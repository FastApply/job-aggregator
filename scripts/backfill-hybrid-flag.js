#!/usr/bin/env node
/**
 * Re-read the Hybrid tag of live jobs that are hybrid only by the adjective in their text.
 *
 *   DATABASE_URL=... NODE_ENV=production node scripts/backfill-hybrid-flag.js            # SHADOW
 *   DATABASE_URL=... NODE_ENV=production SAMPLE=2 node scripts/backfill-hybrid-flag.js   # SHADOW, 2% sample
 *   DATABASE_URL=... NODE_ENV=production APPLY=1 node scripts/backfill-hybrid-flag.js    # armed
 *
 * The crawl tagged a job Hybrid on the bare word anywhere in its text (extract.js), so
 * Solidigm's remote Senior Security Application Engineer ("ML-DSA, LMS/LMOD, or hybrid crypto
 * schemes") was stored Hybrid and is_remote false, out of every remote search and refused by the
 * match verdict for remote-only candidates (pref-match audit, 2026-11-10). hybrid-work.js now reads
 * the word only as a work arrangement. A job the new reader leaves untagged keeps its stored tag
 * on the next crawl (jobs.js keeps a stored tag when a crawl has none), hence this script.
 *
 * Rewrites a row only when its text has the word, its location does not, and the reader no
 * longer calls it hybrid; workplace_type, is_remote and remote_worldwide are re-derived the way the
 * crawl derives them. Only on the ATSes whose adapter sends no work model of its own (NO_WORK_MODEL),
 * and only crawl rows (external_id "<ats>_..."): on an ATS that sends
 * one the stored Hybrid may be the employer's word. The index trigger queues each changed row, so
 * this waits while the outbox holds MAX_OUTBOX rows. Walks the primary key, resumable from CKPT.
 *
 * Env: BATCH (5000 ids per step) · MAX_OUTBOX (20000) · POLL_MS (20000) · CKPT · ATS (comma list,
 * overrides NO_WORK_MODEL) · SAMPLE (percent, shadow only: one id window in every 100/SAMPLE) · SHOW
 * (rows to print, default 25)
 */
const fs = require('fs');
const { stripHtml } = require('../src/utils/html');
const { extractWorkplaceType, normalizeWorkplaceType } = require('../src/utils/extract');
const { classifyJob } = require('../src/utils/classify');

const HYBRID_WORD = /\bhybrid\b/i;

// Adapters that set workplace_type to null, or only from the title/location (backfill-remote-flag.js's
// list without BambooHR and UKG: their own codes, locationType 2 and JobLocationType 0, ARE hybrid,
// so a stored Hybrid there may be the employer's word with "hybrid cloud" in the text beside it).
const NO_WORK_MODEL = [
  'greenhouse', 'workday', 'successfactors', 'taleo', 'avature', 'brassring', 'personio',
  'reachmee', 'varbi', 'visma', 'adp', 'adp_workforcenow', 'manatal', 'silkroad', 'jazzhr', 'jobvite',
];

/** Pure. The row's new tags, or null when it stays as stored. */
function retag(row) {
  const plain = stripHtml(row.description || '');
  if (!HYBRID_WORD.test(`${row.title || ''} ${plain}`)) return null;
  if (HYBRID_WORD.test(String(row.location || ''))) return null;
  const workplace = extractWorkplaceType(row.title, row.location, plain);
  if (workplace === 'hybrid') return null;
  const tags = classifyJob({ title: row.title, location: row.location, workplace_type: workplace, description: plain });
  return { workplace, is_remote: !!tags.is_remote, remote_worldwide: !!tags.remote_worldwide };
}

