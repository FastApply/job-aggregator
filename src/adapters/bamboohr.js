const DETAIL_BATCH_SIZE = 5;

// BambooHR publishes compensation as free text ("$17.00+", "$90k–$120k / year").
// Parse best-effort into min/max/currency/interval; {} if not a usable amount.
function parseComp(s) {
  const empty = { salary_min: null, salary_max: null, salary_currency: null, salary_interval: null };
  if (!s || typeof s !== 'string') return empty;
  const currency = /€|eur/i.test(s) ? 'EUR' : /£|gbp/i.test(s) ? 'GBP' : /\$|usd/i.test(s) ? 'USD' : null;
  const interval = /year|annum|annual|\/yr/i.test(s) ? 'year' : /hour|\/hr/i.test(s) ? 'hour'
    : /month/i.test(s) ? 'month' : /day/i.test(s) ? 'day' : null;
  const nums = (s.match(/\d[\d,.]*\s*[kK]?/g) || []).map((n) => {
    const k = /k/i.test(n); const v = parseFloat(n.replace(/[,\s kK]/g, ''));
    return isNaN(v) ? null : (k ? v * 1000 : v);
  }).filter((v) => v != null);
  if (!nums.length) return empty;
  return { salary_min: String(nums[0]), salary_max: nums.length > 1 ? String(nums[1]) : null, salary_currency: currency, salary_interval: interval };
}

// A posting's place. `location` is the office; a role with no office (locationType "1")
// leaves it empty and names the place only in `atsLocation`. Reading the first alone lost
// the place on 10,261 live rows, and the empty ones then read as open worldwide: swaarm's
// Kuala Lumpur sales role went to a candidate in Romania (2026-10-31).
function locationOf(detail, listing) {
  const office = detail?.location || listing?.location || {};
  const parts = [office.city, office.state, office.addressCountry].filter(Boolean);
  if (parts.length) return parts.join(', ');
  const ats = detail?.atsLocation || listing?.atsLocation || {};
  const named = [ats.city, ats.state || ats.province, ats.country].filter(Boolean);
  return named.filter((part, i) => part !== named[i - 1]).join(', ') || null;
}

async function fetchJobDetail(company, jobId) {
  try {
    const res = await fetch(
      `https://${company}.bamboohr.com/careers/${jobId}/detail`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.result?.jobOpening || null;
  } catch {
    return null;
  }
}

async function fetchJobs(clientname) {
  const res = await fetch(
    `https://${encodeURIComponent(clientname)}.bamboohr.com/careers/list`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) throw new Error(`BambooHR HTTP ${res.status}`);
  const data = await res.json();

  const listings = data.result || [];
  if (listings.length === 0) return { jobs: [], meta: {} };

  // Fetch details in batches for descriptions
  const jobs = [];

  for (let i = 0; i < listings.length; i += DETAIL_BATCH_SIZE) {
    const batch = listings.slice(i, i + DETAIL_BATCH_SIZE);
    const settled = await Promise.allSettled(
      batch.map(j => fetchJobDetail(clientname, j.id))
    );
    const details = settled.map(r => r.status === 'fulfilled' ? r.value : null);

    for (let k = 0; k < batch.length; k++) {
      const listing = batch[k];
      const detail = details[k];

      // Determine workplace type from locationType, isRemote flag, or department name
      const locType = detail?.locationType || listing.locationType;
      const isRemote = listing.isRemote
        || locType === '3'
        || (listing.departmentLabel || '').toLowerCase().includes('remote');
      const isHybrid = locType === '2';
      const workplaceType = isRemote ? 'remote' : isHybrid ? 'hybrid' : null;

      // Filter out non-employment-type values like "Active", "Inactive"
      const rawEmpType = detail?.employmentStatusLabel || listing.employmentStatusLabel || '';
      const invalidEmpTypes = ['active', 'inactive', 'open', 'closed'];
      const employmentType = invalidEmpTypes.includes(rawEmpType.toLowerCase())
        ? null : (rawEmpType || null);

      jobs.push({
        external_id: `bamboohr_${listing.id}`,
        title: listing.jobOpeningName,
        department: listing.departmentLabel || null,
        location: locationOf(detail, listing),
        workplace_type: workplaceType,
        employment_type: employmentType,
        // BambooHR gives compensation as free text (e.g. "$17.00+", "$90k-$120k/year").
        ...parseComp(detail?.compensation),
        description: detail?.description || null,
        url: detail?.jobOpeningShareUrl || `https://${clientname}.bamboohr.com/careers/${listing.id}`,
        posted_at: detail?.datePosted || null,
        raw_data: listing,
      });
    }
  }

  return { jobs, meta: { companyName: null } };
}

module.exports = { fetchJobs, locationOf };
