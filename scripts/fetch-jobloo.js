#!/usr/bin/env node
/**
 * Streams jobs from jobloo.co's public search API straight into Postgres.
 *
 * Nothing is staged on disk. jobloo is the bottleneck by a wide margin — the API costs
 * ~110s per request regardless of page size (see PAGE_SIZE below), so it serves at best
 * ~90 jobs/s while Postgres absorbs that without noticing. Each page is mapped, written,
 * and dropped, so peak memory is one page.
 *
 * Meilisearch needs no work here: the index_dirty_at trigger fires on every insert and
 * src/tasks/meili-sync.js ships the rows within 60s. Writing to Postgres IS writing to Meili.
 *
 * WHY THE AGE FILTER (--maxAgeMonths, default 6)
 * jobloo's corpus is ~2.25M postings but roughly half of it is stale. Measured 2026-08-08 by
 * fetching real apply URLs in each age bucket:
 *
 *     <1mo    4% dead        3-6mo   12% dead
 *     1-3mo   8% dead        6-12mo  80% dead   <-- 48.7% of the corpus
 *
 * Importing unfiltered would put ~500k dead postings on the board and leave the dead-job
 * pruner to rediscover that by HTTP, one request at a time. We still have to page through
 * everything (the API has no server-side date filter), we just drop the stale rows before
 * they reach the DB.
 *
 * DEDUP
 * jobloo's `id` is already our external_id convention — it emits `greenhouse_1038706` and
 * src/adapters/greenhouse.js emits `greenhouse_${job.id}`. That prefixed form is the dominant
 * one in prod (510k of 649k greenhouse rows), so UNIQUE(external_id, company_id) dedups
 * natively. The one thing that must be right is company resolution: a job has to land on the
 * EXISTING company row for its board, or the unique constraint is scoped to a fresh duplicate
 * company and every job re-inserts. Companies are therefore resolved from an in-memory map of
 * every existing (ats, ats_slug) and career_url, not by per-job lookup — `companies` has no
 * index on (ats, ats_slug) and 100k+ rows.
 *
 * Usage:
 *   node scripts/fetch-jobloo.js --dry-run              # map everything, write nothing
 *   node scripts/fetch-jobloo.js                        # live
 *   node scripts/fetch-jobloo.js --maxAgeMonths=3
 *   node scripts/fetch-jobloo.js --from=0 --to=500000   # resume a range
 *   node scripts/fetch-jobloo.js --concurrency=4 --pageSize=10000
 */
const { query } = require('../src/db/connection');
const sandboxGuard = require('../src/utils/sandbox-guard');
const { classifyRemote, classifyRemoteWorldwide, classifyVisa, classifyRoleCategory, classifyExperienceLevel } = require('../src/utils/classify');

const API = 'https://api.jobloo.co/api/jobs/search';
const USER_ID = process.env.JOBLOO_USER_ID || '0fc2e7a1-f50b-4cab-99e4-9bdcecda4eb9';

// THE SCRAPE IS SHARDED BY CATEGORY, NOT WALKED LINEARLY.
//
// jobloo's OFFSET scans from row zero, so an unfiltered walk degrades brutally with depth —
// measured 2026-08-08: 0.9 min/page for the first 15 pages, 7.7 min/page by page 19, still
// worsening. Extrapolated to 30+ hours for the full corpus.
//
// Filtering by category keeps every offset shallow and the cost flat:
//
//     Noise @0       10k jobs in 27s      unfiltered @200000  ->  462s
//     Noise @350000  10k jobs in 13s
//     Noise @700000  10k jobs in 19s
//
// The 15 categories below are the complete set: their measured depths sum to ~2.15M against a
// linear corpus independently measured at 2.0-2.5M (offset 2.0M returns rows, 2.5M is empty).
// `depth` is a binary-searched estimate used only to plan the work; it is NOT trusted as a
// stopping condition — see the tail extension in run(), which keeps paging any category whose
// last page came back full, so an underestimate can never silently truncate a shard.
const CATEGORIES = [
  { name: 'Noise', depth: 733750 },
  { name: 'Sales', depth: 302500 },
  { name: 'Software Engineering', depth: 227500 },
  { name: 'Operations & Strategy', depth: 205000 },
  { name: 'Misc. Engineering', depth: 145000 },
  { name: 'Finance', depth: 111250 },
  { name: 'Marketing', depth: 81250 },
  { name: 'Data', depth: 73750 },
  { name: 'Human Resources', depth: 66250 },
  { name: 'General', depth: 43750 },
  { name: 'Consulting', depth: 40000 },
  { name: 'Design', depth: 32500 },
  { name: 'Security', depth: 32500 },
  { name: 'Product', depth: 32500 },
  { name: 'Legal', depth: 25000 },
];

