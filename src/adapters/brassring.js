// BrassRing (IBM Kenexa) adapter — career sites at sjobs.brassring.com/TGnewUI/Search/Home/Home?
// partnerid=X&siteid=Y. slug = "{partnerid}/{siteid}": "25526/5032" (Home Depot).
//
// GET  /TGnewUI/Search/Home/HomeWithPreLoad?partnerid=&siteid=&PageType=searchResults sets the session
//      cookies and embeds <input id="preLoadJSON">: TotalCount, the first 50 jobs
//      (searchResultsResponse.Jobs.Job), EncryptedSession, and JobFieldsToDisplay — which of the
//      site's questions holds the title, the place (Position3) and the summary. Plus the
//      __RequestVerificationToken the next call sends back as the RFT header.
// POST /TgNewUI/Search/Ajax/ProcessSortAndShowMoreJobs {partnerId, siteId, pageNumber,
//      encryptedSessionValue, ...} -> {Jobs: {Job[]}, JobsCount}, 50 a page. Without the session
//      value every page comes back empty.
// Each job is a list of {QuestionName, Value}: reqid, jobtitle, lastupdated ("10/23/2026",
// "22-Oct-2026"), often the full jobdescription, and site-specific formtextN fields. Closed job =
// gone from the search. An unknown partner or site answers a bare HTTP 500 — the same as a passing
// fault — so it stays a retry. Checked 2026-10-23.
const BASE = 'https://sjobs.brassring.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0 Safari/537.36';
const MAX_PAGES = 600; // 30,000 jobs
const PAGE_DELAY_MS = 400;
// Home Depot is ~24,000 jobs: 480 pages.
const fetchTimeoutMs = 30 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseSlug(slug) {
  const m = String(slug || '').trim().match(/^(\d+)\/(\d+)$/);
  if (!m) throw new Error(`BrassRing HTTP 404 (not found): bad slug "${slug}"`);
  return { partnerId: m[1], siteId: m[2] };
}

async function call(url, opts = {}) {
  let res;
  try {
    res = await fetch(url, { ...opts, headers: { 'user-agent': UA, ...(opts.headers || {}) }, signal: AbortSignal.timeout(60000) });
  } catch (e) {
    throw new Error(`BrassRing network error (retry): ${e.message}`);
  }
  if (res.status === 404) throw new Error('BrassRing HTTP 404 (not found)');
  if (!res.ok) throw new Error(`BrassRing HTTP ${res.status} (retry)`);
  return res;
}

const decode = (s) => String(s || '').replace(/&quot;/g, '"').replace(/&#39;|&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** A fresh session: cookies, RFT token, encrypted session and the preloaded first page. */
async function openSession(partnerId, siteId) {
  const res = await call(`${BASE}/TGnewUI/Search/Home/HomeWithPreLoad?partnerid=${partnerId}&siteid=${siteId}&PageType=searchResults`);
  const html = await res.text();
  const m = html.match(/id="preLoadJSON" type="hidden" value="([^"]*)"/);
  if (!m) throw new Error('BrassRing HTTP 404 (not found)');
  let pre;
  try { pre = JSON.parse(decode(m[1])); } catch { throw new Error('BrassRing unreadable preload (retry)'); }
  if (!pre.searchResultsResponse) throw new Error('BrassRing HTTP 404 (not found)');
  const cookie = (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''])
    .map((c) => c.split(';')[0]).filter(Boolean).join('; ');
  const rft = (html.match(/name="__RequestVerificationToken" type="hidden" value="([^"]+)"/) || [])[1] || '';
  return { pre, cookie, rft };
}

