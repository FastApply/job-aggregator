const test = require('node:test');
const assert = require('node:assert');
const { deriveCompany } = require('../src/tasks/demand-crawl');
const { workableFeedCompany, employerSlugOfUrl, nameOfSlug } = require('../src/utils/workable-feed-company');

const view = (rest) => `https://jobs.workable.com/view/gEKTQXxvSiqyirjUny3YFr/${rest}`;

test('a marketplace link is filed under the employer in its own URL, not its first path word', () => {
  // Filed under "Digitals AI Inc" on 2026-10-30, with 6,372 other live rows.
  const c = deriveCompany(view('remote-senior-qa-automation-engineer-in-united-states-at-dispel'), 'workable', 'Dispel', 'liftmycv');
  assert.strictEqual(c.ats, 'workable');
  assert.strictEqual(c.slug, 'wjb_name_dispel');
  assert.strictEqual(c.careerUrl, 'https://jobs.workable.com/company-name/dispel');
  const other = deriveCompany(view('hybrid-director-of-marketing-in-milan-at-empatica'), 'workable', 'Empatica', 'liftmycv');
  assert.notStrictEqual(other.careerUrl, c.careerUrl);
});

test('an escaped employer in the URL reads the same as the name', () => {
  assert.strictEqual(employerSlugOfUrl(view('platform-engineer-in-chantilly-at-avalore%2C-llc')), 'avalore-llc');
  assert.strictEqual(nameOfSlug('super-soccer-stars'), 'Super Soccer Stars');
});

test('a short link has only the feed name; with none the row is dropped', () => {
  const url = 'https://apply.workable.com/j/A68D795201';
  assert.strictEqual(deriveCompany(url, 'workable', 'Runware', 'liftmycv').slug, 'wjb_name_runware');
  assert.strictEqual(deriveCompany(url, 'workable', '', 'liftmycv').careerUrl, null);
  assert.strictEqual(workableFeedCompany(url, ''), null);
});

test('an account link keeps its account', () => {
  const c = deriveCompany('https://apply.workable.com/acme/j/ABC123/', 'workable', 'Acme', 'liftmycv');
  assert.strictEqual(c.slug, 'acme');
  assert.strictEqual(c.careerUrl, 'https://apply.workable.com/acme');
});
