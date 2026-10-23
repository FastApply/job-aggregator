// Eightfold adapter — career sites at {tenant}.eightfold.ai (often behind a custom domain such as
// careers.qualcomm.com). slug = the tenant ("starbucks"), or "{tenant}/{domain}" when the domain
// cannot be read off the career page (the shared "app" tenant serves many employers by domain).
//
// Every API call needs ?domain= (the employer's own domain, "starbucks.com"). The career page carries
// it in <code id="pcsx-data">{"domain": ...}. Two API generations, chosen per tenant:
//   PCSX  GET /api/pcsx/search?domain=&start=N&sort_by=timestamp -> {data: {count, positions[]}}
//         GET /api/pcsx/position_details?position_id=&domain=   -> {data: {jobDescription, ...}}
//   v2    GET /api/apply/v2/jobs?domain=&start=N&sort_by=timestamp -> {count, positions[]} (no text)
//         GET /api/apply/v2/jobs/{id}?domain=                    -> {job_description, ...}
// A PCSX tenant answers v2 with "Not authorized for PCSX"; a v2 tenant fails the PCSX search.
// Both serve 10 positions a call whatever num asks. Each tenant host 429s past roughly one request
// a second, so calls to one host queue GAP_MS apart. Starbucks alone lists ~21,700 jobs: listing it
// takes about an hour, and a detail call per job would take ten, so each crawl fetches descriptions
// for the newest DETAIL_MAX jobs only. A sync that sends no description keeps the stored one, so
// they accumulate crawl over crawl. Unknown tenant -> its subdomain does not resolve, or the career
// page answers 404. Checked 2026-10-23.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0 Safari/537.36';
const PAGE_SIZE = 10; // fixed by both APIs
const MAX_PAGES = 3000; // 30,000 jobs
const DETAIL_MAX = Number(process.env.EIGHTFOLD_DETAIL_MAX || 250);
const GAP_MS = Number(process.env.EIGHTFOLD_GAP_MS || 1600);
// Across all tenants too: six tenants crawled side by side (~4 requests a second in all) failed
// 13 of 18 boards that each crawl fine alone (2026-10-23).
const GLOBAL_GAP_MS = Number(process.env.EIGHTFOLD_GLOBAL_GAP_MS || 500);
const BLOCKED_WAIT_MS = 20 * 1000;
const fetchTimeoutMs = 2 * 60 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One queue per tenant host (its own limit) inside one process-wide queue (the limit across hosts).
const nextAt = new Map();
let globalNextAt = 0;
async function turn(host) {
  const now = Date.now();
  const at = Math.max(now, nextAt.get(host) || 0, globalNextAt);
  nextAt.set(host, at + GAP_MS);
  globalNextAt = at + GLOBAL_GAP_MS;
  if (at > now) await sleep(at - now);
}

function parseSlug(slug) {
  const m = String(slug || '').trim().toLowerCase().match(/^([a-z0-9][a-z0-9-]*)(?:\/([a-z0-9.-]+\.[a-z]{2,}))?$/);
  if (!m) throw new Error(`Eightfold HTTP 404 (not found): bad slug "${slug}"`);
  return { tenant: m[1], domain: m[2] || null };
}

async function get(host, path, { json = true } = {}) {
  for (let attempt = 1; ; attempt++) {
    await turn(host);
    let res;
    try {
      res = await fetch(`https://${host}${path}`, { headers: { 'user-agent': UA, accept: json ? 'application/json' : 'text/html' }, signal: AbortSignal.timeout(45000) });
    } catch (e) {
      // No such tenant: its subdomain does not resolve.
      if (e.cause && e.cause.code === 'ENOTFOUND') throw new Error('Eightfold HTTP 404 (not found)');
      throw new Error(`Eightfold network error (retry): ${e.message}`);
    }
    if ((res.status === 429 || res.status === 403 || res.status === 503) && attempt < 8) {
      nextAt.set(host, Math.max(nextAt.get(host) || 0, Date.now() + BLOCKED_WAIT_MS * attempt));
      continue;
    }
    if (res.status === 404) return { status: 404, body: null };
    const body = json ? await res.json().catch(() => null) : await res.text();
    return { status: res.status, body };
  }
}

