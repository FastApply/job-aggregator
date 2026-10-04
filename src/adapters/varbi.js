// Varbi adapter — Swedish public-sector and company careers sites at {org}.varbi.com.
//
// The job list is the employer's RSS feed (https://{org}.varbi.com/what:rssfeed/): title, link with
// the job id, publication date and a teaser. It carries no location, which a Sweden search needs,
// so each job page is read too: its "quick info" table gives town (Ort), county (Län), country
// (Land), employment form, hours and the application deadline, and .job-desc the full text.
//
// Applying: Cloudflare Turnstile on every apply form (First Apply's TurnstileHijackService handles
// that pattern); a few employers force a Varbi login before the form. Checked 2026-10-04.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0 Safari/537.36';
const DETAIL_CONCURRENCY = 6;
const DETAIL_DELAY_MS = 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { decodeEntities } = require('./html-entities');
const decode = (s) => decodeEntities(String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim();
const text = (html) => decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** The employer's base URL: a bare org name, or a full host when the slug carries one. */
function baseUrl(slug) {
  const s = String(slug || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return s.includes('.') ? `https://${s}` : `https://${s}.varbi.com`;
}

function parseFeed(xml) {
  return [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const tag = (name) => { const t = m[1].match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)); return t ? decode(t[1]) : null; };
    const link = tag('link') || tag('guid');
    const id = (link || '').match(/jobID:(\d+)/);
    return id ? { id: id[1], title: tag('title'), url: link, pubDate: tag('pubDate'), teaser: tag('description') } : null;
  }).filter(Boolean);
}

/** The job page's quick-info table, keyed by row class: town, county, country, hours, ... */
function parseDetail(html) {
  const info = {};
  for (const m of String(html).matchAll(/<tr class="quick-info-([a-z-]+)">\s*<th[^>]*>[\s\S]*?<\/th>\s*<td>([\s\S]*?)<\/td>/g)) {
    info[m[1]] = text(m[2]);
  }
  const desc = String(html).match(/class="job-desc mb"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/);
  return { info, description: desc ? desc[1].trim() : null };
}

/** Swedish employment wording -> the board's canonical types. */
function employmentType(info) {
  const form = (info['type-of-employment'] || '').toLowerCase();
  const hours = (info.hours || '').toLowerCase();
  if (/visstid|vikariat|tidsbegränsad|säsong|projekt|timanställning|behov/.test(form)) return 'Temporary';
  if (/praktik/.test(form)) return 'Internship';
  if (/deltid/.test(hours)) return 'Part-time';
  if (/heltid/.test(hours) || /tillsvidare/.test(form)) return 'Full-time';
  return null;
}

async function get(url, as = 'text') {
  const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'sv-SE,sv;q=0.9,en;q=0.8' }, signal: AbortSignal.timeout(30000) });
  if (res.status === 404) throw new Error('Varbi HTTP 404 (not found)');
  if (!res.ok) throw new Error(`Varbi HTTP ${res.status}`);
  return as === 'text' ? res.text() : res.json();
}

async function fetchJobs(clientname) {
  const base = baseUrl(clientname);
  const xml = await get(`${base}/what:rssfeed/`);
  if (!/<rss|<channel/i.test(xml)) throw new Error('Varbi: no RSS feed (not found)');
  const items = parseFeed(xml);

  // Details, a few at a time: a page that fails keeps the feed's title and link, so one bad page
  // never drops a live job from the set (the absence counter would read that as closed).
  const jobs = [];
  for (let i = 0; i < items.length; i += DETAIL_CONCURRENCY) {
    const batch = items.slice(i, i + DETAIL_CONCURRENCY);
    const details = await Promise.all(batch.map((it) => get(it.url).then(parseDetail).catch(() => ({ info: {}, description: null }))));
    batch.forEach((it, k) => {
      const { info, description } = details[k];
      const location = [info.town, info.country].filter(Boolean).join(', ') || null;
      jobs.push({
        external_id: `varbi_${it.id}`,
        title: it.title,
        department: null,
        location,
        workplace_type: null,
        employment_type: employmentType(info),
        salary_min: null, salary_max: null, salary_currency: null, salary_interval: null,
        description: description || it.teaser || null,
        url: it.url,
        posted_at: info.published || (it.pubDate ? new Date(it.pubDate).toISOString() : null),
        raw_data: { id: it.id, county: info.county || null, deadline: info.ends || null, hours: info.hours || null, form: info['type-of-employment'] || null },
      });
    });
    if (i + DETAIL_CONCURRENCY < items.length) await sleep(DETAIL_DELAY_MS);
  }
  return { jobs, meta: { companyName: null, logoUrl: null, capped: false } };
}

module.exports = { fetchJobs, parseFeed, parseDetail, employmentType, baseUrl };
