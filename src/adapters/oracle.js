/**
 * Oracle Cloud HCM adapter.
 * Uses the public recruitingCEJobRequisitions REST API.
 * Slug formats:
 *   "{tenant}.{region}" e.g. "eeho.us2"
 *   "{tenant}.{region}.{siteNumber}" e.g. "eeho.us2.CX_45001"
 *   "full:{subdomain}/{siteNumber}" e.g. "full:jpmc.fa.oraclecloud.com/CX_1001"
 *     for tenants with non-standard URL patterns (no region segment, SaaS prod URLs, etc.)
 */
const logger = require('../logger');

// 200 is the most the list API returns per request (limit=500 still answers 200), and it stops at
// offset 10,000 whatever the total. At 25 a 13k-job site took 400 requests just to list.
const PAGE_SIZE = 200;
const MAX_OFFSET = 10000;
const DETAIL_BATCH_SIZE = 3;
// Detail calls per sync when the caller says which postings already hold text (opts.describedIds).
// Newest first, so a big site fills in over a few syncs instead of timing out on the first one.
const DETAIL_MAX = parseInt(process.env.ORACLE_DETAIL_MAX || '400', 10);
// crawl-companies-local.js gives an adapter 60s unless it asks for more. Every Oracle site with
// more than a few hundred postings ran past that (one detail call per posting, 3 at a time), the
// timeout was filed as transient, and the board was retried every 10 minutes forever without
// writing a row or an error: emqk.ca3.CX_1001 showed 247 live of 2,216, last seen 2026-11-10.
const fetchTimeoutMs = 30 * 60 * 1000;
// Ask the crawler for the external_ids that already have a description (see opts.describedIds).
const wantsStoredState = true;
const COMMON_SITE_NUMBERS = ['CX', 'CX_1', 'CX_1001', 'CX_45001', 'CX_1003'];

/**
 * Build the base API URL from parsed slug info.
 */
function buildBaseUrl(parsed) {
  if (parsed.baseUrl) return parsed.baseUrl;
  return `https://${parsed.tenant}.fa.${parsed.region}.oraclecloud.com/hcmRestApi/resources/latest`;
}

/**
 * Build the careers page URL from parsed slug info.
 */
function buildCareersUrl(parsed, siteNumber, jobId) {
  if (parsed.subdomain) {
    return `https://${parsed.subdomain}/hcmUI/CandidateExperience/en/sites/${siteNumber}/job/${jobId}`;
  }
  return `https://${parsed.tenant}.fa.${parsed.region}.oraclecloud.com/hcmUI/CandidateExperience/en/sites/${siteNumber}/job/${jobId}`;
}

/**
 * Parse the slug into tenant, region, and siteNumber.
 * Supports standard format and full subdomain format.
 */
function parseSlug(slug) {
  // Full subdomain format: "full:subdomain/siteNumber"
  if (slug.startsWith('full:')) {
    const rest = slug.slice(5);
    const slashIdx = rest.indexOf('/');
    if (slashIdx === -1) return null;
    const subdomain = rest.substring(0, slashIdx);
    const siteNumber = rest.substring(slashIdx + 1);
    return {
      tenant: null,
      region: null,
      siteNumber,
      subdomain,
      baseUrl: `https://${subdomain}/hcmRestApi/resources/latest`,
    };
  }

  const parts = slug.split('.');
  if (parts.length >= 3) {
    return { tenant: parts[0], region: parts[1], siteNumber: parts.slice(2).join('.') };
  }
  if (parts.length === 2) {
    return { tenant: parts[0], region: parts[1], siteNumber: null };
  }
  return null;
}

/**
 * Discover the siteNumber by trying common values.
 */
