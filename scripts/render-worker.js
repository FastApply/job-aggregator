#!/usr/bin/env node
/**
 * Render background-worker entrypoint — the always-on replacement for the Heroku worker
 * ($50 Standard-2X  ->  $7 Render Starter). NO Redis / BullMQ.
 *
 * It covers exactly the gap the local Mac fleet does NOT: the four "sync-only" platforms
 * (workday, icims, oracle, successfactors), plus the worker's maintenance loops. The Macs
 * still crawl the other 9 platforms + the workable marketplace, so between this box and the
 * Macs, everything the Heroku worker did is covered — and the worker can be scaled to 0.
 *
 *   crawl    — forks scripts/crawl-companies-local.js (ATS=the 4), the SAME claim-and-crawl
 *              (FOR UPDATE SKIP LOCKED) loop the Macs use; auto-restarts if it exits.
 *   maintain — description + classification backfill, dead-job pruning, 90-day stale cleanup
 *              (copied verbatim from src/worker.js).
 *
 * Render config:  Build `npm ci`  ·  Start `node scripts/render-worker.js`  ·  env DATABASE_URL
 * Tune for the 512MB/low-CPU Starter via env: CRAWL_ATS, CONCURRENCY, BATCH, PG_POOL_MAX.
 */
// Keep demand-crawl's per-cycle memory small on the 512MB box (it shares the parent process
// with the maintenance loops). MUST be set before requiring demand-crawl, which reads these
// at module load. Smaller page/batch => fewer job objects in flight => no parent-heap OOM.
process.env.DEMAND_BATCH = process.env.DEMAND_BATCH || '12';
process.env.DEMAND_PAGE_SIZE = process.env.DEMAND_PAGE_SIZE || '40';
process.env.DEMAND_MAX_TITLES = process.env.DEMAND_MAX_TITLES || '2';
process.env.DEMAND_MAX_LOCATIONS = process.env.DEMAND_MAX_LOCATIONS || '2';
const { fork } = require('child_process');
const path = require('path');
const logger = require('../src/logger');
const { backfillForAts, ATS_CONFIG } = require('../src/tasks/backfill-descriptions');
const { backfillClassifications } = require('../src/tasks/backfill-classifications');
const { pruneDeadJobs } = require('../src/tasks/dead-job-check');
const { cycle: runDemandCycle, ensureColumns: ensureDemandColumns } = require('../src/tasks/demand-crawl');
const { runHealthAlert } = require('./health-alert');
const { query, closeDb } = require('../src/db/connection');

const CRAWL_ATS = process.env.CRAWL_ATS || 'workday,icims,oracle,successfactors';

// --- crawl loop: fork the tested local crawler for the 4 sync-only platforms ---
let child = null;
let shuttingDown = false;
function startCrawler() {
  if (shuttingDown) return;
  child = fork(path.join(__dirname, 'crawl-companies-local.js'), [], {
    // Cap the child heap below the ~258MB Node auto-picks on the 512MB Starter so a runaway
    // tenant fails with a clean V8 error + restart rather than a container SIGKILL. The REAL
    // fix is low concurrency/batch: the OOM was 4-way concurrency crawling 500-600-posting
    // Workday tenants (each posting carries full description HTML) — several 10MB job arrays
    // in flight at once. CONCURRENCY 2 + BATCH 8 keeps at most ~2 tenants' jobs resident and
    // GCs between companies. Override via Render env if you later move to a bigger instance.
    execArgv: ['--max-old-space-size=224'],
    env: {
      ...process.env,
      ATS: CRAWL_ATS,
      CONCURRENCY: process.env.CONCURRENCY || '2',
      BATCH: process.env.BATCH || '8',
      PG_POOL_MAX: process.env.PG_POOL_MAX || '2',
      DELAY_MS: process.env.DELAY_MS || '300',
      PROXY_DISABLED: '1', // all four crawl direct; never route through the metered proxy
    },
  });
  child.on('exit', (code, sig) => {
    child = null;
    if (shuttingDown) return;
    logger.warn({ code, sig }, 'crawler child exited — restarting in 5s');
    setTimeout(startCrawler, 5000);
  });
}

