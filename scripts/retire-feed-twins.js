#!/usr/bin/env node
/**
 * Retire feed twins already stored: live rows a job feed wrote for a posting whose ATS row is
 * also live on the same board (src/utils/feed-twins.js says why the feed copy is the wrong one).
 *
 * The Meili sync stops indexing a twin from the moment its row is next synced, and the demand
 * crawler no longer stores new ones; this pass is for the backlog, and for twins whose ATS row
 * was crawled after them. Re-runnable.
 *
 * Twins get removed_at = NOW() and removed_reason "feed twin of #<ATS row id>". The outbox
 * trigger fires on removed_at, so the Meili sync then deletes them from the index. Nothing is
 * deleted; the ATS row is untouched.
 *
 *   PG_STATEMENT_TIMEOUT=120000 DRY=1 node scripts/retire-feed-twins.js   # report only
 *   PG_STATEMENT_TIMEOUT=120000 node scripts/retire-feed-twins.js         # write
 *
 * PG_STATEMENT_TIMEOUT: the pool's 15s default (sized for the API) is too tight for the one
 * sequential candidate read (about a minute on the live board). Writes go in CHUNKs (5,000).
 */
const { query, closeDb } = require('../src/db/connection');
const { findFeedTwins, PARSERS } = require('../src/utils/feed-twins');

const DRY = process.env.DRY === '1';
const CHUNK = parseInt(process.env.CHUNK || '5000', 10);
const ATS = Object.keys(PARSERS);

(async () => {
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL (Postgres required)'); process.exit(1); }
  // One sequential read for the candidates (live rows of a recognised ATS that the ATS crawl did
  // not write) — about a minute on the live board, where a primary-key walk took tens of minutes
  // of random reads through 23GB. Then one indexed twin lookup per CHUNK.
  const { rows: candidates } = await query(
    // Written so no index applies: the planner otherwise walks idx_jobs_ats_active (or any
    // partial "removed_at IS NULL" index) with a random heap read per row, which ran past five
    // minutes; the parallel sequential scan this forces takes about thirty seconds.
    `SELECT id, ats, external_id, url FROM jobs
      WHERE COALESCE(removed_at, 'infinity'::timestamp) = 'infinity'::timestamp
        AND (ats || '') = ANY($1::text[])
        AND external_id NOT LIKE ats || '\\_%'`,
    [ATS]
  );
  let found = 0, retired = 0;
  const perAts = {};
  const sample = [];
  for (let i = 0; i < candidates.length; i += CHUNK) {
    const rows = candidates.slice(i, i + CHUNK);
    const twins = await findFeedTwins(rows, query);
    if (!twins.size) continue;
    found += twins.size;
    for (const r of rows) if (twins.has(r.id)) {
      perAts[r.ats] = (perAts[r.ats] || 0) + 1;
      if (sample.length < 10) sample.push({ twin: r.id, ats_row: twins.get(r.id), url: r.url });
    }
    if (!DRY) {
      const ids = [...twins.keys()];
      const reasons = ids.map((id) => `feed twin of #${twins.get(id)}`);
      retired += (await query(
        `UPDATE jobs SET removed_at = NOW(), removed_reason = v.reason
           FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::text[]) AS reason) v
          WHERE jobs.id = v.id AND jobs.removed_at IS NULL`,
        [ids, reasons]
      )).rowCount;
    }
    if ((i / CHUNK) % 20 === 0) process.stderr.write(`  checked ${Math.min(i + CHUNK, candidates.length)}/${candidates.length}, twins ${found}\n`);
  }
  console.log({ dry: DRY, candidates: candidates.length, twins: found, retired });
  console.table(Object.entries(perAts).map(([ats, n]) => ({ ats, twins: n })).sort((a, b) => b.twins - a.twins));
  console.log('sample:', sample);
  await closeDb();
})().catch((e) => { console.error(e.message); process.exit(1); });
