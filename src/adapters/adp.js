// ADP Candidate Experience adapter — career sites at https://myjobs.adp.com/{tenant}/cx/job-listing.
// slug = the tenant path segment ("ruan", "pepboyscareers").
//
// The site's own public API, no account (found by tracing the page, 2026-10-28):
//   GET https://myjobs.adp.com/public/staffing/v1/career-site/{tenant}
//     -> {clientName, active, myJobsToken, settings.externalId, ...}; an unknown tenant answers
//        400 {"message":"Careersite not found"}. myJobsToken is the token the page hands every
//        visitor.
//   GET https://my.adp.com/myadp_prefix/mycareer/public/staffing/v1/job-requisitions/apply-custom-filters
//       ?$select=...&$top=N&$skip=N&$filter=   with headers rolecode: manager, myJobsToken
//     -> {count, jobRequisitions[]}: reqId, publishedJobTitle, jobDescription (HTML),
//        jobQualifications, requisitionLocations[].address, workLevelCode, postingDate.
// Two traps: the OData names must go out as a literal `$` (URLSearchParams writes `%24top`, which
// ADP ignores), and Node's fetch sends `accept-language: *`, which ADP reads as a language filter
// that matches nothing — count 0, no error. Both are set by hand below.
// FastApply's ADP apply adapter takes .../{tenant}/cx/job-details?reqId={reqId}.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0 Safari/537.36';
const SITE = 'https://myjobs.adp.com';
const API = 'https://my.adp.com/myadp_prefix/mycareer/public/staffing/v1/job-requisitions/apply-custom-filters';
const SELECT = 'reqId,jobTitle,publishedJobTitle,type,jobDescription,jobQualifications,workLocations,workLevelCode,clientRequisitionID,postingDate';
const PAGE = 50;
const MAX_PAGES = 100; // 5,000 requisitions
const MIN_GAP_MS = Number(process.env.ADP_GAP_MS || 500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let nextAt = 0;
async function turn() {
  const now = Date.now();
  const at = Math.max(now, nextAt);
  nextAt = at + MIN_GAP_MS;
  if (at > now) await sleep(at - now);
}

function slugOf(slug) {
  const s = String(slug || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(s)) throw new Error(`ADP HTTP 404 (not found): bad slug "${slug}"`);
  return s;
}

async function getJson(url, headers = {}) {
  for (let attempt = 1; ; attempt++) {
    await turn();
    let res;
    try {
      res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'application/json', 'accept-language': 'en-US', ...headers },
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      throw new Error(`ADP network error (retry): ${e.message}`);
    }
    if (res.status === 404) throw new Error('ADP HTTP 404 (not found)');
    if (res.status === 400) {
      const body = await res.text();
      if (/careersite not found/i.test(body)) throw new Error('ADP HTTP 404 (not found): career site not found');
      throw new Error(`ADP bad request (retry): ${body.slice(0, 80)}`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await sleep(5000 * attempt); continue; }
    if (!res.ok) throw new Error(`ADP HTTP ${res.status} (retry)`);
    return res.json();
  }
}

function locationOf(r) {
  const parts = [];
  for (const l of [...(r.requisitionLocations || []), ...(r.workLocations || [])]) {
    const a = l.address || {};
    const region = a.countrySubdivisionLevel1 && (a.countrySubdivisionLevel1.codeValue || a.countrySubdivisionLevel1.longName);
    const country = a.country && (a.country.codeValue || a.country.longName);
    const place = [a.cityName, region, country].map((x) => String(x || '').trim()).filter(Boolean).join(', ');
    const name = place || String((l.nameCode && l.nameCode.longName) || '').trim();
    if (name && !parts.includes(name)) parts.push(name);
  }
  return parts.length ? parts.join(' / ') : null;
}

function toJob(r, tenant) {
  const description = [r.jobDescription, r.jobQualifications].filter((x) => x && String(x).trim()).join('\n') || null;
  const location = locationOf(r);
  return {
    external_id: `adp_${tenant}_${r.reqId}`,
    title: String(r.publishedJobTitle || r.jobTitle || '').trim(),
    department: null,
    location,
    workplace_type: /\bremote\b/i.test(`${r.publishedJobTitle || ''} ${location || ''}`) ? 'remote' : null,
    employment_type: r.workLevelCode || null,
    salary_min: null,
    salary_max: null,
    salary_currency: null,
    salary_interval: null,
    description,
    url: `${SITE}/${tenant}/cx/job-details?reqId=${r.reqId}`,
    posted_at: r.postingDate || null,
    raw_data: { reqId: r.reqId, tenant, clientRequisitionID: r.clientRequisitionID || null },
  };
}

async function fetchJobs(rawSlug) {
  const tenant = slugOf(rawSlug);
  const site = await getJson(`${SITE}/public/staffing/v1/career-site/${encodeURIComponent(tenant)}`);
  if (site.active === false) throw new Error('ADP HTTP 404 (not found): career site no longer active');
  if (!site.myJobsToken) throw new Error('ADP career site gave no public token (retry)');
  const headers = { rolecode: 'manager', myJobsToken: site.myJobsToken };
  const rows = [];
  let capped = false;
  for (let page = 0; ; page++) {
    const d = await getJson(`${API}?$select=${encodeURIComponent(SELECT)}&$top=${PAGE}&$skip=${page * PAGE}&$filter=`, headers);
    const got = d.jobRequisitions || [];
    rows.push(...got);
    if (got.length < PAGE || rows.length >= (d.count || 0)) break;
    if (page + 1 >= MAX_PAGES) { capped = true; break; }
  }
  const seen = new Set();
  const jobs = [];
  for (const r of rows) {
    if (!r.reqId || seen.has(r.reqId)) continue;
    seen.add(r.reqId);
    jobs.push(toJob(r, tenant));
  }
  return { jobs, meta: { companyName: String(site.clientName || '').trim() || null, capped } };
}

const fetchTimeoutMs = 15 * 60 * 1000;

module.exports = { fetchJobs, toJob, locationOf, slugOf, fetchTimeoutMs };
