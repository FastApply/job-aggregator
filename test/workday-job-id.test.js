'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { jobIdOf, isReqId } = require('../src/adapters/workday');

test('a requisition-number bullet stays the id (no churn on working tenants)', () => {
  assert.equal(jobIdOf({ bulletFields: ['0097814'], externalPath: '/job/X/Account-Director_0097814' }), '0097814');
  assert.equal(jobIdOf({ bulletFields: ['R2000727'], externalPath: '/job/X/Analyst_R2000727' }), 'R2000727');
  assert.equal(jobIdOf({ bulletFields: ['JR-12345'], externalPath: '/job/X/Y_JR-12345' }), 'JR-12345');
});

test('a shift or address bullet is not the id: the path suffix is', () => {
  assert.equal(jobIdOf({ bulletFields: ['Day Shift (United States of America)'],
    externalPath: '/job/Woodbury-MN/Physician-Assistant_JR101829' }), 'JR101829');
  assert.equal(jobIdOf({ bulletFields: ['OT228: GNK - FAIRFIELD, NJ 105 FAIRFIELD ROAD, FAIRFIELD, NJ, 07004 USA'],
    externalPath: '/job/Fairfield/Equipment-Sales-Representative_20172128' }), '20172128');
  assert.equal(jobIdOf({ bulletFields: ['Fixed Term (Fixed Term)'], externalPath: '/job/London/Analyst_R-100561-1' }), 'R-100561-1');
});

test('postings sharing a non-id bullet get distinct ids', () => {
  const ps = ['A_JR1', 'B_JR2', 'C_JR3'].map((p) => ({ bulletFields: ['Day Shift (United States of America)'], externalPath: `/job/X/${p}` }));
  assert.equal(new Set(ps.map(jobIdOf)).size, 3);
});

test('no bullet and no suffix falls back to the path', () => {
  assert.equal(jobIdOf({ externalPath: '/job/X/Title' }), '/job/X/Title');
  assert.equal(jobIdOf({ bulletFields: [], externalPath: '/job/X/Title_R9' }), 'R9');
  assert.equal(jobIdOf({}), null);
});

test('isReqId', () => {
  for (const v of ['0097814', 'R2000727', 'JR-12345', 'REQ_2024.17']) assert.equal(isReqId(v), true, v);
  for (const v of ['Full-time', 'United Kingdom', 'New York', 'Day Shift (United States of America)', '', null, 'x'.repeat(41) + '1'])
    assert.equal(isReqId(v), false, String(v));
});
