#!/usr/bin/env node
'use strict';
/**
 * Put back the locations map-aggregators-local.js cut at 300 characters.
 *
 * Until 2026-11-22 the mapper inserted left(location, 300). aiapply (and Sprout) join every office
 * of a posting with "; ", so a long list lost its tail mid-place: Southland Industries' "Project
 * Manager" ends "...El Paso, Texas, United States; F" and lost Houston, TX. The mapper now keeps
 * the whole list (cut after a whole place past 2,000 characters, src/utils/aggregator-fields.js);
 * this repairs the rows already written.
 *
 * DRY RUN BY DEFAULT: reads both databases inside READ ONLY transactions and prints what it would
 * change.
 *
 *   DATABASE_URL=<target> node scripts/repair-aggregator-cut-locations.js                       # dry run
 *   DATABASE_URL=<target> node scripts/repair-aggregator-cut-locations.js --apply --confirm=<target-host>
 *
 * AGG_DB is where agg_raw lives (default: the local staging database the pulls write to). The
 * target is DATABASE_URL: staging, or the production board. A row is repaired only when it is
 * exactly 300 characters long, its URL is a feed posting whose own location is longer, and the
 * stored value is that location's first 300 characters (so nothing a crawler rewrote since is
 * touched). The update dirties index_dirty_at through the jobs trigger, so search picks it up.
 *
 * Undo is not needed: the new value only adds the places the cut dropped.
 */
const { Pool } = require('pg');
const { FIELDS } = require('./map-aggregators-local');
const { cutLocationList } = require('../src/utils/aggregator-fields');

const OLD_CUT = 300;
const USAGE = 'usage: repair-aggregator-cut-locations.js [--show=N] [--apply --confirm=<db-host>]';
const AGG_DB = process.env.AGG_DB || 'postgres://codev@localhost:5432/jobs_local';

function parseArgs(argv) {
  const opts = { apply: false, confirm: null, show: 10 };
  for (const arg of argv) {
    if (arg === '--apply') opts.apply = true;
    else if (arg.startsWith('--confirm=')) opts.confirm = arg.slice('--confirm='.length).trim().toLowerCase();
    else if (arg.startsWith('--show=')) opts.show = parseInt(arg.slice('--show='.length), 10) || 0;
    else throw new Error(`unknown argument "${arg}"\n${USAGE}`);
  }
  if (opts.confirm && !opts.apply) throw new Error('--confirm only makes sense with --apply\n' + USAGE);
  return opts;
}

const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };
const isLocalUrl = (url) => /@(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url);
const poolFor = (url) => new Pool({ connectionString: url, ssl: isLocalUrl(url) ? false : { rejectUnauthorized: false }, max: 1 });

/**
 * The repairs for the target rows, given every feed posting whose location is longer than the old
 * cut (url -> full location). Pure, so it is tested without a database.
 */
function planRepairs(targetRows, fullByUrl) {
  const out = [];
  for (const row of targetRows) {
    const full = fullByUrl.get(row.url);
    if (!full || String(row.location).length !== OLD_CUT) continue;
    if (full.slice(0, OLD_CUT) !== row.location) continue;
    const location = cutLocationList(full);
    if (location !== row.location) out.push({ id: row.id, url: row.url, from: row.location, to: location });
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const target = process.env.DATABASE_URL;
  if (!target) throw new Error('DATABASE_URL is not set.\n' + USAGE);
  const host = hostOf(target);
  if (!host) throw new Error('DATABASE_URL has no readable host.');
  if (opts.apply && opts.confirm !== host) throw new Error(`--apply needs --confirm=${host}   (this run would write to ${host})`);
  console.log(`agg_raw from: ${hostOf(AGG_DB)}   target: ${host}   mode: ${opts.apply ? 'APPLY (writing)' : 'dry run (read only)'}\n`);

  const src = poolFor(AGG_DB);
  const dst = poolFor(target);
  try {
    const fullByUrl = new Map();
    const s = await src.connect();
    try {
      await s.query('BEGIN READ ONLY');
      await s.query("SET LOCAL statement_timeout = '900s'");
      for (const [name, f] of Object.entries(FIELDS)) {
        const { rows } = await s.query(
          `SELECT url, location FROM (SELECT ${f.url} AS url, ${f.location} AS location FROM agg_raw WHERE source = $1) r
            WHERE url IS NOT NULL AND length(location) > ${OLD_CUT}`, [name]);
        for (const r of rows) if (!fullByUrl.has(r.url)) fullByUrl.set(r.url, r.location);
        if (rows.length) console.log(`  ${name}: ${rows.length.toLocaleString()} feed postings longer than ${OLD_CUT}`);
      }
      await s.query('ROLLBACK');
    } finally { s.release(); }

    const d = await dst.connect();
    try {
      await d.query('BEGIN READ ONLY');
      await d.query("SET LOCAL statement_timeout = '900s'");
      const { rows } = await d.query(`SELECT id, url, location FROM jobs WHERE length(location) = ${OLD_CUT}`);
      await d.query('ROLLBACK');
      const plan = planRepairs(rows, fullByUrl);
      console.log(`\n  target rows at exactly ${OLD_CUT} characters: ${rows.length.toLocaleString()}`);
      console.log(`  cut by the mapper and repairable: ${plan.length.toLocaleString()}`);
      for (const p of plan.slice(0, opts.show)) console.log(`   - job ${p.id}: ...${p.from.slice(-40)}  ->  ${p.to.length} chars, ...${p.to.slice(-40)}`);
      if (!opts.apply) { console.log('\nDry run: nothing written. Re-run with --apply --confirm=' + host); return; }
      await d.query('BEGIN');
      let done = 0;
      for (const p of plan) {
        const r = await d.query(`UPDATE jobs SET location = $2 WHERE id = $1 AND length(location) = ${OLD_CUT}`, [p.id, p.to]);
        done += r.rowCount;
      }
      await d.query('COMMIT');
      console.log(`\n  repaired: ${done.toLocaleString()}`);
    } finally { d.release(); }
  } finally {
    await src.end();
    await dst.end();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { planRepairs, parseArgs };
