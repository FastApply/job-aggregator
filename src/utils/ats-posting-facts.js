/**
 * The job type and publish date a posting's own ATS states, for a row a job FEED copied.
 *
 * Feeds (simplify, wonsulting, liftmycv, jobloo, jobhose, resumly) store their own type and
 * date, not the employer's. Simplify labels nearly every row Full-time and dates it from its own
 * listing, so a posting the employer published years ago reads as weeks old and passes every
 * "posted in the last N" filter:
 *
 *   - Domino's "HR Administrative Assistant" (SmartRecruiters 744000057641515): Part-time,
 *     released 2025-05-05. The Simplify row: Full-time, posted 2026-08-13. FastApply applied to it
 *     for a candidate who takes full-time work only (2026-11-02).
 *   - Of the feed rows FastApply applied to between 2026-10-27 and 2026-11-02, the ATS dated
 *     14 more than 180 days old while the row said under 180 (SmartRecruiters 3,573 days,
 *     Workable 1,334, Workday 433, Eightfold 215, Jobvite 421), and a JazzHR CONTRACTOR row and
 *     two SmartRecruiters Part-time rows said Full-time.
 *
 * When the board also crawls the posting from the ATS, the feed row is a twin and is dropped
 * (feed-twins.js). This covers the rest: feed rows with no direct row. Each reader below uses
 * the same field the board's own adapter for that ATS reads, so a corrected feed row says what a
 * direct row would. ATSs with no public per-posting resource (Ashby's API lists a whole board,
 * iCIMS, Paylocity) are not read.
 */
const { parseWorkdayUrl, workdayCxsUrl } = require('./workday-url');
const { parseOracleUrl, oracleDetailUrl } = require('./oracle-url');
const { normalizeEmploymentType } = require('./extract');

/** Feeds as the board's external_id prefix names them ("simplify_<uuid>"). */
const FEEDS = ['simplify', 'wonsulting', 'liftmycv', 'jobloo', 'jobhose', 'resumly'];

/** The feed a board external_id belongs to, or null for a row the board crawled itself. */
function feedOf(externalId) {
  const prefix = /^([a-z0-9]+)_/i.exec(String(externalId || ''));
  const name = prefix && prefix[1].toLowerCase();
  return name && FEEDS.includes(name) ? name : null;
}

