#!/usr/bin/env node
/**
 * Show what the next demand-crawl cycle WOULD pick, and what the old
 * popularity-only ordering would have picked instead. Reads only.
 *
 * demand-crawl used to select with a single `ORDER BY search_count DESC LIMIT
 * 25`, so a search nobody else runs never reached the queue however long it had
 * been unmet. That is the shape of a paying user with narrow criteria, and it
 * is why the fix for one on 2026-09-05 was loading jobs by hand. Part of each
 * batch is now reserved for the most starved demand regardless of popularity.
 *
 * This prints both lists so the difference is a measured fact rather than a
 * claim in a commit message.
 *
 * Run:  DATABASE_URL=... node scripts/demand-queue-preview.js
 * Env:  DEMAND_STARVED_SHARE(0.4) DEMAND_BATCH(25) DEMAND_MAX_RESULTS(10)
 */
const { query, closeDb } = require('../src/db/connection');
const { selectDemand } = require('../src/tasks/demand-crawl');

const BATCH = parseInt(process.env.DEMAND_BATCH || '25', 10);
const THRESHOLD = parseInt(process.env.DEMAND_MAX_RESULTS || '10', 10);

const ageDays = (ts) =>
  ts == null ? 'never' : `${Math.floor((Date.now() - new Date(ts).getTime()) / 86_400_000)}d`;

function print(title, rows) {
  process.stdout.write(`\n${title}  (${rows.length})\n`);
  process.stdout.write(`${''.padEnd(78, '-')}\n`);
  for (const r of rows) {
    const q = String(r.query_text || '').slice(0, 34).padEnd(34);
    const loc = String(r.location || '-').slice(0, 14).padEnd(14);
    const lane = (r.lane || 'popular').padEnd(8);
    process.stdout.write(
      `${q} ${loc} ${lane} searches=${String(r.search_count).padStart(4)} `
      + `results=${String(r.last_result_count ?? '?').padStart(4)} `
      + `crawled=${ageDays(r.last_crawled_at)}\n`,
    );
  }
}

(async () => {
  // What ships today: both lanes.
  const picked = await selectDemand({ batch: BATCH, threshold: THRESHOLD });

  // What the old code would have taken — the same query it used.
  const { rows: popularityOnly } = await query(
    `SELECT demand_key, query_text, location, search_count, last_result_count, last_crawled_at
       FROM search_demand
      WHERE COALESCE(last_result_count, 0) <= ? AND query_text IS NOT NULL AND query_text <> ''
        AND (last_crawled_at IS NULL OR last_crawled_at < NOW() - INTERVAL '48 hours')
      ORDER BY search_count DESC, last_result_count ASC LIMIT ?`,
    [THRESHOLD, BATCH],
  );

  print('WOULD CRAWL NOW (two-lane)', picked);
  print('WOULD HAVE CRAWLED (popularity only)', popularityOnly);

  const before = new Set(popularityOnly.map((r) => r.demand_key));
  const newly = picked.filter((r) => !before.has(r.demand_key));

  process.stdout.write(`\n${''.padEnd(78, '=')}\n`);
  process.stdout.write(`${newly.length} of ${picked.length} would NOT have been crawled under the old ordering.\n`);
  if (newly.length) {
    const oldest = newly.reduce((a, b) => {
      const at = a.last_crawled_at ? new Date(a.last_crawled_at).getTime() : 0;
      const bt = b.last_crawled_at ? new Date(b.last_crawled_at).getTime() : 0;
      return bt < at ? b : a;
    });
    process.stdout.write(
      `Most neglected of them: "${oldest.query_text}" `
      + `(${oldest.search_count} searches, last crawled ${ageDays(oldest.last_crawled_at)}).\n`,
    );
  }

  // The queue behind the batch: how much demand is due but not reachable this
  // cycle. If this only grows, the reserved share is too small.
  const { rows: backlog } = await query(
    `SELECT count(*) AS n FROM search_demand
      WHERE COALESCE(last_result_count, 0) <= ? AND query_text IS NOT NULL AND query_text <> ''
        AND (last_crawled_at IS NULL OR last_crawled_at < NOW() - INTERVAL '48 hours')`,
    [THRESHOLD],
  );
  process.stdout.write(`Total due this cycle: ${backlog[0].n} (batch takes ${BATCH}).\n`);

  await closeDb();
  process.exit(0);
})().catch(async (err) => {
  process.stderr.write(`demand-queue-preview failed: ${err.message}\n`);
  try { await closeDb(); } catch { /* already closed */ }
  process.exit(1);
});