async function discoverSiteNumber(parsed) {
  const baseApiUrl = buildBaseUrl(parsed);
  for (const site of COMMON_SITE_NUMBERS) {
    try {
      const url = `${baseApiUrl}/recruitingCEJobRequisitions?onlyData=true&finder=findReqs;siteNumber=${site},limit=1,sortBy=POSTING_DATES_DESC`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const data = await res.json();
      if (data.items?.length > 0 || data.count > 0) {
        return site;
      }
    } catch { /* try next */ }
  }
  const label = parsed.subdomain || `${parsed.tenant}.${parsed.region}`;
  logger.warn({ label, triedSites: COMMON_SITE_NUMBERS }, 'Oracle: no working siteNumber found');
  return null;
}

/**
 * Fetch full job details (description, qualifications, responsibilities).
 */
/**
 * Parse salary from Oracle flex fields.
 * Common patterns: "53,000 USD", "80000", "120,000.00 CAD"
 */
function parseSalaryFromFlex(flexFields) {
  const minRaw = flexFields['minimum salary'] || flexFields['min salary'] || flexFields['salary minimum'] || null;
  const maxRaw = flexFields['maximum salary'] || flexFields['max salary'] || flexFields['salary maximum'] || null;

  if (!minRaw && !maxRaw) return null;

  const parse = (str) => {
    if (!str) return null;
    // Extract number: "53,000 USD" → 53000, "80000" → 80000
    const numMatch = str.replace(/,/g, '').match(/([\d.]+)/);
    return numMatch ? parseFloat(numMatch[1]) : null;
  };

  const parseCurrency = (str) => {
    if (!str) return null;
    const m = str.match(/[A-Z]{3}/);
    return m ? m[0] : null;
  };

  return {
    min: parse(minRaw),
    max: parse(maxRaw),
    currency: parseCurrency(minRaw) || parseCurrency(maxRaw) || null,
  };
}

