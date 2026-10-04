#!/usr/bin/env node
/**
 * Phase 2 — demand-driven crawling (multi-source).
 *
 * Reads the top UNMET demand from search_demand (searched a lot, few results — the
 * unsatisfied customers Phase 0 surfaced), splits the OR-lists into (title × location)
 * queries, and fetches those exact jobs from every ENABLED source, upserting into Postgres.
 *
 * Source: liftmycv — public keyword+location API, free, no token. The token-based sources
 * (wonsulting, jobhose, googledork) were removed 2026-10-04; see SOURCES below.
 *
 * Jobs are stored per-source (company keyed by career_url, external_id = source job id) so
 * they merge with existing rows rather than duplicating. origin = demand_<source>.
 *
 * Run:  DATABASE_URL=... node src/tasks/demand-crawl.js          # one drain of due demand
 *       DATABASE_URL=... LOOP=1 node src/tasks/demand-crawl.js   # keep re-checking
 *       DATABASE_URL=... DRY=1 node src/tasks/demand-crawl.js    # fetch+map, write nothing
 * Env:  DEMAND_MAX_RESULTS(10) DEMAND_BATCH(15) DEMAND_RECRAWL_HOURS(6)
 *       DEMAND_MAX_TITLES(3) DEMAND_MAX_LOCATIONS(2) DEMAND_PAGES(1) DEMAND_PAGE_SIZE(100)
 *       DEMAND_DELAY_MS(1200) RECHECK_S(600) DEMAND_STARVED_SHARE(0.4)
 */
// Load .env at repo root so a local run picks up settings without exporting them in the shell.
// Real env vars take precedence.
(function loadEnv() {
  try {
    const fs = require('fs'), path = require('path');
    fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8').split(/\r?\n/).forEach((l) => {
      const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
  } catch { /* no .env — rely on real env */ }
})();
const https = require('https');
const { query, closeDb } = require('../db/connection');
const logger = require('../logger');
const { classifyJob } = require('../utils/classify');
const { isSupportedAts, normalizeAts, SUPPORTED_ATS } = require('../utils/supported-ats');

const THRESHOLD = parseInt(process.env.DEMAND_MAX_RESULTS || '10', 10);
const BATCH = parseInt(process.env.DEMAND_BATCH || '25', 10);
// 48h (not 6h): a just-crawled demand shouldn't be redone for days, or the top few high-volume
// searches get re-crawled every cycle and the long-tail backlog never gets reached.
const RECRAWL_HOURS = parseInt(process.env.DEMAND_RECRAWL_HOURS || '48', 10);
const MAX_TITLES = parseInt(process.env.DEMAND_MAX_TITLES || '3', 10);
const MAX_LOCATIONS = parseInt(process.env.DEMAND_MAX_LOCATIONS || '2', 10);
const PAGES = parseInt(process.env.DEMAND_PAGES || '1', 10);
const PAGE_SIZE = parseInt(process.env.DEMAND_PAGE_SIZE || '100', 10);
const DELAY_MS = parseInt(process.env.DEMAND_DELAY_MS || '1200', 10);
const LOOP = process.env.LOOP === '1';
const DRY = process.env.DRY === '1';
const RECHECK_S = parseInt(process.env.RECHECK_S || '600', 10);
// Fraction of each batch reserved for STARVED demand — see selectDemand below.
// 0 restores the old popularity-only behaviour without a redeploy.
const STARVED_SHARE = Math.min(1, Math.max(0, parseFloat(process.env.DEMAND_STARVED_SHARE || '0.4')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- HTTP helpers ----------
function httpGetJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 25000, headers }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(`JSON parse: ${e.message}`)); } });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}
// ---------- shared company derivation (canonical career_url + ats + slug per employer) ----------
const ATS_HOST_MAP = { greenhouse: 'greenhouse', lever: 'lever', ashby: 'ashby', workable: 'workable',
  bamboohr: 'bamboohr', smartrecruiters: 'smartrecruiters', recruitee: 'recruitee', breezy: 'breezy',
  personio: 'personio', pinpoint: 'pinpoint', jazzhr: 'jazzhr', rippling: 'rippling', zoho: 'zoho' };

