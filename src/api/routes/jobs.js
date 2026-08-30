const { Router } = require('express');
const { jobsRepo } = require('../../db');
const jobsSearch = require('../../db/repositories/jobs-search');
const { query, queryWithTimeout } = require('../../db/connection');
const { stripHtml } = require('../../utils/html');
const { recordSearchDemand, getTopDemand } = require('../searchDemand');
const { parsePostedWindow } = require('../../utils/posted-window');
const logger = require('../../logger');

const router = Router();

function formatJob(row, includeDescription = false) {
  const job = {
    id: row.id,
    external_id: row.external_id,
    title: row.title,
    department: row.department,
    location: row.location,
    workplace_type: row.workplace_type,
    employment_type: row.employment_type,
    is_remote: row.is_remote || false,
    remote_worldwide: row.remote_worldwide || false,
    visa_sponsorship: row.visa_sponsorship || null,
    experience_level: row.experience_level || null,
    url: row.url,
    posted_at: row.posted_at,
    ats: row.ats,
    // Stringified so both engines agree. salary_min/max are TEXT in Postgres, but toDocument
    // coerces them to numbers on the way into the index (a numeric filter needs real numbers),
    // so the same job came back as "75000" from SQL and 75000 from the index. The cutover
    // promises an identical row shape and no client changes; a silent type flip on a field the
    // UI renders breaks that. Postgres output is unchanged — this only normalises the index.
    salary: {
      min: row.salary_min == null ? null : String(row.salary_min),
      max: row.salary_max == null ? null : String(row.salary_max),
      currency: row.salary_currency,
      interval: row.salary_interval,
      // The figure salary_min/salary_max filters actually compare against. Without it a result
      // is baffling: filtering ">= 100000" returns a row displaying "73.85", because that is
      // 73.85/hour — $153,608/yr. Null means the row is not salary-filterable at all.
      min_annual: row.salary_min_annual == null ? null : Number(row.salary_min_annual),
      max_annual: row.salary_max_annual == null ? null : Number(row.salary_max_annual),
    },
    company: {
      id: row.company_id,
      name: row.company_name,
      domain: row.domain,
      ats_slug: row.ats_slug,
      logo_url: row.logo_url,
    },
  };
  if (includeDescription) {
    job.description = row.description ? stripHtml(row.description) : null;
  }
  return job;
}

/**
 * GET /api/jobs
 *
 * Query params (★ = supports multiple comma-separated values, OR-semantics
 * within the field, AND-semantics across fields):
 *
 *   q ★              - Role / keywords (comma-separated for "role A, role B, role C")
 *   work_mode ★      - any | remote | hybrid | onsite       (e.g. "remote,hybrid")
 *   employment_type ★ - full-time | part-time | contract | internship | any
 *   location ★       - Free text (e.g. "United States,Canada,United Kingdom")
 *   experience_level ★ - internship | entry | mid | senior | lead | executive
 *   ats ★            - ATS platform (e.g. "ashby,greenhouse,breezy")
 *   posted           - Nh | Nd | Nw | Nm (e.g. 2h, 6h, 12h, 24h, 7d, 30d, 90d, 3m).
 *                      Filters on first_seen_at (listing freshness) — source posted_at is
 *                      date-only/null for ~half the jobs, so it can't do hour-level windows.
 *   remote           - true (only fully remote jobs, indexed)
 *   remote_worldwide - true (remote jobs open to any location globally)
 *   visa             - yes | no (H1B/visa sponsorship filter)
 *   company_id       - Filter by company ID (single)
 *   limit            - Results per page (default 50, max 200)
 *   page             - Page number (1-based, alternative to offset)
 *   offset           - Pagination offset
 *
 * Multi-value can also be passed via repeated keys: ?location=US&location=Canada
 * (Express qs parser handles this transparently and yields an array.)
 */
