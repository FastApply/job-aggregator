// CareerPlug adapter — every employer board is its own subdomain: https://{slug}.careerplug.com/jobs.
// slug = the subdomain. Postings live at /jobs/{id}/apps/new (/jobs/{id} 302s there).
//
// There is no JSON API: /jobs.json and Accept: application/json answer 406 not_acceptable, /api/jobs
// is 404, and the XHR pager (/jobs.js) is disallowed in robots.txt. So, read 2026-11-15:
//   GET /jobs?page=N        -> HTML, 30 rows a page (<a href="/jobs/{id}"> with the title and an
//       "ST-City-ZIP" location), a will_paginate pager whose next link is <a class="next_page">.
//       Page 1 of some boards (not all) carries an ItemList JSON-LD, never later pages, so it is not used.
//   GET /jobs/{id}/apps/new -> HTML with a JobPosting JSON-LD: the full description (entity-escaped
//       HTML), datePosted, employmentType, jobLocation address, baseSalary (value or min/max with a
//       unitText) and hiringOrganization (on franchise boards, the franchisee that is hiring).
//       "Future Opening" postings carry no JSON-LD; their text is read off the page instead.
// So a board costs one request per 30 jobs plus one per job. An unknown subdomain 302s to
// app.careerplug.com; an empty board says "There are no jobs posted at this time."; a page past
// the last says the same. Closed job = gone from the list.
const { decodeEntities } = require('./html-entities');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0 Safari/537.36';
const MAX_PAGES = 40; // 1,200 jobs
// Posting pages read per board; past that a job keeps its list row only (title, location, no text).
// The set is still whole, so this does not mark the crawl capped (capped = jobs missing).
const MAX_DETAILS = 400;
const MIN_GAP_MS = Number(process.env.CAREERPLUG_GAP_MS || 750);
// The shared queue makes a big board slow (400 postings at 750 ms = 5 min), so the crawler gets a longer limit.
const fetchTimeoutMs = 30 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One queue for the whole process: every board is the same CareerPlug app, so boards take turns.
let nextAt = 0;
async function turn() {
  const now = Date.now();
  const at = Math.max(now, nextAt);
  nextAt = at + MIN_GAP_MS;
  if (at > now) await sleep(at - now);
}

// CareerPlug's own hosts, never an employer board.
const VENDOR_HOSTS = new Set(['www', 'app', 'api', 'help', 'blog', 'support', 'apply', 'jobs', 'careers']);

