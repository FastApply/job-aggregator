#!/usr/bin/env node
/**
 * Turn the health metrics into an alert when one leaves its measured band.
 *
 * `log-health.sh` has recorded these numbers hourly for weeks and nothing has
 * ever read them back. That is the gap HANDOVER.md opens with — "most of the
 * ways this system fails are silent" — and it has a cost: on 2026-09-05 a
 * paying user's Apply-for-Me automation sat with no jobs for their criteria,
 * and the first anyone knew was a support chat. The supply was topped up by
 * hand. `src/utils/notify.js` has had a working sendAlert() the whole time,
 * with zero callers.
 *
 * Thresholds are the measured healthy ranges from HANDOVER.md §4, not guesses.
 *
 * Run:  DATABASE_URL=... node scripts/health-alert.js
 *       DATABASE_URL=... DRY=1 node scripts/health-alert.js    # print, never send
 * Cron: 5 * * * * (just after log-health.sh at :00, so it reads a fresh row)
 * Env:  TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID   (absent → logs only, never throws)
 *       ALERT_REPEAT_HOURS(6)   (dedup state lives in the alert_state table)
 *
 * Always exits 0. A monitor that dies on a bad night removes the very signal
 * you need to understand the bad night.
 */
const { query, closeDb } = require('../src/db/connection');
const { sendAlert } = require('../src/utils/notify');
const logger = require('../src/logger');

const DRY = process.env.DRY === '1';
// Re-alerting every hour on a condition that takes days to fix trains people to
// ignore the channel. One alert, then silence until it clears or this elapses.
const REPEAT_HOURS = parseInt(process.env.ALERT_REPEAT_HOURS || '6', 10);

/**
 * Each check returns { id, level, title, message } when unhealthy, else null.
 * `id` is the dedup key, so wording can change without re-alerting.
 */
async function collectChecks() {
  const one = async (sql, params = []) => (await query(sql, params)).rows[0];
  const out = [];

  // Every check runs independently. Inline awaits meant the FIRST query to fail
  // took the whole pass with it: the live-count below is cancelled by the pool's
  // 15s statement_timeout on every run (measured against prod — 5.2M rows, 42GB),
  // so collectChecks() threw before reaching the outbox and demand checks, the
  // worker's catch logged it, and the alerter was permanently silent. Silent is
  // indistinguishable from healthy, which is the exact failure this file exists
  // to catch. A check that cannot answer must cost only itself.
  const safe = async (label, fn) => {
    try { return await fn(); } catch (e) {
      logger.warn({ check: label, err: e.message }, 'health-alert: check failed, skipping');
      return null;
    }
  };

  // ── Ingestion is alive ────────────────────────────────────────────────
  // Measured healthy: 3,000–12,000 retired/hour. "Low hundreds" is the
  // signature of the fleet not running — usually the laptop slept.
  const retiredRow = await safe('ingestion', () =>
    one(`SELECT count(*) AS n FROM jobs WHERE removed_at > NOW() - INTERVAL '1 hour'`));
  const retired = retiredRow == null ? null : Number(retiredRow.n);
  if (retired != null && retired < 500) {
    out.push({
      id: 'ingestion-stalled',
      level: 'error',
      title: 'Ingestion looks stopped',
      message: `Only ${retired} jobs retired in the last hour (healthy: 3,000-12,000). `
        + 'The crawler fleet runs on the laptop — check it is awake and that '
        + 'launch-local-crawlers.sh is running (expect 11 crawlers, 2 pruners).',
    });
  }

  // ── The corpus itself ─────────────────────────────────────────────────
  // SAMPLED, not counted. An exact `count(*) WHERE removed_at IS NULL` cannot
  // finish inside the pool's 15s statement_timeout on this table and is
  // cancelled every time; a 0.5% sample answers in about a second, which is far
  // more precision than a threshold comparison needs.
  //
  // The threshold is 2M, NOT the 4M this first carried. That 4M came from
  // reading /health's `total_active_jobs` as a live count — it is actually
  // pg_class.reltuples, i.e. EVERY row including the ~2.4M soft-removed ones.
  // Live has been ~2.7-2.8M for weeks, so a 4M floor fires on the first run and
  // every REPEAT_HOURS after, forever. An alert that is always on is not an
  // alert. 2M sits below normal churn and still catches a real collapse.
  const liveRow = await safe('corpus', () => one(`
    SELECT round((count(*) FILTER (WHERE removed_at IS NULL)) * 100.0
                 / NULLIF(count(*), 0), 2) AS pct_live,
           (SELECT reltuples::bigint FROM pg_class WHERE relname = 'jobs') AS est_total
      FROM jobs TABLESAMPLE SYSTEM (0.5)`));
  const live = (liveRow && liveRow.pct_live != null)
    ? Math.round(Number(liveRow.est_total) * Number(liveRow.pct_live) / 100)
    : null;
  if (live != null && live < 2_000_000) {
    out.push({
      id: 'corpus-shrinking',
      level: 'error',
      title: 'Live job count has fallen',
      message: `~${live.toLocaleString()} live jobs (normal: ~2.7-2.8M). `
        + 'Something is retiring jobs without replacing them.',
    });
  }

  // ── Removals reaching the index ───────────────────────────────────────
  // The outbox swings 0-3k between drains; only sustained growth is a fault.
  // Cheap despite the table size: idx_jobs_index_dirty is partial on
  // index_dirty_at IS NOT NULL, so this only ever touches the pending rows.
  const outboxRow = await safe('outbox', () =>
    one('SELECT count(*) AS n FROM jobs WHERE index_dirty_at IS NOT NULL'));
  const outbox = outboxRow == null ? null : Number(outboxRow.n);
  if (outbox != null && outbox > 50_000) {
    out.push({
      id: 'outbox-backed-up',
      level: 'warning',
      title: 'Search index is falling behind',
      message: `${outbox.toLocaleString()} rows waiting to reach Meili (normal: 0-3,000). `
        + 'Users are seeing jobs that are already gone. Check the Render worker.',
    });
  }

  // ── Unmet demand: the case this script was written for ────────────────
  // A demand row is a real search someone ran. One that is due for a crawl and
  // has been waiting days is a user whose automation has nothing to apply to.
  let starved = null;
  try {
    starved = await one(
      `SELECT count(*) AS n,
              min(COALESCE(last_crawled_at, first_seen_at)) AS oldest
         FROM search_demand
        WHERE COALESCE(last_result_count, 0) <= 10
          AND query_text IS NOT NULL AND query_text <> ''
          AND (last_crawled_at IS NULL OR last_crawled_at < NOW() - INTERVAL '72 hours')`,
    );
  } catch (err) {
    // The table is created by schema.js; a missing one is not worth an alert.
    logger.debug({ err: err.message }, 'search_demand unavailable');
  }
  if (starved && Number(starved.n) > 0) {
    const n = Number(starved.n);
    const waitedH = starved.oldest
      ? Math.floor((Date.now() - new Date(starved.oldest).getTime()) / 3_600_000)
      : null;
    // demand-crawl drains 25 per 20 minutes, so a backlog this size means the
    // loop is not running at all rather than merely behind.
    if (n > 200 || (waitedH != null && waitedH > 168)) {
      out.push({
        id: 'demand-starved',
        level: 'warning',
        title: 'Searches with no jobs are not being crawled',
        message: `${n} unmet searches are overdue`
          + (waitedH != null ? `, the oldest waiting ${Math.floor(waitedH / 24)} days` : '')
          + '. These are users whose automations have nothing to apply to. '
          + 'Check demand-crawl on the Render worker.',
      });
    }
  }

  return out;
}