const obj = (v) => (v && typeof v === 'object' ? v : {});
const str = (v) => (typeof v === 'string' ? v : '');
const iso = (v) => {
  const t = Date.parse(str(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const epoch = (v, unit) => {
  const n = typeof v === 'number' ? v : Number(str(v));
  return Number.isFinite(n) && n > 0 ? new Date(unit === 's' ? n * 1000 : n).toISOString() : null;
};

/** The JobPosting a page carries as JSON-LD, or {}. */
function jobPostingLd(html) {
  for (const m of String(html || '').matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(m[1]);
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        if (obj(item)['@type'] === 'JobPosting') return item;
      }
    } catch { /* another block, or a badly written one */ }
  }
  return {};
}

/** JSON-LD's employmentType: one type only; a list ("FULL_TIME, PART_TIME") offers both. */
function ldType(v) {
  const list = (Array.isArray(v) ? v : [v]).map(str).filter(Boolean);
  return list.length === 1 ? list[0].replace(/_/g, '-') : null;
}

const WORKABLE_TYPE = { full: 'Full-time', part: 'Part-time', contract: 'Contract', temporary: 'Temporary', internship: 'Internship' };

/**
 * Where a posting's facts are read, or null. Pure. `html` sources are fetched as a page.
 * Each reader returns { type, date } with raw ATS values.
 */
function atsFactsSource(ats, url) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const p = u.pathname.split('/').filter(Boolean);
  switch (String(ats || '').toLowerCase()) {
    case 'smartrecruiters': {
      const id = /^(\d{6,})/.exec(p[1] || '');
      if (!/(^|\.)smartrecruiters\.com$/.test(host) || !p[0] || !id) return null;
      return {
        api: `https://api.smartrecruiters.com/v1/companies/${p[0]}/postings/${id[1]}`,
        read: (j) => ({ type: str(obj(obj(j).typeOfEmployment).label), date: iso(obj(j).releasedDate) }),
      };
    }
    case 'workable': {
      if (host !== 'apply.workable.com' || p[1] !== 'j' || !p[2]) return null;
      return {
        api: `https://apply.workable.com/api/v2/accounts/${p[0]}/jobs/${p[2]}`,
        read: (j) => ({ type: WORKABLE_TYPE[str(obj(j).type).toLowerCase()] || null, date: iso(obj(j).published) }),
      };
    }
    case 'workday': {
      const w = parseWorkdayUrl(u.href);
      if (!w) return null;
      return {
        api: workdayCxsUrl(w),
        read: (j) => {
          const i = obj(obj(j).jobPostingInfo);
          return { type: str(i.timeType), date: iso(i.startDate) };
        },
      };
    }
    case 'greenhouse': {
      const m = /^\/([^/]+)\/jobs\/(\d+)/.exec(u.pathname);
      const id = u.searchParams.get('gh_jid') || (m && m[2]);
      if (!/(^|\.)greenhouse\.io$/.test(host) || !m || !id) return null;
      // No type field on Greenhouse; first_published is what the adapter dates by.
      return { api: `https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs/${id}`, read: (j) => ({ type: null, date: iso(obj(j).first_published) }) };
    }
    case 'lever': {
      if (!/^jobs\.(eu\.)?lever\.co$/.test(host) || !/^[0-9a-f-]{36}$/i.test(p[1] || '')) return null;
      const api = host.includes('.eu.') ? 'api.eu.lever.co' : 'api.lever.co';
      return {
        api: `https://${api}/v0/postings/${p[0]}/${p[1]}`,
        read: (j) => ({ type: str(obj(obj(j).categories).commitment), date: epoch(obj(j).createdAt, 'ms') }),
      };
    }
    case 'eightfold': {
      const id = /^(\d+)/.exec(p[2] || '');
      if (!/\.eightfold\.ai$/.test(host) || p[0] !== 'careers' || p[1] !== 'job' || !id) return null;
      return { api: `https://${host}/api/apply/v2/jobs/${id[1]}`, read: (j) => ({ type: null, date: epoch(obj(j).t_create, 's') }) };
    }
    case 'bamboohr': {
      if (!/^[a-z0-9-]+\.bamboohr\.com$/.test(host) || p[0] !== 'careers' || !/^\d+$/.test(p[1] || '')) return null;
      return {
        api: `https://${host}/careers/${p[1]}/detail`,
        read: (j) => {
          const o = obj(obj(obj(j).result).jobOpening);
          return { type: str(o.employmentStatusLabel), date: iso(o.datePosted) };
        },
      };
    }
    case 'jazzhr': {
      if (!/\.applytojob\.com$/.test(host) || p[0] !== 'apply' || !p[1]) return null;
      return {
        api: `https://${host}/apply/${p[1]}`,
        html: true,
        read: (h) => { const ld = jobPostingLd(h); return { type: ldType(ld.employmentType), date: iso(ld.datePosted) }; },
      };
    }
    case 'jobvite': {
      if (host !== 'jobs.jobvite.com' || p[1] !== 'job' || !p[2]) return null;
      return {
        api: `https://jobs.jobvite.com/${p[0]}/job/${p[2]}`,
        html: true,
        read: (h) => { const ld = jobPostingLd(h); return { type: ldType(ld.employmentType), date: iso(ld.datePosted) }; },
      };
    }
    case 'oracle':
    case 'oraclecloud': {
      const o = parseOracleUrl(u.href);
      if (!o) return null;
      return {
        api: oracleDetailUrl(o),
        read: (j) => {
          const items = obj(j).items;
          const i = obj(Array.isArray(items) ? items[0] : null);
          return { type: str(i.JobSchedule), date: iso(i.ExternalPostedStartDate) };
        },
      };
    }
    default:
      return null;
  }
}

/** The ATSs atsFactsSource reads, as stored in jobs.ats. */
const ATS_WITH_FACTS = ['smartrecruiters', 'workable', 'workday', 'greenhouse', 'lever', 'eightfold', 'bamboohr', 'jazzhr', 'jobvite', 'oracle', 'oraclecloud'];

/** A source's raw reading as board columns: { employment_type, posted_at }, nulls for unstated. */
function factsFromBody(source, body) {
  const { type, date } = source.read(body) || {};
  return { employment_type: type ? normalizeEmploymentType(type) : null, posted_at: date || null };
}

/**
 * Fetch and read one posting's facts. Resolves null on any failure (unknown ATS, HTTP error,
 * timeout): a miss leaves the row as the feed stored it.
 */
async function fetchAtsFacts(ats, url, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const source = atsFactsSource(ats, url);
  if (!source || !fetchImpl) return null;
  try {
    const res = await fetchImpl(source.api, {
      headers: { Accept: source.html ? 'text/html' : 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; FastApplyBoard/1.0)' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = source.html ? await res.text() : await res.json();
    const facts = factsFromBody(source, body);
    return facts.employment_type || facts.posted_at ? facts : null;
  } catch {
    return null;
  }
}

module.exports = { FEEDS, ATS_WITH_FACTS, feedOf, atsFactsSource, factsFromBody, fetchAtsFacts, jobPostingLd };
