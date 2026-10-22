// Talentadore adapter (Finnish ATS, FI/SE). Checked 2026-10-22. slug = employer "company hash" (3-ish chars, case-sensitive, e.g. z18).
//   List: GET https://ats.talentadore.com/positions/{hash}/json (also /rss) -> {version, company, generated_at, jobs[]}, every open job
//         with full description_html; no paging/cap seen (160 jobs on one feed). Unknown hash -> 404 "{}"; zero open jobs -> 200 jobs:[].
//   White-label tenants answer only on their own subdomain (staffpoint.talentadore.com, jobilla.talentadore.com):
//   slug "{sub}/{hash}" (e.g. staffpoint/OEv72); a bare hash means ats.talentadore.com.
//   Detail (empty description only, + 1-3 pages for logo <img class="logo">): GET /apply/{slug}/{job_token}; hash = its data-company_hash.
//   Closed job = missing from the feed; its apply page is 404 or a 200 "Not available" page without data-job_token. Times are UTC, no 'Z'.
//   Applying: guest web form (CV upload + questions), no account, no CAPTCHA seen. Staffing/group tenants (Eezy 1vb, Cor Group lLO) list
//   several hiring companies: per-job business_unit_name -> raw_data.hiring_company. employment_type is free text (fi/sv/en) or null.
const ATS_BASE = 'https://ats.talentadore.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const TIMEOUT_MS = 30000;
const DETAIL_CONCURRENCY = 4;
const DETAIL_DELAY_MS = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, accept) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'user-agent': UA, accept, 'accept-language': 'en;q=0.9,fi;q=0.8,sv;q=0.7' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`Talentadore network error (retry): ${e.message}`);
  }
  return res;
}

