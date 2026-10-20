const logger = require('../logger');

const PAGE_DELAY_MS = parseInt(process.env.WORKABLE_PAGE_DELAY_MS || '300');
const MAX_PAGES = parseInt(process.env.WORKABLE_MAX_PAGES || '200'); // 10 jobs a page
const BLOCK_PAUSE_MS = parseInt(process.env.WORKABLE_BLOCK_PAUSE_MS || '60000');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The v3 list returns 10 jobs a page and a `nextPage` token; the token goes back as `{ token }`.
// Reading only the first page silently dropped every job past the tenth.
async function fetchListings(clientname, fetchImpl = fetch) {
  const listings = [];
  let token = null;
  let capped = false;
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) { capped = true; break; }
    if (page) await sleep(PAGE_DELAY_MS);
    const res = await fetchImpl(
      `https://apply.workable.com/api/v3/accounts/${encodeURIComponent(clientname)}/jobs`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(token ? { token } : {}),
        signal: AbortSignal.timeout(15000),
      }
    );
    // Workable answers a burst from one IP with 429 or 403 (the same accounts load fine minutes
    // later). Pause this crawler before failing so the next company doesn't hit the block too;
    // the error stays transient, so the company is retried and its jobs are untouched.
    if (res.status === 429 || res.status === 403) {
      if (BLOCK_PAUSE_MS) await sleep(BLOCK_PAUSE_MS);
      throw new Error(`Workable rate limited (${res.status}) — will retry next cycle`);
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

  // Logo from v1 widget
  let companyName = null;
  let logoUrl = null;
  try {
    const widgetRes = await fetch(
      `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(clientname)}`,
      { signal: AbortSignal.timeout(3000) }
    );
    if (widgetRes.ok) {
      const widget = await widgetRes.json();
      companyName = widget.name || null;
      logoUrl = widget.logo || null;
    }
  } catch {}

  return { jobs, meta: { companyName, logoUrl, capped } };
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

module.exports = { fetchJobs, fetchListings, fetchCompanyMeta };
