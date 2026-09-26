#!/usr/bin/env node
/**
 * Re-send the search documents whose employment_type or country tags changed on 2026-09-26.
 *
 *   DATABASE_URL=... NODE_ENV=production node scripts/requeue-index-recall.js          # SHADOW
 *   DATABASE_URL=... NODE_ENV=production APPLY=1 node scripts/requeue-index-recall.js  # armed
 *
 * toDocument now indexes the canonical employment_type and tags a trailing US state as the US
 * (see meili.js, location-countries.js). Documents already in the index keep the old values until
 * they are shipped again, and until then the filters keep missing them. Only two kinds of row
 * change, and both are decidable from the row alone:
 *   - employment_type whose canonical form differs from the stored text ("Full time")
 *   - location that ends in a US state (endsInUsState) — every changed country tag goes through it
 * Measured on a 2% sample that is ~35% of live jobs, so it is NOT the whole table.
 *
 * Marks them through the index_dirty_at outbox, like seed-salary-reindex.js, so the worker's
 * normal sync loop ships them — but THROTTLED on outbox depth. The loop drains ~2,000 documents
 * a tick in index_dirty_at order, so dumping 2.7M rows at once would put every genuinely new or
 * retired job a day behind them. Here a new chunk is marked only while the outbox holds fewer
 * than MAX_OUTBOX rows, which keeps that delay to a few ticks.
 *
 * Until it finishes, the filters return more results every minute and never wrong ones: an
 * unshipped document is simply still missing from the filter, as it was before.
 *
 * Walks the primary key, resumable from CKPT.
 * Env: BATCH (20000 ids scanned per step) · MAX_OUTBOX (4000) · POLL_MS (20000) · CKPT
 */
const fs = require('fs');
const db = require('../src/db/connection');

// render-deploy's connection module has no queryWithTimeout (its pool already allows 60s), so fall
// back to plain query there. This script runs from either branch.
const longQuery = db.queryWithTimeout
  ? (sql, params) => db.queryWithTimeout(sql, params, 120000)
  : (sql, params) => db.query(sql, params);
const { normalizeEmploymentType } = require('../src/utils/extract');
const { endsInUsState } = require('../src/utils/location-countries');

const APPLY = process.env.APPLY === '1';
const BATCH = parseInt(process.env.BATCH || '20000', 10);
const MAX_OUTBOX = parseInt(process.env.MAX_OUTBOX || '4000', 10);
const POLL_MS = parseInt(process.env.POLL_MS || '20000', 10);
const CKPT = process.env.CKPT || '/tmp/index-recall-requeue.pos';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Each statement on its own dedicated client with a raised timeout. The first shadow run
// (2026-09-26) died at 30% with "Query read timeout": a session-level `SET statement_timeout = 0`
// only reaches whichever pooled connection ran it, so later queries kept the pool's 20s
// client-side abort — which one slow range over the SSH tunnel exceeded. Retried with backoff,
// as seed-salary-reindex.js does, so a blip costs a few seconds instead of the run.
async function run(sql, params = []) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await longQuery(sql, params);
    } catch (err) {
      if (attempt === 5) throw err;
      console.error(`\n  retry ${attempt + 1}: ${err.message}`);
      await sleep(2000 * (attempt + 1) ** 2);
    }
  }
}

/** Pure. Would this row's document change under the 2026-09-26 toDocument? */
function needsResend(row) {
  // Case alone does not count: Meilisearch equality ignores it, so "Full-Time" already matched.
  // Those are ~11% of live jobs and re-sending them would change nothing a filter sees.
  const canon = normalizeEmploymentType(row.employment_type);
  if (canon && canon.toLowerCase() !== String(row.employment_type).toLowerCase()) return true;
  return !!row.location && endsInUsState(row.location);
}

async function outboxDepth() {
  const { rows: [r] } = await run('SELECT COUNT(*)::int n FROM jobs WHERE index_dirty_at IS NOT NULL');
  return r.n;
}

async function main() {
  console.log(`mode: ${APPLY ? 'APPLY' : 'SHADOW'}`);
  const { rows: [b] } = await run('SELECT MIN(id) AS lo, MAX(id) AS hi FROM jobs');
  let from = Number(b.lo) - 1;
  const hi = Number(b.hi);
  if (APPLY && fs.existsSync(CKPT)) {
    const saved = parseInt(fs.readFileSync(CKPT, 'utf8').trim(), 10);
    if (Number.isFinite(saved) && saved > from) { from = saved; console.log(`resuming from ${from.toLocaleString()}`); }
  }

  let scanned = 0, marked = 0, batches = 0;
  const started = Date.now();
  while (from < hi) {
    const to = Math.min(from + BATCH, hi);
    const { rows } = await run(
      `SELECT id, employment_type, location FROM jobs
        WHERE id > ${from} AND id <= ${to} AND removed_at IS NULL`);
    const ids = rows.filter(needsResend).map((r) => r.id);
    scanned += rows.length;

    if (APPLY && ids.length) {
      while (await outboxDepth() >= MAX_OUTBOX) await sleep(POLL_MS);
      const r = await run(
        'UPDATE jobs SET index_dirty_at = COALESCE(index_dirty_at, NOW()) WHERE id = ANY($1::int[])', [ids]);
      marked += r.rowCount || 0;
    } else {
      marked += ids.length;
    }
    from = to;
    if (APPLY) fs.writeFileSync(CKPT, String(from));
    if (++batches % 10 === 0) {
      const pct = ((from - Number(b.lo)) / (hi - Number(b.lo)) * 100).toFixed(1);
      process.stdout.write(`\r  ${pct}% of id space | scanned ${scanned.toLocaleString()} | ${APPLY ? 'marked' : 'would mark'} ${marked.toLocaleString()} | ${((Date.now() - started) / 60000).toFixed(1)}m   `);
    }
  }

  console.log(`\n\n=== ${APPLY ? 'APPLIED' : 'SHADOW (nothing written)'} ===`);
  console.log(`live jobs scanned: ${scanned.toLocaleString()} · documents ${APPLY ? 'queued' : 'to queue'}: ${marked.toLocaleString()}`);
  await db.closeDb();
}

if (require.main === module) main().catch((err) => { console.error('\n', err.message); process.exit(1); });
module.exports = { needsResend };
