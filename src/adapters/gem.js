// Gem adapter — hosted job boards at https://jobs.gem.com/{board}. slug = the board's vanity path.
//
// Gem's public job-board API (Greenhouse-shaped), no key:
//   GET https://api.gem.com/job_board/v0/{board}/job_posts/
//     -> [{id, title, absolute_url, content (HTML), location.name, location_type
//          (remote / hybrid / in_office), employment_type (full_time ...), departments[], offices[],
//          first_published_at, created_at}], every posting in one answer.
// Unknown board -> 404 "Job board with vanity URL path ... not found". Checked 2026-10-29.
// FastApply's Gem apply adapter takes absolute_url.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0 Safari/537.36';
const API = 'https://api.gem.com/job_board/v0';

function slugOf(slug) {
  const s = String(slug || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{0,99}$/.test(s)) throw new Error(`Gem HTTP 404 (not found): bad slug "${slug}"`);
  return s;
}

const WORKPLACE = { remote: 'remote', hybrid: 'hybrid', in_office: 'onsite', onsite: 'onsite', on_site: 'onsite' };

function toJob(p, board) {
  const offices = (p.offices || []).map((o) => (o.location && o.location.name) || o.name).filter(Boolean);
  const location = (p.location && p.location.name) || (offices.length ? [...new Set(offices)].join(' / ') : null);
  return {
    external_id: `gem_${p.id}`,
    title: String(p.title || '').trim(),
    department: (p.departments || []).map((d) => d.name).filter(Boolean)[0] || null,
    location,
    workplace_type: WORKPLACE[String(p.location_type || '').toLowerCase()] || null,
    employment_type: p.employment_type || null,
    salary_min: null,
    salary_max: null,
    salary_currency: null,
    salary_interval: null,
    description: p.content || null,
    url: p.absolute_url || `https://jobs.gem.com/${board}/${p.id}`,
    posted_at: p.first_published_at || p.created_at || null,
    raw_data: { id: p.id, board, requisition_id: p.requisition_id || null },
  };
}

async function fetchJobs(rawSlug) {
  const board = slugOf(rawSlug);
  let res;
  try {
    res = await fetch(`${API}/${encodeURIComponent(board)}/job_posts/`, {
      headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw new Error(`Gem network error (retry): ${e.message}`);
  }
  if (res.status === 404) throw new Error('Gem HTTP 404 (not found)');
  if (!res.ok) throw new Error(`Gem HTTP ${res.status} (retry)`);
  const posts = await res.json();
  if (!Array.isArray(posts)) throw new Error('Gem unexpected answer (retry)');
  const seen = new Set();
  const jobs = [];
  for (const p of posts) {
    if (!p || !p.id || seen.has(p.id)) continue;
    seen.add(p.id);
    jobs.push(toJob(p, board));
  }
  return { jobs };
}

module.exports = { fetchJobs, toJob, slugOf };
