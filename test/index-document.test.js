'use strict';
/**
 * The index must hold the value the search filters on. jobs-search buildFilter normalises
 * employment_type=full-time to "Full-time" and matches it exactly (Meilisearch equality ignores
 * case, not separators), so a document carrying the raw "Full time" was invisible to the filter.
 * Measured 2026-09-26: 21% of full-time jobs, 57% of temporary.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { toDocument } = require('../src/utils/meili');
const { buildFilter } = require('../src/db/repositories/jobs-search');

const doc = (employment_type) => toDocument({ id: 1, title: 't', employment_type });

test('raw employment types are indexed as the canonical value the filter asks for', () => {
  for (const raw of ['Full time', 'full_time', 'FullTime', 'FULL_TIME', 'Full Time',
    'fulltime_permanent', 'Regular Full-Time', '["FULL_TIME"]', 'Permanent']) {
    assert.equal(doc(raw).employment_type, 'Full-time', raw);
  }
  assert.equal(doc('Part time').employment_type, 'Part-time');
  assert.equal(doc('PART_TIME').employment_type, 'Part-time');
  assert.equal(doc('Contractor').employment_type, 'Contract');
  assert.equal(doc('Temp').employment_type, 'Temporary');
  assert.equal(doc('Intern').employment_type, 'Internship');
});

test('the indexed value is exactly what the filter compares against', () => {
  const { filter } = buildFilter({ employmentType: 'full-time' });
  assert.ok(filter.includes(`"${doc('full_time').employment_type}"`), filter);
});

test('a value the normaliser cannot place keeps its raw text for display', () => {
  assert.equal(doc('Hourly').employment_type, 'Hourly');
  assert.equal(doc(null).employment_type, null);
  assert.equal(doc('').employment_type, null);
});

