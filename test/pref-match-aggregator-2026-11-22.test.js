'use strict';
/**
 * pref-match loop 2026-11-22 00h: two field rules for aggregator rows (src/utils/aggregator-fields.js).
 *
 * - A long multi-office list is kept whole, and cut only after a whole place: the 300-character
 *   cut dropped Houston, TX from Southland Industries' "Project Manager" and ended it on "; F".
 * - A scraped heading is never a company name: Workable's kent-companies was named
 *   "Description This", and so were other employers, which made them one company downstream.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LOCATION_CAP, cutLocationList, cutLocationSql, isArtifactCompanyName, realCompanyNameSql, ARTIFACT_COMPANY_PATTERN,
} = require('../src/utils/aggregator-fields');
const { planRepairs } = require('../scripts/repair-aggregator-cut-locations');
const { workableName } = require('../scripts/repair-artifact-company-names');

// Southland's offices as aiapply lists them (49 in all; enough here to pass 300 characters).
const SOUTHLAND = [
  'Abilene, Texas, United States', 'Amarillo, Texas, United States', 'Austin, Texas, United States',
  'Beltsville, Maryland, United States', 'Brandywine, Maryland, United States', 'Corpus Christi, Texas, United States',
  'Dallas, Texas, United States', 'Dulles, Virginia, United States', 'El Paso, Texas, United States',
  'Fort Worth, Texas, United States', 'Houston, Texas, United States', 'San Antonio, Texas, United States',
].join('; ');

test('the whole office list is kept: Houston is no longer cut off', () => {
  assert.ok(SOUTHLAND.length > 300);
  assert.equal(cutLocationList(SOUTHLAND), SOUTHLAND);
  assert.match(cutLocationList(SOUTHLAND), /Houston, Texas, United States/);
});

test('a list past the cap is cut after its last whole place, never inside one', () => {
  const cut = cutLocationList(SOUTHLAND, 300);
  assert.ok(cut.length <= 300);
  assert.ok(SOUTHLAND.startsWith(cut));
  assert.match(cut, /El Paso, Texas, United States$/);
  assert.doesNotMatch(cut, /; F$/);
  // The cut falling exactly on a separator keeps the place before it.
  const two = 'A, B; C, D';
  assert.equal(cutLocationList(two, 4), 'A, B');
});

test('short, empty and single-place locations are left as they are', () => {
  assert.equal(cutLocationList('Remote'), 'Remote');
  assert.equal(cutLocationList(null), null);
  const long = 'x'.repeat(LOCATION_CAP + 10);
  assert.equal(cutLocationList(long), 'x'.repeat(LOCATION_CAP), 'one place with no separator: a plain cut');
});

test('the SQL cut is the same rule over the same cap', () => {
  const sql = cutLocationSql('location');
  assert.match(sql, new RegExp(`length\\(\\(location\\)\\) <= ${LOCATION_CAP}`));
  assert.match(sql, new RegExp(`left\\(\\(location\\), ${LOCATION_CAP + 1}\\)`));
  assert.match(sql, /regexp_replace\(.*';\[\^;\]\*\$'/);
  assert.doesNotMatch(sql, /left\(\(location\), 300\)/);
});

test('scraped headings and placeholders are not company names', () => {
  for (const name of ['Description This', 'description', 'Company Description', 'Company Description This',
    'About Us', 'Job Description', 'Company Overview', 'Unknown', 'Unknown Company', 'N/A', ' n/a ', '', null]) {
    assert.equal(isArtifactCompanyName(name), true, String(name));
  }
});

test('real employers whose names contain those words stand', () => {
  for (const name of ['Kent Companies', 'Description Technologies', 'Unknown Worlds Entertainment', 'About Time Ltd',
    'NA Holdings', 'Raydar']) {
    assert.equal(isArtifactCompanyName(name), false, name);
  }
});

test('the SQL filter carries the same pattern, quoted for a literal', () => {
  const sql = realCompanyNameSql('company_name');
  assert.ok(sql.includes(ARTIFACT_COMPANY_PATTERN));
  assert.match(sql, /company_name !~\* '/);
  assert.match(sql, /nullif\(btrim\(company_name\), ''\) IS NOT NULL/);
});

test('repair: only rows the mapper cut, and only to the longer list', () => {
  const url = 'https://southland.wd504.myworkdayjobs.com/External/job/Garden-Grove-CA/Project-Manager_R-2000003';
  const cut = SOUTHLAND.slice(0, 300);
  const full = new Map([[url, SOUTHLAND], ['https://x/rewritten', SOUTHLAND]]);
  const plan = planRepairs([
    { id: 1, url, location: cut },
    { id: 2, url: 'https://x/rewritten', location: 'y'.repeat(300) }, // a crawler rewrote it since
    { id: 3, url: 'https://x/unknown', location: cut },               // not a feed posting
  ], full);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].id, 1);
  assert.equal(plan[0].to, SOUTHLAND);
});

test('repair: the Workable widget name is taken only when it is a real name', async () => {
  const fake = (body, ok = true) => async () => ({ ok, json: async () => body });
  assert.equal(await workableName('kent-companies', fake({ name: 'Kent Companies' })), 'Kent Companies');
  assert.equal(await workableName('x', fake({ name: 'Description This' })), null);
  assert.equal(await workableName('x', fake({}, false)), null);
  assert.equal(await workableName('x', async () => { throw new Error('offline'); }), null);
});
