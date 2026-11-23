const DETAIL_BATCH_SIZE = 5;

// Breezy exposes salary only as free text (e.g. "$90,000 – $120,000 / year", "€45k/year").
// Parse min/max/currency/interval best-effort; return {} when it isn't a usable range.
function parseBreezySalary(s) {
  const empty = { salary_min: null, salary_max: null, salary_currency: null, salary_interval: null };
  if (!s || typeof s !== 'string') return empty;
  const currency = /€|eur/i.test(s) ? 'EUR' : /£|gbp/i.test(s) ? 'GBP' : /\$|usd/i.test(s) ? 'USD' : null;
  const interval = /year|annum|\/yr|annual/i.test(s) ? 'year' : /hour|\/hr/i.test(s) ? 'hour'
    : /month/i.test(s) ? 'month' : /day/i.test(s) ? 'day' : null;
  const nums = (s.match(/\d[\d,.]*\s*[kK]?/g) || []).map((n) => {
    const k = /k/i.test(n);
    const v = parseFloat(n.replace(/[,\s kK]/g, ''));
    return isNaN(v) ? null : (k ? v * 1000 : v);
  }).filter((v) => v != null);
  if (!nums.length) return empty;
  return {
    salary_min: String(nums[0]),
    salary_max: nums.length > 1 ? String(nums[1]) : null,
    salary_currency: currency,
    salary_interval: interval,
  };
}

/**
 * Fetch a single job's detail page and extract description + logo.
 */
/**
 * Breezy's own work-mode setting. Breezy sets is_remote for "Hybrid (Some remote, some in person)"
 * too (remote_details.value "hybrid"), so a hybrid posting was stored remote: Precision's "Executive
 * Assistant & Office Manager (DC Office)", hybrid in Washington, DC, went to a remote-only candidate
 * in Connecticut (FastApply pref-match, 2026-11-19).
 */
function workplaceOf(location) {
  if (!location) return null;
  if (location.remote_details?.value === 'hybrid') return 'hybrid';
  return location.is_remote ? 'remote' : null;
}

/**
 * The posting's own text from its page: the `<div class="description">` Breezy renders, inner HTML
 * kept. Read when the page carries no JSON-LD JobPosting. Some Breezy pages ship none, and the
 * description backfill then kept only the 300-character og:description: Committee for Children's
 * "Senior Revenue Operations Manager" reached FastApply's matcher as one paragraph, without "This
 * position is remote; employees are eligible to work remotely in any of the following states: ...
 * TX ...", and was refused on Location for a candidate in Houston (FastApply supply loop,
 * 2026-11-23 06h). 443 of 7,004 sampled Breezy rows held 300 characters or fewer.
 */
function breezyPageDescription(html) {
  const open = /<div[^>]*\bclass="description"[^>]*>/i.exec(String(html || ''));
  if (!open) return null;
  const start = open.index + open[0].length;
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = start;
  let depth = 1;
  let m;
  while ((m = tags.exec(html)) !== null) {
    depth += m[0][1] === '/' ? -1 : 1;
    if (depth === 0) {
      const inner = html.slice(start, m.index).trim();
      return inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().length > 100 ? inner : null;
    }
  }
  return null;
}

async function fetchJobDetail(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const html = await res.text();

    // Extract description from JSON-LD (find JobPosting, not WebSite)
    let description = null;
    const ldRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
    let ldMatch;
    while ((ldMatch = ldRegex.exec(html)) !== null) {
      try {
        const ld = JSON.parse(ldMatch[1]);
        if (ld['@type'] === 'JobPosting' && ld.description) {
          description = ld.description;
          break;
        }
      } catch { /* invalid JSON-LD */ }
    }
    if (!description) description = breezyPageDescription(html);

    // Extract company logo from gallery CDN
    let logoUrl = null;
    const logoMatch = html.match(/https:\/\/gallery-cdn\.breezy\.hr\/[^"'\s]+/);
    if (logoMatch) logoUrl = logoMatch[0];

    return { description, logoUrl };
  } catch {
    return null;
  }
}

async function fetchJobs(clientname) {
  const res = await fetch(
    `https://${encodeURIComponent(clientname)}.breezy.hr/json`,
    { signal: AbortSignal.timeout(10000), redirect: 'manual' }
  );

  // Breezy returns 302 redirect to marketing page for inactive companies
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`Breezy: company "${clientname}" no longer exists (redirect)`);
  }
  if (!res.ok) throw new Error(`Breezy HTTP ${res.status}`);

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('json')) {
    throw new Error(`Breezy: company "${clientname}" returned HTML instead of JSON`);
  }

  const data = await res.json();
  const listings = Array.isArray(data) ? data : [];

  const jobs = [];
  let logoUrl = null;

  // Fetch details in batches
  for (let i = 0; i < listings.length; i += DETAIL_BATCH_SIZE) {
    const batch = listings.slice(i, i + DETAIL_BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map(job => {
        const url = job.url || `https://${encodeURIComponent(clientname)}.breezy.hr/p/${job.friendly_id}`;
        return fetchJobDetail(url);
      })
    );
    const details = settled.map(r => r.status === 'fulfilled' ? r.value : null);

    for (let j = 0; j < batch.length; j++) {
      const job = batch[j];
      const detail = details[j];

      if (!logoUrl && detail?.logoUrl) logoUrl = detail.logoUrl;

      jobs.push({
        external_id: `breezy_${job.id || job.friendly_id}`,
        title: job.name,
        department: job.department || null,
        location: job.location?.name || job.location?.city || null,
        workplace_type: workplaceOf(job.location),
        employment_type: job.type?.name || null,
        ...parseBreezySalary(job.salary), // breezy gives salary as free text, e.g. "$90,000 – $120,000 / year"
        description: detail?.description || null,
        url: job.url || `https://${encodeURIComponent(clientname)}.breezy.hr/p/${job.friendly_id}`,
        posted_at: job.published_date || null,
        raw_data: job,
      });
    }
  }

  const company = data[0]?.company || {};

  return {
    jobs,
    meta: {
      companyName: company.name || null,
      logoUrl: logoUrl || null,
    },
  };
}

module.exports = { fetchJobs, workplaceOf, breezyPageDescription };
