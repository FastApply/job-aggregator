/**
 * Search canary: proves the deployed board still answers a multi-role query with EVERY role.
 *
 * `q` is comma-separated and each entry is a role the user would accept — an OR. Three times
 * now a change has silently turned that into "only the first role":
 *   - 2026-03-21..04-17  FastApply joined keywords with spaces (backend); AND-of-tokens → 0 rows
 *   - then FastApply joined with `|`, which the board does not treat as an operator
 *   - 2026-08-06..09-17  this repo's Meilisearch path joined the roles with a space and let
 *                        matchingStrategy 'last' drop the tail; role #1 owned the page
 * None of them crashed, logged, or moved a dashboard. Each was found weeks later from user
 * complaints, by which time 84% of FastApply automations had been searching one keyword.
 *
 * So this asks the PUBLIC API — the URL consumers hit, through the deployed web service, with
 * the same bearer auth — for a pair of roles with large, disjoint corpora, in both orders, and
 * demands at least one title for each role on the first page. It fails loudly, to Telegram,
 * the same day. It does not fix anything; it makes this class of bug impossible to miss.
 *
 * It also runs a RECALL probe over the jobs those pages returned: a filter must not lose a job
 * that satisfies it. Two filters did exactly that, unnoticed, until 2026-09-26 — the index held
 * raw employment types ("Full time") that employment_type=full-time never matched (21% of
 * full-time jobs), and "Austin, TX" carried no country, so location=United States missed 38% of
 * US jobs. Both are the same shape: the index side and the query side disagree about a value.
 * So the probe takes a job the board just showed, asks for it again by its own title and
 * company WITH a filter it plainly satisfies, and demands it come back.
 */
const jwt = require('jsonwebtoken');
const config = require('../config');
const logger = require('../logger');
const { sendAlert } = require('../utils/notify');
const { normalizeEmploymentType } = require('../utils/extract');

const CANARY_URL =
  process.env.SEARCH_CANARY_URL || 'https://board.fastapply.co/api/jobs';

/**
 * Role pairs with corpora big enough that both are always on the board and disjoint enough that
 * one title cannot satisfy both. A pair whose second role vanishes is the bug; a pair that is
 * unreachable is an outage, reported separately so the two never read as the same thing.
 */
const PAIRS = [
  ['Registered Nurse', 'Accountant'],
  ['Software Engineer', 'Truck Driver'],
  ['Project Manager', 'Electrician'],
];

