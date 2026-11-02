const test = require('node:test');
const assert = require('node:assert/strict');
const { extractWorkplaceType } = require('../src/utils/extract');
const { classifyRemote } = require('../src/utils/classify');

// Convergint's pay note, on every UKG posting it has (anonymised to the sentence).
const PAY_NOTE = 'The salary is the target market range within the primary geographic region the requisition is posted. If the position is posted in multiple locations or is a remote position, the salary range may vary.';

test('a pay note about remote positions tags nothing', () => {
  const text = `Convergint is looking for an Operations Manager. ${PAY_NOTE}`;
  assert.equal(extractWorkplaceType('Operations Manager 2', 'Renton, WA, USA', text), null);
  assert.equal(classifyRemote('Operations Manager 2', 'Renton, WA, USA', null, text), false);
});

test('the same words as a statement of fact still read as remote', () => {
  const text = `This is a remote position. ${PAY_NOTE}`;
  assert.equal(extractWorkplaceType('Operations Manager', 'Renton, WA, USA', text), 'remote');
  assert.equal(classifyRemote('Operations Manager', 'Renton, WA, USA', null, text), true);
});

test('"where you will work" and an address to the reader are not conditions', () => {
  assert.equal(extractWorkplaceType('Manager', 'Sacramento, California', "Where You'll Work This is a REMOTE role open to candidates based in US or Europe."), 'remote');
  assert.equal(extractWorkplaceType('Manager', 'Texas', "Where you'll be working In this remote role, you have flexibility."), 'remote');
});

test('conditions in other words', () => {
  for (const line of [
    'Pay may differ if this is a remote role.',
    'Benefits vary if the job is a remote job.',
    'Unless this is a remote position, you report to the office.',
  ]) {
    assert.equal(extractWorkplaceType('Analyst', 'Austin, TX', line), null, line);
  }
});

test('"all remote employees" is about the people, not the job', () => {
  const text = "The Inside Sales & Office Manager oversees the inside sales team and all remote employees reporting to that office, in the remote office.";
  assert.equal(extractWorkplaceType('Inside Sales & Office Manager', 'Newport Beach, California, United States', text), null);
});

test('an all-remote company still reads as remote', () => {
  assert.equal(extractWorkplaceType('Designer', 'Austin, TX', 'We are an all-remote company.'), 'remote');
  assert.equal(extractWorkplaceType('Designer', 'Austin, TX', 'Our team is all remote.'), 'remote');
});
