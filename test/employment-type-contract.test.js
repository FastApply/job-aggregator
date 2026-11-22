const test = require('node:test');
const assert = require('node:assert/strict');
const { extractEmploymentType } = require('../src/utils/extract');

// pref-match loop, 2026-11-22 18h: Century Communities' "Sales Consultant" was stored as Contract
// on "through contract, construction updates, and closing".
test('a contract the job handles is no contract work', () => {
  const century =
    'Many customers use our Buy Online feature. With the combined base salary and our closing bonus program, the total earnings for this role have the potential to exceed six figures annually! Own the customer journey from initial inquiry through contract, construction updates, and closing.';
  assert.equal(extractEmploymentType('Sales Consultant', century), null);
  assert.equal(extractEmploymentType('Procurement Manager', 'Lead contract negotiation and contract management with suppliers.'), null);
  assert.equal(extractEmploymentType('Contracts Administrator', 'Review buyer contracts.'), null);
  assert.equal(extractEmploymentType('Contract Manager', 'Own the contract lifecycle.'), null);
});

test('contract work is still contract', () => {
  assert.equal(extractEmploymentType('Data Analyst (Contract)', 'Join our team.'), 'Contract');
  assert.equal(extractEmploymentType('Data Analyst - Contract', ''), 'Contract');
  assert.equal(extractEmploymentType('Data Analyst (Contract - 6 months)', ''), 'Contract');
  assert.equal(extractEmploymentType('Data Analyst', 'This is a 6-month contract with a possible extension.'), 'Contract');
  assert.equal(extractEmploymentType('Data Analyst', 'This is a contract role.'), 'Contract');
  assert.equal(extractEmploymentType('Sales Rep', 'Structured as an independent contractor role with long-term growth potential.'), 'Contract');
  assert.equal(extractEmploymentType('Developer', 'Contract-to-hire opportunity.'), 'Contract');
  assert.equal(extractEmploymentType('Developer', 'Employment Type: Contract'), 'Contract');
  assert.equal(extractEmploymentType('Writer', 'Freelance, paid per article.'), 'Contract');
  assert.equal(extractEmploymentType('Engineer', 'W2 contract only, no C2C.'), 'Contract');
});

test('full-time and part-time read as before', () => {
  assert.equal(extractEmploymentType('Analyst', 'This is a full-time contract role.'), 'Full-time');
  assert.equal(extractEmploymentType('Analyst', 'Part-time contract.'), 'Part-time');
});
