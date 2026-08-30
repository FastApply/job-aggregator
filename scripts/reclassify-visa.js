#!/usr/bin/env node
/**
 * Re-derive jobs.visa_sponsorship after a change to classifyVisa().
 *
 *   node scripts/reclassify-visa.js                        # SHADOW on the local SQLite DB
 *   APPLY=1 node scripts/reclassify-visa.js                # armed, local
 *   DATABASE_URL=... NODE_ENV=production node scripts/reclassify-visa.js          # SHADOW on prod
 *   DATABASE_URL=... NODE_ENV=production APPLY=1 node scripts/reclassify-visa.js  # armed, prod
 *
 * A pattern fix only changes what NEW syncs write. Rows already stored keep whatever the old
 * patterns decided, so the corpus stays wrong until it is swept — this is that sweep.
 *
 * PRECEDENCE. Two sources can answer "does this employer sponsor":
 *
 *   1. An employer-stated answer (Simplify's sponsors_h1b, loaded as ats='simplify' rows).
 *      Graded against our own classifier on 395 disagreements, the stated answer was right
 *      every time. It wins.
 *   2. classifyVisa() over the posting description. Used wherever no stated answer exists.
 *
 * Rows are only written when the derived value actually differs, so a re-run is a no-op and the
 * index-dirty trigger is not fired needlessly. Shadow by default: this rewrites a classified
 * column in bulk, and on Postgres that is millions of rows behind a live search index.
 *
 * SIZING A PROD RUN. A full sweep reads every description — ~5.2M rows at ~5KB each is roughly
 * 26GB over the wire, which is an hours-long job, not something to fire off casually. Set
 * SAMPLE_PCT to estimate the change count first: on Postgres it uses TABLESAMPLE SYSTEM, which
 * reads random pages and costs almost nothing. SAMPLE_PCT forces shadow mode — a sample must
 * never be used to write.
 *
 * Env: BATCH (2000) · LIMIT (0 = all) · SAMPLE_PCT (0 = full scan) · SKIP_STATED=1
 */
const { query, closeDb, isPostgres } = require('../src/db/connection');
const { classifyVisa } = require('../src/utils/classify');

const SAMPLE_PCT = parseFloat(process.env.SAMPLE_PCT || '0');
// A sampled run can only ever estimate, so it is never allowed to write.
const APPLY = process.env.APPLY === '1' && !SAMPLE_PCT;
const BATCH = parseInt(process.env.BATCH || '2000', 10);
const LIMIT = parseInt(process.env.LIMIT || '0', 10);
const SKIP_STATED = process.env.SKIP_STATED === '1';

async function buildStatedMap() {
  // Employer-stated answers, keyed by normalised (company, title). Only unanimous groups count:
  // where several stated rows disagree the key is dropped rather than guessed.
  if (SKIP_STATED) return new Map();
  const { rows } = await query(`
    SELECT lower(trim(c.company_name)) || '|' || lower(trim(j.title)) AS k,
           MIN(j.visa_sponsorship) AS lo, MAX(j.visa_sponsorship) AS hi
      FROM jobs j JOIN companies c ON c.id = j.company_id
     WHERE j.ats = 'simplify' AND c.company_name IS NOT NULL
       AND j.visa_sponsorship IS NOT NULL AND j.visa_sponsorship != ''
     GROUP BY 1`);
  const m = new Map();
  for (const r of rows) if (r.lo === r.hi) m.set(r.k, r.lo);
  return m;
}

async function main() {
  console.log(`engine: ${isPostgres ? 'postgres' : 'sqlite'} | mode: ${APPLY ? 'APPLY' : 'SHADOW'}`);

  const stated = await buildStatedMap();
  console.log(`employer-stated keys: ${stated.size.toLocaleString()}${SKIP_STATED ? ' (disabled)' : ''}`);

  const transitions = new Map();
  let scanned = 0, changed = 0, lastId = 0;

  if (SAMPLE_PCT && !isPostgres) { console.error('SAMPLE_PCT needs Postgres (TABLESAMPLE).'); process.exit(1); }
  if (SAMPLE_PCT) console.log(`SAMPLE_PCT=${SAMPLE_PCT} — estimating from a random page sample; writing is disabled`);

  for (;;) {
    const { rows } = SAMPLE_PCT
      ? await query(
          `SELECT j.id, j.title, j.description, j.visa_sponsorship AS stored, c.company_name
             FROM jobs j TABLESAMPLE SYSTEM (${SAMPLE_PCT}) JOIN companies c ON c.id = j.company_id
            WHERE j.ats != 'simplify' AND j.removed_at IS NULL
            LIMIT ${BATCH}`)
      : await query(
          `SELECT j.id, j.title, j.description, j.visa_sponsorship AS stored,
                  c.company_name
             FROM jobs j JOIN companies c ON c.id = j.company_id
            WHERE j.id > ? AND j.ats != 'simplify' AND j.removed_at IS NULL
            ORDER BY j.id
            LIMIT ${BATCH}`, [lastId]);
    if (!rows.length) break;
    lastId = rows[rows.length - 1].id;

    const updates = [];
    for (const r of rows) {
      scanned++;
      const key = `${String(r.company_name || '').trim().toLowerCase()}|${String(r.title || '').trim().toLowerCase()}`;
      // Employer-stated first, classifier second.
      const derived = stated.get(key) ?? classifyVisa(r.description);
      // Three spellings of "no answer" reach this column and they must compare as equal, or the
      // sweep rewrites rows for no gain:
      //   ''         syncForCompany, which writes `visa || ''`
      //   NULL       never classified
      //   'unknown'  the LLM backfill's sentinel for "looked, found nothing"
      //              (src/tasks/backfill-classifications.js). Its own eligibility query already
      //              treats NULL / '' / 'unknown' identically, so collapsing them changes no
      //              behaviour — but writing 'unknown' -> '' would dirty ~130k rows for the
      //              search index to re-ingest and tell a reader nothing new.
      // Replacing 'unknown' with a REAL answer is still a write, which is the point.
      const blank = (v) => (v === null || v === undefined || v === '' || v === 'unknown' ? '' : v);
      const now = blank(derived);
      const was = blank(r.stored);
      if (now === was) continue;
      changed++;
      const t = `${was || '<empty>'} -> ${now || '<empty>'}`;
      transitions.set(t, (transitions.get(t) || 0) + 1);
      updates.push([now, r.id]);
    }

    if (APPLY && updates.length) {
      for (const [v, id] of updates) await query('UPDATE jobs SET visa_sponsorship = ? WHERE id = ?', [v, id]);
    }
    process.stdout.write(`\r  scanned ${scanned.toLocaleString()} | changed ${changed.toLocaleString()}   `);
    if (LIMIT && scanned >= LIMIT) break;
    if (SAMPLE_PCT) break;   // one sample batch is the estimate; paging it would just re-sample
  }

  console.log(`\n\n=== ${APPLY ? 'APPLIED' : 'SHADOW (nothing written)'} ===`);
  console.log(`scanned  ${scanned.toLocaleString()}`);
  console.log(`changed  ${changed.toLocaleString()}`);
  for (const [t, n] of [...transitions.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(8)}  ${t}`);
  }
  if (!APPLY && changed) console.log('\nRe-run with APPLY=1 to write.');
  await closeDb();
}

main().catch((err) => { console.error(err); process.exit(1); });
