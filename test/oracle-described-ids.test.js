'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ORACLE_DETAIL_MAX = '2';
const oracle = require('../src/adapters/oracle');

// A fake Oracle tenant: `total` postings, newest first, ids 1000+i.
function fakeFetch(total) {
  const calls = { list: 0, detail: [] };
  const fn = async (url) => {
    if (url.includes('recruitingCEJobRequisitionDetails')) {
      const id = Number(/Id=(\d+)/.exec(url)[1]);
      calls.detail.push(id);
      return { ok: true, json: async () => ({ items: [{ ExternalDescriptionStr: `full text ${id}` }] }) };
    }
    calls.list++;
    const limit = Number(/limit=(\d+)/.exec(url)[1]);
    const offset = Number(/offset=(\d+)/.exec(url)[1]);
    const list = [];
    for (let i = offset; i < Math.min(total, offset + Math.min(limit, 200)); i++) {
      list.push({ Id: 1000 + i, Title: `Job ${i}`, PrimaryLocation: 'Toronto', ShortDescriptionStr: `short ${i}` });
    }
    return { ok: true, json: async () => ({ items: [{ requisitionList: list, TotalJobsCount: total }] }) };
  };
  return { fn, calls };
}

async function withFetch(fake, run) {
  const real = global.fetch;
  global.fetch = fake.fn;
  try { return await run(); } finally { global.fetch = real; }
}

test('the crawler is given a longer budget and asked for stored state', () => {
  assert.equal(oracle.wantsStoredState, true);
  assert.ok(oracle.fetchTimeoutMs >= 10 * 60 * 1000);
  assert.equal(oracle.PAGE_SIZE, 200);
});

test('with describedIds, only undescribed postings get a detail call, newest first, capped', async () => {
  const fake = fakeFetch(5);
  const { jobs } = await withFetch(fake, () =>
    oracle.fetchJobs('emqk.ca3.CX_1001', { describedIds: new Set(['oracle_1000']) }));
  assert.equal(jobs.length, 5);
  assert.deepEqual(fake.calls.detail, [1001, 1002]); // 1000 already described; cap of 2
  const byId = Object.fromEntries(jobs.map((j) => [j.external_id, j.description]));
  assert.equal(byId.oracle_1000, null);              // keeps the stored text (upsert ignores NULL)
  assert.equal(byId.oracle_1001, 'full text 1001');
  assert.equal(byId.oracle_1003, null);              // over the cap: filled on a later sync
});

test('without describedIds every posting is read, as before', async () => {
  const fake = fakeFetch(4);
  const { jobs } = await withFetch(fake, () => oracle.fetchJobs('emqk.ca3.CX_1001'));
  assert.equal(fake.calls.detail.length, 4);
  assert.ok(jobs.every((j) => j.description && j.description.startsWith('full text')));
});

test('lists 200 per request, so a 450-posting site takes 3 list calls', async () => {
  const fake = fakeFetch(450);
  const { jobs } = await withFetch(fake, () =>
    oracle.fetchJobs('emqk.ca3.CX_1001', { describedIds: new Set() }));
  assert.equal(jobs.length, 450);
  assert.equal(fake.calls.list, 3);
});
