#!/usr/bin/env node
/**
 * Populate salary_min_annual / salary_max_annual on rows that predate the columns.
 *
 *   DATABASE_URL=postgres://codev@localhost:5432/jobs_local NODE_ENV=local \
 *     node scripts/backfill-salary-annual.js            # SHADOW
 *   ... APPLY=1 node scripts/backfill-salary-annual.js  # armed
 *
 * syncForCompany fills these going forward, but only for rows it re-writes — and it COALESCEs
 * the salary columns, so a company whose adapter carries no salary in its list response never
 * refreshes them. Existing priced rows therefore need one sweep or they stay unfilterable.
 *
 * Only rows with a raw salary and no annualised value are touched, so a re-run is a no-op and
 * rows the annualiser legitimately refuses (missing or unrecognised interval) are retried
 * cheaply rather than being marked done.
 *
 * Env: BATCH (5000) · LIMIT (0 = all)
 */
const { query, closeDb, isPostgres } = require('../src/db/connection');
const { annualiseSalary } = require('../src/utils/salary');

const APPLY = process.env.APPLY === '1';
const BATCH = parseInt(process.env.BATCH || '5000', 10);
const LIMIT = parseInt(process.env.LIMIT || '0', 10);

async function main() {
  console.log(`engine: ${isPostgres ? 'postgres' : 'sqlite'} | mode: ${APPLY ? 'APPLY' : 'SHADOW'}`);
  if (APPLY && !isPostgres) { console.error('The batched UPDATE ... FROM (VALUES) path is Postgres-only.'); process.exit(1); }

  const { rows: [pre] } = await query(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN salary_min_annual IS NOT NULL THEN 1 ELSE 0 END) AS done
       FROM jobs WHERE salary_min IS NOT NULL`);
  console.log(`priced rows: ${Number(pre.total).toLocaleString()} | already annualised: ${Number(pre.done).toLocaleString()}`);

  let scanned = 0, filled = 0, refused = 0;
  const pending = [];
  const byInterval = new Map();

  // One scan, not one per batch. Keyset paging on `id > last` cannot help here: the predicate
  // that selects the work (salary_min_annual IS NULL) has no index, so every batch rescanned
  // from the cursor and the query timed out long before the table was covered. The target set
  // is narrow — four small columns, no descriptions — so pulling it in one pass is cheap and
  // turns every subsequent write into a plain primary-key lookup.
  console.log('collecting target rows (one scan)...');
  const t0 = Date.now();
  const { rows: targets } = await query(
    `SELECT id, salary_min, salary_max, salary_interval
       FROM jobs
      WHERE salary_min IS NOT NULL AND salary_min_annual IS NULL`);
  console.log(`  ${targets.length.toLocaleString()} rows to process (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

  while (targets.length) {
    const rows = targets.splice(0, BATCH);

    for (const r of rows) {
      scanned++;
      const min = annualiseSalary(r.salary_min, r.salary_interval);
      const max = annualiseSalary(r.salary_max, r.salary_interval);
      if (min === null) {
        refused++;
        const k = r.salary_interval || '(no interval)';
        byInterval.set(k, (byInterval.get(k) || 0) + 1);
        continue;
      }
      filled++;
      pending.push([r.id, min, max]);
    }

    // One multi-row UPDATE per batch rather than one statement per row. At 1.1M priced rows a
    // round trip each would dominate the runtime entirely; the annualising stays in JS so the
    // rules live in exactly one place (src/utils/salary.js) rather than being restated in SQL.
    if (APPLY && pending.length) {
      // Explicit casts: parameters inside a VALUES list arrive untyped, which Postgres resolves
      // as text and then refuses to compare against the bigint id ("operator does not exist:
      // integer = text").
      const vals = pending.map(() => '(?::bigint, ?::bigint, ?::bigint)').join(',');
      const flat = [];
      for (const [id, mn, mx] of pending) flat.push(id, mn, mx);
      await query(
        `UPDATE jobs SET salary_min_annual = v.mn, salary_max_annual = v.mx
           FROM (VALUES ${vals}) AS v(id, mn, mx)
          WHERE jobs.id = v.id`, flat);
    }
    pending.length = 0;
    process.stdout.write(`\r  scanned ${scanned.toLocaleString()} | fillable ${filled.toLocaleString()} | refused ${refused.toLocaleString()}   `);
    if (LIMIT && scanned >= LIMIT) break;
  }

  console.log(`\n\n=== ${APPLY ? 'APPLIED' : 'SHADOW (nothing written)'} ===`);
  console.log(`scanned   ${scanned.toLocaleString()}`);
  console.log(`filled    ${filled.toLocaleString()}`);
  console.log(`refused   ${refused.toLocaleString()} (interval missing or unrecognised — left NULL, not guessed)`);
  if (byInterval.size) {
    console.log('\nrefusals by stated interval:');
    [...byInterval.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
      .forEach(([k, n]) => console.log(`  ${String(n).padStart(8)}  ${k}`));
  }
  if (!APPLY && filled) console.log('\nRe-run with APPLY=1 to write.');
  await closeDb();
}

main().catch((err) => { console.error(err); process.exit(1); });
