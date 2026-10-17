'use strict';
/** The crawler's rolling pool: one slow company must not hold the other slots idle. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { runPool } = require('../src/utils/rolling-pool');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function source(items, per) {
  const left = [...items];
  let claims = 0;
  return { claim: async () => { claims++; return left.splice(0, per); }, claims: () => claims };
}

test('a slow item does not block the other slots (no batch barrier)', async () => {
  // 1 slow item (300ms) + 40 fast ones (10ms), 4 slots, batches of 5. With a barrier the slow item
  // would stall its batch; the rolling pool finishes the 40 fast ones while it runs.
  const src = source(['slow', ...Array.from({ length: 40 }, (_, i) => `f${i}`)], 5);
  const done = [];
  const t0 = Date.now();
  let fastDoneAt = null;
  await runPool({
    concurrency: 4, once: true, claim: src.claim, idle: () => sleep(1),
    work: async (it) => { await sleep(it === 'slow' ? 300 : 10); done.push(it); if (fastDoneAt === null && done.filter((x) => x !== 'slow').length === 40) fastDoneAt = Date.now() - t0; },
  });
  assert.equal(done.length, 41);
  assert.ok(fastDoneAt < 300, `the 40 fast items finished at ${fastDoneAt}ms, behind the slow one`);
});

test('every item is worked exactly once and claims never overlap', async () => {
  let inFlight = 0, maxInFlight = 0;
  const left = Array.from({ length: 23 }, (_, i) => i);
  const seen = [];
  await runPool({
    concurrency: 6, once: true, idle: () => sleep(1),
    claim: async () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await sleep(5); inFlight--; return left.splice(0, 4); },
    work: async (it) => { await sleep(1); seen.push(it); },
  });
  assert.deepEqual(seen.sort((a, b) => a - b), Array.from({ length: 23 }, (_, i) => i));
  assert.equal(maxInFlight, 1, 'two claims ran at once');
});

test('a failed claim is reported and retried', async () => {
  let calls = 0, reported = 0;
  const seen = [];
  await runPool({
    concurrency: 2, once: true, idle: () => sleep(1),
    claim: async () => { calls++; if (calls === 1) throw new Error('db down'); return calls === 2 ? [1, 2] : []; },
    onClaimError: async () => { reported++; },
    work: async (it) => { seen.push(it); },
  });
  assert.equal(reported, 1);
  assert.deepEqual(seen.sort(), [1, 2]);
});