// ATS where the tenant is the subdomain and no dedicated branch above handles it.
const SUBDOMAIN_TENANT_ATS = new Set(['personio', 'zoho']);

// URL path words that name a section, never an employer.
const GENERIC_PATH_SEGMENT = /^(company|companies|jobs?|job-openings|careers?|careersection|opportunities|positions|openings|talent|people|team|about|home|index|search|apply|hiring|main|portal|site|page|default|external|internal|psc|en|us|www|vacancies|listings|recruiting|recruitment|employment|work|join|joinus|current-openings|view|list|all|browse|find|explore)$/i;

function deriveCompany(applyUrl, atsHint, companyName, sourceName) {
  const strip = (u) => { try { const x = new URL(u); ['userid','jobid','utm_source','utm_medium','utm_campaign','gh_src'].forEach(p => x.searchParams.delete(p)); return x.toString().replace(/\?$/, ''); } catch { return u; } };
  const clean = strip(applyUrl || '');
  let host = '', parts = [], proto = 'https:';
  try { const u = new URL(clean); host = u.hostname.toLowerCase().replace(/^www\./, ''); parts = u.pathname.split('/').filter(Boolean); proto = u.protocol; } catch {}
  const sub = host.split('.')[0];
  // Fold alias labels (grnhse, taleo_careersection, …) to the adapter that can actually crawl
  // them — stored verbatim they pass the ingest gate but throw in getAdapter(), so the row can
  // never sync. See src/utils/supported-ats.js.
  let ats = normalizeAts(atsHint) || null, slug = null, careerUrl = null;
  // Subdomain-tenant ATS (tenant lives in the hostname)
  if (host.endsWith('.myworkdayjobs.com')) { ats = 'workday'; slug = sub; careerUrl = `https://${sub}.myworkdayjobs.com`; }
  else if (host.endsWith('.icims.com')) { ats = 'icims'; slug = sub; careerUrl = `https://${sub}.icims.com`; }
  else if (host.endsWith('.bamboohr.com')) { ats = 'bamboohr'; slug = sub; careerUrl = `https://${sub}.bamboohr.com`; }
  else if (host.endsWith('.recruitee.com')) { ats = 'recruitee'; slug = sub; careerUrl = `https://${sub}.recruitee.com`; }
  else if (host.endsWith('.breezy.hr')) { ats = 'breezy'; slug = sub; careerUrl = `https://${sub}.breezy.hr`; }
  else if (host.includes('teamtailor.com') && sub !== 'teamtailor') { ats = 'teamtailor'; slug = sub; careerUrl = `https://${sub}.teamtailor.com`; }
  // Taleo: the tenant is the subdomain ({tenant}.taleo.net/careersection/...). Without this the
  // generic fallback slugged them "careersection". Taleo Business Edition ({x}.tbe.taleo.net/
  // {portal}/ats/careers/...) is a separate product the taleo adapter cannot read, so drop it
  // rather than store a row that looks healthy and never syncs.
  else if (host.endsWith('.taleo.net')) {
    if (host.endsWith('.tbe.taleo.net')) return { ats: 'taleo', slug: null, careerUrl: null, domain: null };
    ats = 'taleo'; slug = sub; careerUrl = `https://${sub}.taleo.net`;
  }
  // Paylocity: the tenant is a GUID in the path (/Recruiting/Jobs/All/{guid}). Job-detail and
  // apply links carry ONLY a numeric job id — no tenant — so they must be dropped, not stored.
  // Without this branch they fell to the generic fallback below, which slugged them "Recruiting"
  // and, because career_url is the conflict key, piled every employer's postings onto one bogus
  // company row (978 live jobs from 263 different employers under "iNewOrleans LLC").
  else if (host.endsWith('paylocity.com')) {
    const g = clean.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (!g) return { ats: 'paylocity', slug: null, careerUrl: null, domain: null };
    ats = 'paylocity'; slug = g[0].toLowerCase();
    careerUrl = `https://recruiting.paylocity.com/recruiting/jobs/All/${slug}`;
  }
  // Path-slug ATS (boards.greenhouse.io/{slug}, jobs.lever.co/{slug}, ...)
  else if (parts[0] && /greenhouse|lever|ashby|workable|smartrecruiters/.test(host)) {
    slug = parts[0];
    if (host.includes('greenhouse')) { ats = 'greenhouse'; careerUrl = `https://boards.greenhouse.io/${slug}`; }
    else if (host.includes('lever')) { ats = 'lever'; careerUrl = `https://jobs.lever.co/${slug}`; }
    else if (host.includes('ashby')) { ats = 'ashby'; careerUrl = `https://jobs.ashbyhq.com/${slug}`; }
    else if (host.includes('workable')) { ats = 'workable'; careerUrl = `https://apply.workable.com/${slug}`; }
    else if (host.includes('smartrecruiters')) { ats = 'smartrecruiters'; careerUrl = `https://jobs.smartrecruiters.com/${slug}`; }
  }
  // Generic fallback: host root, else namespace by company name so it still stores.
  if (!careerUrl) {
    // parts[0] is only a tenant id when it actually names the employer. When it is a
    // generic path word ("careers", "jobs", "company", "psc", ...) it identifies nothing,
    // and because career_url is the ON CONFLICT key every employer on that host collapses
    // into ONE row: 353 such rows had accumulated, one of them holding 978 postings from
    // 625 different employers. Drop the job instead — a row we can never crawl is worse
    // than no row. (Only the fallback is guarded; the branches above read the tenant from
    // the hostname, where "people.bamboohr.com" is a legitimate tenant named "people".)
    if (host && parts[0] && GENERIC_PATH_SEGMENT.test(parts[0])) {
      const a = ats || ATS_HOST_MAP[sub] || null;
      // ...unless the tenant lives in the hostname. acme.jobs.personio.de/job/123 and
      // acme.zohorecruit.com/jobs/Careers both start with a generic path word, but the
      // subdomain still names the employer, so key the row on the host root instead of
      // dropping it. (The other subdomain-tenant platforms have explicit branches above;
      // this list stays narrow on purpose — a wrong guess here recreates the one-row-per-host
      // collapse that made this guard necessary.)
      if (a && SUBDOMAIN_TENANT_ATS.has(a) && host.includes(a) && sub !== a && !GENERIC_PATH_SEGMENT.test(sub)) {
        return { ats: a, slug: sub, careerUrl: `${proto}//${host}`, domain: host };
      }
      return { ats: a || sourceName, slug: null, careerUrl: null, domain: null };
    }
    // The feed named a real ATS but the URL is on the employer's own domain — i.e. an embedded
    // board. The path segment is then a page name, not a tenant id ("join-our-team", not
    // "meritamerica"), and the true token is only discoverable by fetching the page, which
    // ingest does not do. Storing it is the worst outcome: the row passes every check, resolves
    // to a real adapter, and harvests nothing forever. Drop it instead.
    if (host && ats && SUPPORTED_ATS.has(ats) && !ATS_HOST_MAP[sub] && !host.includes(ats)) {
      return { ats, slug: null, careerUrl: null, domain: null };
    }
    if (host && parts[0]) { slug = parts[0]; careerUrl = `${proto}//${host}/${slug}`; }
    else if (host) { slug = sub; careerUrl = `${proto}//${host}`; }
    else { slug = (companyName || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); careerUrl = `${sourceName}://${slug}`; }
    ats = ats || ATS_HOST_MAP[sub] || sourceName;
  }
  let domain; try { domain = new URL(careerUrl).hostname; } catch { domain = slug; }
  return { ats: ats || sourceName, slug, careerUrl, domain };
}