function getArg(name, fallback) {
  const m = process.argv.find((a) => a.startsWith(`--${name}=`));
  return m ? m.split('=').slice(1).join('=') : fallback;
}
const hasFlag = (n) => process.argv.includes(`--${n}`);

const DRY_RUN = hasFlag('dry-run');
// 10000, not larger. Cost is per-request, not per-row: limit=1 and limit=10000 both take
// ~110s, limit=20000 takes ~305s (worse throughput), limit=50000 returns HTTP 502.
const PAGE_SIZE = parseInt(getArg('pageSize', '10000'), 10);
const CONCURRENCY = parseInt(getArg('concurrency', '4'), 10);
const MAX_AGE_MONTHS = parseFloat(getArg('maxAgeMonths', '6'));
const FROM = parseInt(getArg('from', '0'), 10);
// Restrict to specific category shards, e.g. --categories="Legal,Design". Handy for resuming
// a shard that failed without re-walking the whole corpus.
const ONLY_CATEGORIES = getArg('categories', null)?.split(',').map((s) => s.trim()).filter(Boolean) || null;
// Corpus ends between offset 2.0M (returns rows) and 2.5M (empty), measured 2026-08-08.
const TO = parseInt(getArg('to', '2500000'), 10);
// 150, not 500. Rows carry full description text (~12KB each), so a 500-row batch pushes ~6MB
// in one statement and blew past the pool's 15s statement_timeout against standard-0's 1GB
// shared_buffers. Smaller batches also keep each write short enough that the live API's
// connections are never stuck behind ours.
const WRITE_BATCH = parseInt(getArg('writeBatch', '150'), 10);
const KEEP_DESCRIPTIONS = !hasFlag('noDescriptions');

const MAX_AGE_MS = MAX_AGE_MONTHS * 30.44 * 864e5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Completed pages, so a crash costs one page rather than the whole run. A full walk is ~4
// hours against a shared database; losing that to one dropped connection (as happened
// 2026-08-08, 76 minutes and 415,667 rows in) is not acceptable. Re-running a page is
// harmless — everything is an upsert — this just avoids re-paying for it.
const fsMod = require('fs');
const CHECKPOINT = getArg('checkpoint', '/tmp/jobloo-progress.done');
const donePages = new Set();
function loadCheckpoint() {
  if (DRY_RUN || !fsMod.existsSync(CHECKPOINT)) return;
  for (const l of fsMod.readFileSync(CHECKPOINT, 'utf8').split('\n')) if (l.trim()) donePages.add(l.trim());
  if (donePages.size) console.log(`checkpoint: skipping ${donePages.size} pages already completed (${CHECKPOINT})`);
}
function markDone(cat, offset) {
  if (DRY_RUN) return;
  donePages.add(`${cat}@${offset}`);
  try { fsMod.appendFileSync(CHECKPOINT, `${cat}@${offset}\n`); } catch { /* progress tracking must never kill the run */ }
}

// ---------------------------------------------------------------- fetching

