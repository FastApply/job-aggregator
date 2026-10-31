'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchJobs, locationOf } = require('../src/adapters/bamboohr');
const { classifyJob } = require('../src/utils/classify');

// swaarm's "Sales Manager (SEA)" as the API serves it, 2026-10-31.
const listing = {
  id: '32',
  jobOpeningName: 'Sales Manager (SEA)',
  departmentLabel: 'Sales',
  employmentStatusLabel: 'Full-Time',
  location: { city: null, state: null },
  atsLocation: { country: 'Malaysia', state: null, province: 'Kuala Lumpur', city: 'Kuala Lumpur' },
  isRemote: null,
  locationType: '1',
};
const detail = {
  location: { city: null, state: null, postalCode: null, addressCountry: null },
  atsLocation: { country: 'Malaysia', countryId: '130', state: 'Kuala Lumpur', city: 'Kuala Lumpur' },
  locationType: '1',
  description: '<p>Fully remote - work from anywhere in Southeast Asia</p>',
};

test('a role with no office takes its place from atsLocation', () => {
  assert.equal(locationOf(detail, listing), 'Kuala Lumpur, Malaysia');
  assert.equal(locationOf(null, listing), 'Kuala Lumpur, Malaysia');
});

test('an office still wins', () => {
  const office = { location: { city: 'Austin', state: 'Texas', addressCountry: 'United States' }, atsLocation: { country: 'Malaysia' } };
  assert.equal(locationOf(office, listing), 'Austin, Texas, United States');
});

test('state or province, whichever the API filled', () => {
  assert.equal(locationOf({ atsLocation: { city: 'Brisbane', province: 'Queensland', country: 'Australia' } }), 'Brisbane, Queensland, Australia');
  assert.equal(locationOf({ atsLocation: { city: null, state: 'Florida', country: 'United States' } }), 'Florida, United States');
});

test('nothing named is null, so the row stays unknown', () => {
  assert.equal(locationOf({ location: {}, atsLocation: { country: null, state: null, city: null } }, {}), null);
  assert.equal(locationOf(null, null), null);
});

test('the crawl stores the place, and the row is no longer open worldwide', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => new Response(JSON.stringify(
    String(url).endsWith('/list') ? { result: [listing] } : { result: { jobOpening: detail } })));
  const { jobs } = await fetchJobs('swaarm');
  assert.equal(jobs[0].location, 'Kuala Lumpur, Malaysia');
  const tags = classifyJob({ ...jobs[0], workplace_type: 'remote', description: detail.description });
  assert.equal(tags.remote_worldwide, false);
});
