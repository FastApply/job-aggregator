#!/usr/bin/env node
'use strict';
/**
 * FA-053 — retire the demo/sandbox jobs that are already in the job board.
 *
 * DRY RUN BY DEFAULT: with no flags this only reads, inside a READ ONLY transaction, and prints
 * which boards and how many live jobs it would retire.
 *
 *   node scripts/retire-sandbox-jobs.js                              # dry run
 *   node scripts/retire-sandbox-jobs.js --json                       # dry run, machine-readable
 *   node scripts/retire-sandbox-jobs.js --apply --confirm=<db-host>  # do it
 *
 * --apply also needs --confirm=<the database host this will write to>, which the dry run prints
 * on its first line. That one extra word is what stops a script aimed at the wrong DATABASE_URL
 * from writing to it.
 *
 * ORDER: run this only AFTER the guard (SANDBOX_REJECT unset or "enforce") is live on every
 * process that ingests jobs: the laptop crawlers, the Render worker, anything on the VPS. A crawl
 * that still ingests a sandbox board makes its jobs live again (the upsert clears removed_at), and
 * this would be undone by the next sync. Run `npm run check:sandbox` afterwards and expect 0.
 *
 * What it does: sets removed_at / removed_reason on live jobs, the repo's normal soft retirement
 * (the search index drops them on its next sync). Nothing is deleted. Safe to run twice: it only
 * touches jobs that are still live.
 *
 * Undo (every retired row carries the reason prefix):
 *   UPDATE jobs SET removed_at = NULL, removed_reason = NULL
 *    WHERE removed_reason LIKE 'sandbox board (FA-053)%';
 *
 * Requires DATABASE_URL (no .env is loaded, on purpose). For production:
 *   export DATABASE_URL=$(heroku config:get DATABASE_URL -a fastapply-board)
 */
const { Pool } = require('pg');
const { planRetirement, applyRetirement, formatPlan, REASON_PREFIX } = require('../src/tasks/sandbox-retire');

const USAGE = 'usage: retire-sandbox-jobs.js [--json] [--apply --confirm=<db-host>]';

function parseArgs(argv) {
  const opts = { json: false, apply: false, confirm: null };
  for (const arg of argv) {
    if (arg === '--json') opts.json = true;
    else if (arg === '--apply') opts.apply = true;
    else if (arg.startsWith('--confirm=')) opts.confirm = arg.slice('--confirm='.length).trim().toLowerCase();
    else throw new Error(`unknown argument "${arg}"\n${USAGE}`);
  }
  if (opts.confirm && !opts.apply) throw new Error('--confirm only makes sense with --apply\n' + USAGE);
  return opts;
}

const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };
// A local Docker Postgres has no TLS; Heroku's needs it without a CA we can verify.
const isLocalUrl = (url) => /@(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url);

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set.\n' + USAGE);
  const host = hostOf(databaseUrl);
  if (!host) throw new Error('DATABASE_URL has no readable host.');

  if (opts.apply && opts.confirm !== host) {
    throw new Error(`--apply needs --confirm=${host}   (this run would write to ${host})`);
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: isLocalUrl(databaseUrl) ? false : { rejectUnauthorized: false },
    max: 1,
  });
  const client = await pool.connect();
  try {
    if (!opts.json) console.log(`database host: ${host}   mode: ${opts.apply ? 'APPLY (writing)' : 'dry run (read only)'}\n`);

    // Planning is read-only whichever mode this is.
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '300s'");
    const plan = await planRetirement({ query: (sql, params) => client.query(sql, params) });
    await client.query('ROLLBACK');

    let result = null;
    if (opts.apply && plan.total) {
      await client.query("SET statement_timeout = '120s'");
      result = await applyRetirement({ query: (sql, params) => client.query(sql, params), plan });
    }

    if (opts.json) {
      console.log(JSON.stringify({ host, apply: opts.apply, plan, result }, null, 2));
    } else {
      console.log(formatPlan(plan, { apply: opts.apply }));
      if (result) {
        console.log(`\nRetired ${result.retired.toLocaleString('en-US')} job(s). Reason prefix: "${REASON_PREFIX}".`);
        console.log('Now run `npm run check:sandbox` against the same database and expect 0 live.');
      } else if (!opts.apply && plan.total) {
        console.log(`\nDRY RUN: nothing was changed. To retire these: --apply --confirm=${host}`);
      }
    }
    return 0;
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => { console.error(`ERROR: ${err.message}`); process.exit(2); },
);
