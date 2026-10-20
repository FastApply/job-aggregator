'use strict';
/** Workable's v3 list is paged 10 at a time (nextPage token sent back as { token }). */
process.env.WORKABLE_PAGE_DELAY_MS = '0';
process.env.WORKABLE_BLOCK_PAUSE_MS = '0';
process.env.WORKABLE_MAX_PAGES = '5';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchListings } = require('../src/adapters/workable');
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
    const pages = [page(codes(0, 10), 'T1'), { ok: false, status }];
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
