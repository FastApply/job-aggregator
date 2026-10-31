#!/usr/bin/env node
/**
 * Clear the remote tag from live jobs that are remote only by a word in their text.
 *
 *   DATABASE_URL=... NODE_ENV=production node scripts/backfill-remote-flag.js          # SHADOW
 *   DATABASE_URL=... NODE_ENV=production APPLY=1 node scripts/backfill-remote-flag.js  # armed
 *
 * The crawl used to tag a job remote on the bare word anywhere in its text (extract.js), so a
 * nurse's posting that mentions "remote monitoring" or Sentara's boilerplate about "positions that
 * are available as remote work" sat in every remote search. On a 0.4% sample of live remote rows
 * on 2026-10-30, 510 of 1,145 on ATSes that send no work model were tagged that way, and First
 * Apply applied remote-only users to them: the verdict refuses only a mode the posting states.
 *
 * Why this cannot fix itself on the next crawl: jobs.js keeps the stored tag when a crawl has none
 * (a tag read later from a late-fetched description must survive), so a job the new reader leaves
 * untagged keeps its old "remote".
 *
 * Rewrites a row only when its text has the word and the reader no longer calls it remote, and only
 * on the ATSes whose adapter sends no work model of its own (NO_WORK_MODEL: workplace_type null, or
 * read from the title and location, which retag() reads too) — the audit's own population. On an
 * ATS that does send one (Ashby, Lever, Workable, SmartRecruiters, ...) the stored remote may be the
 * ATS's word, and the next crawl puts it back only if that ATS is still scheduled: a paused account
 * would lose a true tag for good. Feed rows (external_id not "<ats>_...") are skipped as well:
 * demand-crawl's upsert never rewrites their tag, so nothing would restore one cleared by mistake.
 * is_remote and remote_worldwide are re-derived the way the crawl derives them. The index trigger
 * queues each changed row, so this waits while the outbox holds MAX_OUTBOX rows.
 *
 * Walks the primary key, resumable from CKPT.
 * Env: BATCH (5000 ids per step) · MAX_OUTBOX (20000) · POLL_MS (20000) · CKPT · ATS (comma list,
 * overrides NO_WORK_MODEL)
 */
const fs = require('fs');
const { stripHtml } = require('../src/utils/html');
const { extractWorkplaceType } = require('../src/utils/extract');
const { classifyJob } = require('../src/utils/classify');

const REMOTE_WORD = /\bremote(?:ly)?\b|\bwork from home\b|\bwfh\b/i;

// Adapters that set workplace_type to null, or only from the title/location (src/adapters/*.js).
const NO_WORK_MODEL = [
  'greenhouse', 'workday', 'successfactors', 'taleo', 'avature', 'brassring', 'personio',
  'reachmee', 'varbi', 'visma', 'adp', 'adp_workforcenow', 'manatal', 'silkroad', 'jazzhr', 'jobvite',
];

/** Pure. The row's new tags, or null when it stays as stored. */
function retag(row) {
  const plain = stripHtml(row.description);
  if (!REMOTE_WORD.test(plain)) return null;
  const workplace = extractWorkplaceType(row.title, row.location, plain);
  if (workplace === 'remote') return null;
  const tags = classifyJob({ title: row.title, location: row.location, workplace_type: workplace, description: plain });
  if (tags.is_remote) return null;
  return { workplace, is_remote: false, remote_worldwide: false };
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
  const CKPT = process.env.CKPT || '/tmp/remote-flag-backfill.pos';
  const ATS = process.env.ATS ? process.env.ATS.split(',').map((a) => a.trim()).filter(Boolean) : NO_WORK_MODEL;
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

  console.log(`mode: ${APPLY ? 'APPLY' : 'SHADOW'} · ats: ${ATS.join(',')}`);
  const { rows: [b] } = await run('SELECT MIN(id) AS lo, MAX(id) AS hi FROM jobs');
  let from = Number(b.lo) - 1;
  const hi = Number(b.hi);
  if (APPLY && fs.existsSync(CKPT)) {
    const saved = parseInt(fs.readFileSync(CKPT, 'utf8').trim(), 10);
    if (Number.isFinite(saved) && saved > from) { from = saved; console.log(`resuming from ${from.toLocaleString()}`); }
  }
  let scanned = 0, cleared = 0, batches = 0;
  const byAts = {}, byTag = {};
  while (from < hi) {
    const to = Math.min(from + BATCH, hi);
    const { rows } = await run(
      `SELECT id, ats, title, location, description FROM jobs
        WHERE id > ${from} AND id <= ${to} AND removed_at IS NULL AND is_remote = true
          AND ats = ANY($1::text[]) AND left(external_id, length(ats) + 1) = ats || '_'
          AND description IS NOT NULL AND description <> 'N/A'`, [ATS]);
    scanned += rows.length;
    const ids = [], wts = [];
    for (const row of rows) {
      const t = retag(row);
      if (!t) continue;
      ids.push(row.id); wts.push(t.workplace);
      byAts[row.ats] = (byAts[row.ats] || 0) + 1;
      byTag[t.workplace] = (byTag[t.workplace] || 0) + 1;
    }
    if (APPLY && ids.length) {
      for (;;) {
        const { rows: [o] } = await run('SELECT COUNT(*)::int n FROM jobs WHERE index_dirty_at IS NOT NULL');
        if (o.n < MAX_OUTBOX) break;
        await sleep(POLL_MS);
      }
      const r = await run(
        `UPDATE jobs j SET workplace_type = v.wt, is_remote = false, remote_worldwide = false
           FROM unnest($1::bigint[], $2::text[]) AS v(id, wt)
          WHERE j.id = v.id AND j.is_remote = true`, [ids, wts]);
      cleared += r.rowCount || 0;
    } else {
      cleared += ids.length;
    }
    from = to;
    if (APPLY) fs.writeFileSync(CKPT, String(from));
    if (++batches % 20 === 0) {
      const pct = ((from - Number(b.lo)) / (hi - Number(b.lo)) * 100).toFixed(1);
      process.stdout.write(`\r  ${pct}% | remote rows ${scanned.toLocaleString()} | ${APPLY ? 'cleared' : 'would clear'} ${cleared.toLocaleString()}   `);
    }
  }
  console.log(`\nremote rows scanned ${scanned.toLocaleString()}, ${APPLY ? 'cleared' : 'would clear'} ${cleared.toLocaleString()}`);
  console.log('by ats', byAts);
  console.log('new tag', byTag);
  if (db.closeDb) await db.closeDb();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { retag };
