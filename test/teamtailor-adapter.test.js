'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const tt = require('../src/adapters/teamtailor');

const rss = (n) => `<rss><channel>${Array.from({ length: n }, (_, i) => `<item><title>Job ${i}</title><guid>g${i}</guid><link>https://careers.shine.co/jobs/${i}-job</link><tt:city>Berlin</tt:city><tt:country>Germany</tt:country><remoteStatus>hybrid</remoteStatus></item>`).join('')}</channel></rss>`;

test('a teamtailor.com tenant reads its subdomain feed', () => {
  assert.equal(tt.feedUrl('suessa'), 'https://suessa.teamtailor.com/jobs.rss');
});

test('a custom careers domain reads the feed on that domain', () => {
  assert.equal(tt.feedUrl('careers.shine.co'), 'https://careers.shine.co/jobs.rss');
  assert.equal(tt.feedUrl('https://Jobs.Verda.com/'), 'https://jobs.verda.com/jobs.rss');
});

test('a feed at its 100-job cap is marked capped so absence removal skips it', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(rss(100)));
  const r = await tt.fetchJobs('careers.shine.co');
  assert.equal(r.jobs.length, 100);
  assert.equal(r.meta.capped, true);
});

test('a feed under the cap is complete', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => { calls.push(String(url)); return new Response(rss(73)); });
  const r = await tt.fetchJobs('careers.shine.co');
  assert.equal(calls[0], 'https://careers.shine.co/jobs.rss');
  assert.equal(r.meta.capped, false);
  assert.equal(r.jobs[0].workplace_type, 'hybrid');
});
