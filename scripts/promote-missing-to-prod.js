#!/usr/bin/env node
/**
 * Promote to production the companies and jobs that production does NOT already have.
 *
 * SHADOW BY DEFAULT. Nothing is written unless APPLY=1.
 *
 *   node scripts/promote-missing-to-prod.js               # shadow
 *   LIMIT_COMPANIES=50 node scripts/promote-missing-to-prod.js
 *   APPLY=1 node scripts/promote-missing-to-prod.js       # armed
 *
 * Env:
 *   LOCAL_URL / PROD_URL   databases (PROD_URL defaults to ~/.fastapply-database-url)
 *   APPLY=1                write
 *   LIMIT_COMPANIES        stop after N companies (0 = all)
 *   SLEEP_MS               pause between companies (default 120)
 *   CHECKPOINT             resume file
 *
 * ── DEDUPE ON THE EMPLOYER URL, NOT external_id ─────────────────────────────────────────
 * This is the whole reason the script exists in this shape. The staging corpus carries
 * `external_id = simplify_<uuid>` while production holds the SAME posting under its native id
 * (`ashby_67f41097-...`), because prod's own crawler found it first. The unique constraint is
 * (external_id, company_id), so an upsert keyed on it does not collide — it inserts a second
 * copy. Measured on 200 ashby rows: 185 (92.5%) already existed in prod under a native id.
 * Promoting on external_id would therefore have put a duplicate of nearly every job on the live
 * board — same title, same company, same apply link.
 *
 * The resolved employer URL is the one identity both sides share, so that is the key.
 *
 * ── WHY PER-COMPANY, NOT ONE BIG DIFF ───────────────────────────────────────────────────
 * jobs.url is NOT indexed in production, and a `url = ANY(...)` scan over 5.2M rows / 42GB
 * did not finish in 10 minutes while the fleet was writing. idx_jobs_company_id IS present, so
 * fetching one company's URLs is a cheap index lookup. Diffing company-by-company turns an
 * impossible full scan into a few hundred indexed reads, and needs no DDL on production.
 *
 * ── WHAT IT PROMOTES ────────────────────────────────────────────────────────────────────
 * 1. Companies local has that prod does not, matched on (ats, lower(ats_slug)).
 * 2. Jobs whose employer URL prod does not already hold for that company.
 *
 * Never promotes: rows still pointing at simplify.jobs (unenriched), rows retired locally, or
 * companies with no real ats/slug. Never writes removed_at — retirement stays prod's own.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pool } = require('pg');

const LOCAL_URL = process.env.LOCAL_URL || 'postgres://codev@localhost:5432/jobs_local';
const PROD_URL = process.env.PROD_URL || (() => {
  try { return fs.readFileSync(path.join(os.homedir(), '.fastapply-database-url'), 'utf8').trim(); }
  catch { return ''; }
})();
const APPLY = process.env.APPLY === '1';
const LIMIT_COMPANIES = parseInt(process.env.LIMIT_COMPANIES || '0', 10);
const SLEEP_MS = parseInt(process.env.SLEEP_MS || '0', 10);
// Employers processed at once. Each holds one prod connection while inserting, so this is the
// main throughput lever: the first armed run did 3 employers in 28 minutes serially (~350
// jobs/min), which is weeks for 8,528. Prod's role limit is 200 and sits near 35 in use.
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '5', 10);
// Rows per INSERT. 200 meant a transatlantic round trip every 200 jobs; 1,000 cuts that 5x and
// stays well under Postgres's 65535 bind-parameter ceiling (24 cols x 1000 = 24,000).
const INSERT_BATCH = parseInt(process.env.INSERT_BATCH || '1000', 10);
// Only promote postings a crawler confirmed recently. sync-local-to-prod.js has carried this
// guard from the start and this script shipped without it: the first armed run pushed ~7,600
// jobs last seen 7-9 days earlier (greenhouse/svetness 2026-08-31, american-logistics-authority
// 2026-09-02). "removed_at IS NULL" only means nothing has retired it, NOT that anyone checked.
const MAX_AGE_H = parseInt(process.env.MAX_AGE_H === undefined ? '24' : process.env.MAX_AGE_H, 10);
// 'crawled' = employers we hold as real companies. 'simplify' = the imported corpus, whose
// employer identity lives in the ENRICHED URL rather than in its (placeholder) company row.
const SOURCE = (process.env.SOURCE || 'crawled').toLowerCase();
const CHECKPOINT = process.env.CHECKPOINT || '/tmp/promote-missing.checkpoint';
// Pause when the search-index outbox gets too deep.
//
// Every insert sets index_dirty_at, and the Render worker drains to Meili at ~2,000 per 72s
// (~100k/hour). The first full run pushed 308,702 jobs with no regard for that and drove the
// outbox to 244,562 against a normal band of 0-3,000 — it fired the "Search index is falling
// behind" alert and users saw a stale index for hours. Inserting faster than the index can
// absorb does not deliver jobs sooner; it just moves the queue somewhere less visible.
const OUTBOX_MAX = parseInt(process.env.OUTBOX_MAX || '40000', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const n = (v) => Number(v).toLocaleString();

// Columns copied on insert. Excludes: id (prod assigns), removed_at and absent_syncs (prod owns
// retirement), and the columns prod's triggers populate.
const COLS = ['external_id', 'company_id', 'ats', 'title', 'department', 'location',
  'workplace_type', 'employment_type', 'salary_min', 'salary_max', 'salary_currency',
  'salary_interval', 'description', 'url', 'posted_at', 'raw_data', 'first_seen_at',
  'last_seen_at', 'created_at', 'visa_sponsorship', 'experience_level', 'is_remote',
  'remote_worldwide', 'role_category'];

/** Canonical board URL, used when creating a company derived from an enriched job URL. */
function canonicalUrl(ats, slug) {
  const m = {
    greenhouse: `https://boards.greenhouse.io/${slug}`,
    lever: `https://jobs.lever.co/${slug}`,
    ashby: `https://jobs.ashbyhq.com/${slug}`,
    workable: `https://apply.workable.com/${slug}`,
    smartrecruiters: `https://careers.smartrecruiters.com/${slug}`,
    jazzhr: `https://${slug}.applytojob.com`,
    bamboohr: `https://${slug}.bamboohr.com/careers`,
    breezy: `https://${slug}.breezy.hr`,
    rippling: `https://ats.rippling.com/${slug}/jobs`,
    teamtailor: `https://${slug}.teamtailor.com`,
    recruitee: `https://${slug}.recruitee.com`,
    pinpoint: `https://${slug}.pinpointhq.com`,
    workday: `https://${slug}.myworkdayjobs.com`,
  };
  return m[ats] || `https://example.invalid/${ats}/${slug}`;
}

