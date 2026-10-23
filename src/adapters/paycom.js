// Paycom adapter — career pages at www.paycomonline.net/v4/ats/web.php/portal/{key}/career-page.
// slug = the employer's 32-hex portal key.
//
// The career page embeds a session JWT (configsFromHost.sessionJWT, good for two hours) and the API
// host (libConfig.atsPortalMantleServiceUrl). With that JWT as the Authorization header:
//   POST {api}/api/ats/job-posting-previews/search {skip, take, filtersForQuery}
//     -> {jobPostingPreviews[], jobPostingPreviewsCount}: id, title, locations, a cut description
//   GET  {api}/api/ats/job-postings/{id} -> {jobPosting}: full description and qualifications,
//     salaryRange ("$17.00 - $20.00 Hourly"), positionType, remoteType, googleJobJson (datePosted)
//   GET  {api}/api/ats/company-name -> {companyName}
// Unknown key -> the career page answers 200 with "Job board does not exist or is unavailable at this
// time." and no JWT. Locations read "{site name} - {city, ST zip}". Closed job = gone from the search.
// Checked 2026-10-23.
const BASE = 'https://www.paycomonline.net/v4/ats/web.php/portal';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0 Safari/537.36';
const PAGE_SIZE = 500;
const MAX_JOBS = 3000;
const DETAIL_CONCURRENCY = 4;
// One detail request per job: a 3,000-job board needs more than the crawler's default minute.
const fetchTimeoutMs = 20 * 60 * 1000;
const EMPTY_FILTERS = {
  distanceFrom: 0, workEnvironments: [], positionTypes: [], educationLevels: [], categories: [], travelTypes: [],
  shiftTypes: [], otherFilters: [], keywordSearchText: '', location: '', sortOption: '',
};

function keyOf(slug) {
  const k = String(slug || '').trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(k)) throw new Error(`Paycom HTTP 404 (not found): bad portal key "${slug}"`);
  return k;
}

async function call(url, opts = {}) {
  let res;
  try {
    res = await fetch(url, { ...opts, headers: { 'user-agent': UA, ...(opts.headers || {}) }, signal: AbortSignal.timeout(30000) });
  } catch (e) {
    throw new Error(`Paycom network error (retry): ${e.message}`);
  }
  if (res.status === 404) throw new Error('Paycom HTTP 404 (not found)');
  if (!res.ok) throw new Error(`Paycom HTTP ${res.status} (retry)`);
  return res;
}

/** The career page's session JWT and API host. */
async function session(key) {
  const html = await (await call(`${BASE}/${key}/career-page`)).text();
  const jwt = (html.match(/"sessionJWT":"([^"]+)"/) || [])[1];
  if (!jwt && /does not exist or is unavailable/i.test(html)) throw new Error('Paycom HTTP 404 (not found)');
  if (!jwt) throw new Error('Paycom no session on the career page (retry)');
  const host = (html.match(/atsPortalMantleServiceUrl\\*":\\*"(https:[^"\\]*(?:\\+\/[^"\\]*)*)/) || [])[1];
  const api = host ? host.replace(/\\/g, '').replace(/\/$/, '') : 'https://portal-applicant-tracking.us-cent.paycomonline.net';
  return { jwt, api };
}

async function api(s, path, body) {
  const opts = { headers: { authorization: s.jwt, accept: 'application/json' } };
  if (body) Object.assign(opts, { method: 'POST', body: JSON.stringify(body) }, { headers: { ...opts.headers, 'content-type': 'application/json' } });
  return (await call(`${s.api}/api/ats/${path}`, opts)).json();
}

