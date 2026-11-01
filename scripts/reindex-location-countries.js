#!/usr/bin/env node
/**
 * Queue for re-indexing the live jobs whose location_countries the 2026-11-01 readings change.
 *
 *   DATABASE_URL=... NODE_ENV=production node scripts/reindex-location-countries.js          # SHADOW
 *   DATABASE_URL=... NODE_ENV=production APPLY=1 node scripts/reindex-location-countries.js  # armed
 *
 * location_countries is written when a document is indexed (meili.js), so the new readings in
 * location-countries.js and location-subdivisions.js reach a stored row only when it is indexed
 * again. Until then the home-city filter (`home=City|Country`) drops it as "elsewhere":
 *   - "Mumbai, MH", "Hyderabad, TG", "Gurugram, HR": read as the Marshall Islands, Togo, Croatia
 *   - "London, UK", "UK - Remote", "London, UK; Paris, France": no gb
 *   - "Mumbai (Andheri East), IN": read as Indiana
 *   - "4660 La Jolla Village Dr #100, San Diego, CA": read as Canada
 * A row is queued (index_dirty_at) only when its location has one of those shapes AND today's
 * reading of it holds the country the old one missed; meili-sync ships it on its next pass. No
 * column but index_dirty_at is written. The trigger-free UPDATE keeps an earlier stamp.
 *
 * Walks the primary key in batches (no table-wide scan in one statement: the board's disk stalls
 * under those) and sleeps PAUSE_MS between batches. Resumable from CKPT.
 * Env: BATCH (5000) · PAUSE_MS (200) · CKPT
 */
const fs = require('fs');
const { countriesFromLocation, NAME } = require('../src/utils/location-countries');

const SHAPES = [
  // An Indian state code that is also an ISO code, after a city.
  [/,\s*(?:MH|TG|HR)\s*$/i, 'in'],
  // A standalone UK.
  [/(?:^|[,;/|]|\s-\s)\s*(?:remote\s+)?uk(?:\s+remote)?\s*(?=$|[,;/|]|\s-\s)/i, 'gb'],
  // A district in brackets, then a state code.
  [/\)\s*,\s*[A-Za-z]{2}\s*$/, null],
  // A street address, the city, a state code that is also a country code.
  [/^\s*\d+[A-Za-z]?\s+[^,]+,\s*[^,]+,\s*[A-Za-z]{2}\s*$/, 'us'],
];

/** Pure. The country today's reading adds for this location, or null when it needs no reindex. */
function needsReindex(location) {
  const loc = String(location || '');
  if (!loc) return null;
  for (const [shape, code] of SHAPES) {
    if (!shape.test(loc)) continue;
    // A street address before "City, ST" only changed where ST is also a country code (CA, DE,
    // IN...): "Austin, TX" always read as the US.
    if (code === 'us' && !NAME.has(loc.trim().slice(-2).toLowerCase())) continue;
    const now = countriesFromLocation(loc);
    if (code && now.includes(code)) return code;
    if (!code && now.includes('in')) return 'in';
  }
  return null;
}

async function main() {
  const db = require('../src/db/connection');
  const run = db.queryWithTimeout
    ? (sql, params) => db.queryWithTimeout(sql, params, 120000)
    : (sql, params) => db.query(sql, params);
  const APPLY = process.env.APPLY === '1';
  const BATCH = parseInt(process.env.BATCH || '5000', 10);
  const PAUSE_MS = parseInt(process.env.PAUSE_MS || '200', 10);
  const CKPT = process.env.CKPT || '/tmp/reindex-location-countries.pos';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  console.log(`mode: ${APPLY ? 'APPLY' : 'SHADOW'}`);
  const { rows: [b] } = await run('SELECT MIN(id) AS lo, MAX(id) AS hi FROM jobs');
  let from = Number(b.lo) - 1;
  const hi = Number(b.hi);
  if (APPLY && fs.existsSync(CKPT)) {
    const saved = parseInt(fs.readFileSync(CKPT, 'utf8').trim(), 10);
    if (Number.isFinite(saved) && saved > from) from = saved;
  }
  let queued = 0, batches = 0;
  const byCode = {};
  const samples = [];
  while (from < hi) {
    const to = Math.min(from + BATCH, hi);
    const { rows } = await run(
      `SELECT id, location FROM jobs WHERE id > ${from} AND id <= ${to} AND removed_at IS NULL AND location IS NOT NULL`);
    const ids = [];
    for (const row of rows) {
      const code = needsReindex(row.location);
      if (!code) continue;
      ids.push(row.id);
      byCode[code] = (byCode[code] || 0) + 1;
      if (samples.length < 20) samples.push(`${code}  ${row.location}`);
    }
    if (APPLY && ids.length) {
      await run('UPDATE jobs SET index_dirty_at = COALESCE(index_dirty_at, NOW()) WHERE id = ANY($1::bigint[])', [ids]);
      fs.writeFileSync(CKPT, String(to));
    }
    queued += ids.length;
    from = to;
    if (++batches % 50 === 0) process.stdout.write(`\r${from}/${hi} ${APPLY ? 'queued' : 'would queue'} ${queued}   `);
    if (PAUSE_MS > 0) await sleep(PAUSE_MS);
  }
  console.log(`\n${APPLY ? 'queued' : 'would queue'} ${queued}`, byCode);
  console.log(samples.join('\n'));
  if (db.closeDb) await db.closeDb();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { needsReindex };
