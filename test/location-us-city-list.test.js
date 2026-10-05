'use strict';
/**
 * One job posted in several US cities, "City, ST, City, ST, ...". Read the trailing state code as a
 * country and it was tagged Albania ("AL") or Colombia ("CO"), or nothing, and a United States
 * filter dropped it (search canary 2026-10-04: an 8-city Truck Driver job).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { countriesFromLocation: c } = require('../src/utils/location-countries');

test('a list of US City, ST pairs is the United States', () => {
  assert.deepEqual(c('Arcadia, FL, Auburn, AL, Edwardsville, KS, Gloversville, NY, Lyons, IL, Menasha, WI, Millcreek, UT, Puyallup, WA'), ['us']);
  assert.deepEqual(c('Arcadia, FL, Auburn, AL'), ['us']);
  assert.deepEqual(c('Austin, TX, Denver, CO'), ['us']);
  assert.deepEqual(c('Austin, TX, Dallas, TX'), ['us']);
  assert.deepEqual(c('Austin, TX, Denver, CO, USA'), ['us']);
});

test('country-code lists keep their countries', () => {
  assert.deepEqual(c('Toronto, ON, CA'), ['ca']);
  assert.deepEqual(c('London, England, GB, GB'), ['gb']);
  assert.deepEqual(c('Paris, France, Berlin, Germany'), ['fr', 'de']);
  assert.notDeepEqual(c('Berlin, DE, Munich, DE'), ['us'], 'one repeated code that is also a country stays ambiguous');
});

test('state-first lists ("TX - Dallas, ...") and trailing bare states are the United States', () => {
  assert.deepEqual(c('TX - Dallas, NM - Albuquerque, VA - Norfolk, IN - Indianapolis, MI - Hazel Park, IN - Hammond, OH - Cleveland, TN, NY'), ['us']);
  assert.deepEqual(c('CA - San Diego, CO - Denver'), ['us']);
  assert.notDeepEqual(c('Chennai, TN, IN'), ['us'], 'City, state, country stays India');
});

test('lists that name a real country keep it', () => {
  assert.deepEqual(c('Austin, TX, Mexico City, Mexico'), c('Austin, TX, Mexico City, Mexico'));
  assert.ok(c('Austin, TX, Mexico City, Mexico').includes('mx'));
  assert.deepEqual(c('Indore, IN, Pune, IN'), c('Indore, IN, Pune, IN'));
  assert.notDeepEqual(c('Indore, IN, Pune, IN'), ['us']);
});