/** "$17.00 - $20.00 Hourly" / "$65,000.00 Salary" -> min, max, currency, interval. */
function parseSalary(s) {
  const empty = { salary_min: null, salary_max: null, salary_currency: null, salary_interval: null };
  if (!s || typeof s !== 'string') return empty;
  const nums = (s.match(/\d[\d,]*(?:\.\d+)?/g) || []).map((n) => Number(n.replace(/,/g, ''))).filter((n) => n > 0);
  if (!nums.length) return empty;
  return {
    salary_min: nums[0], salary_max: nums.length > 1 ? nums[1] : null,
    salary_currency: /\$/.test(s) ? 'USD' : /€/.test(s) ? 'EUR' : /£/.test(s) ? 'GBP' : null,
    salary_interval: /hour/i.test(s) ? 'hour' : /salary|year|annual/i.test(s) ? 'year' : /month/i.test(s) ? 'month' : /week/i.test(s) ? 'week' : null,
  };
}

/** "Las Vegas - Las Vegas, NV 89115" -> "Las Vegas, NV 89115": the site label adds nothing to the place. */
function placeOf(s) {
  const t = String(s || '').trim();
  const m = t.match(/^.+? - ([^-]+,\s*[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?)$/);
  return m ? m[1].trim() : t || null;
}

function datePosted(d) {
  try {
    const v = JSON.parse(d.googleJobJson || '{}').datePosted;
    return v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null;
  } catch {
    return null;
  }
}

function toJob(p, d, key) {
  d = d || {};
  const remote = String(d.remoteType || p.remoteType || '');
  const description = [d.description, d.qualifications && `<h3>${d.qualificationsTitle || 'Qualifications'}</h3>${d.qualifications}`]
    .filter(Boolean).join('\n') || p.description || null;
  return {
    external_id: `paycom_${p.jobId}`,
    title: String(p.jobTitle || d.jobTitle || '').trim(),
    department: d.jobCategory || null,
    location: [...new Set([d.location || p.locations, ...(d.secondaryLocations || [])].map(placeOf).filter(Boolean))].slice(0, 5).join(' / ') || null,
    workplace_type: /remote/i.test(remote) ? 'remote' : /hybrid/i.test(remote) ? 'hybrid' : null,
    employment_type: d.positionType || p.positionType || null,
    ...parseSalary(d.salaryRange),
    description,
    url: `${BASE}/${key}/jobs/${p.jobId}`,
    posted_at: datePosted(d),
    raw_data: { id: p.jobId, client_code: d.clientCode || null, shift: d.jobShift || null, travel: d.travelPercentage || null, hot: !!p.isHotJob, quick_apply: d.isQuickApply ?? null },
  };
}

async function fetchJobs(slug) {
  const key = keyOf(slug);
  const s = await session(key);
  const previews = [];
  let total = 0;
  for (let skip = 0; skip < MAX_JOBS; skip += PAGE_SIZE) {
    const d = await api(s, 'job-posting-previews/search', { skip, take: PAGE_SIZE, filtersForQuery: EMPTY_FILTERS });
    const batch = d.jobPostingPreviews || [];
    previews.push(...batch);
    total = d.jobPostingPreviewsCount || 0;
    if (!batch.length || previews.length >= total) break;
  }
  const seen = new Set();
  const list = previews.filter((p) => p.jobId && !seen.has(p.jobId) && seen.add(p.jobId)).slice(0, MAX_JOBS);
  // A detail that fails keeps the list row: the job is still open, only its long fields are missing.
  const jobs = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, async () => {
    while (next < list.length) {
      const i = next++;
      let d = null;
      try { d = (await api(s, `job-postings/${list[i].jobId}`)).jobPosting; } catch { /* keep the preview */ }
      jobs[i] = toJob(list[i], d, key);
    }
  }));
  let companyName = null;
  try { companyName = (await api(s, 'company-name')).companyName || null; } catch { /* name is optional */ }
  return { jobs, meta: { companyName, logoUrl: `https://www.paycomonline.net/v4/ats/web.php/portal-customization/logo?clientkey=${key}`, capped: total > list.length } };
}

module.exports = { fetchJobs, toJob, parseSalary, placeOf, keyOf, fetchTimeoutMs };
