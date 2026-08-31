#!/usr/bin/env node
/**
 * Copy existing jobs straight into the search index. READ-ONLY against Postgres.
 *
 * The first approach seeded by setting index_dirty_at on every row so the normal sync loop
 * would pick them up. That is right for ongoing changes but wrong for a one-time backfill: the
 * rows have not changed, so there is nothing to record, and marking 2.8M rows means 2.8M
 * UPDATEs, each maintaining all 26 indexes on the table (2.4GB of them). Measured on the live
 * database: marking 10k rows took 30-70s and produced sustained 5xx on the API; reading the
 * same 10k takes ~10s and dirties nothing — no dead tuples, no autovacuum churn.
 *
 * The outbox trigger still handles everything ongoing. This only fills the backlog.
 *
 *   node scripts/meili-backfill.js              # from the start
 *   FROM_ID=12345 node scripts/meili-backfill.js
 *
 * Must run somewhere that can reach the index — it is a private service, so that means inside
 * Render, not a laptop.
 *
 * Env: BF_BATCH(2000) BF_PAUSE_MS(500) FROM_ID(0) CHECKPOINT(/tmp/meili-backfill.pos)
 */
const fs = require('fs');
const { query, closeDb } = require('../src/db/connection');
const meili = require('../src/utils/meili');

const BATCH = parseInt(process.env.BF_BATCH || '2000', 10);
const PAUSE_MS = parseInt(process.env.BF_PAUSE_MS || '500', 10);
const CHECKPOINT = process.env.CHECKPOINT || '/tmp/meili-backfill.pos';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiBusy() {
  // Yield whenever a USER-FACING query has been running a while. Reads are cheap but not free,
  // and the site takes priority over finishing quickly.
  //
  // Autovacuum is excluded, and that exclusion is load-bearing. It is background maintenance,
  // not a user request, and on this table it runs for HOURS — a TOAST vacuum was 46 minutes old
  // when this was written. Counting it meant apiBusy() was permanently true, so every batch
  // burned the full 60s wait ceiling before proceeding: measured 1,449 docs/min against 26,000
  // when the guard is quiet, an 18x slowdown that would have turned a 90-minute rebuild into 32
  // hours. Waiting on vacuum also achieves nothing — vacuum does not finish sooner because a
  // reader paused.
  const { rows } = await query(
    `SELECT COUNT(*) n FROM pg_stat_activity
      WHERE datname = current_database() AND state = 'active'
        AND query NOT ILIKE '%pg_stat_activity%'
        AND query NOT ILIKE 'SELECT j.id,j.title%'
        AND query NOT ILIKE 'autovacuum:%'
        AND backend_type = 'client backend'
        AND query_start < NOW() - INTERVAL '5 seconds'`
  );
  return parseInt(rows[0].n, 10) > 0;
}

(async () => {
  if (!meili.enabled) {
    console.error('MEILI_HOST unset — this must run where the index is reachable (inside Render)');
    process.exit(1);
  }
  const h = await meili.health();
  if (!h.ok) { console.error('index unreachable:', h.reason); process.exit(1); }
  await meili.ensureIndex();

  let from = parseInt(process.env.FROM_ID || '0', 10);
  if (!from && fs.existsSync(CHECKPOINT)) from = parseInt(fs.readFileSync(CHECKPOINT, 'utf8'), 10) || 0;
  console.log(`backfill starting from id>${from} batch=${BATCH} pause=${PAUSE_MS}ms`);

  let sent = 0, batches = 0, waits = 0;
  const t0 = Date.now();

  for (;;) {
    let waited = 0;
    while (await apiBusy() && waited < 60) { waits++; await sleep(5000); waited += 5; }

    const { rows } = await query(
      `SELECT j.id, j.external_id, j.title, j.department, j.location, j.workplace_type,
              j.employment_type, j.experience_level, j.visa_sponsorship, j.role_category,
              j.is_remote, j.remote_worldwide, j.ats, j.url,
              j.salary_min, j.salary_max, j.salary_currency, j.salary_interval,
              j.salary_min_annual, j.salary_max_annual,
              j.posted_at, j.first_seen_at, j.company_id,
              c.company_name, c.domain, c.ats_slug, c.logo_url
         FROM jobs j
         LEFT JOIN companies c ON c.id = j.company_id
        WHERE j.id > ${from} AND j.removed_at IS NULL
        ORDER BY j.id LIMIT ${BATCH}`
    );
    if (!rows.length) break;

    // Retry the push. The index restarted once mid-run (Meilisearch is on a 2GB instance and
    // indexing is memory-hungry); the in-flight request died with `fetch failed` and took a
    // 3-hour run with it, because a single throw ends the whole script. Reads from Postgres are
    // not retried — those failing means something worth stopping for.
    let lastErr;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try { await meili.addDocuments(rows.map(meili.toDocument)); lastErr = null; break; }
      catch (err) {
        lastErr = err;
        console.log(`  push failed (attempt ${attempt}/5): ${err.message}`);
        await sleep(attempt * 5000);
      }
    }
    if (lastErr) throw lastErr;

    from = rows[rows.length - 1].id;
    sent += rows.length;
    batches++;
    fs.writeFileSync(CHECKPOINT, String(from));

    if (batches % 25 === 0) {
      const mins = ((Date.now() - t0) / 60000).toFixed(1);
      const rate = Math.round(sent / Math.max(1, (Date.now() - t0) / 60000));
      console.log(`  sent=${sent} batches=${batches} waits=${waits} lastId=${from} ${mins}m (~${rate}/min)`);
    }
    await sleep(PAUSE_MS);
  }

  console.log(`backfill complete: ${sent} documents in ${batches} batches, ${((Date.now() - t0) / 60000).toFixed(1)}m`);
  console.log('index stats:', JSON.stringify(await meili.stats().catch(() => null)));
  fs.existsSync(CHECKPOINT) && fs.unlinkSync(CHECKPOINT);
  await closeDb();
})().catch((err) => { console.error('backfill failed:', err.message); process.exit(1); });
