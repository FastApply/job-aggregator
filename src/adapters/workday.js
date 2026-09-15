const logger = require('../logger');
const { WORKDAY_SITES } = require('./workday-sites');

// Common Workday instances first (covers ~80% of tenants), then the higher-numbered
// pods (wd10x/wd50x) seen across the company set. discoverConfig() tries these in
// order and stops at the first that resolves, so ordering keeps the common case fast.
//
// 107 was absent until 2026-08-10, which made tp (TP-ICAP) undiscoverable no matter what its
// robots.txt said — the pod was simply never probed.
const WD_NUMBERS = [1, 2, 3, 5, 10, 12, 102, 103, 105, 107, 108, 115, 501, 502, 503, 504];
const PAGE_SIZE = 20;
const DETAIL_BATCH_SIZE = 3;

/**
 * fetch() that rides out Workday's rate limiting instead of failing the tenant on it.
 *
 * A large tenant costs thousands of requests -- ~250 list pages plus one detail fetch per
 * posting -- and Workday answers a burst of those with HTTP 429. Every fetch here used to treat
 * any non-2xx as fatal, so the FIRST 429 threw, the tenant was marked failed, and all the work
 * already done was thrown away. Measured 2026-09-15: the two local workday crawlers logged 1,149
 * x 429 against 16,515 successful syncs, and the 11 largest tenants in the corpus (cvshealth
 * 19,402 jobs, ccf 2,087, jll 2,000, ...) held ZERO rows while a plain curl to each returned its
 * full count -- we were being throttled by our own volume, then blaming the tenant.
 *
 * 429 and 503 back off and retry, honouring Retry-After when Workday sends one and otherwise
 * doubling from 2s. Anything else is returned to the caller untouched so a real 404 still
 * retires a dead tenant. Detail fetches pass retries=1: one posting's body is not worth a
 * minute of waiting, and the caller already tolerates a null.
 */
async function wdFetch(url, init, retries = 5) {
  let delay = 2000;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if ((res.status !== 429 && res.status !== 503) || attempt >= retries) return res;
    const ra = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60000) : delay;
    logger.debug({ url: url.slice(0, 80), status: res.status, attempt, wait }, 'Workday backoff');
    await new Promise((r) => setTimeout(r, wait));
    delay = Math.min(delay * 2, 32000);
  }
}

/**
 * Resolve the Workday pod number and career site slug(s) for a tenant.
 *
 * Known tenants come from workday-sites.js and cost no requests. Everything else falls back to
 * probing robots.txt across every pod, which is both slow (up to 16 requests) and unreliable:
 * a tenant serving no robots.txt, or one with no Sitemap line, is indistinguishable from a
 * tenant that does not exist, and gets written off as "could not discover config".
 *
 * Returns { wdNum, siteSlug, sites } — siteSlug is kept for callers that only handle one site
 * (backfill-descriptions.js), sites is the full list for fetchJobs to merge across.
 */
