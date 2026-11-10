'use strict';
/**
 * When a board answers "gone" (HTTP 404, "not found", ...), retire it only once that answer has
 * held for a while — never on the first one.
 *
 * WHY. A failed board is never crawled again. BambooHR returned 404 for most tenants on
 * 2026-10-19..21; every board synced in that window was failed on the spot, 18,610 of them.
 * A reprobe on 2026-11-07 found 13,070 of those live with 85,450 jobs and only 366 really gone.
 * Varbi did the same on 2026-10-07 (340 employers). An outage looks exactly like a dead board
 * for one sync; it does not look like one for a week.
 *
 * So a miss is recorded in error_message — "<error> (missing since <ISO>, miss <n>)" — and the
 * board stays active. It retires only when it has missed at least MIN_MISSES times AND the
 * first miss is GRACE_DAYS old. A successful sync clears the message, which resets the count.
 *
 * Env: BOARD_MISS_GRACE_DAYS (7) · BOARD_MISS_MIN (3) · BOARD_MISS_RETRY_MIN (360, how long a
 * missed board waits before it is tried again, so an outage cannot fill every fanout with retries).
 */
const GRACE_DAYS = Number(process.env.BOARD_MISS_GRACE_DAYS || 7);
const MIN_MISSES = parseInt(process.env.BOARD_MISS_MIN || '3', 10);
const RETRY_MIN = parseInt(process.env.BOARD_MISS_RETRY_MIN || '360', 10);

const MISS_RE = /\(missing since (\d{4}-\d{2}-\d{2}T[\d:.]+Z), miss (\d+)\)$/;

function boardMissOutcome(prevErrorMessage, errMessage, now = new Date(), {
  graceDays = GRACE_DAYS, minMisses = MIN_MISSES,
} = {}) {
  const prev = MISS_RE.exec(prevErrorMessage || '');
  const since = prev && !Number.isNaN(Date.parse(prev[1])) ? new Date(prev[1]) : now;
  const misses = prev ? Number(prev[2]) + 1 : 1;
  const retire = misses >= minMisses && now - since >= graceDays * 86400000;
  const base = String(errMessage || 'unknown error').replace(MISS_RE, '').trim().slice(0, 150);
  return { retire, misses, since, message: `${base} (missing since ${since.toISOString()}, miss ${misses})` };
}

const isBoardMiss = (msg) => MISS_RE.test(msg || '');

module.exports = { boardMissOutcome, isBoardMiss, RETRY_MIN, GRACE_DAYS, MIN_MISSES };