// ---------- sources: each returns an array of NORMALIZED jobs ----------
// normalized = { externalId, source, atsHint, company, applyUrl, title, location, description, postedAt, workplaceType }
function wp(v) { const w = String(v || '').toUpperCase(); if (w === 'REMOTE') return 'remote'; if (w === 'HYBRID') return 'hybrid'; if (w === 'ONSITE' || w === 'ON_SITE') return 'onsite'; return null; }

const liftmycv = {
  name: 'liftmycv',
  enabled: () => true,
  async search(title, location, page) {
    const p = new URLSearchParams({ roles: title, count: String(PAGE_SIZE), page: String(page) });
    if (location) p.set('location', location);
    const data = await httpGetJson(`https://app.liftmycv.com/api/v1/jobs/search?${p}`);
    return (data?.results?.jobs || []).map((j) => ({
      externalId: j.id, source: 'liftmycv', atsHint: j.platform, company: j.company, applyUrl: j.companyUrl,
      title: j.role, location: j.location, description: j.description || j.formattedDescription || null,
      postedAt: j.jobCreatedAt ? new Date(j.jobCreatedAt * 1000).toISOString() : null, workplaceType: wp(j.workplaceType),
      jobUrl: j.jobUrl,
    }));
  },
};

// LiftMyCV is the only source (2026-10-04). Removed: wonsulting (needed a browser cookie that kept
// expiring, and had been returning nothing), jobhose (its search API timed out on nearly every
// call, ~30s each — about half of every cycle) and googledork (paid Serper key). The user's
// decision: nothing here should depend on renewing a token. LiftMyCV is a free public API and
// supplied nearly all of the ~40k jobs demand-crawl added in the week before.
const SOURCES = [liftmycv];

