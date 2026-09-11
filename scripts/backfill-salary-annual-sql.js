#!/usr/bin/env node
/**
 * Populate salary_min_annual / salary_max_annual, server-side.
 *
 *   DATABASE_URL=... NODE_ENV=production node scripts/backfill-salary-annual-sql.js          # SHADOW
 *   DATABASE_URL=... NODE_ENV=production APPLY=1 node scripts/backfill-salary-annual-sql.js  # armed
 *
 * The row-by-row sibling (backfill-salary-annual.js) is fine on a local database and hopeless on
 * production: it must find ~1.06M rows inside a 39.5GB table whose only qualifying predicate
 * (salary_min_annual IS NULL) has no index, so every shape of that scan — keyset paged or
 * collected in one pass — is a sequential scan that blows the statement timeout under live crawl
 * load. It never got past its opening COUNT.
 *
 * So the arithmetic happens in the database and nothing but progress counts crosses the wire.
 * The CASE expressions are GENERATED FROM the same PER_YEAR and MAX_PLAUSIBLE tables that
 * src/utils/salary.js uses, so the rules still live in exactly one place — edit the JS and this
 * follows. The interval matching mirrors normalizeSalaryInterval()'s order, compound spellings
 * (semimonthly, biweekly) first so a bare week/month pattern cannot claim them.
 *
 * Work is done in id ranges, which ARE indexed (primary key), so each statement is a bounded
 * range scan rather than a table scan, and no single transaction holds locks for long.
 *
 * NO '?' MAY APPEAR IN THE SQL THIS BUILDS. connection.js rewrites every '?' into a positional
 * parameter ($1, $2 ...) before sending the query, and it does so with a blind regex that cannot
 * tell a bind marker from a literal question mark. The numeric guard here was originally written
 * '^[0-9]+(\.[0-9]+)?$' and reached Postgres as '^[0-9]+(\.[0-9]+)$1$' — a pattern matching
 * nothing, so the guard failed for every row, the CASE fell to ELSE, and a full production run
 * wrote NULL over a million rows while reporting them as updated. {0,1} says the same thing
 * without the character.
 *
 * Env: RANGE (200000 ids per statement) · APPLY=1
 */
const { query, closeDb } = require('../src/db/connection');
const { PER_YEAR, MAX_PLAUSIBLE } = require('../src/utils/salary');

const fs = require('fs');

const APPLY = process.env.APPLY === '1';
// Checkpoint so an interrupted run resumes itself. This job spans hours against a database the
// crawler fleet is already saturating, and it has died four separate ways — a client-side read
// timeout, a transient EADDRNOTAVAIL, and twice on pool connection timeouts. Losing all progress
// each time is the actual problem; the failures themselves are expected on this link.
const CKPT = process.env.CKPT || '/tmp/salary-annual-backfill.pos';
const RANGE = parseInt(process.env.RANGE || '200000', 10);
// Resume point. A dense id range can exceed the client-side query_timeout (which is a POOL
// setting, so the session's `SET statement_timeout = 0` does not lift it), and the run dies
// mid-way. Restarting from scratch is safe — completed ranges no longer match
// salary_min_annual IS NULL — but re-scanning ~1,000 ranges to reach the failure point is
// wasted work, so START skips straight to it.
const START = parseInt(process.env.START || '0', 10);

// Postgres regexes matching normalizeSalaryInterval(), in the same precedence order.
const MATCH = [
  ['semimonthly', 'semimonthly|semi-monthly'],
  ['biweekly', 'biweekly|bi-weekly|fortnight'],
  ['yearly', 'year|yearly|annual|annually|annum|yr|per-year|salary'],
  ['monthly', 'month|monthly|per-month|mo'],
  ['weekly', 'week|weekly|per-week|wk'],
  ['daily', 'day|daily|per-day|diem'],
  ['hourly', 'hour|hourly|per-hour|hr|wage'],
];

