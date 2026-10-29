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
// its header logo, its board name or its own text (employerFromPage). The board page does not (its
// header is drawn by script), so a board whose postings all have text already costs one page for
// the name, and only while the company row has none.
// FastApply's UKG apply adapter takes the posting URL .../OpportunityDetail?opportunityId={Id}.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0 Safari/537.36';
const PAGE = 50;
const MAX_PAGES = 100; // 5,000 postings
const MIN_GAP_MS = Number(process.env.UKG_GAP_MS || 400);
// Posting pages read per crawl for postings with no text yet, newest first. A page takes 3-25 s to
// answer (measured 2026-10-29), so this stays small: once a board's backlog is read (the crawl
// over several hours, or scripts/backfill-ukg-employers.js), only new postings cost a read.
const DETAIL_MAX = Number(process.env.UKG_DETAIL_MAX || 5);
// A board whose page named no employer (6 of 194 read on 2026-10-29) is not asked again for a day.
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

const decodeEntities = (v) => String(v || '')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&').replace(/&apos;|&rsquo;|&lsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"')
  .replace(/&nbsp;/g, ' ').replace(/&ndash;/g, '–').replace(/&mdash;/g, '—');

// A whole value that names no employer: a brand placeholder, a browser logo, or a board's generic
// title once its "careers"/"jobs" words are gone.
const NOT_A_NAME = /\b(?:chrome|firefox|internet explorer|edge|safari)\s+logo\b|\b(?:default|career\s+site)\s+brand\b|\?|^ready\b|\ball companies\b/i;
const GENERIC = /^(?:unknown(?:\s+company)?|n\/?a|none|company|employer|our company|external|internal|main|home|default|english|en|us|usa|all|global|candidate|candidates|applicant|search|portal|recruiting|recruitment|talent|hiring|team|the team|join us|join our team|work with us|current|open|now hiring)$/i;
// Words a board title adds to the employer's name. Only ones that never end a real name on their
// own: "Home" ("Pinnacle Home") or "US" ("Bayer US") would, so those go only in brackets.
const BOARD_WORDS = '(?:logo(?:\\s+(?:19|20)\\d\\d)?|brand|careers?|career\\s+(?:site|portal|center|centre|page|opportunities)|jobs?|job\\s+(?:board|openings?|opportunities|postings?|search|site|page)|opportunities|openings|current\\s+openings|employment(?:\\s+opportunities)?|positions|postings|vacancies|external|internal|\\((?:\\s*(?:us|usa|en|external|internal|english)\\s*)\\))';
const TRAILING_BOARD_WORDS = new RegExp(`(?:\\s*[-|:–,]*\\s*(?:\\b)?${BOARD_WORDS}(?:\\b|(?<=\\)))?)+\\s*$`, 'i');
const LEADING_BOARD_WORDS = /^\s*(?:(?:careers?|jobs?|opportunities|employment|work)\s+(?:at|with|for)|join(?:\s+(?:the|our))?(?:\s+team)?(?:\s+at)?|welcome\s+to)\s+/i;

/** A candidate name from the page, tidied, or null when what is left names nobody. */
function asEmployer(value, tenant) {
  const raw = decodeEntities(value).replace(/\s+/g, ' ').trim();
  if (!raw || NOT_A_NAME.test(raw) || /_|\.(?:png|jpe?g|gif|svg)\b/i.test(raw)) return null;
  const name = raw.replace(LEADING_BOARD_WORDS, '').replace(TRAILING_BOARD_WORDS, '').replace(/[\s\-|:,]+$/, '').trim();
  if (name.length < 2 || !/[a-z]/i.test(name)) return null;
  if (tenant && name.replace(/\s+/g, '').toUpperCase() === String(tenant).toUpperCase()) return null;
  if (GENERIC.test(name)) return null;
  return name;
}

/**
 * The employer as the posting's own text names it, or null — the last resort, for a board with no
 * header logo and only a generic title ("Opportunities", "Careers"). UKG tenant aliases are built
 * from the employer's name: its first three letters, then a number (HAS1004HMIC: Hastings
 * Insurance; CHE1027CFMC: Checkered Flag Automotive Group; STR1026STRME: Structure Medical). So a
 * capitalised name in the text counts only when it starts with those three letters, AND it either
 * sits where a posting introduces its employer ("Hastings Insurance is seeking", "At X,", "Join
 * X", "...companies—Concord Hospitality Enterprises") or runs to two words or more.
 */
