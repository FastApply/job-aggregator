// Visma Recruit adapter — Swedish public-sector and company hiring on recruit.visma.com.
//
// Visma has no public per-employer job list: its XML feed (External/Feeds/AssignmentList.ashx)
// needs a guidGroup that Visma hands each customer privately. Every Swedish Visma ad is published
// to Platsbanken, though, so the employer's board is its Swedish organisation number: the list is
// Arbetsförmedlingen's JobTech search filtered on that employer (jobsearch.api.jobtechdev.se,
// open, no key), kept to ads whose apply link is Visma.
//
// Each ad is then checked against Visma's own apply settings (Services/Public/Apply/
// GetApplySettings, the call the apply page makes): Status 1 is open (2 and 3 are closed), and
// HasApplyWithoutAccountMode says whether a candidate can apply without a Visma account. Closed
// ads and account-only ads are left out. Checked 2026-10-22: of 25 open ads, 20 took applications
// without an account; no CAPTCHA on the form.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0 Safari/537.36';
const JOBTECH = 'https://jobsearch.api.jobtechdev.se/search';
const PAGE = 100;
const MAX_OFFSET = 2000; // JobTech refuses offsets past 2,000
const DETAIL_CONCURRENCY = 6;
const DETAIL_DELAY_MS = 100;
const VISMA_HOST = /^https?:\/\/(recruit\.visma\.com|hire\.vismatalent\.com)\//i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Platsbanken's plain text, paragraphs on blank lines, as HTML. */
function textToHtml(text) {
  const paras = String(text || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return paras.length ? paras.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('\n') : null;
}

/** A bare 10-digit org number; dashes and spaces are tolerated. */
function orgNumber(slug) {
  const s = String(slug || '').replace(/[\s-]/g, '');
  return /^\d{10}$/.test(s) ? s : null;
}

/** guidAssignment from a Visma apply link. */
function assignmentGuid(url) {
  const m = String(url || '').match(/[?&]guidAssignment=([0-9a-f-]{36})/i);
  return m ? m[1].toLowerCase() : null;
}

/** Swedish employment wording -> the board's canonical types. */
function employmentType(hit) {
  const form = `${hit.employment_type?.label || ''} ${hit.duration?.label || ''}`.toLowerCase();
  const hours = (hit.working_hours_type?.label || '').toLowerCase();
  if (/sommarjobb|feriejobb|behovsanställning|vikariat|visstid|säsong|månader|dagar/.test(form)) return 'Temporary';
  if (/praktik/.test(form)) return 'Internship';
  if (/deltid/.test(hours)) return 'Part-time';
  if (/heltid/.test(hours) || /tills vidare/.test(form)) return 'Full-time';
  return null;
}

/** One Platsbanken ad plus Visma's settings for it -> a job, or null when it is not applyable. */
function toJob(hit, settings) {
  const url = hit.application_details?.url;
  const guid = assignmentGuid(url);
  if (!guid) return null;
  if (settings) {
    if (settings.Status !== 1) return null;
    if (settings.HasApplyWithoutAccountMode === false) return null;
  }
  const addr = hit.workplace_address || {};
  const town = addr.city || addr.municipality || null;
  const location = [town, addr.country || 'Sverige'].filter(Boolean).join(', ');
  const visma = settings?.Assignment?.AdDescription;
  return {
    external_id: `visma_${guid}`,
    title: settings?.Assignment?.Title || hit.headline,
    department: null,
    location,
    workplace_type: null,
    employment_type: employmentType(hit),
    salary_min: null, salary_max: null, salary_currency: null, salary_interval: null,
    description: (visma && visma.trim()) || textToHtml(hit.description?.text_formatted || hit.description?.text),
    url,
    posted_at: hit.publication_date ? new Date(`${hit.publication_date}+02:00`).toISOString() : null,
    raw_data: {
      platsbanken_id: hit.id,
      region: addr.region || null,
      deadline: hit.application_deadline || null,
      reference: hit.application_details?.reference || null,
      checked: Boolean(settings),
    },
  };
}

// JobTech answers a big employer's page slowly (one Region timed out at 30s), so the list waits longer.
async function get(url, timeoutMs = 30000) {
  let res;
  try {
    res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json', 'accept-language': 'sv-SE,sv;q=0.9,en;q=0.8' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new Error(`Visma: ${e.message} (retry)`);
  }
  if (!res.ok) throw new Error(`Visma HTTP ${res.status}${res.status >= 500 ? ' (retry)' : ''}`);
  const body = await res.text();
  try { return JSON.parse(body); } catch { throw new Error('Visma: unexpected page instead of JSON (retry)'); }
}

/** The employer's live Platsbanken ads, every page. */
async function listAds(org) {
  const hits = [];
  let total = Infinity;
  for (let offset = 0; offset < total && offset <= MAX_OFFSET; offset += PAGE) {
    const d = await get(`${JOBTECH}?employer=${org}&limit=${PAGE}&offset=${offset}`, 120000);
    if (!Array.isArray(d.hits)) throw new Error('Visma: unexpected page from Platsbanken search (retry)');
    total = d.total?.value ?? 0;
    hits.push(...d.hits);
    if (d.hits.length < PAGE) break;
  }
  return hits;
}

function settingsUrl(applyUrl, guid) {
  const origin = String(applyUrl).match(/^https?:\/\/[^/]+/)[0];
  const code = String(applyUrl).match(/[?&]publishCode=([^&]+)/i);
  return `${origin}/Services/Public/Apply/GetApplySettings?guidAssignment=${guid}${code ? `&publishCode=${code[1]}` : ''}`;
}

async function fetchJobs(slug) {
  const org = orgNumber(slug);
  if (!org) throw new Error('Visma HTTP 404 (not found): slug is not an organisation number');
  const ads = (await listAds(org)).filter((h) => VISMA_HOST.test(h.application_details?.url || '') && assignmentGuid(h.application_details.url));

  // Settings, a few at a time. A check that fails keeps the ad (Platsbanken still lists it), so one
  // bad response never drops a live job from the set (the absence counter would read that as closed).
  const jobs = [];
  let companyName = null;
  let logoUrl = null;
  for (let i = 0; i < ads.length; i += DETAIL_CONCURRENCY) {
    const batch = ads.slice(i, i + DETAIL_CONCURRENCY);
    const settings = await Promise.all(batch.map((h) => {
      const url = h.application_details.url;
      return get(settingsUrl(url, assignmentGuid(url))).catch(() => null);
    }));
    batch.forEach((h, k) => {
      const job = toJob(h, settings[k]);
      if (job) jobs.push(job);
      companyName = companyName || h.employer?.name || null;
      logoUrl = logoUrl || settings[k]?.Branding?.DepartmentLogoUrl || null;
    });
    if (i + DETAIL_CONCURRENCY < ads.length) await sleep(DETAIL_DELAY_MS);
  }
  return { jobs, meta: { companyName, logoUrl, capped: false } };
}

module.exports = { fetchJobs, toJob, employmentType, orgNumber, assignmentGuid, textToHtml };
