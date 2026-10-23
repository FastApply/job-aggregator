// Dayforce (Ceridian) adapter — jobs.dayforcehcm.com. slug = client namespace ("gaylor"), or
// "{namespace}/{board}" when the employer's career site is not CANDIDATEPORTAL ("sobeys/sobeysrscexternalsite").
//
// List: POST /api/geo/{ns}/jobposting/search {clientNamespace, jobBoardCode, cultureCode, paginationStart}
//   -> {jobPostings[], maxCount, offset, count}, 25 a page, each with the full HTML description, locations
//   and posting dates. The API wants the site's next-auth CSRF pair: GET /api/auth/csrf sets a cookie and
//   returns the token, sent back as X-CSRF-TOKEN; without it every POST is a 403. Unknown namespace or
//   board -> 404. The career page's embedded site info names the employer and says whether it takes
//   applications without an account (enableApplyWithoutAccount). Closed job = gone from the search; its
//   page then carries postingStatus 4 (1 = open). Checked 2026-10-23.
const BASE = 'https://jobs.dayforcehcm.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0 Safari/537.36';
const DEFAULT_BOARD = 'CANDIDATEPORTAL';
const PAGE_SIZE = 25; // fixed by the API
const MAX_PAGES = 400; // 10,000 jobs
const PAGE_DELAY_MS = 150;
const SESSION_MS = 15 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "gaylor" -> {ns: 'gaylor', board: 'CANDIDATEPORTAL'}; "sobeys/SobeysRSCExternalSite" keeps its board. */
function parseSlug(slug) {
  const m = String(slug || '').trim().match(/^([A-Za-z0-9_-]+)(?:\/([A-Za-z0-9_-]+))?$/);
  if (!m) throw new Error(`Dayforce HTTP 404 (not found): bad slug "${slug}"`);
  return { ns: m[1].toLowerCase(), board: (m[2] || DEFAULT_BOARD).toUpperCase() };
}

// One CSRF session per process, renewed when it ages out or a POST is refused.
let session = null;
async function getSession(force = false) {
  if (!force && session && Date.now() - session.at < SESSION_MS) return session;
  let res;
  try {
    res = await fetch(`${BASE}/api/auth/csrf`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30000) });
  } catch (e) {
    throw new Error(`Dayforce network error (retry): ${e.message}`);
  }
  if (!res.ok) throw new Error(`Dayforce csrf HTTP ${res.status} (retry)`);
  const { csrfToken } = await res.json();
  const cookie = (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''])
    .map((c) => c.split(';')[0]).filter(Boolean).join('; ');
  session = { token: csrfToken, cookie, at: Date.now() };
  return session;
}

async function searchPage(ns, board, start) {
  for (let attempt = 1; ; attempt++) {
    const s = await getSession(attempt > 1);
    let res;
    try {
      res = await fetch(`${BASE}/api/geo/${ns}/jobposting/search`, {
        method: 'POST',
        headers: { 'user-agent': UA, 'content-type': 'application/json', 'x-csrf-token': s.token, cookie: s.cookie,
          origin: BASE, referer: `${BASE}/en-US/${ns}/${board}` },
        body: JSON.stringify({ clientNamespace: ns, jobBoardCode: board, cultureCode: 'en-US', paginationStart: start }),
        signal: AbortSignal.timeout(45000),
      });
    } catch (e) {
      throw new Error(`Dayforce network error (retry): ${e.message}`);
    }
    if (res.status === 404) throw new Error('Dayforce HTTP 404 (not found)');
    if (res.status === 403 && attempt < 2) continue; // stale CSRF pair: renew once
    if (!res.ok) throw new Error(`Dayforce HTTP ${res.status} (retry)`);
    return res.json();
  }
}

/** Employer name and apply settings from the career page's embedded site info; null when unreadable. */
async function siteInfo(ns, board) {
  try {
    const res = await fetch(`${BASE}/en-US/${ns}/${board}`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) return null;
    const m = (await res.text()).match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    const q = JSON.parse(m[1]).props.pageProps.dehydratedState.queries.find((x) => x.queryKey[0] === 'site-info');
    return q && q.state && q.state.data;
  } catch {
    return null;
  }
}

/** "Atlanta, GA, USA" places, the remote flag when the posting has a virtual location. */
function locationOf(p) {
  const places = [...new Set((p.postingLocations || []).map((l) => (l.formattedAddress || '').trim()).filter(Boolean))];
  return places.length ? places.slice(0, 5).join(' / ') : null;
}

function toJob(p, ns, board, info) {
  return {
    external_id: `dayforce_${p.jobPostingId}`,
    title: String(p.jobTitle || '').trim(),
    department: null,
    location: locationOf(p),
    workplace_type: p.hasVirtualLocation ? 'remote' : null,
    employment_type: null,
    salary_min: null, salary_max: null, salary_currency: null, salary_interval: null,
    description: p.jobDescription || null,
    url: `${BASE}/en-US/${ns}/${board}/jobs/${p.jobPostingId}`,
    posted_at: p.postingStartTimestampUTC || null,
    raw_data: {
      id: p.jobPostingId, req_id: p.jobReqId, namespace: ns, board,
      expires_at: p.postingExpiryTimestampUTC || null, evergreen: !!p.isEvergreen,
      apply_without_account: info ? !!info.enableApplyWithoutAccount : null,
    },
  };
}

async function fetchJobs(slug) {
  const { ns, board } = parseSlug(slug);
  const postings = [];
  let total = 0; let capped = false;
  for (let page = 0; ; page++) {
    const d = await searchPage(ns, board, page * PAGE_SIZE);
    const batch = d.jobPostings || [];
    postings.push(...batch);
    total = d.maxCount || 0;
    if (!batch.length || postings.length >= total) break;
    if (page + 1 >= MAX_PAGES) { capped = true; break; }
    await sleep(PAGE_DELAY_MS);
  }
  const info = await siteInfo(ns, board);
  const seen = new Set();
  const jobs = [];
  for (const p of postings) {
    if (!p.jobPostingId || seen.has(p.jobPostingId)) continue;
    seen.add(p.jobPostingId);
    jobs.push(toJob(p, ns, board, info));
  }
  return { jobs, meta: { companyName: (info && info.candidateCorrespondenceClientName) || null, logoUrl: null, capped } };
}

module.exports = { fetchJobs, parseSlug, toJob, locationOf };