const STOP = new Set(['and', 'or', 'of', 'the', 'a', 'an', 'to', 'for', 'in', 'with', '&']);
const words = (role) => role.toLowerCase().replace(/[^a-z0-9+#]+/g, ' ').split(' ').filter((w) => w && !STOP.has(w));
const titleHas = (title, role) => { const t = String(title || '').toLowerCase(); return words(role).every((w) => t.includes(w)); };

// State codes that are no country's ISO code, so "City, ST" with one of them is the US beyond any
// reading. Deliberately independent of location-countries.js: the probe must not share the code
// it is checking.
const PLAIN_US_STATE = /,\s*(AK|CT|FL|HI|IA|KS|MI|NH|NJ|NM|NV|NY|ND|OH|OK|OR|RI|TX|UT|VT|WA|WI|WV|WY)$/;

/**
 * Pure. The recall checks worth running on a page of jobs: for each, the query that must find it
 * again. At most `perKind` of each kind, so the probe stays a handful of requests.
 */
function recallChecks(jobs, perKind = 2) {
  const checks = [];
  const usable = jobs.filter((j) => j && j.id && j.title && j.company && j.company.id);
  // `control` is the same query without the filter. An employer can post the same title hundreds
  // of times, so a job absent from a page is only LOST if the control page has it: filtering
  // keeps the ranking order, so a job in the unfiltered top 200 is in the filtered top 200 too.
  const base = (j) => `q=${encodeURIComponent(j.title)}&company_id=${j.company.id}&limit=200`;
  for (const j of usable.filter((x) => normalizeEmploymentType(x.employment_type)).slice(0, perKind)) {
    const type = normalizeEmploymentType(j.employment_type).toLowerCase();
    checks.push({ id: j.id, filter: `employment_type=${type}`, control: base(j),
      qs: `${base(j)}&employment_type=${type}`, why: `${j.title} (employment_type "${j.employment_type}")` });
  }
  for (const j of usable.filter((x) => PLAIN_US_STATE.test(String(x.location || '').trim())).slice(0, perKind)) {
    checks.push({ id: j.id, filter: 'location=United States', control: base(j),
      qs: `${base(j)}&location=United%20States`, why: `${j.title} (location "${j.location}")` });
  }
  return checks;
}

/** Pure. Which of `roles` have NO title on the page? Empty array means the OR is intact. */
function missingRoles(titles, roles) {
  return roles.filter((role) => !titles.some((t) => titleHas(t, role)));
}

// The API verifies a JWT signed with API_SECRET (src/api/middleware/auth.js); with no secret
// configured it accepts anonymous requests, so send nothing rather than an unsigned token.
function authHeaders() {
  if (!config.API_SECRET) return {};
  return { Authorization: `Bearer ${jwt.sign({ sub: 'search-canary' }, config.API_SECRET, { expiresIn: '10m' })}` };
}

async function fetchPage(q) {
  return fetchQuery(`q=${encodeURIComponent(q)}&limit=50`);
}

async function fetchQuery(qs) {
  const url = `${CANARY_URL}?${qs}`;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(url, { headers: authHeaders(), signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const jobs = body.data || [];
      return { jobs, titles: jobs.map((j) => j.title || ''), servedBy: body.meta && body.meta.servedBy };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function runSearchCanary() {
  const failures = [];
  const seen = [];
  let unreachable = 0;
  for (const [a, b] of PAIRS) {
    // Both orders: the 2026-08 bug was order-dependent — whichever role came first won.
    for (const roles of [[a, b], [b, a]]) {
      const q = roles.join(',');
      let page;
      try {
        page = await fetchPage(q);
      } catch (err) {
        unreachable += 1;
        failures.push(`q="${q}": unreachable (${err.message})`);
        continue;
      }
      seen.push(...page.jobs);
      const missing = missingRoles(page.titles, roles);
      if (missing.length) {
        failures.push(`q="${q}" (${page.servedBy || '?'}) returned ${page.titles.length} rows and NONE for: ${missing.join(', ')}`);
      }
    }
  }
  // Recall probe: a job the board just returned must survive a filter it satisfies.
  const lost = [];
  for (const check of recallChecks(seen)) {
    try {
      const has = (page) => page.jobs.some((j) => String(j.id) === String(check.id));
      if (!has(await fetchQuery(check.control))) continue; // inconclusive, not lost
      if (!has(await fetchQuery(check.qs))) lost.push(`${check.filter} lost ${check.why}`);
    } catch {
      // Reachability is already judged above; a probe that cannot run proves nothing either way.
    }
  }
  if (lost.length) {
    const title = 'Search canary FAILED: a filter drops jobs that satisfy it';
    await sendAlert(title, lost.join('\n'), 'error');
    logger.error({ lost }, title);
  }

  if (failures.length) {
    const outage = unreachable === PAIRS.length * 2;
    const title = outage ? 'Search canary: board unreachable' : 'Search canary FAILED: a multi-role search is not an OR';
    await sendAlert(title, failures.join('\n'), outage ? 'warning' : 'error');
    logger.error({ failures }, title);
  } else {
    logger.info({ pairs: PAIRS.length, url: CANARY_URL }, 'search canary ok: every role reaches the page in both orders');
  }
  return { ok: failures.length === 0 && lost.length === 0, failures, lost };
}

module.exports = { runSearchCanary, missingRoles, recallChecks, PAIRS };
