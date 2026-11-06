const test = require('node:test');
const assert = require('node:assert/strict');
const { countriesFromLocation, isLabelCityState } = require('../src/utils/location-countries');
const { isUsPlace } = require('../src/utils/us-places');
const { needsResend } = require('../scripts/requeue-label-city-state');

// Supply loop, 2026-11-06: a First Apply search for Vancouver / Canada got 24 Greystar rows in
// California ("Vida at Morgan Hill, Morgan Hill, CA" read as Canada), and about 12,000 live US rows
// were tagged New Caledonia, Israel, Gabon, Azerbaijan ... so a United States search missed them.
// Over the 120,000 most common live locations, 314 tags changed, every one of them to the US.
test('a site or neighbourhood, then a town of that state, is the US', () => {
  for (const location of [
    'Vida at Morgan Hill, Morgan Hill, CA',
    'City Office Escondido, Escondido, CA',
    'Hotel Per La, Autograph Collection - Los Angeles, CA',
    'Carolinas Medical Center - 1000 Blythe Blvd, Charlotte, NC',
    'Streeterville, Chicago, IL',
    'Atrium Health Navicent The Medical Center - 777 Hemlock St, Macon, GA',
    '00435 - Century 20 El Con and XD, Tucson, AZ',
    'CMU Main Campus, Grand Junction, CO',
    'Kansas City #3, NW 64th, Kansas City, MO',
    'Nashville Clinic, Nashville, TN',
    'Edward Don & Company - Woodridge - IL',
  ]) {
    assert.deepEqual(countriesFromLocation(location), ['us'], location);
    assert.equal(isLabelCityState(location), true, location);
  }
});

test('a country named inside that address is dropped with the code', () => {
  assert.deepEqual(countriesFromLocation('Davie Medical Center - 329 NC Highway 801 N, Bermuda Run, NC'), ['us']);
});

test('the same shape outside the US keeps its country', () => {
  const kept = {
    'Toronto, ON, CA': ['ca'],
    'Montreal, Queb, CA': ['ca'],
    // Ontario is also a California city: the province reads first.
    'Brampton, Ontario, CA': ['ca'],
    'Guelph, Ontario, CA': ['ca'],
    // Toronto is one of Canada's own cities, so the address stays as read before.
    'Toronto, San Francisco, CA': ['ca'],
    'Remote, UNAVAILABLE, CA': ['ca'],
    'Tel Aviv-Yafo, Tel Aviv District, IL': ['il'],
    'Bogota, UNAVAILABLE, CO': ['co'],
    'Bengaluru, Karnataka, IN': ['in'],
    'Gandhinagar, Gujarat, IN': ['in'],
    'Casablanca, CasaNearshore, MA': ['ma'],
    'Panama, Panama, PA': ['pa'],
    'CABA, CABA, AR': ['ar'],
    'Lima, Peru, IN': ['pe', 'in'],
    // DE keeps its own town list.
    'Berlin, Berlin, DE': ['de'],
  };
  for (const [location, codes] of Object.entries(kept)) {
    assert.deepEqual(countriesFromLocation(location), codes, location);
    assert.equal(isLabelCityState(location), false, location);
  }
});

test('the bare and street-first shapes read as before', () => {
  assert.deepEqual(countriesFromLocation('Morgan Hill, CA'), ['us']);
  assert.deepEqual(countriesFromLocation('4660 La Jolla Village Dr #100, San Diego, CA'), ['us']);
  assert.deepEqual(countriesFromLocation('HQ - San Diego, CA'), ['us']);
  assert.deepEqual(countriesFromLocation('London, England, GB, GB'), ['gb']);
});

test('an earlier address keeps its own country', () => {
  assert.deepEqual(countriesFromLocation('Toronto, Canada; Streeterville, Chicago, IL').sort(), ['ca', 'us']);
});

test('us-places folds the way postings write towns', () => {
  assert.equal(isUsPlace('nc', 'Winston Salem'), true);
  assert.equal(isUsPlace('nc', 'Winston-Salem'), true);
  assert.equal(isUsPlace('mo', 'St. Louis'), true);
  assert.equal(isUsPlace('ga', 'Macon'), true); // "Macon-Bibb County"
  assert.equal(isUsPlace('tn', 'Nashville'), true); // "Nashville-Davidson metropolitan government"
  assert.equal(isUsPlace('nc', 'Winston'), false);
  assert.equal(isUsPlace('ca', 'Queb'), false);
  assert.equal(isUsPlace('de', 'Wilmington'), false); // DE is left to DELAWARE_TOWNS
  assert.equal(isUsPlace('tx', 'Austin'), false); // TX was never a country: not in the data
});

test('the requeue script marks exactly the label shape', () => {
  assert.equal(needsResend({ location: 'Vida at Morgan Hill, Morgan Hill, CA' }), true);
  assert.equal(needsResend({ location: 'Toronto, ON, CA' }), false);
  assert.equal(needsResend({ location: 'Morgan Hill, CA' }), false);
  assert.equal(needsResend({ location: null }), false);
});

test('a list of places with other codes is not one address', () => {
  assert.equal(isLabelCityState('Boulder, CO, Chicago, IL, New York, NY, Toronto, ON, Atlanta, GA'), false);
  assert.deepEqual(countriesFromLocation('Store 265 - Huntsville, AL - Huntsville, AL'), ['us']);
});