// --- maintenance loops (verbatim cadences from src/worker.js) ---
let descRunning = false;
async function runDescBackfill() {
  if (!descRunning) {
    descRunning = true;
    try {
      // Sequential per-platform (NOT the all-parallel backfillDescriptions) so the parent
      // process's memory stays bounded on the 512MB Starter: one platform's batch of HTML
      // descriptions in flight at a time, not ~15 platforms' worth at once. Batch/concurrency
      // capped for the same reason. Slower per cycle, but it loops every 5m and re-drains.
      let filled = 0;
      for (const [ats, cfg] of Object.entries(ATS_CONFIG)) {
        try {
          const r = await backfillForAts(ats, Math.min(cfg.batchSize, 40), Math.min(cfg.concurrency, 3));
          filled += r.filled;
        } catch (e) { logger.warn({ ats, err: e.message }, 'desc backfill (ats) error'); }
      }
      logger.info({ filled }, 'desc backfill cycle complete');
    } catch (e) { logger.error({ err: e.message }, 'desc backfill error'); }
    finally { descRunning = false; }
  }
  setTimeout(runDescBackfill, 5 * 60 * 1000);
}
async function runClassify() {
  try { await backfillClassifications(); } catch (e) { logger.error({ err: e.message }, 'classification backfill error'); }
  setTimeout(runClassify, 60 * 1000);
}
async function runStaleCleanup() {
  // This was one unbounded `DELETE FROM jobs WHERE posted_at < NOW() - 90 days RETURNING id`.
  // On a 28GB table with 26 indexes that is an enormous single write, and it timed out every
  // run — which was the lucky outcome, because succeeding would have starved the API for as
  // long as it held. Deleting in bounded chunks keeps each statement short and leaves gaps for
  // user queries, and the loop still clears the same backlog, just across several passes.
  let total = 0;
  try {
    for (let i = 0; i < 20; i++) { // ceiling of 100k per cycle; the rest waits for the next one
      const { rows } = await query(
        `DELETE FROM jobs WHERE id IN (
           SELECT id FROM jobs
            WHERE posted_at IS NOT NULL AND posted_at < NOW() - INTERVAL '90 days'
            LIMIT 5000
         ) RETURNING id`
      );
      if (!rows.length) break;
      total += rows.length;
      // Hard DELETEs leave no row for the outbox trigger to mark, so without this the index
      // would keep serving jobs that no longer exist. Fire and forget — never fail the cleanup.
      require('../src/tasks/meili-sync').removeFromIndex(rows.map((r) => r.id)).catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
    }
    if (total) logger.info({ deleted: total }, 'stale job cleanup');
  } catch (e) { logger.error({ err: e.message, deleted: total }, 'stale job cleanup error'); }
  setTimeout(runStaleCleanup, 6 * 60 * 60 * 1000);
}
async function runDeadPrune() {
  // 400/hr against a ~2.7M eligible population is one full pass every 281 days, against a
  // recheckDays of 14 — measured 2026-08-06: 92% of live jobs had never been checked once, and
  // the batches that did run came back 28% dead. That backlog is dead postings served as live.
  //
  // The candidate SELECT is a sequential scan (cost ~694k, no usable index — `id % N` is not
  // sargable and the OR spans jobs and companies), and that cost is paid once per call whatever
  // the limit. So take more per call rather than calling more often: 3000 every 20 minutes is
  // ~9000/hr and a full pass in ~12 days, for roughly the same number of scans per hour.
  //
  // concurrency stays at 10 ON PURPOSE. checkUrl buffers each response twice (res.text() then
  // .toLowerCase()), so peak memory scales with concurrency, not with limit — the batch array
  // itself is only ~600KB at 3000 rows. This runs in the parent process, which shares the
  // 512MB Starter with the 224MB-capped crawler child; raising concurrency is what would put
  // that child's headroom at risk.
  //
  // Batches cannot overlap: the next timer is scheduled after the await, so a slow batch simply
  // delays the following one.
  // 5000 is now affordable: dropping the ORDER BY from the candidate query (see
  // dead-job-check.js) took it from a full scan-and-sort of the eligible population to a scan
  // that stops at LIMIT — 20,000 rows in 33s where 1,000 previously blew past 60s. At ~8s for
  // this batch there is ample headroom under the worker's ceiling.
  //
  // 5000 every 20 minutes is ~15,000/hr, versus the 400/hr that could not keep up with a 2.7M
  // backlog. Concurrency stays at 10: checkUrl buffers each body twice and this shares 512MB
  // with the 224MB-capped crawler child.
  //
  // partitionMod/Remainder set explicitly. This ran unpartitioned, harmless only because the
  // local runner was down — that runner claims the ODD ids, so an unpartitioned Render would
  // re-verify everything it checks, doubling outbound traffic to third-party career pages.
  try { const r = await pruneDeadJobs({ limit: 5000, concurrency: 10, tailDays: 30, recheckDays: 14, partitionMod: 2, partitionRemainder: 0 }); if (r.checked) logger.info(r, 'dead-job pruning'); }
  catch (e) { logger.error({ err: e.message }, 'dead-job pruning error'); }
  setTimeout(runDeadPrune, 20 * 60 * 1000);
}
// Demand-driven crawl (Phase 2): moved off the Mac to the cloud so home-network outages don't
// pause it. Runs IN this parent process (not a fork) — it's I/O-bound + low-memory (one API
// page at a time), cheaper than a second Node runtime on the 512MB box. Sources activate by
// env: LiftMyCV + jobhose need no key; Wonsulting needs WONSULTING_COOKIE; googledork a paid
// SERPER_API_KEY. A single crawl guard prevents overlap.
let demandRunning = false;
// Ship changed jobs into the search index. Driven by the index_dirty_at outbox column, so it
// picks up writes from every source — this worker, the local crawler fleet, and the one-off
// scripts. No-ops entirely when MEILI_HOST is unset.
let meiliSyncRunning = false;
async function runMeiliSync() {
  if (meiliSyncRunning) return;
  meiliSyncRunning = true;
  try {
    const { syncMeili } = require('../src/tasks/meili-sync');
    await syncMeili();
  } catch (e) {
    logger.error({ err: e.message }, 'meili sync');
  } finally {
    meiliSyncRunning = false;
    setTimeout(runMeiliSync, 60 * 1000);
  }
}

