#!/usr/bin/env node
'use strict';
/**
 * Rename the boards whose company name is a scraped heading, not the employer.
 *
 * map-aggregators-local.js named a new board after the longest company name any feed row gave it,
 * so Workable's kent-companies became "Description This" (its widget says "Kent Companies"), and so
 * did raydar and other Workable employers. FastApply keys "one application per company" on that
 * name, so different employers shared one key (pref-match loop, 2026-11-22 00h: seven First Apply
 * attempts). The mapper no longer picks such a name (src/utils/aggregator-fields.js); this repairs
 * the rows already written.
 *
 *   DATABASE_URL=<db> node scripts/repair-artifact-company-names.js                          # dry run: list
 *   DATABASE_URL=<db> node scripts/repair-artifact-company-names.js --probe                  # + ask Workable
 *   DATABASE_URL=<db> node scripts/repair-artifact-company-names.js --apply --confirm=<db-host>
 *
 * The dry run only reads the database (READ ONLY) and makes no network call. --probe also reads the
 * Workable widget (apply.workable.com/api/v1/widget/accounts/<slug>) for each Workable board and
 * prints the name it would set. --apply sets that name where the widget gives a real one; other
 * ATSs are listed only, since their own crawl renames them (sync.queue updateMeta). The companies
 * trigger dirties index_dirty_at, so search picks the new name up.
 *
 * Undo: each change is printed as "id: old -> new"; restore by hand from that list.
 */
const { Pool } = require('pg');
const { ARTIFACT_COMPANY_PATTERN, isArtifactCompanyName } = require('../src/utils/aggregator-fields');

const USAGE = 'usage: repair-artifact-company-names.js [--probe] [--apply --confirm=<db-host>]';

function parseArgs(argv) {
  const opts = { apply: false, probe: false, confirm: null };
  for (const arg of argv) {
    if (arg === '--apply') opts.apply = true;
    else if (arg === '--probe') opts.probe = true;
    else if (arg.startsWith('--confirm=')) opts.confirm = arg.slice('--confirm='.length).trim().toLowerCase();
    else throw new Error(`unknown argument "${arg}"\n${USAGE}`);
  }
  if (opts.confirm && !opts.apply) throw new Error('--confirm only makes sense with --apply\n' + USAGE);
  return opts;
}

const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };
const isLocalUrl = (url) => /@(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url);

/** The Workable widget's own name for a board, or null. `fetchImpl` is injectable for tests. */
async function workableName(slug, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}`,
      { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const name = String((await res.json())?.name ?? '').trim();
    return name && !isArtifactCompanyName(name) ? name : null;
  } catch { return null; }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.\n' + USAGE);
  const host = hostOf(url);
  if (!host) throw new Error('DATABASE_URL has no readable host.');
  if (opts.apply && opts.confirm !== host) throw new Error(`--apply needs --confirm=${host}   (this run would write to ${host})`);
  console.log(`database host: ${host}   mode: ${opts.apply ? 'APPLY (writing)' : opts.probe ? 'dry run + Workable probe' : 'dry run (read only, no network)'}\n`);

  const pool = new Pool({ connectionString: url, ssl: isLocalUrl(url) ? false : { rejectUnauthorized: false }, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '300s'");
    const { rows } = await client.query(
      `SELECT c.id, c.company_name, c.ats, c.ats_slug,
              (SELECT count(*) FROM jobs j WHERE j.company_id = c.id AND j.removed_at IS NULL) AS live_jobs
         FROM companies c WHERE c.company_name ~* $1 ORDER BY live_jobs DESC, c.id`, [ARTIFACT_COMPANY_PATTERN]);
    await client.query('ROLLBACK');
    console.log(`companies named like an artifact: ${rows.length}`);
    const byAts = rows.reduce((o, r) => ((o[r.ats] = (o[r.ats] || 0) + 1), o), {});
    console.log('  by ats:', JSON.stringify(byAts));

    const changes = [];
    for (const r of rows) {
      let proposed = null;
      if ((opts.probe || opts.apply) && r.ats === 'workable' && r.ats_slug && !/^wjb_/.test(r.ats_slug)) {
        proposed = await workableName(r.ats_slug);
      }
      console.log(`  ${r.id} ${r.ats}/${r.ats_slug} "${r.company_name}" live=${r.live_jobs}${proposed ? `  -> "${proposed}"` : ''}`);
      if (proposed) changes.push({ id: r.id, from: r.company_name, to: proposed });
    }
    if (!opts.apply) {
      console.log(`\n${opts.probe ? `would rename ${changes.length}. ` : ''}Nothing written. ${opts.probe ? '' : 'Add --probe to ask Workable, or '}--apply --confirm=${host} to rename.`);
      return;
    }
    await client.query('BEGIN');
    let done = 0;
    for (const c of changes) {
      const r = await client.query('UPDATE companies SET company_name = $2 WHERE id = $1 AND company_name = $3', [c.id, c.to, c.from]);
      if (r.rowCount) { done += 1; console.log(`  renamed ${c.id}: "${c.from}" -> "${c.to}"`); }
    }
    await client.query('COMMIT');
    console.log(`\nrenamed: ${done}`);
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { parseArgs, workableName };
