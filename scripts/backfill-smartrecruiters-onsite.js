#!/usr/bin/env node
/**
 * Give stored SmartRecruiters rows the on-site work model SmartRecruiters states for them.
 *
 *   DATABASE_URL=... NODE_ENV=production node scripts/backfill-smartrecruiters-onsite.js          # SHADOW
 *   DATABASE_URL=... NODE_ENV=production APPLY=1 node scripts/backfill-smartrecruiters-onsite.js  # armed
 *
 * The adapter stored workplace_type null when a posting's location said remote: false and
 * hybrid: false, which is SmartRecruiters' on-site. A later text reader then tagged some of those
 * rows remote, and remote-only searches got them: on 2026-11-10 every one of 130 sampled
 * SmartRecruiters rows flagged remote with no work model was on-site in SmartRecruiters, and First
 * Apply judged 297 such rows in a week (186 Domino's store jobs), each refused as on-site.
 *
 * The adapter now stores 'onsite' (srWorkplaceType), and a crawl repairs a row it sees again. This
 * repairs the rest now, from the stored list response (raw_data.location), without calling
 * SmartRecruiters. Only live crawled rows (external_id "smartrecruiters_...") that are flagged
 * remote, carry no work model, and whose stored location says remote false and hybrid false.
 * The index trigger queues each changed row, so this waits while the outbox holds MAX_OUTBOX rows.
 *
 * Walks the primary key, resumable from CKPT.
 * Env: BATCH (5000 ids per step) · MAX_OUTBOX (20000) · POLL_MS (20000) · CKPT
 */
const fs = require('fs');
const { srWorkplaceType } = require('../src/adapters/smartrecruiters');

/** Pure. True when the stored list response says SmartRecruiters' on-site. */
function storedOnsite(rawData) {
  let raw = rawData;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return false; }
  }
  return srWorkplaceType(raw?.location) === 'onsite';
}

async function main() {
  const db = require('../src/db/connection');
  const longQuery = db.queryWithTimeout
    ? (sql, params) => db.queryWithTimeout(sql, params, 120000)
    : (sql, params) => db.query(sql, params);
  const APPLY = process.env.APPLY === '1';
  const BATCH = parseInt(process.env.BATCH || '5000', 10);
  const MAX_OUTBOX = parseInt(process.env.MAX_OUTBOX || '20000', 10);
  const POLL_MS = parseInt(process.env.POLL_MS || '20000', 10);
  const CKPT = process.env.CKPT || '/tmp/sr-onsite-backfill.pos';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const run = async (sql, params = []) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await longQuery(sql, params);
      } catch (err) {
        if (attempt === 5) throw err;
        console.error(`\n  retry ${attempt + 1}: ${err.message}`);
        await sleep(2000 * (attempt + 1) ** 2);
      }
    }
  };

  console.log(`mode: ${APPLY ? 'APPLY' : 'SHADOW'}`);
  const { rows: [b] } = await run('SELECT MIN(id) AS lo, MAX(id) AS hi FROM jobs');
  let from = Number(b.lo) - 1;
  const hi = Number(b.hi);
  if (APPLY && fs.existsSync(CKPT)) {
    const saved = parseInt(fs.readFileSync(CKPT, 'utf8').trim(), 10);
    if (Number.isFinite(saved) && saved > from) { from = saved; console.log(`resuming from ${from.toLocaleString()}`); }
  }
  let scanned = 0, fixed = 0, batches = 0;
  const sample = [];
  while (from < hi) {
    const to = Math.min(from + BATCH, hi);
    const { rows } = await run(
      `SELECT id, title, raw_data FROM jobs
        WHERE id > ${from} AND id <= ${to} AND ats = 'smartrecruiters' AND removed_at IS NULL
          AND is_remote = true AND workplace_type IS NULL
          AND left(external_id, 16) = 'smartrecruiters_'`);
    scanned += rows.length;
    const ids = rows.filter((r) => storedOnsite(r.raw_data)).map((r) => r.id);
    for (const r of rows) if (sample.length < 10 && ids.includes(r.id)) sample.push(`${r.id} ${r.title}`);
    if (APPLY && ids.length) {
      for (;;) {
        const { rows: [o] } = await run('SELECT COUNT(*)::int n FROM jobs WHERE index_dirty_at IS NOT NULL');
        if (o.n < MAX_OUTBOX) break;
        await sleep(POLL_MS);
      }
      const r = await run(
        `UPDATE jobs SET workplace_type = 'Onsite', is_remote = false, remote_worldwide = false
          WHERE id = ANY($1::bigint[]) AND workplace_type IS NULL AND is_remote = true`, [ids]);
      fixed += r.rowCount || 0;
    } else {
      fixed += ids.length;
    }
    from = to;
    if (APPLY) fs.writeFileSync(CKPT, String(from));
    if (++batches % 20 === 0) {
      const pct = ((from - Number(b.lo)) / Math.max(1, hi - Number(b.lo)) * 100).toFixed(1);
      process.stdout.write(`\r  ${pct}% | remote rows with no work model ${scanned.toLocaleString()} | ${APPLY ? 'fixed' : 'would fix'} ${fixed.toLocaleString()}   `);
    }
  }
  console.log(`\nremote SmartRecruiters rows with no work model ${scanned.toLocaleString()}, ${APPLY ? 'set on-site' : 'would set on-site'} ${fixed.toLocaleString()}`);
  console.log('sample', sample);
  if (db.closeDb) await db.closeDb();
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { storedOnsite };
