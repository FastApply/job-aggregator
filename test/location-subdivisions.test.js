'use strict';
/**
 * Countries written as ISO alpha-3 codes and Australian / Canadian states written as postal codes.
 *
 * Measured on the live board 2026-10-30: every row written "Toronto, ON, CAN" (389 of 389) carried
 * no country, so location=Canada never found it, and the same held for GBR, IND, DEU, BRA and the
 * rest. location=Ontario and location=New South Wales matched only postings that spell the name:
 * "Toronto, ON, Canada" and "Wollongong, NSW, Australia" never do. "Adelaide, SA" was Saudi Arabia.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { countriesFromLocation, resolveCountry } = require('../src/utils/location-countries');
const { buildFilter } = require('../src/db/repositories/jobs-search');
const meili = require('../src/utils/meili');

const is = (text, codes) => assert.deepEqual(countriesFromLocation(text).sort(), [...codes].sort(), text);

test('an alpha-3 country code ending an address is that country', () => {
  is('Toronto, ON, CAN', ['ca']);
  is('Pointe-Claire, QC, CAN', ['ca']);
  is('Gurugram, HR, IND', ['in']);
  is('Sao Paulo, SP, BRA', ['br']);
  is('Dublin, IRL', ['ie']);
  is('Dubai, ARE', ['ae']);
  is('Huangpu, Shanghai - CHN', ['cn']);
  is('Zurich, Zurich, CHE', ['ch']);
});

test('an alpha-3 code heading an address is that country', () => {
  is('AUS - NSW - MACQUARIE PARK', ['au']);
  is('ITA-Milan-Piazza Armando Diaz 2', ['it']);
  is('ZAF - Gauteng - Isando', ['za']);
  is('NLD - Oss - Molenstraat', ['nl']);
});

test('several addresses in one string are read one by one', () => {
  is('Boeblingen, DEU / Munich, BY, DEU', ['de']);
  is('Toronto, ON, CAN; Chicago, IL, USA', ['ca', 'us']);
  is('Birmingham, GBR / Ghent, BE, BEL', ['gb', 'be']);
});

test('an alpha-3 code needs capitals and the edge of an address', () => {
  is('Can Tho, Vietnam', ['vn']);
  assert.deepEqual(countriesFromLocation('Client Site - IND - Che - PDS'), [],
    'mid-address, and "Che" here is Chennai');
  is('Zhangjiang, ARE-SH, CHN', ['cn']);
  assert.deepEqual(countriesFromLocation('Remote - people who are based anywhere'), []);
});

test('an address ending in a province or state code with no country', () => {
  is('Ottawa, ON', ['ca']);
  is('Toronto ON', ['ca']);
  is('Calgary, AB', ['ca']);
  is('Montreal, QC', ['ca']);
  is('Newcastle, NSW', ['au']);
  is('Sydney NSW', ['au']);
  is('Brisbane QLD', ['au']);
  is('Melbourne VIC 3000', ['au']);
  is('Hobart, TAS', ['au']);
  is('Canberra, ACT', ['au']);
});

test('colliding codes count only beside a city of that province', () => {
  is('Vancouver, BC', ['ca']);
  is('Winnipeg, MB', ['ca']);
  is('Halifax, NS', ['ca']);
  is('Moncton, NB', ['ca']);
  is('Yellowknife, NT', ['ca']);
  is('Darwin, NT', ['au']);
  is('Adelaide, SA', ['au']);
  is('Regina, SK', ['ca']);
  is("St. John's, NL", ['ca']);
  is('Charlottetown, PE', ['ca']);
  // ... and keep their other meaning everywhere else.
  is('Riyadh, SA', ['sa']);
  is('Bratislava, SK', ['sk']);
  is('Amsterdam, NL', ['nl']);
  is('Lima, PE', ['pe']);
  assert.deepEqual(countriesFromLocation('Tijuana, BC'), [], 'Baja California');
  assert.deepEqual(countriesFromLocation('Eindhoven, NB'), [], 'Noord-Brabant');
});

test('a named country always wins over a code that looks like a province', () => {
  is('Concorezzo, MB, Italy', ['it']);
  is('Sydney, NS, AU', ['au']);
  is('Tas-Sliema, Malta', ['mt']);
  is('Waverley, TAS, ZA', ['za']);
  is('Burton-on-Trent, England, United Kingdom', ['gb']);
});

test('a province name is its country at index time', () => {
  is('London, Ontario', ['ca']);
  is('Quebec City, Quebec', ['ca']);
  is('Victoria, British Columbia', ['ca']);
  is('Toronto, Ontario, CA', ['ca']);
  is('Vancouver, British Columbia, CA, V6B 1A9', ['ca']);
  is('Brisbane, Queensland', ['au']);
  is('Melbourne, Victoria', ['au']);
  is('Carlton, Victoria 3053', ['au']);
});

test('US places sharing a province name stay in the US', () => {
  is('Ontario, CA', ['us']);
  is('Ontario, California', ['us']);
  is('Yukon, OK', ['us']);
  is('Newfoundland, NJ', ['us']);
  is('Alberta, VA', ['us']);
  is('Santa Ana, CA, US; Ontario, CA, US; Remote, CA, US', ['us']);
  is('Toronto Paseo, Ontario, CA 91761, United States', ['us']);
  assert.deepEqual(countriesFromLocation('1769 Ontario, CA - California Core'), []);
});

test('US and existing readings are unchanged', () => {
  is('Seattle, WA', ['us']);
  is('Perth, WA', ['au']);
  is('Austin, TX', ['us']);
  is('Toronto, ON, CA', ['ca']);
  is('Toronto, ON, Canada; Chicago, IL, USA', ['ca', 'us']);
});

test('a province search is never a country search', () => {
  assert.equal(resolveCountry('Ontario'), null, 'Ontario must not widen to all of Canada');
  assert.equal(resolveCountry('Queensland'), null);
  assert.equal(resolveCountry('CAN'), null);
});

test('a state or province name also matches its code, only inside its country', () => {
  assert.equal(buildFilter({ location: 'New South Wales' }).filter,
    '((location_tokens = "new south wales" OR (location_tokens = "nsw" AND location_countries = "au")))');
  assert.equal(buildFilter({ location: 'Ontario' }).filter,
    '((location_tokens = "ontario" OR (location_tokens = "on" AND location_countries = "ca")))');
  assert.match(buildFilter({ location: 'British Columbia' }).filter,
    /\(location_tokens = "bc" AND location_countries = "ca"\)/);
  assert.match(buildFilter({ location: 'Queensland' }).filter,
    /\(location_tokens = "qld" AND location_countries = "au"\)/);
  assert.match(buildFilter({ location: 'Western Australia' }).filter,
    /\(location_tokens = "wa" AND location_countries = "au"\)/);
});

test('the code clause matches how these postings are actually indexed', () => {
  const doc = (location) => meili.toDocument({ id: 1, title: 'x', location, company_id: 1 });
  const toronto = doc('Toronto, ON, CAN');
  assert.ok(toronto.location_tokens.includes('on'));
  assert.ok(toronto.location_countries.includes('ca'));
  const newcastle = doc('Newcastle, NSW');
  assert.ok(newcastle.location_tokens.includes('nsw'));
  assert.ok(newcastle.location_countries.includes('au'));
});

test('an ordinary place is unchanged', () => {
  assert.equal(buildFilter({ location: 'Sydney' }).filter, '((location_tokens = "sydney"))');
  assert.equal(buildFilter({ location: 'Illinois' }).filter,
    '((location_tokens = "illinois" OR (location_tokens = "il" AND location_countries = "us")))');
});
