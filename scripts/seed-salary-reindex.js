#!/usr/bin/env node
/**
 * Mark for reindexing ONLY the jobs whose documents need the new salary fields.
 *
 *   DATABASE_URL=... NODE_ENV=production node scripts/seed-salary-reindex.js          # SHADOW
 *   DATABASE_URL=... NODE_ENV=production APPLY=1 node scripts/seed-salary-reindex.js  # armed
 *
 * meili-init.js --seed marks EVERY live job. The sync loop ships MEILI_SYNC_BATCH (500) documents
 * a minute, so 5.2M live jobs is roughly seven days of draining — during which genuinely changed
 * jobs queue behind the backlog and take that long to reach users.
 *
 * Only rows that HAVE an annualised salary need their document refreshed. A job without one is
 * excluded by the filter's `salary_min_annual EXISTS` clause whether or not its document is
 * current, so reindexing it changes nothing. That is ~775k rows instead of 5.2M.
 *
 * Until the drain completes the salary filter returns FEWER results than it eventually will,
 * never wrong ones: a document that has not yet been refreshed simply lacks the field and is
 * excluded.
 *
 * Walks the primary key rather than filtering on index_dirty_at: that column's index is partial
 * (non-null only), so `index_dirty_at IS NULL` cannot use it and degrades to a scan restarting
 * from the beginning each batch — the same trap documented in meili-init.js.
 *
 * Env: BATCH (20000) · CKPT
 */
const fs = require('fs');
const { query, closeDb } = require('../src/db/connection');

const APPLY = process.env.APPLY === '1';
const BATCH = parseInt(process.env.BATCH || '20000', 10);
const CKPT = process.env.CKPT || '/tmp/salary-reindex-seed.pos';

async function main() {
  console.log(`mode: ${APPLY ? 'APPLY' : 'SHADOW'}`);
  await query('SET statement_timeout = 0');

  const { rows: [b] } = await query('SELECT MIN(id) AS lo, MAX(id) AS hi FROM jobs');
  let from = Number(b.lo) - 1;
  const hi = Number(b.hi);
  if (APPLY && fs.existsSync(CKPT)) {
    const saved = parseInt(fs.readFileSync(CKPT, 'utf8').trim(), 10);
    if (Number.isFinite(saved) && saved > from) { from = saved; console.log(`resuming from ${from.toLocaleString()}`); }
  }

  let marked = 0, batches = 0;
  const started = Date.now();
  while (from < hi) {
    const to = Math.min(from + BATCH, hi);
    const where = `id > ${from} AND id <= ${to} AND removed_at IS NULL AND salary_min_annual IS NOT NULL`;
    let ok = false;
    for (let attempt = 0; attempt < 6 && !ok; attempt++) {
      try {
        if (APPLY) {
          const r = await query(`UPDATE jobs SET index_dirty_at = COALESCE(index_dirty_at, NOW()) WHERE ${where}`);
          marked += r.rowCount || 0;
        } else {
          const { rows: [c] } = await query(`SELECT COUNT(*)::int n FROM jobs WHERE ${where}`);
          marked += c.n;
        }
        ok = true;
      } catch (err) {
        if (attempt === 5) console.error(`\n  range ${from}-${to} skipped: ${err.message}`);
        else await new Promise((r) => setTimeout(r, 2000 * (attempt + 1) ** 2));
      }
    }
    from = to;
    if (APPLY) fs.writeFileSync(CKPT, String(from));
    if (++batches % 20 === 0) {
      const pct = ((from - Number(b.lo)) / (hi - Number(b.lo)) * 100).toFixed(1);
      process.stdout.write(`\r  ${pct}% of id space | marked ${marked.toLocaleString()} | ${((Date.now() - started) / 60000).toFixed(1)}m   `);
    }
  }

  console.log(`\n\n=== ${APPLY ? 'APPLIED' : 'SHADOW (nothing written)'} ===`);
  console.log(`documents queued for reindex: ${marked.toLocaleString()}`);
  console.log(`at MEILI_SYNC_BATCH=500 per minute that drains in ~${(marked / 500 / 60).toFixed(1)} hours`);
  await closeDb();
}

main().catch((err) => { console.error('\n', err.message); process.exit(1); });
