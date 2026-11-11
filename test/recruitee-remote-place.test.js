'use strict';
// Verdict audit 2026-11-11 20h: Recruitee's remote offers say only "Remote job" in `location`.
const test = require('node:test');
const assert = require('node:assert/strict');
const { remotePlace } = require('../src/adapters/recruitee');

const loc = (city, country, code) => ({ city, country, country_code: code });

test('a remote offer names the country its location list gives', () => {
  assert.equal(
    remotePlace({ location: 'Remote job', remote: true, locations: [loc('Düsseldorf', 'Germany', 'DE')] }),
    'Remote - Germany'
  );
  // The account's own word for remote, and the country in the account's language.
  assert.equal(
    remotePlace({ location: 'Homeoffice', remote: true, locations: [loc('Europe', 'Deutschland', 'DE')] }),
    'Remote - Germany'
  );
});

test('every country of the list, once', () => {
  assert.equal(
    remotePlace({
      location: 'Remote job',
      remote: true,
      locations: [loc('Barcelona', 'Spain', 'ES'), loc('milan', 'Italy', 'IT')],
    }),
    'Remote - Spain; Italy'
  );
  assert.equal(
    remotePlace({
      location: 'Remote job',
      remote: true,
      locations: [loc('Perth', 'Australia', 'AU'), loc('Sydney', 'Australia', 'AU'), loc('Melbourne', 'Australia', 'AU')],
    }),
    'Remote - Australia'
  );
  assert.equal(
    remotePlace({
      location: 'Remote job',
      remote: true,
      locations: [
        loc('Bolivia', 'Bolivia, Plurinational State of', 'BO'),
        loc('Chile', 'Chile', 'CL'),
        loc('Colombia', 'Colombia', 'CO'),
      ],
    }),
    'Remote - Bolivia; Chile; Colombia'
  );
});

test("the offer's own country when the list is missing", () => {
  assert.equal(remotePlace({ location: 'Remote job', remote: true, country_code: 'BE' }), 'Remote - Belgium');
});

test('left alone: an on-site offer, a label that names a country, an offer with no country', () => {
  assert.equal(
    remotePlace({ location: 'Leuven, Vlaams Gewest, Belgium', remote: false, locations: [loc('Leuven', 'Belgium', 'BE')] }),
    'Leuven, Vlaams Gewest, Belgium'
  );
  assert.equal(
    remotePlace({ location: 'Remote, Portugal', remote: true, locations: [loc('Lisbon', 'Portugal', 'PT')] }),
    'Remote, Portugal'
  );
  assert.equal(remotePlace({ location: 'Remote job', remote: true, locations: [] }), 'Remote job');
  assert.equal(remotePlace({ location: null, remote: false }), null);
});
