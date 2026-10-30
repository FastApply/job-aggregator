'use strict';
/**
 * FA-053 — retiring the demo/sandbox jobs that are already stored.
 *
 * The guard keeps new ones out; this removes the ones that got in before it existed. Retiring is
 * the repo's normal soft removal (removed_at, with removed_reason saying why), so it is
 * reversible and the search index follows through the outbox trigger.
 *
 * Two kinds of evidence, as everywhere else in this feature:
 *   whole companies   the slug or career_url names a sandbox board -> every live job it has
 *   single postings   the posting URL names one (third-party feeds file jobs under their own
 *                     company, so the company looks innocent) -> that job
 *
 * planRetirement only ever SELECTs. applyRetirement is the only function that writes, and it
 * reuses jobs-retire.js's own UPDATE so a retired sandbox job looks exactly like any other
 * retired job. `query` is injected so all of it is testable without a database.
 *
 * THE ORDER MATTERS. A job seen again by a crawl is made live again (the upsert clears
 * removed_at). Retire only after the guard is running on every crawler, or the next sync undoes
 * this. check-sandbox-postings.js afterwards is the proof.
 */
const { sandboxMatch } = require('../utils/sandbox-board');
const { listCompanyMatches } = require('./sandbox-check');
const { buildRetireSql, MAX_REASON } = require('../db/repositories/jobs-retire');

const BATCH_SIZE = 5000;
const RETIRE_CHUNK = 500; // the same ceiling the retire API puts on one call
const REASON_PREFIX = 'sandbox board (FA-053)';

const COMPANY_JOBS_SQL = `
  SELECT id FROM jobs
   WHERE company_id = $1::bigint AND removed_at IS NULL
   ORDER BY id`;

// Every live job whose URL could name a sandbox board, in id order. The regex is only a cheap
// pre-filter that keeps ~5M rows from crossing the wire; it is a superset of what the rule can
// match, and sandboxMatch makes the real decision on each candidate.
const URL_SCAN_SQL = `
  SELECT j.id, j.url, c.id AS company_id, c.ats AS company_ats, c.ats_slug, c.career_url
    FROM jobs j
    JOIN companies c ON c.id = j.company_id
   WHERE j.removed_at IS NULL
     AND j.id > $1::bigint
     AND j.url ~* '(sandbox|demo|test)'
   ORDER BY j.id
   LIMIT $2`;

const boardKey = (m) => `${m.ats}/${String(m.slug).toLowerCase()}`;

async function planRetirement({ query, batchSize = BATCH_SIZE, match = sandboxMatch }) {
  const boards = new Map(); // key -> { ats, slug, rule, via:Set, ids:[], sampleUrl }
  const claimed = new Set(); // a job is retired once, under the first board that claims it

  const claim = (m, id, url) => {
    const jobId = Number(id);
    if (claimed.has(jobId)) return;
    claimed.add(jobId);
    const key = boardKey(m);
    let b = boards.get(key);
    if (!b) { b = { ats: m.ats, slug: m.slug, rule: m.rule, via: new Set(), ids: [], sampleUrl: null }; boards.set(key, b); }
    b.via.add(m.via);
    b.ids.push(jobId);
    if (!b.sampleUrl && url) b.sampleUrl = url;
  };

  // A. whole companies: the board's own name is the evidence.
  const { matches } = await listCompanyMatches({ query, batchSize, match });
  for (const m of matches) {
    const { rows } = await query(COMPANY_JOBS_SQL, [m.companyId]);
    for (const r of rows) claim(m, r.id, null);
  }

  // B. single postings: the posting's URL is the evidence.
  let scanned = 0;
  let cursor = 0;
  let prev = -1;
  for (;;) {
    const { rows } = await query(URL_SCAN_SQL, [cursor, batchSize]);
    for (const r of rows) {
      scanned += 1;
      const m = match({ ats: r.company_ats, slug: r.ats_slug, careerUrl: r.career_url, url: r.url });
      if (m) claim(m, r.id, r.url);
    }
    if (rows.length < batchSize) break;
    cursor = Number(rows[rows.length - 1].id);
    // A cursor that stands still would re-read the same batch forever against a live database.
    if (cursor <= prev) throw new Error(`url scan did not advance past id ${prev}; stopping instead of looping`);
    prev = cursor;
  }

  const list = [...boards.values()]
    .map(({ via, ...b }) => ({ ...b, via: [...via].sort().join('+'), count: b.ids.length }))
    .sort((a, b) => (b.count - a.count) || `${a.ats}${a.slug}`.localeCompare(`${b.ats}${b.slug}`));
  return { boards: list, total: claimed.size, urlCandidatesScanned: scanned };
}

/** The reason stored on every job this script retires; the undo statement keys on its prefix. */
function reasonFor(board) {
  return `${REASON_PREFIX}: ${board.rule} ${board.ats}/${board.slug}`.slice(0, MAX_REASON);
}

async function applyRetirement({ query, plan, chunk = RETIRE_CHUNK }) {
  let retired = 0;
  const perBoard = [];
  for (const board of plan.boards) {
    const reason = reasonFor(board);
    let n = 0;
    for (let i = 0; i < board.ids.length; i += chunk) {
      const built = buildRetireSql({ ids: board.ids.slice(i, i + chunk), externalIds: [] });
      built.params[built.params.length - 1] = reason;
      const { rows } = await query(built.sql, built.params);
      n += rows.length;
    }
    retired += n;
    perBoard.push({ ats: board.ats, slug: board.slug, planned: board.ids.length, retired: n });
  }
  return { retired, perBoard };
}

function formatPlan(plan, { apply = false } = {}) {
  const out = [];
  if (!plan.boards.length) {
    out.push('No live sandbox jobs to retire.');
    return out.join('\n');
  }
  out.push(`${apply ? 'Retiring' : 'Would retire'} ${plan.total.toLocaleString('en-US')} live job(s) on ${plan.boards.length} sandbox board(s):`, '');
  for (const b of plan.boards) {
    out.push(`  ${b.ats}/${b.slug}   ${b.count} job(s)   rule ${b.rule} via ${b.via}`);
    if (b.sampleUrl) out.push(`      e.g. ${b.sampleUrl}`);
  }
  return out.join('\n');
}

module.exports = {
  planRetirement, applyRetirement, formatPlan, reasonFor,
  COMPANY_JOBS_SQL, URL_SCAN_SQL, REASON_PREFIX, BATCH_SIZE, RETIRE_CHUNK,
};
