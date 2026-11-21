#!/usr/bin/env node
/**
 * Pull whole catalogs from third-party job aggregators into STAGING, as raw payloads.
 *
 * LOCAL ONLY. Refuses any DATABASE_URL that is not localhost.
 *
 * This is capture, not import. Every job lands verbatim in agg_raw(source, ext_id, payload) and
 * nothing touches companies/jobs. Mapping a payload onto an employer is where every earlier
 * importer lost data (unsupported platform -> skip, unknown board shape -> skip), so it is kept
 * out of the fetch path: a mapping bug can be fixed and re-run against agg_raw without asking
 * the source again.
 *
 * WHY SHARDS. The search APIs cap how deep you can page — LiftMyCV errors past offset 10,000 and
 * Wonsulting stops at 10,000 results per query — while holding far more than that. So each
 * catalog is walked as many narrow queries (one per role from scripts/job-roles.js), and any query
 * that reports more than the cap is split again by location. agg_shards records every query and
 * the page it reached, so a stopped run resumes where it left off and a finished one is not redone.
 *
 * Sources
 *   liftmycv   public keyword API              roles x (locations when a role exceeds 10k)
 *   wonsulting JobBoardAI, WONSULTING_COOKIE   roles x (US states when a role exceeds 10k)
 *   jobhose    scale.jobs public API           first JOBHOSE_MAX_PAGES pages per role (sampled, see below)
 *   workable   jobs.workable.com marketplace   one cursor walk over the whole marketplace
 *   allscm     portal.allscmjobs.com feed      one XML document
 *   jobloo     api.jobloo.co, JOBLOO_TOKEN     15 category shards, 10k rows a request
 *   resumly    resumly.ai, RESUMLY_TOKEN       roles through the account's ONE saved-query slot
 *   trueup     trueup.io, TRUEUP_CLIENT_COOKIE updated_at ranges, halved until each holds <= 300
 *   trulyremotework trulyremotework.com        jobs sitemap -> each job page's JobPosting + Apply link
 *   thehub     thehub.io                       THEHUB_COUNTRIES listing pages (default EU) -> job page link
 *   platsbanken jobtechdev.se (Arbetsförmedlingen) every Swedish ad, per county, date-halved past 1,900
 *   sprout     api.usesprout.com open job detail  live id band, 100k blocks x SPROUT_STRIDE passes
 *   aiapply    aiapply.co, AIAPPLY_COOKIE      search=* per employer (companies=), split by country / remote / city / newest past 1,000
 *
 *   node --env-file=.env scripts/pull-aggregators-local.js                  # all sources
 *   SOURCES=workable,allscm node --env-file=.env scripts/pull-aggregators-local.js
 *   LIMIT_SHARDS=2 MAX_PAGES=2 SOURCES=liftmycv node ...                      # smoke test
 *   RESET_ERRORS=1 ...                                                        # retry failed shards
 *   REFRESH=1 SOURCES=liftmycv ...                                            # re-walk a finished source
 *
 * REFRESH=1 sends every shard of the chosen sources back to the start, so a source pulled weeks
 * ago is walked again for what it has added since. Records are upserted on (source, ext_id), so a
 * repeat costs nothing; the new ones are those whose first_fetched_at is after the run started,
 * and map-aggregators-local.js SINCE=<that time> maps just them.
 */
const { Pool } = require('pg');
const crypto = require('crypto');
const { ALL_ROLES } = require('./job-roles');

const DB = process.env.DATABASE_URL || 'postgres://codev@localhost:5432/jobs_local';
{
  const host = (() => { try { return new URL(DB).hostname; } catch { return ''; } })();
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    console.error(`Refusing to run: ${host || 'DATABASE_URL'} is not local. This script only writes staging.`);
    process.exit(1);
  }
}
const SOURCES = (process.env.SOURCES || 'liftmycv,wonsulting,jobhose,workable,allscm,jobloo,resumly').split(',').map((s) => s.trim()).filter(Boolean);
const LIMIT_SHARDS = parseInt(process.env.LIMIT_SHARDS || '0', 10);
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '0', 10);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (s) => crypto.createHash('md5').update(String(s)).digest('hex');

const US_STATES = ['Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware',
  'District of Columbia', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky',
  'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Montana',
  'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio',
  'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah',
  'Vermont', 'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming'];
const COUNTRIES = ['United Kingdom', 'Canada', 'Germany', 'France', 'Netherlands', 'Ireland', 'Spain', 'Italy', 'Poland',
  'Portugal', 'Sweden', 'Switzerland', 'Belgium', 'Austria', 'Denmark', 'Norway', 'Finland', 'Czechia', 'Romania', 'India',
  'Singapore', 'Australia', 'New Zealand', 'Japan', 'Philippines', 'Mexico', 'Brazil', 'Argentina', 'Colombia',
  'United Arab Emirates', 'Saudi Arabia', 'Israel', 'South Africa', 'Nigeria', 'Kenya', 'Remote'];

// ---------------------------------------------------------------- http

class HttpError extends Error { constructor(status, msg) { super(msg || `HTTP ${status}`); this.status = status; } }

/** Fetch JSON/text with patience: 429 waits (retry-after or doubling), 5xx/network retried, 4xx thrown. */
async function request(url, init = {}, { as = 'json', timeoutMs = 90000, attempts = 6 } = {}) {
  let wait = 5000;
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { ...init, headers: { 'user-agent': UA, ...(init.headers || {}) }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 429 || res.status === 503) {
        const ra = Number(res.headers.get('retry-after'));
        const ms = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 600000) : Math.min(wait * 2, 600000);
        wait = ms;
        if (i >= attempts + 4) throw new HttpError(res.status, `HTTP ${res.status} after ${i} tries`);
        await sleep(ms);
        continue;
      }
      if (res.status >= 500) throw new HttpError(res.status);
      if (!res.ok) { const e = new HttpError(res.status); e.permanent = true; throw e; }
      return as === 'text' ? await res.text() : await res.json();
    } catch (e) {
      if (e.permanent || i >= attempts) throw e;
      await sleep(wait);
      wait = Math.min(wait * 2, 120000);
    }
  }
}

// ---------------------------------------------------------------- sources
//
// Each source: seed() -> shard keys; page(shard, cursor) -> { items: [{id, payload}], next, total, split }
// `next` null means the shard is finished. `split` asks for sub-shards when the query exceeds the cap.

const liftmycv = {
  name: 'liftmycv', conc: 3, delayMs: 800,
  seed: () => ALL_ROLES.map((r) => `role:${r}`),
  async page(shard, cursor) {
    const page = Number(cursor || 1);
    const [, role, loc] = shard.match(/^role:(.*?)(?:\|loc:(.*))?$/);
    const p = new URLSearchParams({ roles: role, count: '100', page: String(page) });
    if (loc) p.set('location', loc);
    const d = await request(`https://app.liftmycv.com/api/v1/jobs/search?${p}`);
    const jobs = d?.results?.jobs || [];
    const total = d?.results?.total || 0;
    // Past 10,000 the API 500s. A role that big is re-asked per location instead.
    const split = page === 1 && total > 10000 && !loc ? [...US_STATES, ...COUNTRIES].map((l) => `role:${role}|loc:${l}`) : null;
    const reachable = Math.min(total, 10000);
    return { items: jobs.map((j) => ({ id: j.id, payload: j })), total, split,
      next: jobs.length === 100 && page * 100 < reachable ? String(page + 1) : null };
  },
};

