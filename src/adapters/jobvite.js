/**
 * Jobvite career sites — https://jobs.jobvite.com/{slug}
 *
 * Unusually friendly for an HTML board: the listing page server-renders every posting (no
 * pagination, no JS execution, no auth), and each detail page carries a schema.org JobPosting
 * block in ld+json. So the structured fields — title, description, datePosted, employmentType,
 * department, location, salary — are read from JSON rather than scraped out of markup, and only
 * the id/title/location index has to be parsed from HTML.
 *
 * The public partner API (api.jobvite.com/api/v2/job) is NOT used: it answers
 * 401 "Invalid api/secret" without per-customer credentials we do not have.
 */
const logger = require('../logger');

const BASE = 'https://jobs.jobvite.com';
const DETAIL_BATCH_SIZE = 5;

// Jobvite fronts its career sites with Cloudflare, which serves a challenge to bare scripted
// requests. A normal browser UA is enough; nothing else is required.
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Titles come out of markup, so entities have to be decoded. Deliberately NOT utils/stripHtml,
// which also strips tags — a title is already plain text and stripping would be a no-op that
// hides a real "<" in a title like "Engineer <Contract>".
function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "United States, United States" -> "United States". Order-preserving, case-insensitive. */
function dedupeSegments(s) {
  const seen = new Set();
  return String(s || '').split(',').map((p) => p.trim()).filter((p) => {
    if (!p) return false;
    const k = p.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).join(', ');
}

/**
 * Parse the listing index into [{ id, title, location, department }].
 *
 * Shape: one <table class="jv-job-list"> per department, preceded by an <h3> naming it. Rows are
 *   <td class="jv-job-list-name"><a href="/{slug}/job/{id}">{title}</a></td>
 *   <td class="jv-job-list-location">{location}</td>
 * where the location cell is either bare text or a <div class="jv-meta">N Locations</div>
 * placeholder for multi-site postings — that placeholder is not a location, so it is dropped and
 * the real values are taken from the detail page's JSON-LD instead.
 */
function parseListing(html, slug) {
  const out = [];
  const linkRe = new RegExp(
    `<td[^>]*class="[^"]*jv-job-list-name[^"]*"[^>]*>\\s*<a[^>]*href="/${slug}/job/([a-zA-Z0-9]+)"[^>]*>([\\s\\S]*?)</a>`
    + `[\\s\\S]*?<td[^>]*class="[^"]*jv-job-list-location[^"]*"[^>]*>([\\s\\S]*?)</td>`,
    'gi'
  );
  // Department headings sit between tables, so track the most recent one by position.
  const headings = [...html.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/gi)]
    .map((m) => ({ at: m.index, text: decodeEntities(m[1].replace(/<[^>]+>/g, '')) }));

  for (const m of html.matchAll(linkRe)) {
    const rawLoc = m[3];
    // Jobvite renders an empty city as a repeat of the country, so the cell arrives as
    // "United States, United States" on real boards. Dedupe segments rather than storing that.
    const location = /jv-meta/i.test(rawLoc)
      ? null // "2 Locations" placeholder — resolved from JSON-LD
      : dedupeSegments(decodeEntities(rawLoc.replace(/<[^>]+>/g, ''))) || null;
    const dept = headings.filter((h) => h.at < m.index).pop();
    out.push({
      id: m[1],
      title: decodeEntities(m[2].replace(/<[^>]+>/g, '')),
      location,
      department: dept ? dept.text : null,
    });
  }
  return out;
}

// Where the description block ends. Checked in order; the earliest match after the opening div
// wins, so a tenant that omits one of these still terminates at the next.
const DESC_TERMINATORS = [
  '<div class="jv-share-widget', '<div class="jv-job-detail-bottom',
  '<p class="jv-powered-by', '<div class="jv-footer', '</article>',
];

/**
 * Fallback for tenants that serve no JSON-LD.
 *
 * Not every Jobvite career site emits a JobPosting block — uplight and ookla do, nutanix does
 * not, and its detail pages are a perfectly good 72KB of HTML with a 7,704-character
 * description in them. Without this, those tenants yield a job with no description and no
 * company name, which is exactly the three biggest boards discovery found (jbs 345 jobs,
 * nutanix 103, legalzoom 16).
 *
 * Deliberately narrow: it returns ONLY description, company and title. Location and department
 * are already carried by the listing index and are parsed reliably there, whereas the detail
 * page packs them into a separator-delimited <p> whose field order is not guaranteed across
 * tenants — guessing at that would mislabel a department as a location.
 *
 * Shaped like a JobPosting so callers cannot tell the two sources apart.
 */
function parseDetailHtml(html) {
  const start = html.search(/<div[^>]*class="[^"]*jv-job-detail-description[^"]*"[^>]*>/i);
  let description = null;
  if (start !== -1) {
    const from = html.indexOf('>', start) + 1;
    let end = html.length;
    for (const t of DESC_TERMINATORS) {
      const at = html.indexOf(t, from);
      if (at !== -1 && at < end) end = at;
    }
    // HTML comments have to go first: this block is served with the previous revision of the
    // posting commented out ahead of the live copy ("<!-- removed ===== ... -->"), which would
    // otherwise be concatenated into the description as duplicate text.
    const body = html.slice(from, end).replace(/<!--[\s\S]*?-->/g, '').trim();
    if (body.replace(/<[^>]+>/g, '').trim().length > 50) description = body;
  }

  // "<title>Nutanix Careers - Senior Engineering Manager</title>" -> company + title.
  const titleTag = (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const m = decodeEntities(titleTag).match(/^(.*?)\s+Careers\s*-\s*(.*)$/i);

  if (!description && !m) return null;
  return {
    description,
    hiringOrganization: m ? m[1].trim() : null,
    title: m ? m[2].trim() : null,
  };
}

/** Pull the schema.org JobPosting out of a detail page, or null. */
function parseJobPosting(html) {
  const blocks = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const b of blocks) {
    try {
      const data = JSON.parse(b[1].trim());
      for (const node of Array.isArray(data) ? data : [data]) {
        if (node && node['@type'] === 'JobPosting') return node;
      }
    } catch { /* a malformed block must not lose the others */ }
  }
  return null;
}

