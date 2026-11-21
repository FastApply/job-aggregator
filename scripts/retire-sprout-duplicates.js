#!/usr/bin/env node
/**
 * Retire Sprout rows that duplicate a job we hold from the employer's own board.
 *
 * map-aggregators-local.js gave Sprout jobs on Workday/Oracle/iCIMS/... boards the id sprout_<id>,
 * which never matches a crawler's (workday_<req>, oracle_<Id>), and Sprout's Workday links carry
 * /en-US/ where the crawler's do not. So the crawl added its own copy beside the Sprout row instead
 * of replacing it, and the dead-link check never retires the Sprout row because its link still
 * opens. Search showed each such job twice, once with Sprout's AI summary.
 *
 * A Sprout row is retired only when a live non-Sprout row on the SAME TENANT (ats + ats_slug) has
 *   - the job id the Sprout link carries, as the crawler stores it (oracle_<id>, icims_<id>, ...), or
 *   - the same link once query, fragment, trailing slash and Workday's locale segment are removed.
 * A Sprout row with no such twin is kept: on Workday most of those are live jobs on a career site
 * the worker does not crawl (sync.queue passes no career_url, so a multi-site tenant is crawled on
 * one discovered site only).
 *
 *   DATABASE_URL=... node scripts/retire-sprout-duplicates.js            # shadow: counts + sample
 *   DATABASE_URL=... APPLY=1 node scripts/retire-sprout-duplicates.js    # retire
 *
 * Env: ATS (comma list), BATCH (5000), MAX_OUTBOX (20000), POLL_MS (20000), SHOW (sample rows, 15).
 */
const { Pool } = require('pg');

const URL = process.env.DATABASE_URL;
if (!URL) { console.error('DATABASE_URL is required'); process.exit(1); }
const APPLY = process.env.APPLY === '1';
const BATCH = parseInt(process.env.BATCH || '5000', 10);
const MAX_OUTBOX = parseInt(process.env.MAX_OUTBOX || '20000', 10);
const POLL_MS = parseInt(process.env.POLL_MS || '20000', 10);
const SHOW = parseInt(process.env.SHOW || '15', 10);

// The crawler's external_id, rebuilt from the job id in a Sprout link. ATSes whose link does not
// carry the crawler's id (teamtailor guid, recruitee numeric id) rely on the link match alone.
const DERIVED_ID = {
  workday: `'workday_' || substring(url from '_([A-Za-z0-9-]+)/?$')`,
  oracle: `'oracle_' || substring(url from '/job/([0-9]+)')`,
  icims: `'icims_' || substring(url from '/jobs/([0-9]+)/')`,
  zoho: `'zoho_' || substring(url from '/Careers/([0-9]+)')`,
  jazzhr: `'jazzhr_' || substring(url from '/apply/([A-Za-z0-9]+)')`,
  personio: `'personio_' || substring(url from '/job/([0-9]+)')`,
  bamboohr: `'bamboohr_' || substring(url from '/careers/([0-9]+)')`,
  rippling: `'rippling_' || substring(url from '/jobs/([0-9a-f-]{36})')`,
  teamtailor: 'NULL', recruitee: 'NULL', pinpoint: 'NULL',
};
const ATS = process.env.ATS ? process.env.ATS.split(',').map((a) => a.trim()).filter(Boolean) : Object.keys(DERIVED_ID);
const URL_KEY = (col) => `lower(regexp_replace(regexp_replace(split_part(split_part(${col},'?',1),'#',1),'/+$',''), '(myworkdayjobs\\.com)/[a-z]{2}-[a-z]{2}/', '\\1/', 'i'))`;
const DERIVED_CASE = `CASE j.ats ${ATS.map((a) => `WHEN '${a}' THEN ${DERIVED_ID[a].replace(/\burl\b/g, 'j.url')}`).join(' ')} END`;
const list = ATS.map((a) => `'${a}'`).join(',');

