const test = require('node:test');
const assert = require('node:assert/strict');
const { countriesFromLocation } = require('../src/utils/location-countries');

// Live, 2026-10-30: a Canada search returned Axos's "HQ - San Diego, CA", and First Apply applied
// to it for a candidate whose places are Germany, Canada and the Netherlands. Over 3,350 distinct
// locations from the loop's pulls, 4 tags changed, all of them to the right country.
test('a label, then a city and its US state, is the US', () => {
  assert.deepEqual(countriesFromLocation('HQ - San Diego, CA'), ['us']);
  assert.deepEqual(countriesFromLocation('HQ - Indianapolis, IN'), ['us']);
  assert.deepEqual(countriesFromLocation('Support Center - Irving, TX'), ['us']);
  assert.deepEqual(countriesFromLocation('Main - Wilmington, DE'), ['us']);
});

test('the same shape outside the US keeps its country', () => {
  assert.deepEqual(countriesFromLocation('Downtown - Toronto, CA'), ['ca']);
  assert.deepEqual(countriesFromLocation('India - Pune, IN'), ['in']);
  assert.deepEqual(countriesFromLocation('Paris - La Defense, FR'), ['fr']);
  assert.deepEqual(countriesFromLocation('London - Canary Wharf, GB'), ['gb']);
});
