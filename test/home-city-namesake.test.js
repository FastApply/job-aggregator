const test = require('node:test');
const assert = require('node:assert/strict');
const { countriesFromLocation } = require('../src/utils/location-countries');

// Supply loop, 2026-11-01. A candidate in London, Ontario who picked "London" got London, UK
// (16 of 38 rows); Melbourne, Australia got Melbourne, FL (13 of 139); Vancouver, BC got
// Vancouver, WA (61 of 300). "City|Country" removed them but also lost the home country's own
// rows that index with no country ("Bangalore", "AE - Dubai"): Bengaluru 11 -> 5, Dubai 64 -> 49.

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
