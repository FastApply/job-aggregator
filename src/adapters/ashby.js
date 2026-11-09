/**
 * Some stored slugs are already percent-encoded ("Superhuman%20Platform%20Inc", 203 failed
 * boards on 2026-11-09). encodeURIComponent on those sends %2520, which Ashby answers 404, so the
 * board was failed on every crawl. Decode first, then encode exactly once.
 */
function boardPath(clientname) {
  let name = String(clientname);
  try { name = decodeURIComponent(name); } catch { /* a bare % that is not an escape: use as is */ }
  return encodeURIComponent(name);
}

async function fetchJobs(clientname) {
  const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${boardPath(clientname)}?includeCompensation=true`);
  if (!res.ok) throw new Error(`Ashby HTTP ${res.status}`);
  const data = await res.json();
  const jobs = (data.jobs || []).map(job => {
    const comp = job.compensation;
    return {
      external_id: `ashby_${job.id}`,
      title: job.title,
      department: job.department || job.team || null,
      location: job.location || 'Remote',
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
    const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${boardPath(clientname)}`);
    if (res.ok) {
      const data = await res.json();
      if (data.organizationLogo) return { companyName: data.organizationName, logoUrl: data.organizationLogo };
    }
  } catch {}

  // Fallback: scrape the hosted page for org-theme-logo or org-theme-social images
  try {
    const res = await fetch(`https://jobs.ashbyhq.com/${boardPath(clientname)}`, {
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

module.exports = { fetchJobs, fetchCompanyMeta, _boardPath: boardPath };
