'use strict';
/**
 * FA-053 — "is any recently ingested posting on a demo/sandbox board?"
 *
 * The logic behind scripts/check-sandbox-postings.js. It only ever reads. `query` is injected
 * (`(sql, params) => Promise<{rows}>`, Postgres `$n` placeholders) so the scan can be tested
 * without a database and the script can hand it a read-only transaction.
 *
 * Two questions, two functions:
 *   scanRecentPostings   every job first seen in the last N days, judged by company slug,
 *                        career_url AND the posting's own URL. This is the one that must return
 *                        zero. It reads job URLs because third-party feeds (Simplify, Resumly, ...)
 *                        file their jobs under the feed's namespace, where only the URL names the
 *                        real board.
 *   listCompanyMatches   every company whose NAME matches, whenever it was ingested. This is the
 *                        review list to read before rejection is switched on: each line is a board
 *                        that will stop being ingested, so a real employer on it needs an entry in
 *                        ALLOWED_BOARDS first.
 */
const { sandboxMatch } = require('../utils/sandbox-board');

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;
const BATCH_SIZE = 5000;
const SAMPLE_JOBS = 3;

// timestamps travel as text: node-postgres would round a microsecond timestamp to milliseconds,
// and a keyset cursor built from the rounded value re-reads (or skips) rows in that millisecond.
const SINCE_SQL = `SELECT (NOW() - make_interval(days => $1::int))::timestamp::text AS since`;

const SCAN_SQL = `
  SELECT j.id, j.url, j.first_seen_at::text AS first_seen_at, (j.removed_at IS NOT NULL) AS retired,
         c.id AS company_id, c.ats AS company_ats, c.ats_slug, c.career_url
    FROM jobs j
    JOIN companies c ON c.id = j.company_id
   WHERE (j.first_seen_at, j.id) > ($1::timestamp, $2::int)
   ORDER BY j.first_seen_at, j.id
   LIMIT $3`;

const COMPANIES_SQL = `
  SELECT c.id, c.ats, c.ats_slug, c.career_url, c.company_name, c.status, c.origin
    FROM companies c
   WHERE c.id > $1::int
   ORDER BY c.id
   LIMIT $2`;

const JOB_COUNTS_SQL = `
  SELECT company_id,
         COUNT(*) FILTER (WHERE removed_at IS NULL) AS live,
         COUNT(*) FILTER (WHERE removed_at IS NOT NULL) AS retired
    FROM jobs
   WHERE company_id = ANY($1::int[])
   GROUP BY company_id`;

function parseDays(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_DAYS;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) {
    throw new RangeError(`--days must be a whole number from 1 to ${MAX_DAYS}, got "${value}"`);
  }
  return n;
}

const boardKey = (m) => `${m.ats}:${String(m.slug).toLowerCase()}`;

async function scanRecentPostings({ query, days = DEFAULT_DAYS, batchSize = BATCH_SIZE, match = sandboxMatch }) {
  const { rows: [{ since }] } = await query(SINCE_SQL, [parseDays(days)]);

  const boards = new Map();
  let scanned = 0;
  let cursorAt = since;
  let cursorId = 0;
  let prevLast = null;

  for (;;) {
    const { rows } = await query(SCAN_SQL, [cursorAt, cursorId, batchSize]);
    for (const r of rows) {
      scanned += 1;
      const m = match({ ats: r.company_ats, slug: r.ats_slug, careerUrl: r.career_url, url: r.url });
      if (!m) continue;

      const key = boardKey(m);
      let b = boards.get(key);
      if (!b) {
        b = {
          ats: m.ats, slug: m.slug, vias: new Set(), rule: m.rule,
          companyIds: new Set(), live: 0, retired: 0,
          firstSeen: r.first_seen_at, lastSeen: r.first_seen_at, sampleUrl: r.url, sampleJobIds: [],
        };
        boards.set(key, b);
      }
      b.vias.add(m.via);
      b.companyIds.add(r.company_id);
      if (r.retired) b.retired += 1; else b.live += 1;
      if (r.first_seen_at < b.firstSeen) b.firstSeen = r.first_seen_at;
      if (r.first_seen_at > b.lastSeen) b.lastSeen = r.first_seen_at;
      if (b.sampleJobIds.length < SAMPLE_JOBS) b.sampleJobIds.push(r.id);
    }
    if (rows.length < batchSize) break;
    const last = rows[rows.length - 1];
    // Each batch must end strictly after the previous one. Kept apart from the cursor on purpose:
    // a cursor that stood still would re-read the same batch forever against a live database, and
    // a check that compared the cursor with itself would never notice.
    if (prevLast && !(last.first_seen_at > prevLast.at || (last.first_seen_at === prevLast.at && last.id > prevLast.id))) {
      throw new Error(`scan did not advance past (${prevLast.at}, ${prevLast.id}); stopping instead of looping`);
    }
    prevLast = { at: last.first_seen_at, id: last.id };
    cursorAt = last.first_seen_at;
    cursorId = last.id;
  }

  const list = [...boards.values()]
    .map(({ vias, ...b }) => ({ ...b, via: [...vias].sort().join('+'), companyIds: [...b.companyIds].sort((x, y) => x - y) }))
    .sort((x, y) => (y.live - x.live) || (y.retired - x.retired) || `${x.ats}${x.slug}`.localeCompare(`${y.ats}${y.slug}`));

  return {
    days: parseDays(days),
    since,
    scanned,
    boards: list,
    live: list.reduce((n, b) => n + b.live, 0),
    retired: list.reduce((n, b) => n + b.retired, 0),
  };
}

