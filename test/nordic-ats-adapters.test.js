'use strict';
/** Visma Recruit, Recman, HR-Manager and Talentadore: the offline parts, shapes taken from live answers 2026-10-22. */
const test = require('node:test');
const assert = require('node:assert/strict');
const visma = require('../src/adapters/visma');
const recman = require('../src/adapters/recman');
const hrmanager = require('../src/adapters/hrmanager');
const talentadore = require('../src/adapters/talentadore');
const { countriesFromLocation } = require('../src/utils/location-countries');

const hit = {
  id: '31631355',
  headline: 'Lärare i ma/no åk 7-9',
  publication_date: '2026-10-22T11:25:13',
  application_deadline: '2026-11-08T23:59:59',
  description: { text_formatted: 'Första stycket.\n\nAndra stycket <med> tecken.' },
  employment_type: { label: 'Vanlig anställning' },
  duration: { label: 'Tills vidare' },
  working_hours_type: { label: 'Heltid' },
  employer: { name: 'Kristinehamns kommun', organization_number: '2120001868' },
  application_details: { url: 'https://recruit.visma.com/spa/public/apply?guidAssignment=68D1239C-dfd1-44d5-b04c-474c77b26c47&publishCode=PB&TK=x', reference: 'C350927' },
  workplace_address: { municipality: 'Kristinehamn', region: 'Värmlands län', country: 'Sverige' },
};

test('visma: an open ad that takes applications without an account becomes a job', () => {
  const j = visma.toJob(hit, { Status: 1, HasApplyWithoutAccountMode: true, Assignment: { Title: 'Lärare i matematik', AdDescription: '<p>Visma text</p>' } });
  assert.equal(j.external_id, 'visma_68d1239c-dfd1-44d5-b04c-474c77b26c47');
  assert.equal(j.title, 'Lärare i matematik');
  assert.equal(j.description, '<p>Visma text</p>');
  assert.equal(j.location, 'Kristinehamn, Sverige');
  assert.deepEqual(countriesFromLocation(j.location), ['se']);
  assert.equal(j.employment_type, 'Full-time');
  assert.equal(j.url, hit.application_details.url);
});

test('visma: closed ads and account-only ads are left out', () => {
  assert.equal(visma.toJob(hit, { Status: 3, HasApplyWithoutAccountMode: true }), null);
  assert.equal(visma.toJob(hit, { Status: 2, HasApplyWithoutAccountMode: true }), null);
  assert.equal(visma.toJob(hit, { Status: 1, HasApplyWithoutAccountMode: false }), null);
});

test('visma: when the settings check fails the Platsbanken ad is kept, text as paragraphs', () => {
  const j = visma.toJob(hit, null);
  assert.equal(j.title, hit.headline);
  assert.equal(j.description, '<p>Första stycket.</p>\n<p>Andra stycket &lt;med&gt; tecken.</p>');
  assert.equal(j.raw_data.checked, false);
});

test('visma: the board is a 10-digit organisation number', async () => {
  assert.equal(visma.orgNumber('212000-1868'), '2120001868');
  assert.equal(visma.orgNumber('kristinehamn'), null);
  await assert.rejects(visma.fetchJobs('kristinehamn'), /HTTP 404/);
});

test('recman: board hosts, addresses and employment wording', () => {
  assert.equal(recman.baseUrl('prowork'), 'https://prowork.recman.page');
  assert.equal(recman.baseUrl('prowork.recman.io'), 'https://prowork.recman.page');
  assert.equal(recman.baseUrl('www.iqjobb.se'), 'https://www.iqjobb.se');
  assert.equal(recman.placeFromAddress('Astraallén 3, 152 57 Södertälje, Sverige'), 'Södertälje, Sweden');
  assert.equal(recman.placeFromList('Sverige, Eskilstuna'), 'Eskilstuna, Sweden');
  assert.equal(recman.employmentType({ Extent: 'Vikariat' }, null), 'Temporary');
  assert.equal(recman.employmentType({ EmploymentType: 'Heltid' }, null), 'Full-time');
});

test('hrmanager: slug is an alias, optionally with the media ids it publishes to', () => {
  assert.deepEqual(hrmanager.parseSlug('bilia'), { alias: 'bilia', mediaIds: [] });
  assert.deepEqual(hrmanager.parseSlug('lfv1:5559,5,5559'), { alias: 'lfv1', mediaIds: ['5559'] });
  assert.throws(() => hrmanager.parseSlug('no such/alias'), /HTTP 404/);
});

test('talentadore: a slug that is not a company hash is a dead board', async () => {
  await assert.rejects(talentadore.fetchJobs('not a hash'), /HTTP 404/);
  await assert.rejects(talentadore.fetchJobs('staffpoint/bad hash'), /HTTP 404/);
});
