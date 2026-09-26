'use strict';
/**
 * The canary's judgement must be right in both directions: it has to FIRE on the bug that has
 * shipped three times (a page carrying only the first role), and it must NOT fire on a healthy
 * page just because a title is worded loosely.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { missingRoles, PAIRS } = require('../src/tasks/search-canary');

test('a healthy page carries both roles — nothing missing', () => {
  const titles = ['Registered Nurse - ICU', 'Senior Accountant', 'Registered Nurse (Nights)', 'Staff Accountant'];
  assert.deepEqual(missingRoles(titles, ['Registered Nurse', 'Accountant']), []);
});

test('the bug: a page of only the first role names the second as missing', () => {
  // Exactly what prod returned 2026-08-06..09-17 for every multi-role query.
  const titles = Array.from({ length: 50 }, (_, i) => `Registered Nurse ${i}`);
  assert.deepEqual(missingRoles(titles, ['Registered Nurse', 'Accountant']), ['Accountant']);
  assert.deepEqual(missingRoles(titles, ['Accountant', 'Registered Nurse']), ['Accountant'],
    'order must not change the verdict — whichever role is absent is reported');
});

test('an empty page reports every role, so an outage is never read as healthy', () => {
  assert.deepEqual(missingRoles([], ['Registered Nurse', 'Accountant']), ['Registered Nurse', 'Accountant']);
});

test('loosely worded titles still count for their role', () => {
  assert.deepEqual(missingRoles(['Nurse, Registered — Oncology', 'Accountant II'], ['Registered Nurse', 'Accountant']), []);
});

test('the pairs are disjoint: one title cannot satisfy both roles', () => {
  for (const [a, b] of PAIRS) {
    assert.deepEqual(missingRoles([a], [a, b]), [b], `${a} must not read as ${b}`);
    assert.deepEqual(missingRoles([b], [a, b]), [a], `${b} must not read as ${a}`);
  }
});

const { recallChecks } = require('../src/tasks/search-canary');
const job = (id, over = {}) => ({ id, title: `Nurse ${id}`, company: { id: 7 }, employment_type: null, location: null, ...over });

test('recall probe: a raw employment type is re-asked for by its canonical filter', () => {
  const [c] = recallChecks([job(1, { employment_type: 'Full time' })]);
  assert.equal(c.id, 1);
  assert.equal(c.filter, 'employment_type=full-time');
  assert.match(c.qs, /company_id=7/);
  assert.equal(c.control, c.qs.replace('&employment_type=full-time', ''), 'the control is the same query without the filter');
  assert.match(c.qs, /q=Nurse%201/);
});

test('recall probe: only unambiguous US "City, ST" rows are probed against United States', () => {
  const checks = recallChecks([
    job(1, { location: 'Austin, TX' }),
    job(2, { location: 'San Francisco, CA' }), // CA is also Canada: not the probe's call to make
    job(3, { location: 'Paris, France' }),
  ]).filter((c) => c.filter === 'location=United States');
  assert.deepEqual(checks.map((c) => c.id), [1]);
});

test('recall probe stays small', () => {
  const many = Array.from({ length: 50 }, (_, i) => job(i + 1, { employment_type: 'Full-time', location: 'Austin, TX' }));
  assert.equal(recallChecks(many).length, 4);
});

test('recall probe skips rows it cannot re-query', () => {
  assert.deepEqual(recallChecks([{ id: 1, title: 'x', employment_type: 'Full-time' }]), []);
});