async function fetchJobDetail(baseUrl, siteNumber, jobId) {
  try {
    const url = `${baseUrl}/recruitingCEJobRequisitionDetails?onlyData=true&expand=all&finder=ById;Id=${jobId},siteNumber=${siteNumber}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json();
    const item = data.items?.[0];
    if (!item) return null;

    const descParts = [
      item.ExternalDescriptionStr,
      item.ExternalQualificationsStr,
      item.ExternalResponsibilitiesStr,
    ].filter(Boolean);

    // Extract structured data from flex fields
    const flexFields = {};
    for (const ff of (item.requisitionFlexFields || [])) {
      if (ff.Prompt && ff.Value) {
        flexFields[ff.Prompt.toLowerCase().trim()] = ff.Value;
      }
    }

    // Extract salary from flex fields (e.g. "Minimum Salary": "53,000 USD")
    const salary = parseSalaryFromFlex(flexFields);

    return {
      description: descParts.length > 0 ? descParts.join('\n') : null,
      category: item.Category || null,
      jobFunction: item.JobFunction || null,
      department: item.Department || item.Organization || item.BusinessUnit || null,
      workplaceType: item.WorkplaceTypeCode || item.WorkplaceType || null,
      jobType: flexFields['job type'] || flexFields['employment category'] || item.JobType || null,
      workerType: item.WorkerType || null,
      jobSchedule: item.JobSchedule || flexFields['job schedule'] || null,
      role: flexFields['role'] || null,
      yearsExperience: flexFields['years'] || null,
      salary,
    };
  } catch {
    return null;
  }
}

/**
 * opts.describedIds: external_ids the board already holds text for (a Set or array). When given,
 *   only postings missing from it get a detail call, newest first and at most DETAIL_MAX; the
 *   rest are sent with description NULL, which the upsert treats as "keep what is stored". Without
 *   it every posting gets a detail call, as before (the BullMQ sync worker).
 */
async function fetchJobs(clientname, opts = {}) {
  const parsed = parseSlug(clientname);
  if (!parsed) throw new Error(`Oracle: invalid slug format "${clientname}", expected "tenant.region", "tenant.region.siteNumber", or "full:subdomain/siteNumber"`);

  let siteNumber = parsed.siteNumber;

  if (!siteNumber) {
    siteNumber = await discoverSiteNumber(parsed);
    if (!siteNumber) throw new Error(`Oracle: could not discover siteNumber for ${clientname}`);
  }

  const baseUrl = buildBaseUrl(parsed);

  // Step 1: Paginate through all job listings
  const postings = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore && offset < MAX_OFFSET) {
    const url = `${baseUrl}/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.secondaryLocations&finder=findReqs;siteNumber=${siteNumber},limit=${PAGE_SIZE},offset=${offset},sortBy=POSTING_DATES_DESC`;

    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Oracle HTTP ${res.status}`);
    const data = await res.json();

    const requisitions = data.items?.[0]?.requisitionList || [];
    if (requisitions.length === 0) break;

    postings.push(...requisitions);
    hasMore = requisitions.length === PAGE_SIZE;
    offset += PAGE_SIZE;
  }

  // Step 2: Fetch details in batches for full descriptions
  const jobs = [];
  const described = opts.describedIds
    ? (opts.describedIds instanceof Set ? opts.describedIds : new Set(opts.describedIds))
    : null;
  // Which postings get a detail call. The list is newest first, so the cap keeps the newest.
  const wanted = new Set();
  for (const p of postings) {
    if (described && wanted.size >= DETAIL_MAX) break;
    if (!described || !described.has(`oracle_${p.Id}`)) wanted.add(p.Id);
  }

  for (let i = 0; i < postings.length; i += DETAIL_BATCH_SIZE) {
    const batch = postings.slice(i, i + DETAIL_BATCH_SIZE);
    const toRead = batch.filter(job => wanted.has(job.Id));
    const settled = await Promise.allSettled(
      batch.map(job => (wanted.has(job.Id) ? fetchJobDetail(baseUrl, siteNumber, job.Id) : Promise.resolve(null)))
    );
    const details = settled.map(r => r.status === 'fulfilled' ? r.value : null);

    if (toRead.length && i + DETAIL_BATCH_SIZE < postings.length) {
      await new Promise(r => setTimeout(r, 300));
    }

    for (let j = 0; j < batch.length; j++) {
      const job = batch[j];
      const detail = details[j];
      const locations = [job.PrimaryLocation];
      if (job.secondaryLocations) {
        for (const sec of job.secondaryLocations) {
          if (sec.Name) locations.push(sec.Name);
        }
      }

      // Resolve department: detail has richer data (Category, Organization, etc.)
      const department = detail?.category
        || detail?.department
        || job.Department
        || job.JobFunction
        || null;

      // Resolve workplace type from detail or listing
      const wpCode = detail?.workplaceType || job.WorkplaceTypeCode || '';
      const workplaceType = wpCode.toLowerCase().includes('remote') ? 'remote'
        : wpCode.toLowerCase().includes('hybrid') ? 'hybrid'
        : wpCode.toLowerCase().includes('on') ? 'onsite'
        : null;

      // Resolve employment type: flex field "Job Type" > listing fields
      const employmentType = detail?.jobType
        || job.JobType
        || job.JobSchedule
        || detail?.workerType
        || null;

      const salary = detail?.salary || {};

      jobs.push({
        external_id: `oracle_${job.Id}`,
        title: job.Title,
        department,
        location: locations.filter(Boolean).join('; ') || null,
        workplace_type: workplaceType,
        employment_type: employmentType,
        salary_min: salary.min || null,
        salary_max: salary.max || null,
        salary_currency: salary.currency || null,
        salary_interval: salary.min ? 'yearly' : null,
        // A posting skipped for detail sends NULL, not the list's short text: NULL keeps the full
        // description stored, and a short one would overwrite it and then count as described.
        description: detail?.description || (wanted.has(job.Id) ? job.ShortDescriptionStr || null : null),
        url: buildCareersUrl(parsed, siteNumber, job.Id),
        posted_at: job.PostedDate || null,
        raw_data: job,
      });
    }
  }

  logger.info({ slug: clientname, siteNumber, fetched: jobs.length }, 'Oracle Cloud HCM fetch complete');

  return { jobs, meta: { companyName: null } };
}

module.exports = { fetchJobs, fetchTimeoutMs, wantsStoredState, PAGE_SIZE, DETAIL_MAX };
