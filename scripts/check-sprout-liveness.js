#!/usr/bin/env node
/**
 * Retire live Sprout rows that Sprout itself has expired.
 *
 * On a 'direct' site (no adapter) and on Workday sites the worker does not crawl, Sprout is the
 * only source for a job, and nothing re-checks it: the pull stores what it finds and never retires,
 * and the dead-link check only reads the employer page now and then. Sprout's open detail endpoint
 * answers 404 once a posting expires (every stored payload says status ACTIVE; expiry is the 404),
 * so ask it again for each live row and retire on a 404 or a non-ACTIVE status.
 *
 *   DATABASE_URL=... node scripts/check-sprout-liveness.js                 # shadow, all rows
 *   DATABASE_URL=... LIMIT=2000 node scripts/check-sprout-liveness.js      # shadow sample
 *   DATABASE_URL=... APPLY=1 node scripts/check-sprout-liveness.js         # retire
 *
 * Only a definite answer counts: 404, or 200 with a status other than ACTIVE. Timeouts, 429s and
 * 5xx leave the row alone. Oldest-checked first via CKPT (last id), resumable.
 *
 * Env: CONC (8 requests in flight), LIMIT (rows, shadow), BATCH (2000 rows per read),
 *      CKPT (/tmp/sprout-liveness.pos), MAX_OUTBOX (20000).
 */
const fs = require('fs');
const { Pool } = require('pg');

const URL_ = process.env.DATABASE_URL;
if (!URL_) { console.error('DATABASE_URL is required'); process.exit(1); }
const APPLY = process.env.APPLY === '1';
const CONC = parseInt(process.env.CONC || '8', 10);
const LIMIT = parseInt(process.env.LIMIT || '0', 10);
const BATCH = parseInt(process.env.BATCH || '2000', 10);
const CKPT = process.env.CKPT || '/tmp/sprout-liveness.pos';
const MAX_OUTBOX = parseInt(process.env.MAX_OUTBOX || '20000', 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sprout(id) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://api.usesprout.com/jobs/${id}`, {
        headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (res.status === 404) return 'gone';
      if (res.ok) {
        const d = await res.json().catch(() => null);
        if (!d) return 'unknown';
        return (d.status || 'ACTIVE') === 'ACTIVE' ? 'live' : 'gone';
      }
      if (res.status === 429 || res.status >= 500) { await sleep(2000 * (attempt + 1)); continue; }
      return 'unknown';
    } catch { await sleep(1000 * (attempt + 1)); }
  }
  return 'unknown';
}

async function main() {
  const pool = new Pool({ connectionString: URL_, max: 2 });
  const q = (sql, p) => pool.query(sql, p);
  let from = 0;
  if (APPLY && fs.existsSync(CKPT)) from = parseInt(fs.readFileSync(CKPT, 'utf8'), 10) || 0;
  console.log(`mode: ${APPLY ? 'APPLY' : 'SHADOW'}${LIMIT ? ` · limit ${LIMIT}` : ''} · conc ${CONC}${from ? ` · from id ${from}` : ''}`);
  const tally = { live: 0, gone: 0, unknown: 0 };
  let seen = 0, retired = 0;
  for (;;) {
    const { rows } = await q(
      `SELECT id, substring(external_id from 8) AS sid FROM jobs
        WHERE id > $1 AND removed_at IS NULL AND external_id LIKE 'sprout\\_%'
        ORDER BY id LIMIT $2`, [from, LIMIT ? Math.min(BATCH, LIMIT - seen) : BATCH]);
    if (!rows.length) break;
    const gone = [];
    let i = 0;
    await Promise.all(Array.from({ length: CONC }, async () => {
      while (i < rows.length) {
        const r = rows[i++];
        const v = await sprout(r.sid);
        tally[v]++;
        if (v === 'gone') gone.push(r.id);
      }
    }));
    seen += rows.length;
    from = rows[rows.length - 1].id;
    if (APPLY && gone.length) {
      for (;;) {
        const { rows: [o] } = await q('SELECT COUNT(*)::int n FROM jobs WHERE index_dirty_at IS NOT NULL');
        if (o.n < MAX_OUTBOX) break;
        await sleep(20000);
      }
      const res = await q(`UPDATE jobs SET removed_at = NOW() WHERE id = ANY($1::bigint[]) AND removed_at IS NULL`, [gone]);
      retired += res.rowCount;
    }
    if (APPLY) fs.writeFileSync(CKPT, String(from));
    process.stdout.write(`\r  checked ${seen.toLocaleString()} | live ${tally.live.toLocaleString()} | gone ${tally.gone.toLocaleString()} | unknown ${tally.unknown.toLocaleString()}${APPLY ? ` | retired ${retired.toLocaleString()}` : ''}   `);
    if (LIMIT && seen >= LIMIT) break;
  }
  console.log(`\n${APPLY ? `retired ${retired.toLocaleString()}` : `would retire ${tally.gone.toLocaleString()}`} of ${seen.toLocaleString()} checked.`);
  if (APPLY && !LIMIT && fs.existsSync(CKPT)) fs.unlinkSync(CKPT);   // full sweep done: next run starts over
  await pool.end();
}

main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