async function fetchPage(category, offset, attempt = 1) {
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://jobloo.co',
        referer: 'https://jobloo.co/',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({
        userId: USER_ID, categories: [category], subcategories: [], locations: [],
        experience_levels: [], job_types: [], languages: [],
        limit: PAGE_SIZE, offset,
      }),
      signal: AbortSignal.timeout(600000),
    });
    if (res.status === 429) {
      const wait = parseInt(res.headers.get('retry-after'), 10) * 1000 || 60000;
      console.log(`  [${category} @${offset}] rate-limited, sleeping ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      return fetchPage(category, offset, attempt); // rate-limit waits don't burn the retry budget
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    return body.jobs || [];
  } catch (err) {
    if (attempt >= 4) {
      console.log(`  [${category} @${offset}] FAILED after ${attempt}: ${err.message}`);
      stats.failedShards.push(`${category}@${offset}`);
      return null;
    }
    await sleep(5000 * attempt);
    return fetchPage(category, offset, attempt + 1);
  }
}

// ---------------------------------------------------------------- mapping

// Derive the ATS identity of a posting from its apply URL. Mirrors the career_url shapes the
// adapters use so a jobloo row resolves onto the company the crawler already created.
function deriveCompany(job) {
  const url = job.applyUrl || job.hostedUrl || '';
  let host = '', parts = [];
  try { const u = new URL(url); host = u.hostname.replace(/^www\./, ''); parts = u.pathname.split('/').filter(Boolean); } catch { return null; }
  const sub = host.split('.')[0];

  if (host.includes('greenhouse.io')) {
    const slug = parts[0];
    return slug && { ats: 'greenhouse', slug, careerUrl: `https://boards.greenhouse.io/${slug}`, domain: 'greenhouse.io' };
  }
  if (host.includes('smartrecruiters.com')) {
    const slug = parts[0];
    return slug && { ats: 'smartrecruiters', slug, careerUrl: `https://jobs.smartrecruiters.com/${slug}`, domain: 'smartrecruiters.com' };
  }
  if (host.includes('ashbyhq.com')) {
    const slug = parts[0];
    return slug && { ats: 'ashby', slug, careerUrl: `https://jobs.ashbyhq.com/${slug}`, domain: 'ashbyhq.com' };
  }
  if (host.includes('myworkdayjobs.com')) {
    const m = url.match(/\/\/([^.]+)\.(wd\d+)\.myworkdayjobs\.com/i);
    return m && { ats: 'workday', slug: m[1], careerUrl: `https://${m[1]}.${m[2]}.myworkdayjobs.com`, domain: host };
  }
  // Workday's second domain: https://wd1.myworkdaysite.com/recruiting/{tenant}/{site}/job/...
  // The tenant is in the PATH here, not the subdomain. Prod has 4 legacy rows that missed this
  // and fell back to slug 'recruiting', collapsing every tenant on a host into one company
  // (parexel, ssctech and snapchat all sit under company 550091) — hence parsing it properly.
  // Resolving on the (workday, tenant) key also merges these onto the tenant's existing
  // myworkdayjobs company where one already exists.
  if (host.includes('myworkdaysite.com')) {
    const tenant = parts[0] === 'recruiting' ? parts[1] : null;
    return tenant && { ats: 'workday', slug: tenant, careerUrl: `https://${sub}.myworkdaysite.com/recruiting/${tenant}`, domain: host };
  }
  if (host.includes('lever.co')) {
    const slug = parts[0];
    return slug && { ats: 'lever', slug, careerUrl: `https://jobs.lever.co/${slug}`, domain: 'lever.co' };
  }
  if (host.includes('workable.com')) {
    const slug = parts[0];
    return slug && { ats: 'workable', slug, careerUrl: `https://apply.workable.com/${slug}`, domain: 'workable.com' };
  }
  if (host.includes('recruitee.com')) {
    return sub !== 'recruitee' && { ats: 'recruitee', slug: sub, careerUrl: `https://${sub}.recruitee.com`, domain: host };
  }
  if (host.includes('bamboohr.com')) {
    return sub !== 'bamboohr' && { ats: 'bamboohr', slug: sub, careerUrl: `https://${sub}.bamboohr.com/careers`, domain: host };
  }
  return null; // unknown board — skipped rather than guessed onto a wrong company
}

function mapWorkplace(job) {
  const w = (job.workplaceType || '').toLowerCase();
  if (w === 'remote') return 'remote';
  if (w === 'hybrid') return 'hybrid';
  if (w === 'onsite' || w === 'on-site' || w === 'in-person') return 'onsite';
  return null;
}

// jobloo's `description` is just an HTML-escaped duplicate of descriptionPlain — carrying
// both would double the payload for zero information.
function pickDescription(job) {
  if (!KEEP_DESCRIPTIONS) return null;
  return job.descriptionPlain || job.descriptionBodyPlain || null;
}

