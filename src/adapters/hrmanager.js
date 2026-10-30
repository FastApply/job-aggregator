// HR-Manager (Talentech) adapter. slug = "<customerAlias>" or "<customerAlias>:<mediaId>[,<mediaId>]" (e.g. "bilia", "lfv1:5559").
// List: GET https://api.hr-manager.net/jobportal.svc/<alias>/positionlist/json/?take=500&skip=N&incads=true[&mediaid=M]
//   (no auth; full ad HTML inline; default = the "homepage" media, MediaId=5). Some customers publish ONLY to external media
//   (Sjöfartsverket/lfv1 -> MediaId 5559), so the slug may carry extra media ids taken from the apply URL; lists are unioned.
// Detail (fallback only / closed check): .../jobportal.svc/<alias>/position/<ProjectId>/json/?incads=true -> HTTP 404 when closed.
// Alias from a numeric cid: candidate.hr-manager.net/Login.aspx?cid=<cid> ("ForgottenPassword.aspx?customer=<alias>"); see board-from-url.js.
// Applying: guest single-page form (email, name, address, birth date, phone, questions, CV upload, consent); no account, no CAPTCHA.
// Checked 2026-10-22.

const API = 'https://api.hr-manager.net/jobportal.svc';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const PAGE = 500;
const MAX_PAGES = 20;
const CONCURRENCY = 4;
const DELAY_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseSlug(slug) {
  const [alias, media] = String(slug || '').trim().split(':');
  if (!alias || !/^[A-Za-z0-9_.-]+$/.test(alias)) throw new Error('HR-Manager HTTP 404 (not found)');
  const mediaIds = String(media || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s) && s !== '5');
  return { alias, mediaIds: [...new Set(mediaIds)] };
}

async function getJson(url) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw new Error(`HR-Manager network error (retry): ${e.message}`);
  }
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    if (res.status === 404) return { status: 404, body: null };
    throw new Error(`HR-Manager HTTP ${res.status} non-JSON response (retry)`);
  }
  if (res.status === 429 || res.status >= 500) throw new Error(`HR-Manager HTTP ${res.status} (retry)`);
  return { status: res.status, body };
}

// /Date(1793401199000+0100)/ -> ISO; DateTime.MinValue (negative) -> null
function msDate(s) {
  const m = /\/Date\((-?\d+)/.exec(s || '');
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? new Date(n).toISOString() : null;
}

async function fetchList(alias, mediaId) {
  const items = [];
  let total = null;
  let body = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({ take: String(PAGE), skip: String(page * PAGE), incads: 'true' });
    if (mediaId) qs.set('mediaid', mediaId);
    const r = await getJson(`${API}/${encodeURIComponent(alias)}/positionlist/json/?${qs}`);
    body = r.body;
    const st = body && body.TransactionStatus;
    if (!body || (st && st.StatusCode !== 0)) {
      const desc = (st && st.Description) || '';
      // Unknown alias -> HTTP 400 "Value cannot be null. Parameter name: connectionString"
      if (/connectionString/i.test(desc) || r.status === 404) {
        if (mediaId && !/connectionString/i.test(desc)) return { items: [], body: null, mediaError: desc || 'not found' };
        throw new Error('HR-Manager HTTP 404 (not found)');
      }
      if (mediaId) return { items: [], body: null, mediaError: desc };
      throw new Error(`HR-Manager status ${st ? st.StatusCode : '?'} ${desc} (retry)`);
    }
    const got = Array.isArray(body.Items) ? body.Items : [];
    items.push(...got);
    total = body.PositionCountSearch ?? body.PositionCountCustomer ?? items.length;
    if (got.length < PAGE || items.length >= total) break;
    await sleep(DELAY_MS);
  }
  return { items, body, total };
}

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (i < list.length) {
      const idx = i++;
      out[idx] = await fn(list[idx], idx);
      await sleep(DELAY_MS);
    }
  });
  await Promise.all(workers);
  return out;
}

const leaf = (node) => {
  let n = node;
  while (n && Array.isArray(n.SubItems) && n.SubItems.length === 1) n = n.SubItems[0];
  return n;
};

