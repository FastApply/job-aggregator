// Jobylon adapter — Nordic/European ATS (emp.jobylon.com). Employers are numeric company ids.
//
// The list is the employer's careers widget, https://cdn.jobylon.com/jobs/companies/{id}/embed/v1/:
// every open job in one response (paging is client-side; 180 for one employer whatever page_size
// is asked), each with title, town, function and links to the job and its apply form. The job page
// adds JSON-LD: full description, posting date, and an address with the country ("Milan,
// Metropolitan City of Milan, Italy"), which a country search needs.
//
// Applying: /applications/jobs/{id}/create/ — one page, no CAPTCHA, no login: name, email, phone,
// LinkedIn URL, message, CV, optional cover letter, terms (checked 2026-10-05).
const { decodeEntities } = require('./html-entities');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0 Safari/537.36';
const DETAIL_CONCURRENCY = 6;
const DETAIL_DELAY_MS = 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (html) => decodeEntities(String(html || '').replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

const listUrl = (id) => `https://cdn.jobylon.com/jobs/companies/${encodeURIComponent(String(id).trim())}/embed/v1/?target=jobylon-jobs-widget&page_size=1000`;

function parseList(html) {
  const jobs = [];
  for (const m of String(html).matchAll(/<div id="jobylon-job-(\d+)" class="jobylon-job[^"]*">([\s\S]*?)(?=<div id="jobylon-job-\d+"|$)/g)) {
    const [, id, blk] = m;
    const href = (blk.match(/href="(https:\/\/emp\.jobylon\.com\/jobs\/\d+-[^"]+)"/) || [])[1];
    if (!href) continue;
    const field = (cls) => { const f = blk.match(new RegExp(`class="jobylon-${cls}"><strong>[^<]*</strong>([\\s\\S]*?)</li>`)); return f ? text(f[1]) || null : null; };
    jobs.push({ id, url: decodeEntities(href), title: text((blk.match(/class="jobylon-job-title[^"]*">([\s\S]*?)<\/div>/) || [])[1]), town: field('location'), department: field('function') });
  }
  return jobs;
}

/** The job page's JSON-LD JobPosting, or null. */
function parseDetail(html) {
  for (const b of String(html).matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const d = [].concat(JSON.parse(b[1])).find((x) => x && x['@type'] === 'JobPosting');
      if (!d) continue;
      const places = [].concat(d.jobLocation || []).map((p) => {
        const a = (p && p.address) || {};
        const country = typeof a.addressCountry === 'object' ? a.addressCountry && a.addressCountry.name : a.addressCountry;
        return a.streetAddress || [a.addressLocality, a.addressRegion, country].filter(Boolean).join(', ');
      }).filter(Boolean);
      const remote = /TELECOMMUTE/i.test(String(d.jobLocationType || ''));
      return {
        description: d.description || null,
        posted_at: d.datePosted || null,
        location: places.length ? [...new Set(places)].join(' / ') : null,
        employment_type: [].concat(d.employmentType || [])[0] || null,
        workplace_type: remote ? 'remote' : null,
        company: (d.hiringOrganization && d.hiringOrganization.name) || null,
        deadline: d.validThrough || null,
      };
    } catch { /* malformed block: try the next */ }
  }
  return null;
}

const EMPLOYMENT = { FULL_TIME: 'Full-time', PART_TIME: 'Part-time', CONTRACTOR: 'Contract', TEMPORARY: 'Temporary', INTERN: 'Internship' };

async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30000) });
  if (res.status === 404) throw new Error('Jobylon HTTP 404 (not found)');
  if (!res.ok) throw new Error(`Jobylon HTTP ${res.status}`);
  return res.text();
}

async function fetchJobs(companyId) {
  const html = await get(listUrl(companyId));
  if (!/jobylon-job-list|jobylon-powered-by/.test(html)) throw new Error('Jobylon: no job widget (not found)');
  const items = parseList(html);

  // A job page that fails keeps the widget's title and town, so one bad page never drops a live
  // job from the set (the absence counter would read that as closed).
  const jobs = [];
  let companyName = null;
  for (let i = 0; i < items.length; i += DETAIL_CONCURRENCY) {
    const batch = items.slice(i, i + DETAIL_CONCURRENCY);
    const details = await Promise.all(batch.map((it) => get(it.url).then(parseDetail).catch(() => null)));
    batch.forEach((it, k) => {
      const d = details[k] || {};
      companyName = companyName || d.company || null;
      jobs.push({
        external_id: `jobylon_${it.id}`,
        title: it.title,
        department: it.department,
        location: d.location || it.town || null,
        workplace_type: d.workplace_type || null,
        employment_type: EMPLOYMENT[d.employment_type] || null,
        salary_min: null, salary_max: null, salary_currency: null, salary_interval: null,
        description: d.description || null,
        url: it.url,
        posted_at: d.posted_at || null,
        raw_data: { id: it.id, company_id: String(companyId), deadline: d.deadline || null, apply_url: `https://emp.jobylon.com/applications/jobs/${it.id}/create/` },
      });
    });
    if (i + DETAIL_CONCURRENCY < items.length) await sleep(DETAIL_DELAY_MS);
  }
  return { jobs, meta: { companyName, logoUrl: null, capped: false } };
}

module.exports = { fetchJobs, parseList, parseDetail, listUrl };
