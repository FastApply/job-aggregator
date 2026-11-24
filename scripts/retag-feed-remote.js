#!/usr/bin/env node
/**
 * Live feed rows that say remote in workplace_type while is_remote is false: check the feed's word
 * against the posting's own text (src/utils/feed-workplace.js) and make the two fields agree.
 *
 *   DATABASE_URL=... NODE_ENV=production node scripts/retag-feed-remote.js          # SHADOW (default)
 *   DATABASE_URL=... NODE_ENV=production APPLY=1 node scripts/retag-feed-remote.js  # armed
 *
 * map-aggregators-local.js copied the feed's work setting into workplace_type and left is_remote
 * false, so the board's own remote search skipped these rows while FastApply's backend, reading the
 * work-mode field, took them for remote. Wonsulting's "remote" is mostly wrong: on a 2026-11-24
 * sample of these rows, 307 of 331 Wonsulting postings had text the board's reader does not call
 * remote (Micron's San Jose "Program Manager, SIG" is on-site in its Workday). The feed's word is
 * kept, with is_remote and remote_worldwide set, when the text says remote; otherwise workplace_type
 * is cleared to unknown, which is what the posting states. A feed row is one whose external_id is
 * a feed's ("wonsulting_...") or whose raw_data still names the feed (map-aggregators-local.js gives
 * a feed row on a known ATS that ATS's id, "workable_..."). A row whose raw_data the crawl has since
 * rewritten is the crawl's, and left alone: there workplace_type may be the ATS's own word.
 *
 * Walks the primary key, resumable from CKPT, and waits while the index outbox holds MAX_OUTBOX rows.
 * Env: BATCH (5000 ids per step) · MAX_OUTBOX (20000) · POLL_MS (20000) · CKPT · FEEDS (comma list)
 */
const fs = require('fs');
const { feedRemoteTags } = require('../src/utils/feed-workplace');

// external_id prefixes of the feeds map-aggregators-local.js and demand-crawl.js insert.
const FEEDS = [
  'wonsulting', 'liftmycv', 'jobhose', 'jobloo', 'resumly', 'trueup', 'simplify', 'trulyremotework',
  'thehub', 'sprout', 'aiapply', 'allscm',
];

/** Pure. { keep, clear } ids for one batch of rows, with remote_worldwide for the kept ones. */
function plan(rows) {
  const keep = [], ww = [], clear = [];
  for (const row of rows) {
    const t = feedRemoteTags(row);
    if (t.is_remote) { keep.push(row.id); ww.push(t.remote_worldwide); } else clear.push(row.id);
  }
  return { keep, ww, clear };
}

async function main() {
  const db = require('../src/db/connection');
  const longQuery = db.queryWithTimeout
    ? (sql, params) => db.queryWithTimeout(sql, params, 120000)
    : (sql, params) => db.query(sql, params);
  const APPLY = process.env.APPLY === '1';
  const BATCH = parseInt(process.env.BATCH || '5000', 10);
  const MAX_OUTBOX = parseInt(process.env.MAX_OUTBOX || '20000', 10);
  const POLL_MS = parseInt(process.env.POLL_MS || '20000', 10);
  const CKPT = process.env.CKPT || '/tmp/retag-feed-remote.pos';
  const feeds = process.env.FEEDS ? process.env.FEEDS.split(',').map((f) => f.trim()).filter(Boolean) : FEEDS;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const run = async (sql, params = []) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await longQuery(sql, params);
      } catch (err) {
        if (attempt === 5) throw err;
        console.error(`\n  retry ${attempt + 1}: ${err.message}`);
        await sleep(2000 * (attempt + 1) ** 2);
      }
    }
  };

  console.log(`mode: ${APPLY ? 'APPLY' : 'SHADOW'} · feeds: ${feeds.join(',')}`);
  const { rows: [b] } = await run('SELECT MIN(id) AS lo, MAX(id) AS hi FROM jobs');
  let from = Number(b.lo) - 1;
  const hi = Number(b.hi);
  if (APPLY && fs.existsSync(CKPT)) {
    const saved = parseInt(fs.readFileSync(CKPT, 'utf8').trim(), 10);
    if (Number.isFinite(saved) && saved > from) { from = saved; console.log(`resuming from ${from.toLocaleString()}`); }
  }
  let scanned = 0, kept = 0, cleared = 0, batches = 0;
  const byFeed = {};
  while (from < hi) {
    const to = Math.min(from + BATCH, hi);
    const { rows } = await run(
      `SELECT id, external_id, title, location, description FROM jobs
        WHERE id > ${from} AND id <= ${to} AND removed_at IS NULL AND is_remote = false
          AND lower(workplace_type) = 'remote'
          AND (split_part(external_id, '_', 1) = ANY($1::text[])
               OR raw_data LIKE '%"aggregator:%' OR raw_data LIKE '%"demand\\_%')`, [feeds]);
    scanned += rows.length;
    const p = plan(rows);
    for (const row of rows) {
      const f = row.external_id.split('_')[0];
      const k = p.keep.includes(row.id) ? 'keep' : 'clear';
      byFeed[f] = byFeed[f] || { keep: 0, clear: 0 };
      byFeed[f][k]++;
    }
    if (APPLY && (p.keep.length || p.clear.length)) {
      for (;;) {
        const { rows: [o] } = await run('SELECT COUNT(*)::int n FROM jobs WHERE index_dirty_at IS NOT NULL');
        if (o.n < MAX_OUTBOX) break;
        await sleep(POLL_MS);
      }
      if (p.keep.length) {
        await run(`UPDATE jobs j SET is_remote = true, remote_worldwide = v.ww
                     FROM unnest($1::bigint[], $2::boolean[]) AS v(id, ww)
                    WHERE j.id = v.id AND j.is_remote = false`, [p.keep, p.ww]);
      }
      if (p.clear.length) {
        await run(`UPDATE jobs SET workplace_type = NULL
                    WHERE id = ANY($1::bigint[]) AND is_remote = false AND lower(workplace_type) = 'remote'`, [p.clear]);
      }
    }
    kept += p.keep.length; cleared += p.clear.length;
    from = to;
    if (APPLY) fs.writeFileSync(CKPT, String(from));
    if (++batches % 20 === 0) {
      const pct = ((from - Number(b.lo)) / (hi - Number(b.lo)) * 100).toFixed(1);
      process.stdout.write(`\r  ${pct}% | rows ${scanned.toLocaleString()} | ${APPLY ? '' : 'would '}keep ${kept.toLocaleString()} · clear ${cleared.toLocaleString()}   `);
    }
  }
  console.log(`\nfeed rows remote-in-field-only: ${scanned.toLocaleString()} · ${APPLY ? '' : 'would '}keep as remote ${kept.toLocaleString()} · ${APPLY ? '' : 'would '}clear to unknown ${cleared.toLocaleString()}`);
  console.log('by feed', byFeed);
  if (db.closeDb) await db.closeDb();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { plan, FEEDS };
