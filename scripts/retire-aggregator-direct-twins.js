#!/usr/bin/env node
/**
 * Retire Sprout/aiapply rows that went to prod as ats='direct' but belong to a board we now crawl.
 *
 * Until 2026-11-15 map-aggregators-local.js had no URL rules for Dayforce, UKG/UltiPro, Manatal,
 * CareerPlug, ADP and SuccessFactors, so their postings were filed under 'direct' (no adapter, never
 * re-checked). The rules exist now, the boards were created in prod (21,422 on 2026-11-15) and the
 * crawler has synced them, so the same posting is live twice: the crawled row, and the stale 'direct'
 * copy nothing will ever refresh or retire.
 *
 * A 'direct' row is retired only when the board its URL names exists in prod AND holds a live,
 * non-'direct' row carrying the same job id. The id is read per platform, because one shared rule
 * would be wrong: UKG keeps it in the query (?opportunityId=<uuid>), so stripping queries would make
 * every UKG posting on a board look identical. Rows whose board has no twin are left alone.
 *
 *   DATABASE_URL=... node scripts/retire-aggregator-direct-twins.js           # shadow
 *   DATABASE_URL=... APPLY=1 node scripts/retire-aggregator-direct-twins.js   # retire
 *
 * Env: BATCH (5000), MAX_OUTBOX (20000), POLL_MS (20000), SHOW (12).
 */
const { Pool } = require('pg');

const URL_ = process.env.DATABASE_URL;
if (!URL_) { console.error('DATABASE_URL is required'); process.exit(1); }
const APPLY = process.env.APPLY === '1';
const BATCH = parseInt(process.env.BATCH || '5000', 10);
const MAX_OUTBOX = parseInt(process.env.MAX_OUTBOX || '20000', 10);
const POLL_MS = parseInt(process.env.POLL_MS || '20000', 10);
const SHOW = parseInt(process.env.SHOW || '12', 10);

// Same board shapes as map-aggregators-local.js; host/bare as it computes them.
const ATS = `CASE
  WHEN host = 'jobs.dayforcehcm.com' AND bare ~ '^jobs\\.dayforcehcm\\.com/[A-Za-z]{2}-[A-Za-z]{2}/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+' THEN 'dayforce'
  WHEN (host ~ '^recruiting[0-9]*\\.ultipro\\.(com|ca)$' OR host ~ '\\.rec\\.pro\\.ukg\\.net$') AND bare ~* '/[^/]+/JobBoard/[0-9a-f-]{36}' THEN 'ukg'
  WHEN host = 'careers-page.com' AND split_part(bare,'/',2) <> '' THEN 'manatal'
  WHEN host ~ '^[a-z0-9-]+\\.careerplug\\.com$' AND split_part(host,'.',1) NOT IN ('www','app','api') THEN 'careerplug'
  WHEN host = 'myjobs.adp.com' AND split_part(bare,'/',2) <> '' THEN 'adp'
  WHEN host = 'workforcenow.adp.com' AND url ~* 'cid=[0-9a-f-]{36}' THEN 'adp_workforcenow'
  WHEN host ~ '\\.jobs\\.hr\\.cloud\\.sap$' THEN 'successfactors'
  WHEN url ~* '^https?://[^/]+/([^/]+/)?job/[^/]+/[0-9]{6,}/?(\\?|$)' THEN 'successfactors?'
  END`;
const SLUG = `CASE ats
  WHEN 'dayforce' THEN lower(split_part(bare,'/',3)) || CASE WHEN upper(split_part(bare,'/',4)) = 'CANDIDATEPORTAL' THEN '' ELSE '/' || lower(split_part(bare,'/',4)) END
  WHEN 'ukg' THEN host || '/' || lower(split_part(bare,'/',2)) || '/' || lower(substring(bare from '(?i)/JobBoard/([0-9a-f-]{36})'))
  WHEN 'manatal' THEN lower(split_part(bare,'/',2))
  WHEN 'adp' THEN lower(split_part(bare,'/',2))
  WHEN 'careerplug' THEN split_part(host,'.',1)
  WHEN 'adp_workforcenow' THEN lower(substring(url from '(?i)cid=([0-9a-f-]{36})'))
  ELSE lower(split_part(regexp_replace(url,'^https?://',''),'/',1)) END`;