/** Strip the query string and fragment so the same posting compares equal across sources. */
function urlKey(u) {
  if (!u) return null;
  try {
    const x = new URL(u);
    return (x.origin + x.pathname).replace(/\/+$/, '').toLowerCase();
  } catch { return String(u).split('?')[0].split('#')[0].replace(/\/+$/, '').toLowerCase(); }
}

/**
 * Resolve the prod host ONCE and connect by IP.
 *
 * This machine has a single resolver (its router, 192.168.1.1). Under load it drops lookups:
 * with 5 employer workers on top of a ~65-process crawler fleet, an armed run failed 8,426 of
 * 8,430 employers in 150 seconds, every one `getaddrinfo ENOTFOUND`. The host resolves fine
 * when asked once — the resolver simply cannot take the concurrency.
 *
 * Pinning the IP removes DNS from the hot path entirely: one lookup at startup instead of one
 * per connection. Safe here because the pool already sets rejectUnauthorized:false (Heroku
 * presents a cert from its own CA), so swapping host for IP changes nothing about the TLS
 * outcome. The real fix is a second resolver — the handover names 1.1.1.1 — but that is a
 * change to the machine, not to this script.
 */
async function pinHostToIp(url) {
  try {
    const dns = require('dns').promises;
    const u = new URL(url);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) return url;   // already an IP
    const { address } = await dns.lookup(u.hostname, { family: 4 });
    console.log(`  DNS pinned: ${u.hostname} -> ${address}`);
    u.hostname = address;
    return u.toString();
  } catch (e) {
    console.log(`  DNS pin failed (${e.message}) — falling back to hostname`);
    return url;
  }
}