async function main() {
  const pool = new Pool({ connectionString: URL, max: 2, ssl: process.env.PGSSL === '0' ? false : undefined });
  const c = await pool.connect();
  const q = (sql, p) => c.query(sql, p);
  try {
    await q('SET statement_timeout = 0');
    console.log(`mode: ${APPLY ? 'APPLY' : 'SHADOW'} · ats: ${ATS.join(',')}`);

    await q(`CREATE TEMP TABLE sp AS
      SELECT j.id, j.ats, lower(c.ats_slug) AS slug, j.title, j.url, ${DERIVED_CASE} AS did, ${URL_KEY('j.url')} AS uk
        FROM jobs j JOIN companies c ON c.id = j.company_id
       WHERE j.removed_at IS NULL AND j.external_id LIKE 'sprout\\_%' AND j.ats IN (${list})`);
    const { rows: [s] } = await q('SELECT count(*)::int n FROM sp');
    console.log(`  live Sprout rows on crawlable boards: ${s.n.toLocaleString()}`);

    await q(`CREATE TEMP TABLE cr AS
      SELECT j.id, j.ats, lower(c.ats_slug) AS slug, j.external_id, ${URL_KEY('j.url')} AS uk
        FROM jobs j JOIN companies c ON c.id = j.company_id
       WHERE j.removed_at IS NULL AND j.external_id NOT LIKE 'sprout\\_%' AND j.ats IN (${list})
         AND lower(c.ats_slug) IN (SELECT DISTINCT slug FROM sp)`);
    await q('CREATE INDEX ON cr (ats, slug, external_id)');
    await q('CREATE INDEX ON cr (ats, slug, uk)');
    await q('ANALYZE cr');
    await q('ANALYZE sp');

    await q(`CREATE TEMP TABLE dup AS
      SELECT sp.id, sp.ats, sp.title, sp.url,
             (SELECT cr.id FROM cr WHERE cr.ats = sp.ats AND cr.slug = sp.slug
                 AND (cr.external_id = sp.did OR cr.uk = sp.uk) LIMIT 1) AS twin
        FROM sp`);
    await q('DELETE FROM dup WHERE twin IS NULL');
    await q('CREATE INDEX ON dup (id)');
    const { rows: by } = await q('SELECT ats, count(*)::int n FROM dup GROUP BY 1 ORDER BY 2 DESC');
    const { rows: tot } = await q('SELECT sp.ats, count(*)::int n FROM sp GROUP BY 1');
    const totals = Object.fromEntries(tot.map((r) => [r.ats, r.n]));
    let all = 0;
    console.log('  duplicates (twin on the employer board) / live Sprout rows:');
    for (const r of by) { all += r.n; console.log(`    ${r.ats.padEnd(11)} ${r.n.toLocaleString().padStart(9)} / ${(totals[r.ats] || 0).toLocaleString()}`); }
    console.log(`  total to retire: ${all.toLocaleString()}`);
    const { rows: sample } = await q(`SELECT d.ats, d.title, d.url, k.external_id, k.url AS twin_url
        FROM dup d JOIN jobs k ON k.id = d.twin ORDER BY random() LIMIT ${SHOW}`);
    for (const r of sample) console.log(`   ${r.ats} | ${r.title}\n       sprout ${r.url.slice(0, 140)}\n       twin   ${r.external_id} ${r.twin_url.slice(0, 120)}`);

    if (!APPLY) { console.log('\nSHADOW: nothing written. APPLY=1 to retire.'); return; }

    const { rows: ids } = await q('SELECT id FROM dup ORDER BY id');
    let done = 0;
    for (let i = 0; i < ids.length; i += BATCH) {
      for (;;) {
        const { rows: [o] } = await q('SELECT COUNT(*)::int n FROM jobs WHERE index_dirty_at IS NOT NULL');
        if (o.n < MAX_OUTBOX) break;
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      const chunk = ids.slice(i, i + BATCH).map((r) => r.id);
      const res = await q(`UPDATE jobs SET removed_at = NOW() WHERE id = ANY($1::bigint[]) AND removed_at IS NULL
                             AND external_id LIKE 'sprout\\_%'`, [chunk]);
      done += res.rowCount;
      process.stdout.write(`\r  retired ${done.toLocaleString()} / ${ids.length.toLocaleString()}   `);
    }
    console.log(`\nretired ${done.toLocaleString()} duplicate Sprout rows.`);
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
