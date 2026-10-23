// Avature adapter — career sites at {tenant}.avature.net/{portal path} (often behind a custom domain:
// tesco.avature.net -> careers.tesco.com). slug = "{tenant}/{portal path}": "koch/en_US/careers",
// "nva/careers", "dbgroup/en_US/jobsGlobal".
//
// No JSON API. The search page {portal}/SearchJobs/?jobOffset=N is server-rendered: an <article> (or
// list item) per job with a link to {portal}/JobDetail/{slug}/{id}, the title as that link's text,
// and usually the place (span.list-item-location, a "Location" field, or else the subtitle, which on a
// few sites names the group company instead). Page size is
// the site's own (6, 10, 12 or 20) and no parameter changes it; the RSS feed stops at 20. So the
// adapter walks offsets by the first page's size until a page brings nothing new.
// A job page has the full text: a JobPosting JSON-LD block on some sites, otherwise label/value
// fields (article__content__view__field__label/__value) and a rich-text body, or on the older
// template infoTitle/infoDes sections. Job pages run 35 KB to
// 1.3 MB (Siemens), so each crawl reads only the first DETAIL_MAX of them; a sync that sends no
// description keeps the stored one, so they accumulate crawl over crawl.
// Unknown tenant -> its subdomain does not resolve; unknown portal -> 404. Checked 2026-10-23.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0 Safari/537.36';
const MAX_PAGES = 600;
const DETAIL_MAX = Number(process.env.AVATURE_DETAIL_MAX || 150);
const GAP_MS = Number(process.env.AVATURE_GAP_MS || 1500);
const BLOCKED_WAIT_MS = 60 * 1000;
const fetchTimeoutMs = 2 * 60 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One queue for the whole process, not one per site: every Avature site sits behind the same
// firewall, which answered "406 Not Acceptable" to every site at once after four employers were
// crawled side by side at ~5 requests a second (2026-10-23).
let nextAt = 0;
async function turn() {
  const now = Date.now();
  const at = Math.max(now, nextAt);
  nextAt = at + GAP_MS;
  if (at > now) await sleep(at - now);
}

function parseSlug(slug) {
  const m = String(slug || '').trim().match(/^([A-Za-z0-9-]+)\/([A-Za-z0-9_\-/]+?)\/?$/);
  if (!m) throw new Error(`Avature HTTP 404 (not found): bad slug "${slug}"`);
  return { tenant: m[1].toLowerCase(), portal: m[2] };
}