// "2026-09-07T05:00:00" (UTC, no zone) -> ISO, or null.
function iso(s) {
  if (!s || typeof s !== 'string') return null;
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const COUNTRY = {
  suomi: 'Finland', finland: 'Finland', sverige: 'Sweden', ruotsi: 'Sweden', sweden: 'Sweden',
  norge: 'Norway', norja: 'Norway', danmark: 'Denmark', tanska: 'Denmark', eesti: 'Estonia', viro: 'Estonia',
  deutschland: 'Germany', saksa: 'Germany', tyskland: 'Germany', 'united states': 'United States',
};
const normCountry = (c) => (c ? COUNTRY[c.trim().toLowerCase()] || c.trim() : null);

// City from a free-text address when `city` is empty: "Siltakatu 18, 80100, Joensuu" -> Joensuu; "Lappeenranta" -> Lappeenranta.
function cityFromAddress(addr, country) {
  let last = String(addr || '').split(',').pop().replace(/\(.*?\)/g, '').trim();
  const postal = /^\d{3}\s?\d{2}\s+(.+)$/.exec(last); // "903 26 Umeå" / "80100 Joensuu"
  if (postal) last = postal[1].trim();
  if (!/^[\p{L} .'-]{2,40}$/u.test(last)) return null;
  if (COUNTRY[last.toLowerCase()] || (country && last.toLowerCase() === country.toLowerCase())) return null;
  return last;
}

function locationOf(j) {
  const city = (j.city || '').trim() || cityFromAddress(j.location, j.country);
  const country = normCountry(j.country);
  const parts = [city || (j.county || '').trim(), country].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

const REMOTE_RE = /\b(remote|etätyö|etänä|distans|på distans|fully remote)\b/i;
const HYBRID_RE = /\b(hybrid|hybridi|hybridityö)\b/i;
function workplaceType(j) {
  const hay = `${j.name || ''} ${j.city || ''} ${j.location || ''}`;
  if (HYBRID_RE.test(hay)) return 'hybrid';
  if (REMOTE_RE.test(hay)) return 'remote';
  return null;
}

// Free-text (fi/sv/en) -> our vocabulary. Mixed values ("osa-aikainen tai kokoaikainen") resolve to Full-time.
function employmentType(raw) {
  const v = String(raw || '').toLowerCase();
  if (!v.trim()) return null;
  if (/harjoittel|praktik|intern|trainee|traineeship|kesäharjoit/.test(v)) return 'Internship';
  const full = /kokoaika|täysipäiv|täysiaika|heltid|full[- ]?time/.test(v);
  const part = /osa-?aika|deltid|part[- ]?time/.test(v);
  if (part && !full) return 'Part-time';
  if (full) return 'Full-time';
  if (/määräaika|sijais|kesätyö|keikka|visstid|tidsbegräns|vikariat|sommarjobb|timanställ|temporary|fixed[- ]?term|seasonal|summer/.test(v)) return 'Temporary';
  if (/vakituinen|vakituo|toistaiseksi|tillsvidare|fast anställ|tillsvidareanställ|permanent/.test(v)) return 'Full-time';
  return null;
}

// Evergreen ads ("open application") report start_date == generated_at (i.e. "now"); fall back to `updated`.
function postedAt(j, generatedAt) {
  const start = iso(j.start_date);
  const gen = iso(generatedAt);
  if (start && gen && Math.abs(Date.parse(start) - Date.parse(gen)) < 5 * 60 * 1000) return iso(j.updated);
  return start || iso(j.updated);
}

function parseLd(html) {
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const d = JSON.parse(m[1]);
      if (d && d['@type'] === 'JobPosting') return d;
    } catch { /* ignore */ }
  }
  return null;
}

async function fetchApplyPage(url) {
  const res = await get(url, 'text/html');
  if (!res.ok) return null;
  const html = await res.text();
  const img = /<img[^>]*class\s*=\s*"logo"[^>]*src="(https?:\/\/[^"]+)"/i.exec(html);
  const ld = parseLd(html);
  const ldLogo = ld && ld.hiringOrganization && ld.hiringOrganization.logo;
  return { ld, logo: img ? img[1] : (typeof ldLogo === 'string' && /^https?:\/\//.test(ldLogo) ? ldLogo : null) };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); } catch { out[idx] = null; }
      await sleep(DETAIL_DELAY_MS);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function fetchJobs(slug) {
  const m = /^(?:([a-z0-9-]+)\/)?([A-Za-z0-9]{1,16})$/.exec(String(slug || '').trim());
  if (!m) throw new Error('Talentadore HTTP 404 (not found)');
  const hash = m[2];
  const BASE = m[1] ? `https://${m[1].toLowerCase()}.talentadore.com` : ATS_BASE;
  const res = await get(`${BASE}/positions/${encodeURIComponent(hash)}/json`, 'application/json');
  if (res.status === 404) throw new Error('Talentadore HTTP 404 (not found)');
  if (!res.ok) throw new Error(`Talentadore HTTP ${res.status} (retry)`);
  const body = await res.text();
  let feed;
  try { feed = JSON.parse(body); } catch { throw new Error('Talentadore unexpected non-JSON feed (retry)'); }
  if (!feed || !Array.isArray(feed.jobs)) throw new Error('Talentadore unexpected feed shape (retry)');

  const companyName = typeof feed.company === 'string' && feed.company.trim() ? feed.company.trim() : null;

  const jobs = feed.jobs.filter((j) => j && j.job_token && j.name).map((j) => {
    const url = j.link || `${BASE}/apply/jobs/${j.job_token}`;
    const hiring = j.business_unit_name && j.business_unit_name !== companyName ? j.business_unit_name : null;
    return {
      external_id: `talentadore_${j.job_token}`,
      title: String(j.name).trim(),
      department: null,
      location: locationOf(j),
      workplace_type: workplaceType(j),
      employment_type: employmentType(j.employment_type),
      salary_min: null,
      salary_max: null,
      salary_currency: null,
      salary_interval: null,
      description: j.description_html || null,
      url,
      posted_at: postedAt(j, feed.generated_at),
      raw_data: {
        position_id: j.id || null,
        job_token: j.job_token,
        hiring_company: hiring,
        business_unit_id: j.business_unit_id || null,
        address: j.location || null,
        city: j.city || null,
        county: j.county || null,
        country: j.country || null,
        deadline: iso(j.due_date),
        employment_type_raw: j.employment_type || null,
        updated: iso(j.updated),
        image: j.image || null,
      },
    };
  });

  // Detail fallback: only for the rare ad whose feed description is empty.
  const thin = jobs.filter((j) => !j.description || j.description.length < 50);
  if (thin.length) {
    await mapLimit(thin, DETAIL_CONCURRENCY, async (job) => {
      const page = await fetchApplyPage(job.url);
      const ld = page && page.ld;
      if (ld && ld.description && ld.description.length > (job.description || '').length) job.description = ld.description;
    });
  }

  // Logo: the feed has none. Read it from up to 3 apply pages, tenant's own ads first (agency feeds carry client logos).
  let logoUrl = null;
  const candidates = [...jobs.filter((j) => !j.raw_data.hiring_company), ...jobs.filter((j) => j.raw_data.hiring_company)].slice(0, 3);
  for (const job of candidates) {
    try {
      const page = await fetchApplyPage(job.url);
      if (page && page.logo) { logoUrl = page.logo; break; }
    } catch { /* logo is best effort */ }
    await sleep(DETAIL_DELAY_MS);
  }

  return { jobs, meta: { companyName, logoUrl, capped: false } };
}

module.exports = { fetchJobs, employmentType, _internal: { iso, locationOf, cityFromAddress, postedAt, parseLd } };
