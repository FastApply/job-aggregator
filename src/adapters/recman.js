// Recman adapter — slug is a {label}.recman.page label ("prowork"; .recman.io is the same board) or
// a custom host Recman serves ("www.iqjobb.se"); see board-from-url.js. The candidate page's JSON
// API wants a session: GET /jobs yields a csrf-token meta + cookies, then /api/jobs?limit=&page=
// lists every published ad and /api/job/{id} adds the HTML body, geocoded locations and type ids.
// Ads posted only to Arbetsförmedlingen (path=ams) may be absent from the list. Applying: guest
// form (name, email, phone, CV), no account or login; reCAPTCHA Enterprise and email/SMS codes
// only where the employer enables them (/api/apply/{id}/settings). Checked 2026-10-22.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0 Safari/537.36';
const PAGE_SIZE = 500;
const DETAIL_CONCURRENCY = 5;
const DETAIL_DELAY_MS = 150;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The board's base URL: a bare label on recman.page, or a full host when the slug carries one. */
function baseUrl(slug) {
  const s = String(slug || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const m = s.match(/^([a-z0-9-]+)\.recman\.(?:page|io|no)$/);
  if (m) return `https://${m[1]}.recman.page`;
  return s.includes('.') ? `https://${s}` : `https://${s}.recman.page`;
}

const COUNTRIES = {
  sverige: 'Sweden', sweden: 'Sweden', norge: 'Norway', noreg: 'Norway', norway: 'Norway',
  danmark: 'Denmark', denmark: 'Denmark', suomi: 'Finland', finland: 'Finland', polen: 'Poland', poland: 'Poland',
};
const country = (s) => COUNTRIES[String(s || '').trim().toLowerCase()] || null;
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** "Astraallén 3, 152 57 Södertälje, Sverige" -> "Södertälje, Sweden". */
function placeFromAddress(addr) {
  const parts = String(addr || '').split(',').map(clean).filter(Boolean);
  if (!parts.length) return null;
  const c = country(parts[parts.length - 1]);
  const rest = c ? parts.slice(0, -1) : parts;
  const city = rest.length ? rest[rest.length - 1].replace(/^\d[\d\s-]*\s+/, '') : null;
  return [city, c || (rest.length ? null : parts[parts.length - 1])].filter(Boolean).join(', ') || null;
}

/** "Sverige, Eskilstuna" -> "Eskilstuna, Sweden"; anything else as written. */
function placeFromList(place) {
  const p = clean(place);
  if (!p) return null;
  const parts = p.split(',').map(clean).filter(Boolean);
  const c = country(parts[0]);
  if (c && parts.length > 1) return `${parts.slice(1).join(', ')}, ${c}`;
  if (c) return c;
  return p;
}

function location(post, detail) {
  const fromGeo = [...new Set(((detail && detail.locations) || []).map((l) => placeFromAddress(l.FormattedAddress)).filter(Boolean))];
  if (fromGeo.length) return fromGeo.join('; ');
  const ad = (detail && detail.ad) || {};
  const city = clean(ad.PlaceCity);
  if (city) return [city, country(ad.PlaceCountry) || clean(ad.PlaceCountry) || null].filter(Boolean).join(', ');
  return placeFromList(post.Place);
}

/** Recman work type: ids 1 office / 2 hybrid / 3 home on the ad; the list carries the label. */
function workplaceType(post, ad) {
  const id = Number(ad && ad.WorkType);
  if (id === 1) return 'onsite';
  if (id === 2) return 'hybrid';
  if (id === 3) return 'remote';
  const t = String(post.WorkType || '').toLowerCase();
  if (/hybrid/.test(t)) return 'hybrid';
  if (/hemm|hjemm|remote|distans/.test(t)) return 'remote';
  if (/kontor|on-site|office/.test(t)) return 'onsite';
  return null;
}

/**
 * Extent (Tillsvidare/Fast = 1, Vikariat/Midlertidig = 2, Visstid/Engasjement = 3, Projekt = 4,
 * Säsong = 6) and hours (Heltid/Fulltid = 1, Deltid = 2, Skift/Turnus = 3) -> canonical types.
 */
function employmentType(post, ad) {
  const extentId = Number(ad && ad.ExtentID);
  const hoursId = Number(ad && ad.EmploymentType);
  const extent = String(post.Extent || (ad && ad.Extent) || '').toLowerCase();
  const hours = String(post.EmploymentType || '').toLowerCase();
  if (/praktik|lærling|lärling|internship|trainee/.test(extent)) return 'Internship';
  if ([2, 3, 4, 6].includes(extentId) || /visstid|vikari|projekt|prosjekt|säsong|sesong|midlertid|engasjement|tidsbegräns|sommer/.test(extent)) return 'Temporary';
  if (hoursId === 2 || /deltid/.test(hours)) return 'Part-time';
  if (hoursId === 1 || /heltid|fulltid/.test(hours) || extentId === 1 || /tillsvidare|fast/.test(extent)) return 'Full-time';
  return null;
}

/**
 * "2026-10-13 12:09:46" -> ISO. Recman serves UTC: og:updated_time on the job page is the same
 * instant read as UTC, and posting hours cluster 05-14 with a dip at 10 (Nordic lunch).
 */
function utcToIso(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toISOString() : null;
}

function deadNotFound() { return new Error('Recman HTTP 404 (not found)'); }

/** Open a session on the candidate page: cookies plus the csrf token every /api call needs. */
async function openSession(base) {
  let res;
  try {
    res = await fetch(`${base}/jobs`, { headers: { 'user-agent': UA, 'accept-language': 'sv-SE,sv;q=0.9,nb;q=0.8,en;q=0.7' }, signal: AbortSignal.timeout(30000) });
  } catch (e) {
    const code = e && e.cause && e.cause.code;
    if ((code === 'ENOTFOUND' || code === 'EAI_NONAME') && !/\.recman\.page$/.test(new URL(base).hostname)) throw deadNotFound();
    throw new Error(`Recman: ${e.message} (retry)`);
  }
  if (res.status === 404 || res.status === 410) throw deadNotFound();
  if (!res.ok) throw new Error(`Recman HTTP ${res.status} (retry)`);
  const html = await res.text();
  const finalPath = new URL(res.url).pathname;
  const token = (html.match(/name="csrf-token" content="([^"]+)"/) || [])[1];
  // An unknown board redirects to /unknown ("Finner ikke side") with an anonymous 0-0-... token.
  if (finalPath === '/unknown' || /^0-0-/.test(token || '')) throw deadNotFound();
  if (!token) {
    // A custom domain that no longer points at Recman is a dead board; anything else is transient.
    if (!/recman/i.test(html) && !/\.recman\.page$/.test(new URL(base).hostname)) throw deadNotFound();
    throw new Error('Recman: unexpected page, no csrf token (retry)');
  }
  const cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  return { base: new URL(res.url).origin, token, cookie };
}

async function api(session, path) {
  let res;
  try {
    res = await fetch(`${session.base}/api${path}`, {
      headers: { 'user-agent': UA, accept: 'application/json', 'x-csrf-token': session.token, cookie: session.cookie },
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw new Error(`Recman: ${e.message} (retry)`);
  }
  if (!res.ok) throw new Error(`Recman HTTP ${res.status} (retry)`);
  const body = await res.text();
  let json;
  try { json = JSON.parse(body); } catch { throw new Error('Recman: non-JSON API answer (retry)'); }
  return json;
}

async function listPosts(session) {
  const posts = [];
  for (let page = 1; page <= 50; page++) {
    const json = await api(session, `/jobs?limit=${PAGE_SIZE}&page=${page}`);
    if (json.statusCode !== 200 || !json.data || !Array.isArray(json.data.job_posts)) {
      throw new Error(`Recman: job list answered ${json.statusCode} ${json.message || ''} (retry)`.replace(/\s+/g, ' '));
    }
    posts.push(...json.data.job_posts);
    const pages = Number(json.data.pagination && json.data.pagination.countPages) || 1;
    if (page >= pages || !json.data.job_posts.length) break;
  }
  return posts;
}

/** The ad's detail; null when it cannot be read ("Ad not available" or a transient failure). */
async function getDetail(session, id) {
  try {
    const json = await api(session, `/job/${id}`);
    return json.statusCode === 200 && json.data && json.data.ad ? json.data : null;
  } catch {
    return null;
  }
}

function mostCommon(values) {
  const n = new Map();
  for (const v of values) if (v) n.set(v, (n.get(v) || 0) + 1);
  let best = null;
  for (const [v, c] of n) if (!best || c > best[1]) best = [v, c];
  return best ? best[0] : null;
}

async function fetchJobs(slug) {
  const session = await openSession(baseUrl(slug));
  const posts = await listPosts(session);

  // Details, a few at a time: an ad whose detail fails keeps the list's fields, so one bad request
  // never drops a live job from the set (the absence counter would read that as closed).
  const jobs = [];
  for (let i = 0; i < posts.length; i += DETAIL_CONCURRENCY) {
    const batch = posts.slice(i, i + DETAIL_CONCURRENCY);
    const details = await Promise.all(batch.map((p) => getDetail(session, p.AdID)));
    batch.forEach((post, k) => {
      const detail = details[k];
      const ad = (detail && detail.ad) || null;
      if (ad && ad.Ended === true) return; // closed between the list and the detail read
      jobs.push({
        external_id: `recman_${post.AdID}`,
        title: clean(post.Name || (ad && ad.Name) || post.JobTitle),
        department: null,
        location: location(post, detail),
        workplace_type: workplaceType(post, ad),
        employment_type: employmentType(post, ad),
        salary_min: null, salary_max: null, salary_currency: null, salary_interval: null,
        description: (ad && ad.Body) || null,
        url: `${session.base}/job/${post.AdID}`,
        posted_at: utcToIso(post.Created),
        raw_data: {
          id: post.AdID,
          employer: post.EmpName || null,
          job_title: post.JobTitle || null,
          place: post.Place || null,
          expires: post.Expire || null,
          deadline: post.Deadline || null,
          extent: post.Extent || null,
          hours: post.EmploymentType || null,
          positions: post.Positions || null,
          external_link: (ad && ad.ExternalLink) || null,
        },
      });
    });
    if (i + DETAIL_CONCURRENCY < posts.length) await sleep(DETAIL_DELAY_MS);
  }

  const companyName = mostCommon(posts.map((p) => p.EmpName));
  const logoPost = posts.find((p) => p.EmpName === companyName && p.Logos && p.Logos.full);
  return { jobs, meta: { companyName: companyName ? clean(companyName) : null, logoUrl: logoPost ? logoPost.Logos.full : null, capped: false } };
}

module.exports = { fetchJobs, baseUrl, employmentType, workplaceType, placeFromAddress, placeFromList, utcToIso };
