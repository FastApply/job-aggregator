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
 */
const jwt = require('jsonwebtoken');
const config = require('../config');
const logger = require('../logger');
const { sendAlert } = require('../utils/notify');

const CANARY_URL =
  process.env.SEARCH_CANARY_URL || 'https://job-aggregator-web-gt9m.onrender.com/api/jobs';

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
  const url = `${CANARY_URL}?q=${encodeURIComponent(q)}&limit=50`;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(url, { headers: authHeaders(), signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      return { titles: (body.data || []).map((j) => j.title || ''), servedBy: body.meta && body.meta.servedBy };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function runSearchCanary() {
  const failures = [];
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
      const missing = missingRoles(page.titles, roles);
      if (missing.length) {
        failures.push(`q="${q}" (${page.servedBy || '?'}) returned ${page.titles.length} rows and NONE for: ${missing.join(', ')}`);
      }
    }
  }
  if (failures.length) {
    const outage = unreachable === PAIRS.length * 2;
    const title = outage ? 'Search canary: board unreachable' : 'Search canary FAILED: a multi-role search is not an OR';
    await sendAlert(title, failures.join('\n'), outage ? 'warning' : 'error');
    logger.error({ failures }, title);
  } else {
    logger.info({ pairs: PAIRS.length, url: CANARY_URL }, 'search canary ok: every role reaches the page in both orders');
  }
  return { ok: failures.length === 0, failures };
}

module.exports = { runSearchCanary, missingRoles, PAIRS };
