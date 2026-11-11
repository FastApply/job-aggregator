const { NAME, countriesFromLocation } = require('../utils/location-countries');

/**
 * Where a remote offer is open, from Recruitee's own location list.
 *
 * WHY. Recruitee writes the label "Remote job" (or the account's word for it, "Homeoffice") into
 * `location` on every remote offer and keeps the place in `locations[]` / `country_code`. The
 * label named no country, so a remote offer read as open anywhere: seven of one remote-only US
 * candidate's First Apply submissions in six hours went to Recruitee roles in Belgium (Luzmo),
 * Germany (ITQ, Quantum Systems, Dr. Rosenfeld), Spain and Italy (seQura), Australia (Zensai)
 * and Bolivia/Chile/Colombia (Talentsam) (verdict audit, 2026-11-11 20h). The countries only,
 * not the towns: a remote role is open across the country the employer names, and a town
 * (often the head office) would read as a commute.
 *
 * `location` unchanged unless the offer is remote, the label names no country, and the list
 * names at least one.
 */
function remotePlace(job) {
  const label = typeof job.location === 'string' ? job.location.trim() : '';
  if (!job.remote || (label && countriesFromLocation(label).length > 0)) return job.location || null;
  const codes = [];
  const entries = Array.isArray(job.locations) && job.locations.length ? job.locations : [job];
  for (const l of entries) {
    const code = String(l?.country_code || '').trim().toLowerCase();
    if (code.length === 2 && NAME.has(code) && !codes.includes(code)) codes.push(code);
  }
  if (!codes.length) return job.location || null;
  return `Remote - ${codes.map(c => NAME.get(c)).join('; ')}`;
}

/**
 * Recruitee adapter. Public JSON feed: {slug}.recruitee.com/api/offers
 * One call returns all published offers with full descriptions — no per-job fetch.
 */
async function fetchJobs(clientname) {
  const res = await fetch(
    `https://${encodeURIComponent(clientname)}.recruitee.com/api/offers`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) throw new Error(`Recruitee HTTP ${res.status}`);

  // Dead/closed accounts redirect to a marketing page (HTML). Guard so res.json()
  // doesn't throw an opaque parse error.
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('json')) {
    throw new Error(`Recruitee: "${clientname}" returned non-JSON (${contentType || 'unknown'})`);
  }

  const data = await res.json();
  const jobs = (data.offers || []).map(job => ({
    external_id: `recruitee_${job.id}`,
    title: job.title,
    department: job.department || null,
    location: remotePlace(job) || [job.city, job.country].filter(Boolean).join(', ') || null,
    workplace_type: job.remote ? 'remote' : (job.hybrid ? 'hybrid' : (job.on_site ? 'onsite' : null)),
    employment_type: job.employment_type_code || null,
    // Salary is a nested object {min,max,currency,period} — the old flat paths (job.min_salary…)
    // never existed, so salary was always null.
    salary_min: job.salary?.min || null,
    salary_max: job.salary?.max || null,
    salary_currency: job.salary?.currency || null,
    salary_interval: job.salary?.period || null,
    description: job.description || null,
    url: job.careers_url || `https://${encodeURIComponent(clientname)}.recruitee.com/o/${job.slug || job.id}`,
    posted_at: job.published_at || null,
    raw_data: job,
  }));

  return {
    jobs,
    meta: {
      companyName: data.company?.name || null,
      logoUrl: data.company?.logo_url || null,
    },
  };
}

module.exports = { fetchJobs, remotePlace };