const LANG_COUNTRY = { sv: 'Sweden', no: 'Norway', nb: 'Norway', nn: 'Norway', da: 'Denmark', fi: 'Finland' };
const JUNK_LOC = /^(ospecificerad|ej angivet|ej angiven|unspecified|not specified|-+|\.)$/i;
const COUNTRY_NAMES = { sverige: 'Sweden', sweden: 'Sweden', norge: 'Norway', norway: 'Norway', danmark: 'Denmark', denmark: 'Denmark', suomi: 'Finland', finland: 'Finland' };
const countryName = (s) => (s ? COUNTRY_NAMES[String(s).trim().toLowerCase()] || String(s).trim() : null);

function locationOf(it, orgWords) {
  const dep = it.Department || {};
  const cands = [
    (it.PositionLocation && it.PositionLocation.Name) || (leaf(it.PositionLocationTree) || {}).Name,
    it.WorkPlace,
    dep.City,
  ];
  let city = null;
  for (const c of cands) {
    const v = String(c || '').replace(/\s+/g, ' ').trim();
    if (!v || JUNK_LOC.test(v)) continue;
    const low = v.toLowerCase();
    if (dep.Name && low === String(dep.Name).toLowerCase()) continue;
    if (orgWords.some((w) => low.includes(w))) continue; // e.g. PositionLocation "Assemblin VS" is a business unit
    city = v;
    break;
  }
  const langs = (it.Languages || []).map((l) => l.Code);
  const country = countryName(dep.Country) || (langs.length === 1 ? LANG_COUNTRY[langs[0]] : null) || null;
  if (city && COUNTRY_NAMES[city.toLowerCase()]) return COUNTRY_NAMES[city.toLowerCase()];
  if (!city) return country;
  return country && !city.toLowerCase().includes(country.toLowerCase()) ? `${city}, ${country}` : city;
}

const stripTags = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').toLowerCase();

function employmentType(it, descText) {
  const lists = Object.keys(it)
    .filter((k) => /^CustomList\d+(Tree)?$/.test(k) && it[k] && it[k].Name)
    .map((k) => it[k].Name);
  const meta = [it.Name, it.PositionType, ...lists].join(' | ').toLowerCase();
  const title = String(it.Name || '').toLowerCase();
  if (/praktik|internship|trainee|exjobb|examensarbete|lärling|lærling|apprentice/.test(title)) return 'Internship';
  if (/sommarjobb|sommarvikari|feriejobb|sommerjobb|vikariat|visstid|tidsbegränsad|säsong|timanställ|vid behov|midlertidig|vikar\b|tidsbestemt|projektanställning/.test(meta)) return 'Temporary';
  if (/deltid|part[- ]time|deltid/.test(meta)) return 'Part-time';
  if (/heltid|full[- ]time|tillsvidare|fast anställning|fast stilling|fastansættelse|fuldtid|vakituinen/.test(meta)) return 'Full-time';
  const d = descText;
  const ft = /\bheltid|tillsvidare|fast anställning|provanställning|fuldtid|fast stilling|full[- ]time/.test(d);
  const pt = /\bdeltid|part[- ]time/.test(d);
  const tmp = /\bvikariat|visstidsanställning|tidsbegränsad anställning|midlertidig stilling|sommarvikariat/.test(d);
  if (tmp && !/tillsvidare|fast anställning/.test(d)) return 'Temporary';
  if (pt && !ft) return 'Part-time';
  if (ft) return 'Full-time';
  return null;
}

function workplaceType(it, descText) {
  const t = `${it.Name || ''} ${it.WorkPlace || ''}`.toLowerCase();
  if (/\b(remote|distans|fjernarbeid|hjemmekontor)\b/.test(t)) return 'remote';
  if (/\bhybrid/.test(t) || /\bhybridarbete|hybrid work/.test(descText)) return 'hybrid';
  return null;
}