async function discoverConfig(slug) {
  const known = WORKDAY_SITES[String(slug || '').toLowerCase()];
  if (known && known.sites.length) {
    return { wdNum: known.wdNum, siteSlug: known.sites[0], sites: known.sites };
  }

  for (const wd of WD_NUMBERS) {
    try {
      const res = await fetch(
        `https://${slug}.wd${wd}.myworkdayjobs.com/robots.txt`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (!res.ok) continue;
      const text = await res.text();
      const match = text.match(/Sitemap:.*myworkdayjobs\.com\/([^/\s]+)/);
      if (match) {
        return { wdNum: wd, siteSlug: match[1], sites: [match[1]] };
      }
    } catch {
      // timeout or network error — try next
    }
  }
  return null;
}

/**
 * Fetch job detail for a single posting.
 */
async function fetchJobDetail(baseUrl, externalPath) {
  try {
    const res = await wdFetch(`${baseUrl}${externalPath}`, {
      signal: AbortSignal.timeout(10000),
    }, 1);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Extract salary from job description HTML if present.
 */
function extractSalary(description) {
  if (!description) return {};
  const match = description.match(
    /\$([\d,]+(?:\.\d{2})?)\s*[-–]\s*\$([\d,]+(?:\.\d{2})?)|(?:base[^.]*?)([\d,]+(?:\.\d{2})?)\s*(USD|CAD|GBP|EUR)\s*[-–]\s*([\d,]+(?:\.\d{2})?)\s*(USD|CAD|GBP|EUR)/i
  );
  if (match) {
    if (match[1] && match[2]) {
      const min = parseInt(match[1].replace(/,/g, ''), 10);
      const max = parseInt(match[2].replace(/,/g, ''), 10);
      if (min >= 10000 && max >= 10000 && max < 10000000) {
        return { salary_min: String(min), salary_max: String(max), salary_currency: 'USD' };
      }
    }
    if (match[3] && match[5]) {
      const min = parseInt(match[3].replace(/,/g, ''), 10);
      const max = parseInt(match[5].replace(/,/g, ''), 10);
      if (min >= 10000 && max >= 10000 && max < 10000000) {
        return { salary_min: String(min), salary_max: String(max), salary_currency: match[4] || match[6] || 'USD' };
      }
    }
  }
  return {};
}

/**
 * Build department map by querying each jobFamilyGroup facet.
 * Returns Map<externalPath, departmentName>.
 */
async function buildDeptMap(baseUrl, facets) {
  const deptMap = new Map();
  const catFacet = (facets || []).find(f => f.facetParameter === 'jobFamilyGroup');
  if (!catFacet || !catFacet.values || catFacet.values.length === 0) return deptMap;

  for (const cat of catFacet.values) {
    let catOffset = 0;
    while (catOffset < cat.count + PAGE_SIZE) {
      try {
        const res = await fetch(`${baseUrl}/jobs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            appliedFacets: { jobFamilyGroup: [cat.id] },
            limit: PAGE_SIZE, offset: catOffset, searchText: '',
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) break;
        const data = await res.json();
        const jobs = data.jobPostings || [];
        if (jobs.length === 0) break;
        for (const p of jobs) deptMap.set(p.externalPath, cat.descriptor);
        catOffset += PAGE_SIZE;
        if (jobs.length < PAGE_SIZE) break;
      } catch { break; }
    }
  }

  return deptMap;
}

/**
 * Fetch all jobs from a Workday career site with full details.
 */
async function fetchJobs(clientname) {
  const config = await discoverConfig(clientname);
  if (!config) throw new Error(`Workday: could not discover config for ${clientname}`);

  const { wdNum } = config;
  const sites = config.sites && config.sites.length ? config.sites : [config.siteSlug];

  // A tenant can run several career sites — relx runs four (relx, LexisNexisLegal,
  // ReedExhibitions, ElsevierJobs) — and a posting normally lives on exactly one of them, so
  // fetching only the first would silently drop the rest of the company's jobs.
  //
  // One site failing must not lose the others: a dead or renamed site is common on multi-site
  // tenants. Collect what works and only throw if every site failed, so the company keeps the
  // jobs it does have rather than being marked failed wholesale.
  if (sites.length > 1) {
    const merged = new Map();
    let meta = null;
    const failures = [];

    for (const site of sites) {
      try {
        const res = await fetchSiteJobs(clientname, wdNum, site);
        for (const job of res.jobs) {
          if (!merged.has(job.external_id)) merged.set(job.external_id, job);
        }
        if (!meta) meta = res.meta;
      } catch (err) {
        failures.push(`${site}: ${err.message}`);
      }
    }

    if (!merged.size && failures.length === sites.length) {
      throw new Error(`Workday: all ${sites.length} sites failed for ${clientname} — ${failures.join('; ')}`);
    }
    if (failures.length) {
      logger.warn({ slug: clientname, failures }, 'Workday: some sites failed, keeping the rest');
    }
    logger.info({ slug: clientname, wdNum, sites: sites.length, fetched: merged.size },
      'Workday multi-site fetch complete');
    return { jobs: [...merged.values()], meta: meta || {} };
  }

  return fetchSiteJobs(clientname, wdNum, sites[0]);
}

/** Fetch every job from ONE Workday career site. */
async function fetchSiteJobs(clientname, wdNum, siteSlug) {
  const baseUrl = `https://${clientname}.wd${wdNum}.myworkdayjobs.com/wday/cxs/${clientname}/${siteSlug}`;

  // Step 1: First request — get postings + facets
  const firstRes = await wdFetch(`${baseUrl}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appliedFacets: {}, limit: PAGE_SIZE, offset: 0, searchText: '' }),
    signal: AbortSignal.timeout(15000),
  });
  if (!firstRes.ok) throw new Error(`Workday HTTP ${firstRes.status}`);
  const firstData = await firstRes.json();

  // Step 2: Build department map from facets
  const deptMap = await buildDeptMap(baseUrl, firstData.facets);
  if (deptMap.size > 0) {
    logger.debug({ slug: clientname, mapped: deptMap.size }, 'Workday dept map built');
  }

  // Step 3: Collect all postings
  const postings = [...(firstData.jobPostings || [])];

  if (postings.length >= PAGE_SIZE) {
    let offset = PAGE_SIZE;
    while (offset < 5000) {
      const res = await wdFetch(`${baseUrl}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appliedFacets: {}, limit: PAGE_SIZE, offset, searchText: '' }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`Workday HTTP ${res.status}`);
      const data = await res.json();
      const page = data.jobPostings || [];
      if (page.length === 0) break;
      postings.push(...page);
      offset += PAGE_SIZE;
      if (page.length < PAGE_SIZE) break;
    }
  }

  // Step 4: Fetch details in batches
  const jobs = [];
  let companyName = null;

  for (let i = 0; i < postings.length; i += DETAIL_BATCH_SIZE) {
    const batch = postings.slice(i, i + DETAIL_BATCH_SIZE);
    const details = await Promise.all(
      batch.map(p => fetchJobDetail(baseUrl, p.externalPath))
    );

    if (i + DETAIL_BATCH_SIZE < postings.length) {
      await new Promise(r => setTimeout(r, 300));
    }

    for (let j = 0; j < batch.length; j++) {
      const posting = batch[j];
      const detail = details[j]?.jobPostingInfo || null;
      const jobReqId = posting.bulletFields?.[0] || null;
      const description = detail?.jobDescription || null;
      const salary = extractSalary(description);

      if (!companyName && details[j]?.hiringOrganization?.name) {
        companyName = details[j].hiringOrganization.name;
      }

      jobs.push({
        external_id: `workday_${jobReqId || posting.externalPath}`,
        title: posting.title,
        department: deptMap.get(posting.externalPath) || null,
        location: detail?.location || posting.locationsText || null,
        workplace_type: null,
        employment_type: detail?.timeType || null,
        salary_min: salary.salary_min || null,
        salary_max: salary.salary_max || null,
        salary_currency: salary.salary_currency || null,
        salary_interval: null,
        description,
        url: detail?.externalUrl || `https://${clientname}.wd${wdNum}.myworkdayjobs.com/${siteSlug}${posting.externalPath}`,
        posted_at: detail?.startDate || null,
        raw_data: posting,
      });
    }
  }

  logger.info({ slug: clientname, wdNum, siteSlug, fetched: jobs.length, depts: deptMap.size }, 'Workday fetch complete');

  const logoUrl = `https://${clientname}.wd${wdNum}.myworkdayjobs.com/${siteSlug}/assets/logo`;

  return { jobs, meta: { companyName, logoUrl } };
}

module.exports = { fetchJobs, discoverConfig };
