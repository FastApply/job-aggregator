// ADP Workforce Now Recruitment adapter — career centers at
// https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid={client uuid}.
// slug = the cid. A different ADP product from myjobs.adp.com (see adp.js): own API, own apply flow.
//
// The career center's own public API, no key or session:
//   GET https://workforcenow.adp.com/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions
//       ?cid={cid}&lang=en_US&locale=en_US&$top=N&$skip=N
//     -> {meta.totalNumber, jobRequisitions[]}: itemID, requisitionTitle, requisitionLocations[],
//        workLevelCode.shortName, postDate, customFieldGroup.stringFields[ExternalJobID]. No description.
//   GET .../job-requisitions/{itemID}?cid={cid}&lang=en_US -> the same plus requisitionDescription (HTML).
// Unknown cid -> 404 from openresty ("<title>404 Not Found</title>"), every time.
// A known cid can ALSO answer 404, with the body "default backend - 404": the front end routes
// some requests to a cluster that does not host that client (probed 2026-10-31: four retired cids
// flapped 200/404 about half the time, three steady ones never did, a made-up cid never got 200).
// Treating that as "board gone" retired 544 live career centers, so it is retried and, if it
// persists, reported as passing. An unknown itemID answers 200 with no requisitionDescription.
// The posting URL carries jobId={ExternalJobID}, which is what FastApply's
// Workforce Now apply adapter reads (verified there against Infinite Campus and ORBCOMM, 2026-10-28).
// Descriptions are filled by backfill-descriptions through fetchDescription (one request a posting).
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0 Safari/537.36';
const API = 'https://workforcenow.adp.com/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions';
const PAGE_URL = 'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html';
const PAGE = 50;
const MAX_PAGES = 100;
const MIN_GAP_MS = Number(process.env.ADP_WFN_GAP_MS || 500);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A misrouted request lands on a good cluster about half the time, so 8 tries miss ~1 in 250.
const MISROUTE_TRIES = 8;
const isMisrouted = (body) => /default backend/i.test(body || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let nextAt = 0;
async function turn() {
  const now = Date.now();
  const at = Math.max(now, nextAt);
  nextAt = at + MIN_GAP_MS;
  if (at > now) await sleep(at - now);
}

function cidOf(slug) {
  const s = String(slug || '').trim().toLowerCase();
  if (!UUID_RE.test(s)) throw new Error(`ADP Workforce Now HTTP 404 (not found): bad cid "${slug}"`);
  return s;
}

async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    await turn();
    let res;
    try {
      res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json', 'accept-language': 'en-US' }, signal: AbortSignal.timeout(30000) });
    } catch (e) {
      throw new Error(`ADP Workforce Now network error (retry): ${e.message}`);
    }
    if (res.status === 404) {
      const body = await res.text().catch(() => '');
      if (!isMisrouted(body)) throw new Error('ADP Workforce Now HTTP 404 (not found)');
      if (attempt < MISROUTE_TRIES) { await sleep(1000 + Math.random() * 1000); continue; }
      throw new Error(`ADP Workforce Now misrouted ${MISROUTE_TRIES} times in a row (retry)`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await sleep(5000 * attempt); continue; }
    if (!res.ok) throw new Error(`ADP Workforce Now HTTP ${res.status} (retry)`);
    return res.json();
  }
}

const field = (r, name) => {
  const f = ((r.customFieldGroup || {}).stringFields || []).find((x) => x.nameCode && x.nameCode.codeValue === name);
  return f && f.stringValue ? String(f.stringValue).trim() : null;
};

function locationOf(r) {
  const parts = [];
  for (const l of r.requisitionLocations || []) {
    const a = l.address || {};
    const region = a.countrySubdivisionLevel1 && a.countrySubdivisionLevel1.codeValue;
    const country = a.country && (a.country.codeValue || a.country.longName);
    const place = [a.cityName, region, country].map((x) => String(x || '').trim()).filter(Boolean).join(', ');
    const name = String((l.nameCode && l.nameCode.shortName) || '').trim() || place;
    if (name && !parts.includes(name)) parts.push(name);
  }
  return parts.length ? parts.join(' / ') : null;
}

function jobUrl(cid, jobId) {
  return `${PAGE_URL}?cid=${cid}&jobId=${encodeURIComponent(jobId)}&lang=en_US`;
}

function toJob(r, cid) {
  const jobId = field(r, 'ExternalJobID') || r.itemID;
  const location = locationOf(r);
  return {
    external_id: `adpwfn_${cid}_${r.itemID}`,
    title: String(r.requisitionTitle || '').trim(),
    department: null,
    location,
    workplace_type: /\bremote\b/i.test(`${r.requisitionTitle || ''} ${location || ''}`) ? 'remote' : null,
    employment_type: (r.workLevelCode && r.workLevelCode.shortName) || null,
    salary_min: null,
    salary_max: null,
    salary_currency: null,
    salary_interval: null,
    description: r.requisitionDescription || null,
    url: jobUrl(cid, jobId),
    posted_at: r.postDate || null,
    raw_data: { cid, itemID: r.itemID, jobId, clientRequisitionID: r.clientRequisitionID || null },
  };
}

async function fetchJobs(rawSlug) {
  const cid = cidOf(rawSlug);
  const rows = [];
  let capped = false;
  for (let page = 0; ; page++) {
    const d = await getJson(`${API}?cid=${cid}&lang=en_US&locale=en_US&$top=${PAGE}&$skip=${page * PAGE}`);
    const got = d.jobRequisitions || [];
    rows.push(...got);
    const total = (d.meta && d.meta.totalNumber) || 0;
    if (got.length < PAGE || rows.length >= total) break;
    if (page + 1 >= MAX_PAGES) { capped = true; break; }
  }
  const seen = new Set();
  const jobs = [];
  for (const r of rows) {
    if (!r.itemID || seen.has(r.itemID)) continue;
    seen.add(r.itemID);
    jobs.push(toJob(r, cid));
  }
  return { jobs, meta: { capped } };
}

/**
 * The posting's HTML description from the detail endpoint, or 'SKIP' when the posting is gone
 * (200 with no itemID), carries no text, or its career center no longer exists. A passing fault throws.
 */
async function fetchDescription(url, rawData) {
  const raw = typeof rawData === 'string' ? JSON.parse(rawData) : rawData || {};
  const cid = raw.cid || (String(url).match(/[?&]cid=([0-9a-f-]{36})/i) || [])[1];
  if (!cid || !raw.itemID) return 'SKIP';
  let d;
  try {
    d = await getJson(`${API}/${encodeURIComponent(raw.itemID)}?cid=${cid}&lang=en_US&locale=en_US`);
  } catch (e) {
    if (/HTTP 404/.test(e.message)) return 'SKIP';
    throw e;
  }
  const text = String(d.requisitionDescription || '').replace(/<[^>]+>/g, '').trim();
  return text.length >= 20 ? d.requisitionDescription : 'SKIP';
}

const fetchTimeoutMs = 15 * 60 * 1000;

module.exports = { fetchJobs, fetchDescription, toJob, locationOf, cidOf, isMisrouted, fetchTimeoutMs };
