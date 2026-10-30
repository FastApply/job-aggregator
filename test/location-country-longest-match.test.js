'use strict';
/**
 * A country named INSIDE a longer place name is not that country.
 *
 * Measured on the live board 2026-10-29 (supply loop): location=United Kingdom returned 22
 * Australian rows in 400 ("Sydney, New South Wales, Australia" read "wales" as the UK),
 * location=Guinea returned 85 Papua New Guinea rows of 125, location=Ireland returned Belfast,
 * and location=Spain returned "Port of Spain, Trinidad and Tobago". The index-time scan read every
 * word n-gram, so the short name inside the long one was tagged as well. It now keeps the longest
 * match: each word belongs to one name.
 *
 * Over 8,315 distinct locations from First Apply's replayed searches, 34 changed tags, all of them
 * these corrections.
 */
const test = require('node:test');
const assert = require('node:assert');
const { countriesFromLocation } = require('../src/utils/location-countries');

const tags = (loc) => countriesFromLocation(loc).sort();

test('New South Wales is Australia, not the United Kingdom', () => {
  assert.deepStrictEqual(tags('Sydney, New South Wales, Australia'), ['au']);
  assert.deepStrictEqual(tags('North Sydney, New South Wales'), ['au']);
  assert.deepStrictEqual(tags('Cardiff, Wales'), ['gb']);
  assert.deepStrictEqual(tags('Wales, UK'), ['gb']);
});

test('a longer country name is not also the shorter one inside it', () => {
  assert.deepStrictEqual(tags('Port Moresby, Papua New Guinea'), ['pg']);
  assert.deepStrictEqual(tags('Malabo, Equatorial Guinea'), ['gq']);
  assert.deepStrictEqual(tags('Bissau, Guinea-Bissau'), ['gw']);
  assert.deepStrictEqual(tags('Conakry, Guinea'), ['gn']);
  assert.deepStrictEqual(tags('Juba, South Sudan'), ['ss']);
  assert.deepStrictEqual(tags('Khartoum, Sudan'), ['sd']);
  assert.deepStrictEqual(tags('Kinshasa, Democratic Republic of the Congo'), ['cd']);
  assert.deepStrictEqual(tags('Brazzaville, Republic of the Congo'), ['cg']);
  assert.deepStrictEqual(tags("Beijing, People's Republic of China"), ['cn']);
});

test('Northern Ireland is the United Kingdom only', () => {
  assert.deepStrictEqual(tags('Belfast, Northern Ireland, United Kingdom'), ['gb']);
  assert.deepStrictEqual(tags('Dublin, Ireland'), ['ie']);
});

test('Port of Spain is Trinidad and Tobago, not Spain', () => {
  assert.deepStrictEqual(tags('Port of Spain, Trinidad and Tobago'), ['tt']);
  assert.deepStrictEqual(tags('Madrid, Spain'), ['es']);
});

test('two places in one string keep both countries', () => {
  assert.deepStrictEqual(tags('United Kingdom - Remote, Sydney, New South Wales'), ['au', 'gb']);
});

test('a state or city named for its country at index time is still a place in a search', () => {
  const { resolveCountry, countriesFromLocation } = require('../src/utils/location-countries');
  assert.deepEqual(countriesFromLocation('Sydney, New South Wales, Australia'), ['au']);
  assert.deepEqual(countriesFromLocation('Port of Spain, Trinidad and Tobago'), ['tt']);
  assert.equal(resolveCountry('New South Wales'), null);
  assert.equal(resolveCountry('new south wales'), null);
  assert.equal(resolveCountry('Port of Spain'), null);
  assert.equal(resolveCountry('Australia').code, 'au');
  assert.equal(resolveCountry('Trinidad and Tobago').code, 'tt');
});
