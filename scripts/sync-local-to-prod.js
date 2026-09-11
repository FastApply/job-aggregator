#!/usr/bin/env node
/**
 * Promote jobs from the LOCAL Postgres staging database to the live Heroku database.
 *
 * SHADOW BY DEFAULT. Nothing is written unless APPLY=1. This follows the house rule that
 * anything touching rows in bulk gets observed before it is armed — on 2026-08-25 a
 * retirement rule that looked plausible would have cleared ~2.5M live jobs, and the only
 * reason it did not was that it was run in shadow first.
 *
 *   node scripts/sync-local-to-prod.js              # shadow: report what WOULD change
 *   LIMIT=5000 node scripts/sync-local-to-prod.js   # bounded trial
 *   APPLY=1 node scripts/sync-local-to-prod.js      # armed
 *
 * Env:
 *   LOCAL_URL   staging DB          (default postgres://codev@localhost:5432/jobs_local)
 *   PROD_URL    live DB             (default: contents of ~/.fastapply-database-url)
 *   APPLY=1     arm writes          (default shadow)
 *   BATCH       rows per round trip (default 500)
 *   LIMIT       stop after N rows examined (0 = all)
 *   SLEEP_MS    pause between batches (default 250)
 *   MAX_AGE_H   only promote jobs seen within N hours (default 24, 0 = no limit)
 *   SYNC_ATS    comma-separated ATS allowlist (default: the clone fleet's own partition)
 *
 * ── THE CENTRAL RULE ────────────────────────────────────────────────────────────────────
 * Promotion means "a crawler on THIS machine confirmed this posting was on the employer's
 * board". It does not mean "a row exists locally". Three guards enforce that, and each one
 * exists because of something measured in this database:
 *
 * 1. SYNC_ATS allowlist — the primary guard.
 *    The staging DB holds jobs from platforms this fleet does not crawl: 4,435 greenhouse,
 *    1,295 workday, plus smartrecruiters/rippling/bamboohr. Those belong to the always-on
 *    Render worker, which crawls them continuously and is therefore authoritative. A job
 *    sitting locally on one of those platforms and MISSING from prod is most likely missing
 *    because it CLOSED — prod's crawler is current on that company and would already hold it
 *    otherwise. Promoting it would push a dead posting onto the live board, which a user
 *    meets as an apply link that 404s. Local may only vouch for what local crawls.
 *
 * 2. MAX_AGE_H — a backstop, not the main defence.
 *    Note it is genuinely weak on its own: the rows inherited from the old SQLite file were
 *    last seen the same morning this ran, so they pass a 24h test comfortably while carrying
 *    no liveness evidence at all (that file held 1,746,973 jobs and exactly 0 removals).
 *    Age tells you when a row was written, not whether anyone verified it.
 *
 * 3. Company must exist in prod.
 *    25,530 staging companies are local-only (id >= 10,000,000) and carry the imported
 *    `simplify` corpus — 1.7M rows holding a URL and no description whatsoever. Inserting
 *    their jobs would violate jobs_company_id_fkey. They are counted and reported rather than
 *    dropped silently, because promoting them is a separate decision that means creating 25k
 *    companies in prod first.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────────────────
 *
 * It never propagates removal. No DELETE, and `removed_at` is never written — not on insert,
 * not on update. Local and prod each run their own absence counters, and a job local believes
 * is closed may simply be one local has not re-synced yet. Retirement on prod stays owned by
 * prod: pruneDeadJobs' HTTP-confirmed 404/410 path and prod's own absent_syncs. Promotion is
 * strictly additive. This is the single property that keeps this script clear of the
 * 2026-08-25 failure class.
 *
 * It never carries the local `id`. The two databases have independent id sequences, so a
 * local id means nothing in prod. Rows match on the natural key (external_id, company_id),
 * a real UNIQUE constraint in both — jobs_external_id_company_id_key.
 *
 * On an existing row it is conservative: it refreshes last_seen_at and fills description only
 * where prod's is empty. It never overwrites a description prod already has. The staging fleet
 * is currently the fresher writer, but fresher is not the same as correct, and a bad overwrite
 * here is invisible until a user reads the posting.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('pg');

const LOCAL_URL = process.env.LOCAL_URL || 'postgres://codev@localhost:5432/jobs_local';
const PROD_URL = process.env.PROD_URL || readProdUrl();
const APPLY = process.env.APPLY === '1';
const BATCH = parseInt(process.env.BATCH || '500', 10);
const LIMIT = parseInt(process.env.LIMIT || '0', 10);
const SLEEP_MS = parseInt(process.env.SLEEP_MS || '250', 10);
const MAX_AGE_H = parseInt(process.env.MAX_AGE_H === undefined ? '24' : process.env.MAX_AGE_H, 10);

// Must stay in step with scripts/launch-clone-localdb.sh. If you add a partition there, add it
// here; if you remove one, remove it here, or this will promote jobs nothing is verifying.
//
// workday/greenhouse/bamboohr/smartrecruiters/rippling joined this list on 2026-08-30, when the
// clone fleet took them over. They were excluded before for one reason only — the clone was not
// crawling them, so local held stale rows it could not vouch for. Now that it does crawl them,
// the guard is satisfied. Note the Render worker may still be crawling them into prod as well;
// that is not a correctness problem here (promotion is additive and matches on the natural key),
// it just means most rows on those platforms will already exist in prod.
const DEFAULT_ATS = 'lever,recruitee,breezy,ashby,jazzhr,teamtailor,jobvite,pinpoint,comeet,'
  + 'paylocity,zoho,personio,workday,greenhouse,bamboohr,smartrecruiters,rippling';
const SYNC_ATS = (process.env.SYNC_ATS || DEFAULT_ATS).split(',').map((s) => s.trim()).filter(Boolean);

// Local-only companies were re-keyed to this offset precisely so they could never collide with
// a real prod company id. It doubles as the "does prod know this company" test.
const LOCAL_ONLY_ID_FLOOR = 10000000;

function readProdUrl() {
  try {
    return fs.readFileSync(path.join(os.homedir(), '.fastapply-database-url'), 'utf8').trim();
  } catch { return ''; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const n = (v) => Number(v).toLocaleString();

// Columns copied on insert. Deliberately excludes: id (prod assigns its own), removed_at and
// absent_syncs (prod owns retirement), and the columns prod's own triggers populate
// (index_dirty_at, last_checked_at, search_vector).
const COLS = [
  'external_id', 'company_id', 'ats', 'title', 'department', 'location',
  'workplace_type', 'employment_type', 'salary_min', 'salary_max', 'salary_currency',
  'salary_interval', 'description', 'url', 'posted_at', 'raw_data', 'first_seen_at',
  'last_seen_at', 'created_at', 'visa_sponsorship', 'experience_level', 'is_remote',
  'remote_worldwide', 'role_category',
];

async function main() {
  if (!PROD_URL) {
    console.error('FATAL: no PROD_URL and ~/.fastapply-database-url is unreadable');
    process.exit(1);
  }

  // Built by a factory because these get REPLACED, not reused, after a connection error.
  //
  // A pg.Client — unlike a Pool — never reconnects. Once its socket errors, every later query
  // throws "Client has encountered a connection error and is not queryable" forever. A retry
  // loop that assumes otherwise spins against a dead object: this script logged 3,822 identical
  // failures on one batch while the checkpoint advanced by 2 ids.
  //
  // rejectUnauthorized:false matches the rest of the codebase — Heroku presents a cert signed by
  // its own CA. statement_timeout bounds any single write so a stall cannot hold a connection
  // while the live API competes for the pool.
  const mkLocal = () => new Client({ connectionString: LOCAL_URL });
  const mkProd = () => new Client({
    connectionString: PROD_URL,
    ssl: { rejectUnauthorized: false },
    statement_timeout: 120000,
  });
  const onErr = (name) => (err) => console.error(`\n  [${name}] connection error: ${err.message}`);

  let local = mkLocal(); local.on('error', onErr('local'));
  let prod = mkProd();   prod.on('error', onErr('prod'));
  await local.connect();
  await prod.connect();

  /**
   * Replace dead clients with fresh, CONNECTED ones.
   *
   * The swap happens only after both connects succeed. Assigning first and connecting after is
   * what hung this script for a day: the connect threw on a DNS blip
   * (getaddrinfo ENOTFOUND ...compute-1.amazonaws.com), leaving `local` and `prod` pointing at
   * brand-new Client objects that had never connected — and an unconnected pg.Client QUEUES a
   * query indefinitely rather than rejecting it. The next batch awaited a connection that would
   * never exist, at 0% CPU, with the supervisor seeing a live process and nothing to restart.
   *
   * Throwing on failure is deliberate: it reaches the bounded retry in the loop, which after ten
   * tries exits to the supervisor with the checkpoint intact.
   */
  const reconnect = async () => {
    const nl = mkLocal(); const np = mkProd();
    nl.on('error', onErr('local')); np.on('error', onErr('prod'));
    await nl.connect();
    await np.connect();
    for (const c of [local, prod]) { try { await c.end(); } catch { /* already gone */ } }
    local = nl; prod = np;
  };

  console.log(`mode: ${APPLY ? 'APPLY (writing to prod)' : 'SHADOW (no writes)'}`);
  console.log(`batch ${BATCH} | limit ${LIMIT || 'all'} | sleep ${SLEEP_MS}ms | max_age ${MAX_AGE_H || 'unlimited'}h`);
  console.log(`ats: ${SYNC_ATS.join(', ')}\n`);

  // Report the whole staging population and why each slice is in or out, before any batch runs.
  const scope = await local.query(`
    SELECT
      count(*) FILTER (WHERE removed_at IS NULL AND company_id <  $1 AND ats = ANY($2)
                         AND ($3 = 0 OR last_seen_at > now() - ($3 || ' hours')::interval))   AS eligible,
      count(*) FILTER (WHERE removed_at IS NULL AND company_id <  $1 AND ats = ANY($2)
                         AND NOT ($3 = 0 OR last_seen_at > now() - ($3 || ' hours')::interval)) AS too_old,
      count(*) FILTER (WHERE removed_at IS NULL AND company_id <  $1 AND NOT (ats = ANY($2)))  AS wrong_ats,
      count(*) FILTER (WHERE removed_at IS NULL AND company_id >= $1)                          AS local_only_company,
      count(*) FILTER (WHERE removed_at IS NOT NULL)                                           AS locally_removed
    FROM jobs`, [LOCAL_ONLY_ID_FLOOR, SYNC_ATS, MAX_AGE_H]);
  const s = scope.rows[0];
  console.log('staging scope:');
  console.log(`  eligible to promote                : ${n(s.eligible)}`);
  console.log(`  held back: ATS not crawled here    : ${n(s.wrong_ats)}`);
  console.log(`  held back: not seen within ${String(MAX_AGE_H).padEnd(3)}h     : ${n(s.too_old)}`);
  console.log(`  held back: company not in prod     : ${n(s.local_only_company)}`);
  console.log(`  held back: retired locally         : ${n(s.locally_removed)}\n`);

  const stats = { examined: 0, insert: 0, fillDesc: 0, refreshSeen: 0, unchanged: 0, noCompany: 0 };
  const samples = [];
  // Resume point. Promotion is idempotent — an insert that already landed becomes a no-op — so a
  // restart is safe, but re-walking tens of thousands of rows at ~770/min is an hour thrown away.
  let consecutiveFailures = 0;
  let lastId = parseInt(process.env.START_ID || '0', 10);
  const CKPT = process.env.CKPT || '/tmp/sync-local-to-prod.pos';
  if (!process.env.START_ID && APPLY && fs.existsSync(CKPT)) {
    const saved = parseInt(fs.readFileSync(CKPT, 'utf8').trim(), 10);
    if (Number.isFinite(saved) && saved > lastId) { lastId = saved; console.log(`resuming from id ${saved}`); }
  }

  for (;;) {
    // Retry the BATCH on a connection failure instead of exiting the process.
    //
    // The prod client's socket drops every ~15 minutes under this workload, and the top-level
    // catch turned each drop into an exit — 27 restarts, most of the run spent reconnecting.
    // node-postgres reconnects on the next query, so the batch only needs replaying. lastId and
    // the counter are rewound first: lastId advances immediately after the local SELECT, so
    // without the rewind a failure in any later step would SKIP that batch entirely — silently
    // losing rows, which is far worse than a slow run.
    const resumeFrom = lastId;
    const examinedAt = stats.examined;
    try {
      if (LIMIT && stats.examined >= LIMIT) break;
      const take = LIMIT ? Math.min(BATCH, LIMIT - stats.examined) : BATCH;

      const { rows } = await local.query(
        `SELECT id, ${COLS.join(', ')}
           FROM jobs
          WHERE id > $1
            AND removed_at IS NULL
            AND company_id < $2
            AND ats = ANY($3)
            AND ($4 = 0 OR last_seen_at > now() - ($4 || ' hours')::interval)
          ORDER BY id
          LIMIT $5`,
        [lastId, LOCAL_ONLY_ID_FLOOR, SYNC_ATS, MAX_AGE_H, take]
      );
      if (!rows.length) break;
      lastId = rows[rows.length - 1].id;
      if (APPLY) fs.writeFileSync(CKPT, String(lastId));
      stats.examined += rows.length;

      // One round trip per batch, not per row: ask prod which natural keys it already holds.
      const { rows: existing } = await prod.query(
        `SELECT external_id, company_id, (coalesce(description,'') = '') AS desc_empty, last_seen_at
           FROM jobs
          WHERE company_id = ANY($1::bigint[]) AND external_id = ANY($2::text[])`,
        [[...new Set(rows.map((r) => r.company_id))], rows.map((r) => r.external_id)]
      );
      const have = new Map(existing.map((e) => [`${e.company_id} ${e.external_id}`, e]));

      // A company can sit below the local-only floor and still be absent from prod, if it was
      // deleted there after the import. Verify rather than assume.
      const { rows: known } = await prod.query(
        'SELECT id FROM companies WHERE id = ANY($1::bigint[])',
        [[...new Set(rows.map((r) => r.company_id))]]
      );
      const knownCompany = new Set(known.map((c) => String(c.id)));

      const toInsert = [];
      const toUpdate = [];
      for (const r of rows) {
        if (!knownCompany.has(String(r.company_id))) { stats.noCompany++; continue; }
        const hit = have.get(`${r.company_id} ${r.external_id}`);
        if (!hit) {
          stats.insert++;
          toInsert.push(r);
          if (samples.length < 6) samples.push(`INSERT  ${r.ats}/${r.external_id}  "${(r.title || '').slice(0, 55)}"`);
          continue;
        }
        const fillsDesc = hit.desc_empty && (r.description || '') !== '';
        const refreshes = r.last_seen_at && (!hit.last_seen_at || r.last_seen_at > hit.last_seen_at);
        if (fillsDesc) stats.fillDesc++;
        if (refreshes) stats.refreshSeen++;
        if (fillsDesc || refreshes) {
          toUpdate.push({ r, fillsDesc });
          if (samples.length < 6) samples.push(`UPDATE  ${r.ats}/${r.external_id}  ${fillsDesc ? '+description ' : ''}${refreshes ? '+last_seen' : ''}`);
        } else {
          stats.unchanged++;
        }
      }

      if (APPLY && toInsert.length) await insertBatch(prod, toInsert);
      if (APPLY && toUpdate.length) await updateBatch(prod, toUpdate);

      process.stdout.write(
        `\rexamined ${n(stats.examined)} | insert ${n(stats.insert)} | ` +
        `+desc ${n(stats.fillDesc)} | +seen ${n(stats.refreshSeen)} | unchanged ${n(stats.unchanged)}   `
      );
      if (SLEEP_MS) await sleep(SLEEP_MS);
      consecutiveFailures = 0;
    } catch (err) {
      lastId = resumeFrom;
      stats.examined = examinedAt;
      consecutiveFailures++;
      // Bounded. If reconnecting does not clear it after this many tries the fault is not
      // transient, and exiting hands the problem to the supervisor with the checkpoint intact —
      // which is strictly better than looping on it in silence.
      if (consecutiveFailures > 10) {
        throw new Error(`batch at id > ${resumeFrom} failed ${consecutiveFailures}x: ${err.message}`);
      }
      console.error(`\n  batch at id > ${resumeFrom} failed (${err.message}) — reconnecting, attempt ${consecutiveFailures}`);
      try {
        await reconnect();
      } catch (e) {
        // Swallowing this was the other half of the hang: a failed reconnect left the clients
        // unusable and the loop carried on regardless. Back off and let the bound above decide.
        console.error(`  reconnect failed: ${e.message}`);
        await sleep(10000);
        continue;
      }
      await sleep(5000);
      continue;
    }
  }

  console.log('\n');
  if (samples.length) {
    console.log(`sample of what this would ${APPLY ? 'do' : 'have done'}:`);
    for (const line of samples) console.log('  ' + line);
    console.log('');
  }
  console.log('result:');
  console.log(`  examined                 : ${n(stats.examined)}`);
  console.log(`  ${APPLY ? 'inserted' : 'would insert'}             : ${n(stats.insert)}`);
  console.log(`  ${APPLY ? 'filled description' : 'would fill description'}   : ${n(stats.fillDesc)}`);
  console.log(`  ${APPLY ? 'refreshed last_seen' : 'would refresh last_seen'}  : ${n(stats.refreshSeen)}`);
  console.log(`  already current          : ${n(stats.unchanged)}`);
  console.log(`  skipped, company absent  : ${n(stats.noCompany)}`);
  if (!APPLY) console.log('\nSHADOW — nothing was written. Re-run with APPLY=1 to arm.');

  await local.end();
  await prod.end();
}

