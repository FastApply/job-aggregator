'use strict';
/** Workable's v3 list is paged 10 at a time (nextPage token sent back as { token }). */
process.env.WORKABLE_MIN_GAP_MS = '20';
process.env.WORKABLE_MAX_PAGES = '5';
process.env.WORKABLE_MAX_BLOCK_WAIT_MS = '150';
process.env.WORKABLE_BLOCK_WAIT_MS = '80';
const test = require('node:test');
const assert = require('node:assert/strict');
const workable = require('../src/adapters/workable');
const { fetchListings } = workable;
test.beforeEach(() => workable._reset());
const fs = require('fs');
const path = require('path');
// the crawler's own rule, read from the script (it runs on require)
const crawler = fs.readFileSync(path.join(__dirname, '../scripts/crawl-companies-local.js'), 'utf8');
const rule = new RegExp(crawler.match(/const isPermanentError = \(msg\) => \/(.+)\/i\.test/)[1], 'i');
const isPermanentError = (msg) => rule.test(msg);

const page = (codes, nextPage) => ({ ok: true, status: 200, json: async () => ({ total: 25, results: codes.map((shortcode) => ({ shortcode })), nextPage }) });
const codes = (from, n) => Array.from({ length: n }, (_, i) => `J${from + i}`);

test('workable: follows nextPage until the last page and sends the token back', async () => {
  const bodies = [];
  const pages = [page(codes(0, 10), 'T1'), page(codes(10, 10), 'T2'), page(codes(20, 5), undefined)];
  const r = await fetchListings('acme', async (_url, opts) => { bodies.push(opts.body); return pages.shift(); });
  assert.equal(r.listings.length, 25);
  assert.equal(r.capped, false);
  assert.deepEqual(bodies, ['{}', '{"token":"T1"}', '{"token":"T2"}']);
});

test('workable: a repeated job across pages is kept once', async () => {
  const pages = [page(codes(0, 10), 'T1'), page(codes(9, 3), undefined)];
  const r = await fetchListings('acme', async () => pages.shift());
  assert.equal(r.listings.length, 12);
});

test('workable: stops at the page ceiling and says the list is capped', async () => {
  let n = 0;
  const r = await fetchListings('acme', async () => page(codes(n++ * 10, 10), `T${n}`));
  assert.equal(r.listings.length, 50);
  assert.equal(r.capped, true);
});

test('workable: a block (403/429) mid-list fails the whole crawl as a retry, not a dead board', async () => {
  for (const status of [403, 429]) {
    const pages = [page(codes(0, 10), 'T1'), { ok: false, status, headers: new Headers() }];
    await assert.rejects(fetchListings('acme', async () => pages.shift()), (e) => {
      assert.match(e.message, /rate limited/);
      assert.equal(isPermanentError(e.message), false);
      return true;
    });
  }
});

test('workable: a 404 account is still a dead board', async () => {
  await assert.rejects(fetchListings('gone', async () => ({ ok: false, status: 404 })), (e) => isPermanentError(e.message));
});

test('workable: requests are spaced by the minimum gap', async () => {
  const at = [];
  const pages = [page(codes(0, 10), 'T1'), page(codes(10, 10), 'T2'), page(codes(20, 5), undefined)];
  await fetchListings('acme', async () => { at.push(Date.now()); return pages.shift(); });
  for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 18, `gap ${at[i] - at[i - 1]} ms`);
});

test('workable: a block holds every later request until Retry-After, capped', async () => {
  // Retry-After: 1 s, capped to the 150 ms test ceiling
  await assert.rejects(fetchListings('acme', async () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '1' }) })));
  const t0 = Date.now();
  await workable.waitUntilReady();
  const waited = Date.now() - t0;
  assert.ok(waited >= 130 && waited < 400, `waited ${waited} ms`);
  let sentAt = 0;
  await fetchListings('acme', async () => { sentAt = Date.now(); return page(codes(0, 3), undefined); });
  assert.ok(sentAt >= t0 + 130);
});

test('workable: a 403 without Retry-After waits the default', async () => {
  await assert.rejects(fetchListings('acme', async () => ({ ok: false, status: 403, headers: new Headers() })), /pausing/);
  const t0 = Date.now();
  await workable.waitUntilReady();
  assert.ok(Date.now() - t0 >= 60);
});

test('workable: fetchJobs makes only the list requests (no per-crawl widget call)', async () => {
  const urls = [];
  const real = global.fetch;
  global.fetch = async (url) => { urls.push(String(url)); return page(codes(0, 2), undefined); };
  try { const r = await workable.fetchJobs('acme'); assert.equal(r.jobs.length, 2); assert.equal(r.meta.capped, false); }
  finally { global.fetch = real; }
  assert.deepEqual(urls, ['https://apply.workable.com/api/v3/accounts/acme/jobs']);
});

test('workable: the crawler waits out a block before timing the fetch, with the adapter\'s own timeout', () => {
  assert.match(crawler, /if \(adapter\.waitUntilReady\) await adapter\.waitUntilReady\(\);\s*\n\s*const result = await withTimeout\(adapter\.fetchJobs\([^;]*adapter\.fetchTimeoutMs \|\| FETCH_TIMEOUT/);
  assert.ok(workable.fetchTimeoutMs > 60000);
});
