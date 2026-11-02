#!/usr/bin/env node
/**
 * Give the feed rows already stored their job type and publish date from the posting's own ATS
 * (src/utils/ats-posting-facts.js, src/tasks/feed-ats-facts.js). The worker corrects new feed
 * rows; this is for the ones loaded before it.
 *
 * DRY RUN BY DEFAULT: reads the ATS for each row and reports what would change. Writes only with
 * APPLY=1.
 *
 *   COUNT=1 node scripts/backfill-feed-ats-facts.js           # read-only: rows to do, per feed and ATS
 *   LIMIT=500 node scripts/backfill-feed-ats-facts.js         # dry run on the first 500
 *   APPLY=1 node scripts/backfill-feed-ats-facts.js           # armed, whole corpus
 *
 * Env: DATABASE_URL (the board), APPLY=1, COUNT=1, LIMIT (rows, 0 = all), BATCH (default 200),
 *      CONCURRENCY (default 4), AFTER_ID (resume from an id; the last id is printed per batch),
 *      ATS (only one ATS, e.g. workday).
 */
const { query, closeDb } = require('../src/db/connection');
const { refreshFeedAtsFacts } = require('../src/tasks/feed-ats-facts');
const { FEEDS, ATS_WITH_FACTS } = require('../src/utils/ats-posting-facts');

const APPLY = process.env.APPLY === '1';
const LIMIT = Number(process.env.LIMIT || 0);
const BATCH = Number(process.env.BATCH || 200);
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);
const ONLY_ATS = process.env.ATS || null;

async function count() {
  const feed = `split_part(external_id, '_', 1)`;
  const { rows } = await query(
    `SELECT ${feed} AS feed, ats, COUNT(*) AS n FROM jobs
     WHERE removed_at IS NULL AND ats_facts_at IS NULL
       AND ${feed} IN (${FEEDS.map(() => '?').join(', ')})
       AND ats IN (${ATS_WITH_FACTS.map(() => '?').join(', ')})
     GROUP BY 1, 2 ORDER BY 3 DESC`,
    [...FEEDS, ...ATS_WITH_FACTS]
  );
  console.table(rows);
}

async function main() {
  if (process.env.COUNT === '1') return count();
  console.log(APPLY ? 'APPLY: writing' : 'DRY RUN: nothing is written (APPLY=1 to write)');
  let afterId = Number(process.env.AFTER_ID || 0);
  const total = { scanned: 0, read: 0, missed: 0, typeChanged: 0, dateChanged: 0, nowOld: 0 };
  for (;;) {
    const limit = LIMIT ? Math.min(BATCH, LIMIT - total.scanned) : BATCH;
    if (limit <= 0) break;
    const db = ONLY_ATS
      ? { query: (sql, params) => query(sql.replace('ats IN (', `ats = '${ONLY_ATS.replace(/[^a-z]/g, '')}' AND ats IN (`), params) }
      : { query };
    const s = await refreshFeedAtsFacts({ apply: APPLY, afterId, limit, concurrency: CONCURRENCY, db });
    for (const k of Object.keys(total)) total[k] += s[k];
    for (const x of s.samples.slice(0, 3)) console.log('  ', JSON.stringify(x));
    console.log(`batch to id ${s.lastId}:`, JSON.stringify(total));
    if (s.scanned < limit) break;
    afterId = s.lastId;
  }
  console.log('done', JSON.stringify(total));
}

main().then(closeDb).catch(async (e) => { console.error(e); await closeDb(); process.exit(1); });