(async () => {
  if (!PROD_URL) { console.error('FATAL: no PROD_URL'); process.exit(1); }
  // Pool, not Client. A bare Client has no reconnect and emits an unhandled 'error' event when
  // Heroku drops a long-lived connection — which killed an armed run mid-insert. A Pool replaces
  // a dead connection on the next query, and the listener below stops an idle-client drop from
  // taking the process down. keepAlive holds the socket open through slow per-employer batches.
  const local = new Pool({ connectionString: LOCAL_URL, max: Math.max(4, CONCURRENCY + 2), keepAlive: true,
    idleTimeoutMillis: 0, statement_timeout: 300000 });
  const PROD_PINNED = await pinHostToIp(PROD_URL);
  const prod = new Pool({ connectionString: PROD_PINNED, ssl: { rejectUnauthorized: false }, max: Math.max(4, CONCURRENCY + 2),
    keepAlive: true, idleTimeoutMillis: 0, statement_timeout: 180000,
    connectionTimeoutMillis: 20000 });
  local.on('error', (e) => console.log(`\n  [local pool] ${e.message} (recovering)`));
  prod.on('error', (e) => console.log(`\n  [prod pool] ${e.message} (recovering)`));

  console.log(`mode: ${APPLY ? 'APPLY (writing to prod)' : 'SHADOW (no writes)'}`);
  console.log(`source ${SOURCE} | limit ${LIMIT_COMPANIES || 'all'} | concurrency ${CONCURRENCY} | insert_batch ${INSERT_BATCH} | max_age ${MAX_AGE_H || 'unlimited'}h\n`);

  // Prod's (ats, lower(slug)) -> id map, loaded ONCE.
  //
  // This was a per-employer `WHERE ats=$1 AND lower(ats_slug)=lower($2)`. lower() defeats the
  // index on ats_slug, so each lookup sequentially scanned 116k companies — fine at 12,376
  // employers, fatal at 55,747: five concurrent scans against a database the fleet is already
  // writing to timed out 53,519 of them (96%). One 116k-row fetch costs a couple of seconds and
  // turns every lookup into a hash hit.
  const prodCompanyIndex = new Map();
  {
    const t0 = Date.now();
    const { rows } = await prod.query(
      'SELECT id, ats, lower(ats_slug) AS s FROM companies WHERE ats_slug IS NOT NULL ORDER BY id');
    for (const r of rows) {
      const k = `${r.ats}|${r.s}`;
      if (!prodCompanyIndex.has(k)) prodCompanyIndex.set(k, r.id);  // lowest id wins
    }
    console.log(`  prod company index: ${n(prodCompanyIndex.size)} pairs in ${Date.now() - t0}ms`);
  }

  let done = new Set();
  try { done = new Set(JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8'))); } catch { /* first run */ }
  if (done.size) console.log(`resuming: ${n(done.size)} companies already done`);


  // Reads simplify_employer_map, built once by a regex pass over the corpus. Deriving the
  // employer inline cost 63s per run over 1.7M rows and dropped the pg connection mid-query;
  // the map makes it an indexed lookup. Rebuild it as enrichment adds rows.
  // ── SOURCE=simplify ────────────────────────────────────────────────────────────────────
  // The imported corpus hangs off placeholder companies (ats='simplify', local-only ids) that
  // production has never heard of, which is the sole reason none of its 1.7M jobs have ever
  // reached prod. Their real employer is in the ENRICHED url — greenhouse.io/{slug}/jobs/{id},
  // {tenant}.wd5.myworkdayjobs.com/... — so group by that instead of by company_id.
  //
  // The Workday tenant is only obtainable this way. tracked_obj carries the career-SITE slug
  // (workday:Draper_Careers/...) while the redirect gives draper.wd5.myworkdayjobs.com, and it
  // is the tenant that identifies the employer.
  const SIMPLIFY_SQL = `
    SELECT min(m.job_id) AS local_id, array_agg(m.job_id) AS job_ids,
           m.ats, min(m.slug) AS ats_slug, count(*) AS job_count
      FROM simplify_employer_map m
      JOIN jobs j ON j.id = m.job_id
     WHERE j.removed_at IS NULL
       AND ($1 = 0 OR j.last_seen_at > now() - ($1 || ' hours')::interval)
     GROUP BY m.ats, lower(m.slug)
     ORDER BY count(*) DESC
     ${LIMIT_COMPANIES ? `LIMIT ${LIMIT_COMPANIES}` : ''}`;

  // Candidates are grouped by (ats, lower(slug)) — the EMPLOYER — not by local company row.
  //
  // The staging database holds 15,587 duplicate (ats, slug) pairs: greenhouse/svetness exists
  // as two company rows (129391 and 1087403), each carrying the same postings, so that employer
  // shows 9,962 job rows for 4,981 distinct URLs. Iterating company rows would process the same
  // employer twice and double-count everything it offers. Grouping collapses them, and
  // local_ids carries every row so no job is missed.
  const cands = SOURCE === 'simplify'
    ? (await local.query(SIMPLIFY_SQL, [MAX_AGE_H])).rows
    : (await local.query(`
    SELECT min(c.id) AS local_id,
           array_agg(DISTINCT c.id) AS local_ids,
           min(c.company_name) AS company_name,
           c.ats, min(c.ats_slug) AS ats_slug,
           min(c.career_url) AS career_url, min(c.domain) AS domain,
           count(j.id) AS job_count
      FROM companies c JOIN jobs j ON j.company_id = c.id
     WHERE c.ats IS NOT NULL AND c.ats <> 'simplify' AND c.ats_slug IS NOT NULL
       AND j.removed_at IS NULL
       AND j.url NOT LIKE 'https://simplify.jobs/%'
       AND ($1 = 0 OR j.last_seen_at > now() - ($1 || ' hours')::interval)
     GROUP BY c.ats, lower(c.ats_slug)
     ORDER BY count(j.id) DESC
     ${LIMIT_COMPANIES ? `LIMIT ${LIMIT_COMPANIES}` : ''}`, [MAX_AGE_H])).rows;
  const work = cands.filter((c) => !done.has(c.local_id));
  console.log(`candidate companies: ${n(work.length)}\n`);

  const stats = { companies: 0, companiesCreated: 0, companiesMatched: 0,
    jobsExamined: 0, jobsAlreadyInProd: 0, jobsInserted: 0, jobsWouldInsert: 0, errors: 0,
    // Tally by message, not just a count. The 2026-09-11 17:00 cycle reported 50,608 errors
    // against 55,609 employers -- 91% -- and printed FIVE of them, because the logger below
    // is capped at `errors <= 5`. A bare count cannot distinguish 'prod is timing out' from
    // 'one bad slug repeated 50,000 times', so the cap made a mass failure unreadable.
    errorTypes: Object.create(null) };
  const samples = [];

  let cursor = 0;
  let aborted = false;
  async function employerWorker() {
   for (;;) {
    if (aborted) return;
    const myIdx = cursor++;
    if (myIdx >= work.length) return;
    const c = work[myIdx];

    // Back off while the index catches up. Checked per employer, not per row, so the cost is
    // one cheap indexed count against idx_jobs_index_dirty.
    if (OUTBOX_MAX > 0) {
      for (let waited = 0; waited < 40; waited++) {
        let pending = 0;
        try {
          const r = await prod.query('SELECT count(*) AS n FROM jobs WHERE index_dirty_at IS NOT NULL');
          pending = Number(r.rows[0].n);
        } catch { break; }
        if (pending <= OUTBOX_MAX) break;
        if (waited === 0) process.stdout.write(`\n  outbox ${n(pending)} > ${n(OUTBOX_MAX)} — pausing for the index to drain\n`);
        await sleep(30000);
      }
    }
    stats.companies++;
    try {
      // 1. Does prod know this company?
      let prodCompanyId = prodCompanyIndex.get(`${c.ats}|${String(c.ats_slug).toLowerCase()}`) || null;

      if (!prodCompanyId) {
        if (APPLY) {
          const ins = await prod.query(
            `INSERT INTO companies (company_name, ats, ats_slug, career_url, domain, status, origin, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,'active','local_promote',NOW(),NOW())
             ON CONFLICT (career_url) DO UPDATE SET updated_at = NOW()
             RETURNING id`,
            [c.company_name || c.ats_slug, c.ats, c.ats_slug,
             c.career_url || canonicalUrl(c.ats, c.ats_slug),
             c.domain || (() => { try { return new URL(canonicalUrl(c.ats, c.ats_slug)).host; } catch { return 'unknown'; } })()]);
          prodCompanyId = ins.rows[0].id;
          prodCompanyIndex.set(`${c.ats}|${String(c.ats_slug).toLowerCase()}`, prodCompanyId);
        }
        stats.companiesCreated++;
        if (samples.length < 8) samples.push(`NEW COMPANY  ${c.ats.padEnd(16)} ${c.ats_slug}`);
      } else {
        stats.companiesMatched++;
      }
      if (!prodCompanyId) { await sleep(SLEEP_MS); continue; } // shadow, company would be new

      // 2. What does prod already hold for it? Indexed by company_id, so this is cheap.
      const { rows: existing } = await prod.query(
        'SELECT url FROM jobs WHERE company_id = $1', [prodCompanyId]);
      const have = new Set(existing.map((r) => urlKey(r.url)).filter(Boolean));

      // 3. Local jobs for this company that prod does not have, by URL.
      // = ANY(local_ids): every company row for this employer, so a duplicated row cannot
      // hide postings the other one lacks. DISTINCT ON the URL path collapses the copies the
      // duplication created (svetness: 9,962 rows -> 4,981 real postings).
      const { rows: mine } = await local.query(
        SOURCE === 'simplify'
        ? `SELECT DISTINCT ON (regexp_replace(split_part(split_part(url,'?',1),'#',1),'/+$',''))
                  ${COLS.filter((x) => x !== 'company_id').join(', ')}
             FROM jobs WHERE id = ANY($1::bigint[])
            ORDER BY regexp_replace(split_part(split_part(url,'?',1),'#',1),'/+$',''), last_seen_at DESC NULLS LAST`
        : `SELECT DISTINCT ON (regexp_replace(split_part(split_part(url,'?',1),'#',1),'/+$',''))
                ${COLS.filter((x) => x !== 'company_id').join(', ')}
           FROM jobs WHERE company_id = ANY($1::bigint[]) AND removed_at IS NULL
            AND url NOT LIKE 'https://simplify.jobs/%'
            AND ($2 = 0 OR last_seen_at > now() - ($2 || ' hours')::interval)
          ORDER BY regexp_replace(split_part(split_part(url,'?',1),'#',1),'/+$',''), last_seen_at DESC NULLS LAST`,
        SOURCE === 'simplify' ? [c.job_ids] : [c.local_ids, MAX_AGE_H]);
      stats.jobsExamined += mine.length;

      const missing = [];
      for (const j of mine) {
        const k = urlKey(j.url);
        if (!k || have.has(k)) { stats.jobsAlreadyInProd++; continue; }
        have.add(k);                       // guard against dupes within this batch too
        missing.push(j);
      }

      if (missing.length) {
        stats.jobsWouldInsert += missing.length;
        if (samples.length < 8) samples.push(`${String(missing.length).padStart(5)} new jobs  ${c.ats}/${c.ats_slug}`);
        if (APPLY) {
          for (let i = 0; i < missing.length; i += INSERT_BATCH) {
            const chunk = missing.slice(i, i + INSERT_BATCH);
            const params = []; const tuples = [];
            chunk.forEach((j, k2) => {
              const base = k2 * COLS.length;
              for (const col of COLS) params.push(col === 'company_id' ? prodCompanyId : j[col]);
              tuples.push('(' + COLS.map((_, x) => `$${base + x + 1}`).join(',') + ')');
            });
            const res = await prod.query(
              `INSERT INTO jobs (${COLS.join(',')}) VALUES ${tuples.join(',')}
               ON CONFLICT (external_id, company_id) DO NOTHING`, params);
            stats.jobsInserted += res.rowCount;
          }
        }
      }
      done.add(c.local_id);
    } catch (e) {
      stats.errors++;
      const ekey = String(e.message).replace(/"[^"]*"/g, '"..."').slice(0, 90);
      stats.errorTypes[ekey] = (stats.errorTypes[ekey] || 0) + 1;
      if (stats.errors <= 5) console.log(`\n  error on ${c.ats}/${c.ats_slug}: ${e.message}`);
      // Circuit breaker. Once a run is failing this consistently it does not recover, and
      // grinding through the rest converts one fault into an hour of silence that still exits
      // rc=0 -- precisely what the 2026-09-11 17:00 cycle did: inserts stopped at employer
      // 5,020 of 55,609, every one of the remaining 50,589 failed, and the wrapper logged
      // success. Stop loudly and leave the checkpoint intact so the next run resumes.
      if (!aborted && stats.errors >= 500 && stats.errors > stats.companies * 0.5) {
        aborted = true;
        console.log(`\n\nABORTING: ${n(stats.errors)} errors across ${n(stats.companies)} employers `
          + `(${Math.round(100 * stats.errors / Math.max(1, stats.companies))}%). `
          + 'Something is broken -- not grinding through the rest.');
      }
    }

    if (stats.companies % 10 === 0) {
      process.stdout.write(`\r  employers ${n(stats.companies)}/${n(work.length)} | new co ${n(stats.companiesCreated)} | jobs ${n(APPLY ? stats.jobsInserted : stats.jobsWouldInsert)} | dup skipped ${n(stats.jobsAlreadyInProd)} | err ${n(stats.errors)}   `);
      if (APPLY) fs.writeFileSync(CHECKPOINT, JSON.stringify([...done]));
    }
    if (SLEEP_MS) await sleep(SLEEP_MS);
   }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, employerWorker));
  if (APPLY) fs.writeFileSync(CHECKPOINT, JSON.stringify([...done]));

  console.log('\n');
  if (samples.length) { console.log('sample:'); for (const s of samples) console.log('  ' + s); console.log(''); }
  console.log('result:');
  console.log(`  companies examined      : ${n(stats.companies)}`);
  console.log(`  companies already in prod: ${n(stats.companiesMatched)}`);
  console.log(`  companies ${APPLY ? 'CREATED' : 'to create'}      : ${n(stats.companiesCreated)}`);
  console.log(`  jobs examined           : ${n(stats.jobsExamined)}`);
  console.log(`  jobs already in prod    : ${n(stats.jobsAlreadyInProd)}  <- deduped by URL`);
  console.log(`  jobs ${APPLY ? 'INSERTED' : 'to insert'}          : ${n(APPLY ? stats.jobsInserted : stats.jobsWouldInsert)}`);
  console.log(`  errors                  : ${n(stats.errors)}`);
  {
    const types = Object.entries(stats.errorTypes).sort((x, y) => y[1] - x[1]);
    for (const [msg, count] of types.slice(0, 8)) {
      console.log(`    ${String(n(count)).padStart(9)}  ${msg}`);
    }
    if (types.length > 8) console.log(`    ${String(types.length - 8).padStart(9)}  (more distinct messages)`);
  }
  if (!APPLY) console.log('\nSHADOW — nothing written. Re-run with APPLY=1.');
  if (aborted) {
    console.log('\nrun ABORTED by the error circuit breaker — exiting non-zero so cron is not told this succeeded.');
    await local.end(); await prod.end();
    process.exit(2);
  }

  await local.end(); await prod.end();
})().catch((e) => { console.error('\nFATAL', e.message); process.exit(1); });
