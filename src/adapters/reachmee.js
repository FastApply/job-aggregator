// ReachMee (Talentech) adapter — careers sites at {org}.attract.reachmee.com.
//
// The employer's list page (/jobs) renders every open job server-side — title, link with the job id,
// town and application deadline — with no pagination (Espresso House: all 55 on one page). Each job
// page adds the full description and the department. The site gives only a town ("Goteborg"), so
// the country comes from the page's language: lang="sv" -> Sweden, and so on.
//
// Applying: no CAPTCHA, no login — a plain form in a frame from web103.reachmee.com (checked on six
// employers, 2026-10-04).
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0 Safari/537.36';
const DETAIL_CONCURRENCY = 6;
const DETAIL_DELAY_MS = 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COUNTRY_BY_LANG = { sv: 'Sweden', no: 'Norway', nb: 'Norway', nn: 'Norway', da: 'Denmark', fi: 'Finland', is: 'Iceland', de: 'Germany', nl: 'Netherlands' };

const decode = (s) => String(s || '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
const text = (html) => decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** The employer's site: a bare org name, or a full host when the slug carries one. */
function baseUrl(slug) {
  const s = String(slug || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return s.includes('.') ? `https://${s}` : `https://${s}.attract.reachmee.com`;
}

function parseList(html) {
  const lang = (String(html).match(/<html[^>]*\blang="([a-z]{2})/i) || [])[1];
  const country = COUNTRY_BY_LANG[(lang || '').toLowerCase()] || null;
  const jobs = [];
  for (const m of String(html).matchAll(/<li class="at-jobs-list-item">([\s\S]*?)<\/li>/g)) {
    const link = m[1].match(/href="([^"]*\/jobs\/(\d+)-[^"?#]*)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const cells = [...m[1].matchAll(/<div class="at-jobs-list-cell-\d+">([\s\S]*?)<\/div>/g)].map((c) => text(c[1]));
    const town = cells[1] || null;
    jobs.push({ id: link[2], url: decode(link[1]), title: text(link[3]), town, deadline: cells[2] || null, country });
  }
  return jobs;
}

function parseDetail(html) {
  const department = (String(html).match(/class="at-department">[\s\S]*?<\/i>([\s\S]*?)<\/span>/) || [])[1];
  const body = String(html).match(/class="at-content-block-wrapper[^"]*"[^>]*>([\s\S]*?)<div class="at-(?:social|button-row|footer)/);
  return { department: department ? text(department) : null, description: body ? body[1].trim() : null };
}

async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'sv-SE,sv;q=0.9,en;q=0.8' }, signal: AbortSignal.timeout(30000) });
  if (res.status === 404) throw new Error('ReachMee HTTP 404 (not found)');
  if (!res.ok) throw new Error(`ReachMee HTTP ${res.status}`);
  return res.text();
}

async function fetchJobs(clientname) {
  const listHtml = await get(`${baseUrl(clientname)}/jobs`);
  // A site with zero jobs still renders the list header; one with no list at all is not a board.
  if (!/at-jobs-list|Tjänst|Position/i.test(listHtml)) throw new Error('ReachMee: no job list (not found)');
  const items = parseList(listHtml);

  const jobs = [];
  for (let i = 0; i < items.length; i += DETAIL_CONCURRENCY) {
    const batch = items.slice(i, i + DETAIL_CONCURRENCY);
    const details = await Promise.all(batch.map((it) => get(it.url).then(parseDetail).catch(() => ({ department: null, description: null }))));
    batch.forEach((it, k) => {
      const d = details[k];
      jobs.push({
        external_id: `reachmee_${it.id}`,
        title: it.title,
        department: d.department,
        location: [it.town, it.country].filter(Boolean).join(', ') || null,
        workplace_type: null,
        employment_type: null,
        salary_min: null, salary_max: null, salary_currency: null, salary_interval: null,
        description: d.description,
        url: it.url,
        posted_at: null,   // the site does not publish one
        raw_data: { id: it.id, deadline: it.deadline },
      });
    });
    if (i + DETAIL_CONCURRENCY < items.length) await sleep(DETAIL_DELAY_MS);
  }
  return { jobs, meta: { companyName: null, logoUrl: null, capped: false } };
}

module.exports = { fetchJobs, parseList, parseDetail, baseUrl };
