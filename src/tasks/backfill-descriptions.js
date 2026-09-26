/**
 * Backfill missing job descriptions across all ATS platforms.
 * Fetches individual job details for jobs with NULL descriptions.
 * Runs independently from the sync queue to avoid blocking.
 * Processes each ATS separately with per-ATS rate limits.
 */
const { query } = require('../db/connection');
const { discoverConfig } = require('../adapters/workday');
const { parseWorkdayUrl, workdayCxsUrl } = require('../utils/workday-url');
const { parseOracleUrl, oracleDetailUrl } = require('../utils/oracle-url');
const { fetchUnlockedHtml } = require('../utils/brightdata-proxy');
const logger = require('../logger');
const metrics = require('../utils/metrics');

// Only ATS platforms that return descriptions without Browserless.
// Priority order: Ashby, Breezy, Greenhouse, Workable first, then rest.
//
// This map is the ONLY thing that decides what gets backfilled — `fetchDescription` having a
// `case` for an ATS means nothing if the key is missing here. That gap went unnoticed for months
// because the Oracle/Taleo/iCIMS/SuccessFactors *fetchers* were all present and looked wired in.
// Measured 2026-08-10: 22,320 of the 35,695 live jobs missing a description (63%) were on ATSes
// absent from this map, so no cycle ever asked for them. Probing the existing fetchers against
// real rows before enabling: taleo 6/6, successfactors 5/6, oracle 2/6, oraclecloud 0/6 and
// icims 1/6 — the latter three fixed below by deriving coordinates from job.url instead of the
// mangled ats_slug. Keep concurrency lower here than on the ashby/greenhouse tier: these are
// enterprise tenants that rate-limit far more aggressively.
const ATS_CONFIG = {
  ashby:           { batchSize: 75, concurrency: 5 },
  breezy:          { batchSize: 75, concurrency: 5 },
  greenhouse:      { batchSize: 75, concurrency: 5 },
  workable:        { batchSize: 75, concurrency: 4 },
  lever:           { batchSize: 75, concurrency: 5 },
  recruitee:       { batchSize: 75, concurrency: 4 },
  pinpoint:        { batchSize: 75, concurrency: 5 },
  smartrecruiters: { batchSize: 75, concurrency: 5 },
  bamboohr:        { batchSize: 75, concurrency: 5 },
  jazzhr:          { batchSize: 75, concurrency: 5 },
  personio:        { batchSize: 50, concurrency: 3 },
  rippling:        { batchSize: 75, concurrency: 5 },
  zoho:            { batchSize: 50, concurrency: 3 },
  workday:         { batchSize: 75, concurrency: 4 },
  comeet:          { batchSize: 50, concurrency: 4 },
  paylocity:       { batchSize: 60, concurrency: 3 },
  // Simplify pages are ~44KB gzipped and this platform has 1.7M rows to fill, so it is the one
  // that runs longest. Concurrency stays modest deliberately: the work is a courtesy scrape of
  // someone else's site, and measured throughput was already ~40 pages/min at 4.
  //
  // OPT-IN, and it has to be. scripts/render-worker.js drains descriptions with
  // `for (const [ats, cfg] of Object.entries(ATS_CONFIG))` — every key in this object becomes
  // work the Render worker picks up on a 5-minute loop. Listing simplify unconditionally would
  // therefore have started a 1.7M-row scrape of someone else's site from Render's IPs, on the
  // 512MB instance that already OOMs 13-18 times a day, duplicating a backfill the laptop owns.
  // The entry is only ever wanted where it is deliberately run, so it is gated rather than
  // listed. scripts/backfill-desc-generic.js falls back to {75, 4} when a key is absent, so the
  // manual path keeps working either way.
  ...(process.env.DESC_ENABLE_SIMPLIFY === '1'
    ? { simplify: { batchSize: 100, concurrency: 6 } }
    : {}),
};

// Platforms with a working fetcher but NO apply automation — users cannot apply to these jobs, so
// a description on them buys nothing today. They are prospective inventory only.
//
// OFF BY DEFAULT, and that is a product decision, not a technical one. src/utils/supported-ats.js
// calls its list "platforms we can actually crawl AND apply to" and includes all five, but that
// gate reflects ADAPTER coverage, not AUTOMATION coverage — it is not the authority on what is
// applyable. Enabling these was a mistake on 2026-08-10: they are 64% of the outstanding backlog
// (21,003 of 32,715) and taleo alone is 14,518, so they soak up most of the cycle while workable,
// comeet, greenhouse and workday — the ones users actually see — wait behind them.
//
// The fetchers stay wired and tested so this is a one-line switch the day automation lands.
const NO_AUTOMATION_ATS = {
  taleo:           { batchSize: 60, concurrency: 3 },
  successfactors:  { batchSize: 60, concurrency: 3 },
  oracle:          { batchSize: 50, concurrency: 3 },
  oraclecloud:     { batchSize: 50, concurrency: 3 },
  icims:           { batchSize: 50, concurrency: 3 },
};

if (process.env.BACKFILL_NO_AUTOMATION_ATS === '1') {
  Object.assign(ATS_CONFIG, NO_AUTOMATION_ATS);
}

// Cache workday configs per slug with TTL (1 hour)
const wdConfigCache = new Map();
const WD_CACHE_TTL_MS = 60 * 60 * 1000;

function getWdConfig(key) {
  const entry = wdConfigCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > WD_CACHE_TTL_MS) {
    wdConfigCache.delete(key);
    return undefined;
  }
  return entry.config;
}

function setWdConfig(key, config) {
  wdConfigCache.set(key, { config, timestamp: Date.now() });
}

/**
 * Workday has multiple site slugs per company (e.g. VCA has Careers, BFCareers, etc.)
 * Try all known site slugs if the first one fails with 422.
 */