// jobloo ships mixed-case levels from a coarser taxonomy than ours ("mid"/"Mid", "Exec",
// "Associate") and has no lead/internship at all. Prod's vocabulary is exactly
// lead|entry|senior|mid|internship|executive, so normalise into it — anything unmapped is
// dropped rather than allowed to fragment the Meilisearch facet.
const LEVEL_ALIASES = {
  entry: 'entry', junior: 'entry', associate: 'entry', intern: 'internship',
  internship: 'internship', mid: 'mid', midlevel: 'mid', senior: 'senior', sr: 'senior',
  lead: 'lead', staff: 'lead', principal: 'lead', exec: 'executive', executive: 'executive',
};
function normalizeLevel(raw) {
  if (!raw) return null;
  return LEVEL_ALIASES[String(raw).toLowerCase().replace(/[^a-z]/g, '')] || null;
}

function mapJob(job, companyId, ats) {
  const description = pickDescription(job);
  const location = job.location || [job.city, job.region, job.country].filter(Boolean).join(', ') || null;
  const workplaceType = mapWorkplace(job);
  const isRemote = workplaceType === 'remote' || classifyRemote(job.title, location, workplaceType, description);
  const salary = job.salaryRange || {};

  return {
    external_id: String(job.id),
    company_id: companyId,
    // The ats derived from the apply URL, not job.source — it's what decides which company
    // row this dedups onto, so the two must never disagree.
    ats,
    title: job.title || 'Unknown',
    // NOT job.category. `department` holds the employer's own ATS department ("Engineering",
    // "Behavior Technician"); jobloo's category is a separate role taxonomy whose largest
    // bucket is the literal junk value "Noise" (30% of sampled rows). It is kept in raw_data,
    // and the role signal we actually use comes from classifyRoleCategory below.
    department: null,
    location,
    workplace_type: workplaceType,
    employment_type: job.commitmentType || null,
    salary_min: Number.isFinite(salary.min) ? String(salary.min) : null,
    salary_max: Number.isFinite(salary.max) ? String(salary.max) : null,
    salary_currency: salary.currency || null,
    salary_interval: salary.interval || null,
    description,
    url: job.applyUrl || job.hostedUrl || null,
    posted_at: job.createdAt ? new Date(Number(job.createdAt)).toISOString() : null,
    raw_data: JSON.stringify({
      source: 'jobloo', jobloo_id: job.id, esco_code: job.escoCode, esco_title: job.escoTitle,
      esco_confidence: job.escoConfidence, category: job.category, subcategory: job.subcategory,
      detected_language: job.detectedLanguage, experience_level: job.experienceLevel,
      country_code: job.country_code, all_locations: job.allLocations,
    }),
    visa_sponsorship: (description && classifyVisa(description)) || '',
    // Our classifier first: it carries the full six-value vocabulary (jobloo has no
    // lead/internship) and already handles the "Account Executive"/"Executive Assistant"
    // false friends. jobloo's own label is the fallback.
    experience_level: classifyExperienceLevel(job.title, description) || normalizeLevel(job.experienceLevel) || '',
    is_remote: !!isRemote,
    remote_worldwide: !!classifyRemoteWorldwide(job.title, location, description, !!isRemote),
    role_category: classifyRoleCategory(job.title),
  };
}

// ---------------------------------------------------------------- company cache

const companyByKey = new Map(); // "ats|slug" -> id
const companyByUrl = new Map(); // career_url  -> id

// Keyset-paginated, not one big SELECT. `companies` is 100k+ rows and the pool's default
// statement_timeout is 15s — a single unbounded scan hits it (measured 2026-08-08). Walking
// the primary key in chunks keeps every query short and never holds a long transaction
// against a DB that also serves live traffic.
async function loadCompanies() {
  let after = 0, total = 0;
  for (;;) {
    const { rows } = await query(
      `SELECT id, ats, ats_slug, career_url FROM companies
        WHERE id > $1 ORDER BY id LIMIT 10000`,
      [after]
    );
    if (!rows.length) break;
    for (const r of rows) {
      if (r.ats && r.ats_slug) companyByKey.set(`${r.ats}|${r.ats_slug.toLowerCase()}`, r.id);
      if (r.career_url) companyByUrl.set(r.career_url, r.id);
    }
    total += rows.length;
    after = rows[rows.length - 1].id;
  }
  console.log(`Loaded ${total} existing companies into the resolution map (${companyByKey.size} ats/slug keys)`);
}