function descriptionOf(it) {
  const ad = (it.Advertisements || []).find((a) => a && a.Content) || (it.Advertisements || [])[0];
  if (!ad) return null;
  let html = String(ad.Content || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .trim();
  const intro = String(ad.Introduction || '').trim();
  if (intro && !html.includes(intro.slice(0, 40))) html = `<p>${intro}</p>\n${html}`;
  return html || null;
}

function companyNameOf(body, items, alias) {
  const name = body && body.CustomerName;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (name && norm(name) !== norm(alias)) return name;
  // CustomerName is often just the alias ("LFV1" for Sjöfartsverket) -> use the most common root department
  const counts = {};
  for (const it of items) {
    const root = it.DepartmentTree && it.DepartmentTree.Name;
    if (root) counts[root] = (counts[root] || 0) + 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return (best && best[0]) || name || null;
}

async function fetchDetail(alias, id) {
  const r = await getJson(`${API}/${encodeURIComponent(alias)}/position/${id}/json/?incads=true`);
  if (r.status === 404 || !r.body || (r.body.TransactionStatus && r.body.TransactionStatus.StatusCode !== 0)) return null;
  return r.body;
}

async function fetchJobs(slug) {
  const { alias, mediaIds } = parseSlug(slug);

  const main = await fetchList(alias, null);
  const byId = new Map();
  for (const it of main.items) byId.set(it.Id, it);
  const mediaErrors = {};
  await mapLimit(mediaIds, CONCURRENCY, async (m) => {
    const r = await fetchList(alias, m);
    if (r.mediaError) mediaErrors[m] = r.mediaError;
    for (const it of r.items) if (!byId.has(it.Id)) byId.set(it.Id, it); // keep homepage URL when on both
  });

  // Spontaneous applications / talent pools are not jobs.
  let items = [...byId.values()].filter((it) => it.ProjectType !== 'OpenApplication');

  // Fallback: fill missing ad HTML from the per-position endpoint (rare; incads normally inlines it).
  const missing = items.filter((it) => !(it.Advertisements || []).some((a) => a && a.Content));
  if (missing.length) {
    await mapLimit(missing, CONCURRENCY, async (it) => {
      const d = await fetchDetail(alias, it.Id).catch(() => null);
      if (d && Array.isArray(d.Advertisements)) it.Advertisements = d.Advertisements;
    });
  }

  const companyName = companyNameOf(main.body, items, alias);
  const orgWords = [companyName, main.body && main.body.CustomerName]
    .map((s) => String(s || '').toLowerCase().split(/\s+/)[0])
    .filter((w) => w && w.length >= 4);

  const jobs = items.map((it) => {
    const description = descriptionOf(it);
    const descText = stripTags(description);
    const deadline = msDate(it.ApplicationDue);
    return {
      external_id: `hrmanager_${it.Id}`,
      title: String(it.Name || '').replace(/\s+/g, ' ').trim(),
      department: (it.Department && it.Department.Name) || null,
      location: locationOf(it, orgWords),
      workplace_type: workplaceType(it, descText),
      employment_type: employmentType(it, descText),
      salary_min: null,
      salary_max: null,
      salary_currency: null,
      salary_interval: null,
      description,
      url: it.AdvertisementUrlSecure || it.AdvertisementUrl || null,
      posted_at: msDate(it.Published) || msDate(it.Created),
      raw_data: {
        id: it.Id,
        alias,
        cid: ((it.AdvertisementUrl || '').match(/cid=(\d+)/i) || [])[1] || null,
        department_id: it.Department ? it.Department.Id : null,
        category: (it.PositionCategory && it.PositionCategory.Name) || null,
        position_location: (it.PositionLocation && it.PositionLocation.Name) || null,
        work_place: it.WorkPlace || null,
        coordinates: it.WorkPlaceCoordinates || null,
        deadline,
        start_asap: !!it.StartDateASAP,
        start_date: msDate(it.StartDate),
        languages: (it.Languages || []).map((l) => l.Code),
        show_apply_button: it.ShowApplyButton !== false,
        apply_url: it.ApplicationFormUrlSecure || it.ApplicationFormUrl || null,
        updated_at: msDate(it.LastUpdated),
      },
    };
  });

  return {
    jobs,
    meta: {
      companyName,
      logoUrl: null,
      capped: false,
      ...(Object.keys(mediaErrors).length ? { mediaErrors } : {}),
    },
  };
}

module.exports = { fetchJobs, fetchDetail, parseSlug };