const NAME_WORD = "[A-Z][A-Za-z0-9&'’-]*";
const CAPITALISED_NAME = new RegExp(`${NAME_WORD}(?:\\s+(?:${NAME_WORD}|&|of|and|the|de|for))*`, 'g');
const INTRO_AFTER = /^\s*(?:,\s*)?(?:is|are|has\s+been|has|was)\s+(?:seeking|hiring|looking|searching|currently|now|a|an|the|one|proud|committed|dedicated|excited)\b|^\s*(?:offers|provides|believes|seeks|invites)\b/;
const INTRO_BEFORE = /(?:\bat|\bjoin|—|–)\s*$/i;
function tenantPrefix(tenant) {
  return /^[A-Za-z]{3}/.test(String(tenant || '')) ? String(tenant).slice(0, 3).toUpperCase() : null;
}
function startsLikeTenant(name, tenant) {
  const prefix = tenantPrefix(tenant);
  return !!prefix && String(name).replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() === prefix;
}
function employerFromText(description, tenant) {
  if (!tenantPrefix(tenant) || !description) return null;
  const text = decodeEntities(String(description).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
  // Sentence by sentence, so a name never runs into the next sentence ("... Enterprises. As").
  for (const sentence of text.split(/(?<=[.!?;:])\s+/)) {
    for (const m of sentence.matchAll(CAPITALISED_NAME)) {
      // A run of capitalised words can carry a heading in front of the name ("... Out-of-State
      // Candidates Structure Medical is seeking"): take the tail that starts like the tenant.
      const words = m[0].split(/\s+/);
      const end = m.index + m[0].length;
      const before = sentence.slice(Math.max(0, m.index - 8), m.index);
      let found = null;
      for (let at = 0; at < words.length && !found; at++) {
        if (!/^[A-Z]/.test(words[at]) || !startsLikeTenant(words.slice(at).join(' '), tenant)) continue;
        const name = words.slice(at).join(' ').replace(/['’]s$/i, '').replace(/(?:\s+(?:&|of|and|the|de|for))+$/i, '').replace(/[.,'’-]+$/, '').trim();
        // A run of headings ("Melaleuca Award Winning Culture Flexibility") is not a name; the text
        // introduces the employer again ("... Benefits At Melaleuca, our mission").
        if (name.length > 60 || name.split(/\s+/).length > 5) continue;
        const intro = INTRO_AFTER.test(sentence.slice(end, end + 40)) ||
          (at === 0 ? INTRO_BEFORE.test(before) : /^(?:at|join)$/i.test(words[at - 1]));
        if (intro) found = name;
      }
      if (!found) continue;
      const name = found;
      const ok = asEmployer(name, tenant);
      if (ok) return ok;
    }
  }
  return null;
}

/**
 * The employer on a UKG posting page, or null. Two layouts:
 *  - classic: the header logo's alt text ("Mid-America Overseas, Inc.", "Corovan Corporation");
 *  - modern: some boards' header is drawn by script and carries no
 *    text, but the page's title script names the board: `var params = {"opportunityTitle":...,
 *    "jobBoardName":"UNITED ALLOY INC."}` (the browser title reads "Welder (MIG) - 1st Shift |
 *    UNITED ALLOY INC."). A board name is often the employer plus "Careers" ("Corovan Careers")
 *    or only a generic title ("Opportunities"); the words are dropped and a generic title is
 *    not a name.
 * Placeholders shared by many tenants ("Default Brand", "Career Site Brand", "Ready to Join Our
 * Team?"), browser logos and the tenant alias are never names: a placeholder would make unrelated
 * employers one company. A name that starts like the tenant alias (its first three letters are the
 * employer's: COR1031CORC, Corovan) goes first; a logo can carry a slogan ("Unlimited Potential").
 * Then the posting text's own introduction of the employer, then any logo or board name.
 */
function employerFromPage(html, tenant) {
  const page = String(html || '');
  const logo = (/<img\b[^>]*\bdata-automation="navbar-(?:small|large)-logo"[^>]*>/i.exec(page) || [])[0];
  const alt = logo ? (/\balt="([^"]*)"/i.exec(logo) || [])[1] : '';
  let fromLogo = asEmployer(alt, tenant);
  // "<something> Brand" is how a tenant labels one of its brand themes: "Surgery Partners Brand"
  // names the employer (SUR1004SRGY), "Maryland Brand" (CHI1001CHIM) names a region.
  if (fromLogo && /\bbrand\s*$/i.test(decodeEntities(alt).trim()) && !startsLikeTenant(fromLogo, tenant)) fromLogo = null;
  const board = /"jobBoardName"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(page);
  let fromBoard = null;
  if (board) {
    try { fromBoard = asEmployer(JSON.parse(board[1]), tenant); } catch { fromBoard = null; }
  }
  // A name that starts like the tenant alias is the employer's; a logo can carry a slogan
  // ("Unlimited Potential" on BUN1000BUNZL, where the text names Bunzl) or a brand of the group.
  if (fromLogo && startsLikeTenant(fromLogo, tenant)) return fromLogo;
  if (fromBoard && startsLikeTenant(fromBoard, tenant)) return fromBoard;
  let fromText = null;
  const marker = page.indexOf('new US.Opportunity.CandidateOpportunityDetail(');
  if (marker >= 0) {
    try {
      const { value } = parseJsonPrefix(page.slice(marker + 'new US.Opportunity.CandidateOpportunityDetail('.length));
      fromText = employerFromText(value && value.Description, tenant);
    } catch { fromText = null; }
  }
  return fromText || fromLogo || fromBoard || null;
}

/**
 * The page's text, as much of it as arrived. UKG sometimes sends the whole page and then holds the
 * connection open until the request times out (measured 2026-10-29); `res.text()` then throws and
 * the page is lost, although everything this adapter reads (the posting JSON, then the board name
 * near the end) had already arrived. Stops at </html>.
 */
async function readPage(res) {
  if (!res.body || typeof res.body.getReader !== 'function') return res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let html = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (html.includes('</html>')) { reader.cancel().catch(() => {}); break; }
    }
  } catch {
    // Timed out mid-body: keep what arrived.
  }
  return html;
}

/** One posting page: its HTML description (or null) and the employer it names (or null). */
async function fetchPosting(url) {
  const res = await request(url, { headers: { 'user-agent': UA, accept: 'text/html' } });
  const html = await readPage(res);
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
  fetchJobs, fetchDescription, fetchPosting, employerFromPage, employerFromText, toJob, locationOf, parseSlug, parseJsonPrefix,
  fetchTimeoutMs, wantsStoredState,
};
