#!/usr/bin/env node
/**
 * Xeruit bulk import — api.xeruit.com/jobs/search/advanced -> the LOCAL SQLite DB.
 *
 * Xeruit is an aggregator of aggregators: ~24k postings, each carrying the employer's real
 * board link (`externalJobLink`) plus a full description. The descriptions are the reason this
 * import is worth running — they arrive complete (median ~5,000 chars, 100% coverage), which is
 * the one field our own crawlers most often have to backfill afterwards.
 *
 *   XERUIT_TOKEN=<jwt> node scripts/fetch-xeruit.js                 # fetch the API, then load
 *   node scripts/fetch-xeruit.js --from-file dump.jsonl             # load a raw dump instead
 *   XERUIT_TOKEN=<jwt> node scripts/fetch-xeruit.js --dump out.jsonl --no-load   # fetch only
 *   node scripts/fetch-xeruit.js --from-file dump.jsonl --report    # map + diagnose, no writes
 *
 * The token is a normal user JWT from app.xeruit.com (the endpoint 401s without one) and lasts
 * 24h. Grab a fresh one from the Authorization header of any request the web app makes.
 *
 * Env knobs: CONCURRENCY (5) · DELAY_MS (250) · CHUNK (2000 rows held in memory at a time)
 *            START_PAGE (1) · MAX_PAGES · ALLOW_POSTGRES (see below)
 *
 * ---------------------------------------------------------------------------------------
 * LOCAL ONLY. The script refuses to run with DATABASE_URL set unless ALLOW_POSTGRES=1. Every
 * other importer here shares one connection module, so an inherited DATABASE_URL in the shell
 * would silently push 24k aggregated rows straight into the live board. Load locally, eyeball
 * the result, and push deliberately with scripts/sync-jobs-to-postgres.js.
 * ---------------------------------------------------------------------------------------
 *
 * What the mapping does NOT take at face value:
 *
 *   workType     is 'remote' on every single external row (24,124/24,124) and is not even a
 *                filterable field on the API — it is defaulted, not measured. Storing it would
 *                mark the entire import Remote. We store OUR classifier's verdict instead
 *                (which says remote for ~44%) and keep the source value in raw_data.
 *   level /      Xeruit's own LLM-derived seniority and visa flags. Same treatment: classify.js
 *   visaSponsorship  decides what lands in the column so this corpus stays comparable with every
 *                other row in the table, and the source values are preserved in raw_data.
 *   city         occasionally holds a country ("city": "Canada", "country": "United States").
 *                Identical city/country pairs collapse to one term rather than "Canada, Canada".
 *
 * Known upstream defect, passed through as-is: salaryFrequency is wrong on 39 of 24,114 rows
 * ("USD 120,000 - 155,000 hourly", "USD 198 - 260 annually"). Their own salaryDisplay string
 * carries the same mistake, so it is theirs, not ours. It is left uncorrected on purpose — the
 * numbers alone cannot settle it without a per-currency magnitude table (INR 1,621/hour is a
 * perfectly ordinary contract rate; USD 120,000/hour is not), and 0.16% of rows does not justify
 * guessing. Both the value and the source's own rendering are in raw_data if it ever matters.
 *
 * Company identity comes from the board link, never from companyName — see xeruit-board.js.
 * Companies whose tenant slug the link does not state are stored status='unlinked', which keeps
 * them out of the crawler's claim query and out of sync-jobs-to-postgres (both require
 * ats_slug IS NOT NULL). Nothing here is ever marked removed: this is an additive import.
 */
const fs = require('fs');
const readline = require('readline');

// The point of this guard is "never write to the LIVE board by accident", not "never use
// Postgres" — the local corpus now lives in a local Postgres (jobs_local), so a loopback URL is
// exactly where these importers are meant to write. Only a REMOTE host needs the override.
const dbHost = (() => { try { return new URL(process.env.DATABASE_URL).hostname; } catch { return ''; } })();
const isLocalDb = ['localhost', '127.0.0.1', '::1', ''].includes(dbHost);
if (process.env.DATABASE_URL && !isLocalDb && process.env.ALLOW_POSTGRES !== '1') {
  console.error('Refusing to run: DATABASE_URL points at a REMOTE database.\n' +
                'Point it at a local database, or pass ALLOW_POSTGRES=1 deliberately.');
  process.exit(1);
}

const { companiesRepo, jobsRepo, migrate, closeDb } = require('../src/db');
const { query } = require('../src/db/connection');
const { classifyJob } = require('../src/utils/classify');
const { resolveCountry } = require('../src/utils/location-countries');
const { resolveBoard } = require('./xeruit-board');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, def = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };

