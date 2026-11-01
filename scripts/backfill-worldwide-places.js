#!/usr/bin/env node
/**
 * Clear the worldwide (and remote) tag from live jobs whose location only holds the word.
 *
 *   DATABASE_URL=... NODE_ENV=production node scripts/backfill-worldwide-places.js          # SHADOW
 *   DATABASE_URL=... NODE_ENV=production APPLY=1 node scripts/backfill-worldwide-places.js  # armed
 *
 * classify.js read any location containing "worldwide", "global", "world" or "anywhere" as a
 * worldwide remote job, so "CVG2 - Hebron, KY - 1405 Worldwide Blvd", "Bonifacio Global City, PHL",
 * "MUFG Global Service Private Ltd. - Bengaluru (BCIT)" and cruise-ship postings filed as "<ship
 * line>, worldwide" were served to every Remote Worldwide search: 1,300 of the 3,431 live worldwide
 * rows on 2026-11-01. The crawl re-derives the tags on its next pass of each company, so this only
 * hurries it, and only ever clears.
 *
 * Reads the worldwide rows through their partial index (no table walk: the board's disk stalls
 * under full scans). A row changes only when its location holds a worldwide word but is not a
 * worldwide work model (locationIsWorldwide) and the crawl's own classifyJob, run on the stored
 * title, location, work model and description, no longer tags it. is_remote is cleared only when
 * classifyJob also says not remote. The index trigger queues each changed row for search.
 * Env: LIMIT (rows read, default all)
 */
const { stripHtml } = require('../src/utils/html');
const { classifyJob, locationIsWorldwide } = require('../src/utils/classify');

const WORD = /\b(?:worldwide|world|global|anywhere)\b/i;

/** Pure. The row's new tags, or null when it stays as stored. */
function retag(row) {
  if (!row.remote_worldwide) return null;
  const location = row.location || '';
  if (!WORD.test(location) || locationIsWorldwide(location)) return null;
  const tags = classifyJob({
    title: row.title,
    location,
    workplace_type: row.workplace_type,
    description: stripHtml(row.description || ''),
  });
  if (tags.remote_worldwide) return null;
  return { is_remote: row.is_remote && tags.is_remote, remote_worldwide: false };
}

async function main() {
  const db = require('../src/db/connection');
  const run = db.queryWithTimeout
    ? (sql, params) => db.queryWithTimeout(sql, params, 120000)
    : (sql, params) => db.query(sql, params);
  const APPLY = process.env.APPLY === '1';
  const LIMIT = parseInt(process.env.LIMIT || '0', 10);
  console.log(`mode: ${APPLY ? 'APPLY' : 'SHADOW'}`);
  const { rows } = await run(
    `SELECT id, title, location, workplace_type, description, is_remote, remote_worldwide
       FROM jobs WHERE removed_at IS NULL AND remote_worldwide = true
      ORDER BY id${LIMIT > 0 ? ` LIMIT ${LIMIT}` : ''}`);
  const fixes = [];
  const byLocation = {};
  for (const row of rows) {
    const t = retag(row);
    if (!t) continue;
    fixes.push({ id: row.id, ...t });
    byLocation[row.location] = (byLocation[row.location] || 0) + 1;
  }
  if (APPLY) {
    for (let i = 0; i < fixes.length; i += 500) {
      const part = fixes.slice(i, i + 500);
      await run(
        `UPDATE jobs j SET remote_worldwide = false, is_remote = v.is_remote
           FROM unnest($1::bigint[], $2::boolean[]) AS v(id, is_remote)
          WHERE j.id = v.id AND j.remote_worldwide = true`,
        [part.map((f) => f.id), part.map((f) => f.is_remote)]);
    }
  }
  const remoteCleared = fixes.filter((f) => !f.is_remote).length;
  console.log(`worldwide rows read ${rows.length}, ${APPLY ? 'cleared' : 'would clear'} ${fixes.length} (remote also cleared on ${remoteCleared})`);
  for (const [loc, n] of Object.entries(byLocation).sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`  ${n}  ${loc}`);
  if (db.closeDb) await db.closeDb();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { retag };