const WONSULTING_COOKIE = (process.env.WONSULTING_COOKIE || '').replace(/[\r\n]+/g, '').trim();
const WONSULTING_XSRF = (() => {
  const m = WONSULTING_COOKIE.match(/XSRF-TOKEN=([^;]+)/);
  try { return m ? decodeURIComponent(m[1]).replace(/[^\x20-\x7E]/g, '') : ''; } catch { return ''; }
})();
const wonsulting = {
  // An account session, not an open API: one request at a time, well spaced.
  //
  // Its search is fuzzy: nearly every title reports the 10,000 cap ("Aerospace Engineer" and a
  // blank query alike), and `location` does not narrow it ("Software Engineer" + Wyoming is still
  // 10,000). Location shards would re-fetch the same rows, so there are none. Instead each role
  // is walked until its pages stop yielding rows we have not already stored (staleStop below) —
  // past that point a fuzzy query is only returning other roles' jobs again.
  name: 'wonsulting', conc: 1, delayMs: 1200, staleStop: { pages: 3, newShare: 0.1 },
  enabled: () => !!(WONSULTING_COOKIE && WONSULTING_XSRF),
  seed: () => ALL_ROLES.map((r) => `role:${r}`),
  async page(shard, cursor) {
    const page = Number(cursor || 1);
    const [, role, loc] = shard.match(/^role:(.*?)(?:\|loc:(.*))?$/);
    const body = { job_title: role, location: loc || '', work_setting: null, last_posted: null, longitude: null, latitude: null,
      page, jobs_per_page: 100, sort_by: 'posted_at', sort_direction: 'desc', industry: null, radius: null,
      min_experience: null, max_experience: null, min_salary: null, max_salary: null, auto_apply_filter: false };
    const d = await request('https://app.wonsulting.com/api/job-board/find-jobs', { method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/plain, */*', 'x-xsrf-token': WONSULTING_XSRF,
        referer: 'https://app.wonsulting.com/job-board/search', origin: 'https://app.wonsulting.com', cookie: WONSULTING_COOKIE } });
    const jobs = d?.jobs || [];
    const count = Number(d?.jobs_count || 0);
    return { items: jobs.map((j) => ({ id: j.provider_job_id || j.id || md5(j.apply_url), payload: j })), total: count,
      next: jobs.length === 100 && page * 100 < Math.min(count, 10000) ? String(page + 1) : null };
  },
};

// jobhose cannot be drained, only sampled. Measured 2026-09-15: the catalog reports 3,822,521
// postings, but one request takes 20-60s, four in parallel took 170-240s each (or timed out), and
// paging past a few thousand rows answers 500 after a minute or more. `take` above 100 is a 500
// too. So this walks one query at a time, the first JOBHOSE_MAX_PAGES pages of each role. Its
// payloads name the ATS and board (ext:grnhse___capco___8124694), so the lasting value is the
// boards it surfaces for our own crawlers, which then take every job from the board directly.
const JOBHOSE_MAX_PAGES = parseInt(process.env.JOBHOSE_MAX_PAGES || '10', 10);
const jobhose = {
  name: 'jobhose', conc: 1, delayMs: 2000,
  seed: () => ALL_ROLES.map((r) => `role:${r}`),
  async page(shard, cursor) {
    const skip = Number(cursor || 0);
    const role = shard.slice('role:'.length);
    const p = new URLSearchParams({ userId: process.env.JOBHOSE_USER_ID || 'user_demandcrawl', jobTitles: role, take: '100',
      skip: String(skip), source: 'live' });
    const d = await request(`https://jobhose-prod.scale.jobs/api/search-jobs?${p}`,
      { headers: { origin: 'https://scale.jobs', referer: 'https://scale.jobs/' } }, { timeoutMs: 240000, attempts: 2 });
    const jobs = d?.jobs || [];
    const nextSkip = skip + jobs.length;
    return { items: jobs.map((j) => ({ id: j.id || j.externalId || md5(j.url), payload: j })), total: d?.totalCount || 0,
      next: d?.hasMore && jobs.length && nextSkip < JOBHOSE_MAX_PAGES * 100 ? String(nextSkip) : null };
  },
};

const workable = {
  // 400ms was enough for 3,916 pages and then earned a 429 that ten retries could not outlast.
  // The marketplace is one long cursor walk, so the pace has to suit the whole walk, not its start.
  name: 'workable', conc: 1, delayMs: parseInt(process.env.WORKABLE_DELAY_MS || '1500', 10),
  seed: () => ['all'],
  async page(shard, cursor) {
    const url = `https://jobs.workable.com/api/v1/jobs?query=&location=${cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ''}`;
    const d = await request(url);
    const jobs = d?.jobs || [];
    return { items: jobs.map((j) => ({ id: j.id, payload: j })), total: d?.totalSize || 0,
      next: d?.nextPageToken && jobs.length ? d.nextPageToken : null };
  },
};

// jobloo needs an account bearer token since ~2026-09 (the userId-only call now 401s). Cost is per
// REQUEST, not per row — limit=1 and limit=10000 both take ~110s — so pages are as large as the API
// allows (50000 is a 502, 20000 is slower overall). Categories are its only shard dimension and the
// depths come from the earlier fetcher's measurements.
const JOBLOO_TOKEN = (process.env.JOBLOO_TOKEN || '').replace(/^Bearer\s+/i, '').trim();
const JOBLOO_CATEGORIES = ['Noise', 'Sales', 'Software Engineering', 'Operations & Strategy', 'Misc. Engineering',
  'Finance', 'Marketing', 'Data', 'Human Resources', 'General', 'Consulting', 'Design', 'Security', 'Product', 'Legal'];
const jobloo = {
  name: 'jobloo', conc: 4, delayMs: 0,
  enabled: () => !!JOBLOO_TOKEN,
  seed: () => JOBLOO_CATEGORIES.map((c) => `cat:${c}`),
  async page(shard, cursor) {
    const offset = Number(cursor || 0);
    const limit = parseInt(process.env.JOBLOO_PAGE_SIZE || '10000', 10);
    const d = await request('https://api.jobloo.co/api/jobs/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${JOBLOO_TOKEN}`,
        origin: 'https://jobloo.co', referer: 'https://jobloo.co/' },
      body: JSON.stringify({ userId: process.env.JOBLOO_USER_ID || '0fc2e7a1-f50b-4cab-99e4-9bdcecda4eb9',
        categories: [shard.slice('cat:'.length)], subcategories: [], locations: [], experience_levels: [],
        job_types: [], languages: [], limit, offset }),
    }, { timeoutMs: 600000, attempts: 3 });
    const jobs = d?.jobs || [];
    // Each job carries both an HTML and a *Plain mirror of description, opening, body and
    // additional. At ~2.15M rows that duplication is tens of GB of staging for text we can
    // re-derive, so only the HTML side is kept.
    const items = jobs.map((j) => {
      const { descriptionPlain, openingPlain, descriptionBodyPlain, additionalPlain, salaryDescriptionPlain, ...keep } = j;
      return { id: j.id, payload: keep };
    });
    return { items, total: Number(d?.total) || 0, next: jobs.length >= limit ? String(offset + jobs.length) : null };
  },
};

// resumly meters its database through ONE saved query per account (plan cap: 1 slot), so a pull has
// to point that slot at each role in turn, page it out (~1,000 rows max), then move on. That makes
// it stateful in a way the other sources are not: conc must stay 1, and the slot is restored to the
// account's own search when the run ends. Auth is a Cognito id token that expires in 24h — when it
// does, shards fail with 401 and resume with a fresh RESUMLY_TOKEN and RESET_ERRORS=1.
const RESUMLY_TOKEN = (process.env.RESUMLY_TOKEN || '').replace(/^Bearer\s+/i, '').trim();
const RESUMLY_QID = process.env.RESUMLY_QUERY_ID || '6a67bb089414f50fe39fa14c';
const RESUMLY_BASE = 'https://8tilziinw8.execute-api.us-east-1.amazonaws.com/Prod/job-search';
const RESUMLY_MAX_PAGES = parseInt(process.env.RESUMLY_MAX_PAGES || '40', 10);
const resumlyHeaders = () => ({ authorization: `Bearer ${RESUMLY_TOKEN}`, origin: 'https://app.resumly.ai', 'content-type': 'application/json' });
async function resumlySetQuery(titles, locations) {
  const body = { query_id: RESUMLY_QID, query_name: 'demandcrawl', title_filter: titles };
  if (locations) body.location_filter = locations;
  return request(`${RESUMLY_BASE}/query/${RESUMLY_QID}`, { method: 'PUT', body: JSON.stringify(body), headers: resumlyHeaders() }, { attempts: 3 });
}
const resumly = {
  name: 'resumly', conc: 1, delayMs: 350,
  enabled: () => !!RESUMLY_TOKEN,
  seed: () => ALL_ROLES.map((r) => `role:${r}`),
  async page(shard, cursor) {
    const page = Number(cursor || 1);
    const role = shard.slice('role:'.length);
    // Point the one slot at this role before its first page. A bare title filter is preferred —
    // it is the widest — with the US filter as the fallback the API accepts.
    if (page === 1) {
      try { await resumlySetQuery([role], null); }
      catch { await resumlySetQuery([role], ['United States']); }
    }
    const size = parseInt(process.env.RESUMLY_PAGE_SIZE || '50', 10);
    const d = await request(`${RESUMLY_BASE}/public-jobs-supplemental?query_id=${RESUMLY_QID}&page=${page}&page_size=${size}`,
      { headers: resumlyHeaders() }, { attempts: 3 });
    const rows = d?.result || [];
    return { items: rows.map((j) => ({ id: j.id || j._id, payload: j })), total: Number(d?.total) || null,
      next: d?.has_more && rows.length && page < RESUMLY_MAX_PAGES ? String(page + 1) : null };
  },
  async finish() {
    const t = process.env.RESUMLY_RESTORE_TITLE || 'financial analyst';
    const l = process.env.RESUMLY_RESTORE_LOCATION || 'United States';
    try { await resumlySetQuery([t], [l]); console.log(`[resumly] saved search restored to "${t}" / ${l}`); }
    catch (e) { console.log(`[resumly] could not restore saved search: ${e.message}`); }
  },
};

// TrueUp holds 274,667 jobs but answers at most 300 per query (Algolia's paginationLimitedTo: page
// 1 of hitsPerPage=1000 is already empty), so the catalog is cut by updated_at_timestamp: ask a
// range, and if it holds more than 300, split it in half and ask each side. ~1,000 leaf ranges.
//
// Auth is Clerk, and a TrueUp session token lives SIXTY SECONDS — a pasted one is dead on arrival.
// What lasts is the browser's __client cookie, which mints tokens on demand exactly as the site
// does, so that is what this holds. Only /jobs/search/member accepts them; /jobs/search 401s.
// The WHOLE cookie jar, not just __client. trueup.io sits behind Cloudflare, so the mint also
// needs cf_clearance/__cf_bm; and Clerk rotates __client on every use, so a cookie copied on its
// own is usually already stale by the time it is used. Copy-as-cURL gives both at once, along with
// the current session id — which changes on re-login and was the actual cause of the 401 on
// 2026-09-24. TRUEUP_CLIENT_COOKIE is still honoured for the bare-__client form.
const TRUEUP_COOKIE = (process.env.TRUEUP_COOKIE
  || (process.env.TRUEUP_CLIENT_COOKIE ? `__client=${process.env.TRUEUP_CLIENT_COOKIE.trim()}` : '')).trim();
const TRUEUP_SID = (process.env.TRUEUP_SESSION_ID || '').trim();
const TRUEUP_API_VERSION = process.env.TRUEUP_API_VERSION || '2026-05-12';
const TRUEUP_JS_VERSION = process.env.TRUEUP_JS_VERSION || '6.32.0';
const TRUEUP_HITS = 300;
let truToken = null, truTokenExp = 0;
async function trueupToken() {
  if (truToken && Date.now() < truTokenExp - 10000) return truToken;
  const r = await request(`https://clerk.trueup.io/v1/client/sessions/${TRUEUP_SID}/tokens?__clerk_api_version=${TRUEUP_API_VERSION}&_clerk_js_version=${TRUEUP_JS_VERSION}`,
    { method: 'POST', headers: { cookie: TRUEUP_COOKIE, origin: 'https://www.trueup.io', referer: 'https://www.trueup.io/',
      'content-type': 'application/x-www-form-urlencoded' }, body: 'organization_id=&tab_state=hidden' }, { attempts: 4 });
  if (!r?.jwt) throw new Error('trueup: no token minted (cookie expired?)');
  truToken = r.jwt;
  truTokenExp = Date.now() + 55000;
  return truToken;
}
const trueup = {
  name: 'trueup', conc: 2, delayMs: 300,
  enabled: () => !!(TRUEUP_COOKIE && TRUEUP_SID),
  // 2015-01-01 .. now+1d, split down from there.
  // TRUEUP_SINCE makes a re-pull proportional to what changed. Its filter is on
  // updated_at_timestamp, so starting the walk at the last pull instead of 2015 asks only for jobs
  // touched since — minutes rather than the full 274k-row descent.
  seed: () => [`ts:${parseInt(process.env.TRUEUP_SINCE || '1420070400', 10)}-${Math.floor(Date.now() / 1000) + 86400}`],
  async page(shard) {
    const [lo, hi] = shard.slice('ts:'.length).split('-').map(Number);
    const tok = await trueupToken();
    const d = await request('https://arc.trueup.io/jobs/search/member', {
      method: 'POST',
      headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', origin: 'https://www.trueup.io', referer: 'https://www.trueup.io/' },
      body: JSON.stringify([{ indexName: 'job', params: { query: '', facets: [], maxValuesPerFacet: 500, trueupRequestVersion: 2,
        hitsPerPage: TRUEUP_HITS, page: 0, numericFilters: [`updated_at_timestamp>=${lo}`, `updated_at_timestamp<${hi}`] } }]),
    }, { timeoutMs: 120000, attempts: 4 });
    const res = d?.results?.[0] || d?.[0] || d;
    const hits = res?.hits || [];
    const nb = Number(res?.nbHits) || 0;
    // Too many for one answer: halve the range. The 300 rows in hand are still kept — they are
    // real jobs, and the halves re-fetch them harmlessly (same ids, one row).
    const mid = Math.floor((lo + hi) / 2);
    const split = nb > TRUEUP_HITS && hi - lo > 1 ? [`ts:${lo}-${mid}`, `ts:${mid}-${hi}`] : null;
    return { items: hits.map((j) => ({ id: j.objectID || j.job_id, payload: j })), total: nb, split, next: null };
  },
};

/** One flat XML feed. Each <job> becomes an object of its child tags. */
const allscm = {
  name: 'allscm', conc: 1, delayMs: 0,
  seed: () => ['feed'],
  async page() {
    const xml = await request('https://portal.allscmjobs.com/jobs.xml', {}, { as: 'text', timeoutMs: 300000 });
    const items = [];
    for (const m of xml.matchAll(/<job[\s>]([\s\S]*?)<\/job>/g)) {
      const o = {};
      for (const t of m[1].matchAll(/<([a-zA-Z_][\w-]*)[^>]*>([\s\S]*?)<\/\1>/g)) {
        o[t[1]] = t[2].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1').trim();
      }
      const id = o.id || o.referencenumber || o.guid || md5(o.url || o.apply_url || JSON.stringify(o));
      items.push({ id, payload: o });
    }
    return { items, total: items.length, next: null };
  },
};

// ---------------------------------------------------------------- job-page boards
//
// trulyremotework and thehub are boards of other employers' postings: each job page carries a
// schema.org JobPosting and a link to the employer's own application page. That link is the
// point — the mapper turns it into an employer board our crawlers then read in full.
//
// Employers on Teamtailor often serve it on their own domain (careers.shine.co), which no URL rule
// can recognise. teamtailorHost() asks each such host once whether it is Teamtailor (its pages load
// teamtailor-cdn.com) and the item carries the answer for the mapper. Measured 2026-10-04: 12 of
// 25 sampled The Hub jobs were Teamtailor custom domains, all five checked serve /jobs.rss.

function jobPosting(html) {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const d = JSON.parse(m[1]);
      const all = Array.isArray(d) ? d : (d['@graph'] || [d]);
      const jp = all.find((o) => o && o['@type'] === 'JobPosting');
      if (jp) return jp;
    } catch { /* malformed block: try the next one */ }
  }
  return null;
}

const KNOWN_ATS_HOST = /greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|myworkday(jobs|site)\.com|bamboohr\.com|breezy\.hr|applytojob\.com|rippling\.com|zohorecruit\.|personio\.(de|com)|jobvite\.com|paylocity\.com|pinpointhq\.com|recruitee\.com|teamtailor\.com|comeet\.|icims\.com|oraclecloud\.com|taleo\.net|linkedin\.com/i;
const ttHosts = new Map();
async function teamtailorHost(applyUrl) {
  let u;
  try { u = new URL(applyUrl); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (KNOWN_ATS_HOST.test(host)) return null;
  if (!ttHosts.has(host)) {
    let tt = false;
    try {
      const html = await request(`https://${host}/`, {}, { as: 'text', timeoutMs: 20000, attempts: 2 });
      tt = /teamtailor-cdn\.com|teamtailor-production/.test(html);
    } catch { /* unreachable host: not something we can crawl either way */ }
    ttHosts.set(host, tt ? host : null);
  }
  return ttHosts.get(host);
}

const JOB_PAGE_DELAY_MS = parseInt(process.env.JOB_PAGE_DELAY_MS || '1000', 10);

// trulyremotework.com — ~700 remote jobs. Its sitemap lists every job page; /api/ is disallowed in
// robots.txt and is not used. One shard, cursor = position in the sitemap, 20 pages per step.
let trwUrls = null;
const trulyremotework = {
  name: 'trulyremotework', conc: 1, delayMs: 0,
  seed: () => ['sitemap'],
  async page(shard, cursor) {
    if (!trwUrls) {
      const xml = await request('https://trulyremotework.com/sitemap-jobs/1.xml', {}, { as: 'text' });
      trwUrls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
    }
    const start = Number(cursor || 0);
    const items = [];
    for (const url of trwUrls.slice(start, start + 20)) {
      let html;
      try { html = await request(url, {}, { as: 'text', timeoutMs: 30000, attempts: 3 }); }
      catch (e) { if (e.permanent) continue; throw e; }   // a removed posting 404s: skip it
      const jp = jobPosting(html) || {};
      const apply = (html.match(/<a[^>]+href="(https?:\/\/(?!(?:www\.)?trulyremotework\.com)[^"]+)"[^>]*>\s*(?:<[^>]+>\s*)*Apply/i) || [])[1] || null;
      const where = [].concat(jp.applicantLocationRequirements || []).map((x) => (x && x.name) || x).filter((x) => typeof x === 'string');
      items.push({ id: url, payload: {
        url, applyUrl: apply ? apply.replace(/&amp;/g, '&') : null,
        title: jp.title || null, company: jp.hiringOrganization && jp.hiringOrganization.name,
        // A worldwide role lists every accepted country (~190 for Canonical): kept as text it would put
        // the job under every country filter. Past a handful of countries it is a worldwide role.
        location: !where.length ? 'Remote' : where.length > 8 ? 'Worldwide' : `Remote - ${where.join(', ')}`,
        remote: jp.jobLocationType || null, datePosted: jp.datePosted || null, description: jp.description || null,
        teamtailorHost: apply ? await teamtailorHost(apply) : null,
      } });
      await sleep(JOB_PAGE_DELAY_MS);
    }
    return { items, total: trwUrls.length, next: start + 20 < trwUrls.length ? String(start + 20) : null };
  },
};

// thehub.io — Nordic/European startup jobs. Listing pages by country code (THEHUB_COUNTRIES, default
// EU), 15-16 jobs each; the employer's application link is the `link` field of the job page's
// embedded state. One shard per country code, cursor = listing page number.
const thehub = {
  name: 'thehub', conc: 1, delayMs: 0,
  seed: () => (process.env.THEHUB_COUNTRIES || 'EU').split(',').map((s) => s.trim()).filter(Boolean),
  async page(shard, cursor) {
    const p = Number(cursor || 1);
    const list = await request(`https://thehub.io/jobs?countryCode=${encodeURIComponent(shard)}&sorting=mostPopular&page=${p}`, {}, { as: 'text' });
    const pages = Number((list.match(/\bpages:(\d+)/) || [])[1] || p);
    const ids = [...new Set([...list.matchAll(/\/jobs\/([0-9a-f]{24})/g)].map((m) => m[1]))];
    const items = [];
    for (const id of ids) {
      let html;
      try { html = await request(`https://thehub.io/jobs/${id}`, {}, { as: 'text', timeoutMs: 30000, attempts: 3 }); }
      catch (e) { if (e.permanent) continue; throw e; }
      const jp = jobPosting(html) || {};
      let link = (html.match(/\blink:"([^"]+)"/) || [])[1] || null;
      if (link) { try { link = JSON.parse(`"${link}"`); } catch { /* keep as found */ } }
      const addr = (jp.jobLocation && (jp.jobLocation.address || (jp.jobLocation[0] || {}).address)) || {};
      items.push({ id, payload: {
        url: `https://thehub.io/jobs/${id}`, applyUrl: link && /^https?:\/\//.test(link) ? link : null,
        title: jp.title || null, company: jp.hiringOrganization && jp.hiringOrganization.name,
        location: [addr.addressLocality, addr.addressCountry].filter(Boolean).join(', ') || null,
        employmentType: jp.employmentType || null, datePosted: jp.datePosted || null, description: jp.description || null,
        teamtailorHost: link ? await teamtailorHost(link) : null,
      } });
      await sleep(JOB_PAGE_DELAY_MS);
    }
    return { items, total: null, next: ids.length && p < pages ? String(p + 1) : null };
  },
};

// platsbanken — Arbetsförmedlingen's public JobTech API (jobsearch.api.jobtechdev.se), every live
// Swedish job ad (~40k), open, no key. Each ad is stored whole: the employer's apply link is
// application_details.url, remote/hybrid is workplace_model. Many link to Swedish platforms First
// Apply does not apply on yet (Varbi, ReachMee) — kept anyway, for when it does.
//
// A query pages at most ~2,000 deep, so the catalog is walked per county (`region`, the 21 län
// codes) and a county over the cap is split by halving its publication-date window until each
// slice fits. Shard key: "<region>|<publishedAfter>|<publishedBefore>".
const PB_REGIONS = ['01', '03', '04', '05', '06', '07', '08', '09', '10', '12', '13', '14', '17', '18', '19', '20', '21', '22', '23', '24', '25'];
const PB_CAP = 1900;
const PB_FROM = '2020-01-01T00:00:00';
const PB_TO = '2031-01-01T00:00:00';
const platsbanken = {
  name: 'platsbanken', conc: 2, delayMs: 400,
  seed: () => PB_REGIONS.map((r) => `${r}|${PB_FROM}|${PB_TO}`),
  async page(shard, cursor) {
    const [region, from, to] = shard.split('|');
    const offset = Number(cursor || 0);
    const qs = new URLSearchParams({ region, 'published-after': from, 'published-before': to, limit: '100', offset: String(offset) });
    const d = await request(`https://jobsearch.api.jobtechdev.se/search?${qs}`, { headers: { accept: 'application/json' } }, { timeoutMs: 120000 });
    const total = (d.total && d.total.value) || 0;
    if (offset === 0 && total > PB_CAP) {
      const a = new Date(`${from}Z`).getTime(), b = new Date(`${to}Z`).getTime();
      if (b - a > 3600 * 1000) {   // an hour that still holds >1,900 ads cannot be split further
        const mid = new Date(a + Math.floor((b - a) / 2)).toISOString().slice(0, 19);
        return { items: [], total, next: null, split: [`${region}|${from}|${mid}`, `${region}|${mid}|${to}`] };
      }
    }
    const hits = d.hits || [];
    const items = [];
    for (const h of hits) {
      const apply = (h.application_details && h.application_details.url) || null;
      items.push({ id: h.id, payload: { ...h, teamtailorHost: apply && /^https?:\/\/(careers?|jobs?|jobb|karriar|karriär)\./i.test(apply) ? await teamtailorHost(apply) : null } });
    }
    const next = hits.length === 100 && offset + 100 < Math.min(total, PB_CAP + 100) ? String(offset + 100) : null;
    return { items, total, next };
  },
};

// The ad payload's workplace_model is usually empty, yet the API's own remote=true filter knows which
// ads are remote (574 on 2026-10-04). This records that set — ad id only — so the mapper can mark
// those ads remote without the county walk having to know.
const platsbanken_remote = {
  name: 'platsbanken_remote', conc: 1, delayMs: 400,
  seed: () => ['remote'],
  async page(shard, cursor) {
    const offset = Number(cursor || 0);
    const d = await request(`https://jobsearch.api.jobtechdev.se/search?remote=true&limit=100&offset=${offset}`, { headers: { accept: 'application/json' } }, { timeoutMs: 120000 });
    const hits = d.hits || [];
    const total = (d.total && d.total.value) || 0;
    return { items: hits.map((h) => ({ id: h.id, payload: { remote: true } })), total,
      next: hits.length === 100 && offset + 100 < Math.min(total, PB_CAP + 100) ? String(offset + 100) : null };
  },
};

// sprout — api.usesprout.com, a job board fed mostly by jobdataapi. Nearly every posting links to the
// employer's own ATS page (Workday, ADP, UKG, SmartRecruiters, Oracle...) and carries a company logo,
// which makes it a board-discovery and logo source rather than a jobs source in itself.
//
// Its listing endpoint needs an account bearer token that lives 60 minutes, so it is not used. The
// job-detail endpoint GET /jobs/<id> is open, and ids are sequential, so the live id band is walked
// directly. Probed 2026-11-09: ids below ~69.5M are expired (404), the band is dense from ~72M up to
// the newest id (~77M), ~45% of ids resolve overall.
//
// ORDER. The band is ~7.5M ids, days of requests. It is cut into 100k-id blocks, and each block into
// SPROUT_STRIDE interleaved passes (pass p walks ids start+p, start+p+stride, ...). Shard keys sort
// pass-first ("p0|...", "p1|..."), so pass 0 finishes across the WHOLE band before pass 1 starts: a
// run stopped at any point holds an even sample of everything rather than one dense corner.
// The top of the band moves (new jobs every hour), so seed() finds the newest id each run and
// REFRESH=1 is not needed to pick up new blocks — they are added as new shards.
const SPROUT_LO = parseInt(process.env.SPROUT_LO || '69500000', 10);
const SPROUT_BLOCK = 100000;
const SPROUT_STRIDE = parseInt(process.env.SPROUT_STRIDE || '10', 10);
const SPROUT_STEP = 100;                                             // ids per page() call
const SPROUT_INNER = parseInt(process.env.SPROUT_INNER || '5', 10);  // requests in flight per shard
const SPROUT_SKIP_BELOW = parseInt(process.env.SPROUT_SKIP_BELOW || '5', 10);  // pass-0 hits under which a block is skipped
async function sproutJob(id) {
  try { return await request(`https://api.usesprout.com/jobs/${id}`, { headers: { accept: 'application/json' } }, { timeoutMs: 30000, attempts: 4 }); }
  catch (e) { if (e.status === 404) return null; throw e; }
}
async function sproutTop() {
  // Search DOWN from well above the newest id: the first 50k step where sampled ids resolve is the
  // top. Climbing up from the bottom does not work: the bottom is full of expired gaps (70.2-70.5M
  // answered nothing on 2026-11-09), and a climb read the first gap as the end of the band.
  for (let at = SPROUT_LO + 15000000; at > SPROUT_LO; at -= 50000) {
    const probes = Array.from({ length: 15 }, () => sproutJob(at + Math.floor(Math.random() * 50000)).catch(() => null));
    if ((await Promise.all(probes)).some(Boolean)) return at + 50000;
  }
  return SPROUT_LO;
}
const sprout = {
  name: 'sprout', conc: parseInt(process.env.SPROUT_SHARDS || '8', 10), delayMs: 0,
  async seed() {
    const top = await sproutTop();
    console.log(`[sprout] live band ${SPROUT_LO.toLocaleString()} .. ${top.toLocaleString()}`);
    const keys = [];
    for (let p = 0; p < SPROUT_STRIDE; p++) {
      for (let b = Math.floor(SPROUT_LO / SPROUT_BLOCK) * SPROUT_BLOCK; b < top; b += SPROUT_BLOCK) {
        keys.push(`p${String(p).padStart(2, '0')}|${String(b).padStart(9, '0')}`);
      }
    }
    return keys;
  },
  async page(shard, cursor) {
    const [ps, bs] = shard.split('|');
    const p = Number(ps.slice(1)), block = Number(bs);
    const perShard = Math.ceil(SPROUT_BLOCK / SPROUT_STRIDE);
    // A block whose first pass found almost nothing is expired jobs end to end (the bottom of the
    // band): its other passes would be ~10,000 404s each for a handful of rows. Skip them.
    if (p > 0 && !cursor) {
      const { rows: [first] } = await pool.query(
        `SELECT status, fetched FROM agg_shards WHERE source = 'sprout' AND shard = $1`, [`p00|${bs}`]);
      if (first && first.status === 'done' && first.fetched < SPROUT_SKIP_BELOW) return { items: [], total: 0, next: null };
    }
    const from = Number(cursor || 0);
    const idx = Array.from({ length: Math.min(SPROUT_STEP, perShard - from) }, (_, i) => from + i);
    const items = [];
    let j = 0;
    await Promise.all(Array.from({ length: SPROUT_INNER }, async () => {
      while (j < idx.length) {
        const id = block + p + SPROUT_STRIDE * idx[j++];
        const d = await sproutJob(id);
        if (d && d.id) items.push({ id: d.id, payload: d });
      }
    }));
    const next = from + idx.length;
    return { items, total: null, next: next < perShard ? String(next) : null };
  },
};

// aiapply.co: an account session (AIAPPLY_COOKIE = the aiapply_session + XSRF-TOKEN cookies), so
// one request at a time, well spaced. Measured 2026-11-13:
//   - /api/jobs serves at most 1,000 hits per query (offset >= 1000 is empty), but limit=1000 is
//     accepted, so a query is ONE request (~7 MB, ~3 s).
//   - A blank search returns only a subset (Luxembourg: 165 blank vs 273 for "engineer"), so the
//     catalog is walked by role, like the other keyword sources.
//   - remote=true|false and countryCode narrow it; seniority is ignored. city+lat/lon narrows to a
//     radius; lat/lon on a country's centroid narrows to jobs located only as "<country>".
//   - sort=desc (newest) returns a different 1,000 than relevance, so a leaf still at the cap is
//     also asked newest-first.
// A role over the cap splits by country, a country over the cap by its cities (where listed),
// and any capped leaf gets a newest-first twin. Payloads carry the employer's own link and ATS
// ("Workday", "SuccessFactors", ...), from Fantastic.jobs and Workable's XML feed.
const AIAPPLY_COOKIE = (process.env.AIAPPLY_COOKIE || '').replace(/[\r\n]+/g, '').trim();
const AIAPPLY_CAP = 1000;
const AIAPPLY_COUNTRIES = ('us,ca,gb,ie,de,fr,nl,be,lu,ch,at,es,pt,it,pl,cz,sk,hu,ro,bg,gr,hr,si,rs,ua,lt,lv,ee,'
  + 'se,no,dk,fi,is,tr,il,ae,sa,qa,kw,bh,om,eg,ma,za,ng,ke,gh,in,pk,bd,lk,sg,my,id,th,vn,ph,hk,tw,jp,kr,cn,'
  + 'au,nz,mx,br,ar,cl,co,pe,uy,cr,pa,do,pr,gt,ec,ve,bo,py,cy,mt,ge,am,kz,uz,az,et,tz,ug,rw,tn,dz,jo,lb,np').split(',');
// Cities for countries that stay over the cap: name, lat, lon.
const AIAPPLY_CITIES = {
  us: [['New York', 40.7128, -74.006], ['Los Angeles', 34.0522, -118.2437], ['Chicago', 41.8781, -87.6298], ['Houston', 29.7604, -95.3698],
    ['Phoenix', 33.4484, -112.074], ['Philadelphia', 39.9526, -75.1652], ['San Antonio', 29.4241, -98.4936], ['San Diego', 32.7157, -117.1611],
    ['Dallas', 32.7767, -96.797], ['Austin', 30.2672, -97.7431], ['San Jose', 37.3382, -121.8863], ['San Francisco', 37.7749, -122.4194],
    ['Seattle', 47.6062, -122.3321], ['Denver', 39.7392, -104.9903], ['Boston', 42.3601, -71.0589], ['Washington', 38.9072, -77.0369],
    ['Atlanta', 33.749, -84.388], ['Miami', 25.7617, -80.1918], ['Tampa', 27.9506, -82.4572], ['Orlando', 28.5383, -81.3792],
    ['Charlotte', 35.2271, -80.8431], ['Raleigh', 35.7796, -78.6382], ['Nashville', 36.1627, -86.7816], ['Indianapolis', 39.7684, -86.1581],
    ['Columbus', 39.9612, -82.9988], ['Cleveland', 41.4993, -81.6944], ['Cincinnati', 39.1031, -84.512], ['Detroit', 42.3314, -83.0458],
    ['Minneapolis', 44.9778, -93.265], ['St. Louis', 38.627, -90.1994], ['Kansas City', 39.0997, -94.5786], ['Milwaukee', 43.0389, -87.9065],
    ['Pittsburgh', 40.4406, -79.9959], ['Baltimore', 39.2904, -76.6122], ['Portland', 45.5152, -122.6784], ['Sacramento', 38.5816, -121.4944],
    ['Las Vegas', 36.1699, -115.1398], ['Salt Lake City', 40.7608, -111.891], ['Oklahoma City', 35.4676, -97.5164], ['Louisville', 38.2527, -85.7585],
    ['Memphis', 35.1495, -90.049], ['New Orleans', 29.9511, -90.0715], ['Jacksonville', 30.3322, -81.6557], ['Richmond', 37.5407, -77.436],
    ['Hartford', 41.7658, -72.6734], ['Buffalo', 42.8864, -78.8784], ['Albuquerque', 35.0844, -106.6504], ['Tucson', 32.2226, -110.9747],
    ['Omaha', 41.2565, -95.9345], ['Birmingham', 33.5186, -86.8104], ['Boise', 43.615, -116.2023], ['Honolulu', 21.3069, -157.8583],
    ['Anchorage', 61.2181, -149.9003], ['Des Moines', 41.5868, -93.625], ['Little Rock', 34.7465, -92.2896], ['Charleston', 32.7765, -79.9311]],
  ca: [['Toronto', 43.6532, -79.3832], ['Mississauga', 43.589, -79.6441], ['Montreal', 45.5019, -73.5674], ['Vancouver', 49.2827, -123.1207],
    ['Calgary', 51.0447, -114.0719], ['Edmonton', 53.5461, -113.4938], ['Ottawa', 45.4215, -75.6972], ['Winnipeg', 49.8951, -97.1384],
    ['Hamilton', 43.2557, -79.8711], ['Kitchener', 43.4516, -80.4925], ['London', 42.9849, -81.2453], ['Quebec City', 46.8139, -71.208],
    ['Halifax', 44.6488, -63.5752], ['Saskatoon', 52.1332, -106.67], ['Regina', 50.4452, -104.6189], ['Victoria', 48.4284, -123.3656]],
  gb: [['London', 51.5072, -0.1276], ['Manchester', 53.4808, -2.2426], ['Birmingham', 52.4862, -1.8904], ['Leeds', 53.8008, -1.5491],
    ['Glasgow', 55.8642, -4.2518], ['Edinburgh', 55.9533, -3.1883], ['Bristol', 51.4545, -2.5879], ['Liverpool', 53.4084, -2.9916],
    ['Newcastle', 54.9783, -1.6178], ['Sheffield', 53.3811, -1.4701], ['Nottingham', 52.9548, -1.1581], ['Cardiff', 51.4816, -3.1791],
    ['Belfast', 54.5973, -5.9301], ['Cambridge', 52.2053, 0.1218], ['Oxford', 51.752, -1.2577], ['Reading', 51.4543, -0.9781]],
  de: [['Berlin', 52.52, 13.405], ['Munich', 48.1351, 11.582], ['Hamburg', 53.5511, 9.9937], ['Frankfurt', 50.1109, 8.6821],
    ['Cologne', 50.9375, 6.9603], ['Stuttgart', 48.7758, 9.1829], ['Düsseldorf', 51.2277, 6.7735], ['Leipzig', 51.3397, 12.3731],
    ['Hanover', 52.3759, 9.732], ['Nuremberg', 49.4521, 11.0767], ['Dresden', 51.0504, 13.7373], ['Bremen', 53.0793, 8.8017]],
  fr: [['Paris', 48.8566, 2.3522], ['Lyon', 45.764, 4.8357], ['Marseille', 43.2965, 5.3698], ['Toulouse', 43.6047, 1.4442],
    ['Lille', 50.6292, 3.0573], ['Bordeaux', 44.8378, -0.5792], ['Nantes', 47.2184, -1.5536], ['Nice', 43.7102, 7.262]],
  in: [['Bengaluru', 12.9716, 77.5946], ['Mumbai', 19.076, 72.8777], ['Delhi', 28.7041, 77.1025], ['Hyderabad', 17.385, 78.4867],
    ['Chennai', 13.0827, 80.2707], ['Pune', 18.5204, 73.8567], ['Kolkata', 22.5726, 88.3639], ['Gurugram', 28.4595, 77.0266],
    ['Noida', 28.5355, 77.391], ['Ahmedabad', 23.0225, 72.5714]],
  au: [['Sydney', -33.8688, 151.2093], ['Melbourne', -37.8136, 144.9631], ['Brisbane', -27.4698, 153.0251], ['Perth', -31.9505, 115.8605],
    ['Adelaide', -34.9285, 138.6007], ['Canberra', -35.2809, 149.13]],
  nl: [['Amsterdam', 52.3676, 4.9041], ['Rotterdam', 51.9244, 4.4777], ['The Hague', 52.0705, 4.3007], ['Utrecht', 52.0907, 5.1214], ['Eindhoven', 51.4416, 5.4697]],
  es: [['Madrid', 40.4168, -3.7038], ['Barcelona', 41.3874, 2.1686], ['Valencia', 39.4699, -0.3763], ['Seville', 37.3891, -5.9845], ['Málaga', 36.7213, -4.4214]],
  it: [['Milan', 45.4642, 9.19], ['Rome', 41.9028, 12.4964], ['Turin', 45.0703, 7.6869], ['Bologna', 44.4949, 11.3426], ['Naples', 40.8518, 14.2681]],
  pl: [['Warsaw', 52.2297, 21.0122], ['Kraków', 50.0647, 19.945], ['Wrocław', 51.1079, 17.0385], ['Gdańsk', 54.352, 18.6466], ['Poznań', 52.4064, 16.9252]],
  br: [['São Paulo', -23.5505, -46.6333], ['Rio de Janeiro', -22.9068, -43.1729], ['Belo Horizonte', -19.9167, -43.9345], ['Curitiba', -25.4284, -49.2733], ['Porto Alegre', -30.0346, -51.2177]],
  mx: [['Mexico City', 19.4326, -99.1332], ['Guadalajara', 20.6597, -103.3496], ['Monterrey', 25.6866, -100.3161], ['Querétaro', 20.5888, -100.3899]],
  ie: [['Dublin', 53.3498, -6.2603], ['Cork', 51.8985, -8.4756], ['Galway', 53.2707, -9.0568], ['Limerick', 52.6638, -8.6267]],
  ch: [['Zurich', 47.3769, 8.5417], ['Geneva', 46.2044, 6.1432], ['Basel', 47.5596, 7.5886], ['Bern', 46.948, 7.4474], ['Lausanne', 46.5197, 6.6323]],
  se: [['Stockholm', 59.3293, 18.0686], ['Gothenburg', 57.7089, 11.9746], ['Malmö', 55.605, 13.0038]],
  sg: [], ae: [['Dubai', 25.2048, 55.2708], ['Abu Dhabi', 24.4539, 54.3773]],
};
// The walk is by EMPLOYER, not by title (2026-11-15): search=* is a match-all (Iceland: 21 hits
// blank, 154 with *), and companies=<name> returns that employer's whole set exactly (Catalent:
// 319, matching its Workday board). So each employer is one request. Shards:
//   cc:<code>                 search=* per country; capped, but it surfaces employer names
//   co:<name>[|cc:..][|r:..][|city:..][|s:desc]
// Every employer name seen in a cc: shard is queued as co:<name> (and seed() starts from the
// names already in agg_raw). An employer over the cap splits by the countries its hits name,
// then remote/on-site, then city, and any capped leaf gets a newest-first twin.
const aiapplyKey = (f) => ['co', 'cc', 'r', 'city', 's'].filter((k) => f[k] !== undefined)
  .map((k) => `${k}:${k === 'co' ? encodeURIComponent(f[k]) : f[k]}`).join('|');
const aiapply = {
  name: 'aiapply', conc: 1, delayMs: parseInt(process.env.AIAPPLY_DELAY_MS || '1000', 10),
  enabled: () => !!AIAPPLY_COOKIE,
  async seed() {
    // Employers already walked keep their co: shards (REFRESH resets them), and cc: shards queue any
    // new employer they see, so the DISTINCT over agg_raw is only needed on a source's first run.
    const { rows: [had] } = await pool.query(`SELECT 1 AS x FROM agg_shards WHERE source='aiapply' AND shard LIKE 'co:%' LIMIT 1`);
    if (had) return AIAPPLY_COUNTRIES.map((c) => `cc:${c}`);
    const { rows } = await pool.query(
      `SELECT DISTINCT payload->>'company_name' AS n FROM agg_raw WHERE source='aiapply' AND coalesce(payload->>'company_name','') <> ''`);
    return AIAPPLY_COUNTRIES.map((c) => `cc:${c}`).concat(rows.map((r) => aiapplyKey({ co: r.n })));
  },
  async page(shard) {
    const f = Object.fromEntries(shard.split('|').map((kv) => { const i = kv.indexOf(':'); return [kv.slice(0, i), kv.slice(i + 1)]; }));
    if (f.co !== undefined) f.co = decodeURIComponent(f.co);
    const p = new URLSearchParams({ offset: '0', limit: String(AIAPPLY_CAP), search: '*' });
    if (f.co !== undefined) p.set('companies', f.co);
    if (f.s) p.set('sort', f.s);
    if (f.r) p.set('remote', f.r);
    if (f.cc) {
      p.set('countryCode', f.cc);
      if (f.city) {
        const [name, ll] = f.city.split('@');
        const [lat, lon] = ll.split(',');
        p.set('city', name); p.set('country', f.cc.toUpperCase()); p.set('lat', lat); p.set('lon', lon);
      }
    }
    const d = await request(`https://aiapply.co/api/jobs?${p}`, { headers: {
      accept: 'application/json', referer: 'https://aiapply.co/app/jobs', cookie: AIAPPLY_COOKIE } });
    if (!d || d.status !== 'success' || !d.data || !Array.isArray(d.data.hits)) {
      const e = new HttpError(401, `unexpected body: ${JSON.stringify(d).slice(0, 120)}`); e.permanent = true; throw e;
    }
    const hits = d.data.hits;
    const total = Number(d.data.estimatedTotalHits || hits.length);
    const split = [];
    if (f.co === undefined) {   // discovery: queue every employer this page names
      for (const n of new Set(hits.map((h) => h.company_name).filter(Boolean))) split.push(aiapplyKey({ co: n }));
    }
    if (total >= AIAPPLY_CAP && !f.s) {
      if (f.co !== undefined && !f.cc) {
        const ccs = new Set(hits.flatMap((h) => (Array.isArray(h.country_codes) ? h.country_codes : [])).map((c) => String(c).toLowerCase()));
        for (const cc of ccs) split.push(aiapplyKey({ ...f, cc }));
      } else if (f.cc && !f.r) {
        split.push(aiapplyKey({ ...f, r: 'true' }), aiapplyKey({ ...f, r: 'false' }));
      } else if (f.cc && !f.city) {
        for (const [n, la, lo] of AIAPPLY_CITIES[f.cc] || []) split.push(aiapplyKey({ ...f, city: `${n}@${la},${lo}` }));
      }
      split.push(aiapplyKey({ ...f, s: 'desc' }));
    }
    return { items: hits.map((j) => ({ id: j.id, payload: j })), total, split: split.length ? split : null, next: null };
  },
};

const ALL = { liftmycv, wonsulting, jobhose, workable, allscm, jobloo, resumly, trueup, trulyremotework, thehub, platsbanken, platsbanken_remote, sprout, aiapply };

// ---------------------------------------------------------------- storage

const pool = new Pool({ connectionString: DB, max: 4, statement_timeout: 300000 });

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agg_raw (
      source text NOT NULL, ext_id text NOT NULL, payload jsonb NOT NULL,
      first_fetched_at timestamptz NOT NULL DEFAULT now(), last_fetched_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (source, ext_id));
    CREATE TABLE IF NOT EXISTS agg_shards (
      source text NOT NULL, shard text NOT NULL, status text NOT NULL DEFAULT 'pending', cursor text,
      pages int NOT NULL DEFAULT 0, fetched int NOT NULL DEFAULT 0, total int, error text,
      updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (source, shard));`);
}

async function addShards(source, keys) {
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    await pool.query(`INSERT INTO agg_shards (source, shard) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`, [source, chunk]);
  }
}

/** Returns how many rows were new. */
async function saveItems(source, items) {
  const seen = new Set();
  const rows = items.filter((it) => it.id != null && !seen.has(String(it.id)) && seen.add(String(it.id)));
  if (!rows.length) return 0;
  const { rows: r } = await pool.query(
    `INSERT INTO agg_raw (source, ext_id, payload)
       SELECT $1, x.id, x.payload FROM jsonb_to_recordset($2::jsonb) AS x(id text, payload jsonb)
     ON CONFLICT (source, ext_id) DO UPDATE SET payload = EXCLUDED.payload, last_fetched_at = now()
     RETURNING (xmax = 0) AS inserted`,
    // jsonb rejects the NUL escape (\u0000) that some descriptions carry; drop it (but not an
    // escaped backslash followed by "u0000", which is literal text).
    [source, JSON.stringify(rows.map((it) => ({ id: String(it.id), payload: it.payload })))
      .replace(/(?<!\\)((?:\\\\)*)\\u0000/g, '$1')]);
  return r.filter((x) => x.inserted).length;
}

// ---------------------------------------------------------------- run

const stats = {};

async function runSource(src) {
  const st = (stats[src.name] = { shardsDone: 0, pages: 0, fetched: 0, inserted: 0, errors: 0, queued: 0 });
  await addShards(src.name, await src.seed());
  if (process.env.REFRESH === '1') {
    const { rowCount } = await pool.query(
      `UPDATE agg_shards SET status='pending', cursor=NULL, error=NULL, updated_at=now() WHERE source=$1 AND status <> 'skipped'`, [src.name]);
    console.log(`[${src.name}] REFRESH: ${rowCount} shards back to the start`);
  }
  if (process.env.RESET_ERRORS === '1') {
    await pool.query(`UPDATE agg_shards SET status='pending', error=NULL WHERE source=$1 AND status='error'`, [src.name]);
  }

  for (;;) {
    const { rows: queue } = await pool.query(
      `SELECT shard, cursor FROM agg_shards WHERE source=$1 AND status='pending' ORDER BY shard ${LIMIT_SHARDS ? `LIMIT ${LIMIT_SHARDS}` : ''}`, [src.name]);
    if (!queue.length) break;
    st.queued = queue.length;
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(src.conc, queue.length) }, async () => {
      while (i < queue.length) {
        const { shard } = queue[i];
        let cursor = queue[i++].cursor;
        let pages = 0;
        let stalePages = 0;
        try {
          for (;;) {
            const r = await src.page(shard, cursor);
            pages++; st.pages++; st.fetched += r.items.length;
            const added = await saveItems(src.name, r.items);
            st.inserted += added;
            if (r.split) await addShards(src.name, r.split);
            cursor = r.next;
            if (src.staleStop && r.items.length) {
              stalePages = added / r.items.length < src.staleStop.newShare ? stalePages + 1 : 0;
              if (stalePages >= src.staleStop.pages) cursor = null;   // only repeats from here on
            }
            await pool.query(
              `UPDATE agg_shards SET cursor=$3, pages=pages+1, fetched=fetched+$4, total=$5, status=$6, updated_at=now()
                WHERE source=$1 AND shard=$2`,
              [src.name, shard, cursor, r.items.length, r.total || null, cursor ? 'pending' : 'done']);
            if (src.delayMs) await sleep(src.delayMs);
            if (!cursor || (MAX_PAGES && pages >= MAX_PAGES)) break;
          }
          if (!cursor) st.shardsDone++;
        } catch (e) {
          st.errors++;
          await pool.query(`UPDATE agg_shards SET status='error', error=$3, updated_at=now() WHERE source=$1 AND shard=$2`,
            [src.name, shard, String(e.message).slice(0, 300)]);
          if (e.status === 401 || e.status === 403) {
            console.log(`\n[${src.name}] ${e.message} — credential rejected, stopping this source`);
            i = queue.length;
          }
        }
      }
    }));
    if (LIMIT_SHARDS || MAX_PAGES) break;   // smoke test: one pass only
  }
  if (src.finish) await src.finish();
}

(async () => {
  await ensureTables();
  const chosen = SOURCES.map((s) => ALL[s]).filter(Boolean);
  for (const s of chosen) if (s.enabled && !s.enabled()) console.log(`[${s.name}] skipped — credential not configured`);
  const active = chosen.filter((s) => !s.enabled || s.enabled());
  console.log(`pulling ${active.map((s) => s.name).join(', ')} into ${new URL(DB).pathname.slice(1)}`);

  const t0 = Date.now();
  const tick = setInterval(() => {
    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    console.log(`[${mins}m] ` + Object.entries(stats).map(([k, v]) =>
      `${k}: ${v.pages}p ${v.fetched} got ${v.inserted} new ${v.shardsDone} shards done ${v.errors} err`).join(' | '));
  }, 60000);
  await Promise.all(active.map((s) => runSource(s).catch((e) => console.log(`[${s.name}] FATAL ${e.message}`))));
  clearInterval(tick);
  console.log('\nfinal: ' + JSON.stringify(stats));
  await pool.end();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