// ---------- storage ----------
async function upsertNormalized(n) {
  if (!n.externalId || !n.company || !n.applyUrl) return 0;
  const c = deriveCompany(n.applyUrl, n.atsHint, n.company, n.source);
  if (!c.slug || !c.careerUrl) return 0;
  // Only store jobs on ATS platforms we can crawl AND apply to — otherwise we re-fill the DB with
  // jobs users can't apply to (the exact cruft the one-time cleanup removed).
  if (!isSupportedAts(c.ats)) return 0;
  if (DRY) return 0;
  const cRes = await query(
    `INSERT INTO companies (company_name, domain, ats, ats_slug, career_url, status, origin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, NOW(), NOW())
     ON CONFLICT (career_url) DO UPDATE SET company_name = COALESCE(companies.company_name, EXCLUDED.company_name), updated_at = NOW()
     RETURNING id`,
    [n.company, c.domain, c.ats, c.slug, c.careerUrl, `demand_${n.source}`]);
  const companyId = cRes.rows[0]?.id;
  if (!companyId) return 0;
  const tags = classifyJob({ title: n.title, location: n.location, description: n.description || '', workplace_type: n.workplaceType }) || {};
  const raw = JSON.stringify({ source: `demand_${n.source}`, applyUrl: n.jobUrl });
  const jRes = await query(
    `INSERT INTO jobs (external_id, company_id, ats, title, location, workplace_type, description, url,
        posted_at, is_remote, remote_worldwide, experience_level, raw_data, first_seen_at, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW())
     ON CONFLICT (external_id, company_id) DO UPDATE SET
       location = EXCLUDED.location, description = COALESCE(EXCLUDED.description, jobs.description),
       url = EXCLUDED.url, last_seen_at = NOW(), removed_at = NULL
     RETURNING (xmax = 0) AS inserted`,
    [String(n.externalId), companyId, c.ats, n.title, n.location, n.workplaceType, n.description, n.jobUrl,
      n.postedAt, n.workplaceType === 'remote' || !!tags.is_remote, !!tags.remote_worldwide, tags.experience_level || null, raw]);
  return jRes.rows[0]?.inserted ? 1 : 0;
}

