'use strict';
// Supply loop 2026-11-21: the Americas' regions read as the United States, and Teamtailor remote
// jobs stored at the company's address rather than the market their location is named for.
const test = require('node:test');
const assert = require('node:assert/strict');
const { countriesFromLocation } = require('../src/utils/location-countries');
const { remoteRegionCountries } = require('../src/utils/remote-regions');
const { locationOf } = require('../src/adapters/teamtailor');
const { needsResend } = require('../scripts/requeue-americas-regions');

// What meili.js writes into location_countries for a remote row.
const remoteTags = (loc) => [...new Set([...countriesFromLocation(loc), ...remoteRegionCountries(loc)])];

test('Latin, South and Central America are regions, not the United States', () => {
  for (const [loc, has, not] of [
    ['Latin America - Remote', 'mx', 'us'],
    ['South America (Remote)', 'br', 'us'],
    ['Latin America', 'co', 'us'],
    ['Remote - Central America', 'cr', 'us'],
    ['LATAM, Brazil', 'br', 'us'],
  ]) {
    const tags = remoteTags(loc);
    assert.ok(tags.includes(has), `${loc} is in ${has}: ${tags}`);
    assert.ok(!tags.includes(not), `${loc} is not in ${not}: ${tags}`);
  }
});

test('the United States and its towns still read as the United States', () => {
  for (const loc of ['America', 'United States of America', 'Americus, GA', 'North America', 'Remote - USA']) {
    assert.ok(countriesFromLocation(loc).includes('us'), loc);
  }
  assert.deepEqual(countriesFromLocation('South Africa'), ['za']);
  // An office named for the region is no job across it: no region codes off a non-remote row.
  assert.deepEqual(countriesFromLocation('Latin America'), []);
});

const item = (name, city, country) =>
  `<tt:locations><tt:location><tt:name>${name}</tt:name><tt:address/><tt:zip/>` +
  `<tt:city>${city}</tt:city><tt:country>${country}</tt:country></tt:location></tt:locations>`;

test('a Teamtailor remote job named for another market takes the name', () => {
  // Dechra's "Sales Representative": "Remote - Sweden" over a Boston, United States address.
  assert.equal(locationOf(item('Remote - Sweden', 'Boston', 'United States'), true), 'Remote - Sweden');
  assert.deepEqual(countriesFromLocation(locationOf(item('Remote - Sweden', 'Boston', 'United States'), true)), ['se']);
  // Virtasant names its remote locations by market over an Austin address.
  assert.equal(locationOf(item('Latin America', 'Austin', 'United States'), true), 'Latin America');
  assert.equal(locationOf(item('Canada', 'Austin', 'United States'), true), 'Canada');
  assert.equal(locationOf(item('Eastern Europe', 'Austin', 'United States'), true), 'Eastern Europe');
});

test('an office job, a name in the same country, or a name with no country keeps the address', () => {
  assert.equal(locationOf(item('Remote - Sweden', 'Boston', 'United States'), false), 'Boston, United States');
  assert.equal(locationOf(item('Warsaw, Poland', 'Warszawa', 'Poland'), true), 'Warszawa, Poland');
  assert.equal(locationOf(item('Turkey (remote)', 'Istanbul', 'Türkiye'), true), 'Istanbul, Türkiye');
  assert.equal(locationOf(item('Remote', 'Glendale', 'United States'), true), 'Glendale, United States');
  assert.equal(locationOf(item('US Office', 'Tampa', 'United States'), true), 'Tampa, United States');
  assert.equal(locationOf(item('UK', 'London', 'United Kingdom'), true), 'London, United Kingdom');
});

test('the requeue marks only rows naming those regions', () => {
  assert.equal(needsResend({ location: 'Latin America - Remote' }), true);
  assert.equal(needsResend({ location: 'South America (Remote)' }), true);
  assert.equal(needsResend({ location: 'Remote - LATAM' }), true);
  assert.equal(needsResend({ location: 'Americus, GA' }), false);
  assert.equal(needsResend({ location: 'North America' }), false);
  assert.equal(needsResend({ location: null }), false);
});