router.get('/api/jobs', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const pageParam = parseInt(req.query.page, 10);
  const offset = pageParam > 0 ? (pageParam - 1) * limit : (parseInt(req.query.offset, 10) || 0);

  const filters = { limit, offset };

  if (req.query.q) filters.q = req.query.q;
  if (req.query.work_mode) filters.workMode = req.query.work_mode;
  if (req.query.employment_type) filters.employmentType = req.query.employment_type;
  if (req.query.location) filters.location = req.query.location;
  // Canonical param is `posted`; accept `posted_after` and `datePosted` as aliases because
  // different deployed frontends send different names (Browse-and-apply v2 on `main` sends
  // `datePosted`, an older build sent `posted_after`). All take the same Nh/Nd/Nw/Nm value.
  if (req.query.posted || req.query.posted_after || req.query.datePosted) {
    filters.posted = req.query.posted || req.query.posted_after || req.query.datePosted;
    // A value neither path can parse is dangerous precisely because nothing fails: the index
    // path returns null (falling back to Postgres) and the SQL path adds no clause at all, so
    // the request quietly becomes the broadest possible query and then dies on the statement
    // timeout. That looks like a database problem and is actually a bad parameter. Log it so the
    // offending value is identifiable instead of being inferred from a stack trace.
    if (!parsePostedWindow(filters.posted)) {
      logger.warn({ posted: String(filters.posted).slice(0, 40), path: req.path },
        'unparseable posted window — filter dropped, query will run unfiltered');
    }
  }
  if (req.query.remote) filters.remote = req.query.remote;
  if (req.query.remote_worldwide) filters.remoteWorldwide = req.query.remote_worldwide;
  if (req.query.visa) filters.visa = req.query.visa;
  if (req.query.experience_level) filters.experienceLevel = req.query.experience_level;
  // Salary. `salary_currency` defaults to USD (89% of priced rows) because the amount alone is
  // meaningless across the 56 currencies in the corpus and we do no FX conversion — without a
  // default, "over 100000" would quietly match ₹100,000 alongside $100,000.
  if (req.query.salary_min) filters.salaryMin = req.query.salary_min;
  if (req.query.salary_max) filters.salaryMax = req.query.salary_max;
  if (req.query.salary_min || req.query.salary_max) {
    filters.salaryCurrency = req.query.salary_currency || 'USD';
  }
  if (req.query.company_id) filters.companyId = parseInt(req.query.company_id, 10);
  if (req.query.ats) filters.ats = req.query.ats.split(',');

  const includeDesc = req.query.include === 'description';
  if (includeDesc) filters.includeDescription = true;

  // Search path: try the index first, fall back to Postgres on any doubt.
  //
  // jobsSearch.search() returns null when the index is unset, unreachable, or the filter set
  // cannot be expressed faithfully — so an index problem degrades to a slower correct answer
  // rather than a wrong one. SEARCH_ENGINE=postgres forces the old path outright.
  let jobs, total, totalIsCappedFromIndex = null, servedBy = 'postgres';
  const useIndex = process.env.SEARCH_ENGINE !== 'postgres';
  const hit = useIndex ? await jobsSearch.search(filters) : null;
  if (hit) {
    jobs = hit.rows;
    total = hit.total;
    totalIsCappedFromIndex = hit.totalIsCapped;
    servedBy = 'meili';
  } else {
    [jobs, total] = await Promise.all([
      jobsRepo.findActive(filters),
      jobsRepo.countActive(filters),
    ]);
  }

  // countActive stops at COUNT_CAP+1, so a value above the cap means "at least this many"
  // rather than an exact figure. Report the cap and say so, instead of implying precision we
  // did not pay for. Real paging never reaches 10,000 results (200 pages at 50/page).
  const { COUNT_CAP } = jobsRepo;
  const totalIsCapped = totalIsCappedFromIndex !== null ? totalIsCappedFromIndex : total > COUNT_CAP;
  const reportedTotal = totalIsCapped ? COUNT_CAP : total;

  const page = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(reportedTotal / limit);
  const hasNext = offset + limit < reportedTotal;
  const hasPrev = offset > 0;

  res.json({
    meta: {
      total: reportedTotal,
      totalIsCapped,
      limit,
      offset,
      page,
      totalPages,
      hasNext,
      hasPrev,
      nextOffset: hasNext ? offset + limit : null,
      prevOffset: hasPrev ? Math.max(0, offset - limit) : null,
      servedBy,
    },
    data: jobs.map(j => formatJob(j, includeDesc)),
  });

  // Fire-and-forget demand capture — NEVER awaited, self-contained try/catch, so it cannot
  // slow or break the response. Only the initial page (offset 0) counts as one user search,
  // so pagination doesn't inflate the count.
  if (offset === 0) recordSearchDemand(filters, total).catch(() => {});
});

