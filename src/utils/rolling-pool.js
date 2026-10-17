/**
 * Run `work` over items claimed in batches, CONCURRENCY at a time, as a rolling pool: a slot that
 * finishes takes the next item at once, and the queue is topped up with one fresh `claim()` (never
 * two in flight) whenever it runs dry.
 *
 * The crawler used to claim a batch and wait for ALL of it before claiming again, so one large
 * tenant held every other slot idle (a 5,000-job Workday tenant takes ~20 min): the worker's 20
 * Workday slots ran at an effective 2-3 and a full Workday pass took ~35h (2026-10-17).
 *
 * claim()   -> Promise<item[]>; an empty array means nothing is due right now.
 * work(it)  -> Promise; its errors are the caller's to handle inside `work`.
 * idle()    -> Promise, awaited by a slot that found nothing due (continuous mode only).
 * once      -> stop each slot when nothing is due instead of idling (drain mode).
 */
async function runPool({ concurrency, claim, work, idle, once = false, onClaimError }) {
  const queue = [];
  let refill = null;

  async function next() {
    for (;;) {
      if (queue.length) return queue.shift();
      if (!refill) {
        // A failed claim is handled once, inside the shared refill, so slots waiting on it do not
        // each report it (and each sleep) — they just try again afterwards.
        refill = Promise.resolve()
          .then(claim)
          .then(
            (rows) => { queue.push(...rows); return rows.length; },
            async (e) => { if (onClaimError) await onClaimError(e); return -1; },
          )
          .finally(() => { refill = null; });
      }
      const claimed = await refill;
      if (claimed === -1) continue;
      if (!claimed && !queue.length) return null;
    }
  }

  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      const item = await next();
      if (item == null) {
        if (once) return;
        await idle();
        continue;
      }
      await work(item);
    }
  }));
}

module.exports = { runPool };
