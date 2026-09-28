/**
 * Crawl jobs.workable.com marketplace API.
 * This is a separate source from apply.workable.com — it's Workable's
 * public job board with 170K+ jobs, full descriptions, and structured data.
 * No proxy needed — clean JSON API.
 */
const { query } = require('../db/connection');
const { classifyJob } = require('../utils/classify');
const logger = require('../logger');

const API_BASE = 'https://jobs.workable.com/api/v1';
const JOBS_PER_PAGE = 20; // API returns 20 per page
// Heroku worker uses the default (500 pages = 10k latest/cycle). A deep local run
// can set MARKETPLACE_MAX_PAGES much higher to walk the full ~170k marketplace.
const MAX_PAGES_PER_CYCLE = parseInt(process.env.MARKETPLACE_MAX_PAGES, 10) || 500;

function mapEmploymentType(type) {
  if (!type) return null;
  const t = type.toLowerCase();
  if (t.includes('full')) return 'full_time';
  if (t.includes('part')) return 'part_time';
  if (t.includes('contract')) return 'contract';
  if (t.includes('temporary') || t.includes('temp')) return 'temporary';
  if (t.includes('intern')) return 'internship';
  if (t.includes('freelance')) return 'freelance';
  return null;
}

function buildDescription(job) {
  const parts = [];
  if (job.description) parts.push(job.description);
  if (job.requirementsSection) parts.push(`<h3>Requirements</h3>${job.requirementsSection}`);
  if (job.benefitsSection) parts.push(`<h3>Benefits</h3>${job.benefitsSection}`);
  return parts.length > 0 ? parts.join('\n') : null;
}

function buildLocation(job) {
  if (job.locations && job.locations.length > 0) return job.locations[0];
  if (job.location) {
    const parts = [job.location.city, job.location.subregion, job.location.countryName].filter(Boolean);
    return parts.join(', ') || null;
  }
  return null;
}

async function ensureCompany(companyData) {
  if (!companyData?.id) return null;

  const careerUrl = companyData.url || `https://jobs.workable.com/company/${companyData.id}`;
  const companyName = companyData.title || 'Unknown';
  const domain = companyData.website
    ? companyData.website.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    : `jobs.workable.com`;
  const logoUrl = companyData.image || null;
  const atsSlug = `wjb_${companyData.id}`;

  // Check if company exists by career_url
  const { rows: existing } = await query(
    'SELECT id FROM companies WHERE career_url = ?',
    [careerUrl]
  );

  if (existing.length > 0) return existing[0].id;

  // Insert new company
  await query(
    `INSERT INTO companies (career_url, domain, ats, ats_slug, company_name, logo_url, origin, status, created_at, updated_at)
     VALUES (?, ?, 'workable', ?, ?, ?, 'workable_marketplace', 'active', datetime('now'), datetime('now'))`,
    [careerUrl, domain, atsSlug, companyName, logoUrl]
  );

  // Fetch the inserted ID
  const { rows: inserted } = await query(
    'SELECT id FROM companies WHERE career_url = ?',
    [careerUrl]
  );

  return inserted[0]?.id || null;
}