function slugOf(slug) {
  let s = String(slug || '').trim().toLowerCase().replace(/^[^@/]*@/, ''); // "name@host" rows
  const m = s.match(/^(?:https?:\/\/)?([a-z0-9-]+)\.careerplug\.com(?:[/?#]|$)/);
  if (m) s = m[1];
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(s) || VENDOR_HOSTS.has(s)) throw new Error(`CareerPlug HTTP 404 (not found): bad slug "${slug}"`);
  return s;
}

const baseOf = (slug) => `https://${slug}.careerplug.com`;

// GET a page, without following redirects. Returns {status, html, location}.
async function getPage(url) {
  for (let attempt = 1; ; attempt++) {
    await turn();
    let res;
    try {
      res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    } catch (e) {
      throw new Error(`CareerPlug network error (retry): ${e.message}`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await sleep(5000 * attempt); continue; }
    const html = res.status === 200 ? await res.text() : '';
    return { status: res.status, html, location: res.headers.get('location') || null };
  }
}

async function getListPage(slug, page) {
  const r = await getPage(`${baseOf(slug)}/jobs?page=${page}`);
  if (r.status === 200) return r.html;
  if (r.status === 404) throw new Error('CareerPlug HTTP 404 (not found)');
  if (r.status >= 300 && r.status < 400) {
    let host = '';
    try { host = new URL(r.location, baseOf(slug)).hostname.toLowerCase(); } catch { /* no location */ }
    // An unknown or closed board sends the visitor to CareerPlug's login app.
    if (host === 'careerplug.com' || (host.endsWith('.careerplug.com') && VENDOR_HOSTS.has(host.split('.')[0]))) {
      throw new Error('CareerPlug HTTP 404 (not found): board redirects to CareerPlug');
    }
    throw new Error(`CareerPlug HTTP ${r.status} redirect to ${host || 'nowhere'} (retry)`);
  }
  throw new Error(`CareerPlug HTTP ${r.status} (retry)`);
}

const text = (s) => decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

// "PA-Allentown-18101" -> "Allentown, PA". Anything else is kept as it reads.
function rowLocation(s) {
  const t = text(s).replace(/^Location:\s*/i, '');
  if (!t) return null;
  const m = t.match(/^([A-Z]{2})-(.+)-([A-Z0-9][A-Z0-9 ]{2,9})$/) || t.match(/^([A-Z]{2})-(.+)$/);
  return m ? `${m[2].trim()}, ${m[1]}` : t;
}

/** The job rows of one list page: [{id, title, location}], in page order. */
function parseListPage(html) {
  const rows = [];
  const seen = new Set();
  const re = /href="\/jobs\/(\d+)(?:\/apps\/new)?(?:\?[^"]*)?"/g;
  const hits = [...html.matchAll(re)];
  for (let i = 0; i < hits.length; i++) {
    const id = hits[i][1];
    if (seen.has(id)) continue;
    seen.add(id);
    // The row runs from this link to the next posting's link.
    let end = html.length;
    for (let k = i + 1; k < hits.length; k++) if (hits[k][1] !== id) { end = hits[k].index; break; }
    const chunk = html.slice(hits[i].index, Math.min(end, hits[i].index + 6000));
    const title = (chunk.match(/<span class="name">([\s\S]*?)<\/span>/) || chunk.match(/^[^>]*>([\s\S]*?)<\/a>/) || [])[1];
    const loc = (chunk.match(/class="job-location[^"]*">([\s\S]*?)<\/div>\s*<\/div>/) || chunk.match(/<span class="location">([\s\S]*?)<\/span>/) || [])[1];
    rows.push({ id, title: text(title), location: rowLocation(loc) });
  }
  return rows;
}

const hasNextPage = (html) => /<a\b[^>]*class="next_page"[^>]*href=/.test(html) || /<a\b[^>]*href="[^"]*"[^>]*class="next_page"/.test(html);
const isListPage = (html) => /id="job_filter|id="job_table"|id="job-list"/.test(html) || /no jobs posted at this time/i.test(html);

function boardMeta(html) {
  const title = (html.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
  // The employer's uploaded logo (system/logos/{id}/original|thumb/...); not company_photos, not the CareerPlug mark.
  const logo = (html.match(/https:\/\/[a-z0-9]+\.cloudfront\.net\/system\/logos\/\d+\/original\/[^"'\s?&)]+/)
    || html.match(/https:\/\/[a-z0-9]+\.cloudfront\.net\/system\/logos\/\d+\/[a-z]+\/[^"'\s?&)]+/) || [])[0];
  return { companyName: text(title) || null, logoUrl: logo || null };
}

/** The JobPosting JSON-LD of a posting page, or null. */
function parsePosting(html) {
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    let d;
    try { d = JSON.parse(m[1]); } catch { continue; }
    for (const x of Array.isArray(d) ? d : [d]) if (x && x['@type'] === 'JobPosting') return x;
  }
  return null;
}

// The <div ...> element that starts at i, through its matching </div>.
function divAt(html, i) {
  const re = /<div\b|<\/div>/g;
  re.lastIndex = i;
  let depth = 0;
  for (let m; (m = re.exec(html));) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) return html.slice(i, re.lastIndex);
  }
  return null;
}

/**
 * The posting text as the page shows it: the benefits list (when there is one) and the
 * trix-content body of div.job-description-container. "Future Opening" postings have no
 * JobPosting JSON-LD (7 of 169 on Floor Coverings International, 2026-11-15), only this.
 */
function pageDescription(html) {
  const c = html.indexOf('class="job-description-container"');
  if (c < 0) return null;
  const body = html.indexOf('<div class="trix-content">', c);
  if (body < 0) return null;
  const benefits = html.indexOf('<div class="benefits">', c);
  const parts = [benefits >= 0 && benefits < body ? divAt(html, benefits) : null, divAt(html, body)].filter(Boolean);
  const out = parts.join('\n').trim();
  return out || null;
}

const EMPLOYMENT = { FULL_TIME: 'Full-time', PART_TIME: 'Part-time', CONTRACTOR: 'Contract', TEMPORARY: 'Temporary', INTERN: 'Internship', SEASONAL: 'Seasonal', PER_DIEM: 'Per diem', VOLUNTEER: 'Volunteer' };
const INTERVAL = { HOUR: 'hour', DAY: 'day', WEEK: 'week', MONTH: 'month', YEAR: 'year' };
const amount = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);

function postingLocation(p) {
  const places = (Array.isArray(p.jobLocation) ? p.jobLocation : [p.jobLocation]).filter(Boolean);
  const out = [...new Set(places.map((pl) => {
    const a = pl.address || {};
    const country = a.addressCountry && (a.addressCountry.name || a.addressCountry);
    return [a.addressLocality, a.addressRegion, country].filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).join(', ');
  }).filter(Boolean))];
  return out.length ? out.join(' / ') : null;
}

/**
 * A list row (and its posting's JSON-LD, when it was read) as a job.
 * @param {{id: string, title: string, location: string|null}} row
 * @param {object|null} p the JobPosting JSON-LD
 * @param {string|null} pageHtml the posting text read off the page, used when the JSON-LD has none
 */
function toJob(row, slug, p, pageHtml = null) {
  p = p || {};
  const v = (p.baseSalary && p.baseSalary.value) || {};
  const min = amount(v.minValue) || amount(v.value);
  const max = amount(v.maxValue) || amount(v.value);
  const types = (Array.isArray(p.employmentType) ? p.employmentType : [p.employmentType]).filter(Boolean);
  const title = text(p.title) || row.title;
  const location = postingLocation(p) || row.location || null;
  const remote = /TELECOMMUTE/i.test(String(p.jobLocationType || ''));
  const org = p.hiringOrganization && typeof p.hiringOrganization.name === 'string' ? p.hiringOrganization.name.trim() : null;
  return {
    external_id: `careerplug_${row.id}`,
    title,
    department: null,
    location,
    workplace_type: remote ? 'remote' : null,
    employment_type: types.length ? types.map((t) => EMPLOYMENT[String(t).toUpperCase()] || String(t)).join(', ') : null,
    salary_min: min,
    salary_max: max,
    salary_currency: min || max ? (p.baseSalary && p.baseSalary.currency) || null : null,
    salary_interval: min || max ? INTERVAL[String(v.unitText || '').toUpperCase()] || null : null,
    description: (p.description ? decodeEntities(p.description).trim() : '') || pageHtml || null,
    url: `${baseOf(slug)}/jobs/${row.id}/apps/new`,
    posted_at: p.datePosted || null,
    raw_data: { id: row.id, slug, hiring_company: org || null, industry: p.industry && p.industry !== 'Unspecified' ? p.industry : null },
  };
}

async function fetchJobs(rawSlug) {
  const slug = slugOf(rawSlug);
  const rows = [];
  const seen = new Set();
  let meta = null;
  let capped = false;
  for (let page = 1; ; page++) {
    const html = await getListPage(slug, page);
    if (!isListPage(html)) throw new Error('CareerPlug unexpected page (retry)');
    if (!meta) meta = boardMeta(html);
    const got = parseListPage(html).filter((r) => !seen.has(r.id));
    for (const r of got) { seen.add(r.id); rows.push(r); }
    if (!got.length || !hasNextPage(html)) break;
    if (page >= MAX_PAGES) { capped = true; break; }
  }
  const jobs = [];
  for (let i = 0; i < rows.length; i++) {
    let posting = null;
    let pageHtml = null;
    if (i < MAX_DETAILS) {
      const r = await getPage(`${baseOf(slug)}/jobs/${rows[i].id}/apps/new`).catch(() => null);
      if (r && r.status === 200) {
        posting = parsePosting(r.html);
        if (!posting || !posting.description) pageHtml = pageDescription(r.html);
      }
    }
    jobs.push(toJob(rows[i], slug, posting, pageHtml));
  }
  return { jobs, meta: { companyName: meta.companyName, logoUrl: meta.logoUrl, capped } };
}

module.exports = { fetchJobs, toJob, slugOf, parseListPage, parsePosting, pageDescription, boardMeta, rowLocation, hasNextPage, isListPage, fetchTimeoutMs };