const pendingNewCompanies = new Set(); // dry-run bookkeeping
// Companies currently being INSERTed, keyed the same way as the cache. Concurrent workers
// routinely hit the same unseen board in the same instant; without this each one issues its
// own INSERT and they queue against a deliberately small pool until the 10s connection
// timeout fires. Sharing the in-flight promise collapses that to a single round trip.
const inFlightCompanies = new Map();

async function resolveCompany(c, companyName) {
  const key = `${c.ats}|${c.slug.toLowerCase()}`;
  const hit = companyByKey.get(key) ?? companyByUrl.get(c.careerUrl);
  if (hit) return hit;

  if (DRY_RUN) { pendingNewCompanies.add(key); return null; }

  const inFlight = inFlightCompanies.get(key);
  if (inFlight) return inFlight;
  const p = insertCompany(c, companyName, key).finally(() => inFlightCompanies.delete(key));
  inFlightCompanies.set(key, p);
  return p;
}

async function insertCompany(c, companyName, key) {
  const { rows } = await withRetry('company', () => query(
    `INSERT INTO companies (career_url, domain, ats, ats_slug, company_name, status, origin, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'active', 'jobloo', NOW(), NOW())
     ON CONFLICT (career_url) DO UPDATE SET
       company_name = COALESCE(companies.company_name, EXCLUDED.company_name),
       updated_at = NOW()
     RETURNING id`,
    [c.careerUrl, c.domain, c.ats, c.slug, companyName || null]
  ));
  const id = rows[0].id;
  companyByKey.set(key, id);
  companyByUrl.set(c.careerUrl, id);
  return id;
}

// ---------------------------------------------------------------- writing

const COLS = ['external_id', 'company_id', 'ats', 'title', 'department', 'location', 'workplace_type',
  'employment_type', 'salary_min', 'salary_max', 'salary_currency', 'salary_interval', 'description',
  'url', 'posted_at', 'raw_data', 'visa_sponsorship', 'experience_level', 'is_remote',
  'remote_worldwide', 'role_category'];

// Mirrors the ON CONFLICT clause in src/db/repositories/jobs.js — COALESCE on description and
// salary so a jobloo re-run never erases what the backfill pipelines recovered.
// Postgres connections drop mid-run — a 4-hour job against a shared standard-0 instance will
// see it. Measured 2026-08-08: "Connection terminated unexpectedly" killed a run 76 minutes and
// 415,667 rows in, because only the fetch path had retries. Every statement here is an upsert,
// so replaying a batch that may have partly landed is harmless.
const TRANSIENT = /Connection terminated|ECONNRESET|EPIPE|ETIMEDOUT|socket hang up|terminating connection|server closed the connection|Client has encountered a connection error/i;

async function withRetry(label, fn, attempts = 5) {
  for (let a = 1; ; a++) {
    try { return await fn(); } catch (err) {
      if (a >= attempts || !TRANSIENT.test(err.message || '')) throw err;
      const wait = 2000 * a;
      console.log(`  [${label}] ${err.message.slice(0, 60)} — retry ${a}/${attempts - 1} in ${wait / 1000}s`);
      stats.dbRetries++;
      await sleep(wait);
    }
  }
}