async function upsertJob(job, companyId) {
  const location = buildLocation(job);
  const description = buildDescription(job);
  const classification = classifyJob({
    title: job.title,
    description,
    location,
    workplace_type: job.workplace || null,
  });

  await query(
    `INSERT INTO jobs (
      external_id, company_id, ats, title, department, location,
      workplace_type, employment_type,
      salary_min, salary_max, salary_currency, salary_interval,
      description, url, posted_at, raw_data,
      visa_sponsorship, experience_level, is_remote, remote_worldwide,
      first_seen_at, last_seen_at
    )
    VALUES (?, ?, 'workable', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(external_id, company_id) DO UPDATE SET
      title = EXCLUDED.title,
      department = EXCLUDED.department,
      location = EXCLUDED.location,
      workplace_type = EXCLUDED.workplace_type,
      employment_type = EXCLUDED.employment_type,
      -- Only when changed: a walk re-sends all ~170k jobs several times a day, and assigning
      -- the large TOASTed columns unconditionally rewrites them even when byte-identical (see
      -- syncForCompany in jobs.js: 27 MB -> 3.6 MB of WAL per 2,000 unchanged rows).
      description = CASE WHEN EXCLUDED.description IS NOT NULL
                          AND EXCLUDED.description IS DISTINCT FROM jobs.description
                         THEN EXCLUDED.description ELSE jobs.description END,
      url = EXCLUDED.url,
      posted_at = EXCLUDED.posted_at,
      raw_data = CASE WHEN EXCLUDED.raw_data IS DISTINCT FROM jobs.raw_data
                      THEN EXCLUDED.raw_data ELSE jobs.raw_data END,
      last_seen_at = datetime('now'),
      removed_at = NULL`,
    [
      `workable_mkt_${job.id}`,
      companyId,
      job.title,
      job.department || null,
      location,
      job.workplace || null,
      mapEmploymentType(job.employmentType),
      null, null, null, null, // salary fields — not in marketplace API
      description,
      job.url,
      job.created || null,
      JSON.stringify(job),
      classification.visa_sponsorship || '',
      classification.experience_level || '',
      classification.is_remote || false,
      classification.remote_worldwide || false,
    ]
  );
}

/**
 * Walk the marketplace newest-first, upserting every job. Returns the walk's stats; `complete`
 * means the API ran out of pages (not that we hit maxPages or an error), and `totalSize` is what
 * the API said it held when the walk began — together they decide whether retirement may run.
 */
async function crawlWorkableMarketplace({ maxPages = MAX_PAGES_PER_CYCLE } = {}) {
  logger.info({ maxPages }, 'Workable marketplace crawl: starting');
  const startedAt = new Date();
  let totalSize = null;
  let complete = false;

  let pageToken = null;
  let totalProcessed = 0;
  let totalAdded = 0;
  let pagesProcessed = 0;
  const companyCache = new Map();

  try {
    while (pagesProcessed < maxPages) {
      const url = pageToken
        ? `${API_BASE}/jobs?query=&location=&pageToken=${encodeURIComponent(pageToken)}`
        : `${API_BASE}/jobs?query=&location=`;

      // Retry transient failures (a single dropped fetch used to kill the whole
      // deep crawl). Only give up on a page after several backed-off attempts.
      let data = null;
      for (let attempt = 1; attempt <= 6; attempt++) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          data = await res.json();
          break;
        } catch (e) {
          if (attempt === 6) { logger.error({ err: e.message, page: pagesProcessed }, 'Workable marketplace: page failed after 6 retries — stopping'); }
          else { await new Promise(r => setTimeout(r, 3000 * attempt)); }
        }
      }
      if (!data) break;
      if (totalSize == null && Number.isFinite(data.totalSize)) totalSize = data.totalSize;
      const jobs = data.jobs || [];

      if (jobs.length === 0) { complete = true; break; }

      for (const job of jobs) {
        try {
          // Get or create company
          const companyKey = job.company?.id;
          let companyId = companyCache.get(companyKey);
          if (!companyId && companyKey) {
            companyId = await ensureCompany(job.company);
            if (companyId) companyCache.set(companyKey, companyId);
          }
          if (!companyId) continue;

          await upsertJob(job, companyId);
          totalAdded++;
        } catch (err) {
          logger.debug({ jobId: job.id, err: err.message }, 'Workable marketplace job failed');
        }
        totalProcessed++;
      }

      pagesProcessed++;
      pageToken = data.nextPageToken;

      if (!pageToken) {
        logger.info('Workable marketplace crawl: reached end of results');
        complete = true;
        break;
      }

      // Delay to avoid 429 rate limits (1 second between pages)
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (err) {
    logger.error({ err: err.message }, 'Workable marketplace crawl error');
  }

  logger.info({
    pagesProcessed,
    totalProcessed,
    totalAdded,
    totalSize,
    complete,
    companiesCached: companyCache.size,
  }, 'Workable marketplace crawl: complete');

  return { added: totalAdded, processed: totalProcessed, totalSize, complete, startedAt };
}

