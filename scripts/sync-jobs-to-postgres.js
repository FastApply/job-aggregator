#!/usr/bin/env node
/**
 * Syncs companies + jobs from local SQLite (./data/jobs.db) to the Heroku Postgres DB.
 *
 * Uses BATCHED multi-row upserts (the DB is in us-east-1; round-trip latency makes
 * row-by-row inserts impractical for large pushes). Streams jobs from SQLite in
 * id-paged chunks so memory stays bounded even while a fetcher writes concurrently.
 *
 * Connection: process.env.DB_URL (Heroku DATABASE_URL).
 *   DB_URL=$(heroku config:get DATABASE_URL -a fastapply-board) node scripts/sync-jobs-to-postgres.js
 *
 * Scope knobs (env):
 *   SYNC_DAYS    only jobs posted within N days. Default 90 (matches the worker's
 *                90-day retention). 0 or negative = ALL ages.
 *   SYNC_ORIGIN  restrict to one source: 'liftmycv' (raw_data has no `source`),
 *                'wonsulting', or 'lazyapply'. Default: all sources.
 *   BATCH        rows per multi-row upsert. Default 500.
 */
const { Client } = require('pg');
const sqlite3 = require('better-sqlite3');
const sandboxGuard = require('../src/utils/sandbox-guard');

const SUPPORTED_ATS = ['greenhouse','lever','ashby','workable','smartrecruiters','recruitee','bamboohr','breezy','pinpoint','personio','zoho','jazzhr','rippling'];
// jworkable rows are Workable jobs under a legacy label; myworkdayjobs rows are Workday
// jobs under their raw host label. Fold both into the platform's canonical ats (normalized
// in-query) so they merge with the existing 'workable'/'workday' companies in Postgres.
const ATS_FILTER = [...SUPPORTED_ATS, 'jworkable', 'myworkdayjobs'].map(a => "'" + a + "'").join(',');
const ATS_NORM = (col) => `CASE WHEN ${col}='jworkable' THEN 'workable' WHEN ${col}='myworkdayjobs' THEN 'workday' ELSE ${col} END`;

const SYNC_DAYS = process.env.SYNC_DAYS === undefined ? 90 : parseInt(process.env.SYNC_DAYS);
const NO_CUTOFF = !SYNC_DAYS || SYNC_DAYS <= 0;
const SYNC_ORIGIN = (process.env.SYNC_ORIGIN || '').toLowerCase();
const BATCH = parseInt(process.env.BATCH || '500');
// DELTA=1 → insert only jobs NOT already in Postgres (keyed by external_id+company_id).
// Makes re-runs fast (sends only new/missing rows) instead of re-upserting everything;
// the trade-off is it does NOT refresh already-synced rows (title/description/last_seen).
const DELTA = process.env.DELTA === '1' || process.env.DELTA === 'true';

const VALID_ORIGINS = ['liftmycv', 'wonsulting', 'lazyapply'];
if (SYNC_ORIGIN && !VALID_ORIGINS.includes(SYNC_ORIGIN)) { console.error(`Invalid SYNC_ORIGIN: ${SYNC_ORIGIN}`); process.exit(1); }

function jobOriginFilter() {
  if (SYNC_ORIGIN === 'liftmycv') return "AND json_extract(j.raw_data,'$.source') IS NULL";
  if (SYNC_ORIGIN) return `AND json_extract(j.raw_data,'$.source') = '${SYNC_ORIGIN}'`;
  return '';
}

// Postgres btree index entries cap at ~2704 bytes. location / visa_sponsorship /
// experience_level are btree-indexed, so truncate them (a few jobs have absurd
// multi-KB location strings that would otherwise blow up the index).
function truncBytes(s, max = 2600) {
  if (s == null) return s;
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  return Buffer.from(s, 'utf8').subarray(0, max).toString('utf8').replace(/�+$/, '');
}

async function newClient() {
  const c = new Client({ connectionString: process.env.DB_URL, ssl: { rejectUnauthorized: false } });
  c.on('error', () => {});
  await c.connect();
  return c;
}

