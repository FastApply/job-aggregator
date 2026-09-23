'use strict';
/**
 * A comma in a location filter binds a place to the country next to it — it is not a flat OR.
 *
 * The bug: every comma-separated term was OR'd independently, so "Lagos, Nigeria" asked for
 * "anywhere called Lagos OR anywhere in Nigeria". Since every Nigerian job also matches Nigeria,
 * searching one city returned the entire country — the filter looked applied and quietly did
 * nothing. That is the failure mode these tests exist to catch: a regression here does not throw
 * or return zero, it returns plausible, wrong results that nobody reports.
 *
 * Assertions are on the exact filter string rather than a parsed shape, deliberately: the string
 * IS the contract with Meilisearch, and a change in grouping or precedence that preserves the
 * tokens while altering the meaning is exactly what must fail here.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFilter } = require('../src/db/repositories/jobs-search');
const { AMBIGUOUS_COUNTRY_NAMES } = require('../src/utils/location-countries');

const filterFor = (location) => buildFilter({ location }).filter;

test('a place followed by a country is AND-ed, not OR-ed', () => {
  assert.equal(
    filterFor('Lagos, Nigeria'),
    '(((location_tokens = "lagos") AND (location_countries = "ng")))',
    'the original bug: an OR here returns every job in Nigeria for a Lagos search'
  );
});

test('the country can close the run from either side', () => {
  // "Nashville, United States" and "United States, Nashville" must mean the same thing; a reader
  // writing the country first is not asking for the whole country.
  assert.equal(filterFor('Nashville, United States'),
    '(((location_tokens = "nashville") AND (location_countries = "us")))');
  assert.equal(filterFor('United States, Nashville, New Orleans'),
    '(((location_tokens = "nashville" OR location_tokens = "new orleans") AND (location_countries = "us")))',
    'both cities qualify against the one country, and the cities stay OR-ed against each other');
});

test('a country whose own cities are searched normally still closes a run', () => {
  // Mexico is the case that must NOT be treated as ambiguous: "Cancun, Mexico" is a common, precise
  // search, and breaking the bind would widen it to the whole country.
  assert.equal(filterFor('Cancun, Mexico'),
    '(((location_tokens = "cancun") AND (location_countries = "mx")))');
});

test('an ambiguous country name stays over-inclusive rather than returning nothing', () => {
  // "Georgia" is both a country and a US state. Binding it as a closing country turns
  // "Atlanta, Georgia" into `atlanta AND country=ge` — an AND that can never match, so a real
  // search returns zero. Dual-emit keeps the country group AND the plain place terms.
  const f = filterFor('Atlanta, Georgia');
  assert.equal(f, '((location_countries = "ge") OR (location_tokens = "atlanta" OR location_tokens = "georgia"))');
  assert.match(f, / OR /, 'must stay an OR: an AND here is the zero-result failure');
});

test('palestine is deliberately NOT ambiguous — ramallah binds to it', () => {
  // Ramallah is Palestine's own capital, so "ramallah,palestine" is the same shape as
  // "Cancun, Mexico", not the shape of "Atlanta, Georgia". Adding palestine to the ambiguous set
  // would broaden a confirmed real search into "anywhere in Palestine".
  assert.ok(!AMBIGUOUS_COUNTRY_NAMES.has('palestine'));
  assert.equal(filterFor('ramallah,palestine'),
    '(((location_tokens = "ramallah") AND (location_countries = "ps")))');
});

test('a bare place with no country is left alone', () => {
  assert.equal(filterFor('Berlin'), '((location_tokens = "berlin"))');
  assert.equal(filterFor('Remote'), '((location_tokens = "remote"))');
});

test('the ambiguous set stays small and intentional', () => {
  // The same city/country cross-reference turns up 76 collisions; only four earned a place here,
  // each checked against real search-demand data. A future addition should have to update this
  // test — and therefore justify itself — rather than slip in.
  assert.deepEqual([...AMBIGUOUS_COUNTRY_NAMES].sort(), ['angola', 'georgia', 'liberia', 'macedonia']);
});
