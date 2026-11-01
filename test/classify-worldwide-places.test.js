const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyRemote, classifyRemoteWorldwide, classifyJob, locationIsWorldwide } = require('../src/utils/classify');

// Live worldwide rows on 2026-11-01 (supply loop): 1,300 of 3,431 were a place or an office whose
// name holds the word. Remote Worldwide automations were served them, and the match refused each one
// on location after a paid call ("CVG2 - Hebron, KY", "the Krakow Global Business Services Center").
const PLACES = [
  'CVG2 - Hebron, KY - 1405 Worldwide Blvd',
  'Bonifacio Global City, PHL',
  'MUFG Global Service Private Ltd. - Bengaluru (BCIT)',
  'Local Office Pune (Global Function)',
  'NYC Global HQ',
  'Global Headquarters',
  'CO - MEDELLIN II GLOBAL BUSINESS SERVICES-GBS (COMEL)',
  'Krakow Global Business Services Center - IP (POL)',
  'ROYAL CARIBBEAN GROUP, worldwide',
  'Worldwide House',
  'Bangkok (Central World Office)',
  'Danbury, CT - Global',
  'Anywhere, OH',
  'Global, EU',
  'Multiple Locations, Worldwide',
  '上海, worldwide',
];

const WORK_MODELS = [
  'Worldwide', 'Global', 'Anywhere', 'World Wide - Remote', 'Home based - Worldwide', 'Global, Global',
  'Remote, Global', 'Remote - Global', 'Global (Remote)', 'Remote (Worldwide) (+1 more locations)',
  'Anywhere in the World', 'Remote Anywhere in the World', 'Anywhere (Open Globally)',
  'Global Remote – Contractor Only', 'Remote (Global, no location restrictions)', 'Worldwide, , OTHER',
  'Worldwide / Weltweit', '🌎 Global', 'Remote -- World Wide', 'Worldwide, but must be willing to attend regular EST meetings',
];

test('a place or an office that holds a worldwide word is not a worldwide location', () => {
  for (const loc of PLACES) assert.equal(locationIsWorldwide(loc), false, loc);
});

test('a location that is the work model still reads worldwide', () => {
  for (const loc of WORK_MODELS) assert.equal(locationIsWorldwide(loc), true, loc);
});

test('an office with "Global" in its name is neither remote nor worldwide by its location', () => {
  for (const loc of PLACES.filter((l) => !/^Anywhere/.test(l))) {
    assert.equal(classifyRemote('Data Analyst', loc, null, ''), false, loc);
    assert.equal(classifyRemoteWorldwide('Data Analyst', loc, '', true), false, loc);
  }
});

test('the work-model locations keep both tags', () => {
  for (const loc of WORK_MODELS) {
    assert.equal(classifyRemote('Data Analyst', loc, null, ''), true, loc);
    assert.equal(classifyRemoteWorldwide('Data Analyst', loc, '', true), true, loc);
  }
  const tags = classifyJob({ title: 'Writer', location: 'Worldwide', workplace_type: null, description: '' });
  assert.equal(tags.is_remote, true);
  assert.equal(tags.remote_worldwide, true);
});

test('"Anywhere" as the place is still remote, but within the state it names', () => {
  assert.equal(classifyRemote('Analyst', 'Anywhere, OH', null, ''), true);
  assert.equal(classifyRemoteWorldwide('Analyst', 'Anywhere, OH', '', true), false);
  assert.equal(classifyRemote('Analyst', 'Anywhere (subject to approval)', null, ''), true);
});

test('an adapter that says remote keeps the job remote, but an office name is not worldwide', () => {
  assert.equal(classifyRemote('Engineer', 'Global Headquarters', 'remote', ''), true);
  assert.equal(classifyRemoteWorldwide('Engineer', 'Global Headquarters', '', true), false);
  // The description can still say so when the location is a work model.
  assert.equal(classifyRemoteWorldwide('Engineer', 'Global', 'You can work from anywhere.', true), true);
});

test('the backfill clears only rows whose location holds the word inside a place', () => {
  const { retag } = require('../scripts/backfill-worldwide-places');
  const row = (location, extra = {}) => ({
    title: 'Data Analyst', location, workplace_type: null, description: '', is_remote: true, remote_worldwide: true, ...extra,
  });
  assert.deepEqual(retag(row('CVG2 - Hebron, KY - 1405 Worldwide Blvd')), { is_remote: false, remote_worldwide: false });
  assert.deepEqual(retag(row('Bonifacio Global City, PHL', { workplace_type: 'remote' })), { is_remote: true, remote_worldwide: false });
  assert.equal(retag(row('Worldwide')), null);
  assert.equal(retag(row('Remote - Global')), null);
  // No worldwide word in the location: whatever tagged it, this backfill does not touch it.
  assert.equal(retag(row('')), null);
  assert.equal(retag(row('Remote')), null);
  assert.equal(retag(row('Global Headquarters', { remote_worldwide: false })), null);
});