async function morePage(s, partnerId, siteId, pageNumber) {
  const body = {
    partnerId, siteId, keyword: '', location: '', keywordCustomSolrFields: 'JobTitle,FORMTEXT5', locationCustomSolrFields: 'FORMTEXT2',
    linkId: '', Latitude: 0, Longitude: 0, facetfilterfields: { Facet: [] }, powersearchoptions: { PowerSearchOption: [] },
    SortType: 'LastUpdated', pageNumber, encryptedSessionValue: s.pre.EncryptedSession,
  };
  const res = await call(`${BASE}/TgNewUI/Search/Ajax/ProcessSortAndShowMoreJobs`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', cookie: s.cookie, RFT: s.rft, 'x-requested-with': 'XMLHttpRequest', origin: BASE,
      referer: `${BASE}/TGnewUI/Search/Home/HomeWithPreLoad?partnerid=${partnerId}&siteid=${siteId}&PageType=searchResults` },
  });
  const d = await res.json();
  return (d.Jobs && d.Jobs.Job) || [];
}

const answers = (job) => Object.fromEntries((job.Questions || []).map((q) => [String(q.QuestionName).toLowerCase(), q.Value]));
const clean = (v) => decode(String(v || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Which questions hold title, place and summary on this site (JobFieldsToDisplay). */
function layoutOf(pre) {
  const f = pre.JobFieldsToDisplay || {};
  const list = (v) => [].concat(v || []).filter(Boolean).map((x) => String(x).toLowerCase());
  // Position3 is the place line on every site seen; Position1 is a second title or a job family.
  return { title: list(f.JobTitle)[0] || 'jobtitle', places: list(f.Position3), summary: list(f.Summary)[0] || null };
}

const NOT_PLACE = /^(reqid|autoreq|clientid|siteid|gqid|hotjob|lastupdated|jobtitle|jobdescription|department)$/;

function toJob(job, layout, partnerId, siteId) {
  const a = answers(job);
  const id = a.reqid;
  const places = a.location ? [a.location] : layout.places.filter((k) => !NOT_PLACE.test(k) && a[k]).map((k) => a[k]);
  const posted = Date.parse(a.lastupdated);
  return {
    external_id: `brassring_${id}`,
    title: clean(a[layout.title] || a.jobtitle),
    department: clean(a.department) || null,
    location: places.map(clean).filter(Boolean).join(', ') || null,
    workplace_type: null,
    employment_type: null,
    salary_min: null, salary_max: null, salary_currency: null, salary_interval: null,
    description: a.jobdescription || (layout.summary && a[layout.summary]) || null,
    url: job.Link || `${BASE}/TGnewUI/Search/home/HomeWithPreLoad?partnerid=${partnerId}&siteid=${siteId}&PageType=JobDetails&jobid=${id}`,
    posted_at: Number.isNaN(posted) ? null : new Date(posted).toISOString(),
    raw_data: { id, partner_id: partnerId, site_id: siteId, auto_req: a.autoreq || null, lat: Number(a.latitude) || null, lng: Number(a.longitude) || null },
  };
}

async function fetchJobs(slug) {
  const { partnerId, siteId } = parseSlug(slug);
  let s = await openSession(partnerId, siteId);
  const layout = layoutOf(s.pre);
  const total = Number(s.pre.TotalCount) || 0;
  const raw = [...((s.pre.searchResultsResponse.Jobs && s.pre.searchResultsResponse.Jobs.Job) || [])];
  let capped = false;
  for (let page = 2; raw.length < total; page++) {
    if (page > MAX_PAGES) { capped = true; break; }
    await sleep(PAGE_DELAY_MS);
    let batch = await morePage(s, partnerId, siteId, page);
    if (!batch.length) { // the session may have lapsed on a long walk: open a new one and ask again
      s = await openSession(partnerId, siteId);
      batch = await morePage(s, partnerId, siteId, page);
      if (!batch.length) { capped = raw.length < total; break; }
    }
    raw.push(...batch);
  }
  const seen = new Set();
  const jobs = [];
  for (const j of raw) {
    const job = toJob(j, layout, partnerId, siteId);
    if (!job.raw_data.id || !job.title || seen.has(job.external_id)) continue;
    seen.add(job.external_id);
    jobs.push(job);
  }
  // No reliable employer name in the payload: HeaderInfo holds menu links ("Find a Position").
  return { jobs, meta: { companyName: null, logoUrl: null, capped } };
}

module.exports = { fetchJobs, parseSlug, toJob, layoutOf, fetchTimeoutMs };
