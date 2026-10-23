'use strict';
/** Dayforce and Manatal: the offline parts, shapes taken from live answers 2026-10-23. */
const test = require('node:test');
const assert = require('node:assert/strict');
const dayforce = require('../src/adapters/dayforce');
const manatal = require('../src/adapters/manatal');

const posting = {
  clientNamespace: 'gaylor', jobBoardId: 1, jobPostingId: 4297, jobReqId: 1651,
  jobTitle: ' Bilingual Skilled Trades Recruiter ', jobDescription: '<p>Bilingual English/Spanish is preferred</p>',
  hasVirtualLocation: false, postingStartTimestampUTC: '2026-10-21T05:00:00+00:00', postingExpiryTimestampUTC: null, isEvergreen: false,
  postingLocations: [
    { formattedAddress: 'Atlanta, GA, USA', isoCountryCode: 'US', stateCode: 'GA', cityName: 'Atlanta' },
    { formattedAddress: 'Nashville, TN, USA', isoCountryCode: 'US', stateCode: 'TN', cityName: 'Nashville' },
    { formattedAddress: 'Atlanta, GA, USA', isoCountryCode: 'US', stateCode: 'GA', cityName: 'Atlanta' },
  ],
};

test('dayforce: slug is a namespace, with a career-site code when it is not CANDIDATEPORTAL', () => {
  assert.deepEqual(dayforce.parseSlug('Gaylor'), { ns: 'gaylor', board: 'CANDIDATEPORTAL' });
  assert.deepEqual(dayforce.parseSlug('sobeys/SobeysRSCExternalSite'), { ns: 'sobeys', board: 'SOBEYSRSCEXTERNALSITE' });
  assert.throws(() => dayforce.parseSlug('no such/board/x'), /HTTP 404/);
});

test('dayforce: a search posting becomes a job', () => {
  const j = dayforce.toJob(posting, 'gaylor', 'CANDIDATEPORTAL', { enableApplyWithoutAccount: true });
  assert.equal(j.external_id, 'dayforce_4297');
  assert.equal(j.title, 'Bilingual Skilled Trades Recruiter');
  assert.equal(j.location, 'Atlanta, GA, USA / Nashville, TN, USA');
  assert.equal(j.workplace_type, null);
  assert.equal(j.url, 'https://jobs.dayforcehcm.com/en-US/gaylor/CANDIDATEPORTAL/jobs/4297');
  assert.equal(j.posted_at, '2026-10-21T05:00:00+00:00');
  assert.equal(j.raw_data.apply_without_account, true);
  assert.equal(dayforce.toJob({ ...posting, hasVirtualLocation: true }, 'gaylor', 'CANDIDATEPORTAL', null).workplace_type, 'remote');
});

test('manatal: a list row becomes a job; salary only when the employer shows it', () => {
  const row = { id: 2019501, hash: 'QV9649YR', position_name: 'Back End Software Engineer', description: '<p>x</p>',
    country: 'United States', state: 'Maryland', city: 'Annapolis Junction', location_display: 'Annapolis Junction, Maryland, United States',
    is_salary_visible: false, salary_min: 90000, salary_max: 120000, currency_code: 'USD', organization_name: 'Acme' };
  const j = manatal.toJob(row, 'cruitzi');
  assert.equal(j.external_id, 'manatal_2019501');
  assert.equal(j.url, 'https://www.careers-page.com/cruitzi/job/QV9649YR');
  assert.equal(j.location, 'Annapolis Junction, Maryland, United States');
  assert.equal(j.salary_min, null);
  assert.equal(j.raw_data.hiring_company, 'Acme');
  const paid = manatal.toJob({ ...row, is_salary_visible: true }, 'cruitzi');
  assert.deepEqual([paid.salary_min, paid.salary_max, paid.salary_currency], [90000, 120000, 'USD']);
  assert.equal(manatal.locationOf({ city: 'Austin', state: 'Texas', country: '' }), 'Austin, Texas');
  assert.throws(() => manatal.slugOf('bad slug!'), /HTTP 404/);
});

