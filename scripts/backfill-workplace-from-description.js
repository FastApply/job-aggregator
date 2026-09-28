#!/usr/bin/env node
/**
 * Tag the work model of live jobs that were crawled without a description and never tagged.
 *
 *   DATABASE_URL=... NODE_ENV=production node scripts/backfill-workplace-from-description.js          # SHADOW
 *   DATABASE_URL=... NODE_ENV=production APPLY=1 node scripts/backfill-workplace-from-description.js  # armed
 *
 * Workday, Personio and SmartRecruiters list responses carry no description, so the crawl tagged
 * workplace_type from title + location alone and most of those jobs stayed NULL. backfill-descriptions
 * fetched the text later but never read it for the work model, and the English-only tagger could
 * not have read a German or Italian one anyway (see extract.js). A NULL tag hides the job from
 * every hybrid and on-site search, and a remote posting that only says so in its text never became
 * is_remote. Measured on a 30k live sample 2026-09-28: ~5% of untagged jobs with a description gain
 * a tag.
 *
 * Only rows whose workplace_type is still NULL are written, so a tag an ATS sent is never touched;
 * is_remote and remote_worldwide are re-derived from the new tag the way the crawl derives them.
 * The index trigger queues each changed row, so like requeue-index-recall.js this waits while the
 * outbox holds MAX_OUTBOX rows, keeping new and retired jobs from queueing behind it.
 *
 * Walks the primary key, resumable from CKPT.
 * Env: BATCH (5000 ids per step) · MAX_OUTBOX (20000) · POLL_MS (20000) · CKPT
 */
const fs = require('fs');
const db = require('../src/db/connection');
const { stripHtml } = require('../src/utils/html');
const { extractWorkplaceType } = require('../src/utils/extract');
const { classifyJob } = require('../src/utils/classify');

const longQuery = db.queryWithTimeout
  ? (sql, params) => db.queryWithTimeout(sql, params, 120000)
  : (sql, params) => db.query(sql, params);

const APPLY = process.env.APPLY === '1';
const BATCH = parseInt(process.env.BATCH || '5000', 10);
const MAX_OUTBOX = parseInt(process.env.MAX_OUTBOX || '20000', 10);
const POLL_MS = parseInt(process.env.POLL_MS || '20000', 10);
const CKPT = process.env.CKPT || '/tmp/workplace-backfill.pos';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(sql, params = []) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await longQuery(sql, params);
    } catch (err) {
      if (attempt === 5) throw err;
      console.error(`\n  retry ${attempt + 1}: ${err.message}`);
      await sleep(2000 * (attempt + 1) ** 2);
    }
  }
}

/** Pure. The new tag and the flags derived from it, or null when the text says nothing. */
function tagFor(row) {
  const plain = stripHtml(row.description);
  const workplace = extractWorkplaceType(row.title, row.location, plain);
  if (!workplace) return null;
  const tags = classifyJob({ title: row.title, location: row.location, workplace_type: workplace, description: plain });
  return { workplace, is_remote: tags.is_remote, remote_worldwide: tags.remote_worldwide };
}

async function outboxDepth() {
  const { rows: [r] } = await run('SELECT COUNT(*)::int n FROM jobs WHERE index_dirty_at IS NOT NULL');
  return r.n;
}

async function main() {
  console.log(`mode: ${APPLY ? 'APPLY' : 'SHADOW'}`);
  const { rows: [b] } = await run('SELECT MIN(id) AS lo, MAX(id) AS hi FROM jobs');
  let from = Number(b.lo) - 1;
  const hi = Number(b.hi);
  if (APPLY && fs.existsSync(CKPT)) {
    const saved = parseInt(fs.readFileSync(CKPT, 'utf8').trim(), 10);
    if (Number.isFinite(saved) && saved > from) { from = saved; console.log(`resuming from ${from.toLocaleString()}`); }
  }

  let scanned = 0, tagged = 0, becameRemote = 0, batches = 0;
  const byTag = {};
  const started = Date.now();
  while (from < hi) {
    const to = Math.min(from + BATCH, hi);
    const { rows } = await run(
      `SELECT id, title, location, description, is_remote FROM jobs
        WHERE id > ${from} AND id <= ${to} AND removed_at IS NULL AND workplace_type IS NULL
          AND description IS NOT NULL AND description <> 'N/A'`);
    scanned += rows.length;
    const ids = [], wts = [], rem = [], ww = [];
    for (const row of rows) {
      const t = tagFor(row);
      if (!t) continue;
      ids.push(row.id); wts.push(t.workplace); rem.push(t.is_remote); ww.push(t.remote_worldwide);
      byTag[t.workplace] = (byTag[t.workplace] || 0) + 1;
      if (t.is_remote && !row.is_remote) becameRemote++;
    }

    if (APPLY && ids.length) {
      while (await outboxDepth() >= MAX_OUTBOX) await sleep(POLL_MS);
      const r = await run(
        `UPDATE jobs j SET workplace_type = v.wt, is_remote = v.rem, remote_worldwide = v.ww
           FROM unnest($1::bigint[], $2::text[], $3::boolean[], $4::boolean[]) AS v(id, wt, rem, ww)
          WHERE j.id = v.id AND j.workplace_type IS NULL`, [ids, wts, rem, ww]);
      tagged += r.rowCount || 0;
    } else {
      tagged += ids.length;
    }
    from = to;
    if (APPLY) fs.writeFileSync(CKPT, String(from));
    if (++batches % 20 === 0) {
      const pct = ((from - Number(b.lo)) / (hi - Number(b.lo)) * 100).toFixed(1);
      process.stdout.write(`\r  ${pct}% of id space | untagged scanned ${scanned.toLocaleString()} | ${APPLY ? 'tagged' : 'would tag'} ${tagged.toLocaleString()} ${JSON.stringify(byTag)} | now remote ${becameRemote.toLocaleString()} | ${((Date.now() - started) / 60000).toFixed(1)}m   `);
    }
  }

  console.log(`\n\n=== ${APPLY ? 'APPLIED' : 'SHADOW (nothing written)'} ===`);
  console.log(`untagged live jobs with a description: ${scanned.toLocaleString()} · ${APPLY ? 'tagged' : 'to tag'}: ${tagged.toLocaleString()} ${JSON.stringify(byTag)} · newly remote: ${becameRemote.toLocaleString()}`);
  await db.closeDb();
}

if (require.main === module) main().catch((err) => { console.error('\n', err.message); process.exit(1); });
module.exports = { tagFor };
