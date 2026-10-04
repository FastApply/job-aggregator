// ReachMee (Talentech) adapter — careers sites at {org}.attract.reachmee.com.
//
// The employer's list page (/jobs) renders every open job server-side — title, link with the job id,
// town and application deadline — with no pagination (Espresso House: all 55 on one page). Each job
// page adds the full description and the department. The site gives only a town ("Goteborg"), so
// the country comes from the page's language: lang="sv" -> Sweden, and so on.
//
// Applying: no CAPTCHA, no login — a plain form in a frame from web103.reachmee.com (checked on six
// employers, 2026-10-04).
//
// LEGACY SITES. Most ReachMee employers (117 of 128 in Platsbanken, 1,507 of 1,634 ads) still use the
// older format: web{N}.reachmee.com/ext/{instance}/{customer}/main?site={n}&validator={token}&lang=SE.
// Its main page holds the whole list as a table (#jobsTable: title linked to .../job?...&job_id={id},
// deadline, and on some sites a town column); a job page has the heading and .jobad-body. Such a
// company's slug is that main URL. A town is rarely given, so the slug may carry a default after a
// fragment — "...&lang=SE#loc=Östersund" — taken from the employer's Platsbanken ads.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0 Safari/537.36';
const DETAIL_CONCURRENCY = 6;
const DETAIL_DELAY_MS = 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COUNTRY_BY_LANG = { sv: 'Sweden', no: 'Norway', nb: 'Norway', nn: 'Norway', da: 'Denmark', fi: 'Finland', is: 'Iceland', de: 'Germany', nl: 'Netherlands' };

const { decodeEntities } = require('./html-entities');
const decode = (s) => decodeEntities(s);
const text = (html) => decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** The employer's site: a bare org name, or a full host when the slug carries one. */
function baseUrl(slug) {
  const s = String(slug || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return s.includes('.') ? `https://${s}` : `https://${s}.attract.reachmee.com`;
}

function parseList(html) {
  const lang = (String(html).match(/<html[^>]*\blang="([a-z]{2})/i) || [])[1];
  const country = COUNTRY_BY_LANG[(lang || '').toLowerCase()] || null;
  // Columns by their header, not position: a site without a town column (Forex) put the deadline
  // in the town's slot and the job's location became "2026-11-01, Sweden".
  const heads = [...String(html).matchAll(/<h5 title="([^"]+)"/g)].map((h) => decode(h[1]).toLowerCase());
  const col = (re) => heads.findIndex((h) => re.test(h));
  const townCol = col(/\b(stad|ort|placering|kommun|arbetsort|location|city|town)\b/);
  const deadlineCol = col(/sista|deadline|last day/);
  const jobs = [];
  for (const m of String(html).matchAll(/<li class="at-jobs-list-item">([\s\S]*?)<\/li>/g)) {
    const link = m[1].match(/href="([^"]*\/jobs\/(\d+)-[^"?#]*)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const cells = [...m[1].matchAll(/<div class="at-jobs-list-cell-\d+">([\s\S]*?)<\/div>/g)].map((c) => text(c[1]));
    const town = townCol >= 0 ? cells[townCol] || null : null;
    const deadline = deadlineCol >= 0 ? cells[deadlineCol] || null : null;
    jobs.push({ id: link[2], url: decode(link[1]), title: text(link[3]), town, deadline, country });
  }
  return jobs;
}

function parseDetail(html) {
  const department = (String(html).match(/class="at-department">[\s\S]*?<\/i>([\s\S]*?)<\/span>/) || [])[1];
  const body = String(html).match(/class="at-content-block-wrapper[^"]*"[^>]*>([\s\S]*?)<div class="at-(?:social|button-row|footer)/);
  return { department: department ? text(department) : null, description: body ? body[1].trim() : null };
}

async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'sv-SE,sv;q=0.9,en;q=0.8' }, signal: AbortSignal.timeout(30000) });
  if (res.status === 404) throw new Error('ReachMee HTTP 404 (not found)');
  if (!res.ok) throw new Error(`ReachMee HTTP ${res.status}`);
  return res.text();
}

const isLegacy = (slug) => /reachmee\.com\/ext\//i.test(String(slug || ''));

