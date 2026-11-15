#!/usr/bin/env node
/**
 * Retire the Workday rows left behind by the collapsed-id bug, once each board has re-synced.
 *
 * The adapter used bulletFields[0] as the job id. On tenants where that is a shift, a location or
 * a contract type ("workday_Day Shift (United States of America)", "workday_Fixed Term (Fixed
 * Term)"), every posting sharing it collapsed into one row. jobIdOf() now builds the id from the
 * requisition number or the posting path, so after the fix a re-sync writes one row per posting
 * under new ids -- and the old collapsed rows are never returned again. List-diff removal is off
 * (SYNC_ABSENCE_REMOVAL), so nothing retires them: each would stay live beside the real rows,
 * pointing at one of the postings it used to stand for.
 *
 * A row is retired only when ALL of these hold:
 *   - ats = workday, live, external_id = workday_<value> where <value> is not a requisition
 *     number by the adapter's own rule (isReqId) and not a posting path -- i.e. an id the fixed
 *     adapter can never produce;
 *   - its company synced after SINCE (the deploy of the fix), so the re-sync has happened;
 *   - that sync counted it absent (absent_syncs >= 1);
 *   - the company has rows seen after SINCE, so the re-sync really wrote the new ones.
 *
 *   DATABASE_URL=... SINCE='2026-11-15 12:00Z' node scripts/retire-workday-collapsed-ids.js           # shadow
 *   DATABASE_URL=... SINCE='2026-11-15 12:00Z' APPLY=1 node scripts/retire-workday-collapsed-ids.js   # retire
 *
 * Re-run it as boards re-sync: each run takes only the boards synced since SINCE.
 * Env: SINCE (required), BATCH (5000), MAX_OUTBOX (20000), POLL_MS (20000), SHOW (15).
 */
const { Pool } = require('pg');

const URL_ = process.env.DATABASE_URL;
const SINCE = process.env.SINCE;
if (!URL_ || !SINCE) { console.error('DATABASE_URL and SINCE (the deploy time of the fix) are required'); process.exit(1); }
if (Number.isNaN(Date.parse(SINCE))) { console.error(`SINCE is not a timestamp: ${SINCE}`); process.exit(1); }
const APPLY = process.env.APPLY === '1';
const BATCH = parseInt(process.env.BATCH || '5000', 10);
const MAX_OUTBOX = parseInt(process.env.MAX_OUTBOX || '20000', 10);
const POLL_MS = parseInt(process.env.POLL_MS || '20000', 10);
const SHOW = parseInt(process.env.SHOW || '15', 10);

// Mirrors isReqId() in src/adapters/workday.js, applied to the part after "workday_".
const VAL = `substring(j.external_id from 9)`;
const NOT_PRODUCIBLE = `NOT (${VAL} ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{1,39}$' AND ${VAL} ~ '[0-9]') AND ${VAL} NOT LIKE '/%'`;

async function main() {
  const pool = new Pool({ connectionString: URL_, max: 2 });
  const c = await pool.connect();
  const q = (sql, p) => c.query(sql, p);
  try {
    await q('SET statement_timeout = 0');
    console.log(`mode: ${APPLY ? 'APPLY' : 'SHADOW'} · boards synced since ${SINCE}`);
    await q(`CREATE TEMP TABLE cand AS
      SELECT j.id, j.company_id, j.external_id, j.title
        FROM jobs j JOIN companies c ON c.id = j.company_id
       WHERE j.ats = 'workday' AND j.removed_at IS NULL AND j.external_id LIKE 'workday\\_%'
         AND ${NOT_PRODUCIBLE}
         AND c.last_synced_at > $1::timestamptz
         AND j.absent_syncs >= 1
         AND EXISTS (SELECT 1 FROM jobs n WHERE n.company_id = j.company_id AND n.removed_at IS NULL
                        AND n.last_seen_at > $1::timestamptz)`, [SINCE]);
    const { rows: [t] } = await q('SELECT count(*)::int n, count(DISTINCT company_id)::int b FROM cand');
    const { rows: [w] } = await q(`SELECT count(*)::int n, count(DISTINCT j.company_id)::int b FROM jobs j
       WHERE j.ats = 'workday' AND j.removed_at IS NULL AND j.external_id LIKE 'workday\\_%' AND ${NOT_PRODUCIBLE}`);
    console.log(`  collapsed-id rows still live: ${w.n.toLocaleString()} on ${w.b.toLocaleString()} boards`);
    console.log(`  of which re-synced and counted absent (to retire): ${t.n.toLocaleString()} on ${t.b.toLocaleString()} boards`);
    const { rows: top } = await q(`SELECT c.ats_slug, count(*)::int n,
        (SELECT count(*)::int FROM jobs x WHERE x.company_id = cand.company_id AND x.removed_at IS NULL) live
        FROM cand JOIN companies c ON c.id = cand.company_id GROUP BY 1, cand.company_id ORDER BY 2 DESC LIMIT ${SHOW}`);
    for (const r of top) console.log(`    ${r.ats_slug.padEnd(32)} retire ${String(r.n).padStart(5)} of ${r.live} live`);
    const { rows: sample } = await q(`SELECT external_id, title FROM cand ORDER BY random() LIMIT ${SHOW}`);
    for (const r of sample) console.log(`    ${r.external_id.slice(0, 70)} | ${String(r.title).slice(0, 50)}`);

    if (!APPLY) { console.log('\nSHADOW: nothing written. APPLY=1 to retire.'); return; }

    const { rows: ids } = await q('SELECT id FROM cand ORDER BY id');
    let done = 0;
    for (let i = 0; i < ids.length; i += BATCH) {
      for (;;) {
        const { rows: [o] } = await q('SELECT COUNT(*)::int n FROM jobs WHERE index_dirty_at IS NOT NULL');
        if (o.n < MAX_OUTBOX) break;
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      const chunk = ids.slice(i, i + BATCH).map((r) => r.id);
      const res = await q(`UPDATE jobs SET removed_at = NOW() WHERE id = ANY($1::bigint[]) AND removed_at IS NULL`, [chunk]);
      done += res.rowCount;
      process.stdout.write(`\r  retired ${done.toLocaleString()} / ${ids.length.toLocaleString()}   `);
    }
    console.log(`\nretired ${done.toLocaleString()} collapsed Workday rows.`);
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