const FROM_FILE = opt('--from-file');
const DUMP_TO = opt('--dump');
const REPORT = flag('--report');          // resolve + summarise, write nothing
const NO_LOAD = flag('--no-load') || REPORT;
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '5', 10);
const DELAY_MS = parseInt(process.env.DELAY_MS || '250', 10);
const CHUNK = parseInt(process.env.CHUNK || '2000', 10);
const START_PAGE = parseInt(process.env.START_PAGE || '1', 10);
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '0', 10);

const API = 'https://api.xeruit.com/jobs/search/advanced';
const PAGE_SIZE = 100;                    // API rejects limit > 100 with a 422
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── mapping ─────────────────────────────────────────────────────────────────────────────

// annually/monthly/hourly -> the vocabulary src/utils/extract.js already stores.
const INTERVALS = { annually: 'yearly', annual: 'yearly', yearly: 'yearly', monthly: 'monthly', weekly: 'weekly', hourly: 'hourly', daily: 'daily' };

function buildLocation(raw) {
  // Internal (Xeruit-native) postings carry an ISO-2 code in `location` and no city/country.
  if (!raw.city && !raw.country && raw.location) {
    const c = resolveCountry(raw.location);
    return c ? c.name : String(raw.location);
  }
  const city = (raw.city || '').trim();
  const country = (raw.country || '').trim();
  if (city && country) return city.toLowerCase() === country.toLowerCase() ? country : `${city}, ${country}`;
  return city || country || null;
}

/** The company a posting belongs to, as a row we can upsert plus a stable dedup key. */
function resolveCompany(raw) {
  const link = raw.externalJobLink || '';
  const board = link ? resolveBoard(link) : { ats: 'xeruit', slug: null, nativeId: null, host: 'app.xeruit.com', crawlable: false };
  const name = raw.companyName || raw.company?.name || null;

  if (board.crawlable) {
    // createFromCrawl owns the canonical career_url per ATS, so rows land on exactly the URL
    // the crawl fleet itself would mint — that exact string is what sync-jobs-to-postgres
    // matches companies on.
    return { board, name, key: `${board.ats}:${board.slug}`, viaCrawl: true };
  }

  // No usable tenant slug. The company key has to be something stable that does not merge two
  // employers sharing a host: the slug when the link gave one, else the company name. Name
  // collisions across employers are possible but rare, and are strictly better than collapsing
  // every jobs.workable.com employer into a single row.
  const ident = board.slug || slugify(name) || 'unknown';
  const host = board.host || 'app.xeruit.com';
  const careerUrl = board.ats === 'xeruit' && raw.company?._id
    ? `https://app.xeruit.com/company/${raw.company._id}`
    : `https://${host}/${ident}`;
  return { board, name, key: careerUrl, viaCrawl: false, careerUrl, domain: host };
}

function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || null;
}

/** One Xeruit posting -> the row shape jobsRepo.syncForCompany() expects. */
function mapJob(raw, board) {
  const location = buildLocation(raw);
  const description = raw.jobDescription || null;
  const title = raw.jobTitle || '';

  // classify.js decides what goes in the columns — see the header note on why Xeruit's own
  // workType/level/visaSponsorship are kept out of them.
  const cls = classifyJob({ title, description, location, workplace_type: '' });

  const hasSalary = Number(raw.minSalary) > 0 || Number(raw.maxSalary) > 0;

  return {
    external_id: board.nativeId || `xeruit_${raw._id}`,
    title,
    department: null,
    location,
    // Only ever Remote-or-unknown: we can evidence remote from the posting text, but nothing in
    // the feed distinguishes hybrid from onsite once workType is discarded.
    workplace_type: cls.is_remote ? 'Remote' : null,
    employment_type: raw.preferredWorkingHours || null,   // normalised by syncForCompany
    salary_min: hasSalary && Number(raw.minSalary) > 0 ? String(raw.minSalary) : null,
    salary_max: hasSalary && Number(raw.maxSalary) > 0 ? String(raw.maxSalary) : null,
    salary_currency: hasSalary ? raw.currency || null : null,
    salary_interval: hasSalary ? INTERVALS[String(raw.salaryFrequency || '').toLowerCase()] || null : null,
    description,
    url: raw.externalJobLink || `https://app.xeruit.com/jobs/${raw._id}`,
    posted_at: raw.postedDate || raw.createdAt || null,
    ...cls,
    raw_data: {
      source: 'xeruit',
      xeruit_id: raw._id,
      source_type: raw.jobSourceType,
      aggregator: raw.jobSourceAggregator || null,
      source_url: raw.sourceUrl || null,
      // `logoUrl` spelling is deliberate: sync-jobs-to-postgres.js reads
      // json_extract(raw_data,'$.logoUrl') to backfill company logos on push.
      logoUrl: raw.companyLogo || raw.company?.logo || null,
      ats_host: board.host,
      // Source values the columns deliberately do not take at face value.
      workType: raw.workType || null,
      level: raw.level || null,
      experienceLevel: raw.experienceLevel || null,
      visaSponsorship: raw.visaSponsorship ?? null,
      relocationSupport: raw.relocationSupport ?? null,
      eligibilityToWork: raw.eligibilityToWork || null,
      // Xeruit's own structured extras — no column of ours holds them, but they are the most
      // useful part of the feed after the description.
      skills: raw.requiredTechnicalSkills?.length ? raw.requiredTechnicalSkills : null,
      softSkills: raw.requiredSoftSkills?.length ? raw.requiredSoftSkills : null,
      tags: raw.tags?.length ? raw.tags : null,
      responsibilities: raw.responsibilities || null,
      keyRequirements: raw.keyRequirements || null,
      academicBackground: raw.preferredAcademicBackground || null,
      languageRequirements: raw.languageRequirements || null,
      salaryDisplay: raw.salary || null,
      lastSeenAt: raw.lastSeenAt || null,
      fetchedAt: new Date().toISOString(),
    },
  };
}