async function writeJobs(rows) {
  if (!rows.length) return { written: 0 };
  const params = [];
  const tuples = rows.map((r) => {
    const base = params.length;
    COLS.forEach((c) => params.push(r[c]));
    return `(${COLS.map((_, i) => `$${base + i + 1}`).join(', ')}, NOW(), NOW())`;
  });
  const { rowCount } = await withRetry('write', () => query(
    `INSERT INTO jobs (${COLS.join(', ')}, first_seen_at, last_seen_at)
     VALUES ${tuples.join(', ')}
     ON CONFLICT (external_id, company_id) DO UPDATE SET
       -- GAP-FILL ONLY — the COALESCE order is reversed from src/db/repositories/jobs.js and
       -- that reversal is the point. There, EXCLUDED comes from the employer's own board and
       -- is the freshest truth. Here it comes from an aggregator whose median posting is
       -- months old, while our ATS crawlers re-sync continuously. Preferring EXCLUDED would
       -- overwrite a job we synced from greenhouse this morning with jobloo's stale copy of
       -- the same row. So existing values always win and jobloo only fills holes.
       --
       -- The holes are worth filling: of 2,735,195 live rows, 53,123 have no description,
       -- 1,403,778 no experience level and 2,119,058 no salary (measured 2026-08-08).
       --
       -- Deliberately NOT updated: title, location, workplace_type, employment_type,
       -- role_category, url, posted_at, raw_data, is_remote, remote_worldwide. Ours are
       -- derived from the authoritative source and must not regress to an older snapshot.
       description = COALESCE(jobs.description, EXCLUDED.description),
       salary_min = COALESCE(jobs.salary_min, EXCLUDED.salary_min),
       salary_max = COALESCE(jobs.salary_max, EXCLUDED.salary_max),
       salary_currency = COALESCE(jobs.salary_currency, EXCLUDED.salary_currency),
       salary_interval = COALESCE(jobs.salary_interval, EXCLUDED.salary_interval),
       visa_sponsorship = CASE WHEN COALESCE(jobs.visa_sponsorship, '') = '' THEN EXCLUDED.visa_sponsorship ELSE jobs.visa_sponsorship END,
       experience_level = CASE WHEN COALESCE(jobs.experience_level, '') = '' THEN EXCLUDED.experience_level ELSE jobs.experience_level END,
       last_seen_at = NOW()`,
    // NOTE: deliberately NO `removed_at = NULL` here, unlike src/db/repositories/jobs.js.
    //
    // That clause is right for a real ATS sync — if the employer's own board still lists a
    // job, it is alive. jobloo is not that: it is a stale aggregator, and prod holds 1,695,327
    // rows already marked removed by pruneDeadJobs, which established death by actually
    // fetching the posting. Clearing removed_at on jobloo's say-so would resurrect those onto
    // the live board wholesale. Even inside the 6-month window ~12% of its 3-6mo postings are
    // dead. An authoritative liveness check outranks an aggregator's memory of a listing.
    params
  ));
  return { written: rowCount };
}

// ---------------------------------------------------------------- main

const stats = {
  fetched: 0, stale: 0, noBoard: 0, sandbox: 0, noDate: 0, dupInRun: 0, mapped: 0, written: 0,
  newCompanies: 0, pagesOk: 0, pagesFailed: 0, badRows: 0, withDescription: 0, withLevel: 0,
  bySource: {}, byAge: {}, unknownHosts: {}, failedShards: [],
  dbRetries: 0, pagesSkipped: 0,
};
const seen = new Set();
const sampleRows = []; // dry-run: a few fully-mapped rows to eyeball

async function processPage(category, offset) {
  const jobs = await fetchPage(category, offset);
  if (jobs === null) { stats.pagesFailed++; return 0; }
  stats.pagesOk++;
  stats.fetched += jobs.length;
  if (!jobs.length) return 0;

  const now = Date.now();
  const batch = [];
  for (const job of jobs) {
    if (!job.id || seen.has(job.id)) { stats.dupInRun++; continue; }
    seen.add(job.id);

    if (!job.createdAt) { stats.noDate++; continue; }
    const age = now - Number(job.createdAt);
    if (age > MAX_AGE_MS) { stats.stale++; continue; }

    const c = deriveCompany(job);
    if (!c) {
      stats.noBoard++;
      try {
        const h = new URL(job.applyUrl || job.hostedUrl || '').hostname.replace(/^www\./, '');
        stats.unknownHosts[h] = (stats.unknownHosts[h] || 0) + 1;
      } catch { stats.unknownHosts['(unparseable)'] = (stats.unknownHosts['(unparseable)'] || 0) + 1; }
      continue;
    }

    // ATS demo/sandbox boards are not employers (FA-053). Judged before resolveCompany so a
    // sandbox board never gets a company row created for it either.
    if (sandboxGuard.judgePosting(
      { ats: c.ats, slug: c.slug, careerUrl: c.careerUrl, url: job.applyUrl || job.hostedUrl },
      { source: 'fetch-jobloo' }).reject) { stats.sandbox++; continue; }

    const companyId = await resolveCompany(c, job.company);
    if (companyId === null && !DRY_RUN) continue;

    const months = Math.floor(age / (30.44 * 864e5));
    const bucket = months < 1 ? '<1mo' : months < 3 ? '1-3mo' : '3-6mo';
    stats.byAge[bucket] = (stats.byAge[bucket] || 0) + 1;
    stats.bySource[job.source] = (stats.bySource[job.source] || 0) + 1;
    stats.mapped++;

    // Always map, even in a dry run — mapping is exactly what the dry run exists to
    // validate. Only the write below is skipped. Company id is a placeholder when the
    // company doesn't exist yet and we're not creating it.
    const mapped = mapJob(job, companyId ?? -1, c.ats);
    if (DRY_RUN) {
      sampleRows.length < 3 && sampleRows.push(mapped);
      for (const f of ['title', 'url', 'external_id']) if (!mapped[f]) stats.badRows++;
      if (mapped.description) stats.withDescription++;
      if (mapped.experience_level) stats.withLevel++;
    } else {
      batch.push(mapped);
    }
  }

  if (!DRY_RUN) {
    for (let i = 0; i < batch.length; i += WRITE_BATCH) {
      const { written } = await writeJobs(batch.slice(i, i + WRITE_BATCH));
      stats.written += written;
      // Standard-0 has 1GB shared_buffers against a 32GB table; bulk writes starve the live
      // API. jobloo's latency already throttles us, this just keeps the burst gentle.
      await sleep(120);
    }
  }
  return jobs.length;
}

