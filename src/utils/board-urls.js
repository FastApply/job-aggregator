// Employer boards named by a URL, for the platforms whose board is a path or a query value rather
// than a hostname: UKG, ADP (myjobs + Workforce Now), SilkRoad, Gem, Kula. One place for the shapes
// the crawler's adapters take as a slug, used by seed-boards (job URLs we already hold, Common
// Crawl links, guessed names).
const SKIP_FIRST_SEGMENT = new Set([
  'cx', 'auth', 'public', 'assets', 'api', '_next', 'favicon.ico', 'robots.txt', 'sitemap.xml', 'embed',
  'errorhandler', 'content', 'scripts', 'bundles', 'account', 'home', 'static',
]);

/**
 * { ats, slug } for the employer board a URL belongs to, or null. Slugs are lower-cased throughout,
 * as the 2026-10-29 production seed and scripts/lib/board-from-url.js store them: UKG and SilkRoad
 * answer either case, and a mixed-case slug makes a second career_url for the same board.
 */
function boardFromUrl(url) {
  const u = String(url || '').trim();
  let m = u.match(/^https?:\/\/((?:recruiting2?\.ultipro\.(?:com|ca))|(?:[a-z0-9-]+\.rec\.pro\.ukg\.net))\/([A-Za-z0-9]{2,20})\/JobBoard\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (m) return { ats: 'ukg', slug: `${m[1].toLowerCase()}/${m[2].toLowerCase()}/${m[3].toLowerCase()}` };
  m = u.match(/^https?:\/\/myjobs\.adp\.com\/([^/?#]+)\//i);
  if (m) return keep('adp', m[1].toLowerCase());
  m = u.match(/^https?:\/\/workforcenow\.adp\.com\/[^#]*[?&]cid=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (m) return { ats: 'adp_workforcenow', slug: m[1].toLowerCase() };
  m = u.match(/^https?:\/\/jobs\.silkroad\.com\/([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*)(?:[/?#]|$)/i);
  if (m && m[2].toLowerCase() !== 'jobs') return keep('silkroad', `${m[1]}/${m[2]}`.toLowerCase());
  m = u.match(/^https?:\/\/jobs\.gem\.com\/([^/?#]+)/i);
  if (m) return keep('gem', m[1].toLowerCase());
  m = u.match(/^https?:\/\/careers\.kula\.ai\/([^/?#]+)/i);
  if (m) return keep('kula', m[1].toLowerCase());
  return null;
}

function keep(ats, slug) {
  const first = slug.split('/')[0].toLowerCase();
  if (SKIP_FIRST_SEGMENT.has(first) || first.startsWith('-')) return null;
  return { ats, slug };
}

/** The career_url a board is stored under (companies.career_url is unique). */
function careerUrlFor(ats, slug) {
  switch (ats) {
    case 'ukg': { const [host, tenant, board] = slug.split('/'); return `https://${host}/${tenant}/JobBoard/${board}/`; }
    case 'adp': return `https://myjobs.adp.com/${slug}/cx/job-listing`;
    case 'adp_workforcenow': return `https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=${slug}`;
    case 'silkroad': return `https://jobs.silkroad.com/${slug}`;
    case 'gem': return `https://jobs.gem.com/${slug}`;
    case 'kula': return `https://careers.kula.ai/${slug}`;
    default: throw new Error(`no board URL shape for ${ats}`);
  }
}

/** A case-insensitive identity for a board, so "SpecCorp/Careers" and "speccorp/careers" are one. */
const boardKey = (ats, slug) => `${ats}|${String(slug).toLowerCase()}`;

const BOARD_URL_ATS = ['ukg', 'adp', 'adp_workforcenow', 'silkroad', 'gem', 'kula'];

// The same shapes as a Postgres regex, for picking candidate rows out of `jobs` by url.
const BOARD_URL_SQL_RE = '(ultipro\\.(com|ca)/[^/]+/JobBoard/|rec\\.pro\\.ukg\\.net/[^/]+/JobBoard/|myjobs\\.adp\\.com/|workforcenow\\.adp\\.com/.*cid=|jobs\\.silkroad\\.com/|jobs\\.gem\\.com/|careers\\.kula\\.ai/)';

module.exports = { boardFromUrl, careerUrlFor, boardKey, BOARD_URL_ATS, BOARD_URL_SQL_RE };
