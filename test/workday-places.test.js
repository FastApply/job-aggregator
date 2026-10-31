'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { placeOf } = require('../src/adapters/workday');

test('the detail call names the place', () => {
  assert.equal(placeOf({ location: 'Rochester, New York' }, { locationsText: '4 Locations' }), 'Rochester, New York');
});

test('a failed detail call never stores the count', () => {
  assert.equal(placeOf(null, { locationsText: '4 Locations' }), null);
  assert.equal(placeOf(null, { locationsText: '1 Location' }), null);
});

test('a failed detail call keeps a real place from the list', () => {
  assert.equal(placeOf(null, { locationsText: 'Cherokee, IA' }), 'Cherokee, IA');
  assert.equal(placeOf(null, {}), null);
});
