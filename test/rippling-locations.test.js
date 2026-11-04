'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { groupListings, toJob } = require('../src/adapters/rippling');

// Rippling's own "Account Executive, Enterprise, Global" as its list API serves it, 2026-11-04:
// four rows, one uuid.
const uuid = '6fc734dd-1878-40be-aedb-376562313db6';
const row = (label) => ({
  uuid,
  name: 'Account Executive, Enterprise, Global ',
  department: { id: 'Sales', label: 'Sales' },
  url: `https://ats.rippling.com/rippling/jobs/${uuid}`,
  workLocation: { label, id: label },
});
const listings = [row('Austin, TX'), row('New York, NY'), row('Remote (United States)'), row('San Francisco, CA')];
const detail = {
  uuid,
  workLocations: ['Austin, TX', 'San Francisco, CA', 'New York, NY', 'Remote (United States)'],
  employmentType: { label: 'SALARIED_FT', id: 'Salaried, full-time' },
  createdOn: '2026-10-07T11:35:32.937000-07:00',
  description: { role: '<p>Sell Rippling.</p>' },
};

test('one job per posting, every place kept', () => {
  const grouped = groupListings(listings);
  assert.equal(grouped.length, 1);
  assert.deepEqual(grouped[0].places, ['Austin, TX', 'New York, NY', 'Remote (United States)', 'San Francisco, CA']);
});

test('remote when any place is, with the type and the date the detail states', () => {
  const [{ job, places }] = groupListings(listings);
  const out = toJob('rippling', job, places, detail);
  assert.equal(out.external_id, `rippling_${uuid}`);
  assert.equal(out.location, 'Austin, TX; San Francisco, CA; New York, NY; Remote (United States)');
  assert.equal(out.workplace_type, 'remote');
  assert.equal(out.employment_type, 'Salaried, full-time');
  assert.equal(out.posted_at, '2026-10-07T18:35:32.937Z');
});

test('an office-only posting is not remote; a failed detail keeps the list rows', () => {
  const office = groupListings([row('Boston, MA')]);
  const out = toJob('rippling', office[0].job, office[0].places, null);
  assert.equal(out.location, 'Boston, MA');
  assert.equal(out.workplace_type, null);
  assert.equal(out.employment_type, null);
  assert.equal(out.posted_at, null);
});

test('a posting with no place keeps the old defaults', () => {
  const none = groupListings([{ uuid: 'x', name: 'Engineer', workLocation: null }]);
  const out = toJob('acme', none[0].job, none[0].places, null);
  assert.equal(out.location, 'Remote');
  assert.equal(out.workplace_type, null);
});
