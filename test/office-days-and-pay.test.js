'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { extractWorkplaceType, extractSalary, statesRemote } = require('../src/utils/extract');

// pref-match audit, 2026-10-30: each applied to for a candidate who works remotely only or whose
// floor sits above the pay, because the row said otherwise. Real postings, cut to the words.
test('named days in the office are hybrid, whatever a WFH day says', () => {
  const ketryx = 'Office Hours: Monday, Tuesday, Thursday, Friday in office, Wednesday WFH option Location: Boston';
  const performix = 'Location: Fairfield, OH (M-Th on site, F – WFH) Duration: 3 months';
  assert.equal(extractWorkplaceType('Sales Engineer', 'Boston, Massachusetts', ketryx), 'hybrid');
  assert.equal(extractWorkplaceType('Finance Analyst', 'Fairfield, United States', performix), 'hybrid');
  assert.equal(statesRemote('Sales Engineer', ketryx), false);
});

test('Zoho text stored as a script string reads the same', () => {
  const escaped = 'Location:\\\nFairfield, OH (M\\-Th on site, F \\\\u2013 WFH)Duration:\\\n3 months';
  assert.equal(extractWorkplaceType('Finance Analyst', 'Fairfield, United States', escaped), 'hybrid');
});

test('a WFH perk is not a work model, WFH on its own still is', () => {
  assert.equal(statesRemote('Analyst', 'Enjoy a generous WFH allowance and free lunch.'), false);
  assert.equal(statesRemote('Analyst', 'Work setup: WFH, anywhere in the country.'), true);
  assert.equal(statesRemote('Analyst', 'Office hours Monday - Friday on site for visitors. Location: Remote'), true);
});

test('a range with the code after each figure is a range', () => {
  const hitachi = 'the expected base salary for this position is: $53K USD to $70K USD. Expected on-target earnings';
  assert.deepEqual(extractSalary(hitachi), { min: '53000', max: '70000', currency: 'USD', interval: 'yearly' });
  assert.deepEqual(extractSalary('Compensation: $100,000 - $120,000 base'), { min: '100000', max: '120000', currency: 'USD', interval: 'yearly' });
});
