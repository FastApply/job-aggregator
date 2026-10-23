// Manatal adapter — career pages at www.careers-page.com/{slug}. slug = the employer's page slug.
//
// The page's own JSON API, no key or session:
//   GET /api/v1.0/c/{slug}/          -> {name, logo, is_job_listing_enabled, ...}
//   GET /api/v1.0/c/{slug}/jobs/?page=N -> {count, next, results[]}, 20 a page whatever page_size asks,
//       each with the full HTML description, city/state/country and location_display; salary_min/max and
//       currency_code only where is_salary_visible; organization_name on agency boards (the client hired for).
// Unknown slug -> 404 "No ClientPortalSettings matches". Many boards are recruiting agencies; a few post
// one role in hundreds of towns. Closed job = gone from the list. Checked 2026-10-23.
// Rate limit: an AWS WAF rule answers 429 (then 403) to one IP sending ~8 requests a second, so every
// request in the process shares one queue, MIN_GAP_MS apart, and a 429/403 waits and retries.
const BASE = 'https://www.careers-page.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0 Safari/537.36';
const MAX_PAGES = 250; // 5,000 jobs
const MIN_GAP_MS = Number(process.env.MANATAL_GAP_MS || 1000);
const BLOCKED_WAIT_MS = 90 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One queue for the whole process: concurrent boards take turns, MIN_GAP_MS apart.
let nextAt = 0;
async function turn() {
  const now = Date.now();
  const at = Math.max(now, nextAt);
  nextAt = at + MIN_GAP_MS;
  if (at > now) await sleep(at - now);
}

function slugOf(slug) {
  const s = String(slug || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(s)) throw new Error(`Manatal HTTP 404 (not found): bad slug "${slug}"`);
  return s;
}

async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    await turn();
    let res;
    try {
      res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    } catch (e) {
      throw new Error(`Manatal network error (retry): ${e.message}`);
    }
    if (res.status === 404) throw new Error('Manatal HTTP 404 (not found)');
    if ((res.status === 429 || res.status === 403) && attempt < 4) {
      nextAt = Math.max(nextAt, Date.now() + BLOCKED_WAIT_MS); // hold the whole queue, not just this board
      continue;
    }
    if (!res.ok) throw new Error(`Manatal HTTP ${res.status} (retry)`);
    return res.json();
  }
}

function locationOf(j) {
  if (j.location_display && j.location_display.trim()) return j.location_display.trim();
  const parts = [j.city, j.state, j.country].map((x) => String(x || '').trim()).filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function toJob(j, slug) {
  const salary = !!j.is_salary_visible;
  const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) || Number(v) <= 0 ? null : Number(v));
  return {
    external_id: `manatal_${j.id}`,
    title: String(j.position_name || '').trim(),
    department: null,
    location: locationOf(j),
    workplace_type: /\bremote\b/i.test(`${j.position_name} ${j.location_display || ''}`) ? 'remote' : null,
    employment_type: null,
    salary_min: salary ? num(j.salary_min) : null,
    salary_max: salary ? num(j.salary_max) : null,
    salary_currency: salary && (num(j.salary_min) || num(j.salary_max)) ? j.currency_code || null : null,
    salary_interval: null,
    description: j.description || null,
    url: `${BASE}/${slug}/job/${j.hash}`,
    posted_at: null,
    raw_data: { id: j.id, hash: j.hash, slug, hiring_company: j.organization_name || null, pinned: !!j.is_pinned_in_career_page },
  };
}

async function fetchJobs(rawSlug) {
  const slug = slugOf(rawSlug);
  const company = await getJson(`${BASE}/api/v1.0/c/${slug}/`);
  const rows = [];
  let capped = false;
  if (company.is_job_listing_enabled !== false) {
    for (let page = 1; ; page++) {
      const d = await getJson(`${BASE}/api/v1.0/c/${slug}/jobs/?page=${page}`);
      rows.push(...(d.results || []));
      if (!d.next || !(d.results || []).length) break;
      if (page >= MAX_PAGES) { capped = true; break; }
    }
  }
  const seen = new Set();
  const jobs = [];
  for (const r of rows) {
    if (!r.id || !r.hash || seen.has(r.id)) continue;
    seen.add(r.id);
    jobs.push(toJob(r, slug));
  }
  return { jobs, meta: { companyName: (company.name || '').trim() || null, logoUrl: company.logo || null, capped } };
}

module.exports = { fetchJobs, toJob, locationOf, slugOf };