async function main() {
  const db = require('../src/db/connection');
  const longQuery = db.queryWithTimeout
    ? (sql, params) => db.queryWithTimeout(sql, params, 120000)
    : (sql, params) => db.query(sql, params);
  const APPLY = process.env.APPLY === '1';
  const SAMPLE = process.env.SAMPLE ? Number(process.env.SAMPLE) : null;
  if (APPLY && SAMPLE) throw new Error('SAMPLE is for the shadow run only');
  const BATCH = parseInt(process.env.BATCH || '5000', 10);
  const MAX_OUTBOX = parseInt(process.env.MAX_OUTBOX || '20000', 10);
  const POLL_MS = parseInt(process.env.POLL_MS || '20000', 10);
  const SHOW = parseInt(process.env.SHOW || '25', 10);
  const CKPT = process.env.CKPT || '/tmp/hybrid-flag-backfill.pos';
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
  const WHERE = `removed_at IS NULL AND workplace_type IN ('Hybrid', 'hybrid')
    AND ats = ANY($1::text[]) AND left(external_id, length(ats) + 1) = ats || '_'
    AND description IS NOT NULL AND description <> 'N/A'`;

  let scanned = 0, changed = 0;
  const byAts = {}, byTag = {}, shown = [];
  const tally = (row, t) => {
    changed++;
    byAts[row.ats] = (byAts[row.ats] || 0) + 1;
    const k = `${t.workplace || 'untagged'}${t.is_remote ? '+remote' : ''}`;
    byTag[k] = (byTag[k] || 0) + 1;
    if (shown.length < SHOW) {
      const plain = stripHtml(row.description || '');
      const m = /\bhybrid\b/i.exec(plain);
      shown.push(`${row.id} ${row.ats} | ${row.title} | ${row.location} | -> ${k} | "${m ? plain.slice(Math.max(0, m.index - 50), m.index + 50).replace(/\s+/g, ' ') : row.title}"`);
    }
  };

  console.log(`mode: ${APPLY ? 'APPLY' : 'SHADOW'}${SAMPLE ? ` (${SAMPLE}% sample)` : ''} · ats: ${ATS.join(',')}`);
  {
    const { rows: [b] } = await run('SELECT MIN(id) AS lo, MAX(id) AS hi FROM jobs');
    let from = Number(b.lo) - 1;
    const hi = Number(b.hi);
    if (APPLY && fs.existsSync(CKPT)) {
      const saved = parseInt(fs.readFileSync(CKPT, 'utf8').trim(), 10);
      if (Number.isFinite(saved) && saved > from) { from = saved; console.log(`resuming from ${from.toLocaleString()}`); }
    }
    let batches = 0;
    while (from < hi) {
      const to = Math.min(from + BATCH, hi);
      const { rows } = await run(
        `SELECT id, ats, title, location, description FROM jobs WHERE id > ${from} AND id <= ${to} AND ${WHERE}`, [ATS]);
      scanned += rows.length;
      const ids = [], wts = [], rem = [], ww = [];
      for (const row of rows) {
        const t = retag(row);
        if (!t) continue;
        tally(row, t);
        ids.push(row.id); wts.push(normalizeWorkplaceType(t.workplace)); rem.push(t.is_remote); ww.push(t.remote_worldwide);
      }
      if (APPLY && ids.length) {
        for (;;) {
          const { rows: [o] } = await run('SELECT COUNT(*)::int n FROM jobs WHERE index_dirty_at IS NOT NULL');
          if (o.n < MAX_OUTBOX) break;
          await sleep(POLL_MS);
        }
        await run(
          `UPDATE jobs j SET workplace_type = v.wt, is_remote = v.rem, remote_worldwide = v.ww
             FROM unnest($1::bigint[], $2::text[], $3::boolean[], $4::boolean[]) AS v(id, wt, rem, ww)
            WHERE j.id = v.id AND j.workplace_type IN ('Hybrid', 'hybrid')`, [ids, wts, rem, ww]);
      }
      // A sample reads one id window in every 100/SAMPLE: the primary key keeps each read fast,
      // where TABLESAMPLE over the whole table timed out.
      from = SAMPLE ? from + BATCH * Math.max(1, Math.round(100 / SAMPLE)) : to;
      if (APPLY) fs.writeFileSync(CKPT, String(from));
      if (++batches % 20 === 0) {
        const pct = ((from - Number(b.lo)) / (hi - Number(b.lo)) * 100).toFixed(1);
        process.stdout.write(`\r  ${pct}% | hybrid rows ${scanned.toLocaleString()} | ${APPLY ? 'retagged' : 'would retag'} ${changed.toLocaleString()}   `);
      }
    }
  }
  console.log(`\nhybrid rows scanned ${scanned.toLocaleString()}, ${APPLY ? 'retagged' : 'would retag'} ${changed.toLocaleString()}`);
  console.log('by ats', byAts);
  console.log('new tag', byTag);
  for (const s of shown) console.log('  ', s);
  if (db.closeDb) await db.closeDb();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { retag };
