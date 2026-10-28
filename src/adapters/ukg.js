// UKG Pro Recruiting (formerly UltiPro Recruiting) adapter — job boards at
// https://{host}/{TENANT}/JobBoard/{boardGuid}/ on recruiting.ultipro.com, recruiting2.ultipro.com,
// recruiting.ultipro.ca and {company}.rec.pro.ukg.net. slug = "{host}/{TENANT}/{boardGuid}".
//
// The board page's own JSON search, no key or session:
//   POST /{TENANT}/JobBoard/{guid}/JobBoardView/LoadSearchResults
//        {"opportunitySearch":{"Top":50,"Skip":N,"QueryString":"","OrderBy":[...],"Filters":[]}}
//     -> {opportunities[], totalCount}; each with Id, Title, RequisitionNumber, FullTime,
//        JobCategoryName, PostedDate, BriefDescription (a ~250-char teaser), Locations[] and
//        JobLocationType: null unset, 0 hybrid, 1 on-site, 2 remote (read off 747 postings on 40
//        boards, 2026-10-29; the board labels a 0 posting "Hybrid").
// Unknown tenant or board -> 404 HTML. Closed posting = gone from the search.
// The full description is only on each posting's own page (~100KB, the posting as JSON inside
// `new US.Opportunity.CandidateOpportunityDetail({...})`), so the crawl stores no description and
// backfill-descriptions fills it through fetchDescription. The teaser goes in raw_data, not
// description: the backfill only picks up rows whose description IS NULL.
// FastApply's UKG apply adapter takes the posting URL .../OpportunityDetail?opportunityId={Id}.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0 Safari/537.36';
const PAGE = 50;
const MAX_PAGES = 100; // 5,000 postings
const MIN_GAP_MS = Number(process.env.UKG_GAP_MS || 400);
const HOST_RE = /^(?:recruiting2?\.ultipro\.(?:com|ca)|[a-z0-9-]+\.rec\.pro\.ukg\.net)$/i;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One queue for the process: every board shares a handful of UKG hosts.
let nextAt = 0;
async function turn() {
  const now = Date.now();
  const at = Math.max(now, nextAt);
  nextAt = at + MIN_GAP_MS;
  if (at > now) await sleep(at - now);
}

/** "recruiting.ultipro.com/OHI1003/38c0cbd7-..." -> { host, tenant, board }. */
function parseSlug(slug) {
  const [host, tenant, board] = String(slug || '').trim().replace(/^https?:\/\//i, '').split('/');
  if (!HOST_RE.test(host || '') || !/^[A-Za-z0-9]{2,20}$/.test(tenant || '') || !GUID_RE.test(board || '')) {
    throw new Error(`UKG HTTP 404 (not found): bad slug "${slug}"`);
  }
  return { host: host.toLowerCase(), tenant, board: board.toLowerCase() };
}

const boardUrl = ({ host, tenant, board }) => `https://${host}/${tenant}/JobBoard/${board}`;

async function request(url, init) {
  for (let attempt = 1; ; attempt++) {
    await turn();
    let res;
    try {
      res = await fetch(url, { ...init, redirect: 'follow', signal: AbortSignal.timeout(30000) });
    } catch (e) {
      throw new Error(`UKG network error (retry): ${e.message}`);
    }
    if (res.status === 404) throw new Error('UKG HTTP 404 (not found)');
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await sleep(5000 * attempt); continue; }
    if (!res.ok) throw new Error(`UKG HTTP ${res.status} (retry)`);
    return res;
  }
}

function locationOf(o) {
  const parts = [];
  for (const l of o.Locations || []) {
    const a = l.Address || {};
    const place = [a.City, a.State && (a.State.Code || a.State.Name), a.Country && (a.Country.Code || a.Country.Name)]
      .map((x) => String(x || '').trim()).filter(Boolean).join(', ');
    const name = place || String(l.LocalizedName || l.LocalizedDescription || '').trim();
    if (name && !parts.includes(name)) parts.push(name);
  }
  return parts.length ? parts.join(' / ') : null;
}

const WORKPLACE = { 0: 'hybrid', 1: 'onsite', 2: 'remote' };

function toJob(o, ref) {
  return {
    external_id: `ukg_${String(o.Id).toLowerCase()}`,
    title: String(o.Title || '').trim(),
    department: o.JobCategoryName ? String(o.JobCategoryName).trim() : null,
    location: locationOf(o),
    workplace_type: WORKPLACE[o.JobLocationType] || null,
    employment_type: o.FullTime === true ? 'Full-time' : o.FullTime === false ? 'Part-time' : null,
    salary_min: null,
    salary_max: null,
    salary_currency: null,
    salary_interval: null,
    description: null,
    url: `${boardUrl(ref)}/OpportunityDetail?opportunityId=${o.Id}`,
    posted_at: o.PostedDate || null,
    raw_data: { id: o.Id, requisition: o.RequisitionNumber || null, tenant: ref.tenant, board: ref.board, host: ref.host, teaser: o.BriefDescription || null },
  };
}

async function fetchJobs(rawSlug) {
  const ref = parseSlug(rawSlug);
  const url = `${boardUrl(ref)}/JobBoardView/LoadSearchResults`;
  const rows = [];
  let capped = false;
  for (let page = 0; ; page++) {
    const res = await request(url, {
      method: 'POST',
      headers: { 'user-agent': UA, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ opportunitySearch: {
        Top: PAGE, Skip: page * PAGE, QueryString: '',
        OrderBy: [{ Value: 'postedDateDesc', PropertyName: 'PostedDate', Ascending: false }], Filters: [],
      } }),
    });
    const d = await res.json();
    const got = d.opportunities || [];
    rows.push(...got);
    if (got.length < PAGE || rows.length >= (d.totalCount || 0)) break;
    if (page + 1 >= MAX_PAGES) { capped = true; break; }
  }
  const seen = new Set();
  const jobs = [];
  for (const o of rows) {
    if (!o.Id || seen.has(o.Id)) continue;
    seen.add(o.Id);
    jobs.push(toJob(o, ref));
  }
  return { jobs, meta: { capped } };
}

/** The posting's full HTML description from its own page, or null. */
async function fetchDescription(url) {
  const res = await request(url, { headers: { 'user-agent': UA, accept: 'text/html' } });
  const html = await res.text();
  const marker = 'new US.Opportunity.CandidateOpportunityDetail(';
  const i = html.indexOf(marker);
  if (i < 0) return null;
  try {
    const { value } = parseJsonPrefix(html.slice(i + marker.length));
    return (value && value.Description) || null;
  } catch {
    return null;
  }
}

// The posting JSON is followed by `);` and more script, so read exactly one JSON value.
function parseJsonPrefix(text) {
  let depth = 0;
  let inStr = false;
  for (let k = 0; k < text.length; k++) {
    const ch = text[k];
    if (inStr) {
      if (ch === '\\') k++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return { value: JSON.parse(text.slice(0, k + 1)), end: k + 1 };
  }
  throw new Error('unterminated JSON');
}

const fetchTimeoutMs = 15 * 60 * 1000;

module.exports = { fetchJobs, fetchDescription, toJob, locationOf, parseSlug, parseJsonPrefix, fetchTimeoutMs };
