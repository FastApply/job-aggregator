'use strict';
/** A stored slug that is already percent-encoded must not be encoded twice (%2520 answers 404). */
const test = require('node:test');
const assert = require('node:assert/strict');
const ashby = require('../src/adapters/ashby');

test('ashby: encoded and plain slugs reach the same board path', () => {
  assert.equal(ashby._boardPath('Superhuman%20Platform%20Inc'), 'Superhuman%20Platform%20Inc');
  assert.equal(ashby._boardPath('Superhuman Platform Inc'), 'Superhuman%20Platform%20Inc');
  assert.equal(ashby._boardPath('careerswift.ai'), 'careerswift.ai');
  assert.equal(ashby._boardPath('100%'), '100%25');            // a bare % is not an escape
});

test('ashby: fetchJobs requests the singly encoded path', async (t) => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => { urls.push(String(url)); return new Response(JSON.stringify({ jobs: [] })); });
  await ashby.fetchJobs('the%20agency%20fund');
  assert.equal(urls[0], 'https://api.ashbyhq.com/posting-api/job-board/the%20agency%20fund?includeCompensation=true');
});