async function runDemandCrawl() {
  if (!demandRunning) {
    demandRunning = true;
    try { await runDemandCycle(); } catch (e) { logger.error({ err: e.message }, 'demand-crawl cycle error'); }
    finally { demandRunning = false; }
  }
  setTimeout(runDemandCrawl, 20 * 60 * 1000);
}

// Health alerting lives here rather than only in laptop cron, because the
// single most alert-worthy condition is the laptop being asleep — a monitor
// that sleeps with it cannot report it. A handful of COUNT queries an hour.
let healthRunning = false;
async function runHealthCheck() {
  if (!healthRunning) {
    healthRunning = true;
    try { await runHealthAlert(); }
    catch (e) { logger.error({ err: e.message }, 'health-alert error'); }
    finally { healthRunning = false; }
  }
  setTimeout(runHealthCheck, 60 * 60 * 1000);
}

function shutdown(sig) {
  shuttingDown = true;
  logger.info({ sig }, 'render-worker shutting down');
  if (child) child.kill('SIGTERM');
  const force = setTimeout(() => process.exit(0), 12000);
  force.unref();
  closeDb().finally(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err: err?.message }, 'unhandledRejection in render-worker'));

logger.info({ crawlAts: CRAWL_ATS }, 'render-worker starting — crawl 4 sync-only platforms + maintenance + demand-crawl (no Redis)');
startCrawler();
setTimeout(runDescBackfill, 5 * 60 * 1000);
setTimeout(runClassify, 2 * 60 * 1000);
setTimeout(runStaleCleanup, 5 * 60 * 1000);
setTimeout(runDeadPrune, 8 * 60 * 1000);
setTimeout(runMeiliSync, 90 * 1000);
// demand-crawl: ensure its columns exist, then start the loop a bit after boot.
ensureDemandColumns().catch((e) => logger.warn({ err: e.message }, 'demand ensureColumns')).finally(() => setTimeout(runDemandCrawl, 6 * 60 * 1000));
// Late enough that a boot storm after an OOM restart does not run it repeatedly.
setTimeout(runHealthCheck, 12 * 60 * 1000);
