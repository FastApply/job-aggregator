const { withCountry } = require('../utils/place-country');

/**
 * One place Ashby lists, with the country its own address field names ("Berlin Office"): without
 * it the posting was in no country search (place-country.js). A bare town also takes its region
 * from the address ("Portland" + Oregon), so a town several states share is not left to a guess.
 */
function placeOf(location, address) {
  const text = typeof location === 'string' ? location.trim() : '';
  if (!text) return null;
  const pa = (address && address.postalAddress) || {};
  const town = String(pa.addressLocality || '').trim();
  const region = String(pa.addressRegion || '').trim();
  const named = town && region && !text.includes(',') && text.toLowerCase() === town.toLowerCase() &&
    region.toLowerCase() !== town.toLowerCase() ? `${text}, ${region}` : text;
  return withCountry(named, { name: pa.addressCountry }) || named;
}

/**
 * Every place the employer lists for the posting: the primary one, then Ashby's
 * `secondaryLocations`, joined with "; " as the oracle and rippling adapters do.
 *
 * WHY. Only the primary was stored. 7,723 of 44,255 postings on 1,292 sampled Ashby boards list
 * more places (17.5%; 2,993 of them in another country), and a search for any of those places
 * never found them: Scribd's remote "Senior Software Engineer, Core Infrastructure" lists New York
 * City among 21 places but was stored as "San Francisco, United States", and FastApply measured it
 * from San Francisco and refused it, 2,566 miles from a candidate in New York (FastApply supply
 * loop 2026-11-21 12h: on those boards, the place filters of 59 starved searches match 6,747
 * on-title postings instead of 6,218). The primary keeps its old text, so a posting with no other
 * place is stored exactly as before.
 */
function locationOf(job) {
  const primary = withCountry(job.location, { name: job.address?.postalAddress?.addressCountry });
  const more = (Array.isArray(job.secondaryLocations) ? job.secondaryLocations : [])
    .map((l) => placeOf(l && l.location, l && l.address))
    .filter(Boolean);
  if (more.length === 0) return primary || 'Remote';
  const all = [...new Set([primary, ...more].map((p) => (typeof p === 'string' ? p.trim() : '')).filter(Boolean))];
  return all.join('; ') || 'Remote';
}

async function fetchJobs(clientname) {
  const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(clientname)}?includeCompensation=true`);
  if (!res.ok) throw new Error(`Ashby HTTP ${res.status}`);
  const data = await res.json();
  const jobs = (data.jobs || []).map(job => {
    const comp = job.compensation;
    return {
      external_id: `ashby_${job.id}`,
      title: job.title,
      department: job.department || job.team || null,
      location: locationOf(job),
      workplace_type: job.workplaceType || null,
      employment_type: job.employmentType || null,
      salary_min: comp?.compensationTierSummary?.[0]?.min || null,
      salary_max: comp?.compensationTierSummary?.[0]?.max || null,
      salary_currency: comp?.compensationTierSummary?.[0]?.currency || null,
      salary_interval: comp?.compensationTierSummary?.[0]?.interval || null,
      description: job.descriptionHtml || job.descriptionPlain || null,
      url: job.jobUrl,
      posted_at: job.publishedAt || null,
      raw_data: job,
    };
  });

  return {
    jobs,
    meta: {
      companyName: data.organizationName || null,
      logoUrl: data.organizationLogo || null,
    },
  };
}

async function fetchCompanyMeta(clientname) {
  // First try the posting API which may have the logo
  try {
    const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(clientname)}`);
    if (res.ok) {
      const data = await res.json();
      if (data.organizationLogo) return { companyName: data.organizationName, logoUrl: data.organizationLogo };
    }
  } catch {}

  // Fallback: scrape the hosted page for org-theme-logo or org-theme-social images
  try {
    const res = await fetch(`https://jobs.ashbyhq.com/${encodeURIComponent(clientname)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (res.ok) {
      const html = await res.text();
      // Prefer org-theme-logo over org-theme-social
      const logoMatch = html.match(/https:\/\/app\.ashbyhq\.com\/api\/images\/org-theme-logo\/[^"'\s]+/);
      if (logoMatch) return { companyName: null, logoUrl: logoMatch[0] };

      const socialMatch = html.match(/https:\/\/app\.ashbyhq\.com\/api\/images\/org-theme-social\/[^"'\s]+/);
      if (socialMatch) return { companyName: null, logoUrl: socialMatch[0] };
    }
  } catch {}

  return null;
}

module.exports = { fetchJobs, fetchCompanyMeta, locationOf };
