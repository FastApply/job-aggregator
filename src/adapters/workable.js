const logger = require('../logger');

const MAX_PAGES = parseInt(process.env.WORKABLE_MAX_PAGES || '200'); // 10 jobs a page
// Workable (Cloudflare) blocks an IP that sends too much: on 2026-10-20 the VPS's IPv4 got a 429
// with Retry-After ~16 h on every apply.workable.com URL. The crawler had been sending ~2 requests a
// second around the clock (a list + a widget call per company, re-crawled hourly, and an instant
// retry after each 429). So: at least WORKABLE_MIN_GAP_MS between any two requests from this process
// (~21k a day at 4 s — a full pass of ~10k boards in about half a day), and a block is waited out.
const MIN_GAP_MS = parseInt(process.env.WORKABLE_MIN_GAP_MS || '4000');
const MAX_BLOCK_WAIT_MS = parseInt(process.env.WORKABLE_MAX_BLOCK_WAIT_MS || '3600000');
const DEFAULT_BLOCK_WAIT_MS = parseInt(process.env.WORKABLE_BLOCK_WAIT_MS || '300000');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let nextSlot = 0;
let blockedUntil = 0;
async function paced(fn) {
  const now = Date.now();
  const at = Math.max(now, nextSlot, blockedUntil);
  nextSlot = at + MIN_GAP_MS;
  if (at > now) await sleep(at - now);
  return fn();
}

// The crawler calls this before starting a company's timed fetch, so waiting out a block is not
// counted against the fetch timeout (and doesn't turn every claimed company into a timeout).
async function waitUntilReady() {
  const ms = blockedUntil - Date.now();
  if (ms > 0) await sleep(ms);
}
// Paging is paced, so a big board needs longer than the crawler's default fetch timeout
// (392 jobs = 40 pages = ~160 s at 4 s a request).
const fetchTimeoutMs = MAX_PAGES * MIN_GAP_MS + 60000;

// How long a 429/403 asks us to stay away: its Retry-After (seconds), else a default; capped so the
// crawler still probes once an hour and notices when the block lifts.
function blockWaitMs(res) {
  const ra = parseInt(res.headers && res.headers.get ? res.headers.get('retry-after') : '', 10);
  const ms = Number.isFinite(ra) && ra > 0 ? ra * 1000 : DEFAULT_BLOCK_WAIT_MS;
  return Math.min(ms, MAX_BLOCK_WAIT_MS);
}

// The v3 list returns 10 jobs a page and a `nextPage` token; the token goes back as `{ token }`.
// Reading only the first page silently dropped every job past the tenth.
async function fetchListings(clientname, fetchImpl = fetch) {
  const listings = [];
  let token = null;
  let capped = false;
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) { capped = true; break; }
    const res = await paced(() => fetchImpl(
      `https://apply.workable.com/api/v3/accounts/${encodeURIComponent(clientname)}/jobs`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(token ? { token } : {}),
        signal: AbortSignal.timeout(15000),
      }
    ));
    // A block: no request leaves this process until it lifts (every later call waits in paced()).
    // The error stays transient, so the company is retried and its jobs are untouched.
    if (res.status === 429 || res.status === 403) {
      const wait = blockWaitMs(res);
      blockedUntil = Date.now() + wait;
      throw new Error(`Workable rate limited (${res.status}), pausing ${Math.round(wait / 60000)} min — will retry next cycle`);
    }
    if (!res.ok) throw new Error(`Workable HTTP ${res.status}`);
    const data = await res.json();
    const seen = new Set(listings.map((l) => l.shortcode));
    for (const l of data.results || []) if (!seen.has(l.shortcode)) listings.push(l);
    token = data.nextPage;
    if (!token || !(data.results || []).length) break;
  }
  return { listings, capped };
}

async function fetchJobs(clientname) {
  // v3 API, paged — no detail calls during sync.
  // Descriptions come from the backfill task to avoid rate limiting
  const { listings, capped } = await fetchListings(clientname);

  const jobs = listings.map(listing => {
    const loc = listing.location || {};
    return {
      external_id: `workable_${listing.shortcode}`,
      title: listing.title,
      department: listing.department?.[0] || null,
      location: [loc.city, loc.region, loc.country].filter(Boolean).join(', ') || 'Remote',
      workplace_type: listing.remote ? 'Remote' : (listing.workplace || null),
      employment_type: listing.type === 'full' ? 'Full-time' : listing.type === 'part' ? 'Part-time' : listing.type || null,
      salary_min: null,
      salary_max: null,
      salary_currency: null,
      salary_interval: null,
      description: null,
      url: `https://apply.workable.com/${encodeURIComponent(clientname)}/j/${listing.shortcode}/`,
      posted_at: listing.published || null,
      raw_data: listing,
    };
  });

  // Name and logo are not fetched here: that doubled the requests per crawl, and the only caller
  // that uses them (sync.queue) asks fetchCompanyMeta separately.
  return { jobs, meta: { capped } };
}

async function fetchCompanyMeta(clientname) {
  // Try widget API first — returns S3 logo URL
  try {
    const res = await fetch(
      `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(clientname)}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (res.ok) {
      const data = await res.json();
      if (data.logo) return { companyName: data.name || null, logoUrl: data.logo };
    }
  } catch {}

  // Fallback: scrape the careers page for workablehr S3 logo
  try {
    const res = await fetch(`https://apply.workable.com/${encodeURIComponent(clientname)}/`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const html = await res.text();
      const match = html.match(/https:\/\/workablehr\.s3[^"'\s]*logo[^"'\s]*/);
      if (match) return { companyName: null, logoUrl: match[0] };
    }
  } catch {}

  return null;
}

module.exports = {
  fetchJobs, fetchListings, fetchCompanyMeta, waitUntilReady, fetchTimeoutMs,
  _reset: () => { nextSlot = 0; blockedUntil = 0; },
};
