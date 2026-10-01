'use strict';
/**
 * A Workday crawl that collected fewer postings than the site lists must say so (meta.capped), or
 * the absence counter reads every unreached job as closed and retires it after three syncs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const wd = require('../src/adapters/workday');

function stubWorkday(t, { total, pages }) {
  let call = 0;
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (String(url).endsWith('/jobs') && opts && opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      if (body.appliedFacets && Object.keys(body.appliedFacets).length) return new Response(JSON.stringify({ jobPostings: [] }));
      const n = body.offset === 0 ? Math.min(20, pages) : (body.offset / 20 < Math.ceil(pages / 20) ? 20 : 0);
      call++;
      return new Response(JSON.stringify({ total, facets: [], jobPostings: Array.from({ length: n }, (_, i) => ({ title: 't', externalPath: `/job/${body.offset + i}`, bulletFields: [`R${body.offset + i}`] })) }));
    }
    return new Response(JSON.stringify({ jobPostingInfo: { jobDescription: 'x' } }));
  });
}

test('a site that lists more than the crawl collected is marked partial', async (t) => {
  stubWorkday(t, { total: 18895, pages: 40 });
  const r = await wd.fetchJobs('acme', { careerUrl: 'https://acme.wd1.myworkdayjobs.com/en-US/Ext' });
  assert.equal(r.meta.capped, true);
});

test('a site whose listing was collected in full is not', async (t) => {
  stubWorkday(t, { total: 40, pages: 40 });
  const r = await wd.fetchJobs('acme', { careerUrl: 'https://acme.wd1.myworkdayjobs.com/en-US/Ext' });
  assert.equal(r.meta.capped, false);
  assert.equal(r.jobs.length, 40);
});
