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
 * PG_STATEMENT_TIMEOUT: the pool's 15s default (sized for the API) is too tight for the first
 * pages of the primary-key walk, which read through long runs of retired rows.
 *
 * Walks jobs by primary key in pages of PAGE (default 5,000) for the recognised ATSs only, so
 * it never holds more than a page or runs one long statement against the 40-connection role.
 */
const { query, closeDb } = require('../src/db/connection');
const { findFeedTwins, PARSERS } = require('../src/utils/feed-twins');

const DRY = process.env.DRY === '1';
const PAGE = parseInt(process.env.PAGE || '5000', 10);
const ATS = Object.keys(PARSERS);

(async () => {
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL (Postgres required)'); process.exit(1); }
  let after = 0, scanned = 0, found = 0, retired = 0;
  const perAts = {};
  const sample = [];
  for (;;) {
    const { rows } = await query(
      `SELECT id, ats, external_id, url FROM jobs
        WHERE id > $1 AND removed_at IS NULL AND ats = ANY($2::text[])
        ORDER BY id LIMIT ${PAGE}`,
      [after, ATS]
    );
    if (!rows.length) break;
    after = rows[rows.length - 1].id;
    scanned += rows.length;
    const twins = await findFeedTwins(rows, query);
    if (twins.size) {
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
    }
    if (scanned % 200000 < PAGE) process.stderr.write(`  scanned ${scanned}, twins ${found}\n`);
    if (rows.length < PAGE) break;
  }
  console.log({ dry: DRY, scanned, twins: found, retired });
  console.table(Object.entries(perAts).map(([ats, n]) => ({ ats, twins: n })).sort((a, b) => b.twins - a.twins));
  console.log('sample:', sample);
  await closeDb();
})().catch((e) => { console.error(e.message); process.exit(1); });