function splitList(s, cap) { return String(s || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, cap); }

async function crawlDemand(row) {
  const titles = splitList(row.query_text, MAX_TITLES);
  const locList = splitList(row.location, MAX_LOCATIONS);
  const locs = locList.length ? locList : [null];
  const perSource = {};
  let added = 0, fetched = 0;
  for (const title of titles) {
    for (const loc of locs) {
      for (const src of SOURCES.filter((s) => s.enabled())) {
        for (let p = 1; p <= PAGES; p++) {
          let jobs;
          try { jobs = await src.search(title, loc, p); }
          catch (e) { logger.warn({ src: src.name, title, loc, err: e.message }, 'source fetch failed'); break; }
          if (!jobs.length) break;
          fetched += jobs.length;
          for (const j of jobs) { try { const n = await upsertNormalized(j); added += n; perSource[src.name] = (perSource[src.name] || 0) + n; } catch (e) { logger.debug({ err: e.message }, 'upsert failed'); } }
          await sleep(DELAY_MS);
          if (jobs.length < PAGE_SIZE) break;
        }
      }
    }
  }
  // Re-count actual coverage now, so a demand that's now satisfied drops OUT of the unmet queue
  // (otherwise last_result_count keeps its old low value until a user happens to re-search it,
  // and the crawler keeps re-picking it). Best-effort; plainto_tsquery is injection/parse-safe.
  let resultCount = null;
  if (!DRY) {
    try {
      const firstTitle = splitList(row.query_text, 1)[0];
      const firstLoc = splitList(row.location, 1)[0];
      if (firstTitle) {
        const params = [firstTitle];
        let locClause = '';
        if (firstLoc) { locClause = ' AND location ILIKE ?'; params.push(`%${firstLoc}%`); }
        const rc = await query(`SELECT count(*) n FROM jobs WHERE removed_at IS NULL AND search_vector @@ plainto_tsquery('english', ?)${locClause}`, params);
        resultCount = parseInt(rc.rows[0].n, 10);
      }
    } catch (e) { logger.debug({ err: e.message }, 'demand re-count failed'); }
    if (resultCount != null) {
      await query('UPDATE search_demand SET last_crawled_at = NOW(), jobs_added = COALESCE(jobs_added,0) + ?, last_result_count = ? WHERE demand_key = ?', [added, resultCount, row.demand_key]);
    } else {
      await query('UPDATE search_demand SET last_crawled_at = NOW(), jobs_added = COALESCE(jobs_added,0) + ? WHERE demand_key = ?', [added, row.demand_key]);
    }
  }
  return { added, fetched, perSource, resultCount };
}

async function ensureColumns() {
  for (const ddl of ['ALTER TABLE search_demand ADD COLUMN IF NOT EXISTS last_crawled_at TIMESTAMP',
    'ALTER TABLE search_demand ADD COLUMN IF NOT EXISTS jobs_added INTEGER DEFAULT 0']) {
    try { await query(ddl); } catch (e) { logger.warn({ err: e.message }, 'ensureColumns'); }
  }
}

/**
 * Choose this cycle's demand in TWO lanes.
 *
 * The single `ORDER BY search_count DESC` this replaced meant popularity alone
 * decided what got crawled, and the long tail below the LIMIT was never
 * reached at all. That is backwards for the case that matters most: a user on
 * a paid plan with narrow criteria ("Non-Executive Director", UK, executive)
 * generates a demand row searched once or twice a day, while a generic
 * "software engineer" row has hundreds. The niche row sat below the cut-off
 * permanently, so the only way its jobs ever arrived was someone loading them
 * by hand — which is exactly what happened on 2026-09-05.
 *
 * Lane 1, popular: unchanged, most-searched first.
 * Lane 2, starved: never crawled first, then longest-neglected, then emptiest.
 *   search_count is deliberately NOT in this ordering — that is the whole
 *   point. Every due demand reaches the front of this lane eventually, so
 *   coverage no longer depends on being popular.
 *
 * Exported so the selection can be inspected against production without
 * running a crawl: scripts/demand-queue-preview.js.
 */
