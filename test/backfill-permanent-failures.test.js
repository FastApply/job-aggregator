'use strict';
/**
 * A description fetch that can never succeed must return 'SKIP' (row becomes 'N/A', never
 * retried); one that might succeed later must return null (row stays NULL, retried next cycle).
 * Getting this backwards either burns requests forever or gives up on jobs that would have filled.
 * The response shapes below are the ones probed live on 2026-09-26.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchDescription } = require('../src/tasks/backfill-descriptions');

const realFetch = global.fetch;
function respond(status, body, contentType) {
  global.fetch = async () => new Response(body, {
    status,
    headers: contentType ? { 'content-type': contentType } : {},
  });
}
test.afterEach(() => { global.fetch = realFetch; });

const sr = {
  id: 1, ats: 'smartrecruiters', ats_slug: 'UnitedInfrastructure',
  external_id: 'simplify_ec4d78e3', url: 'https://jobs.smartrecruiters.com/UnitedInfrastructure/744000117289907',
};
const bamboo = {
  id: 2, ats: 'bamboohr', ats_slug: 'skylum',
  external_id: 'bamboohr_259', url: 'https://skylum.bamboohr.com/careers/259',
};

for (const status of [400, 401, 403, 404, 410]) {
  test(`SmartRecruiters ${status} is permanent: stop retrying`, async () => {
    respond(status, JSON.stringify({ httpCode: status, code: 'ILLEGAL_ARGUMENT' }), 'application/json');
    assert.equal(await fetchDescription(sr), 'SKIP');
  });
}

for (const status of [429, 500, 502, 503]) {
  test(`SmartRecruiters ${status} is transient: retry next cycle`, async () => {
    respond(status, 'try later', 'text/plain');
    assert.equal(await fetchDescription(sr), null);
  });
}

test('SmartRecruiters 200 with sections still returns the description', async () => {
  respond(200, JSON.stringify({ jobAd: { sections: { a: { text: '<p>Build roads</p>' } } } }), 'application/json');
  assert.equal(await fetchDescription(sr), '<p>Build roads</p>');
});

test('BambooHR careers page turned off (200 HTML after redirect) is permanent', async () => {
  respond(200, '<!DOCTYPE html><title>Login – Skylum</title>', 'text/html; charset=UTF-8');
  assert.equal(await fetchDescription(bamboo), 'SKIP');
});

for (const status of [404, 410]) {
  test(`BambooHR ${status} is permanent`, async () => {
    respond(status, 'gone', 'text/html');
    assert.equal(await fetchDescription(bamboo), 'SKIP');
  });
}

for (const status of [429, 500, 503]) {
  test(`BambooHR ${status} is transient: retry next cycle`, async () => {
    respond(status, 'busy', 'text/html');
    assert.equal(await fetchDescription(bamboo), null);
  });
}

test('BambooHR JSON detail still returns the description', async () => {
  respond(200, JSON.stringify({ result: { jobOpening: { description: '<p>Design</p>' } } }), 'application/json; charset=utf-8');
  assert.equal(await fetchDescription(bamboo), '<p>Design</p>');
});
