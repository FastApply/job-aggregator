/**
 * The employer of a job feed's Workable link, which names no account:
 *   jobs.workable.com/view/<id>/<title>-in-<place>-at-<employer>
 *   apply.workable.com/j/<shortcode>
 *
 * A marketplace link ends in the employer's slug, so that wins; a short link says nothing and the
 * feed's own company name is all there is. Null when neither names one. The slug starts wjb_ like
 * the marketplace crawl's, which keeps the row out of the apply.workable.com account crawl: there
 * is no account of that name to crawl.
 */
function slugOf(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function employerSlugOfUrl(url) {
  const m = /^https?:\/\/jobs\.workable\.com\/view\/[^/]+\/.*-at-([^/?#]+)\/?(?:[?#].*)?$/i.exec(String(url || ''));
  if (!m) return null;
  try {
    return slugOf(decodeURIComponent(m[1])) || null;
  } catch {
    return slugOf(m[1]) || null;
  }
}

function workableFeedCompany(url, companyName) {
  const slug = employerSlugOfUrl(url) || slugOf(companyName);
  if (!slug) return null;
  return { slug: `wjb_name_${slug}`.slice(0, 200), careerUrl: `https://jobs.workable.com/company-name/${slug}` };
}

/** "super-soccer-stars" -> "Super Soccer Stars", for a row with no better name. */
function nameOfSlug(slug) {
  return String(slug).replace(/^wjb_name_/, '').replace(/-+/g, ' ').trim().replace(/(^|\s)([a-z])/g, (_, s, c) => s + c.toUpperCase());
}

module.exports = { workableFeedCompany, employerSlugOfUrl, nameOfSlug };