/** The employer domain from the career page's pcsx-data block; null when the page has none. */
async function domainOf(host) {
  const { status, body } = await get(host, '/careers', { json: false });
  if (status === 404) throw new Error('Eightfold HTTP 404 (not found)');
  if (status !== 200 || !body) throw new Error(`Eightfold careers page HTTP ${status} (retry)`);
  const text = body.replace(/&#34;|&quot;/g, '"');
  const m = text.match(/id="pcsx-data"[^>]*>\s*\{\s*"domain":\s*"([^"]+)"/) || text.match(/"domain":\s*"([a-z0-9.-]+\.[a-z]{2,})"/);
  const name = (text.match(/"companyName":\s*"([^"]+)"/) || [])[1] || null;
  return { domain: m ? m[1] : null, name };
}

function salaryFrom(d) {
  const key = Object.keys(d || {}).find((k) => /payrange|payraterange/i.test(k) && typeof d[k] === 'string' && /\d/.test(d[k]));
  if (!key) return {};
  const s = d[key];
  const nums = (s.match(/\d[\d,]*(?:\.\d+)?/g) || []).map((n) => Number(n.replace(/,/g, ''))).filter((n) => n > 0);
  if (!nums.length) return {};
  return {
    salary_min: nums[0], salary_max: nums[1] || null,
    salary_currency: /\$|usd/i.test(s) ? 'USD' : /€|eur/i.test(s) ? 'EUR' : /£|gbp/i.test(s) ? 'GBP' : null,
    salary_interval: /hour/i.test(s) ? 'hour' : /year|annual|salary/i.test(s) ? 'year' : null,
  };
}

const WORKPLACE = { remote: 'remote', hybrid: 'hybrid', onsite: 'onsite' };

/** A PCSX or v2 position (and its details, when fetched) -> a job. */
function toJob(p, d, { tenant, domain }) {
  d = d || {};
  const id = String(p.id);
  const places = p.standardizedLocations && p.standardizedLocations.length ? p.standardizedLocations : p.locations || (p.location ? [p.location] : []);
  const ts = Number(p.postedTs || p.t_create || 0);
  const option = String(p.workLocationOption || p.work_location_option || '').toLowerCase();
  return {
    external_id: `eightfold_${id}`,
    title: String(p.name || p.posting_name || '').trim(),
    department: p.department || null,
    location: [...new Set(places.filter(Boolean))].slice(0, 5).join(' / ') || null,
    workplace_type: WORKPLACE[option] || null,
    employment_type: null,
    salary_min: null, salary_max: null, salary_currency: null, salary_interval: null,
    ...salaryFrom(d),
    description: d.jobDescription || d.job_description || null,
    url: `https://${tenant}.eightfold.ai/careers/job/${id}${tenant === 'app' ? `?domain=${domain}` : ''}`,
    posted_at: ts > 0 ? new Date(ts * 1000).toISOString() : null,
    raw_data: { id, ats_job_id: p.atsJobId || p.ats_job_id || null, domain, public_url: d.publicUrl || p.canonicalPositionUrl || null },
  };
}

async function fetchJobs(slug) {
  const { tenant, domain: given } = parseSlug(slug);
  const host = `${tenant}.eightfold.ai`;
  const page = await domainOf(host);
  const domain = given || page.domain;
  if (!domain) throw new Error('Eightfold no employer domain on the career page (retry)');
  const q = `domain=${encodeURIComponent(domain)}`;

  // PCSX first; a tenant still on v2 fails it and is listed through v2.
  let api = 'pcsx';
  let first = await get(host, `/api/pcsx/search?${q}&start=0&sort_by=timestamp`);
  if (!(first.status === 200 && first.body && first.body.data && Array.isArray(first.body.data.positions))) {
    api = 'v2';
    first = await get(host, `/api/apply/v2/jobs?${q}&start=0&num=${PAGE_SIZE}&sort_by=timestamp`);
    if (first.status === 404) throw new Error('Eightfold HTTP 404 (not found)');
    if (!(first.status === 200 && first.body && Array.isArray(first.body.positions))) throw new Error(`Eightfold search HTTP ${first.status} (retry)`);
  }
  const unpack = (b) => (api === 'pcsx' ? { total: b.data.count || 0, rows: b.data.positions || [] } : { total: b.count || 0, rows: b.positions || [] });
  let { total, rows } = unpack(first.body);
  const positions = [...rows];
  let capped = false;
  for (let pg = 1; rows.length && positions.length < total; pg++) {
    if (pg >= MAX_PAGES) { capped = true; break; }
    const path = api === 'pcsx' ? `/api/pcsx/search?${q}&start=${pg * PAGE_SIZE}&sort_by=timestamp` : `/api/apply/v2/jobs?${q}&start=${pg * PAGE_SIZE}&num=${PAGE_SIZE}&sort_by=timestamp`;
    const r = await get(host, path);
    if (r.status !== 200 || !r.body) throw new Error(`Eightfold search page ${pg} HTTP ${r.status} (retry)`);
    ({ rows } = unpack(r.body));
    positions.push(...rows);
  }

  const seen = new Set();
  const list = positions.filter((p) => p && p.id && !seen.has(String(p.id)) && seen.add(String(p.id)));
  const jobs = [];
  for (let i = 0; i < list.length; i++) {
    let d = null;
    if (i < DETAIL_MAX) {
      const path = api === 'pcsx' ? `/api/pcsx/position_details?position_id=${list[i].id}&${q}` : `/api/apply/v2/jobs/${list[i].id}?${q}`;
      const r = await get(host, path).catch(() => null);
      if (r && r.status === 200 && r.body) d = api === 'pcsx' ? r.body.data : r.body;
    }
    jobs.push(toJob(list[i], d, { tenant, domain }));
  }
  // The shared "app" tenant's page names Eightfold itself, not the employer behind the domain.
  return { jobs, meta: { companyName: tenant === 'app' ? null : page.name, logoUrl: null, capped } };
}

module.exports = { fetchJobs, parseSlug, toJob, salaryFrom, fetchTimeoutMs };
