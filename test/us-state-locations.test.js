'use strict';
/**
 * A US address that never spells out the country must still be tagged us, and a state must
 * never turn a US job into another country.
 *
 * Measured 2026-09-26 on a 2% sample of live jobs: 38% of US jobs carried no country code
 * ("Austin, TX", "Buffalo, New York"), so location=United States could not find them, and
 * "Niagara Falls, United States" returned 2 of one employer's 106 Niagara Falls jobs. Others
 * were tagged the WRONG country from a word inside the address: "Albuquerque, New Mexico" was
 * Mexico, "Jersey City, NJ" Jersey, "Atlanta, Georgia" Georgia, "Lebanon, Tennessee" Lebanon.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { countriesFromLocation } = require('../src/utils/location-countries');

const is = (text, codes) => assert.deepEqual(countriesFromLocation(text).sort(), [...codes].sort(), text);

test('bare "City, ST" is the US', () => {
  for (const loc of ['Austin, TX', 'Salamanca, NY', 'Spokane, WA', 'Miami, FL', 'Portland, OR',
    'Nashville, TN', 'Washington, D.C.', 'St. Louis, MO', 'Remote, TX']) is(loc, ['us']);
});

test('state codes that are also country codes read as the state in a US city', () => {
  for (const loc of ['San Francisco, CA', 'Indianapolis, IN', 'Richmond, VA', 'Denver, CO',
    'Atlanta, GA', 'Wilmington, DE', 'Newark, DE', 'Boise, ID', 'Chicago, IL', 'Boston, MA',
    'Baltimore, MD', 'Charlotte, NC', 'Little Rock, AR', 'Bozeman, MT']) is(loc, ['us']);
});

test('a foreign city next to a colliding code is that country, not the US', () => {
  is('Montreal, CA', ['ca']);
  is('Montréal, CA', ['ca']);
  is('Pune, IN', ['in']);
  is('Bengaluru, IN', ['in']);
  is('Chennai, TN', ['in']);
  is('Perth, WA', ['au']);
  is('Bogota, CO', ['co']);
  is('Buenos Aires, AR', ['ar']);
  is('Jakarta, ID', ['id']);
  is('Sliema, MT', ['mt']);
  is('Tel Aviv, IL', ['il']);
});

test('DE is Delaware only for Delaware towns', () => {
  is('Berlin, DE', ['de']);
  is('München, DE', ['de']);
  is('Mehrere Standorte, DE', ['de']);
  is('Dover, DE', ['us']);
});

test('spelled-out states are the US', () => {
  for (const loc of ['Buffalo, New York', 'Concord, California', 'New Braunfels, Texas',
    'RICHMOND, Virginia', 'Seattle, Washington', 'Remote - Texas', 'Texas',
    'Niagara Falls, New York, United States', 'Austin, Texas, 78701']) is(loc, ['us']);
});

test('a country named inside a US address is not that country', () => {
  is('Albuquerque, New Mexico', ['us']);
  is('Newark, New Jersey', ['us']);
  is('Jersey City, NJ', ['us']);
  is('Jersey City, NJ, US', ['us']);
  is('Atlanta, Georgia', ['us']);
  is('Lebanon, Tennessee', ['us']);
  is('Peru, Indiana', ['us']);
  is('Mexico, Missouri, USA', ['us']);
});

test('Georgia the country still resolves', () => {
  is('Tbilisi, Georgia', ['ge']);
  is('Georgia', ['ge', 'us']);
  is('Georgia, United States', ['us']);
});

test('a state name that is not at the end of the address is a foreign place', () => {
  is('Montana, Bulgaria', ['bg']);
  is('Florida, Uruguay', ['uy']);
  is('Washington, Tyne and Wear, United Kingdom', ['gb']);
});

test('a state code in the middle is not read unless the US follows it', () => {
  is('Chennai, TN, IN', ['in']);
  is('Toronto, ON, CA', ['ca']);
  is('Navi Mumbai, Maharashtra, IN, IN', ['in']);
  is('London, England, GB, GB', ['gb']);
  is('Indianapolis, IN, US', ['us']);
});

test('territories are both the US and their own code', () => {
  is('San Juan, PR', ['us', 'pr']);
  is('San Juan, Puerto Rico', ['us', 'pr']);
});

test('a country named earlier in a multi-place string is kept', () => {
  is('London, United Kingdom / Austin, Texas', ['gb', 'us']);
});

test('unchanged: shapes with no US state', () => {
  is('Remote - United States', ['us']);
  is('London, England, GB, GB', ['gb']);
  is('Toronto, ON', []);
  is('Madrid, España', ['es']);
});

test('a lowercase ISO code is the country, whatever state it collides with', () => {
  // One source writes "City, cc" in lowercase ISO: "Paris, fr", "Chicago, us". Every lowercase
  // code in the corpus that collides with a state was that country.
  is('Berlin, de', ['de']);
  is('Pune, in', ['in']);
  is('Boucherville, ca', ['ca']);
  is('Bogotá, co', ['co']);
  is('Chicago, us', ['us']);
  // Uppercase stays the state, and a code that is no country is always the state.
  is('Boucherville, CA', ['us']);
  is('Austin, tx', ['us']);
});

test('addresses joined by ";" keep each country', () => {
  is('Toronto, ON, Canada; San Francisco, CA, USA', ['ca', 'us']);
  is('Toronto, ON, Canada; Chicago, IL, USA', ['ca', 'us']);
  is('London, United Kingdom; Austin, TX', ['gb', 'us']);
});

test('Georgian script before "Georgia" is the country', () => {
  is('თბილისი, , Georgia', ['ge']);
});

test('a list of US states is not the country Georgia', () => {
  is('Georgia, North Carolina, South Carolina, Tennessee', ['us']);
});

test('"Georgia" inside a list of US addresses is the state; after Tbilisi it is the country', () => {
  is('Atlanta, Georgia; Austin, Texas; Cleveland, Ohio', ['us']);
  is('Tbilisi, Georgia; Austin, TX', ['ge', 'us']);
});

test('an all-lowercase address is not read as ISO just for being lowercase', () => {
  is('san francisco, ca', ['us']);
  is('indianapolis, in', ['us']);
});
