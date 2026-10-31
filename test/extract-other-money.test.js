'use strict';
// Supply loop, 2026-10-31: the first money in a posting was stored as its salary, whatever it was.
const { test } = require('node:test');
const assert = require('node:assert');
const { extractSalary } = require('../src/utils/extract');

test('a commission band after the base pay is not the salary', () => {
  const got = extractSalary(
    'The base salary for the position is $100,000 plus deal issuance commission anticipated between $25,000 - $70,000 , equity, and benefits .'
  );
  assert.notDeepStrictEqual([got?.min, got?.max], ['25000', '70000']);
});

test('a benefit figure is not the salary', () => {
  for (const text of [
    '<ul><li>Medical, Dental, Vision plans</li><li>Adoption, Fertility and Surrogacy Reimbursement up to $10,000</li><li>Paid Time Off</li><li>Student Debt Pay Down – $10,000</li></ul>',
    'Student Debt Pay Down - $10,000',
    'corporate wide bonus plan and educational assistance program offering up to $10,000 a year for graduate courses.',
  ]) {
    assert.strictEqual(extractSalary(text), null, text);
  }
});

test('a real band after other money is still found', () => {
  const got = extractSalary('Sign-on bonus of $5,000 - $10,000. The salary range is $90,000 - $110,000.');
  assert.deepStrictEqual([got.min, got.max], ['90000', '110000']);
});

test('pay stays pay beside the words for other money', () => {
  for (const [text, min, max] of [
    ['Salary range: $120,000 - $150,000 + bonus.', '120000', '150000'],
    ['The total target compensation range for this position, including sales incentives, is $125,100 – $200,200.', '125100', '200200'],
    ['Base salary range $190,000 - $225,000, OTE range $380,000 - $450,000, plus benefits', '190000', '225000'],
    ['Backed by private equity, with $200,000–$250,000 in total annual cash compensation.', '200000', '250000'],
    ['Competitive base salary of $160,000 plus commission.', '160000', '160000'],
  ]) {
    const got = extractSalary(text);
    assert.deepStrictEqual([got?.min, got?.max], [min, max], text);
  }
});

test('the bands the other tests read still read', () => {
  assert.strictEqual(extractSalary('$22 - $28/hr').interval, 'hourly');
  assert.strictEqual(extractSalary('£50k-£70k per year').max, '70000');
});

test('the backfill rereads only a stored figure that is other money', () => {
  const { reread } = require('../scripts/backfill-other-money-salary');
  const sentara = 'Benefits. Adoption, Fertility and Surrogacy Reimbursement up to $10,000 and more.';
  assert.deepStrictEqual(reread({ salary_min: '10000', description: sentara }), {
    min: null, max: null, currency: null, interval: null, minAnnual: null, maxAnnual: null,
  });
  const wisetack = 'The salary is $100,000 a year plus commission anticipated between $25,000 - $70,000 , equity.';
  assert.ok(reread({ salary_min: '25000', description: wisetack }));
  assert.strictEqual(reread({ salary_min: '90000', description: 'Salary: $90,000 - $110,000 plus bonus.' }), null);
  assert.strictEqual(reread({ salary_min: '120000', description: 'Great benefits.' }), null);
});