async function discoverAllSiteSlugs(slug) {
  for (const wd of [1, 2, 3, 5, 12]) {
    try {
      const res = await fetch(`https://${slug}.wd${wd}.myworkdayjobs.com/robots.txt`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const text = await res.text();
      const matches = [...text.matchAll(/myworkdayjobs\.com\/([^/\s]+)/g)];
      if (matches.length > 0) {
        return { wdNum: wd, siteSlugs: matches.map(m => m[1]) };
      }
    } catch { /* try next */ }
  }
  return null;
}

// Realistic browser headers — some Workday tenants block bare scripted requests.
// (Tenants with stricter permission blocks still return 403 even with these, which
// we then mark SKIP rather than retrying forever.)
const WD_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Derive the CXS coordinates straight from a posting URL — no robots.txt discovery or rawData
// needed. This is what makes demand/aggregator-imported workday jobs (no rawData.externalPath)
// fillable. Shared with the dead-job pruner so the two cannot disagree about what a posting URL
// points at; see src/utils/workday-url.js for the two host shapes and why endsWith matters.
async function fetchWorkdayDescription(job, rawData) {
  // URL-first: works for jobs without rawData.externalPath (demand/aggregator imports).
  const p = parseWorkdayUrl(job.url);
  // HTTP status of the URL-derived attempt, or null if it never got a response (timeout/DNS).
  // Only a real status is evidence about the posting; a timeout must stay retryable.
  let urlStatus = null;
  if (p) {
    try {
      const res = await fetch(workdayCxsUrl(p), { headers: WD_HEADERS, signal: AbortSignal.timeout(10000) });
      urlStatus = res.status;
      if (res.ok) {
        const detail = await res.json();
        const desc = detail?.jobPostingInfo?.jobDescription;
        if (desc && desc.trim()) return desc;
        if (detail?.jobPostingInfo) return 'SKIP'; // 200 but empty body → upstream-empty
      }
      // 403 on the coordinates taken from the posting's own URL means the posting itself is
      // gone — Workday returns it for unpublished/expired requisitions, NOT as a bot block.
      // Verified on tenant `aep` 2026-08-17: live postings on that same site return 200 with a
      // description and no cookies or special headers, while our stored row returns 403.
      // Nothing downstream can recover it, so skip before paying for robots.txt discovery —
      // this is 73% of the workday backlog and it was being re-fetched every cycle forever.
      if (urlStatus === 403) return 'SKIP';
    } catch { /* fall through to discovery-based path below */ }
  }

  const cacheKey = job.ats_slug;
  let config = getWdConfig(cacheKey);
  if (config === undefined) {
    config = await discoverAllSiteSlugs(job.ats_slug);
    setWdConfig(cacheKey, config);
  }
  // A 404/422 says the site slug in the URL didn't resolve the posting. Discovery is the only
  // thing that could still rescue it by trying sibling slugs; with no config there is nothing
  // left to try, so stop retrying rather than looping on it forever.
  if (!config) return urlStatus === 404 || urlStatus === 422 ? 'SKIP' : null;

  const { wdNum, siteSlugs } = config;
  // Fall back to the path parsed out of the URL: aggregator-imported rows have no
  // rawData.externalPath, and without this they bailed here and were retried every cycle.
  const externalPath = rawData?.externalPath || p?.externalPath;
  if (!externalPath) return null;

  // Try each site slug until one works. Track whether we got a confirmed
  // non-retryable response (403 permission, or 200-with-empty-description)
  // so we can return SKIP instead of null and stop retrying forever.
  let sawForbidden = false;
  let sawEmptyDescription = false;

  for (const siteSlug of siteSlugs) {
    try {
      const url = `https://${job.ats_slug}.wd${wdNum}.myworkdayjobs.com/wday/cxs/${job.ats_slug}/${siteSlug}${externalPath}`;
      const res = await fetch(url, { headers: WD_HEADERS, signal: AbortSignal.timeout(10000) });
      if (res.status === 403) { sawForbidden = true; continue; }
      if (!res.ok) continue; // 422 = wrong siteSlug, try next
      const detail = await res.json();
      const desc = detail?.jobPostingInfo?.jobDescription;
      if (desc && desc.trim()) return desc;
      // 200 OK with a populated jobPostingInfo but no description body → upstream-empty
      if (detail?.jobPostingInfo) sawEmptyDescription = true;
    } catch { /* timeout — try next */ }
  }
  // Dead posting, tenant-level permission block, or truly empty posting: not retryable.
  // urlStatus 404/422 lands here too — every slug the tenant advertises has now been tried
  // against the URL's own path and none resolved it.
  if (sawForbidden || sawEmptyDescription || urlStatus === 404 || urlStatus === 422) return 'SKIP';
  return null;
}

// The stored external_id is the ATS-native posting id for natively-crawled jobs, but for
// demand/bulk-imported jobs (liftmycv, wonsulting, resumly, csv_import, serp_discovery) it's the
// AGGREGATOR's own id — while the real ATS id lives in job.url. Prefer the id parsed from the URL;
// fall back to the (prefix-stripped) external_id so natively-crawled jobs behave exactly as before.
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
function nativeId(job, ats) {
  const fallback = String(job.external_id || '').replace(`${ats}_`, '');
  const url = job.url || '';
  let m = null;
  switch (ats) {
    case 'greenhouse':
      m = url.match(/[?&]gh_jid=(\d+)/) || url.match(/\/jobs\/(\d+)/); break;
    case 'lever':
    case 'ashby':
    case 'rippling':
      m = url.match(UUID_RE); return m ? m[0] : fallback;
    case 'smartrecruiters':
      m = url.match(/\/(\d{6,})(?:[-/?#]|$)/); break;
    case 'bamboohr':
      m = url.match(/\/careers\/(\d+)/); break;
    case 'icims':
      m = url.match(/\/jobs\/(\d+)/); break;
    case 'personio':
      m = url.match(/\/job\/(\d+)/) || url.match(/-(\d+)(?:[?#/]|$)/); break;
    default:
      return fallback;
  }
  return m ? m[1] : fallback;
}

// These never heal, so retrying them each cycle only burns requests against the API the crawler
// also needs (~900 per 3h on 2026-09-26, for ~490 postings). Probed live:
//   400     company renamed/migrated: "companyIdentifier (UnitedInfrastructure) does not match
//           companyIdentifier (TBD20260910UnitedInfrastructure) from publication"
//   401/403 the company closed its public API outright (CHECK24: 401 even on its postings list)
//   404/410 posting removed
// 429, 5xx and timeouts stay retryable.
const SR_PERMANENT_STATUS = new Set([400, 401, 403, 404, 410]);

// SmartRecruiters' "one-click" apply links carry the real employer and the posting's publication
// uuid in the path: jobs.smartrecruiters.com/oneclick-ui/company/{Company}/publication/{uuid}.
// Those jobs were stored under a company whose slug is literally "oneclick-ui", which is not a
// SmartRecruiters company, so the postings endpoint answered 200 with an empty list and the rows
// were retried forever. The API accepts the uuid as the posting id (probed 2026-09-26: Dexterra,
// Medfar, VeoliaEnvironnementSA, Wabtec all 200).
const SR_ONECLICK_RE = /\/oneclick-ui\/company\/([^/?#]+)\/publication\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

async function fetchSmartRecruitersDescription(job) {
  const oneclick = (job.url || '').match(SR_ONECLICK_RE);
  const company = oneclick ? decodeURIComponent(oneclick[1]) : job.ats_slug;
  const postingId = oneclick ? oneclick[2] : nativeId(job, 'smartrecruiters');
  const res = await fetch(
    `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings/${postingId}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) {
    if (SR_PERMANENT_STATUS.has(res.status)) {
      logger.warn({ jobId: job.id, slug: job.ats_slug, status: res.status }, 'SmartRecruiters API: permanent failure, not retrying');
      return 'SKIP';
    }
    logger.warn({ jobId: job.id, slug: job.ats_slug, status: res.status }, 'SmartRecruiters API: non-200');
    return null;
  }
  const detail = await res.json();
  if (!detail?.jobAd?.sections) {
    logger.warn({ jobId: job.id, slug: job.ats_slug, hasJobAd: !!detail?.jobAd }, 'SmartRecruiters: no jobAd.sections');
    return null;
  }
  const parts = [];
  for (const section of Object.values(detail.jobAd.sections)) {
    if (section.text && section.text.trim()) parts.push(section.text);
  }
  if (parts.length > 0) return parts.join('\n');

  // jobAd.sections existed and we iterated it cleanly — but every section's
  // `text` field is empty. Confirmed via direct probe: some companies
  // (e.g. AccorHotel, Dr Reddy's) use SmartRecruiters as a redirect-only
  // landing system with no body content. Mark N/A so we stop retrying.
  return 'SKIP';
}

async function fetchBambooHRDescription(job) {
  const jobId = nativeId(job, 'bamboohr');
  const res = await fetch(
    `https://${job.ats_slug}.bamboohr.com/careers/${jobId}/detail`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (res.status === 404 || res.status === 410) return 'SKIP';
  if (!res.ok) return null;
  // A tenant that turned off its careers page (or left BambooHR) answers 200 with HTML: fetch
  // follows the redirect to its login page or to bamboohr.com. Parsing that as JSON threw, the row
  // stayed NULL, and the same jobs were retried every cycle forever (skylum, richtech, mybambu,
  // doc: 12-13 times each in 3h on 2026-09-26). Non-OK statuses above still retry.
  if (!/json/i.test(res.headers.get('content-type') || '')) return 'SKIP';
  const data = await res.json();
  return data?.result?.jobOpening?.description || null;
}

function extractJsonLdDescription(html) {
  const ldRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let ldMatch;
  while ((ldMatch = ldRegex.exec(html)) !== null) {
    try {
      const ld = JSON.parse(ldMatch[1]);
      if (ld['@type'] === 'JobPosting' && ld.description) {
        return ld.description;
      }
    } catch { /* invalid JSON-LD */ }
  }
  return null;
}

// Extract salary from a page's JSON-LD JobPosting.baseSalary (schema.org MonetaryAmount).
// Returns {salary_min,salary_max,salary_currency,salary_interval} or null if not published.
const UNIT_TO_INTERVAL = { YEAR: 'year', MONTH: 'month', WEEK: 'week', DAY: 'day', HOUR: 'hour' };
function extractJsonLdSalary(html) {
  const ldRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let ldMatch;
  while ((ldMatch = ldRegex.exec(html)) !== null) {
    let ld; try { ld = JSON.parse(ldMatch[1]); } catch { continue; }
    const bs = ld && ld['@type'] === 'JobPosting' ? ld.baseSalary : null;
    const v = bs && (bs.value || bs);
    if (!v) continue;
    const min = v.minValue ?? v.value ?? null;
    const max = v.maxValue ?? v.value ?? null;
    if (min == null && max == null) continue;
    return {
      salary_min: min != null ? String(min) : null,
      salary_max: max != null ? String(max) : null,
      salary_currency: bs.currency || ld.baseSalary?.currency || null,
      salary_interval: UNIT_TO_INTERVAL[String(v.unitText || '').toUpperCase()] || null,
    };
  }
  return null;
}

async function fetchJazzHRDescription(job) {
  if (!job.url || !isPublicHttpsUrl(job.url)) return null;
  const res = await fetch(job.url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  const html = await res.text();
  // Try JSON-LD first
  const ld = extractJsonLdDescription(html);
  if (ld) return ld;
  // JazzHR embeds description in the largest content div
  const divs = html.match(/<div[^>]*>((?:(?!<div).)*?)<\/div>/gs) || [];
  let best = null;
  let bestLen = 0;
  for (const div of divs) {
    const clean = div.replace(/<[^>]+>/g, '').trim();
    if (clean.length > bestLen && clean.length > 100) {
      bestLen = clean.length;
      best = div.replace(/^<div[^>]*>/, '').replace(/<\/div>$/, '').trim();
    }
  }
  return best;
}

async function fetchBreezyDescription(job) {
  if (!job.url || !isPublicHttpsUrl(job.url)) return null;
  const res = await fetch(job.url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  const html = await res.text();
  // Try JSON-LD first
  const ld = extractJsonLdDescription(html);
  if (ld) return ld;
  // Breezy has description in og:description meta tag
  const ogMatch = html.match(/property="og:description"[^>]*content="([^"]*)"/i);
  if (ogMatch?.[1] && ogMatch[1].length > 50) return ogMatch[1];
  return null;
}

// Paylocity's crawl is list-only (window.pageData carries no description); the full text
// lives on the Jobs/Details/{id} page as a JSON-LD JobPosting. Detail pages soft-block
// under sustained single-IP load — they return the page WITHOUT the JSON-LD rather than a
// 429 — so, like the list adapter, we rotate UA, jitter, and retry the empty / 429 / 5xx /
// reset cases with backoff. Genuinely-gone listings (404 / JobNotFound) are marked N/A.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAYLOCITY_UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
];
async function fetchPaylocityDescription(job) {
  if (!job.url || !isPublicHttpsUrl(job.url)) return null;
  const MAX = 3;
  for (let attempt = 0; attempt <= MAX; attempt++) {
    await sleep(200 + Math.random() * 800); // 0.2-1s jitter, browser-like
    const ua = PAYLOCITY_UAS[Math.floor(Math.random() * PAYLOCITY_UAS.length)];
    let res;
    try {
      res = await fetch(job.url, {
        headers: { 'User-Agent': ua, Accept: 'text/html,application/xhtml+xml' },
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      if (attempt < MAX) { await sleep(2 ** attempt * 800 + Math.random() * 800); continue; }
      return null;
    }
    // Genuinely-gone listing → stop retrying it forever.
    if (res.status === 404 || res.status === 410 || /JobNotFound/i.test(res.url)) return 'SKIP';
    if (res.status === 429 || res.status >= 500) {
      if (attempt < MAX) { await sleep(2 ** attempt * 800 + Math.random() * 800); continue; }
      return null;
    }
    if (!res.ok) return null;
    const html = await res.text();
    // ~17% of paylocity jobs (pay-transparency states) publish baseSalary in the JSON-LD, which the
    // adapter drops. Capture it here as a side-effect of the same fetch (no extra request).
    try {
      const sal = extractJsonLdSalary(html);
      if (sal && job.id) {
        await query(
          'UPDATE jobs SET salary_min=?, salary_max=?, salary_currency=?, salary_interval=? WHERE id=? AND salary_min IS NULL',
          [sal.salary_min, sal.salary_max, sal.salary_currency, sal.salary_interval, job.id]);
      }
    } catch { /* salary is best-effort; never block the description */ }
    // Full description = the JSON-LD JobPosting.description (HTML), same shape as breezy/jazzhr.
    const ld = extractJsonLdDescription(html);
    if (ld && ld.length > 20) return ld;
    // Weak fallback: og:description (a shorter summary) when the JSON-LD is absent.
    const og = html.match(/property="og:description"[^>]*content="([^"]*)"/i);
    if (og?.[1] && og[1].length > 80) return og[1];
    // Page returned but no description = almost certainly a soft-block that dropped the
    // content → back off and retry; give up after MAX (leaves NULL for the next pass).
    if (attempt < MAX) { await sleep(2 ** attempt * 800 + Math.random() * 800); continue; }
    return null;
  }
  return null;
}

async function fetchTaleoDescription(job) {
  if (!job.url || !isPublicHttpsUrl(job.url)) return null;
  const res = await fetchPublicHtml(job.url);
  if (!res.ok) return null;
  const html = res.html;
  // Try JSON-LD first
  const ld = extractJsonLdDescription(html);
  if (ld) return ld;
  // Taleo server-rendered pages: description in <span class="text"> inside editablesection
  const taleoDesc = extractTaleoDescription(html);
  if (taleoDesc) return taleoDesc;
  // Extract from !*! delimited URL-encoded HTML in pipe data
  const PIPE_SEP = '!|!';
  if (html.includes('!*!') && html.includes(PIPE_SEP)) {
    const pipeStart = html.indexOf(PIPE_SEP);
    const pipeEnd = html.lastIndexOf(PIPE_SEP) + PIPE_SEP.length + 5000;
    const pipeSection = html.substring(pipeStart, Math.min(html.length, pipeEnd));
    const starParts = pipeSection.split('!*!');
    const descSegments = [];
    for (let i = 1; i < starParts.length; i++) {
      let raw = starParts[i];
      const pipeIdx = raw.indexOf(PIPE_SEP);
      if (pipeIdx !== -1) raw = raw.substring(0, pipeIdx);
      if (raw.length < 30) continue;
      try {
        const decoded = decodeURIComponent(raw);
        if (decoded.length > 50 && /<(p|li|br|ul|ol|div|span|h[1-6]|table|tr|td|strong|em|b|i)\b/i.test(decoded)) {
          descSegments.push(decoded);
        }
      } catch { /* skip */ }
    }
    if (descSegments.length > 0) return descSegments.join('\n');
  }
  // Try extracting from job_description div (SelectMinds redirect pages)
  const bodyDesc = extractBodyDescription(html);
  if (bodyDesc) return bodyDesc;
  return null;
}

/**
 * Extract description from Taleo server-rendered HTML.
 * Taleo uses <span class="text"> inside class="editablesection" for the main description.
 * We find the longest text span which is the job description (other spans are short metadata).
 */
function extractTaleoDescription(html) {
  if (!html || !html.includes('editablesection')) return null;
  // Find the editablesection block
  const sectionMatch = html.match(/class="editablesection"[^>]*>([\s\S]*?)<\/div>\s*<div class="staticcontentlinepanel"/i);
  if (sectionMatch?.[1] && sectionMatch[1].length > 100) return sectionMatch[1].trim();
  // Fallback: grab all <span class="text"> elements and use the longest one
  const textSpans = [];
  const spanRegex = /class="text"[^>]*>([\s\S]*?)<\/span>/gi;
  let m;
  while ((m = spanRegex.exec(html)) !== null) {
    if (m[1] && m[1].length > 200) textSpans.push(m[1]);
  }
  if (textSpans.length > 0) {
    textSpans.sort((a, b) => b.length - a.length);
    return textSpans[0].trim();
  }
  return null;
}

/**
 * Extract description from Oracle CX rendered HTML (Knockout.js).
 * Oracle uses multiple div.job-details__description-content sections for
 * description, responsibilities, and qualifications.
 */
function extractOracleRenderedDescription(html) {
  if (!html || !html.includes('job-details__description-content')) return null;
  const sections = [];
  const sectionRegex = /class="job-details__description-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|$)/gi;
  let m;
  while ((m = sectionRegex.exec(html)) !== null) {
    const content = m[1].trim();
    if (content.length > 50) sections.push(content);
  }
  return sections.length > 0 ? sections.join('\n') : null;
}

// Oracle tenants known to have no public descriptions (empty API + empty rendered HTML)
const ORACLE_SKIP_TENANTS = new Set(['hcbt']);

// Oracle coordinates come from the URL, NOT ats_slug. The slug is supposed to be
// `tenant.region.siteNumber`, but rows imported from aggregators carry whatever the URL path
// happened to yield — measured 2026-08-10: `hcmUI`, `eckx.em2`, `ibfhqy.ocs`, i.e. either a
// literal path segment or a slug missing the site entirely. Every one of those failed the
// `< 2 parts` / `no siteNumber` guards below and filled nothing, while the URL sitting in the
// same row carried all four values. Slug stays as the fallback for rows with no URL.
//
// The parser itself now lives in src/utils/oracle-url.js so the dead-job pruner can share it —
// see that file for the two host shapes and why they must not be parsed differently in two places.

async function fetchOracleDescription(job) {
  // URL first, ats_slug only as a fallback — see parseOracleUrl.
  let coords = parseOracleUrl(job.url);
  if (!coords) {
    const parts = String(job.ats_slug || '').split('.');
    if (parts.length < 3) {
      logger.debug({ jobId: job.id, slug: job.ats_slug }, 'Oracle: no URL match and slug lacks tenant.region.site');
      return null;
    }
    coords = {
      tenant: parts[0],
      region: parts[1],
      siteNumber: parts.slice(2).join('.'),
      jobId: String(job.external_id || '').replace(/^oracle(?:cloud)?_/, ''),
      // The slug path has no host to carry forward, so reassemble the region-ful shape — the
      // only one a `tenant.region.site` slug can describe.
      host: `${parts[0]}.fa.${parts[1]}.oraclecloud.com`,
    };
  }
  const { tenant, siteNumber } = coords;
  const jobId = coords.jobId;

  if (ORACLE_SKIP_TENANTS.has(tenant)) {
    return 'SKIP';
  }

  // Strategy 1: REST API (fast, no proxy needed)
  let apiStatus = null;
  try {
    const url = oracleDetailUrl(coords);
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    apiStatus = res.status;
    if (res.ok) {
      const data = await res.json();
      const item = data.items?.[0];
      if (item) {
        const descParts = [
          item.ExternalDescriptionStr,
          item.ExternalQualificationsStr,
          item.ExternalResponsibilitiesStr,
          item.CorporateDescriptionStr,
          item.OrganizationDescriptionStr,
          item.ShortDescriptionStr,
        ].filter(Boolean);
        if (descParts.length > 0) return descParts.join('\n');
        logger.warn({ jobId: job.id, slug: job.ats_slug }, 'Oracle API: 200 but all description fields empty');
      } else {
        logger.warn({ jobId: job.id, slug: job.ats_slug }, 'Oracle API: 200 but no items returned');
      }
    } else {
      logger.warn({ jobId: job.id, slug: job.ats_slug, status: apiStatus }, 'Oracle API: non-200 response');
    }
  } catch (err) {
    logger.warn({ jobId: job.id, slug: job.ats_slug, err: err.message, apiStatus }, 'Oracle API: request failed');
  }

  // Strategy 2: Render page via proxy and extract from Knockout.js-rendered HTML.
  //
  // This called an undefined `fetchUnlockedHtml` until 2026-08-10, so it threw ReferenceError on
  // every single invocation and was swallowed by the catch below as "Oracle proxy: fetch failed"
  // — the strategy had never once run. It is now the real Web Unlocker helper, which returns null
  // (rather than throwing) when BRIGHTDATA_PROXY is off, so the default remains "API only" and
  // no per-request billing starts without that flag being set deliberately.
  if (job.url) {
    try {
      const html = await fetchUnlockedHtml(job.url);
      if (!html) return null; // unlocker disabled — API already tried, nothing further to do
      const htmlLen = html?.length || 0;
      const hasDescContent = html?.includes('job-details__description-content') || false;
      const oracleDesc = extractOracleRenderedDescription(html);
      if (oracleDesc) return oracleDesc;
      logger.warn({ jobId: job.id, slug: job.ats_slug, htmlLen, hasDescContent }, 'Oracle proxy: rendered but extraction failed');
    } catch (err) {
      logger.warn({ jobId: job.id, slug: job.ats_slug, err: err.message }, 'Oracle proxy: fetch failed');
    }
  }

  return null;
}

// Greenhouse board token, recovered from a company's own careers page and cached per host.
//
// Aggregator-imported rows (the jobloo bulk load) store a URL path segment where the board token
// belongs — measured 2026-08-10: `careers`, `pages`, `careers-list.html`. The board API is keyed
// on that token, so all ~2,000 of them 404'd on every cycle forever. The real job id was never
// the problem: nativeId already recovers it from `?gh_jid=`. Only the token was missing, and the
// careers page that the URL points at embeds it (`job_board/js?for=<token>`).
const ghTokenCache = new Map();
const GH_TOKEN_TTL_MS = 6 * 60 * 60 * 1000;

async function discoverGreenhouseToken(url) {
  let host;
  try { host = new URL(url).host; } catch { return null; }

  const hit = ghTokenCache.get(host);
  if (hit && Date.now() - hit.at < GH_TOKEN_TTL_MS) return hit.token;

  let token = null;
  try {
    // Careers-page URL comes from imported data — guard every hop of the redirect chain.
    const res = await fetchPublicHtml(url, { headers: WD_HEADERS });
    if (res.ok) {
      const html = res.html;
      const m = html.match(/job_board(?:\/js)?\?for=([a-z0-9_]+)/i)
        || html.match(/job-boards\.greenhouse\.io\/([a-z0-9_]+)/i)
        || html.match(/boards\.greenhouse\.io\/embed\/job_board\?for=([a-z0-9_]+)/i);
      if (m) token = m[1];
    }
  } catch { /* leave null — cached as a negative so one dead careers page isn't refetched per job */ }

  ghTokenCache.set(host, { token, at: Date.now() });
  return token;
}

// Returns { content } on success, or { status } so the caller can tell "wrong board token"
// (retryable — try discovery) from "this board says the requisition is gone" (permanent).
async function greenhouseBoardFetch(board, jobId) {
  const res = await fetch(
    `https://api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${jobId}?questions=true`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return { status: res.status };
  const data = await res.json();
  return { content: data.content || null, status: 200 };
}

// Slug values that are demonstrably URL path segments rather than board tokens. Used only to
// stop a known-bad slug being offered back as a candidate — never to reject one outright, since
// the real test is whether the board API answers for it.
const GH_NON_TOKENS = new Set([
  'careers', 'jobs', 'job-board', 'en', 'careersitem', 'job-detail', 'about', 'company',
  'open-roles', 'join-us', 'job-openings', 'job-openings-2', 'job-description', 'embed',
  'pages', 'careers-list.html', 'careers-and-culture', 'who-we-are', 'apply', 'openings',
]);

const ghNorm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Hyphens are legal in a board token (`domino-data-lab` is a real board), so they cannot be used
// to tell a token from a path segment — GH_NON_TOKENS does that job instead. A wrong candidate
// only costs one 404, so this stays permissive.
const ghUsable = (s) => !!s && /^[a-z0-9_-]+$/i.test(s) && !GH_NON_TOKENS.has(String(s).toLowerCase());

// Board hosts that put the token straight in the URL path. careerpuck is a third-party host for
// Greenhouse boards, and its rows are the ones where company_name is least reliable — all three
// unresolved samples were labelled "Avalara" while the path named madisonreedcolorbar,
// domino-data-lab and lyft. The path wins over the company record here.
function greenhouseTokenFromUrl(url) {
  const u = String(url || '');
  const m = u.match(/app\.careerpuck\.com\/job-board\/([a-z0-9_-]+)\//i)
    || u.match(/(?:job-boards|boards)\.greenhouse\.io\/(?:embed\/)?([a-z0-9_-]+)\/jobs?\//i);
  return m && ghUsable(m[1]) ? m[1] : null;
}

// Board tokens we already hold for the SAME company under a different companies row.
//
// The most productive source by a distance, and it costs one cached query: the company is usually
// crawled correctly elsewhere in the table by our own greenhouse crawler, and only the
// aggregator-imported row carries the broken slug. Matching on company_name — not domain alone —
// is what makes it work. Measured over 40 imported rows: domain-only resolved 35%, adding the
// name match took it to 75% (sibling-name 22, sibling-domain 7, domain-derived 1).
const ghSiblingCache = new Map();

async function greenhouseSiblingSlugs(job) {
  const key = job.company_id || `${job.domain}|${job.company_name}`;
  if (ghSiblingCache.has(key)) return ghSiblingCache.get(key);

  let slugs = [];
  try {
    const { rows } = await query(
      `SELECT ats_slug FROM companies
        WHERE ats = 'greenhouse' AND ats_slug IS NOT NULL
          AND (company_name = ? OR (domain IS NOT NULL AND domain = ?))
        LIMIT 25`,
      [job.company_name || '', job.domain || '']
    );
    slugs = rows.map((r) => r.ats_slug).filter(ghUsable);
  } catch { /* a sibling lookup failure must never fail the job */ }

  ghSiblingCache.set(key, slugs);
  return slugs;
}

// Does this board exist at all? Separates "wrong token" from "right token, dead requisition".
const ghBoardExistsCache = new Map();
async function greenhouseBoardExists(token) {
  if (ghBoardExistsCache.has(token)) return ghBoardExistsCache.get(token);
  let ok = false;
  try {
    const res = await fetch(
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=false`,
      { signal: AbortSignal.timeout(10000) }
    );
    ok = res.ok;
  } catch { /* network — treat as unknown rather than real */ }
  ghBoardExistsCache.set(token, ok);
  return ok;
}

async function fetchGreenhouseDescription(job) {
  const jobId = nativeId(job, 'greenhouse');
  const tried = new Set();
  let sawRealBoard = false;

  const attempt = async (token) => {
    if (!token || tried.has(token)) return null;
    tried.add(token);
    const res = await greenhouseBoardFetch(token, jobId);
    if (res.content) return res.content;
    if (res.status === 404 && !sawRealBoard) sawRealBoard = await greenhouseBoardExists(token);
    return null;
  };

  // 1. The token spelled out in the URL path (careerpuck / greenhouse-hosted boards), then the
  //    stored slug on the chance it is a real token.
  let out = await attempt(greenhouseTokenFromUrl(job.url));
  if (out) return out;
  out = await attempt(job.ats_slug);
  if (out) return out;

  // 2. The careers page the URL points at, which embeds the token on classic boards.
  if (job.url && isPublicHttpsUrl(job.url)) {
    out = await attempt(await discoverGreenhouseToken(job.url));
    if (out) return out;
  }

  // 3. A sibling row for the same company, then the domain and company name normalised. Modern
  //    careers pages load the board client-side, so step 2 finds nothing on them and these are
  //    the only remaining sources.
  for (const s of await greenhouseSiblingSlugs(job)) {
    out = await attempt(s);
    if (out) return out;
  }
  const host = job.domain ? String(job.domain).replace(/^www\./, '').split('.')[0] : null;
  for (const guess of [ghNorm(host), ghNorm(job.company_name)]) {
    if (!ghUsable(guess)) continue;
    out = await attempt(guess);
    if (out) return out;
  }

  // Only mark the row gone when a board we know is real disowned the requisition. Marking on a
  // bare 404 would burn rows whose token we simply never found.
  return sawRealBoard ? 'SKIP' : null;
}

async function fetchLeverDescription(job) {
  const jobId = nativeId(job, 'lever');
  const res = await fetch(
    `https://api.lever.co/v0/postings/${encodeURIComponent(job.ats_slug)}/${jobId}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return null;
  const data = await res.json();

  // Lever postings split body content across several fields. The legacy fetcher
  // only checked descriptionPlain/description, so postings where the content was
  // in descriptionBodyPlain/opening/lists got marked as failed forever.
  // Build the full description from every populated section.
  const parts = [];
  const append = (s) => { if (typeof s === 'string' && s.trim()) parts.push(s.trim()); };

  append(data.openingPlain || data.opening);
  append(data.descriptionPlain || data.description);
  append(data.descriptionBodyPlain || data.descriptionBody);

  if (Array.isArray(data.lists)) {
    for (const list of data.lists) {
      const heading = list?.text || '';
      const body    = list?.content || '';  // 'content' is HTML; we keep it as-is
      const combined = [heading, body].filter(Boolean).join('\n');
      if (combined) parts.push(combined);
    }
  }

  append(data.additionalPlain || data.additional);

  const full = parts.join('\n\n').trim();
  if (full) return full;

  // We successfully got a 200 + parsed response, but every text field is empty.
  // These postings (often used as redirect landing pages) genuinely have no body.
  // Mark them N/A so we stop retrying every cycle forever.
  return 'SKIP';
}

// Ashby's per-job posting-api endpoint now 401s. The BOARD-LIST endpoint is still public and
// carries descriptionHtml for every posting, so fetch the whole board once per slug (cached) and
// look up the posting by its UUID (which is the id in job.url). One request serves all a
// company's jobs in the batch instead of one-per-job.
const ashbyBoardCache = new Map(); // slug -> { map: Map(id -> descHtml) | null, ts }
const ASHBY_TTL_MS = 30 * 60 * 1000;
async function ashbyBoard(slug) {
  const hit = ashbyBoardCache.get(slug);
  if (hit && Date.now() - hit.ts < ASHBY_TTL_MS) return hit.map;
  let map = null;
  try {
    const res = await fetch(
      `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`,
      { signal: AbortSignal.timeout(12000) });
    if (res.ok) {
      const data = await res.json();
      map = new Map();
      for (const j of (data.jobs || [])) {
        const d = j.descriptionHtml || j.descriptionPlain;
        if (j.id && d) map.set(j.id, d);
      }
    }
  } catch { /* network/timeout — leave map null, retry next cycle */ }
  ashbyBoardCache.set(slug, { map, ts: Date.now() });
  return map;
}
async function fetchAshbyDescription(job) {
  const board = await ashbyBoard(job.ats_slug);
  if (!board) return null; // board fetch failed — retryable
  const desc = board.get(nativeId(job, 'ashby'));
  if (desc) return desc;
  // Board loaded fine but this posting isn't listed → removed/unlisted. Stop retrying.
  return board.size ? 'SKIP' : null;
}

// Build the iCIMS iframe endpoint from the job's own URL rather than from `{ats_slug}.icims.com`.
//
// The stored slug frequently does not match the host that actually serves the posting — measured
// 2026-08-10: slug `careers-quiddity` vs host `career-fairs-quiddity`, slug `aujscareers-aus` vs
// host `securitycareers-alliedbarton` — and customers on a vanity domain store the domain itself
// as the slug (`jobs.ajg.com`), which built the nonsense host `jobs.ajg.com.icims.com`. The URL
// already carries the correct host and requisition id, so prefer it and keep the slug as fallback.
//
// SSRF: job.url is imported data, so only ever fetch https on the iCIMS-hosted domain or the
// exact host already recorded for this posting, and never a private/loopback target.
function icimsIframeUrl(job) {
  const externalId = nativeId(job, 'icims');
  const m = String(job.url || '').match(/^https:\/\/([a-z0-9.-]+)\/(.*\/)?jobs\/(\d+)/i);
  if (m) {
    const host = m[1].toLowerCase();
    const safeHost = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)
      && !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
    if (safeHost) return `https://${host}/${m[2] || ''}jobs/${m[3]}/job?in_iframe=1`;
  }
  if (!/^[a-z0-9-]+$/i.test(String(job.ats_slug || ''))) return null;
  return `https://${job.ats_slug}.icims.com/jobs/${externalId}/job?in_iframe=1`;
}

async function fetchIcimsDescription(job) {
  const url = icimsIframeUrl(job);
  if (!url) return null;
  try {
    // Host is derived from imported data, so the whole redirect chain is checked, not just
    // the first URL.
    const res = await fetchPublicHtml(url);
    // 410 Gone is iCIMS's answer for a pulled requisition. It is a permanent state, so mark the
    // row unavailable instead of re-fetching it every cycle forever.
    if (res.status === 410 || res.status === 404) return 'SKIP';
    if (!res.ok) return null;
    // Extract description from JSON-LD (most reliable)
    const ld = extractJsonLdDescription(res.html);
    if (ld) return ld;
  } catch { /* timeout or network error */ }
  return null;
}

// Extract the inner HTML of the first <div> whose class contains `needle`, using a tag-depth
// counter (personio nests divs, so a regex can't find the matching close). Returns null if absent.
function extractDivByClass(html, needle) {
  const open = new RegExp(`<div[^>]*class="[^"]*${needle}[^"]*"[^>]*>`, 'i');
  const m = open.exec(html);
  if (!m) return null;
  let i = m.index + m[0].length;
  const start = i;
  let depth = 1;
  const tagRe = /<\/?div\b[^>]*>/gi;
  tagRe.lastIndex = i;
  let t;
  while ((t = tagRe.exec(html)) !== null) {
    depth += t[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return html.slice(start, t.index);
  }
  return null;
}

// Personio's XML feed serves EMPTY <jobDescriptions> — so descriptions were never captured, and
// aggregator-imported personio jobs kept a low-quality AI SUMMARY. The real full description lives
// only on the HTML job page (job.url), inside a page_jobDescription container. Extract it there.
// SSRF guard: job.url originates from imported data, so never fetch an arbitrary host. Personio
// postings are always served from the personio-hosted subdomain; require it (https + host suffix)
// before fetching, which blocks localhost / private-IP / cloud-metadata targets outright.
function isPersonioUrl(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:') return false;
    const h = url.hostname.toLowerCase();
    return h.endsWith('.jobs.personio.de') || h.endsWith('.jobs.personio.com');
  } catch { return false; }
}

async function fetchPersonioDescription(job) {
  if (!job.url || !isPersonioUrl(job.url)) return null;
  const res = await fetch(job.url, {
    headers: { 'user-agent': 'Mozilla/5.0', accept: 'text/html' },
    redirect: 'follow', signal: AbortSignal.timeout(15000),
  });
  if (res.status === 404 || res.status === 410) return 'SKIP'; // job gone
  if (!res.ok) return null;
  const html = await res.text();
  // Prefer the personio-specific container; fall back to the generic extractors.
  const block = extractDivByClass(html, 'page_jobDescription') || extractDivByClass(html, 'detail-block-description');
  if (block && block.replace(/<[^>]+>/g, ' ').trim().length > 120) return block.trim();
  return extractDescriptionFromHtml(html) || null;
}

async function fetchRecruiteeDescription(job) {
  const jobId = job.external_id.replace('recruitee_', '');
  const res = await fetch(
    `https://${encodeURIComponent(job.ats_slug)}.recruitee.com/api/offers/${jobId}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.offer?.description || data.description || null;
}

async function fetchRipplingDescription(job) {
  const jobUuid = nativeId(job, 'rippling');
  const res = await fetch(
    `https://api.rippling.com/platform/api/ats/v1/board/${encodeURIComponent(job.ats_slug)}/jobs/${jobUuid}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const desc = data.description;
  if (!desc) return null;
  const parts = [desc.company, desc.role, desc.compensation].filter(Boolean);
  return parts.length > 0 ? parts.join('\n') : null;
}

async function fetchZohoDescription(job) {
  if (!job.url || !isPublicHttpsUrl(job.url)) return null;
  const res = await fetch(job.url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return null;
  const html = await res.text();
  const match = html.match(/var\s+jobs\s*=\s*JSON\.parse\('(.+?)'\)/);
  // Some Zoho tenants use a JS-only SPA template (HTML body ~2KB, no embedded
  // data). No regex match means we can't extract anything without a real
  // browser — mark SKIP so we don't retry these forever.
  if (!match) return 'SKIP';
  // Zoho's embedded JSON uses \xNN hex escapes for many characters (&, ', ", /, etc.).
  // The legacy unescaper only handled \x22 and \x27, so any payload containing
  // \x26 (&) or other hex codes broke JSON.parse — root cause of 308 zoho rows
  // missing descriptions. Decode all \xNN sequences generically.
  let raw = match[1].replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
  // Zoho also emits non-standard JSON escapes like "2026\-04\-21" (backslash
  // followed by an arbitrary character). JSON only allows \", \\, \/, \b, \f,
  // \n, \r, \t, \uXXXX — anything else trips JSON.parse. Strip those stray
  // backslashes, keeping the valid escapes intact.
  raw = raw.replace(/\\([^"\\/bfnrtu])/g, '$1');
  // Legacy double-escape cleanup (kept for payloads that embed JSON-in-JSON).
  raw = raw.replace(/\\\\"/g, '\\"').replace(/\\\\:/g, ':').replace(/\\\\\//g, '/');
  try {
    const parsed = JSON.parse(raw);
    const jobData = Array.isArray(parsed) ? parsed[0] : parsed;
    const desc = jobData?.Job_Description;
    if (typeof desc !== 'string') return null;            // unexpected shape, retry later
    if (desc.trim() === '') return 'SKIP';                // upstream-empty, stop retrying
    return desc;
  } catch {
    // Last-ditch: try a regex extract for just the Job_Description field
    // (handles cases where some other field has weird encoding we missed).
    const descMatch = raw.match(/"Job_Description"\s*:\s*"([\s\S]*?)"\s*,\s*"/);
    if (descMatch) {
      const desc = descMatch[1].replace(/\\"/g, '"');
      if (desc.trim()) return desc;
      return 'SKIP'; // matched but empty
    }
    // Both JSON.parse and regex fallback failed — this tenant uses a format
    // we can't handle. SKIP rather than retrying forever.
    return 'SKIP';
  }
}

async function fetchWorkableDescription(job) {
  const shortcode = job.external_id.replace('workable_', '');
  const res = await fetch(
    `https://apply.workable.com/api/v2/accounts/${encodeURIComponent(job.ats_slug)}/jobs/${shortcode}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const parts = [data.description, data.requirements, data.benefits].filter(Boolean);
  return parts.length > 0 ? parts.join('\n') : null;
}

async function fetchJobviteDescription(job) {
  if (!job.url || !isPublicHttpsUrl(job.url)) return null;
  const res = await fetch(job.url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  const html = await res.text();
  const ld = extractJsonLdDescription(html);
  if (ld) return ld;
  const ogMatch = html.match(/property="og:description"[^>]*content="([^"]*)"/i);
  return ogMatch?.[1]?.length > 50 ? ogMatch[1] : null;
}

async function fetchComeetDescription(job) {
  const positionUid = job.external_id.replace('comeet_', '');
  const slugParts = job.ats_slug.split(':');
  if (slugParts.length < 2) return null;
  const [uid, ...tokenParts] = slugParts;
  const token = tokenParts.join(':');
  // `details=true` is required. Without it the endpoint answers 200 with position METADATA only
  // — name, department, location, urls — and no description field of any kind, which is why this
  // filled 0 of 1,963 while looking perfectly healthy: the request succeeded every time.
  const res = await fetch(
    `https://www.comeet.co/careers-api/2.0/company/${encodeURIComponent(uid)}/positions/${encodeURIComponent(positionUid)}?token=${encodeURIComponent(token)}&details=true`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return null;
  const data = await res.json();

  // details is an ARRAY of {name, value} sections (Description, Responsibilities, Requirements,
  // Benefits), not an object keyed by name — `data.details?.description` was always undefined
  // even on a response that carried the text. Empty sections are normal; drop them.
  if (Array.isArray(data.details)) {
    const body = data.details
      .filter((d) => d && d.value && String(d.value).trim())
      .map((d) => (d.name ? `<h3>${d.name}</h3>\n${d.value}` : String(d.value)))
      .join('\n');
    if (body.trim()) return body;
  }
  return data.description || null;
}

function buildPinpointSections(data) {
  const sections = [];
  if (data.description) sections.push(data.description);
  if (data.key_responsibilities) {
    const header = data.key_responsibilities_header || 'Key Responsibilities';
    sections.push(`<h3>${header}</h3>${data.key_responsibilities}`);
  }
  if (data.skills_knowledge_expertise) {
    const header = data.skills_knowledge_expertise_header || 'Skills, Knowledge and Expertise';
    sections.push(`<h3>${header}</h3>${data.skills_knowledge_expertise}`);
  }
  if (data.benefits) {
    const header = data.benefits_header || 'Benefits';
    sections.push(`<h3>${header}</h3>${data.benefits}`);
  }
  return sections.length > 0 ? sections.join('\n') : null;
}

// Pinpoint's per-job endpoint ({slug}.pinpointhq.com/postings/{id}.json) is dead — 404 for the
// numeric id, 406 for the URL UUID. Descriptions now live ONLY in the LIST (postings.json), which
// also serves custom-domain accounts (careers.infor.com). Fetch the board once per slug (cached)
// and match the posting by numeric id OR the UUID in job.url. This is what makes aggregator-imported
// pinpoint jobs (no description at import) fillable.
const pinpointBoardCache = new Map(); // slug -> { list, ts }
const PP_TTL_MS = 30 * 60 * 1000;
async function pinpointBoard(slug) {
  const hit = pinpointBoardCache.get(slug);
  if (hit && Date.now() - hit.ts < PP_TTL_MS) return hit.list;
  let list = null;
  try {
    const res = await fetch(`https://${encodeURIComponent(slug)}.pinpointhq.com/postings.json`,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
    if (res.ok) { const j = await res.json(); list = Array.isArray(j.data || j.postings || j) ? (j.data || j.postings || j) : []; }
  } catch { /* network — retry next cycle */ }
  pinpointBoardCache.set(slug, { list, ts: Date.now() });
  return list;
}
async function fetchPinpointDescription(job) {
  const list = await pinpointBoard(job.ats_slug);
  if (!list) return null; // board fetch failed — retryable
  const wantId = String(job.external_id).replace('pinpoint_', '');
  const wantUuid = (job.url || '').match(UUID_RE)?.[0]?.toLowerCase();
  const post = list.find((p) => String(p.id) === wantId
    || (wantUuid && String(p.url || '').toLowerCase().includes(wantUuid)));
  if (!post) return list.length ? 'SKIP' : null; // board loaded but posting gone → stop retrying
  return buildPinpointSections(post) || 'SKIP';
}

async function fetchSuccessFactorsDescription(job) {
  if (!job.url || !isPublicHttpsUrl(job.url)) return null;
  const res = await fetch(job.url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return null;
  const html = await res.text();
  const ld = extractJsonLdDescription(html);
  if (ld) return ld;
  return null;
}

/**
 * Extract job description from page body HTML using common CSS selectors.
 * Targets well-known job description container classes/IDs.
 */
function extractBodyDescription(html) {
  if (!html) return null;

  // Oracle CX rendered pages (Knockout.js)
  const oracleDesc = extractOracleRenderedDescription(html);
  if (oracleDesc) return oracleDesc;

  // Taleo server-rendered pages
  const taleoDesc = extractTaleoDescription(html);
  if (taleoDesc) return taleoDesc;

  // Common job description selectors (class or id)
  const patterns = [
    /class="job[_-]?description"[^>]*>([\s\S]*?)<\/div>/i,
    /id="job[_-]?description"[^>]*>([\s\S]*?)<\/div>/i,
    /id="description[_-]?box"[^>]*>([\s\S]*?)<\/div>/i,
    /class="job[_-]?details?[_-]?content"[^>]*>([\s\S]*?)<\/div>/i,
    /class="posting[_-]?description"[^>]*>([\s\S]*?)<\/div>/i,
    /data-testid="job[_-]?description"[^>]*>([\s\S]*?)<\/div>/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m?.[1] && m[1].length > 100) return m[1].trim();
  }
  return null;
}

/**
 * Extract description from raw HTML using multiple strategies:
 * 1. JSON-LD JobPosting schema
 * 2. Page body (job_description divs)
 * 3. og:description meta tag
 * 4. meta description tag
 */
function extractDescriptionFromHtml(html) {
  if (!html) return null;
  // 1. JSON-LD (most reliable)
  const ld = extractJsonLdDescription(html);
  if (ld) return ld;
  // 2. Page body (job description divs)
  const bodyDesc = extractBodyDescription(html);
  if (bodyDesc) return bodyDesc;
  // 3. og:description (often has full job description)
  const ogMatch = html.match(/property="og:description"[^>]*content="([^"]*)"/i)
    || html.match(/content="([^"]*)"[^>]*property="og:description"/i);
  if (ogMatch?.[1] && ogMatch[1].length > 100) return ogMatch[1];
  // 4. meta description
  const metaMatch = html.match(/name="description"[^>]*content="([^"]*)"/i)
    || html.match(/content="([^"]*)"[^>]*name="description"/i);
  if (metaMatch?.[1] && metaMatch[1].length > 100) return metaMatch[1];
  return null;
}


/**
 * Simplify.jobs — the description lives in the page's own __NEXT_DATA__ payload.
 *
 * These rows came from Simplify's Typesense search index, which carries no description at all
 * (search indexes deliberately omit them — the same reasoning src/utils/meili.js applies to our
 * own). So every simplify row lands description-less and can only be filled from the posting page.
 *
 * The page is server-rendered, so one GET is enough; there is no JSON data route
 * (/_next/data/{buildId}/p/{id}.json returns 404 — the page is not statically generated).
 * Requested with gzip: 160KB plain versus 44KB compressed, and this runs over a million rows.
 *
 * A 404 means the posting is gone from Simplify, which is terminal — return SKIP so the row is
 * marked 'N/A' rather than retried forever.
 */
async function fetchSimplifyDescription(job, rawData) {
  const id = (rawData && (rawData.posting_id || rawData.simplify_id))
    || String(job.url || '').match(/\/p\/([0-9a-f-]{36})/i)?.[1];
  if (!id) return 'SKIP';

  // Retry transient network failures rather than counting them as a dead posting.
  //
  // This machine resolves through one nameserver and runs ~39 crawlers alongside this backfill,
  // so undici's generic "fetch failed" (DNS/socket, not HTTP) appears in bursts. Treating those
  // as failures walled the drain: 2,500 consecutive rows "unfillable" while every one of them
  // fetched fine by hand a moment later, and the runner gave up on the whole platform.
  let res = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(`https://simplify.jobs/p/${encodeURIComponent(id)}`, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'accept-encoding': 'gzip, deflate, br',
        },
        signal: AbortSignal.timeout(20000),
      });
      break;
    } catch (err) {
      if (attempt === 2) return null;         // still NULL, so the row is retried next cycle
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1) ** 2));
    }
  }
  if (!res) return null;
  if (res.status === 404 || res.status === 410) return 'SKIP';
  if (!res.ok) return null;                       // transient — retry next cycle

  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  let data;
  try { data = JSON.parse(m[1]); } catch { return null; }

  const desc = data?.props?.pageProps?.jobPosting?.description;
  if (typeof desc !== 'string' || desc.trim().length < 40) {
    // Page rendered but carries no usable body — terminal for this posting.
    return data?.props?.pageProps?.jobPosting ? 'SKIP' : null;
  }
  return desc;
}

async function fetchDescription(job) {
  const rawData = typeof job.raw_data === 'string' ? JSON.parse(job.raw_data) : job.raw_data;

  // Try ATS-specific fetcher first
  let description = null;
  switch (job.ats) {
    case 'workday':
      description = await fetchWorkdayDescription(job, rawData); break;
    case 'taleo':
      description = await fetchTaleoDescription(job); break;
    // Same Candidate Experience product, two labels in our data — `oraclecloud` rows were
    // reaching this switch, matching nothing, and returning null forever.
    case 'oracle':
    case 'oraclecloud':
      description = await fetchOracleDescription(job); break;
    case 'smartrecruiters':
      description = await fetchSmartRecruitersDescription(job); break;
    case 'bamboohr':
      description = await fetchBambooHRDescription(job); break;
    case 'jazzhr':
      description = await fetchJazzHRDescription(job); break;
    case 'breezy':
      description = await fetchBreezyDescription(job); break;
    case 'greenhouse':
      description = await fetchGreenhouseDescription(job); break;
    case 'lever':
      description = await fetchLeverDescription(job); break;
    case 'ashby':
      description = await fetchAshbyDescription(job); break;
    case 'simplify':
      description = await fetchSimplifyDescription(job, rawData); break;
    case 'icims':
      description = await fetchIcimsDescription(job); break;
    case 'personio':
      description = await fetchPersonioDescription(job); break;
    case 'recruitee':
      description = await fetchRecruiteeDescription(job); break;
    case 'rippling':
      description = await fetchRipplingDescription(job); break;
    case 'zoho':
      description = await fetchZohoDescription(job); break;
    case 'workable':
      description = await fetchWorkableDescription(job); break;
    case 'pinpoint':
      description = await fetchPinpointDescription(job); break;
    case 'successfactors':
      description = await fetchSuccessFactorsDescription(job); break;
    case 'comeet':
      description = await fetchComeetDescription(job); break;
    case 'paylocity':
      description = await fetchPaylocityDescription(job); break;
  }

  // Last resort: the posting's own page.
  //
  // The note that used to sit here — "all active ATS platforms return descriptions via their own
  // APIs, so if the ATS fetcher returned nothing we just retry next cycle" — is true only when
  // `ats_slug` is right. For the ~615k aggregator-imported rows it frequently is not: it holds a
  // URL path segment or a URL-encoded fragment (`en`, `careers`, `forward%20financing`), so the
  // API call is built against a board that does not exist and the row retries forever.
  //
  // The URL in the same row still points at the real posting, and every one of these ATSes
  // server-renders a JobPosting JSON-LD block on it. Measured 2026-08-10 on rows that had failed
  // their ATS fetcher: 11 of 12 returned 200 with usable JSON-LD. One extra request only on jobs
  // that already failed, so the cost lands on the backlog rather than the steady path.
  if (!description && isPublicHttpsUrl(job.url)) {
    try {
      const res = await fetchPublicHtml(job.url, { headers: WD_HEADERS });
      if (res.ok) {
        const html = res.html;
        // NOT extractDescriptionFromHtml: its steps 3 and 4 fall back to og:description and
        // meta description behind a >100 char gate. Those are page blurbs, not job bodies —
        // measured here, they returned the COMPANY description cut off mid-word ("...creating a
        // better world for dogs in the future. I..."). Writing one is worse than writing
        // nothing: description stops being NULL, so the row leaves the candidate set and the
        // truncated blurb becomes permanent. Only the two structural extractors are trusted.
        const candidate = extractJsonLdDescription(html) || extractBodyDescription(html);
        description = looksLikeRealDescription(candidate) ? candidate : null;
      } else if (res.status === 404 || res.status === 410) {
        // The posting itself is gone — stop re-fetching it every cycle.
        return 'SKIP';
      }
    } catch { /* network/timeout — leave null and retry next cycle */ }
  }

  return description;
}

// Quality gate for the generic URL fallback ONLY — the per-ATS fetchers hit real job endpoints
// and are trusted as-is.
//
// A write here is irreversible in practice: it clears description IS NULL, so the row leaves the
// backfill's candidate set and nothing ever revisits it. That makes a wrong fill strictly worse
// than no fill, so anything that looks like a page blurb rather than a job body is rejected —
// too short after tag-stripping, or cut off with an ellipsis the way meta descriptions are.
function looksLikeRealDescription(text) {
  if (!text) return false;
  const plain = String(text)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:amp;)*(?:nbsp|#160);/gi, ' ')
    .replace(/&(?:amp;)+/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length < 300) return false;
  if (/(?:\.\.\.|…)$/.test(plain)) return false;

  // Unrendered client-side template. Breezy serves an SPA shell whose markup still contains
  // %BREADCRUMB_JOB_OPENINGS% / %BUTTON_APPLY_TO_POSITION% placeholders — there is no job body
  // in the HTML at all, so anything harvested from that page is chrome.
  if (/%[A-Z][A-Z0-9_]{4,}%/.test(plain)) return false;

  // Truncation without an explicit ellipsis: meta/og blurbs are cut to a character budget and
  // stop mid-sentence ("...ASX-listed enterprises. If you have"). A real job body ends on
  // terminal punctuation. Only enforced below 800 chars, since a long text that happens to end
  // on a bare word is far more likely to be a genuine (if untidy) posting than a blurb.
  if (plain.length < 800 && !/[.!?:;)"'\]]$/.test(plain)) return false;

  return true;
}

// SSRF guard for imported URLs: https only, a public DNS name, never an internal target. Used
// before any fetch of a job.url value, which originates from third-party import data.
//
// The URL parser does more work here than it looks: `new URL()` normalises IPv4 shorthand, so
// `127.1`, `0x7f.1` and `2130706433` all arrive at this check already rewritten to `127.0.0.1`
// and are caught by the dotted-quad rule.
function isPublicHttpsUrl(u) {
  let parsed;
  try { parsed = new URL(String(u || '')); } catch { return false; }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return false; // needs a dot; rejects bare/IPv6
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;         // no raw IPv4 literals
  if (/(^|\.)(localhost|local|internal|localdomain)$/.test(host)) return false;
  return true;
}

/**
 * Fetch HTML from an imported URL with the redirect chain checked at every hop.
 *
 * Validating only the URL we were handed is not enough: with `redirect: 'follow'` the runtime
 * chases 3xx responses itself, so a perfectly public posting URL that redirects to
 * http://169.254.169.254/ or an internal host lands there with the guard already satisfied and
 * the body handed back to us. Follow redirects manually so isPublicHttpsUrl runs against every
 * hop, and cap the chain so a redirect loop cannot hang a backfill worker.
 */
async function fetchPublicHtml(url, { headers, timeoutMs = 15000, maxRedirects = 4 } = {}) {
  let current = String(url);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!isPublicHttpsUrl(current)) return { ok: false, status: 0, blocked: true };
    const res = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers,
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return { ok: false, status: res.status };
      // Relative Location headers are legal and common; resolve against the current hop.
      try { current = new URL(loc, current).toString(); } catch { return { ok: false, status: res.status }; }
      continue;
    }
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, status: res.status, html: await res.text() };
  }
  return { ok: false, status: 0, tooManyRedirects: true };
}

/**
 * Process a single job — fetch description and update DB.
 * Returns 'filled' or 'failed'.
 */
async function processJob(job, ats, failures) {
  try {
    const description = await fetchDescription(job);
    if (description === 'SKIP') {
      // Tenant has no public descriptions — mark as unavailable so we stop retrying
      await query("UPDATE jobs SET description = 'N/A' WHERE id = ?", [job.id]);
      return 'skipped';
    }
    if (description) {
      await query('UPDATE jobs SET description = ? WHERE id = ?', [description, job.id]);
      metrics.increment(`backfill.filled.${ats}`);
      return 'filled';
    } else {
      // Leave description as NULL so it gets retried next cycle.
      //
      // This branch used to return with NO log at all — only the `catch` below logged — so a
      // fetcher returning empty was indistinguishable from one that was never called. On
      // 2026-08-10 that hid 16 consecutive all-zero batches behind a single warning line.
      // Record a sample for the batch summary rather than a line per job: a full batch of
      // failures is normal while the cursor crosses a wall of dead postings, and logging each
      // one buries the batches that matter.
      metrics.increment(`backfill.failed.${ats}`);
      if (failures && failures.length < 3) {
        failures.push({ jobId: job.id, slug: job.ats_slug, url: String(job.url || '').slice(0, 110) });
      }
      return 'failed';
    }
  } catch (err) {
    // Leave description as NULL so it gets retried next cycle
    metrics.increment(`backfill.failed.${ats}`);
    if (failures && failures.length < 3) {
      failures.push({ jobId: job.id, slug: job.ats_slug, err: err.message.slice(0, 90) });
    }
    logger.warn({ jobId: job.id, ats: job.ats, slug: job.ats_slug, err: err.message }, 'Backfill fetch failed');
    return 'failed';
  }
}

/**
 * Run jobs concurrently with a pool of N workers.
 */
async function runWithConcurrency(items, concurrency, fn) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// Where each ATS's walk has reached. Module-level so it survives between cycles in a long-lived
// worker; a restart simply begins the rotation again from the start.
const descCursor = new Map();

// Per-ATS cool-off after a timeout. Originally this existed because the candidate query had no
// index to serve it and genuinely could not finish. That is no longer true — idx_jobs_desc_backfill
// (scripts/add-desc-backfill-index.sql) is live, and the same query now measures 206-622ms.
//
// So a timeout today means CONTENTION, not a hopeless platform, and the old policy read it exactly
// backwards. Measured 2026-08-21: nine platforms cooled off inside the same second (07:34:42), and
// eight more at 06:28:12 — scans do not fail in synchronised groups because eight tables went bad
// at once, they fail that way because they were all queued behind one connection. The fleet runs
// this process at PG_POOL_MAX=1 deliberately (the Heroku role ceiling is 40 and the live API needs
// the headroom), and backfillDescriptions fired all ~15 platform scans at once into that single
// slot. They then hit the 20s query_timeout together and each earned an hour in the corner.
//
// Two changes: scans are serialised at the caller (see backfillDescriptions), and a single timeout
// no longer parks a platform. Two CONSECUTIVE timeouts do, and only for 15 minutes, because the
// congestion that causes them clears in minutes rather than hours.
const descCooloff = new Map();
const descTimeoutStreak = new Map();
const COOLOFF_MS = 15 * 60 * 1000;
const COOLOFF_AFTER_TIMEOUTS = 2;

/**
 * Fetch one platform's candidate rows. Split out from backfillForAts so the caller can run the
 * DB half serially while keeping the HTTP half parallel — see backfillDescriptions.
 *
 * Returns { jobs } on success, { cooling: true } while backing off, or { timedOut: true }.
 */
async function scanCandidates(ats, batchSize) {
  const until = descCooloff.get(ats) || 0;
  // `cooling`, not `skipped` — skipped is a COUNT of jobs marked unavailable this batch, and
  // returning a boolean under that name printed `gone: true` in the batch summary, which reads
  // as a job count and hid the fact that the platform never ran at all.
  if (Date.now() < until) return { cooling: true };
  // Keyset walk on the primary key, NOT `ORDER BY random()`.
  //
  // random() was chosen for a real reason: failed jobs stay description=NULL, so a fixed
  // ordering re-selects the SAME newest batch every cycle, and when the newest N are all
  // unfillable (dead / SPA / soft-block) that wall blocks the fillable jobs behind it forever.
  //
  // But random() has to compute a value for every candidate row and sort the lot to pick a few
  // dozen, so its cost scales with the backlog rather than the batch — the same fault that had
  // dead-job pruning timing out on every run. Measured on this table, that shape of query goes
  // from seconds to over a minute.
  //
  // A cursor solves the wall without the scan: it only ever moves forward, so an unfillable
  // batch is passed over rather than re-selected, and it wraps at the end to re-sample the ones
  // that failed. Same property random() was bought for, at index cost.
  const from = descCursor.get(ats) || 0;
  let jobs;
  try {
    // Optional id-partitioning so several runners can share one platform's backlog.
    //
    // The cursor above lives in process memory, so two processes on the same ATS both start at 0
    // and walk the SAME rows — every fetch done twice. That matters for paylocity, whose list
    // crawl carries no body at all: 118k rows at ~60/round is ~16 hours single-runner.
    //
    // Defaults to mod=1/rem=0, which matches every row and changes nothing — the Render worker
    // and any existing caller keep their current behaviour untouched.
    //
    // `id % mod` is not indexable, so a partitioned scan reads roughly `mod` times as many index
    // entries to fill a batch. That is fine here because the keyset cursor bounds the walk and
    // the batch is small; it is emphatically NOT a pattern to copy into a query that lacks one.
    const pMod = Math.max(1, parseInt(process.env.DESC_PARTITION_MOD, 10) || 1);
    const pRem = ((parseInt(process.env.DESC_PARTITION_REMAINDER, 10) || 0) % pMod + pMod) % pMod;
    const partClause = pMod > 1 ? 'AND j.id % ? = ?' : '';
    const partParams = pMod > 1 ? [pMod, pRem] : [];
    ({ rows: jobs } = await query(
      `SELECT j.id, j.ats, j.external_id, j.url, j.raw_data, j.company_id,
              c.ats_slug, c.company_name, c.domain
       FROM jobs j JOIN companies c ON j.company_id = c.id
       WHERE j.removed_at IS NULL
       AND j.description IS NULL
       AND j.ats = ?
       AND j.id > ?
       ${partClause}
       ORDER BY j.id
       LIMIT ?`,
      [ats, from, ...partParams, batchSize]
    ));
  } catch (err) {
    // Only a timeout earns a cool-off; a real error should still surface to the caller.
    if (/timeout/i.test(err.message)) {
      const streak = (descTimeoutStreak.get(ats) || 0) + 1;
      descTimeoutStreak.set(ats, streak);
      if (streak >= COOLOFF_AFTER_TIMEOUTS) {
        descCooloff.set(ats, Date.now() + COOLOFF_MS);
        descTimeoutStreak.set(ats, 0);
        logger.warn({ ats, streak, cooloffMins: COOLOFF_MS / 60000 },
          'desc backfill: candidate scan timed out twice running, backing off');
      } else {
        // One timeout is congestion, and congestion clears. Say so, but do not sideline a
        // platform that will very likely answer in 250ms on the next pass.
        logger.info({ ats }, 'desc backfill: candidate scan timed out once, retrying next cycle');
      }
      return { timedOut: true };
    }
    throw err;
  }
  // A completed scan clears the streak — only CONSECUTIVE timeouts should compound.
  descTimeoutStreak.set(ats, 0);
  // Short read means the end of the table — wrap so the next cycle re-samples from the start,
  // picking up rows that failed earlier and anything new below the cursor.
  descCursor.set(ats, jobs.length < batchSize ? 0 : jobs[jobs.length - 1].id);
  return { jobs };
}

/** Fetch and store descriptions for an already-scanned batch. Pure HTTP work, safe to parallelise. */
async function processCandidates(ats, jobs, concurrency) {
  if (!jobs.length) return { checked: 0, filled: 0, failed: 0, skipped: 0, failures: [] };

  const failures = [];
  const results = await runWithConcurrency(jobs, concurrency, (job) => processJob(job, ats, failures));

  const filled = results.filter(r => r === 'filled').length;
  const failed = results.filter(r => r === 'failed').length;
  const skipped = results.filter(r => r === 'skipped').length;

  // `checked` lets a caller tell "this batch was all unfillable" from "there is nothing left",
  // which a filled/failed pair cannot express. scripts/backfill-desc-generic.js needs the
  // difference to walk past a wall of dead rows instead of halting at it.
  return { checked: jobs.length, filled, failed, skipped, failures };
}

/**
 * Scan + process one platform. Kept as-is for the single-platform callers
 * (scripts/backfill-desc-generic.js, scripts/render-worker.js), which drive one ATS at a time and
 * so never had the stampede problem that split these two halves apart.
 */
async function backfillForAts(ats, batchSize, concurrency) {
  const scan = await scanCandidates(ats, batchSize);
  if (scan.cooling) return { checked: 0, filled: 0, failed: 0, skipped: 0, cooling: true };
  if (scan.timedOut) return { checked: 0, filled: 0, failed: 0, timedOut: true };
  return processCandidates(ats, scan.jobs, concurrency);
}

async function backfillDescriptions() {
  logger.info('Description backfill: starting');

  // PHASE 1 — candidate scans, ONE AT A TIME.
  //
  // These used to run inside the same Promise.allSettled as the HTTP work below, which meant ~15
  // simultaneous queries against a pool the fleet pins at PG_POOL_MAX=1. Each scan is only
  // ~250ms served by idx_jobs_desc_backfill, but queued fifteen deep behind one connection they
  // hit the 20s query_timeout together and the cool-off then parked most of the fleet for an
  // hour at a time (measured 2026-08-21: nine platforms cooled in the same second).
  //
  // Serial costs ~4s for all fifteen and cannot stampede. The expensive half — the HTTP fetches —
  // stays fully parallel in phase 2, so throughput is unchanged.
  const scanned = [];
  for (const [ats, cfg] of Object.entries(ATS_CONFIG)) {
    let scan;
    try {
      scan = await scanCandidates(ats, cfg.batchSize);
    } catch (err) {
      logger.error({ ats, err: err.message }, 'Description backfill: candidate scan error');
      continue;
    }
    if (scan.cooling) {
      // A cooling platform is not idle — its candidate scan timed out twice running and it is
      // deliberately sitting out. That is worth one line, because a silent absence from the
      // summary is indistinguishable from "nothing left to fill".
      logger.info({ ats }, 'Description backfill: platform cooling off after repeated scan timeouts');
      continue;
    }
    if (scan.timedOut || !scan.jobs.length) continue;
    scanned.push([ats, cfg, scan.jobs]);
  }

  // PHASE 2 — fetch descriptions for every platform at once, as before. Each ATS has its own
  // rate limiting via delayMs, so they do not contend with each other.
  const results = await Promise.allSettled(
    scanned.map(async ([ats, cfg, jobs]) => {
      const { filled, failed, skipped, failures } = await processCandidates(ats, jobs, cfg.concurrency);
      if (filled > 0 || failed > 0 || skipped > 0) {
        // Carry a sample of WHY on any batch that filled nothing — that is the case where the
        // counts alone tell you nothing and someone has to go diagnose it.
        const detail = { ats, filled, failed, skipped };
        if (filled === 0 && failures && failures.length) detail.sample = failures;
        logger.info(detail, 'Description backfill: ATS batch done');
      }
      return { ats, filled, failed };
    })
  );

  let totalFilled = 0;
  let totalFailed = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') {
      totalFilled += r.value.filled;
      totalFailed += r.value.failed;
    } else {
      logger.error({ err: r.reason?.message }, 'Description backfill: ATS batch error');
    }
  }

  logger.info({ filled: totalFilled, failed: totalFailed }, 'Description backfill: complete');
  return totalFilled;
}

module.exports = {
  backfillDescriptions, fetchDescription, backfillForAts, ATS_CONFIG,
  // Exported for tests and for callers that want to separate the DB half from the HTTP half.
  scanCandidates, processCandidates,
};