/** CASE that annualises `col`, or NULL where the interval is absent, unknown or implausible. */
function caseFor(col) {
  const arms = MATCH.map(([name, re]) =>
    `      WHEN salary_interval ~* '${re}' AND ${col} ~ '^[0-9]+(\\.[0-9]+){0,1}$'
             AND ${col}::numeric > 0 AND ${col}::numeric <= ${MAX_PLAUSIBLE[name]}
        THEN round(${col}::numeric * ${PER_YEAR[name]})::bigint`).join('\n');
  return `CASE\n${arms}\n      ELSE NULL END`;
}

async function main() {
  console.log(`mode: ${APPLY ? 'APPLY' : 'SHADOW'} | id range per statement: ${RANGE.toLocaleString()}`);
  await query('SET statement_timeout = 0');

  const { rows: [b] } = await query('SELECT MIN(id) AS lo, MAX(id) AS hi FROM jobs');
  const lo = Number(b.lo), hi = Number(b.hi);
  let start = START || lo;
  if (!START && APPLY && fs.existsSync(CKPT)) {
    const saved = parseInt(fs.readFileSync(CKPT, 'utf8').trim(), 10);
    if (Number.isFinite(saved) && saved > start) { start = saved; console.log(`resuming from checkpoint ${CKPT}`); }
  }
  console.log(`id space: ${lo.toLocaleString()} .. ${hi.toLocaleString()} | starting at ${start.toLocaleString()}`);

  let updated = 0, done = 0;
  const total = Math.ceil((hi - start + 1) / RANGE);
  const started = Date.now();

  let failed = 0;
  for (let from = start; from <= hi; from += RANGE) {
    const to = Math.min(from + RANGE - 1, hi);
    const where = `id BETWEEN ${from} AND ${to}
        AND salary_min IS NOT NULL AND salary_min_annual IS NULL`;

    // Retry the RANGE, not just the query. connection.js already retries transient errors three
    // times, and on a contended pool that is not enough — exhausting it killed a three-hour run.
    // Backing off here lets the fleet's connection spike pass instead of abandoning the job.
    let ok = false;
    for (let attempt = 0; attempt < 6 && !ok; attempt++) {
      try {
        if (APPLY) {
          const r = await query(
            `UPDATE jobs SET salary_min_annual = ${caseFor('salary_min')},
                            salary_max_annual = ${caseFor('salary_max')}
              WHERE ${where}`);
          updated += r.rowCount || 0;
        } else {
          const { rows: [c] } = await query(`SELECT COUNT(*)::int n FROM jobs WHERE ${where}`);
          updated += c.n;
        }
        ok = true;
      } catch (err) {
        if (attempt === 5) {
          // Skip rather than abort: one unreachable range must not cost the whole run. The
          // checkpoint still advances, and a later pass picks the range up because its rows
          // remain salary_min_annual IS NULL.
          failed++;
          console.error(`\n  range ${from}-${to} gave up after 6 attempts: ${err.message}`);
        } else {
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1) ** 2));
        }
      }
    }
    if (APPLY) fs.writeFileSync(CKPT, String(to + 1));
    done++;
    const rate = done / ((Date.now() - started) / 1000);
    process.stdout.write(`\r  range ${done}/${total} | rows ${APPLY ? 'updated' : 'to update'}: ${updated.toLocaleString()} | ETA ${((total - done) / rate / 60).toFixed(1)}m   `);
  }

  console.log(`\n\n=== ${APPLY ? 'APPLIED' : 'SHADOW (nothing written)'} ===`);
  console.log(`rows touched: ${updated.toLocaleString()}`);
  if (failed) console.log(`ranges skipped after repeated failure: ${failed} — re-run to pick them up`);
  // No closing COUNT: an unindexed count over a 39GB table takes longer than the backfill and
  // hung a previous run after all its work was already committed. Sample instead if you want a
  // coverage figure.
  await closeDb();
}

main().catch((err) => { console.error('\n', err.message); process.exit(1); });