/** "Pune, Maharashtra, India" from a schema.org Place. */
function formatPlace(place) {
  const a = place?.address || {};
  return [a.addressLocality, a.addressRegion, a.addressCountry].filter(Boolean).join(', ') || null;
}

/**
 * Pick the most specific of several formatted locations.
 *
 * Jobvite does NOT order jobLocation by specificity — real postings come back as
 * ["India", "Pune, Maharashtra, India"] and ["United States", "Boulder, Colorado, United
 * States"], so taking the first would file a Boulder job under "United States" and lose the
 * city. Component count is the ranking: "city, region, country" beats a bare country.
 */
function mostSpecific(locations) {
  return locations.reduce((best, cur) => {
    if (!best) return cur;
    return cur.split(',').length > best.split(',').length ? cur : best;
  }, null);
}

/**
 * Jobvite emits baseSalary as a MonetaryAmount whose fields are EMPTY STRINGS when unset, not
 * absent — `{currency: "", value: {minValue: "", maxValue: ""}}`. Coercing those blindly yields
 * salary_min "0" / NaN on every job that lists no pay, so empties are mapped to null.
 */
function parseSalary(baseSalary) {
  const v = baseSalary?.value || {};
  const num = (x) => {
    const n = parseFloat(String(x ?? '').replace(/[,\s]/g, ''));
    return Number.isFinite(n) && n > 0 ? String(n) : null;
  };
  const interval = String(v.unitText || '').toLowerCase() || null;
  return {
    salary_min: num(v.minValue),
    salary_max: num(v.maxValue),
    salary_currency: baseSalary?.currency || null,
    salary_interval: interval && interval !== '' ? interval : null,
  };
}

// Jobvite exposes no workplace-type field, so it is inferred from the text we do have — and only
// when the wording is unambiguous, leaving null rather than guessing.
function inferWorkplace(title, location) {
  const s = `${title || ''} ${location || ''}`.toLowerCase();
  if (/\bhybrid\b/.test(s)) return 'hybrid';
  if (/\bremote\b|\bwork from home\b|\bwfh\b/.test(s)) return 'remote';
  return null;
}

async function fetchDetail(slug, id) {
  try {
    const res = await fetch(`${BASE}/${encodeURIComponent(slug)}/job/${encodeURIComponent(id)}`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    return parseJobPosting(html) || parseDetailHtml(html);
  } catch {
    return null;
  }
}

async function fetchJobs(clientname) {
  const slug = String(clientname || '').trim();
  const res = await fetch(`${BASE}/${encodeURIComponent(slug)}`, {
    headers: HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Jobvite HTTP ${res.status}`);

  // An unknown slug does not 404 — Jobvite redirects it to the marketing homepage and serves a
  // 200. Without this check every bad slug would look like a real board with zero openings, and
  // the sync would read that as "this company closed all its jobs" rather than "this slug is
  // wrong". The tell is leaving the jobs.jobvite.com host.
  const finalHost = (() => { try { return new URL(res.url).hostname; } catch { return ''; } })();
  if (finalHost && finalHost !== 'jobs.jobvite.com') {
    throw new Error(`Jobvite slug not found (redirected to ${finalHost})`);
  }

  const html = await res.text();
  const listings = parseListing(html, slug);
  if (!listings.length) return { jobs: [], meta: { companyName: null } };

  const jobs = [];
  let companyName = null;

  for (let i = 0; i < listings.length; i += DETAIL_BATCH_SIZE) {
    const batch = listings.slice(i, i + DETAIL_BATCH_SIZE);
    const settled = await Promise.allSettled(batch.map((l) => fetchDetail(slug, l.id)));
    const details = settled.map((r) => (r.status === 'fulfilled' ? r.value : null));

    for (let k = 0; k < batch.length; k++) {
      const l = batch[k];
      const d = details[k];
      if (d?.hiringOrganization && !companyName) {
        companyName = typeof d.hiringOrganization === 'string'
          ? d.hiringOrganization
          : d.hiringOrganization.name || null;
      }

      // The schema allows one Place or many. Our schema stores a single string, so the most
      // specific one becomes `location` and the rest stay in raw_data rather than being
      // concatenated into something no location filter can match.
      const places = Array.isArray(d?.jobLocation) ? d.jobLocation
        : d?.jobLocation ? [d.jobLocation] : [];
      const formatted = [...new Set(places.map(formatPlace).filter(Boolean))];
      const location = mostSpecific(formatted) || l.location || null;

      const title = decodeEntities(d?.title) || l.title;

      jobs.push({
        external_id: `jobvite_${l.id}`,
        title,
        department: l.department || d?.industry || null,
        location,
        workplace_type: inferWorkplace(title, location),
        employment_type: d?.employmentType || null,
        ...parseSalary(d?.baseSalary),
        description: d?.description || null,
        url: `${BASE}/${slug}/job/${l.id}`,
        posted_at: d?.datePosted || null,
        raw_data: { ...l, locations: formatted, jobPosting: d || null },
      });
    }
  }

  const missing = jobs.filter((j) => !j.description).length;
  if (missing) logger.warn({ slug, missing, total: jobs.length }, 'Jobvite: postings without a description');

  return { jobs, meta: { companyName } };
}

module.exports = { fetchJobs };