async function listCompanyMatches({ query, batchSize = BATCH_SIZE, match = sandboxMatch }) {
  const matches = [];
  let scanned = 0;
  let cursor = 0;

  for (;;) {
    const { rows } = await query(COMPANIES_SQL, [cursor, batchSize]);
    for (const c of rows) {
      scanned += 1;
      const m = match({ ats: c.ats, slug: c.ats_slug, careerUrl: c.career_url });
      if (m) matches.push({ companyId: c.id, name: c.company_name, status: c.status, origin: c.origin, ...m });
    }
    if (rows.length < batchSize) break;
    cursor = rows[rows.length - 1].id;
  }

  if (matches.length) {
    const { rows } = await query(JOB_COUNTS_SQL, [matches.map((m) => m.companyId)]);
    const counts = new Map(rows.map((r) => [Number(r.company_id), r]));
    for (const m of matches) {
      const r = counts.get(m.companyId);
      m.live = r ? Number(r.live) : 0;
      m.retired = r ? Number(r.retired) : 0;
    }
  }
  matches.sort((x, y) => `${x.ats}${x.slug}`.localeCompare(`${y.ats}${y.slug}`));
  return { scanned, matches };
}

function formatScan(result) {
  const out = [];
  out.push(`Sandbox postings first seen since ${result.since} (last ${result.days} days)`);
  out.push(`Scanned ${result.scanned.toLocaleString('en-US')} postings.`);
  if (!result.boards.length) {
    out.push('', 'RESULT: 0 sandbox postings.');
    return out.join('\n');
  }
  out.push('');
  for (const b of result.boards) {
    out.push(`  ${b.ats}/${b.slug}   live ${b.live}  retired ${b.retired}   rule ${b.rule} via ${b.via}`);
    out.push(`      first seen ${b.firstSeen}   last seen ${b.lastSeen}   companies ${b.companyIds.join(',')}`);
    out.push(`      e.g. ${b.sampleUrl}   (job ids ${b.sampleJobIds.join(',')})`);
  }
  out.push('', `RESULT: ${result.live} live sandbox posting(s) on ${result.boards.filter((b) => b.live).length} board(s)`
    + `, ${result.retired} already retired.`);
  return out.join('\n');
}

function formatMatches({ scanned, matches }) {
  const out = [`Reviewed ${scanned.toLocaleString('en-US')} companies; ${matches.length} match the sandbox name rule.`, ''];
  for (const m of matches) {
    out.push(`  ${m.ats}/${m.slug}   rule ${m.rule} via ${m.via}   live ${m.live}  retired ${m.retired}`
      + `   company ${m.companyId} "${m.name || ''}" status=${m.status} origin=${m.origin}`);
  }
  if (matches.length) {
    out.push('', 'Read every line. A real employer here needs an ALLOWED_BOARDS entry before rejection is enabled.');
  }
  return out.join('\n');
}

module.exports = {
  scanRecentPostings, listCompanyMatches, formatScan, formatMatches, parseDays,
  DEFAULT_DAYS, MAX_DAYS, BATCH_SIZE, SINCE_SQL, SCAN_SQL, COMPANIES_SQL, JOB_COUNTS_SQL,
};