function report(final = false) {
  const kept = stats.mapped;
  const pct = (n) => (stats.fetched ? ((n / stats.fetched) * 100).toFixed(1) : '0.0') + '%';
  console.log(
    `\n${final ? '=== DONE ===' : '--- progress ---'}\n` +
    `pages ok ${stats.pagesOk}, failed ${stats.pagesFailed}` +
    (stats.pagesSkipped ? `, resumed-skipped ${stats.pagesSkipped}` : '') +
    (stats.dbRetries ? `, db retries ${stats.dbRetries}` : '') + '\n' +
    `fetched      ${stats.fetched}\n` +
    `  stale (>${MAX_AGE_MONTHS}mo) ${stats.stale} (${pct(stats.stale)})\n` +
    `  unknown board ${stats.noBoard} (${pct(stats.noBoard)})\n` +
    `  sandbox board ${stats.sandbox} (${pct(stats.sandbox)})\n` +
    `  no date      ${stats.noDate}\n` +
    `  dup in run   ${stats.dupInRun}\n` +
    `KEPT         ${kept} (${pct(kept)})\n` +
    (DRY_RUN
      ? `would create ${pendingNewCompanies.size} new companies\n` +
        `  rows missing a required field: ${stats.badRows}\n` +
        `  with description: ${stats.withDescription} | with experience_level: ${stats.withLevel}\n`
      : `written      ${stats.written}\n`) +
    `by age: ${JSON.stringify(stats.byAge)}\n` +
    `by source: ${JSON.stringify(stats.bySource)}\n` +
    `dropped boards (top 10): ${JSON.stringify(
      Object.fromEntries(Object.entries(stats.unknownHosts).sort((a, b) => b[1] - a[1]).slice(0, 10))
    )}` +
    // Never let a partial run read as a complete one.
    (stats.failedShards.length
      ? `\n!! ${stats.failedShards.length} PAGES LOST after retries — rerun with ` +
        `--categories="${[...new Set(stats.failedShards.map((s) => s.split('@')[0]))].join(',')}"\n` +
        `   ${stats.failedShards.slice(0, 20).join(', ')}${stats.failedShards.length > 20 ? ', …' : ''}`
      : '')
  );
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — refusing to run against the local SQLite file.');
    process.exit(1);
  }
  console.log(
    `jobloo → ${DRY_RUN ? 'DRY RUN (no writes)' : 'POSTGRES (live)'}\n` +
    `offsets ${FROM}..${TO} | pageSize ${PAGE_SIZE} | concurrency ${CONCURRENCY} | ` +
    `maxAge ${MAX_AGE_MONTHS}mo | descriptions ${KEEP_DESCRIPTIONS ? 'on' : 'off'}\n`
  );
  loadCheckpoint();
  await loadCompanies();
  const before = companyByKey.size;
  const start = Date.now();

  const selected = ONLY_CATEGORIES
    ? CATEGORIES.filter((c) => ONLY_CATEGORIES.includes(c.name))
    : CATEGORIES;

  // Plan from the measured depths, with headroom. Overshooting is cheap (an off-the-end page
  // returns empty in a few seconds); undershooting is handled by the tail extension below.
  const tasks = [];
  for (const cat of selected) {
    const planned = Math.ceil((cat.depth * 1.15) / PAGE_SIZE) * PAGE_SIZE;
    for (let o = FROM; o < Math.min(planned, TO); o += PAGE_SIZE) tasks.push({ cat: cat.name, offset: o });
  }
  // Interleave categories so concurrent workers hit different shards rather than hammering
  // one, and so a stall in a single category can't hold up everything behind it.
  tasks.sort((a, b) => a.offset - b.offset || a.cat.localeCompare(b.cat));
  console.log(`${tasks.length} pages planned across ${selected.length} categories\n`);

  // Highest offset that came back FULL per category — the tail extension resumes from here.
  const lastFullOffset = new Map();
  let cursor = 0, done = 0;

  async function runTask(t, id, total) {
    if (donePages.has(`${t.cat}@${t.offset}`)) {
      stats.pagesSkipped++;
      // A resumed page was full when it ran, otherwise the shard had ended there. Report it
      // as full so the tail extension still reasons correctly about where each shard stopped.
      return PAGE_SIZE;
    }
    const n = await processPage(t.cat, t.offset);
    if (n > 0) markDone(t.cat, t.offset);
    done++;
    if (n === PAGE_SIZE) {
      lastFullOffset.set(t.cat, Math.max(lastFullOffset.get(t.cat) ?? -1, t.offset));
    }
    const mins = ((Date.now() - start) / 60000).toFixed(1);
    console.log(
      `[w${id}] ${t.cat} @${t.offset} → ${n} | ${done}/${total} pages | ` +
      `kept ${stats.mapped} | ${DRY_RUN ? 'dry' : `written ${stats.written}`} | ${mins}min`
    );
    if (done % 15 === 0) report();
    return n;
  }

  async function worker(id) {
    for (;;) {
      const i = cursor++;
      if (i >= tasks.length) return;
      await runTask(tasks[i], id, tasks.length);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1)));

  // TAIL EXTENSION — the guarantee that a low depth estimate never silently truncates a shard.
  // Any category whose deepest page came back full has more rows beyond what we planned, so
  // keep paging it until a short (or empty) page proves we reached the end.
  const tails = [...lastFullOffset.entries()]
    .filter(([cat, off]) => {
      const planned = Math.ceil(((selected.find((c) => c.name === cat)?.depth ?? 0) * 1.15) / PAGE_SIZE) * PAGE_SIZE;
      return off + PAGE_SIZE >= Math.min(planned, TO); // the last planned page was still full
    })
    .map(([cat, off]) => ({ cat, offset: off + PAGE_SIZE }));

  if (tails.length) {
    console.log(`\ntail extension: ${tails.map((t) => `${t.cat}@${t.offset}`).join(', ')}`);
    await Promise.all(tails.map(async (t, i) => {
      let offset = t.offset;
      for (;;) {
        const n = await runTask({ cat: t.cat, offset }, `tail${i + 1}`, tasks.length);
        if (n < PAGE_SIZE) break; // short page = end of shard
        offset += PAGE_SIZE;
      }
    }));
  }

  stats.newCompanies = DRY_RUN ? pendingNewCompanies.size : companyByKey.size - before;
  report(true);
  console.log(`new companies: ${stats.newCompanies}`);
  if (DRY_RUN && sampleRows.length) {
    console.log('\nsample mapped rows (description truncated):');
    for (const r of sampleRows) {
      console.log(JSON.stringify({ ...r, description: r.description ? `${r.description.slice(0, 80)}…` : null, raw_data: '…' }, null, 1));
    }
  }
  console.log(`elapsed: ${((Date.now() - start) / 60000).toFixed(1)} min`);
  if (!DRY_RUN) console.log('\nMeilisearch will pick these up via index_dirty_at within ~60s (20k rows/run).');
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
