'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { toDocument } = require('../src/utils/meili');

const doc = (location, is_remote = true) => toDocument({ id: 1, title: 'x', company_id: 1, location, is_remote }).location_countries;

test('a remote job open across Europe or EMEA counts in Sweden', () => {
  for (const loc of ['Remote, EMEA', 'Remote - Europe', 'Europe (Remote)', 'Remote, EU', 'Remote (CET)']) {
    assert.ok(doc(loc).includes('se'), loc);
    assert.ok(!doc(loc).includes('ng'), `${loc}: EMEA is read as Europe, not Africa`);
  }
});

test('Nordics and Scandinavia map to their countries', () => {
  assert.deepEqual(doc('Remote - Nordics').sort(), ['dk', 'fi', 'is', 'no', 'se']);
  assert.deepEqual(doc('Scandinavia, Remote').sort(), ['dk', 'no', 'se']);
});

test('region countries add to the countries the location already names', () => {
  const c = doc('Remote in USA; Remote, EMEA');
  assert.ok(c.includes('us') && c.includes('se'));
});

test('an office named after a region is not a job across it', () => {
  assert.deepEqual(doc('Europe HQ', false), []);
});

test('a plain city is unchanged', () => {
  assert.deepEqual(doc('Stockholm, Sweden'), ['se']);
  assert.deepEqual(doc('Austin, TX'), ['us']);
});
