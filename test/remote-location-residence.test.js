const test = require('node:test');
const assert = require('node:assert');
const { extractWorkplaceType, CONDITIONAL_HOME_WORK } = require('../src/utils/extract');
const { classifyJob } = require('../src/utils/classify');
const { withoutRemoteBoilerplate } = require('../src/utils/remote-boilerplate');

// Rows the 2026-11-22 work-mode retag took off remote and that were put back by hand: the posting
// is remote, its text only names hybrid as an option or the employer's policy, or names where the
// employee must live. Cut to the words that decided them.
const mode = (title, location, text) => {
  const workplace_type = extractWorkplaceType(title, location, text);
  return { workplace_type, is_remote: classifyJob({ title, location, workplace_type, description: text }).is_remote };
};

test('a remote location outranks hybrid words that only offer either mode or a perk', () => {
  for (const [title, location, text] of [
    ['Senior Backend Developer (Elixir)', 'Remote - Netherlands; Poland; Germany', 'What we offer • Hybrid or remote working setup across Amsterdam, the Cologne area, and Poland.'],
    ['Senior Infrastructure Engineer', 'TELECOMMUTE', 'Choose between fully remote work across Europe or relocating to our Athens Tech Hub. Fully Remote / Hybrid (2 days in the office, 3 days remote) - If only'],
    ['Senior Enterprise Sales Manager', 'Remote - United States', 'Superhuman offers a dynamic hybrid model, and candidates in this role can be based remotely.'],
    ['Project Engineer', 'UK - Remote', 'Benefits include • Hybrid working (blend of home and office working to suit individual needs)'],
  ]) assert.deepStrictEqual(mode(title, location, text), { workplace_type: 'remote', is_remote: true }, title);
});

test("the employer's policy for hybrid roles names no mode for this one", () => {
  const text = '**Travel to Office expectations** For Remote Roles: If this role is remote, there will be in-office events. For Hybrid Roles: If this role is Hybrid, there will be an expectation to work from the office 3 days a week.';
  assert.doesNotMatch(withoutRemoteBoilerplate(text), /hybrid/i);
  assert.deepStrictEqual(mode('(US) Principal ML System Engineer', 'Remote, USA', text), { workplace_type: 'remote', is_remote: true });
});

test('hybrid still wins where this job is said to be hybrid or office days are set', () => {
  for (const [title, location, text] of [
    ['Strategic Account Manager', 'Remote', 'This is a hybrid role, with the ability to work from home, when not in customer meetings.'],
    ['AVP, Project Manager', 'Remote - USA', 'In office generally required from 8:30 am – 5:30 pm, Tuesday through Thursday, with the option to work remotely on Mondays and Fridays. Our hybrid model'],
    ['Data Engineer', 'Remote or Mississauga', 'Join our hybrid team. #LI-hybrid'],
    ['Office Manager', 'Austin, TX (Hybrid), Remote', 'Our hybrid work model'],
  ]) assert.strictEqual(mode(title, location, text).workplace_type, 'hybrid', title);
});

test('remote work on a condition of where the employee lives is a remote job', () => {
  for (const [title, location, text] of [
    ['Senior Platform Engineer', 'Chicago, IL, US', 'While this position is listed in Chicago, IL, candidates may work remotely, provided they reside in a state where Verano currently has business operations.'],
    ['Personal Vacation Planner', 'Miami, FL, US', 'Full-time position available to work remotely as long as you live in one of these states: AR, AZ, FL, LA, MN, TX, and WI.'],
    ['Experience Design Director', 'London', 'we are open to this person working remote as long as consistency with UK timezone.'],
    ['IT Service Management Specialist', 'United States', 'Remote States: Candidates residing in the following states will be considered for remote employment: Arizona, Texas. Remote work will not be permitted from any other state at this time.'],
    ['Business System Analyst', 'United States', 'employees must reside in and perform work within the United States. We do not support international remote work arrangements for this role. While this is a remote position, occasional travel'],
  ]) assert.deepStrictEqual(mode(title, location, text), { workplace_type: 'remote', is_remote: true }, title);
});

test('a perk-like condition still reads as no work model', () => {
  for (const text of [
    'our flexible work policy so you can work from home whenever it suits',
    'You can work from home, if the work activity allows',
    'Able to work remotely if required',
    'work remotely when based on business needs',
  ]) {
    assert.match(text, CONDITIONAL_HOME_WORK, text);
    assert.notStrictEqual(mode('Relationship Manager', 'Dubai, AE', text).workplace_type, 'remote', text);
  }
  assert.doesNotMatch('may work remotely, provided they reside in Texas', CONDITIONAL_HOME_WORK);
});

test('an office job that says remote is not considered stays off remote', () => {
  for (const text of [
    'This role requires being onsite in Starbase, TX – remote work will not be considered.',
    'This position does not offer a Work from Home option.',
    'Remote work will not be permitted for this role.',
  ]) assert.notStrictEqual(mode('Technician', 'Starbase, TX', text).workplace_type, 'remote', text);
});

test("the posting's own field saying hybrid still wins over a remote location", () => {
  assert.strictEqual(mode('Program Manager', 'Any Location / Remote', 'Strong human relations skills • Location: Hybrid GDIT IS YOUR PLACE').workplace_type, 'hybrid');
  assert.strictEqual(mode('Program Manager', 'Remote, IT', 'Location: Hybrid or remote within Italy').workplace_type, 'remote');
});
