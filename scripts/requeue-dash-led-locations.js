#!/usr/bin/env node
/**
 * Re-send the search documents of postings whose location reads "<label> - City, ST".
 *
 *   DATABASE_URL=... NODE_ENV=production node scripts/requeue-dash-led-locations.js          # SHADOW
 *   DATABASE_URL=... NODE_ENV=production APPLY=1 node scripts/requeue-dash-led-locations.js  # armed
 *
 * location-countries.js used to read the trailing code of "HQ - San Diego, CA" as Canada. The tag
 * is written at index time, so a document already in the index keeps it until it is shipped again:
 * until then a Canada search still returns San Diego. Marks only those rows, through the
 * index_dirty_at outbox, throttled like requeue-index-recall.js.
 *
 * Env: BATCH (20000 ids scanned per step) · MAX_OUTBOX (4000) · POLL_MS (20000) · CKPT
 */
const fs = require('fs');
const db = require('../src/db/connection');

const longQuery = db.queryWithTimeout
  ? (sql, params) => db.queryWithTimeout(sql, params, 120000)
  : (sql, params) => db.query(sql, params);

const APPLY = process.env.APPLY === '1';
const BATCH = parseInt(process.env.BATCH || '20000', 10);
const MAX_OUTBOX = parseInt(process.env.MAX_OUTBOX || '4000', 10);
const POLL_MS = parseInt(process.env.POLL_MS || '20000', 10);
const CKPT = process.env.CKPT || '/tmp/dash-led-requeue.pos';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DASH_LED_CITY_STATE = /^[^,;|/]+ - [^,;|/]+, [A-Z]{2}$/;

/** Pure. Would this row's country tag change? */
function needsResend(row) {
  return !!row.location && DASH_LED_CITY_STATE.test(row.location.trim());
}

async function run(sql, params = []) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await longQuery(sql, params);
    } catch (err) {
      if (attempt === 5) throw err;
      await sleep(2000 * (attempt + 1) ** 2);
    }
  }
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
    if (Number.isFinite(saved) && saved > from) from = saved;
  }
  let scanned = 0, marked = 0;
  const samples = [];
  while (from < hi) {
    const to = Math.min(from + BATCH, hi);
    const { rows } = await run(
      `SELECT id, location FROM jobs WHERE id > ${from} AND id <= ${to} AND removed_at IS NULL`);
    const hits = rows.filter(needsResend);
    const ids = hits.map((r) => r.id);
    for (const r of hits) if (samples.length < 20) samples.push(r.location);
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
  }
  console.log(`${APPLY ? 'APPLIED' : 'SHADOW (nothing written)'}: scanned ${scanned}, ${APPLY ? 'queued' : 'to queue'} ${marked}`);
  console.log(samples.join('\n'));
  await db.closeDb();
}

if (require.main === module) main().catch((err) => { console.error(err.message); process.exit(1); });
module.exports = { needsResend };
