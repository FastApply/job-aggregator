async function fetchJobDetail(boardSlug, jobUuid) {
  try {
    const res = await fetch(
      `https://api.rippling.com/platform/api/ats/v1/board/${encodeURIComponent(boardSlug)}/jobs/${jobUuid}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function extractDescription(desc) {
  if (!desc) return null;
  const parts = [];
  if (desc.company) parts.push(desc.company);
  if (desc.role) parts.push(desc.role);
  if (desc.compensation) parts.push(desc.compensation);
  return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * Rippling's list API returns one row per (posting, office): Rippling's own "Account Executive,
 * Enterprise, Global" is four rows (Austin, New York, "Remote (United States)", San Francisco)
 * under one uuid. Each became a job with the same external_id, so the last row won: the board
 * held it as "New York, NY", on-site, and a remote-only candidate was never shown it, nor was a
 * location check able to see the remote office (2026-11-04). One job per uuid, every place in
 * its location, remote when any place is.
 */
function groupListings(listings) {
  const byUuid = new Map();
  for (const job of listings) {
    if (!job || !job.uuid) continue;
    const label = job.workLocation?.label?.trim();
    const seen = byUuid.get(job.uuid);
    if (!seen) byUuid.set(job.uuid, { job, places: label ? [label] : [] });
    else if (label && !seen.places.includes(label)) seen.places.push(label);
  }
  return [...byUuid.values()];
}

/** The detail's own places when it lists them, else the list rows'. */
function placesOf(detail, places) {
  const fromDetail = Array.isArray(detail?.workLocations)
    ? detail.workLocations.map((p) => String(p || '').trim()).filter(Boolean)
    : [];
  return fromDetail.length ? fromDetail : places;
}

/**
 * The detail states the type ("Salaried, full-time") and the date it opened (createdOn), and the
 * adapter stored neither: every Rippling row was untyped and undated, so First Apply's 180-day
 * window counted them from first_seen_at and a full-time-only filter could not read them.
 */
function employmentTypeOf(detail) {
  const t = detail?.employmentType;
  return (t && (t.id || t.label)) || null;
}

function postedAtOf(detail) {
  const d = detail?.createdOn ? new Date(detail.createdOn) : null;
  return d && Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function toJob(clientname, job, places, detail) {
  const where = placesOf(detail, places);
  const remote = where.some((p) => /^remote\b/i.test(p));
  return {
    external_id: `rippling_${job.uuid}`,
    title: job.name,
    department: job.department?.label || null,
    location: where.join('; ') || 'Remote',
    workplace_type: remote ? 'remote' : null,
    employment_type: employmentTypeOf(detail),
    salary_min: null,
    salary_max: null,
    salary_currency: null,
    salary_interval: null,
    description: extractDescription(detail?.description) || null,
    url: job.url || `https://ats.rippling.com/${encodeURIComponent(clientname)}/jobs/${job.uuid}`,
    posted_at: postedAtOf(detail),
    raw_data: job,
  };
}

async function fetchJobs(clientname) {
  const res = await fetch(`https://api.rippling.com/platform/api/ats/v1/board/${encodeURIComponent(clientname)}/jobs`);
  if (!res.ok) throw new Error(`Rippling HTTP ${res.status}`);
  const data = await res.json();
  const listings = groupListings(Object.values(data));

  const jobs = [];

  // Fetch details in batches of 5
  for (let i = 0; i < listings.length; i += 5) {
    const batch = listings.slice(i, i + 5);
    const settled = await Promise.allSettled(
      batch.map(({ job }) => fetchJobDetail(clientname, job.uuid))
    );
    const details = settled.map(r => r.status === 'fulfilled' ? r.value : null);
    for (let j = 0; j < batch.length; j++) {
      jobs.push(toJob(clientname, batch[j].job, batch[j].places, details[j]));
    }
  }

  return { jobs, meta: {} };
}

module.exports = { fetchJobs, groupListings, toJob };