/** Legacy main page -> jobs. Columns are found by their header, since sites add or drop some. */
function parseLegacyList(html) {
  const lang = (String(html).match(/<html[^>]*\blang="([a-z]{2})/i) || [])[1];
  const country = COUNTRY_BY_LANG[(lang || '').toLowerCase()] || null;
  const table = (String(html).match(/<table[^>]*id='jobsTable'[^>]*>([\s\S]*?)<\/table>/i)
    || String(html).match(/<table[^>]*id="jobsTable"[^>]*>([\s\S]*?)<\/table>/i) || [])[1];
  if (!table) return null;
  const heads = [...table.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => text(m[1]).toLowerCase());
  const townCol = heads.findIndex((h) => /\b(ort|stad|placering|kommun|arbetsort|location|city|town)\b/.test(h));
  const deadlineCol = heads.findIndex((h) => /sista|deadline|last day/.test(h));
  const body = (table.match(/<tbody>([\s\S]*?)<\/tbody>/) || [])[1] || '';
  const jobs = [];
  for (const row of body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
    // The title cell is not always first: some sites lead with the town (Ort, Tjänst, ...).
    const linkCell = cells.find((c) => /job_id=\d+/.test(c)) || '';
    const a = linkCell.match(/href=['"]([^'"]*job_id=(\d+)[^'"]*)['"][^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const cell = (i) => (i >= 0 && cells[i] ? text(cells[i].replace(/<span class=.show-mobile.>[\s\S]*?<\/span>|<span[^>]*display:none[^>]*>[\s\S]*?<\/span>/g, '')) : null);
    jobs.push({ id: a[2], url: decode(a[1]), title: text(a[3]), town: cell(townCol), deadline: cell(deadlineCol), country });
  }
  return jobs;
}

function parseLegacyDetail(html) {
  const body = String(html).match(/class="jobad-body"[^>]*>([\s\S]*?)<\/div>/);
  return { department: null, description: body ? body[1].trim() : null };
}

async function fetchLegacy(slug) {
  const [listUrl, frag] = String(slug).split('#');
  const defaultTown = (frag && /^loc=/.test(frag)) ? decodeURIComponent(frag.slice(4)) : null;
  const html = await get(listUrl.replace(/^http:\/\//, 'https://'));
  const items = parseLegacyList(html);
  if (!items) throw new Error('ReachMee: no job table (not found)');
  const customer = (listUrl.match(/\/ext\/[A-Z0-9]+\/(\d+)\//i) || [])[1] || 'x';
  return detailAndShape(items, parseLegacyDetail, (it) => `reachmee_${customer}_${it.id}`, defaultTown);
}

async function detailAndShape(items, parse, externalId, defaultTown = null) {
  const jobs = [];
  for (let i = 0; i < items.length; i += DETAIL_CONCURRENCY) {
    const batch = items.slice(i, i + DETAIL_CONCURRENCY);
    const details = await Promise.all(batch.map((it) => get(it.url).then(parse).catch(() => ({ department: null, description: null }))));
    batch.forEach((it, k) => {
      const d = details[k];
      jobs.push({
        external_id: externalId(it),
        title: it.title,
        department: d.department,
        location: [it.town || defaultTown, it.country].filter(Boolean).join(', ') || null,
        workplace_type: null,
        employment_type: null,
        salary_min: null, salary_max: null, salary_currency: null, salary_interval: null,
        description: d.description,
        url: it.url,
        posted_at: null,   // neither format publishes one; posted_ts falls back to first_seen_at
        raw_data: { id: it.id, deadline: it.deadline },
      });
    });
    if (i + DETAIL_CONCURRENCY < items.length) await sleep(DETAIL_DELAY_MS);
  }
  return { jobs, meta: { companyName: null, logoUrl: null, capped: false } };
}

async function fetchJobs(clientname) {
  if (isLegacy(clientname)) return fetchLegacy(clientname);
  const listHtml = await get(`${baseUrl(clientname)}/jobs`);
  // A site with zero jobs still renders the list header; one with no list at all is not a board.
  if (!/at-jobs-list|Tjänst|Position/i.test(listHtml)) throw new Error('ReachMee: no job list (not found)');
  const items = parseList(listHtml);
  return detailAndShape(items, parseDetail, (it) => `reachmee_${it.id}`);
}

module.exports = { fetchJobs, parseList, parseDetail, parseLegacyList, parseLegacyDetail, baseUrl, isLegacy };