// The posting's own id, as it appears in the crawled row's URL too.
const JID = `CASE ats
  WHEN 'dayforce' THEN substring(bare from '/jobs/([0-9]+)')
  WHEN 'careerplug' THEN substring(bare from '/jobs/([0-9]+)')
  WHEN 'ukg' THEN lower(substring(url from '(?i)opportunityId=([0-9a-f-]{36})'))
  WHEN 'adp_workforcenow' THEN substring(url from '(?i)jobId=([0-9]+)')
  WHEN 'adp' THEN substring(url from '(?i)(?:reqId|jobId)=([0-9A-Za-z]+)')
  WHEN 'manatal' THEN substring(bare from '/job/([A-Za-z0-9]+)')
  ELSE substring(bare from '/([0-9]{6,})/?$') END`;

async function main() {
  const pool = new Pool({ connectionString: URL_, max: 2 });
  const c = await pool.connect();
  const q = (sql, p) => c.query(sql, p);
  try {
    await q('SET statement_timeout = 0');
    console.log(`mode: ${APPLY ? 'APPLY' : 'SHADOW'}`);
    await q(`CREATE TEMP TABLE d AS
      WITH r AS (
        SELECT id, url, external_id, title,
               lower(split_part(regexp_replace(url,'^https?://(www\\.)?','','i'),'/',1)) AS host,
               regexp_replace(split_part(split_part(url,'?',1),'#',1),'^https?://(www\\.)?','','i') AS bare
          FROM jobs
         WHERE ats = 'direct' AND removed_at IS NULL
           AND (external_id LIKE 'aiapply\\_%' OR external_id LIKE 'sprout\\_%')),
      a AS (SELECT r.*, ${ATS} AS ats FROM r)
      SELECT a.*, ${SLUG} AS slug, ${JID} AS jid FROM a WHERE ats IS NOT NULL`);
    // SuccessFactors on an employer's own domain: only when prod holds that host as a board.
    await q(`UPDATE d SET ats = 'successfactors' WHERE ats = 'successfactors?'`);
    await q(`CREATE INDEX ON d (ats, slug)`);
    const { rows: [t] } = await q(`SELECT count(*)::int n FROM d WHERE jid IS NOT NULL`);
    console.log(`  'direct' aggregator rows on a crawlable platform with a job id: ${t.n.toLocaleString()}`);

    await q(`CREATE TEMP TABLE m AS
      SELECT d.id, d.ats, d.slug, d.title, d.url,
             (SELECT j.id FROM companies co JOIN jobs j ON j.company_id = co.id
               WHERE co.ats = d.ats AND lower(co.ats_slug) = d.slug
                 AND j.removed_at IS NULL AND j.ats <> 'direct' AND j.url LIKE '%' || d.jid || '%'
               LIMIT 1) AS twin
        FROM d WHERE d.jid IS NOT NULL AND length(d.jid) >= 4`);
    await q('DELETE FROM m WHERE twin IS NULL');
    const { rows: by } = await q('SELECT ats, count(*)::int n FROM m GROUP BY 1 ORDER BY 2 DESC');
    const { rows: tot } = await q('SELECT ats, count(*)::int n FROM d GROUP BY 1');
    const totals = Object.fromEntries(tot.map((r) => [r.ats, r.n]));
    let all = 0;
    console.log('  retire (crawled twin found) / direct rows on that platform:');
    for (const r of by) { all += r.n; console.log(`    ${r.ats.padEnd(17)} ${r.n.toLocaleString().padStart(8)} / ${(totals[r.ats] || 0).toLocaleString()}`); }
    console.log(`  total to retire: ${all.toLocaleString()}`);
    const { rows: sample } = await q(`SELECT m.ats, m.title, m.url, k.url AS twin_url FROM m JOIN jobs k ON k.id = m.twin ORDER BY random() LIMIT ${SHOW}`);
    for (const r of sample) console.log(`   ${r.ats} | ${String(r.title).slice(0, 50)}\n       direct ${r.url.slice(0, 120)}\n       twin   ${r.twin_url.slice(0, 120)}`);

    if (!APPLY) { console.log('\nSHADOW: nothing written. APPLY=1 to retire.'); return; }
    const { rows: ids } = await q('SELECT id FROM m ORDER BY id');
    let done = 0;
    for (let i = 0; i < ids.length; i += BATCH) {
      for (;;) {
        const { rows: [o] } = await q('SELECT COUNT(*)::int n FROM jobs WHERE index_dirty_at IS NOT NULL');
        if (o.n < MAX_OUTBOX) break;
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      const res = await q(`UPDATE jobs SET removed_at = NOW() WHERE id = ANY($1::bigint[]) AND removed_at IS NULL AND ats = 'direct'`,
        [ids.slice(i, i + BATCH).map((r) => r.id)]);
      done += res.rowCount;
      process.stdout.write(`\r  retired ${done.toLocaleString()} / ${ids.length.toLocaleString()}   `);
    }
    console.log(`\nretired ${done.toLocaleString()} 'direct' aggregator rows.`);
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
