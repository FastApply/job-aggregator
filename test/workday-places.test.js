'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { placeOf } = require('../src/adapters/workday');
const { cxsUrl, placeIn } = require('../scripts/backfill-workday-places');
const { placed } = require('../scripts/backfill-bamboohr-location');

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

test('reads the API address from a posting URL', () => {
  assert.equal(
    cxsUrl('https://cbrands.wd5.myworkdayjobs.com/cbi_external_careers/job/Rochester-New-York/IT-Product-Manager_R-40881-1'),
    'https://cbrands.wd5.myworkdayjobs.com/wday/cxs/cbrands/cbi_external_careers/job/Rochester-New-York/IT-Product-Manager_R-40881-1'
  );
  assert.equal(
    cxsUrl('https://acme.wd1.myworkdayjobs.com/en-US/External/job/Berlin/Analyst_R1'),
    'https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/External/job/Berlin/Analyst_R1'
  );
  assert.equal(cxsUrl('https://example.com/job/1'), null);
  assert.equal(cxsUrl('not a url'), null);
});

test('reads the place from the API answer', () => {
  assert.equal(placeIn({ jobPostingInfo: { location: 'Rochester, New York' } }), 'Rochester, New York');
  assert.equal(placeIn({ jobPostingInfo: {} }), null);
  assert.equal(placeIn(null), null);
});

// Key Media's row as stored, 2026-10-31.
const keyMedia = {
  title: 'Event Sponsorship Sales Executive',
  workplace_type: 'remote',
  is_remote: true,
  remote_worldwide: true,
  description: '<p>Working remotely in the United States, you will collaborate with colleagues worldwide.</p>',
  raw_data: JSON.stringify({
    location: { city: null, state: null },
    atsLocation: { country: 'United States', state: 'New York', province: null, city: 'New York' },
  }),
};

test('a stored listing gives the row its place and ends "worldwide"', () => {
  const next = placed(keyMedia);
  assert.equal(next.location, 'New York, United States');
  assert.equal(next.remote_worldwide, false);
});

test('a listing with no place, or unreadable, is left alone', () => {
  assert.equal(placed({ ...keyMedia, raw_data: JSON.stringify({ location: {}, atsLocation: { country: null } }) }), null);
  assert.equal(placed({ ...keyMedia, raw_data: 'not json' }), null);
});
