'use strict';
/**
 * A throttled Workday discovery must never read as "this tenant does not exist". On 2026-09-26/27
 * that confusion retired 1,516 tenants in a day, most of them live. These pin down the three
 * outcomes: found, genuinely absent, and inconclusive.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { discoverConfig, configFromCareerUrl, discoveryMissOutcome, DISCOVERY_MISS_LIMIT } = require('../src/adapters/workday');

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

// Route robots.txt probes by pod number: plan maps wd -> [status, status, ...] per attempt.
function pods(plan, sitemapFor = {}) {
  const calls = {};
  global.fetch = async (url) => {
    const wd = Number(/\.wd(\d+)\./.exec(url)[1]);
    const seq = plan[wd] || [422];
    const i = calls[wd] = (calls[wd] ?? -1) + 1;
    const status = seq[Math.min(i, seq.length - 1)];
    if (status === 'timeout') throw new Error('The operation was aborted due to timeout');
    const body = status === 200 ? `User-agent: *\nSitemap: https://t.wd${wd}.myworkdayjobs.com/${sitemapFor[wd] || 'External'}/siteMap.xml` : '';
    return new Response(body, { status });
  };
  return calls;
}
const fast = { retryDelays: [0, 0] };

test('finds the tenant on the pod whose robots.txt names a site', async () => {
  pods({ 12: [200] }, { 12: 'HalifaxHealth' });
  assert.deepEqual(await discoverConfig('sometenant', fast), { wdNum: 12, siteSlug: 'HalifaxHealth', sites: ['HalifaxHealth'] });
});

test('a 429 that clears on retry still finds the tenant', async () => {
  const calls = pods({ 3: [429, 200] });
  assert.equal((await discoverConfig('sometenant', fast)).wdNum, 3);
  assert.equal(calls[3], 1, 'retried once on the throttled pod');
});

test('every pod answering 422 is a real miss: null', async () => {
  pods({});
  assert.equal(await discoverConfig('sometenant', fast), null);
});

test('a pod that stays throttled makes the result inconclusive, not a miss', async () => {
  pods({ 5: [429, 429, 429] });
  await assert.rejects(discoverConfig('sometenant', fast), /discovery throttled/);
});

test('a timeout is inconclusive too', async () => {
  pods({ 1: ['timeout'] });
  await assert.rejects(discoverConfig('sometenant', fast), /discovery throttled/);
});

test('the inconclusive error is not a discovery miss, so it never counts toward retirement', async () => {
  pods({ 5: [503, 503, 503] });
  const err = await discoverConfig('sometenant', fast).catch((e) => e);
  assert.doesNotMatch(err.message, /could not discover config/);
});

test('career URL with pod and site yields coordinates without probing', () => {
  assert.deepEqual(configFromCareerUrl('halifaxhealth', 'https://halifaxhealth.wd12.myworkdayjobs.com/en-US/HalifaxHealth'),
    { wdNum: 12, siteSlug: 'HalifaxHealth', sites: ['HalifaxHealth'] });
  assert.deepEqual(configFromCareerUrl('acme', 'https://acme.wd5.myworkdayjobs.com/External_Careers?q=1'),
    { wdNum: 5, siteSlug: 'External_Careers', sites: ['External_Careers'] });
});

test('career URL without a pod, for another tenant, or with no site gives nothing', () => {
  assert.equal(configFromCareerUrl('mydpr', 'https://mydpr.myworkdayjobs.com'), null);
  assert.equal(configFromCareerUrl('acme', 'https://other.wd5.myworkdayjobs.com/External'), null);
  assert.equal(configFromCareerUrl('acme', 'https://acme.wd5.myworkdayjobs.com/'), null);
  assert.equal(configFromCareerUrl('acme', null), null);
});

test('discovery misses count up and retire only on the last one', () => {
  let prev = null;
  for (let n = 1; n <= DISCOVERY_MISS_LIMIT; n++) {
    const out = discoveryMissOutcome(prev, 'Workday: could not discover config for acme');
    assert.equal(out.misses, n);
    assert.equal(out.retire, n === DISCOVERY_MISS_LIMIT);
    assert.match(out.message, new RegExp(`\\(miss ${n}/${DISCOVERY_MISS_LIMIT}\\)$`));
    prev = out.message;
  }
});

test('an unrelated earlier error does not count as a previous miss', () => {
  assert.equal(discoveryMissOutcome('Workday HTTP 500', 'Workday: could not discover config for acme').misses, 1);
});
