#!/usr/bin/env node
/**
 * Replace "4 Locations" on live Workday rows with the posting's place, read from Workday's API.
 *
 *   DATABASE_URL=... NODE_ENV=production node scripts/backfill-workday-places.js          # SHADOW
 *   DATABASE_URL=... NODE_ENV=production APPLY=1 node scripts/backfill-workday-places.js  # armed
 *
 * When the detail call failed the adapter stored the list page's count as the location (fixed in
 * workday.js with the upsert keeping a stored place). The next good crawl heals a row, but 11,641
 * are live and many are on tenants whose detail calls keep failing, so this walks them at a pace
 * Workday accepts. SHADOW reads LIMIT rows (default 200) and reports how many it could place.
 * One request a row. A row whose posting answers with no place is left as it is. Resumable.
 * Env: LIMIT · CONCURRENCY (3) · PAUSE_MS (250) · MAX_OUTBOX (20000) · POLL_MS (20000) · CKPT
 */
const fs = require('fs');

const PLACE_COUNT_SQL = '^[0-9]+ locations?$';

/** Pure. The API address of a posting's URL, or null for a URL that is not a Workday posting. */
function cxsUrl(jobUrl) {
  let url;
  try { url = new URL(jobUrl); } catch { return null; }
  const tenant = /^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/i.exec(url.hostname)?.[1];
  if (!tenant) return null;
  const path = url.pathname.split('/').filter(Boolean);
  const parts = /^[a-z]{2}-[A-Z]{2}$/.test(path[0] || '') ? path.slice(1) : path;
  if (parts[1] !== 'job' || parts.length < 3) return null;
  return `https://${url.hostname}/wday/cxs/${tenant}/${parts[0]}/${parts.slice(1).join('/')}`;
}

/** Pure. The place in the API's answer, or null. */
const placeIn = (body) => {
  const place = body?.jobPostingInfo?.location;
  return typeof place === 'string' && place.trim() ? place.trim() : null;
};

async function main() {
  const db = require('../src/db/connection');
  const query = db.queryWithTimeout
    ? (sql, params) => db.queryWithTimeout(sql, params, 120000)
    : (sql, params) => db.query(sql, params);
  const APPLY = process.env.APPLY === '1';
  const LIMIT = parseInt(process.env.LIMIT || (APPLY ? '100000' : '200'), 10);
  const CONCURRENCY = parseInt(process.env.CONCURRENCY || '3', 10);
  const PAUSE_MS = parseInt(process.env.PAUSE_MS || '250', 10);
  const MAX_OUTBOX = parseInt(process.env.MAX_OUTBOX || '20000', 10);
  const POLL_MS = parseInt(process.env.POLL_MS || '20000', 10);
  const CKPT = process.env.CKPT || '/tmp/workday-places-backfill.pos';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let from = 0;
  if (APPLY && fs.existsSync(CKPT)) {
    const saved = parseInt(fs.readFileSync(CKPT, 'utf8').trim(), 10);
    if (Number.isFinite(saved)) { from = saved; console.log(`resuming from ${from}`); }
  }
  console.log(`mode: ${APPLY ? 'APPLY' : 'SHADOW'}`);
  let scanned = 0, placed = 0, missed = 0;
  const samples = [];
  while (scanned < LIMIT) {
    const { rows } = await query(
      `SELECT id, url FROM jobs
        WHERE ats = 'workday' AND removed_at IS NULL AND location ~* $1 AND id > $2
        ORDER BY id LIMIT $3`, [PLACE_COUNT_SQL, from, Math.min(300, LIMIT - scanned)]);
    if (rows.length === 0) break;
    from = Number(rows[rows.length - 1].id);
    scanned += rows.length;
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      await Promise.all(rows.slice(i, i + CONCURRENCY).map(async (row) => {
        const api = cxsUrl(row.url);
        let place = null;
        if (api) {
          try {
            const res = await fetch(api, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
            if (res.ok) place = placeIn(await res.json());
          } catch { /* a miss: the row stays as it is */ }
        }
        if (!place) { missed++; return; }
        placed++;
        if (samples.length < 8) samples.push(`${row.id} -> ${place}`);
        if (APPLY) await query('UPDATE jobs SET location = $1 WHERE id = $2 AND location ~* $3', [place, row.id, PLACE_COUNT_SQL]);
      }));
      await sleep(PAUSE_MS);
    }
    if (APPLY) {
      fs.writeFileSync(CKPT, String(from));
      for (;;) {
        const { rows: [o] } = await query('SELECT COUNT(*)::int n FROM jobs WHERE index_dirty_at IS NOT NULL');
        if (o.n < MAX_OUTBOX) break;
        await sleep(POLL_MS);
      }
    }
    process.stdout.write(`\r  scanned ${scanned} | ${APPLY ? 'placed' : 'could place'} ${placed} | no answer ${missed}`);
  }
  console.log(`\nscanned ${scanned}, ${APPLY ? 'placed' : 'could place'} ${placed}, no answer ${missed}`);
  console.log(samples.join('\n'));
  if (db.closeDb) await db.closeDb();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { cxsUrl, placeIn };
