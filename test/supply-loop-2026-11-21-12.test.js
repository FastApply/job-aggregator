'use strict';
// Supply loop 2026-11-21 12h: Ashby postings were stored at their primary place only, so a search
// for any other place the employer lists (Ashby's `secondaryLocations`) never found them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { locationOf } = require('../src/adapters/ashby');
const { withCountry } = require('../src/utils/place-country');
const { countriesFromLocation } = require('../src/utils/location-countries');

const at = (locality, region, country) => ({ postalAddress: { addressLocality: locality, addressRegion: region, addressCountry: country } });
const oldLocation = (job) => withCountry(job.location, { name: job.address?.postalAddress?.addressCountry }) || 'Remote';

test("Scribd's remote posting lists New York City and Canadian towns, not only San Francisco", () => {
  const job = {
    location: 'San Francisco',
    address: at('San Francisco', 'California', 'United States'),
    secondaryLocations: [
      { location: 'Ottawa', address: at('Ottawa', 'Ontario', 'Canada') },
      { location: 'Portland', address: at('Portland', 'Oregon', 'United States') },
      { location: 'New York City', address: at('New York City', 'New York', 'United States') },
    ],
  };
  const loc = locationOf(job);
  assert.match(loc, /^San Francisco, United States; /);
  assert.ok(loc.includes('New York City'), loc);
  // A bare town takes its region, so Portland is not left to a guess between Oregon and Maine.
  assert.ok(loc.includes('Portland, Oregon'), loc);
  const countries = countriesFromLocation(loc);
  assert.ok(countries.includes('us') && countries.includes('ca'), `${loc}: ${countries}`);
});

test('a posting with no other place is stored exactly as before', () => {
  for (const job of [
    { location: 'Berlin Office', address: at('Berlin', 'Berlin', 'Germany') },
    { location: 'Utah, United States ', address: at(null, 'Utah', 'United States') },
    { location: '', address: null },
    { location: 'Remote', secondaryLocations: [] },
  ]) {
    assert.equal(locationOf(job), oldLocation(job), JSON.stringify(job));
  }
});

test('places already written in full, repeats and remote places are kept as the employer wrote them', () => {
  const loc = locationOf({
    location: 'Office Hub - San Diego, CA',
    address: at('San Diego', 'California', 'United States'),
    secondaryLocations: [
      { location: 'Remote Hub - Atlanta, GA', address: at('Atlanta', 'Georgia', 'United States') },
      { location: 'Office Hub - San Diego, CA', address: at('San Diego', 'California', 'United States') },
      { location: '  ', address: null },
      null,
    ],
  });
  assert.equal(loc, 'Office Hub - San Diego, CA; Remote Hub - Atlanta, GA');
});
