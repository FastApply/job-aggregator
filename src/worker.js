const logger = require('./logger');
const { migrate, closeDb } = require('./db');
const metrics = require('./utils/metrics');
const { createRedisConnection } = require('./queues/connection');
const { createSyncQueue, createSyncWorker } = require('./queues/sync.queue');
const { registerSchedules, fanoutSync } = require('./queues/scheduler');
const { backfillDescriptions } = require('./tasks/backfill-descriptions');
const { backfillClassifications } = require('./tasks/backfill-classifications');
const { crawlWorkableMarketplace } = require('./tasks/crawl-workable-marketplace');
const { pruneDeadJobs } = require('./tasks/dead-job-check');

async function main() {
  await migrate();
  metrics.setRedis(createRedisConnection());

  const syncQueue = createSyncQueue();
  const syncWorker = createSyncWorker();

  syncWorker.on('completed', async (job) => {
    if (job.data.fanout) await fanoutSync(syncQueue);
  });

  // Clean stale jobs to free Redis memory
  await Promise.allSettled([
    syncQueue.drain().catch(() => {}),
    syncQueue.clean(0, 1000, 'completed'),
    syncQueue.clean(0, 1000, 'failed'),
  ]);
  logger.info('Cleaned stale queue jobs to free Redis memory');

  await registerSchedules(syncQueue);

  // Stagger sync fanout to avoid boot-time spike
  setTimeout(() => fanoutSync(syncQueue).catch(e => logger.error({ err: e.message }, 'Sync fanout error')), 30000);

  logger.info('Worker started — processing sync queue only (no discovery/crawl)');

  // Description backfill — re-enabled after fixing the four broken fetchers
  // (zoho parser, lever multi-field, smartrecruiters/workday SKIP-on-empty).
  // The 450-job backlog of unfetchable rows was cleared and marked N/A locally,
  // so the loop now only processes genuinely-new missing-description rows.
  let allBackfillRunning = false;
  async function runAllBackfill() {
    if (allBackfillRunning) { logger.warn('Description backfill still running, skipping'); return; }
    allBackfillRunning = true;
    try {
      const filled = await backfillDescriptions();
      logger.info({ filled }, 'Description backfill cycle complete');
    } catch (err) {
      logger.error({ err: err.message }, 'Description backfill error');
    } finally {
      allBackfillRunning = false;
    }
    setTimeout(runAllBackfill, 5 * 60 * 1000);
  }
  setTimeout(runAllBackfill, 5 * 60 * 1000);

  // Backfill classifications (visa, remote, experience) every 5 minutes
  async function runClassificationBackfill() {
    try {
      await backfillClassifications();
    } catch (err) {
      logger.error({ err: err.message }, 'Classification backfill error');
    }
    setTimeout(runClassificationBackfill, 60 * 1000);
  }
  setTimeout(runClassificationBackfill, 2 * 60 * 1000);

  // Clean up stale jobs older than 90 days — runs every 6 hours. (Dead postings
  // younger than this are pruned by liveness checks in runDeadJobPruning below.)
  // Rows with posted_at IS NULL used to be exempt forever (the WHERE clause only
  // matched non-null dates), which let jobs from adapters that don't parse a posted
  // date (iCIMS, Rippling, Pinpoint, JazzHR, ...) accumulate indefinitely. Those now
  // age out on first_seen_at instead, keeping the same 90-day policy consistent
  // across dated and undated rows.
  async function runStaleJobCleanup() {
    try {
      const { query } = require('./db/connection');
      const { rows } = await query(`
        DELETE FROM jobs
        WHERE (posted_at IS NOT NULL AND posted_at < NOW() - INTERVAL '90 days')
           OR (posted_at IS NULL AND first_seen_at < NOW() - INTERVAL '90 days')
        RETURNING id
      `);
      if (rows.length > 0) {
        logger.info({ deleted: rows.length }, 'Stale job cleanup: removed jobs older than 90 days');
        // Hard DELETEs leave no row for the outbox trigger to mark, so the index would keep
        // serving jobs that no longer exist. Fire and forget — a failed removal is corrected
        // by the next full reconcile, and must never fail the cleanup itself.
        require('./tasks/meili-sync').removeFromIndex(rows.map((r) => r.id)).catch(() => {});
      }
    } catch (err) {
      logger.error({ err: err.message }, 'Stale job cleanup error');
    }
    setTimeout(runStaleJobCleanup, 6 * 60 * 60 * 1000);
  }
  setTimeout(runStaleJobCleanup, 5 * 60 * 1000);

  // Search canary — src/tasks/search-canary.js. Asks the deployed public API for two-role
  // queries and alerts to Telegram if either role is missing from the page. Every 6 hours,
  // first run 3 minutes after boot. Cheap (6 requests) and the only thing that has ever
  // caught the "multi-role search silently becomes role #1" bug in under a day.
  async function runSearchCanaryLoop() {
    try {
      await require('./tasks/search-canary').runSearchCanary();
    } catch (err) {
      logger.error({ err: err.message }, 'search canary error');
    }
    setTimeout(runSearchCanaryLoop, 6 * 60 * 60 * 1000);
  }
  setTimeout(runSearchCanaryLoop, 3 * 60 * 1000);

  // Ship changed jobs into the search index. Driven by the index_dirty_at outbox column, so it
  // sees writes from every source including the laptop scripts. No-ops entirely when MEILI_HOST
  // is unset, so this is safe to ship before the index exists.
  // Apply index settings on boot, before the first sync runs.
  //
  // ensureIndex() was previously called only by scripts/meili-init.js, which has to be run by
  // hand from inside Render because the index is a private service unreachable from a laptop.
  // That made a settings change — adding a filterable attribute, say — a manual step somebody
  // has to remember, and a filter shipped without it fails at query time as an unknown
  // attribute. The service that owns the index should apply its own settings.
  //
  // Both calls are upserts and cheap when nothing changed, so re-running on every restart is
  // harmless (this worker restarts 13-18 times a day under memory pressure). Failure is logged
  // and swallowed: an unreachable index must never stop the worker from syncing companies.
  try {
    await require('./utils/meili').ensureIndex();
    logger.info('Meili index settings applied');
  } catch (err) {
    logger.error({ err: err.message }, 'Meili ensureIndex failed (continuing without it)');
  }

  let meiliSyncRunning = false;
  async function runMeiliSync() {
    if (meiliSyncRunning) return;
    meiliSyncRunning = true;
    try {
      await require('./tasks/meili-sync').syncMeili();
    } catch (err) {
      logger.error({ err: err.message }, 'Meili sync error');
    } finally {
      meiliSyncRunning = false;
      setTimeout(runMeiliSync, 60 * 1000);
    }
  }
  setTimeout(runMeiliSync, 90 * 1000);

  // Dead-job pruning: verify a rotating batch of jobs against their career pages
  // and remove confirmed-dead postings. This is now the ONLY removal path (see
  // jobs.js syncForCompany) — as of the guard rewrite the eligible population
  // includes every job missing from its company's latest sync, not just the
  // aging >30d tail, so throughput was bumped (400/hr -> ~1,500/hr) to make a
  // dent in that backlog instead of taking 200+ days for one pass.
  //
  // Partitioned by job id (even here, odd in scripts/prune-dead-jobs-local.js)
  // so this runner and a local process on a separate network/IP can work the
  // backlog in parallel with zero risk of re-checking the same rows — also
  // spreads outbound verification traffic across two IPs instead of hammering
  // thousands of third-party career-page domains from one.
  async function runDeadJobPruning() {
    try {
      const { checked, dead, uncertain } = await pruneDeadJobs({
        limit: 500, concurrency: 10, tailDays: 30, recheckDays: 14,
        partitionMod: 2, partitionRemainder: 0,
      });
      if (checked > 0) {
        logger.info({ checked, dead, uncertain }, 'Dead-job pruning: verified batch (render partition)');
      }
    } catch (err) {
      logger.error({ err: err.message }, 'Dead-job pruning error');
    }
    setTimeout(runDeadJobPruning, 20 * 60 * 1000);
  }
  setTimeout(runDeadJobPruning, 8 * 60 * 1000);

  // Workable marketplace crawl RE-ENABLED (2026-06-30). Pulls jobs.workable.com's
  // public marketplace API (jobs.workable.com/api/v1/jobs) — verified reachable from
  // Heroku (200, paginates), distinct from the apply.workable.com company feeds that
  // 403 under load. Self-contained loop (does NOT use the sync queue), ~10k latest
  // jobs/cycle, 1s/page delay, every 6h — keeps the ~53k /view/ marketplace jobs fresh.
  let workableMarketplaceRunning = false;
  async function runWorkableMarketplace() {
    if (workableMarketplaceRunning) { logger.warn('Workable marketplace crawl still running, skipping'); return; }
    workableMarketplaceRunning = true;
    try {
      const added = await crawlWorkableMarketplace();
      logger.info({ added }, 'Workable marketplace crawl cycle complete');
    } catch (err) {
      logger.error({ err: err.message }, 'Workable marketplace crawl error');
    } finally {
      workableMarketplaceRunning = false;
    }
    setTimeout(runWorkableMarketplace, 6 * 60 * 60 * 1000);
  }
  setTimeout(runWorkableMarketplace, 3 * 60 * 1000);
  logger.info('Workable marketplace crawl enabled (jobs.workable.com marketplace API)');

  async function shutdown(signal) {
    logger.info({ signal }, 'Shutting down worker');
    const forceTimer = setTimeout(() => {
      logger.warn('Forcing exit after 20s shutdown timeout');
      process.exit(1);
    }, 20000);
    forceTimer.unref();
    try {
      await Promise.allSettled([syncWorker.close()]);
      await Promise.allSettled([syncQueue.close()]);
      await closeDb();
    } catch (err) {
      logger.error({ err: err.message }, 'Error during shutdown');
    }
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => {
    logger.error({ err: err?.message }, 'Unhandled rejection in worker');
  });
}

main().catch((err) => {
  logger.fatal({ err: err.message }, 'Worker failed to start');
  process.exit(1);
});