async function selectDemand({ batch = BATCH, threshold = THRESHOLD, starvedShare = STARVED_SHARE } = {}) {
  const DUE = `COALESCE(last_result_count, 0) <= ? AND query_text IS NOT NULL AND query_text <> ''
        AND (last_crawled_at IS NULL OR last_crawled_at < NOW() - INTERVAL '${RECRAWL_HOURS} hours')`;
  const COLS = 'demand_key, query_text, location, search_count, last_result_count, last_crawled_at';

  const starvedWanted = Math.min(batch, Math.round(batch * starvedShare));
  const popularWanted = batch - starvedWanted;

  const popular = popularWanted > 0
    ? (await query(
      `SELECT ${COLS} FROM search_demand WHERE ${DUE}
        ORDER BY search_count DESC, last_result_count ASC LIMIT ?`,
      [threshold, popularWanted])).rows
    : [];

  // NULLS FIRST is explicit: Postgres defaults to NULLS LAST on ASC, which
  // would put never-crawled demand — the most starved there is — at the back.
  const starved = starvedWanted > 0
    ? (await query(
      `SELECT ${COLS} FROM search_demand WHERE ${DUE}
        ORDER BY last_crawled_at ASC NULLS FIRST, last_result_count ASC, last_seen_at DESC
        LIMIT ?`,
      [threshold, starvedWanted + popular.length])).rows
    : [];

  // A row can qualify for both lanes; take it once, and let the starved lane
  // top up from its own ordering so the reserved slots are not silently lost.
  const seen = new Set(popular.map((r) => r.demand_key));
  const picked = [...popular];
  for (const row of starved) {
    if (picked.length >= batch) break;
    if (seen.has(row.demand_key)) continue;
    seen.add(row.demand_key);
    picked.push({ ...row, lane: 'starved' });
  }
  return picked;
}

async function cycle() {
  const active = SOURCES.filter((s) => s.enabled()).map((s) => s.name);
  logger.info({ sources: active, dry: DRY }, 'demand-crawl: active sources');
  const rows = await selectDemand();
  if (!rows.length) { logger.info('demand-crawl: no unmet demand due'); return { demands: 0, added: 0 }; }
  let totalAdded = 0, totalFetched = 0;
  for (const row of rows) {
    const { added, fetched, perSource, resultCount } = await crawlDemand(row);
    totalAdded += added; totalFetched += fetched;
    logger.info({ q: (row.query_text || '').slice(0, 48), loc: row.location, lane: row.lane || 'popular', searches: row.search_count, was_results: row.last_result_count, now_results: resultCount, fetched, added, perSource, dry: DRY }, 'demand crawled');
  }
  const starvedCount = rows.filter((r) => r.lane === 'starved').length;
  logger.info({ demands: rows.length, starved: starvedCount, popular: rows.length - starvedCount, fetched: totalFetched, added: totalAdded, dry: DRY }, 'demand-crawl cycle complete');
  return { demands: rows.length, added: totalAdded };
}

// Only run the crawl loop when executed directly (`node demand-crawl.js`), not when required
// for testing — otherwise `require()` would kick off a full cycle + closeDb.
if (require.main === module) {
  (async () => {
    if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL'); process.exit(1); }
    await ensureColumns();
    do {
      try { await cycle(); } catch (e) { logger.error({ err: e.message, stack: e.stack }, 'demand-crawl cycle error'); }
      if (LOOP) await sleep(RECHECK_S * 1000);
    } while (LOOP);
    await closeDb();
    process.exit(0);
  })().catch((e) => { logger.error({ err: e.message }, 'demand-crawl fatal'); process.exit(1); });
}

module.exports = { cycle, crawlDemand, upsertNormalized, deriveCompany, ensureColumns, selectDemand };
