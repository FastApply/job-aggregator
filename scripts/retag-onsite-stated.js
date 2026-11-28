#!/usr/bin/env node
/**
 * Re-read the work model of live remote-tagged jobs whose posting says THIS job is worked on site.
 *
 *   DATABASE_URL=... NODE_ENV=production node scripts/retag-onsite-stated.js          # SHADOW
 *   DATABASE_URL=... NODE_ENV=production APPLY=1 node scripts/retag-onsite-stated.js  # armed
 *
 * extract.js read the company's or the work's remote words ("We are a remote-first company",
 * "support colleagues working remotely") as the job's, over the posting's own "This is an onsite
 * position", "Location: On-Site - Emeryville, CA", "Work Remotely • No", or a title "(Onsite - Night
 * Shift)" / "-Not Remote" (supply loop 2026-11-23 12h: 24 of 3,605 remote rows served to 26
 * remote-only automations, 45 of a 13,837-row remote sample across eleven ATS). These office jobs
 * sat in remote-only searches, where the verdict refused them, and out of on-site searches for
 * their own city.
 *
 * Why not wait for the next crawl: jobs.js keeps the stored tag when a crawl has none, and many of
 * these boards are crawled weekly or less; this only does it sooner. An ATS that states its own
 * work model puts it back on the next crawl.
 *
 * Touches a row only when its title or text states on-site work (onsiteStated), the reader no
 * longer calls it remote, and the crawl's own classifier agrees (classifyJob). Feed rows
 * (external_id not "<ats>_...") are skipped. The index trigger queues each changed row, so this
 * waits while the outbox holds MAX_OUTBOX rows. Walks the primary key, resumable from CKPT.
 * Env: BATCH (5000 ids per step) · MAX_OUTBOX (20000) · POLL_MS (20000) · CKPT · ATS (comma list)
 */
const fs = require('fs');
const { stripHtml } = require('../src/utils/html');
const { extractWorkplaceType, onsiteStated } = require('../src/utils/extract');
const { withoutRemoteBoilerplate } = require('../src/utils/remote-boilerplate');
const { classifyJob } = require('../src/utils/classify');

/** Pure. The row's new tags, or null to leave it. */
function retagOnsiteStated(row) {
  const plain = String(stripHtml(row.description || '') || '').replace(/\s+/g, ' ');
  if (!onsiteStated(row.title, row.location, withoutRemoteBoilerplate(plain)).any) return null;
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
  const CKPT = process.env.CKPT || '/tmp/onsite-stated-retag.pos';
  const ATS = process.env.ATS ? process.env.ATS.split(',').map((a) => a.trim()).filter(Boolean) : null;
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

  console.log(`mode: ${APPLY ? 'APPLY' : 'SHADOW'} · ats: ${ATS ? ATS.join(',') : 'all'}`);
  const { rows: [b] } = await run('SELECT MIN(id) AS lo, MAX(id) AS hi FROM jobs');
  let from = Number(b.lo) - 1;
  const hi = Number(b.hi);
  if (APPLY && fs.existsSync(CKPT)) {
    const saved = parseInt(fs.readFileSync(CKPT, 'utf8').trim(), 10);
    if (Number.isFinite(saved) && saved > from) { from = saved; console.log(`resuming from ${from.toLocaleString()}`); }
  }
  let scanned = 0, changed = 0, batches = 0;
  const byAts = {}, byTag = {};
  while (from < hi) {
    const to = Math.min(from + BATCH, hi);
    const { rows } = await run(
      `SELECT id, ats, title, location, description FROM jobs
        WHERE id > ${from} AND id <= ${to} AND removed_at IS NULL AND is_remote = true
          AND ($1::text[] IS NULL OR ats = ANY($1::text[])) AND left(external_id, length(ats) + 1) = ats || '_'
          AND description IS NOT NULL AND description <> 'N/A'
          AND (title ~* '(on-?site|in-?person|in-?office|office-?based|not remote|non-?remote)'
               OR description ~* '(on-?site|in-?person|in-?office|office-?based|work remotely[^a-z]{0,4}no)')`, [ATS]);
    scanned += rows.length;
    const ids = [], wts = [];
    for (const row of rows) {
      const t = retagOnsiteStated(row);
      if (!t) continue;
      ids.push(row.id); wts.push(t.workplace);
      byAts[row.ats] = (byAts[row.ats] || 0) + 1;
      byTag[t.workplace] = (byTag[t.workplace] || 0) + 1;
      if (!APPLY && changed + ids.length <= 40) console.log(`  ${row.id} ${row.ats} -> ${t.workplace} | ${String(row.title).slice(0, 60)}`);
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
      changed += r.rowCount || 0;
    } else {
      changed += ids.length;
    }
    from = to;
    if (APPLY) fs.writeFileSync(CKPT, String(from));
    if (++batches % 20 === 0) {
      const pct = ((from - Number(b.lo)) / (hi - Number(b.lo)) * 100).toFixed(1);
      process.stdout.write(`\r  ${pct}% | remote rows ${scanned.toLocaleString()} | ${APPLY ? 'changed' : 'would change'} ${changed.toLocaleString()}   `);
    }
  }
  console.log(`\nremote rows scanned ${scanned.toLocaleString()}, ${APPLY ? 'changed' : 'would change'} ${changed.toLocaleString()}`);
  console.log('by ats', byAts);
  console.log('new tag', byTag);
  if (db.closeDb) await db.closeDb();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { retagOnsiteStated };
