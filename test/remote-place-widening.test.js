'use strict';
/**
 * Remote + a place means "remote jobs I can do from here", not "remote jobs whose posting names my
 * city". FastApply's form makes Locations required and Remote a work mode, so every remote seeker
 * sends a place. A remote posting names its country ("Remote - US"), so AND-ing the city onto
 * is_remote left "San Diego + Remote" with 1 result against 161 for the US (live, 2026-09-28).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const meili = require('../src/utils/meili');
const jobsSearch = require('../src/db/repositories/jobs-search');

const { buildFilter } = jobsSearch;

test('without a country lookup the location is used as typed', () => {
  assert.equal(buildFilter({ location: ['san diego'], workMode: 'remote' }).filter,
    '(is_remote = true) AND ((location_tokens = "san diego"))');
});

test('remote + a city widens the remote half to the city\'s country and worldwide postings', () => {
  const f = buildFilter({ location: ['san diego'], workMode: 'remote', _placeCountries: { 'san diego': ['us'] } }).filter;
  assert.equal(f, '(is_remote = true AND ((location_tokens = "san diego") OR location_countries = "us" OR remote_worldwide = true))');
});

test('hybrid and on-site keep the place as typed when mixed with remote', () => {
  const f = buildFilter({ location: ['san diego'], workMode: 'remote,hybrid', _placeCountries: { 'san diego': ['us'] } }).filter;
  assert.equal(f, '((is_remote = true AND ((location_tokens = "san diego") OR location_countries = "us" OR remote_worldwide = true))'
    + ' OR ((workplace_type = "Hybrid") AND ((location_tokens = "san diego"))))');
});

test('no remote in the search, no widening', () => {
  assert.equal(buildFilter({ location: ['san diego'], workMode: 'hybrid', _placeCountries: { 'san diego': ['us'] } }).filter,
    '(workplace_type = "Hybrid") AND ((location_tokens = "san diego"))');
});

test('a country alone is already as wide as it gets and is left unchanged', () => {
  assert.equal(buildFilter({ location: ['united states'], workMode: 'remote', _placeCountries: {} }).filter,
    '(is_remote = true) AND ((location_countries = "us"))');
});

test('remote worldwide is not narrowed to a country', () => {
  const f = buildFilter({ location: ['san diego'], remote: 'true', remoteWorldwide: 'true', _placeCountries: { 'san diego': ['us'] } }).filter;
  assert.doesNotMatch(f, /location_countries = "us" OR/);
});

test('the lookup picks the countries holding the place\'s postings and ignores a sliver', async (t) => {
  const calls = [];
  t.mock.method(meili, 'search', async (params) => {
    calls.push(params);
    return { facetDistribution: { location_countries: { gb: 900, ca: 40, us: 5 } } };
  });
  const out = await jobsSearch._withPlaceCountries({ location: ['Londonx-test'], workMode: 'remote' });
  assert.deepEqual(out._placeCountries, { 'londonx-test': ['gb'] });
  assert.deepEqual(calls[0].facets, ['location_countries']);
});

test('too few postings names no country, and a failed lookup leaves the search as typed', async (t) => {
  t.mock.method(meili, 'search', async () => ({ facetDistribution: { location_countries: { us: 3 } } }));
  assert.deepEqual((await jobsSearch._withPlaceCountries({ location: ['tinyville-test'], workMode: 'remote' }))._placeCountries,
    { 'tinyville-test': [] });
  meili.search.mock.mockImplementation(async () => { throw new Error('down'); });
  const out = await jobsSearch._withPlaceCountries({ location: ['otherville-test'], workMode: 'remote' });
  assert.deepEqual(out._placeCountries, { 'otherville-test': [] });
  assert.equal(buildFilter(out).filter, '(is_remote = true) AND ((location_tokens = "otherville-test"))');
});
