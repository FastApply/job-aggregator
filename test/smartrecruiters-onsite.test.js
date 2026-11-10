'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sr = require('../src/adapters/smartrecruiters');
const { classifyJob } = require('../src/utils/classify');

// The list item SmartRecruiters returns for a Domino's store job (2026-11-10): on-site in its own setting.
const DOMINOS = {
  id: '744000137232455',
  name: 'Customer Service Rep(5112) - 2020 Sadler Rd, Fernandina Beach, FL',
  location: { city: 'Fernandina Beach', region: 'FL', country: 'us', remote: false, hybrid: false, fullLocation: 'Fernandina Beach, FL, United States' },
  typeOfEmployment: { label: 'Full-time' },
  releasedDate: '2026-07-11T01:09:56.270Z',
};

test("SmartRecruiters' remote false and hybrid false is on-site, not unknown", () => {
  assert.equal(sr.srWorkplaceType(DOMINOS.location), 'onsite');
  assert.equal(sr.srWorkplaceType({ remote: true, hybrid: false }), 'remote');
  assert.equal(sr.srWorkplaceType({ remote: false, hybrid: true }), 'hybrid');
  // Fields left out stay unknown, so the text may still decide.
  assert.equal(sr.srWorkplaceType({ city: 'Austin' }), null);
  assert.equal(sr.srWorkplaceType(undefined), null);
});

test('the crawl stores the on-site row as not remote, whatever its text says', async (t) => {
  const detail = { postingUrl: 'https://jobs.smartrecruiters.com/Dominos/744000137232455-customer-service-rep', jobAd: { sections: { a: { text: 'Customer service in our store. Work from home is not offered. Remote ordering support.' } } } };
  t.mock.method(globalThis, 'fetch', async (url) => {
    const u = String(url);
    if (u.includes('/postings?')) return new Response(JSON.stringify({ content: u.includes('offset=0') ? [DOMINOS] : [] }));
    return new Response(JSON.stringify(detail));
  });
  const r = await sr.fetchJobs('Dominos');
  assert.equal(r.jobs.length, 1);
  assert.equal(r.jobs[0].workplace_type, 'onsite');
  assert.equal(classifyJob(r.jobs[0]).is_remote, false);
});
