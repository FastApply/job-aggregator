#!/usr/bin/env node
/**
 * Give live Avature rows the place their job page names.
 *
 *   DATABASE_URL=... NODE_ENV=production node scripts/backfill-avature-location.js          # SHADOW (LIMIT 40)
 *   DATABASE_URL=... NODE_ENV=production APPLY=1 node scripts/backfill-avature-location.js  # armed
 *
 * 3,882 of 25,672 live Avature rows had no location on 2026-11-01. A crawl reads only the first
 * AVATURE_DETAIL_MAX job pages, and many sites name the place only there (Bupa 1,605, Unifi 547), so
 * those rows wait a long time. First Apply reads an empty place as open anywhere. Each page goes
 * through the adapter's one queue, 1.5 seconds apart, so a full run takes about 100 minutes.
 * COALESCE in the upsert keeps what this writes. Resumable from CKPT.
 * Env: LIMIT (40 in shadow, none when armed) · MAX_OUTBOX (20000) · POLL_MS (20000) · CKPT
 */
const fs = require('fs');
const { fetchLocation } = require('../src/adapters/avature');

async function main() {
  const db = require('../src/db/connection');
  const APPLY = process.env.APPLY === '1';
  const LIMIT = parseInt(process.env.LIMIT || (APPLY ? '0' : '40'), 10);
  const MAX_OUTBOX = parseInt(process.env.MAX_OUTBOX || '20000', 10);
  const POLL_MS = parseInt(process.env.POLL_MS || '20000', 10);
  const CKPT = process.env.CKPT || '/tmp/avature-location-backfill.pos';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let from = 0;
  if (APPLY && fs.existsSync(CKPT)) {
    const saved = parseInt(fs.readFileSync(CKPT, 'utf8').trim(), 10);
    if (Number.isFinite(saved)) { from = saved; console.log(`resuming from ${from}`); }
  }
  console.log(`mode: ${APPLY ? 'APPLY' : 'SHADOW'}`);
  let scanned = 0, placed = 0, noPlace = 0, failed = 0;
  const samples = [];
  for (;;) {
    const { rows } = await db.query(
      `SELECT id, title, url FROM jobs
        WHERE ats = 'avature' AND removed_at IS NULL AND location IS NULL AND id > $1
        ORDER BY id LIMIT 200`, [from]);
    if (rows.length === 0) break;
    for (const row of rows) {
      if (LIMIT && scanned >= LIMIT) break;
      from = Number(row.id);
      scanned++;
      let location = null;
      try { location = await fetchLocation(row.url); } catch { failed++; continue; }
      if (!location) { noPlace++; continue; }
      if (samples.length < 12) samples.push(`${row.id} ${row.title} -> ${location}`);
      placed++;
      if (APPLY) {
        for (;;) {
          const { rows: [o] } = await db.query('SELECT COUNT(*)::int n FROM jobs WHERE index_dirty_at IS NOT NULL');
          if (o.n < MAX_OUTBOX) break;
          await sleep(POLL_MS);
        }
        await db.query('UPDATE jobs SET location = $1 WHERE id = $2 AND location IS NULL', [location, row.id]);
        fs.writeFileSync(CKPT, String(from));
      }
    }
    process.stdout.write(`\r  scanned ${scanned} | ${APPLY ? 'placed' : 'would place'} ${placed} | no place ${noPlace} | failed ${failed}`);
    if (LIMIT && scanned >= LIMIT) break;
  }
  console.log(`\nscanned ${scanned}, ${APPLY ? 'placed' : 'would place'} ${placed}, no place ${noPlace}, failed ${failed}`);
  console.log(samples.join('\n'));
  if (db.closeDb) await db.closeDb();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
