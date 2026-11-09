'use strict';
/** Jibe /api/jobs pages 10 by default and 100 at most; the adapter read page 1 only (every Jibe board held 10 jobs). */
process.env.ICIMS_JIBE_MAX_JOBS = '300';
process.env.ICIMS_JIBE_RETRY_MS = '5';
const test = require('node:test');
const assert = require('node:assert/strict');
const icims = require('../src/adapters/icims');

const jobs = (from, n) => Array.from({ length: n }, (_, i) => ({ data: { req_id: `R${from + i}`, title: `Job ${from + i}`, slug: `${from + i}` } }));
function stub(t, total, { failPage, failTimes = 1 } = {}) {
  const calls = [];
  let fails = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = new URL(String(url));
    calls.push(u.host + u.pathname + u.search);
    if (u.host !== 'careers.acme.com') return new Response('nope', { status: 404 });
    const page = Number(u.searchParams.get('page'));
    const limit = Number(u.searchParams.get('limit')) || 10;
    if (page === failPage && fails++ < failTimes) return new Response('err', { status: 503 });
    const from = (page - 1) * limit;
    const n = Math.max(0, Math.min(limit, total - from));
    return new Response(JSON.stringify({ totalCount: total, jobs: jobs(from, n) }), { headers: { 'content-type': 'application/json' } });
  });
  return calls;
}

test('icims jibe: reads every page, 100 at a time', async (t) => {
  const calls = stub(t, 230);
  const r = await icims.fetchJobs('acme');
  assert.equal(r.jobs.length, 230);
  assert.equal(r.meta.capped, false);
  assert.ok(calls.some((c) => c.includes('limit=100&page=3')));
});

test('icims jibe: a small board is one request', async (t) => {
  const calls = stub(t, 7);
  const r = await icims.fetchJobs('acme');
  assert.equal(r.jobs.length, 7);
  assert.equal(calls.filter((c) => c.startsWith('careers.acme.com')).length, 1);
});

test('icims jibe: stops at ICIMS_JIBE_MAX_JOBS and marks the list partial', async (t) => {
  stub(t, 18572);
  const r = await icims.fetchJobs('acme');
  assert.equal(r.jobs.length, 300);
  assert.equal(r.meta.capped, true);
});

test('icims jibe: one failed page is retried', async (t) => {
  stub(t, 230, { failPage: 2, failTimes: 1 });
  const r = await icims.fetchJobs('acme');
  assert.equal(r.jobs.length, 230);
});

test('icims jibe: a page that keeps failing fails the crawl instead of returning a short list', async (t) => {
  stub(t, 230, { failPage: 2, failTimes: 5 });
  await assert.rejects(icims.fetchJobs('acme'), /page 2/);
});

test('icims: a bare host slug is used as the host', async (t) => {
  const calls = stub(t, 3);
  const r = await icims.fetchJobs('careers.acme.com');
  assert.equal(r.jobs.length, 3);
  assert.ok(calls[0].startsWith('careers.acme.com/api/jobs'));
  assert.ok(!calls.some((c) => c.includes('careers.careers')));
});

test('icims jibe: raw_data drops the HTML bodies but description keeps them', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ totalCount: 1, jobs: [{ data: { req_id: 'R1', title: 'T', description: '<p>d</p>', qualifications: '<p>q</p>' } }] }), { headers: { 'content-type': 'application/json' } }));
  const r = await icims.fetchJobs('acme');
  assert.equal(r.jobs[0].description, '<p>d</p>\n<p>q</p>');
  assert.equal(r.jobs[0].raw_data.description, undefined);
  assert.equal(r.jobs[0].raw_data.req_id, 'R1');
});