/**
 * GET /api/demand
 * Top unmet search demand — most-searched, fewest-results first. Drives demand-based crawling.
 * Query: limit (default 100, max 500), max_results (only searches that returned <= N)
 */
router.get('/api/demand', async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 100;
  const maxResults = req.query.max_results != null ? parseInt(req.query.max_results, 10) : null;
  const rows = await getTopDemand({ limit, maxResults });
  res.json({ count: rows.length, data: rows });
});



/**
 * GET /api/companies
 * Company directory with job counts
 * Query params: q, ats, limit, page
 */
router.get('/api/companies', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const page = parseInt(req.query.page, 10) || 1;
  const offset = (page - 1) * limit;

  const clauses = ['j.removed_at IS NULL'];
  const params = [];

  if (req.query.q) {
    clauses.push('c.company_name ILIKE ?');
    params.push(`%${req.query.q}%`);
  }
  if (req.query.ats) {
    clauses.push('c.ats = ?');
    params.push(req.query.ats);
  }

  const where = clauses.join(' AND ');

  const [{ rows }, { rows: countRows }] = await Promise.all([
    query(
      `SELECT c.id, c.company_name as name, c.domain, c.logo_url, c.ats,
        COUNT(j.id) as job_count,
        COUNT(j.id) FILTER (WHERE j.is_remote = true) as remote_job_count,
        COUNT(j.id) FILTER (WHERE j.visa_sponsorship = 'yes') as visa_job_count
      FROM companies c JOIN jobs j ON j.company_id = c.id
      WHERE ${where}
      GROUP BY c.id, c.company_name, c.domain, c.logo_url, c.ats
      ORDER BY job_count DESC
      LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    ),
    query(
      `SELECT COUNT(DISTINCT c.id) as count
      FROM companies c JOIN jobs j ON j.company_id = c.id
      WHERE ${where}`,
      params
    ),
  ]);

  const total = parseInt(countRows[0].count, 10);
  res.json({
    meta: { total, limit, page, totalPages: Math.ceil(total / limit) },
    data: rows.map(r => ({
      id: r.id,
      name: r.name || r.company_name,
      domain: r.domain,
      logo_url: r.logo_url,
      ats: r.ats,
      job_count: r.job_count,
      remote_job_count: r.remote_job_count,
      visa_job_count: r.visa_job_count,
    })),
  });
});

/**
 * GET /api/companies/:id
 * Single company profile with stats
 */
router.get('/api/companies/:id', async (req, res) => {
  const { rows } = await query(
    `SELECT c.id, c.company_name, c.domain, c.logo_url, c.ats, c.career_url,
      COUNT(j.id) as job_count,
      COUNT(j.id) FILTER (WHERE j.is_remote = true) as remote_job_count,
      COUNT(j.id) FILTER (WHERE j.visa_sponsorship = 'yes') as visa_job_count
    FROM companies c LEFT JOIN jobs j ON j.company_id = c.id AND j.removed_at IS NULL
    WHERE c.id = ?
    GROUP BY c.id`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Company not found' });
  res.json({ data: rows[0] });
});



/**
 * GET /api/facets
 * Aggregated counts for filter sidebar (employment types, experience levels, ATS platforms)
 */
// Cached like the roles endpoint above. Even index-only, these four aggregates scan every
// live job: ~2.8s for the endpoint when run together, and it was being called ~18k times per
// query. The counts move slowly (a sync shifts them by a fraction of a percent), so serving a
// few-minute-old sidebar is indistinguishable to a user and removes the load entirely.
// A single stale-while-revalidate slot also stops a burst of concurrent requests all firing
// the same scan — the first caller refreshes, the rest are served the previous value.
let facetsCache = null;
let facetsCacheExpiry = 0;
let facetsInFlight = null;
const FACETS_TTL_MS = 5 * 60 * 1000;

async function loadFacets() {
  // The index returns facet counts as a byproduct of a zero-result search — no GROUP BY, no
  // scan of 2.8M rows. Falls through to the Postgres aggregates if it is unavailable.
  const fromIndex = process.env.SEARCH_ENGINE !== 'postgres' ? await jobsSearch.facets() : null;
  if (fromIndex) {
    const toRows = (obj, key) => Object.entries(obj || {})
      .map(([k, count]) => ({ [key]: k, count }))
      .sort((a, b) => b.count - a.count);
    return {
      employment_types: toRows(fromIndex.employment_type, 'employment_type'),
      experience_levels: toRows(fromIndex.experience_level, 'experience_level'),
      ats_platforms: toRows(fromIndex.ats, 'ats'),
      work_modes: toRows(fromIndex.workplace_type, 'workplace_type'),
    };
  }

  const [empTypes, expLevels, atsPlatforms, workModes] = await Promise.all([
    query(`SELECT employment_type, COUNT(*) as count FROM jobs
      WHERE removed_at IS NULL AND employment_type IS NOT NULL
      GROUP BY employment_type ORDER BY count DESC`),
    query(`SELECT experience_level, COUNT(*) as count FROM jobs
      WHERE removed_at IS NULL AND experience_level IS NOT NULL
      GROUP BY experience_level ORDER BY count DESC`),
    query(`SELECT ats, COUNT(*) as count FROM jobs
      WHERE removed_at IS NULL
      GROUP BY ats ORDER BY count DESC`),
    query(`SELECT workplace_type, COUNT(*) as count FROM jobs
      WHERE removed_at IS NULL AND workplace_type IS NOT NULL
      GROUP BY workplace_type ORDER BY count DESC`),
  ]);
  return {
    employment_types: empTypes.rows,
    experience_levels: expLevels.rows,
    ats_platforms: atsPlatforms.rows,
    work_modes: workModes.rows,
  };
}

router.get('/api/facets', async (req, res) => {
  if (facetsCache && Date.now() < facetsCacheExpiry) {
    return res.json({ data: facetsCache });
  }
  // Serve the stale value while a refresh is already running, rather than piling on.
  if (facetsInFlight && facetsCache) return res.json({ data: facetsCache });
  try {
    facetsInFlight = facetsInFlight || loadFacets();
    const data = await facetsInFlight;
    facetsCache = data;
    facetsCacheExpiry = Date.now() + FACETS_TTL_MS;
    res.json({ data });
  } catch (err) {
    if (facetsCache) return res.json({ data: facetsCache }); // stale beats an error page
    throw err;
  } finally {
    facetsInFlight = null;
  }
});

router.get('/api/jobs/:id', async (req, res) => {
  // Reject a non-numeric id here rather than letting Postgres do it. `id` is an integer column,
  // so `/api/jobs/null` reached the driver as `invalid input syntax for type integer: "null"` —
  // an unhandled 500, logged as a server fault, for what is a malformed request. Observed live
  // on 2026-08-08 for both `null` and a domain name, so the frontend does emit these.
  if (!/^\d+$/.test(String(req.params.id))) {
    return res.status(400).json({ error: 'Job id must be numeric' });
  }

  const job = await jobsRepo.findById(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const formatted = formatJob(job, true);
  formatted.description_html = job.description;
  res.json({ data: formatted });
});

module.exports = router;