// ── fetching ────────────────────────────────────────────────────────────────────────────

async function getPage(page, attempt = 0) {
  try {
    const res = await fetch(`${API}?page=${page}&limit=${PAGE_SIZE}`, {
      headers: { accept: 'application/json', authorization: `Bearer ${process.env.XERUIT_TOKEN}`, origin: 'https://app.xeruit.com' },
      signal: AbortSignal.timeout(60000),
    });
    if (res.status === 401) throw new Error('401 — XERUIT_TOKEN is missing or expired (they last 24h)');
    if (res.status === 429) { await sleep(5000 * (attempt + 1)); return getPage(page, attempt + 1); }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (/401/.test(err.message) || attempt >= 5) throw err;
    await sleep(2000 * (attempt + 1));
    return getPage(page, attempt + 1);
  }
}

/**
 * Walk every page, yielding rows in CHUNK-sized batches so a 24k-row corpus with ~5KB
 * descriptions never has to sit in memory all at once.
 */
async function* fetchAll(onRow) {
  const first = await getPage(START_PAGE);
  const total = first?.meta?.total || 0;
  let lastPage = Math.ceil(total / PAGE_SIZE);
  if (MAX_PAGES) lastPage = Math.min(lastPage, START_PAGE + MAX_PAGES - 1);
  console.log(`API reports ${total} jobs -> pages ${START_PAGE}..${lastPage}`);

  const seen = new Set();
  let buf = [];
  const take = (rows) => { for (const r of rows) { if (!seen.has(r._id)) { seen.add(r._id); buf.push(r); onRow?.(r); } } };
  take(first?.data || []);

  const queue = [];
  for (let p = START_PAGE + 1; p <= lastPage; p++) queue.push(p);
  let cursor = 0, fetched = 1;

  // Pages are fetched concurrently but drained through one buffer, so ordering across workers
  // does not matter — every row is keyed by _id and deduped above.
  const inflight = Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < queue.length) {
      const page = queue[cursor++];
      const body = await getPage(page);
      take(body?.data || []);
      fetched++;
      if (fetched % 5 === 0) process.stdout.write(`\r  fetched ${fetched}/${lastPage - START_PAGE + 1} pages, ${seen.size} unique jobs   `);
      await sleep(DELAY_MS);
    }
  });

  // Drain the buffer while the workers run: yield whenever a chunk's worth has piled up.
  const done = Promise.all(inflight);
  let finished = false;
  done.then(() => { finished = true; });
  while (!finished || buf.length) {
    if (buf.length >= CHUNK || (finished && buf.length)) {
      const out = buf.splice(0, CHUNK);
      yield out;
    } else {
      await sleep(200);
    }
  }
  await done;
  if (buf.length) yield buf.splice(0);
  process.stdout.write(`\r  fetched ${fetched} pages, ${seen.size} unique jobs${' '.repeat(20)}\n`);
}

async function* readFile(path) {
  const rl = readline.createInterface({ input: fs.createReadStream(path), crlfDelay: Infinity });
  let buf = [];
  const seen = new Set();
  for await (const line of rl) {
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (!row?._id || seen.has(row._id)) continue;
    seen.add(row._id);
    buf.push(row);
    if (buf.length >= CHUNK) { yield buf; buf = []; }
  }
  if (buf.length) yield buf;
}

// ── loading ─────────────────────────────────────────────────────────────────────────────

const companyIds = new Map();   // company key -> local companies.id
const metaWritten = new Set(); // company keys whose name/logo have been filled in

