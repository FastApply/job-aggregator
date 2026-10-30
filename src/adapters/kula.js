// Kula adapter — hosted careers pages at https://careers.kula.ai/{account}. slug = the account name.
//
// The careers page's own JSON (found by tracing the page, 2026-10-28), no key or session:
//   GET https://careers.kula.ai/api/internal/ats_job_posts?accountName={account}&items=99&page=N&type=ats_job_post.index
//     -> {data[], meta: {count, page, items, pages}}; each post has id, title, listed, kind
//        ("external"), launch_at, and ats_job: job_description (HTML), workplace (remote / hybrid /
//        onsite), employment_type, ats_department, offices[].location, compensation.base_salary.
// Unknown account -> 404 err_account_not_found; a closed account -> 403. FastApply's Kula apply
// adapter takes https://careers.kula.ai/{account}/{id}. kind is external or internal_and_external
// for public posts (96 of Multiplier's first 99 are the latter); only kind internal is left out.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0 Safari/537.36';
const BASE = 'https://careers.kula.ai';
const PER_PAGE = 99;
const MAX_PAGES = 50;
const MIN_GAP_MS = Number(process.env.KULA_GAP_MS || 700);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let nextAt = 0;
async function turn() {
  const now = Date.now();
  const at = Math.max(now, nextAt);
  nextAt = at + MIN_GAP_MS;
  if (at > now) await sleep(at - now);
}

function slugOf(slug) {
  const s = String(slug || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(s)) throw new Error(`Kula HTTP 404 (not found): bad slug "${slug}"`);
  return s;
}

async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    await turn();
    let res;
    try {
      res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    } catch (e) {
      throw new Error(`Kula network error (retry): ${e.message}`);
    }
    if (res.status === 404) throw new Error('Kula HTTP 404 (not found)');
    if (res.status === 403) throw new Error('Kula account no longer public (HTTP 403)');
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await sleep(5000 * attempt); continue; }
    if (!res.ok) throw new Error(`Kula HTTP ${res.status} (retry)`);
    return res.json();
  }
}

const WORKPLACE = { remote: 'remote', hybrid: 'hybrid', onsite: 'onsite', on_site: 'onsite', office: 'onsite' };
const INTERVAL = { yearly: 'year', annually: 'year', monthly: 'month', weekly: 'week', daily: 'day', hourly: 'hour' };
const amount = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);

function toJob(p, account) {
  const j = p.ats_job || {};
  const offices = [...new Set((j.offices || []).map((o) => o.location || o.name).filter(Boolean))];
  const pay = (j.compensation && j.compensation.base_salary) || {};
  const min = amount(pay.min_amount);
  const max = amount(pay.max_amount);
  return {
    external_id: `kula_${p.id}`,
    title: String(p.title || '').trim(),
    department: (j.ats_department && j.ats_department.name) || null,
    location: offices.length ? offices.join(' / ') : null,
    workplace_type: WORKPLACE[String(j.workplace || '').toLowerCase()] || null,
    employment_type: j.work_type_name || j.employment_type || null,
    salary_min: min,
    salary_max: max,
    salary_currency: min || max ? pay.currency || null : null,
    salary_interval: min || max ? INTERVAL[String(pay.interval || '').toLowerCase()] || null : null,
    description: j.job_description || null,
    url: `${BASE}/${account}/${p.id}`,
    posted_at: p.launch_at || null,
    raw_data: { id: p.id, account, account_id: p.account_id || null },
  };
}

async function fetchJobs(rawSlug) {
  const account = slugOf(rawSlug);
  const rows = [];
  let capped = false;
  for (let page = 1; ; page++) {
    const d = await getJson(`${BASE}/api/internal/ats_job_posts?accountName=${encodeURIComponent(account)}&items=${PER_PAGE}&page=${page}&type=ats_job_post.index`);
    rows.push(...(d.data || []));
    const pages = (d.meta && d.meta.pages) || 1;
    if (page >= pages || !(d.data || []).length) break;
    if (page >= MAX_PAGES) { capped = true; break; }
  }
  const seen = new Set();
  const jobs = [];
  for (const p of rows) {
    if (!p || !p.id || seen.has(p.id) || p.listed === false || p.kind === 'internal') continue;
    seen.add(p.id);
    jobs.push(toJob(p, account));
  }
  return { jobs, meta: { capped } };
}

const fetchTimeoutMs = 10 * 60 * 1000;

module.exports = { fetchJobs, toJob, slugOf, fetchTimeoutMs };
