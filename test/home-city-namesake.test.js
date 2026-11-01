const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFilter } = require('../src/db/repositories/jobs-search');
const { countriesFromLocation } = require('../src/utils/location-countries');

// Supply loop, 2026-11-01. A candidate in London, Ontario who picked "London" got London, UK
// (16 of 38 rows); Melbourne, Australia got Melbourne, FL (13 of 139); Vancouver, BC got
// Vancouver, WA (61 of 300). "City|Country" removed them but also lost the home country's own
// rows that index with no country ("Bangalore", "AE - Dubai"): Bengaluru 11 -> 5, Dubai 64 -> 49.

test('the home city keeps the home country and postings with no known country', () => {
  const f = buildFilter({ location: ['London'], home: 'London|Canada' }).filter;
  assert.match(f, /location_tokens = "london"/);
  assert.match(f, /location_countries = "ca"/);
  assert.match(f, /location_countries IS EMPTY/);
  assert.match(f, /NOT location_countries EXISTS/);
  assert.doesNotMatch(f, /location_countries = "gb"/);
});

test('only the element that is the home city is narrowed; other places stay as typed', () => {
  const f = buildFilter({ location: ['London', 'Toronto', 'United Kingdom'], home: 'London|Canada' }).filter;
  // Toronto stays a bare place, and a country the candidate chose still brings its rows.
  assert.match(f, /location_tokens = "toronto"/);
  assert.match(f, /location_countries = "gb"/);
  assert.equal((f.match(/location_countries IS EMPTY/g) || []).length, 1);
});

test('without home, or with a home that is not a place|country pair, nothing changes', () => {
  const bare = buildFilter({ location: ['London'] }).filter;
  assert.equal(buildFilter({ location: ['London'], home: 'Paris|Canada' }).filter, bare);
  assert.equal(buildFilter({ location: ['London'], home: 'London' }).filter, bare);
  assert.equal(buildFilter({ location: ['London'], home: 'London|Atlantis' }).filter, bare);
});

test('a remote search from the home city widens to the home country, not the namesake', () => {
  const f = buildFilter({ location: ['Melbourne'], home: 'Melbourne|Australia', workMode: 'remote' }).filter;
  assert.match(f, /is_remote = true AND/);
  assert.match(f, /location_countries = "au"/);
  assert.doesNotMatch(f, /location_countries = "us"/);
});

test('rows the namesake filter must not drop: Indian state codes and UK read as their country', () => {
  assert.deepEqual(countriesFromLocation('Mumbai, MH'), ['in']);
  assert.deepEqual(countriesFromLocation('Hyderabad, TG'), ['in']);
  assert.deepEqual(countriesFromLocation('Gurugram, HR'), ['in']);
  assert.deepEqual(countriesFromLocation('London, UK'), ['gb']);
  assert.ok(countriesFromLocation('London, UK; Paris, France').includes('gb'));
  // The real countries behind those codes are untouched.
  assert.deepEqual(countriesFromLocation('Zagreb, HR'), ['hr']);
  assert.deepEqual(countriesFromLocation('Majuro, MH'), ['mh']);
  assert.deepEqual(countriesFromLocation('Lome, TG'), ['tg']);
});

test('a district in brackets and a street address before the city keep the right country', () => {
  // The 2 of 205 rows the home-city filter dropped that were in the home country.
  assert.deepEqual(countriesFromLocation('Mumbai (Andheri East), IN'), ['in']);
  assert.deepEqual(countriesFromLocation('4660 La Jolla Village Dr #100, San Diego, CA'), ['us']);
  // Unchanged: a US city with a district, Canadian three-part addresses.
  assert.deepEqual(countriesFromLocation('Indianapolis (Downtown), IN'), ['us']);
  assert.deepEqual(countriesFromLocation('Toronto, ON, CA'), ['ca']);
  assert.deepEqual(countriesFromLocation('123 Main St, Toronto, ON'), ['ca']);
});

test('the reindex script queues only rows today\'s reading changes', () => {
  const { needsReindex } = require('../scripts/reindex-location-countries');
  assert.equal(needsReindex('Mumbai, MH'), 'in');
  assert.equal(needsReindex('Hyderabad, TG'), 'in');
  assert.equal(needsReindex('London, UK'), 'gb');
  assert.equal(needsReindex('London, UK; Paris, France'), 'gb');
  assert.equal(needsReindex('Mumbai (Andheri East), IN'), 'in');
  assert.equal(needsReindex('4660 La Jolla Village Dr #100, San Diego, CA'), 'us');
  // The real countries behind the codes, and rows no reading changed.
  assert.equal(needsReindex('Zagreb, HR'), null);
  assert.equal(needsReindex('Majuro, MH'), null);
  assert.equal(needsReindex('Toronto, ON, CA'), null);
  assert.equal(needsReindex('Indianapolis (Downtown), IN'), null);
  assert.equal(needsReindex('London, United Kingdom'), null);
  assert.equal(needsReindex(''), null);
});

test('a street address before a state code that is no country code was always the US', () => {
  const { needsReindex } = require('../scripts/reindex-location-countries');
  assert.equal(needsReindex('100 Congress Ave, Austin, TX'), null);
});
