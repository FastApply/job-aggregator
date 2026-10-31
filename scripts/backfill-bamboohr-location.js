#!/usr/bin/env node
/**
 * Give live BambooHR rows the place their stored listing already names.
 *
 *   DATABASE_URL=... NODE_ENV=production node scripts/backfill-bamboohr-location.js          # SHADOW
 *   DATABASE_URL=... NODE_ENV=production APPLY=1 node scripts/backfill-bamboohr-location.js  # armed
 *
 * The adapter read only `location`, and a role with no office names its place in `atsLocation`
 * (fixed in #47/#48). The rows heal when the crawl reaches them, but that is slow: 5 hours after
 * the fix 10,203 of 10,261 were still empty, and keymediahr was last crawled on 2026-10-21. First
 * Apply reads an empty place as open anywhere: Key Media's New York sales role, which says
 * "working remotely in the United States", went to a candidate authorised only in Romania.
 *
 * The listing is already in raw_data, so nothing is fetched. remote_worldwide is re-derived, since
 * it was true only because no place was named. The index trigger queues each changed row, so this
 * waits while the outbox holds MAX_OUTBOX rows. Resumable from CKPT.
 * Env: BATCH (1000 rows per step) · MAX_OUTBOX (20000) · POLL_MS (20000) · CKPT
 */
const fs = require('fs');
const { locationOf } = require('../src/adapters/bamboohr');
const { classifyJob } = require('../src/utils/classify');

/** Pure. The row's new place and worldwide tag, or null when its listing names no place. */
function placed(row) {
  let listing;
  try {
    listing = typeof row.raw_data === 'string' ? JSON.parse(row.raw_data) : row.raw_data;
  } catch {
    return null;
  }
  const location = listing ? locationOf(null, listing) : null;
  if (!location) return null;
  const tags = classifyJob({
    title: row.title,
    location,
    workplace_type: row.workplace_type,
    description: row.description,
  });
  return { location, remote_worldwide: !!(row.is_remote && tags.remote_worldwide) };
}

async function main() {
  const db = require('../src/db/connection');
  const longQuery = db.queryWithTimeout
    ? (sql, params) => db.queryWithTimeout(sql, params, 120000)
    : (sql, params) => db.query(sql, params);
  const APPLY = process.env.APPLY === '1';
  const BATCH = parseInt(process.env.BATCH || '1000', 10);
  const MAX_OUTBOX = parseInt(process.env.MAX_OUTBOX || '20000', 10);
  const POLL_MS = parseInt(process.env.POLL_MS || '20000', 10);
  const CKPT = process.env.CKPT || '/tmp/bamboohr-location-backfill.pos';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let from = 0;
  if (APPLY && fs.existsSync(CKPT)) {
    const saved = parseInt(fs.readFileSync(CKPT, 'utf8').trim(), 10);
    if (Number.isFinite(saved)) { from = saved; console.log(`resuming from ${from}`); }
  }
  console.log(`mode: ${APPLY ? 'APPLY' : 'SHADOW'}`);
  let scanned = 0, changed = 0, worldwideCleared = 0;
  const samples = [];
  for (;;) {
    const { rows } = await longQuery(
      `SELECT id, title, workplace_type, description, is_remote, remote_worldwide, raw_data FROM jobs
        WHERE ats = 'bamboohr' AND removed_at IS NULL AND location IS NULL AND id > $1
        ORDER BY id LIMIT $2`, [from, BATCH]);
    if (rows.length === 0) break;
    from = Number(rows[rows.length - 1].id);
    scanned += rows.length;
    const ids = [], places = [], worldwide = [];
    for (const row of rows) {
      const next = placed(row);
      if (!next) continue;
      ids.push(row.id); places.push(next.location); worldwide.push(next.remote_worldwide);
      if (row.remote_worldwide && !next.remote_worldwide) worldwideCleared++;
      if (samples.length < 8) samples.push(`${row.id} ${row.title} -> ${next.location}`);
    }
    if (APPLY && ids.length) {
      for (;;) {
        const { rows: [o] } = await longQuery('SELECT COUNT(*)::int n FROM jobs WHERE index_dirty_at IS NOT NULL');
        if (o.n < MAX_OUTBOX) break;
        await sleep(POLL_MS);
      }
      const r = await longQuery(
        `UPDATE jobs j SET location = v.place, remote_worldwide = v.ww
           FROM unnest($1::bigint[], $2::text[], $3::boolean[]) AS v(id, place, ww)
          WHERE j.id = v.id AND j.location IS NULL`, [ids, places, worldwide]);
      changed += r.rowCount || 0;
      fs.writeFileSync(CKPT, String(from));
    } else {
      changed += ids.length;
    }
    process.stdout.write(`\r  scanned ${scanned} | ${APPLY ? 'placed' : 'would place'} ${changed}`);
  }
  console.log(`\nscanned ${scanned}, ${APPLY ? 'placed' : 'would place'} ${changed}, worldwide cleared ${worldwideCleared}`);
  console.log(samples.join('\n'));
  if (db.closeDb) await db.closeDb();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { placed };
