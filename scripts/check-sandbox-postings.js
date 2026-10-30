#!/usr/bin/env node
'use strict';
/**
 * FA-053 — is any recently ingested posting on a demo/sandbox ATS board?
 *
 * Read-only: the whole run is one `BEGIN READ ONLY` transaction, so the database refuses a write
 * even if a later edit adds one by mistake. Safe to point at production.
 *
 * Usage:
 *   node scripts/check-sandbox-postings.js                 # jobs first seen in the last 30 days
 *   node scripts/check-sandbox-postings.js --days=7
 *   node scripts/check-sandbox-postings.js --json          # machine-readable result
 *   node scripts/check-sandbox-postings.js --list-matches  # every company whose NAME matches
 *
 * Exit code: 0 = no live sandbox posting, 1 = at least one, 2 = could not run (bad flag, no
 * DATABASE_URL, database error). `npm run check:sandbox` runs the same thing.
 *
 * --list-matches is the review list to read BEFORE rejection is switched on at ingest: every line
 * is a board that will stop being ingested. It judges company names only; the default mode is
 * what catches third-party-feed jobs, because it reads each posting's URL.
 *
 * Requires DATABASE_URL (no .env is loaded on purpose: a stray .env must not aim this at the
 * wrong database). For production: export DATABASE_URL=$(heroku config:get DATABASE_URL -a fastapply-board)
 */
const { Pool } = require('pg');
const {
  scanRecentPostings, listCompanyMatches, formatScan, formatMatches, parseDays, DEFAULT_DAYS,
} = require('../src/tasks/sandbox-check');

const USAGE = 'usage: check-sandbox-postings.js [--days=N] [--json] [--list-matches]';

function parseArgs(argv) {
  const opts = { days: DEFAULT_DAYS, json: false, listMatches: false };
  for (const arg of argv) {
    if (arg === '--json') opts.json = true;
    else if (arg === '--list-matches') opts.listMatches = true;
    else if (arg.startsWith('--days=')) opts.days = parseDays(arg.slice('--days='.length));
    else throw new Error(`unknown argument "${arg}"\n${USAGE}`);
  }
  return opts;
}

// A local Docker Postgres has no TLS; Heroku's needs it without a CA we can verify.
const isLocalUrl = (url) => /@(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url);

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set.\n' + USAGE);

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: isLocalUrl(databaseUrl) ? false : { rejectUnauthorized: false },
    max: 1,
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '120s'");
    const query = (sql, params) => client.query(sql, params);

    if (opts.listMatches) {
      const result = await listCompanyMatches({ query });
      console.log(opts.json ? JSON.stringify(result, null, 2) : formatMatches(result));
      return 0;
    }
    const result = await scanRecentPostings({ query, days: opts.days });
    console.log(opts.json ? JSON.stringify(result, null, 2) : formatScan(result));
    return result.live > 0 ? 1 : 0;
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