async function getHtml(url) {
  for (let attempt = 1; ; attempt++) {
    await turn();
    let res;
    try {
      res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' }, signal: AbortSignal.timeout(45000) });
    } catch (e) {
      if (e.cause && e.cause.code === 'ENOTFOUND') throw new Error('Avature HTTP 404 (not found)');
      throw new Error(`Avature network error (retry): ${e.message}`);
    }
    if ((res.status === 406 || res.status === 429 || res.status === 503) && attempt < 4) {
      nextAt = Math.max(nextAt, Date.now() + BLOCKED_WAIT_MS * attempt); // hold the whole queue
      continue;
    }
    if (res.status === 404) throw new Error('Avature HTTP 404 (not found)');
    if (!res.ok) throw new Error(`Avature HTTP ${res.status} (retry)`);
    return { html: await res.text(), url: res.url };
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#039': "'", '#39': "'" };
const decode = (s) => String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (ENTITIES[e.toLowerCase()] !== undefined) return ENTITIES[e.toLowerCase()];
  if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return m;
});
const text = (h) => decode(String(h || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Inner HTML of the element whose opening tag starts at `at`, balancing tags of the same name. */
function innerAt(html, at) {
  const open = html.slice(at).match(/^<([a-z0-9]+)[^>]*>/i);
  if (!open) return '';
  const tag = open[1].toLowerCase();
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = at + open[0].length;
  let depth = 1; let m;
  while ((m = re.exec(html))) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(at + open[0].length, m.index);
  }
  return html.slice(at + open[0].length);
}

/** Inner HTML of every element carrying `cls` among its classes. */
function byClass(html, cls) {
  const out = [];
  const re = new RegExp(`<[a-z0-9]+[^>]*class="(?:[^"]*\\s)?${cls}(?:\\s[^"]*)?"[^>]*>`, 'gi');
  let m;
  while ((m = re.exec(html))) out.push(innerAt(html, m.index));
  return out;
}

const LOCATION_LABEL = /location|ort\b|standort|ubicaci|municipio|lieu|localit|city|cidade|plaats|place/i;

/** label -> value text pairs from the article__content__view fields. */
function fieldsOf(html) {
  const fields = {};
  for (const f of byClass(html, 'article__content__view__field')) {
    const label = text(byClass(f, 'article__content__view__field__label')[0] || byClass(f, 'article__content__field__label')[0]);
    const value = byClass(f, 'article__content__view__field__value')[0] || byClass(f, 'article__content__field__value')[0];
    if (label && value !== undefined && !(label in fields)) fields[label.replace(/:$/, '')] = value;
  }
  for (const f of byClass(html, 'article__content__field')) {
    const label = text(byClass(f, 'article__content__field__label')[0]);
    const value = byClass(f, 'article__content__field__value')[0];
    if (label && value !== undefined && !(label in fields)) fields[label.replace(/:$/, '')] = value;
  }
  return fields;
}

const idOf = (href) => (String(href).match(/\/JobDetail\/(?:[^/?#"]*\/)?(\d+)(?:[/?#]|$)/) || [])[1] || null;

/** One search page -> [{id, url, title, location}] in page order. */
function parseList(html, base) {
  const rows = [];
  const seen = new Set();
  const re = /<a\b[^>]*href="([^"]*\/JobDetail\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = decode(m[1]);
    const id = idOf(href);
    const title = text(m[2]);
    if (!id || !title || seen.has(id) || /^(apply|more|read more|view|ver|share)\b/i.test(title)) continue;
    seen.add(id);
    // The job's own block: the nearest <article> or <li> that opens before the link and still holds
    // it (a share menu's <li> can sit between the article's start and the title link).
    const block = ['<article', '<li'].map((t) => html.lastIndexOf(t, m.index)).filter((i) => i >= 0)
      .sort((a, b) => b - a).map((i) => innerAt(html, i)).find((b) => b.includes(m[1])) || '';
    const fields = fieldsOf(block);
    const label = Object.keys(fields).find((k) => LOCATION_LABEL.test(k));
    const subtitle = text(byClass(block, 'article__header__text__subtitle')[0] || byClass(block, 'listSingleColumnItemMiscData')[0])
      .split('·')[0].trim(); // "Largo, Florida, United States · · Posted 19-Oct-2026"
    const location = text(byClass(block, 'list-item-location')[0]) || (label ? text(fields[label]) : '') || subtitle || null;
    rows.push({ id, url: new URL(href, base).href.replace(/\?.*$/, ''), title, location });
  }
  return rows;
}

/** A job page -> {description, location, posted_at, employment_type, salary} from JSON-LD or fields. */
function parseDetail(html) {
  let ld = null;
  for (const raw of html.match(/<script[^>]*application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi) || []) {
    try {
      const j = JSON.parse(raw.replace(/^<script[^>]*>|<\/script>$/gi, ''));
      const p = [].concat(j).find((x) => x && x['@type'] === 'JobPosting');
      if (!p) continue;
      const addr = [].concat(p.jobLocation || []).map((l) => l && l.address).filter(Boolean)
        .map((a) => [a.addressLocality, a.addressRegion, a.addressCountry && (a.addressCountry.name || a.addressCountry)].filter((x) => typeof x === 'string' && x).join(', ')).filter(Boolean);
      const v = p.baseSalary && p.baseSalary.value;
      ld = {
        description: p.description ? decode(p.description) : null,
        location: addr.length ? [...new Set(addr)].slice(0, 5).join(' / ') : null,
        posted_at: p.datePosted && !Number.isNaN(Date.parse(p.datePosted)) ? new Date(p.datePosted).toISOString() : null,
        employment_type: [].concat(p.employmentType || [])[0] || null,
        salary_min: v && Number(v.minValue || v.value) > 0 ? Number(v.minValue || v.value) : null,
        salary_max: v && Number(v.maxValue) > 0 ? Number(v.maxValue) : null,
        salary_currency: (p.baseSalary && p.baseSalary.currency) || null,
        salary_interval: v && v.unitText ? String(v.unitText).toLowerCase() : null,
      };
      break;
    } catch { /* not JSON: fall through to the fields */ }
  }
  // JSON-LD with a body is the whole answer; one with an empty body still lends its other fields.
  if (ld && text(ld.description).length > 50) return ld;
  const fields = fieldsOf(html);
  const rich = [...byClass(html, 'article__content--rich-text'), ...byClass(html, 'field--rich-text')].filter((v) => text(v).length > 50);
  // Some sites put the body in a field with no label, so look at every field value, not just the labelled.
  let bodies = rich.length ? rich : byClass(html, 'article__content__view__field__value').filter((v) => text(v).length > 200);
  // The older template: infoTitle / infoDes sections ("Key Tasks", "Benefits", ...).
  if (!bodies.length) {
    const titles = byClass(html, 'infoTitle');
    bodies = byClass(html, 'infoDes').map((v, i) => (titles[i] ? `<h3>${text(titles[i])}</h3>${v}` : v));
  }
  const description = bodies.length ? bodies.join('\n').trim() : null;
  const locLabel = Object.keys(fields).find((k) => LOCATION_LABEL.test(k));
  const dateLabel = Object.keys(fields).find((k) => /posted|date|fecha|datum/i.test(k));
  const posted = dateLabel ? Date.parse(text(fields[dateLabel])) : NaN;
  const typeLabel = Object.keys(fields).find((k) => /employment type|job type|contrato|contract/i.test(k));
  return {
    ...(ld || {}),
    description,
    location: (locLabel ? text(fields[locLabel]) : '') || (ld && ld.location) || null,
    posted_at: Number.isNaN(posted) ? (ld && ld.posted_at) || null : new Date(posted).toISOString(),
    employment_type: (typeLabel ? text(fields[typeLabel]).slice(0, 60) : '') || (ld && ld.employment_type) || null,
  };
}

function toJob(row, d) {
  d = d || {};
  return {
    external_id: `avature_${row.id}`,
    title: row.title,
    department: null,
    location: row.location || d.location || null,
    workplace_type: null,
    employment_type: d.employment_type || null,
    salary_min: d.salary_min || null, salary_max: d.salary_max || null,
    salary_currency: d.salary_min ? d.salary_currency || null : null, salary_interval: d.salary_min ? d.salary_interval || null : null,
    description: d.description || null,
    url: row.url,
    posted_at: d.posted_at || null,
    raw_data: { id: row.id },
  };
}

async function fetchJobs(slug) {
  const { tenant, portal } = parseSlug(slug);
  const searchUrl = (offset) => `https://${tenant}.avature.net/${portal}/SearchJobs/?jobOffset=${offset}`;
  const first = await getHtml(searchUrl(0));
  const base = first.url;
  let rows = parseList(first.html, base);
  const all = [...rows];
  const seen = new Set(rows.map((r) => r.id));
  const step = rows.length;
  let capped = false;
  for (let pg = 1; step && rows.length; pg++) {
    if (pg >= MAX_PAGES) { capped = true; break; }
    const next = new URL(base);
    next.searchParams.set('jobOffset', String(pg * step));
    rows = parseList((await getHtml(next.href)).html, base).filter((r) => !seen.has(r.id) && seen.add(r.id));
    all.push(...rows);
  }
  const companyName = text((first.html.match(/<meta property="og:site_name" content="([^"]*)"/) || [])[1]) || null;
  const jobs = [];
  for (let i = 0; i < all.length; i++) {
    let d = null;
    if (i < DETAIL_MAX) {
      try { d = parseDetail((await getHtml(all[i].url)).html); } catch { /* keep the list row */ }
    }
    jobs.push(toJob(all[i], d));
  }
  return { jobs, meta: { companyName, logoUrl: null, capped } };
}

module.exports = { fetchJobs, parseSlug, parseList, parseDetail, toJob, fetchTimeoutMs };