(async () => {
  if (!process.env.DB_URL) { console.error('DB_URL env not set (e.g. DB_URL=$(heroku config:get DATABASE_URL -a fastapply-board))'); process.exit(1); }

  const db = sqlite3('./data/jobs.db', { readonly: true });
  let c = await newClient();

  // resilient query: reconnect + retry on connection drops
  async function query(sql, params) {
    let attempts = 0;
    while (true) {
      try { return await c.query(sql, params); }
      catch (e) {
        attempts++;
        const msg = e.message || '';
        if ((msg.includes('not queryable') || msg.includes('connection') || msg.includes('terminat') || msg.includes('timeout')) && attempts < 6) {
          try { await c.end(); } catch {}
          try { c = await newClient(); } catch {}
          await new Promise(r => setTimeout(r, 500 * attempts));
          continue;
        }
        throw e;
      }
    }
  }

  const scope = [
    `origin=${SYNC_ORIGIN || 'all'}`,
    NO_CUTOFF ? 'ages=all' : `days=${SYNC_DAYS}`,
    `batch=${BATCH}`,
  ].join(' | ');
  console.log(`Sync scope: ${scope}`);

  // --- 1. Company map (keyed by career_url, the unique conflict key) ---
  console.log('Loading existing Postgres companies...');
  const pgByCareerUrl = new Map();
  const pgCos = await query('SELECT id, career_url FROM companies WHERE career_url IS NOT NULL');
  for (const row of pgCos.rows) pgByCareerUrl.set(row.career_url, row.id);
  console.log('  ', pgByCareerUrl.size, 'existing');

  const allLocalCompanies = db.prepare(`
    SELECT c.id AS local_id, c.company_name, c.domain, ${ATS_NORM('c.ats')} AS ats,
      c.ats_slug, c.career_url, COALESCE(c.origin, 'liftmycv') AS origin,
      COALESCE(c.logo_url, (SELECT json_extract(j.raw_data,'$.logoUrl') FROM jobs j
        WHERE j.company_id = c.id AND json_extract(j.raw_data,'$.logoUrl') IS NOT NULL LIMIT 1)) AS logo
    FROM companies c
    WHERE c.ats IN (${ATS_FILTER}) AND c.career_url IS NOT NULL AND c.ats_slug IS NOT NULL
    ${SYNC_ORIGIN ? `AND c.origin = '${SYNC_ORIGIN}'` : ''}
  `).all();
  // ATS demo/sandbox boards are not employers (FA-053): never push one to Postgres. A dropped
  // company is also absent from localToPg below, so its jobs are skipped with the other
  // "no company" rows even when the company already exists in Postgres.
  const localCompanies = allLocalCompanies.filter((co) => !sandboxGuard.judgePosting(
    { ats: co.ats, slug: co.ats_slug, careerUrl: co.career_url }, { source: 'sync-jobs-to-postgres' }).reject);
  const sandboxCompanies = allLocalCompanies.length - localCompanies.length;
  console.log('Local companies in scope:', localCompanies.length, sandboxCompanies ? `(+${sandboxCompanies} sandbox boards skipped)` : '');

  // Batch-upsert the ones not already in Postgres.
  const missing = localCompanies.filter(co => !pgByCareerUrl.has(co.career_url));
  let companiesInserted = 0;
  for (let i = 0; i < missing.length; i += BATCH) {
    const chunk = missing.slice(i, i + BATCH);
    const vals = [];
    const tuples = chunk.map((co, k) => {
      const b = k * 8;
      vals.push(co.company_name, co.domain || '', co.ats, co.ats_slug, co.career_url, co.logo || null, 'active', co.origin);
      return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},NOW(),NOW())`;
    }).join(',');
    try {
      const r = await query(
        `INSERT INTO companies (company_name,domain,ats,ats_slug,career_url,logo_url,status,origin,created_at,updated_at)
         VALUES ${tuples} ON CONFLICT (career_url) DO UPDATE SET updated_at=NOW() RETURNING id, career_url`, vals);
      for (const row of r.rows) { if (!pgByCareerUrl.has(row.career_url)) companiesInserted++; pgByCareerUrl.set(row.career_url, row.id); }
    } catch (e) { console.error('  company batch error:', e.message); }
    if ((i / BATCH) % 10 === 0) process.stdout.write(`\r  companies upserted: ${Math.min(i + BATCH, missing.length)}/${missing.length}`);
  }
  console.log(`\n  + ${companiesInserted} new companies`);

  const localToPg = new Map();
  for (const co of localCompanies) { const id = pgByCareerUrl.get(co.career_url); if (id) localToPg.set(co.local_id, id); }

  // --- 2. Stream jobs in id-paged chunks, batch-upsert each ---
  const cutoff = NO_CUTOFF ? null : new Date(Date.now() - SYNC_DAYS * 864e5).toISOString();
  const totalToSync = db.prepare(`
    SELECT COUNT(*) AS n FROM jobs j
    WHERE j.removed_at IS NULL AND j.ats IN (${ATS_FILTER}) AND j.posted_at IS NOT NULL
    ${NO_CUTOFF ? '' : 'AND j.posted_at >= @cutoff'} ${jobOriginFilter()}
  `).get(NO_CUTOFF ? {} : { cutoff }).n;
  console.log(`Jobs in scope: ${totalToSync}`);

  // DELTA mode: pre-load existing (external_id, company_id) keys so we only send missing rows.
  let existingKeys = null;
  if (DELTA) {
    existingKeys = new Set();
    const pgIds = new Set(localToPg.values());
    process.stdout.write('  [delta] loading existing PG job keys...');
    // Keyset pagination (WHERE id > lastId) — O(n) and immune to row-shift/reconnect
    // drift that OFFSET pagination suffers from.
    let lastPgId = 0, loaded = 0;
    while (true) {
      const r = await query('SELECT id, external_id, company_id FROM jobs WHERE id > $1 ORDER BY id LIMIT 50000', [lastPgId]);
      if (!r.rows.length) break;
      for (const row of r.rows) if (pgIds.has(row.company_id)) existingKeys.add(row.external_id + ':' + row.company_id);
      lastPgId = r.rows[r.rows.length - 1].id;
      loaded += r.rows.length;
      process.stdout.write(`\r  [delta] loaded ${loaded} PG job keys (${existingKeys.size} in scope)`);
    }
    console.log(`\n  [delta] ${existingKeys.size} existing keys in scope; will insert only missing`);
  }

  const pageStmt = db.prepare(`
    SELECT j.id, j.external_id, j.company_id, ${ATS_NORM('j.ats')} AS ats, j.title, j.department,
      j.location, j.workplace_type, j.employment_type, j.salary_min, j.salary_max,
      j.salary_currency, j.salary_interval, j.description, j.url, j.posted_at, j.raw_data,
      j.visa_sponsorship, j.experience_level, j.is_remote, j.remote_worldwide
    FROM jobs j
    WHERE j.removed_at IS NULL AND j.ats IN (${ATS_FILTER}) AND j.posted_at IS NOT NULL
    ${NO_CUTOFF ? '' : 'AND j.posted_at >= @cutoff'} ${jobOriginFilter()}
    AND j.id > @lastId ORDER BY j.id LIMIT @lim
  `);

  const JOB_COLS = 20;
  const COLS_SQL = `external_id,company_id,ats,title,department,location,workplace_type,employment_type,salary_min,salary_max,salary_currency,salary_interval,description,url,posted_at,raw_data,visa_sponsorship,experience_level,is_remote,remote_worldwide,first_seen_at,last_seen_at`;
  const UPSERT_TAIL = `ON CONFLICT (external_id, company_id) DO UPDATE SET
        title = EXCLUDED.title,
        description = COALESCE(EXCLUDED.description, jobs.description),
        url = EXCLUDED.url,
        posted_at = EXCLUDED.posted_at,
        last_seen_at = NOW(),
        removed_at = NULL`;
  const jobParams = (r) => [
    r.external_id, r.pgId, r.ats, r.title, r.department, truncBytes(r.location), r.workplace_type,
    r.employment_type, r.salary_min, r.salary_max, r.salary_currency, r.salary_interval,
    r.description, r.url, r.posted_at, r.raw_data, truncBytes(r.visa_sponsorship) || null,
    truncBytes(r.experience_level) || null, r.is_remote === 1, r.remote_worldwide === 1,
  ];

  async function upsertRows(rows) {
    const vals = [];
    const tuples = rows.map((r, k) => {
      const b = k * JOB_COLS;
      vals.push(...jobParams(r));
      const ph = Array.from({ length: JOB_COLS }, (_, x) => `$${b + x + 1}`).join(',');
      return `(${ph},NOW(),NOW())`;
    }).join(',');
    const res = await query(`INSERT INTO jobs (${COLS_SQL}) VALUES ${tuples} ${UPSERT_TAIL}`, vals);
    return res.rowCount || 0;
  }

  async function flushJobs(rows) {
    if (!rows.length) return { up: 0, err: 0 };
    try { return { up: await upsertRows(rows), err: 0 }; }
    catch (e) {
      // A bad row (e.g. still-oversized indexed value) fails the whole batch — retry
      // each row alone so only the genuinely-bad ones are dropped.
      let up = 0, err = 0;
      for (const r of rows) {
        try { up += await upsertRows([r]); }
        catch (e2) { err++; if (err <= 3) console.error(`\n  row skip ext=${r.external_id}: ${(e2.message || '').slice(0, 120)}`); }
      }
      return { up, err };
    }
  }

  let lastId = 0, upserted = 0, skippedNoCo = 0, skippedSandbox = 0, processed = 0, rowErrors = 0, alreadyPresent = 0;
  const start = Date.now();
  while (true) {
    const rows = pageStmt.all({ cutoff: cutoff || '', lastId, lim: BATCH });
    if (!rows.length) break;
    lastId = rows[rows.length - 1].id;

    const ready = [];
    for (const j of rows) {
      const pgId = localToPg.get(j.company_id);
      if (!pgId) { skippedNoCo++; continue; }
      // A feed company can carry a posting on a sandbox board; the job's URL is what names it.
      if (sandboxGuard.judgePosting({ ats: j.ats, url: j.url }, { source: 'sync-jobs-to-postgres' }).reject) { skippedSandbox++; continue; }
      if (existingKeys && existingKeys.has(j.external_id + ':' + pgId)) { alreadyPresent++; continue; }
      j.pgId = pgId; ready.push(j);
    }
    processed += rows.length;
    const res = await flushJobs(ready);
    upserted += res.up; rowErrors += res.err;

    const rate = (processed / ((Date.now() - start) / 1000)).toFixed(0);
    process.stdout.write(`\r  ${processed}/${totalToSync} processed | upserted ${upserted} | skipped(no co) ${skippedNoCo}${DELTA ? ` | alreadyPresent ${alreadyPresent}` : ''} | rowErr ${rowErrors} | ${rate}/s`);
  }

  console.log(`\nDONE in ${((Date.now() - start) / 60000).toFixed(1)} min: upserted ${upserted}, skipped ${skippedNoCo}${DELTA ? `, alreadyPresent ${alreadyPresent}` : ''}, rowErrors ${rowErrors}`);
  if (skippedSandbox) console.log(`Skipped ${skippedSandbox} jobs on ATS demo/sandbox boards (FA-053)`);
  try {
    const r1 = await query('SELECT COUNT(*) AS t FROM companies');
    const r2 = await query('SELECT COUNT(*) AS t FROM jobs WHERE removed_at IS NULL');
    console.log('Postgres now:', r1.rows[0].t, 'companies |', r2.rows[0].t, 'active jobs');
  } catch {}

  try { await c.end(); } catch {}
  db.close();
})().catch(e => { console.error(e); process.exit(1); });
