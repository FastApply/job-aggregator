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
// `new US.Opportunity.CandidateOpportunityDetail({...})`). The teaser goes in raw_data, not
// description: the backfill only picks up rows whose description IS NULL.
//
// Text and employer (2026-10-29). The search names no employer, and neither did anything else the
// crawl stored, so every UKG row read "Unknown Company" and carried no text until
// backfill-descriptions reached it — oldest first, 40 rows a cycle, behind thousands. First Apply
// applied to 13 of 13 UKG postings that way in one window: three "Project Manager" roles asking
// 10, 8+ and 3-5 years went to an entry-level candidate, and repeat-company and blacklist checks
// could not see the employer at all. So the crawl now reads the posting page itself for the
// newest postings that have no text yet (UKG_DETAIL_MAX a crawl; the caller passes the ids it
// already holds text for, so each posting is read once), and the same page names the employer:
// its header logo's alt text ("Mid-America Overseas, Inc."). The board page does not (its header
// is drawn by script), so a board whose postings all have text already costs one page for the
// name, and only while the company row has none.
// FastApply's UKG apply adapter takes the posting URL .../OpportunityDetail?opportunityId={Id}.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0 Safari/537.36';
const PAGE = 50;
const MAX_PAGES = 100; // 5,000 postings
const MIN_GAP_MS = Number(process.env.UKG_GAP_MS || 400);
// Posting pages read per crawl for postings with no text yet, newest first. A page takes 3-25 s to
// answer (measured 2026-10-29), so this stays small: once a board's backlog is read (the crawl
// over several hours, or scripts/backfill-ukg-employers.js), only new postings cost a read.
const DETAIL_MAX = Number(process.env.UKG_DETAIL_MAX || 5);
// About half the boards' pages carry no header logo (the modern layout draws it by script), so a
// board whose page named no employer is not asked again for a day.
const NAME_MISS_TTL_MS = 24 * 60 * 60 * 1000;
const nameMissAt = new Map();
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

/**
 * The employer on a UKG page: its header logo's alt text ("Mid-America Overseas, Inc.", "Corovan
 * Corporation"). Null when the alt is not a name: a browser logo, the tenant alias, or a brand
 * placeholder several tenants share ("Default Brand", "Career Site Brand", "Ready to Join Our
 * Team?") — a placeholder would make unrelated employers one company. Same reading as FastApply's
 * match-time read (backend posting-text.util ukgEmployerName).
 */
function employerFromPage(html, tenant) {
  const logo = (/<img\b[^>]*\bdata-automation="navbar-(?:small|large)-logo"[^>]*>/i.exec(String(html || '')) || [])[0];
  const alt = logo ? (/\balt="([^"]*)"/i.exec(logo) || [])[1] : '';
  const raw = String(alt || '')
    .replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').trim();
  if (/\b(?:chrome|firefox|internet explorer|edge|safari)\s+logo\b|\b(?:default|career\s+site)\s+brand\b|\?|^ready\b|\ball companies\b/i.test(raw)) return null;
  const name = raw
    .replace(/^\s*careers?\s+at\s+/i, '')
    .replace(/(?:\s*[-|:]?\s*\b(?:logo|brand|careers?|jobs?|job board|opportunities))+\s*$/i, '')
    .trim();
  if (name.length < 2 || (tenant && name.toUpperCase() === String(tenant).toUpperCase())) return null;
  if (/^(?:unknown(?:\s+company)?|n\/?a|none|company|employer)$/i.test(name)) return null;
  return name;
}

/** One posting page: its HTML description (or null) and the employer it names (or null). */
async function fetchPosting(url) {
  const res = await request(url, { headers: { 'user-agent': UA, accept: 'text/html' } });
  const html = await res.text();
  let tenant = null;
  try { tenant = new URL(url).pathname.split('/').filter(Boolean)[0] || null; } catch { /* keep null */ }
  let description = null;
  const marker = 'new US.Opportunity.CandidateOpportunityDetail(';
  const i = html.indexOf(marker);
  if (i >= 0) {
    try {
      const { value } = parseJsonPrefix(html.slice(i + marker.length));
      description = (value && value.Description) || null;
    } catch { /* no text */ }
  }
  return { description, companyName: employerFromPage(html, tenant) };
}

/**
 * opts.describedIds: external_ids the board already holds text for (a Set or array), so only new
 *   postings are read. Without it no posting text is read (callers that know nothing keep the
 *   old, list-only crawl).
 * opts.companyName: the name the company row already has; when set, no page is read for it.
 */
async function fetchJobs(rawSlug, opts = {}) {
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
  let companyName = opts.companyName ? null : undefined; // undefined = still wanted
  let pageRead = false;
  if (opts.describedIds) {
    const described = opts.describedIds instanceof Set ? opts.describedIds : new Set(opts.describedIds);
    // The search is newest first, so these are the newest postings with no text.
    const todo = jobs.filter((j) => !described.has(j.external_id)).slice(0, DETAIL_MAX);
    for (const job of todo) {
      const page = await fetchPosting(job.url).catch(() => null);
      if (!page) continue;
      pageRead = true;
      if (page.description) job.description = page.description;
      if (companyName === undefined && page.companyName) companyName = page.companyName;
    }
  }
  const boardKey = `${ref.host}/${ref.tenant}/${ref.board}`;
  const missedRecently = Date.now() - (nameMissAt.get(boardKey) || 0) < NAME_MISS_TTL_MS;
  if (companyName === undefined && jobs.length && !pageRead && !missedRecently) {
    const page = await fetchPosting(jobs[0].url).catch(() => null);
    if (page) pageRead = true;
    companyName = (page && page.companyName) || undefined;
  }
  if (!opts.companyName) {
    if (companyName) nameMissAt.delete(boardKey);
    else if (pageRead) nameMissAt.set(boardKey, Date.now());
  }
  return { jobs, meta: { companyName: companyName || null, capped } };
}

/** The posting's full HTML description from its own page, or null. */
async function fetchDescription(url) {
  const { description } = await fetchPosting(url);
  return description;
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

// crawl-companies-local passes the stored state fetchJobs reads (opts above).
const wantsStoredState = true;

module.exports = {
  fetchJobs, fetchDescription, fetchPosting, employerFromPage, toJob, locationOf, parseSlug, parseJsonPrefix,
  fetchTimeoutMs, wantsStoredState,
};