// A walk must cover this share of what the API said it held before its absences mean anything.
const RETIRE_MIN_COVERAGE = parseFloat(process.env.MARKETPLACE_RETIRE_MIN_COVERAGE || '0.9');
// ...and a job must have been missing this long, i.e. from every walk in that window, so one bad
// page or a job briefly unlisted is never enough.
const RETIRE_GRACE_HOURS = parseInt(process.env.MARKETPLACE_RETIRE_GRACE_HOURS || '24', 10);
const RETIRE_CHUNK = 5000;
const RETIRE_MAX_OUTBOX = parseInt(process.env.MARKETPLACE_RETIRE_MAX_OUTBOX || '20000', 10);

/** Pure. May this walk's absences retire jobs, and if not, why. */
function retirementVerdict(walk) {
  if (!walk || !walk.complete) return { ok: false, reason: 'walk did not reach the end of the marketplace' };
  if (!walk.totalSize) return { ok: false, reason: 'the API reported no total to check coverage against' };
  const coverage = walk.processed / walk.totalSize;
  if (coverage < RETIRE_MIN_COVERAGE) return { ok: false, reason: `walk saw ${(coverage * 100).toFixed(1)}% of the ${walk.totalSize} listed` };
  return { ok: true };
}

/**
 * Retire marketplace jobs no complete walk has seen for RETIRE_GRACE_HOURS.
 *
 * Nothing retired these before: dead-job-check retires a job its company's crawl stopped seeing,
 * and marketplace companies are never crawled company-by-company. By 2026-09-28, 144,740 of
 * 145,733 live marketplace jobs had not been seen for 7+ days, some since June — closed postings
 * still offered to users and to First Apply. Soft delete: removed_at, which the index trigger
 * turns into a search removal. Chunked and paused on outbox depth like the other bulk updates.
 */
async function retireMissingMarketplaceJobs(walk) {
  const verdict = retirementVerdict(walk);
  if (!verdict.ok) {
    logger.warn({ reason: verdict.reason }, 'Workable marketplace: retirement skipped');
    return 0;
  }
  const cutoff = new Date(walk.startedAt.getTime() - RETIRE_GRACE_HOURS * 3600 * 1000);
  let retired = 0;
  for (;;) {
    const { rows: [o] } = await query('SELECT COUNT(*)::int n FROM jobs WHERE index_dirty_at IS NOT NULL');
    if (o.n >= RETIRE_MAX_OUTBOX) { await new Promise((r) => setTimeout(r, 20000)); continue; }
    const r = await query(
      `UPDATE jobs SET removed_at = NOW()
        WHERE id IN (SELECT id FROM jobs
                      WHERE ats = 'workable' AND external_id LIKE 'workable_mkt_%'
                        AND removed_at IS NULL AND last_seen_at < ?
                      LIMIT ${RETIRE_CHUNK})`,
      [cutoff.toISOString()]);
    const n = r.rowCount || 0;
    retired += n;
    if (n < RETIRE_CHUNK) break;
  }
  logger.info({ retired, cutoff: cutoff.toISOString() }, 'Workable marketplace: retired jobs no longer listed');
  return retired;
}

module.exports = { crawlWorkableMarketplace, retireMissingMarketplaceJobs, retirementVerdict };

// Standalone deep run: MARKETPLACE_MAX_PAGES=8500 walks the full ~170k marketplace.
if (require.main === module) {
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL'); process.exit(1); }
  crawlWorkableMarketplace()
    .then((walk) => { console.log('Workable marketplace crawl finished — jobs upserted:', walk.added); process.exit(0); })
    .catch((e) => { console.error('FATAL', e); process.exit(1); });
}