/* ── Dedup state ──────────────────────────────────────────────────────────
   In Postgres, not on disk. The Render worker restarts 13-18 times a day under
   memory pressure, so a state file there is empty on almost every run — every
   restart would re-alert on the same open condition, which is precisely how a
   channel becomes noise people mute. The DB is the one thing both the laptop
   cron and the Render worker share. */
async function ensureStateTable() {
  await query(`CREATE TABLE IF NOT EXISTS alert_state (
    alert_id   TEXT PRIMARY KEY,
    last_sent_at TIMESTAMP NOT NULL
  )`);
}

async function readState() {
  const { rows } = await query('SELECT alert_id, last_sent_at FROM alert_state');
  return Object.fromEntries(
    rows.map((r) => [r.alert_id, new Date(r.last_sent_at).getTime()]),
  );
}

async function markSent(id) {
  await query(
    `INSERT INTO alert_state (alert_id, last_sent_at) VALUES (?, NOW())
       ON CONFLICT (alert_id) DO UPDATE SET last_sent_at = NOW()`,
    [id],
  );
}

async function clearSent(id) {
  await query('DELETE FROM alert_state WHERE alert_id = ?', [id]);
}

/**
 * One pass: collect, alert on what is newly unhealthy, report what recovered.
 * Exported so the Render worker can call it hourly without spawning a process
 * — that box is a 512MB instance that already OOMs 13-18 times a day.
 */
async function runHealthAlert() {
  await ensureStateTable();
  const checks = await collectChecks();
  const state = await readState();
  const now = Date.now();
  const firing = new Set(checks.map((c) => c.id));
  let sent = 0;

  for (const check of checks) {
    const last = state[check.id];
    const due = !last || now - last > REPEAT_HOURS * 3_600_000;
    if (!due) continue;
    if (DRY) {
      process.stdout.write(`WOULD ALERT [${check.level}] ${check.title}: ${check.message}\n`);
    } else {
      await sendAlert(check.title, check.message, check.level);
      await markSent(check.id);
    }
    sent += 1;
  }

  // Say when something recovers, or a channel that only ever reports bad news
  // leaves you guessing whether it is fixed.
  let recovered = 0;
  for (const id of Object.keys(state)) {
    if (firing.has(id)) continue;
    if (!DRY) {
      await sendAlert('Recovered', `${id} is back within its normal range.`, 'info');
      await clearSent(id);
    }
    recovered += 1;
  }

  logger.info({ checks: checks.length, sent, recovered, dry: DRY }, 'health-alert complete');
  return { checks: checks.length, sent, recovered };
}

// Only run when executed directly, so requiring this from the worker does not
// fire a pass and close the shared pool underneath it.
if (require.main === module) {
  runHealthAlert()
    .then(async () => { await closeDb(); process.exit(0); })
    // Never exit non-zero: cron mailing a stack trace is not monitoring.
    .catch(async (err) => {
      logger.error({ err: err.message }, 'health-alert failed');
      try { await closeDb(); } catch { /* already closed */ }
      process.exit(0);
    });
}

module.exports = { runHealthAlert, collectChecks };
