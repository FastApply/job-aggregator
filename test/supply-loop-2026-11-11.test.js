'use strict';
// Supply loop 2026-11-11: bare places that named no country (Workday, Ashby), Workday's own work
// model, and "Remote Position: No" read as remote (Celestica, SuccessFactors).
const test = require('node:test');
const assert = require('node:assert/strict');
const { withCountry } = require('../src/utils/place-country');
const { countriesFromLocation } = require('../src/utils/location-countries');
const { placeOf, workModelOf } = require('../src/adapters/workday');
const { extractWorkplaceType, extractWorkplaceTypeFromDescription } = require('../src/utils/extract');
const { classifyJob } = require('../src/utils/classify');
const { retag } = require('../scripts/backfill-remote-flag');

test('a bare place gets the ATS country and is then in that country search', () => {
  for (const [loc, country, want, code] of [
    ['PARIS', { code: 'FR', name: 'France' }, 'PARIS, France', 'fr'],
    ['Berlin Office', { name: 'Germany' }, 'Berlin Office, Germany', 'de'],
    ['Madrid Office', { name: 'Spain' }, 'Madrid Office, Spain', 'es'],
    ['Copenhagen', { code: 'DK' }, 'Copenhagen, Denmark', 'dk'],
    ['München', { name: 'Germany' }, 'München, Germany', 'de'],
    ['Sydney CBD Area', { code: 'AU' }, 'Sydney CBD Area, Australia', 'au'],
    // The employer's own field settles a namesake: this Berlin is in the US.
    ['Berlin', { name: 'United States of America' }, 'Berlin, United States', 'us'],
  ]) {
    assert.deepEqual(countriesFromLocation(loc), [], `${loc} names no country before`);
    assert.equal(withCountry(loc, country), want);
    assert.deepEqual(countriesFromLocation(want), [code]);
  }
});

test('a place that already names a country, several places, or remote is left as it is', () => {
  assert.equal(withCountry('Toronto, ON', { name: 'Canada' }), 'Toronto, ON');
  assert.equal(withCountry('London, OH', { name: 'United States of America' }), 'London, OH');
  assert.equal(withCountry('Paris / London', { name: 'France' }), 'Paris / London');
  assert.equal(withCountry('Office CHL - Paris 5/7 Avenue Percier', { name: 'France' }), 'Office CHL - Paris 5/7 Avenue Percier');
  assert.equal(withCountry('Remote', { name: 'Germany' }), 'Remote');
  assert.equal(withCountry('4 Locations', { name: 'France' }), '4 Locations');
  assert.equal(withCountry('Garching', {}), 'Garching');
  assert.equal(withCountry('Garching', null), 'Garching');
  assert.equal(withCountry(null, { name: 'Germany' }), null);
  // An ambiguous country name adds nothing.
  assert.equal(withCountry('Atlanta', { name: 'Georgia' }), 'Atlanta');
});

test('Workday: the detail country is written onto a bare place', () => {
  const detail = {
    location: 'PARIS',
    country: { descriptor: 'France' },
    jobRequisitionLocation: { country: { descriptor: 'France', alpha2Code: 'FR' } },
  };
  assert.equal(placeOf(detail, { locationsText: 'PARIS' }), 'PARIS, France');
  assert.equal(placeOf({ location: 'Rochester, New York', country: { descriptor: 'United States of America' } }, {}), 'Rochester, New York');
  // A requisition in another country than the posting: its code is not used, the name is.
  assert.equal(placeOf({
    location: 'Copenhagen', country: { descriptor: 'Denmark' },
    jobRequisitionLocation: { country: { descriptor: 'Sweden', alpha2Code: 'SE' } },
  }, {}), 'Copenhagen, Denmark');
  assert.equal(placeOf(null, { locationsText: '4 Locations' }), null);
});

test('Workday: remoteType is the work model', () => {
  for (const [rt, want] of [
    ['On-Site', 'onsite'], ['On-site', 'onsite'], ['Onsite', 'onsite'], ['On Site', 'onsite'], ['Fully Onsite', 'onsite'],
    ['Remote', 'remote'], ['Fully Remote', 'remote'], ['Remote Working', 'remote'],
    ['Hybrid', 'hybrid'], ['Remote/Hybrid', 'hybrid'],
    ['Not Applicable', null], ['No', null], ['Flexible', null], [undefined, null],
  ]) assert.equal(workModelOf({ remoteType: rt }), want, String(rt));
  assert.equal(workModelOf(null), null);
});

test('Ashby: the address country is written onto a bare place', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ jobs: [
    { id: '1', title: 'A', location: 'Berlin Office', address: { postalAddress: { addressCountry: 'Germany', addressLocality: 'Berlin' } }, jobUrl: 'u1' },
    { id: '2', title: 'B', location: 'Remote', address: { postalAddress: { addressCountry: 'Germany' } }, jobUrl: 'u2' },
    { id: '3', title: 'C', location: 'New York, NY', address: { postalAddress: { addressCountry: 'United States' } }, jobUrl: 'u3' },
    { id: '4', title: 'D', jobUrl: 'u4' },
  ] }) });
  try {
    delete require.cache[require.resolve('../src/adapters/ashby')];
    const { fetchJobs } = require('../src/adapters/ashby');
    const { jobs } = await fetchJobs('acme');
    assert.deepEqual(jobs.map((j) => j.location), ['Berlin Office, Germany', 'Remote', 'New York, NY', 'Remote']);
  } finally {
    global.fetch = realFetch;
  }
});

const CELESTICA = 'Johor Bahru, 01, MY Company: Celestica International LP 04 - Production Technical Operator 4 '
  + 'Req ID: 142481 Remote Position: No Hiring Manager: , Jayadran A/L Gopal Band: 04 Region: Asia '
  + 'Country: Malaysia State/Province: Johor City: Johor Bahru Summary Work is guided by diverse procedures';

test('"Remote Position: No" is not remote', () => {
  const title = '04 - Production Technical Operator 4';
  const location = 'Johor Bahru, 01, MY';
  assert.equal(extractWorkplaceType(title, location, CELESTICA), null);
  assert.equal(extractWorkplaceTypeFromDescription(title, location, CELESTICA), null);
  assert.equal(classifyJob({ title, location, workplace_type: null, description: CELESTICA }).is_remote, false);
  for (const t of ['Remote Work: No', 'Remote eligible? No', 'Remote: No', 'Remote Position - No'])
    assert.equal(extractWorkplaceType('Analyst', 'Austin, TX', t), null, t);
});

test('a remote position stated as yes, or in words, is still remote', () => {
  assert.equal(extractWorkplaceType('Mechanical Design Engineer', 'Remote Employee US, NH, US', 'Req ID: 1 Remote Position: Yes'), 'remote');
  assert.equal(extractWorkplaceType('Analyst', 'Austin, TX', 'This is a remote position.'), 'remote');
  assert.equal(extractWorkplaceType('Analyst', 'Austin, TX', 'Remote - North America'), 'remote');
  // "no" inside a word is not the answer.
  assert.equal(extractWorkplaceType('Analyst', 'Austin, TX', 'Remote position: Northern Virginia preferred'), 'remote');
});

test('the remote-flag backfill clears a stored remote that says "Remote Position: No"', () => {
  assert.deepEqual(
    retag({ title: '04 - Production Technical Operator 4', location: 'Johor Bahru, 01, MY', description: CELESTICA }),
    { workplace: null, is_remote: false, remote_worldwide: false },
  );
  assert.equal(retag({ title: 'Mechanical Design Engineer', location: 'Remote Employee US, NH, US', description: 'Remote Position: Yes Hiring' }), null);
});
