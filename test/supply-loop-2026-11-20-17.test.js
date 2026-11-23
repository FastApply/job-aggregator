'use strict';
/**
 * Supply loop 2026-11-20 17h: a CareerPlug crawl reads the text of a board's first 400 postings
 * only, so on a big franchise board the rest kept their list row and no description, and
 * FastApply refused them as "Industry cannot be checked: the posting has no description" (14 of
 * 16 such refusals in the window, Orangetheory's "Sales Manager" among them). The description
 * backfill now fills CareerPlug rows, one posting page each, through the adapter's own queue.
 */
process.env.CAREERPLUG_GAP_MS = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const careerplug = require('../src/adapters/careerplug');
const backfill = require('../src/tasks/backfill-descriptions');

const fixture = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
const html = (body, status = 200, headers = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
const URL_ = 'https://orangetheory-fitness-careers.careerplug.com/jobs/3113528/apps/new';

test('careerplug is on the description backfill, one posting at a time', () => {
  // ownLoop since supply loop 2026-11-23 00h: CareerPlug drains in its own loop (careerplug-desc-own-loop.test.js).
  assert.deepEqual(backfill.ATS_CONFIG.careerplug, { batchSize: 30, concurrency: 1, ownLoop: true });
});

test('careerplug: the backfill reads the posting JSON-LD text, as the crawl does', async (t) => {
  const seen = [];
  t.mock.method(global, 'fetch', async (url) => { seen.push(String(url)); return html(fixture('careerplug-job.html')); });
  const d = await backfill.fetchDescription({ ats: 'careerplug', url: URL_, external_id: 'careerplug_3113528', raw_data: {} });
  assert.deepEqual(seen, [URL_]);
  assert.equal(d, careerplug.toJob({ id: '1', title: 'x', location: null }, 'x', careerplug.parsePosting(fixture('careerplug-job.html'))).description);
  assert.match(d, /That's a big reason/);
});

test('careerplug: a "Future Opening" posting gives the page body; the /jobs/{id} link is read as its posting', async (t) => {
  const seen = [];
  t.mock.method(global, 'fetch', async (url) => { seen.push(String(url)); return html(fixture('careerplug-job-future-opening.html')); });
  const d = await careerplug.fetchDescription('https://floor-coverings-international-careers.careerplug.com/jobs/3537696');
  assert.deepEqual(seen, ['https://floor-coverings-international-careers.careerplug.com/jobs/3537696/apps/new']);
  assert.match(d, /as a Warehouse Help!/);
});

test('careerplug: a gone posting is SKIP (404, 410, a redirect off it); a passing fault throws to retry', async (t) => {
  for (const [status, headers] of [[404, {}], [410, {}], [302, { location: 'https://app.careerplug.com/' }]]) {
    t.mock.method(global, 'fetch', async () => html('', status, headers));
    assert.equal(await careerplug.fetchDescription(URL_), 'SKIP', `status ${status}`);
    t.mock.restoreAll();
  }
  t.mock.method(global, 'fetch', async () => html('', 403));
  await assert.rejects(careerplug.fetchDescription(URL_), /HTTP 403 \(retry\)/);
  t.mock.restoreAll();
  t.mock.method(global, 'fetch', async () => html('<html><body><p>Apply now</p></body></html>'));
  assert.equal(await careerplug.fetchDescription(URL_), 'SKIP');
});

test('careerplug: a link that is not a posting on an employer board is SKIP, with no request', async (t) => {
  const calls = t.mock.method(global, 'fetch', async () => { throw new Error('no request expected'); });
  for (const u of [null, '', 'https://app.careerplug.com/jobs/1', 'https://kre-security.careerplug.com/jobs', 'https://example.com/jobs/1']) {
    assert.equal(await careerplug.fetchDescription(u), 'SKIP', String(u));
  }
  assert.equal(calls.mock.callCount(), 0);
});