async function upsertCompany(co) {
  if (companyIds.has(co.key)) return companyIds.get(co.key);

  let row;
  if (co.viaCrawl) {
    row = await companiesRepo.createFromCrawl({ ats: co.board.ats, atsSlug: co.board.slug, origin: 'xeruit' });
  } else {
    await query(
      `INSERT INTO companies (company_name, domain, ats, ats_slug, career_url, status, origin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'unlinked', 'xeruit', datetime('now'), datetime('now'))
       ON CONFLICT(career_url) DO NOTHING`,
      [co.name, co.domain, co.board.ats, co.board.slug, co.careerUrl]
    );
    row = await companiesRepo.findByUrl(co.careerUrl);
  }
  if (!row) return null;
  companyIds.set(co.key, row.id);
  return row.id;
}

async function loadChunk(rows, stats) {
  // Group first: syncForCompany opens one transaction per company, so one call per company per
  // chunk instead of one per job.
  const byCompany = new Map();
  for (const raw of rows) {
    const co = resolveCompany(raw);
    stats.ats[co.board.ats] = (stats.ats[co.board.ats] || 0) + 1;
    if (!co.board.crawlable) stats.unlinked++;
    if (co.board.nativeId) stats.native++;
    if (co.board.ats === 'direct') stats.directHosts.add(co.board.host);

    if (!byCompany.has(co.key)) byCompany.set(co.key, { co, jobs: [] });
    byCompany.get(co.key).jobs.push(mapJob(raw, co.board));
  }
  stats.companies = companyIds.size + byCompany.size;

  if (NO_LOAD) { stats.mapped += rows.length; return; }

  for (const { co, jobs } of byCompany.values()) {
    const companyId = await upsertCompany(co);
    if (!companyId) { stats.skipped += jobs.length; continue; }
    // Company metadata is not part of createFromCrawl; fill it from the first posting that
    // carries a name or logo (the feed omits logos on ~1/3 of rows). Once per company, not
    // once per chunk — a company's postings are spread across many chunks.
    if (!metaWritten.has(co.key)) {
      metaWritten.add(co.key);
      const logo = jobs.find((j) => j.raw_data.logoUrl)?.raw_data.logoUrl || null;
      if (co.name || logo) await companiesRepo.updateMeta(companyId, { companyName: co.name, logoUrl: logo });
    }

    const { added, updated } = await jobsRepo.syncForCompany(companyId, co.board.ats, jobs);
    stats.added += added;
    stats.updated += updated;
    stats.mapped += jobs.length;
  }
}

// ── main ────────────────────────────────────────────────────────────────────────────────

async function main() {
  if (!FROM_FILE && !process.env.XERUIT_TOKEN) {
    console.error('XERUIT_TOKEN is required (or pass --from-file <dump.jsonl>).');
    process.exit(1);
  }

  if (!NO_LOAD) await migrate();

  const stats = { mapped: 0, added: 0, updated: 0, skipped: 0, unlinked: 0, native: 0, companies: 0, ats: {}, directHosts: new Set() };
  const started = Date.now();
  const dump = DUMP_TO ? fs.createWriteStream(DUMP_TO) : null;

  const source = FROM_FILE
    ? readFile(FROM_FILE)
    : fetchAll(dump ? (r) => dump.write(JSON.stringify(r) + '\n') : null);

  for await (const chunk of source) {
    await loadChunk(chunk, stats);
    process.stdout.write(`\r  ${stats.mapped} jobs mapped | +${stats.added} new, ${stats.updated} updated | ${companyIds.size} companies   `);
  }

  if (dump) { dump.end(); await new Promise((r) => dump.on('finish', r)); }

  const mins = ((Date.now() - started) / 60000).toFixed(1);
  console.log(`\n\n=== ${REPORT ? 'REPORT (nothing written)' : 'DONE'} — ${mins} min ===`);
  console.log(`jobs mapped        ${stats.mapped}`);
  if (!NO_LOAD) {
    console.log(`  inserted         ${stats.added}`);
    console.log(`  updated          ${stats.updated}`);
    if (stats.skipped) console.log(`  skipped          ${stats.skipped} (company upsert failed)`);
    console.log(`companies          ${companyIds.size}`);
  }
  console.log(`native external_id ${stats.native} (${(stats.native / Math.max(stats.mapped, 1) * 100).toFixed(1)}% can merge with a natively-crawled row)`);
  console.log(`unlinked companies ${stats.unlinked} jobs on boards whose tenant slug the URL does not state`);
  console.log(`distinct direct-employer hosts: ${stats.directHosts.size}`);
  console.log('\nby platform:');
  Object.entries(stats.ats).sort((a, b) => b[1] - a[1]).forEach(([a, c]) => console.log(`  ${String(c).padStart(7)}  ${a}`));

  await closeDb();
}

module.exports = { mapJob, resolveCompany, buildLocation };

if (require.main === module) main().catch((err) => { console.error('\n', err); process.exit(1); });
