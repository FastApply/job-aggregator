const test = require('node:test');
const assert = require('node:assert/strict');
const { countriesFromLocation } = require('../src/utils/location-countries');

// Follow-up to the alpha-3 reader (2026-10-30): about 100 US postings were tagged a foreign
// country by a code that is not one there.
test('EST is the US time zone unless the address is Estonian', () => {
  for (const loc of ['Remote - EST', 'Remote, EST', 'Remote- CST/EST', 'EST', 'FL - Virtual - B+ - EST']) {
    assert.ok(!countriesFromLocation(loc).includes('ee'), loc);
  }
  assert.deepEqual(countriesFromLocation('Tallinn, EST'), ['ee']);
});

test("AUS beside Austin is the airport; elsewhere it is Australia", () => {
  assert.ok(!countriesFromLocation('Austin, TX - AUS').includes('au'));
  assert.deepEqual(countriesFromLocation('Austin, TX, USA - AUS'), ['us']);
  assert.deepEqual(countriesFromLocation('Sydney - AUS'), ['au']);
  assert.deepEqual(countriesFromLocation('Melbourne, VIC, AUS'), ['au']);
  assert.deepEqual(
    countriesFromLocation('Location: USA-HI-Halawa, International - Townsville - AUS').sort(), ['au', 'us']);
});

test('a US-ST-City head is the US, and its city is not read as a province', () => {
  assert.deepEqual(countriesFromLocation('US-CA-Ontario'), ['us']);
  assert.deepEqual(countriesFromLocation('US-WA-Seattle'), ['us']);
  assert.deepEqual(countriesFromLocation('USA-VA-Herndon'), ['us']);
  assert.deepEqual(countriesFromLocation('US-MA-Boston; US-NY-New York'), ['us']);
  assert.deepEqual(countriesFromLocation('US-NY-New York; Toronto, ON, CAN').sort(), ['ca', 'us']);
  assert.deepEqual(countriesFromLocation('CAN-ON-Toronto'), ['ca']);
  assert.deepEqual(countriesFromLocation('US-XX-Foo'), []);
});

test('a CA-PR-City head is Canada', () => {
  assert.deepEqual(countriesFromLocation('CA-ON-Toronto'), ['ca']);
  assert.deepEqual(countriesFromLocation('CA-AB-Sherwood Park | US-CT-Danbury').sort(), ['ca', 'us']);
  assert.deepEqual(countriesFromLocation('CA-QC-LONGUEUIL-J01 ~ 1000 Blvd Marie-Victorin ~ J01 BLDG'), ['ca']);
});