async function insertBatch(prod, rows) {
  const params = [];
  const tuples = rows.map((r, i) => {
    const base = i * COLS.length;
    params.push(...COLS.map((c) => r[c]));
    return '(' + COLS.map((_, k) => `$${base + k + 1}`).join(',') + ')';
  });
  // DO NOTHING, not DO UPDATE: a conflict means prod gained the row between our read and this
  // write, so prod's copy is the newer one. Updates are handled below, where the guards live.
  await prod.query(
    `INSERT INTO jobs (${COLS.join(',')}) VALUES ${tuples.join(',')}
     ON CONFLICT (external_id, company_id) DO NOTHING`,
    params
  );
}

async function updateBatch(prod, items) {
  // Only rows that actually change reach here — a small fraction of any batch. The description
  // guard is repeated in SQL rather than trusted from the earlier read, so a concurrent writer
  // that fills it in between cannot be clobbered.
  for (const { r, fillsDesc } of items) {
    await prod.query(
      `UPDATE jobs
          SET last_seen_at = GREATEST(last_seen_at, $3::timestamptz),
              description  = CASE WHEN $4 AND coalesce(description,'') = '' THEN $5 ELSE description END
        WHERE external_id = $1 AND company_id = $2`,
      [r.external_id, r.company_id, r.last_seen_at, fillsDesc, r.description]
    );
  }
}

main().catch((err) => { console.error('\nFATAL', err.message); process.exit(1); });
