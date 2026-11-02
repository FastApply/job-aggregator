const test = require('node:test');
const assert = require('node:assert/strict');
const { extractWorkplaceType } = require('../src/utils/extract');
const { classifyRemote, classifyRemoteWorldwide } = require('../src/utils/classify');

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

test('a month of work from anywhere is a perk, not the job', () => {
  const perks = 'Company perks program. One month work from anywhere policy (with the exception of a few positions and countries).';
  assert.equal(extractWorkplaceType('Staff Back End Engineer, Data', 'Los Angeles, CA', perks), null);
  assert.equal(classifyRemote('Staff Back End Engineer, Data', 'Los Angeles, CA', null, perks), false);
  assert.equal(extractWorkplaceType('Analyst', 'Boston, MA', 'Benefits: 4 weeks of work from anywhere each year.'), null);
  assert.equal(extractWorkplaceType('Analyst', 'Boston, MA', 'We have a generous work from anywhere policy.'), null);
});

test('work from anywhere as the job still reads as remote', () => {
  assert.equal(extractWorkplaceType('Designer', 'Austin, TX', 'Our team can work from anywhere.'), 'remote');
  assert.equal(classifyRemote('Designer', 'Austin, TX', null, 'Our team can work from anywhere.'), true);
});

test('a chance of remote work is not a remote job', () => {
  assert.equal(extractWorkplaceType('Procurement Analyst', 'New York, NY, United States', 'This position may be eligible for remote work up to 2 days per week, pursuant to the Remote Work Pilot Program.'), null);
  assert.equal(extractWorkplaceType('Operations Manager', 'KS - Overland Park', 'This position may be eligible for remote work in select geographic locations, subject to approval by PNC.'), null);
});

test('"may be remote" and "is eligible for remote work" still read as remote', () => {
  assert.equal(extractWorkplaceType('Analyst', 'Austin, TX', 'This role may be fully remote.'), 'remote');
  assert.equal(extractWorkplaceType('Analyst', 'Austin, TX', 'This position is eligible for remote work.'), 'remote');
});

test('one work-from-home day is not a remote job', () => {
  const text = 'Capstone is in-person Monday through Thursday with flexible work from home Fridays.';
  assert.notEqual(extractWorkplaceType('Research Analyst', 'Washington, DC', text), 'remote');
});

test('work from anywhere in one country is not worldwide', () => {
  const text = 'Certification and wellness reimbursement programs. Work from anywhere in the US';
  assert.equal(classifyRemote('Senior Director of Planners', null, null, text), true);
  assert.equal(classifyRemoteWorldwide('Senior Director of Planners', null, text, true), false);
  assert.equal(classifyRemoteWorldwide('Support Lead', null, 'Work from anywhere in the world.', true), true);
});
