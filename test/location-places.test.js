'use strict';
/**
 * Place names searchers type that postings never write: US state names (postings write "Chicago,
 * IL"), wrapped names ("New York State", "Greater London") and metro areas ("Delhi NCR").
 *
 * Each of these returned zero or a sliver on the live board 2026-09-28 — "new york state" 0 where
 * "new york" gave 319 for the same roles — without an error anywhere. Assertions are on the filter
 * string because that string is the contract with Meilisearch.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFilter } = require('../src/db/repositories/jobs-search');
const { placeVariants } = require('../src/utils/location-places');
const meili = require('../src/utils/meili');

const filterFor = (location) => buildFilter({ location }).filter;

test('a US state name also matches its two-letter code, but only on US postings', () => {
  assert.equal(filterFor('Illinois'),
    '((location_tokens = "illinois" OR (location_tokens = "il" AND location_countries = "us")))');
  // "CA" alone is also Canada: the code must never be matched without the US tag.
  assert.match(filterFor('California'), /\(location_tokens = "ca" AND location_countries = "us"\)/);
  assert.doesNotMatch(filterFor('California'), /OR location_tokens = "ca"(?! AND)/);
});

test('the state-code clause matches how "City, ST" postings are actually indexed', () => {
  const doc = meili.toDocument({ id: 1, title: 'x', location: 'Chicago, IL', company_id: 1 });
  assert.ok(doc.location_tokens.includes('il'));
  assert.ok(doc.location_countries.includes('us'));
  assert.ok(!doc.location_tokens.includes('illinois'), 'if this changes, the code clause is no longer needed');
  const canada = meili.toDocument({ id: 2, title: 'x', location: 'Toronto, ON, CA', company_id: 1 });
  assert.ok(!canada.location_countries.includes('us'), 'a Canadian "CA" must not satisfy a California search');
});

test('"New York State" searches New York', () => {
  assert.equal(filterFor('new york state'),
    '((location_tokens = "new york state" OR location_tokens = "new york" OR (location_tokens = "ny" AND location_countries = "us")))');
});

test('Delhi NCR expands to the cities postings name', () => {
  const f = filterFor('Delhi NCR');
  for (const city of ['delhi', 'gurugram', 'gurgaon', 'noida', 'faridabad', 'ghaziabad']) {
    assert.match(f, new RegExp(`location_tokens = "${city}"`));
  }
});

test('Greater / State / Area wrappers are dropped, keeping the original term', () => {
  assert.deepEqual(placeVariants('Greater London'), ['greater london', 'london']);
  assert.deepEqual(placeVariants('Lagos State'), ['lagos state', 'lagos']);
  assert.ok(placeVariants('Greater Toronto Area').includes('mississauga'));
});

test('a wrapper is not dropped when what is left names no place', () => {
  assert.deepEqual(placeVariants('Eastern Province'), ['eastern province']);
  assert.equal(filterFor('united state'), '((location_countries = "us"))', 'a misspelt country, not the word "united"');
});

test('an ordinary city is unchanged', () => {
  assert.equal(filterFor('San Diego'), '((location_tokens = "san diego"))');
  assert.equal(filterFor('Lagos, Nigeria'), '(((location_tokens = "lagos") AND (location_countries = "ng")))');
});

test('Montana is matched by name only: "mt" is mostly "Mt." (Mount) in real postings', () => {
  assert.equal(filterFor('Montana'), '((location_tokens = "montana"))');
});
