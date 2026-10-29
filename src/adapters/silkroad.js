// SilkRoad Recruiting adapter — job boards at https://jobs.silkroad.com/{Company}/{Board}.
// slug = "{Company}/{Board}" ("SpecCorp/Careers"); paths are case-insensitive, links come back in
// the employer's own casing.
//
// No JSON API: the board is server-rendered HTML, one panel a posting —
//   <h2 id="Jobs_PagedJobList_Category__N">{department}</h2>
//   <a id="Jobs_PagedJobList_Job-{id}" class="sr-panel" href="/{Company}/{Board}/jobs/{id}">
//     <div class="sr-panel__title">{title}</div> <span class="sr-panel__meta">{location}</span>
// paged by ?page=N ("Page 1 of 7"; the next button carries data-href while there is a next page).
// Unknown company or board -> 302 to /ErrorHandler/NotFound. Each posting page carries a
// schema.org JobPosting (JSON-LD) with the full description, read by fetchDescription from
// backfill-descriptions. FastApply's SilkRoad apply adapter takes the posting URL as is.
const { decodeEntities } = require('./html-entities');

const BASE = 'https://jobs.silkroad.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0 Safari/537.36';
const MAX_PAGES = 100;
const MIN_GAP_MS = Number(process.env.SILKROAD_GAP_MS || 700);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let nextAt = 0;
async function turn() {
  const now = Date.now();
  const at = Math.max(now, nextAt);
  nextAt = at + MIN_GAP_MS;
  if (at > now) await sleep(at - now);
}

function parseSlug(slug) {
  const [company, board, extra] = String(slug || '').trim().replace(/^\/+|\/+$/g, '').split('/');
  const ok = (s) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(s || '');
  if (!ok(company) || !ok(board) || extra) throw new Error(`SilkRoad HTTP 404 (not found): bad slug "${slug}"`);
  return { company, board };
}

async function getHtml(url) {
  for (let attempt = 1; ; attempt++) {
    await turn();
    let res;
    try {
      res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    } catch (e) {
      throw new Error(`SilkRoad network error (retry): ${e.message}`);
    }
    if (res.status >= 300 && res.status < 400) {
      const to = res.headers.get('location') || '';
      if (/notfound|error/i.test(to)) throw new Error('SilkRoad HTTP 404 (not found)');
      url = new URL(to, url).href; // a casing or trailing-slash redirect
      continue;
    }
    if (res.status === 404) throw new Error('SilkRoad HTTP 404 (not found)');
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await sleep(5000 * attempt); continue; }
    if (!res.ok) throw new Error(`SilkRoad HTTP ${res.status} (retry)`);
    return res.text();
  }
}

const text = (html) => decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Postings on one board page, each with the department heading it sits under. */
function parsePage(html) {
  const out = [];
  const re = /<h2 id="Jobs_PagedJobList_Category__[^"]*"[^>]*>([\s\S]*?)<\/h2>|<a id="Jobs_PagedJobList_Job-(\d+)"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let department = null;
  let m;
  while ((m = re.exec(html))) {
    if (m[1] !== undefined) { department = text(m[1]) || null; continue; }
    const body = m[4];
    const title = text((body.match(/class="sr-panel__title"[^>]*>([\s\S]*?)<\/div>/) || [])[1]);
    const location = text((body.match(/class="sr-panel__location"[^>]*>([\s\S]*?)<\/div>/) || [])[1]) || null;
    if (title) out.push({ id: m[2], href: decodeEntities(m[3]), title, location, department });
  }
  return out;
}

const hasNextPage = (html) => /id="Jobs_PagedJobList_NextLink"[^>]*data-href="[^"]+"/.test(html)
  && !/id="Jobs_PagedJobList_NextLink"[^>]*disabled/.test(html);

function toJob(p, { company, board }) {
  const url = new URL(p.href, BASE).href;
  return {
    external_id: `silkroad_${company.toLowerCase()}_${board.toLowerCase()}_${p.id}`,
    title: p.title,
    department: p.department,
    location: p.location,
    workplace_type: /\bremote\b/i.test(`${p.title} ${p.location || ''}`) ? 'remote' : null,
    employment_type: null,
    salary_min: null,
    salary_max: null,
    salary_currency: null,
    salary_interval: null,
    description: null,
    url,
    posted_at: null,
    raw_data: { id: p.id, company, board },
  };
}

async function fetchJobs(rawSlug) {
  const ref = parseSlug(rawSlug);
  const rows = [];
  let capped = false;
  for (let page = 1; ; page++) {
    const html = await getHtml(`${BASE}/${ref.company}/${ref.board}${page > 1 ? `?page=${page}` : ''}`);
    const got = parsePage(html);
    rows.push(...got);
    if (!got.length || !hasNextPage(html)) break;
    if (page >= MAX_PAGES) { capped = true; break; }
  }
  const seen = new Set();
  const jobs = [];
  for (const p of rows) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    jobs.push(toJob(p, ref));
  }
  return { jobs, meta: { capped } };
}

/** The posting's HTML description from its JSON-LD JobPosting, or null. */
async function fetchDescription(url) {
  const html = await getHtml(url);
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const d = JSON.parse(m[1]);
      if (d && d['@type'] === 'JobPosting' && d.description) return d.description;
    } catch { /* not this block */ }
  }
  return null;
}

const fetchTimeoutMs = 15 * 60 * 1000;

module.exports = { fetchJobs, fetchDescription, parsePage, hasNextPage, toJob, parseSlug, fetchTimeoutMs };
