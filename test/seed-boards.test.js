'use strict';
/** Board links for the URL-named platforms, and seeding only boards their own adapter can read. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { boardFromUrl, careerUrlFor, boardKey } = require('../src/utils/board-urls');
const { seedBoards } = require('../src/tasks/seed-boards');
const ukg = require('../src/adapters/ukg');
const gem = require('../src/adapters/gem');
const kula = require('../src/adapters/kula');

test('posting and board links name their board in the adapters\' slug shape', () => {
  const cases = [
    ['https://recruiting.ultipro.com/OHI1003/JobBoard/38C0CBD7-a4ea-41e1-82d8-dd797bfd73ae/OpportunityDetail?opportunityId=x',
      { ats: 'ukg', slug: 'recruiting.ultipro.com/ohi1003/38c0cbd7-a4ea-41e1-82d8-dd797bfd73ae' }],
    ['https://gusea1p01.rec.pro.ukg.net/BOS1501BGMP/JobBoard/3ebc7d47-2d31-4b8d-817d-db673315517a/?q=',
      { ats: 'ukg', slug: 'gusea1p01.rec.pro.ukg.net/bos1501bgmp/3ebc7d47-2d31-4b8d-817d-db673315517a' }],
    ['https://myjobs.adp.com/RuanCareers/cx/job-details?reqId=5001225334400', { ats: 'adp', slug: 'ruancareers' }],
    ['https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?ccId=1&cid=69ABE2ED-59b3-4ab3-bd4a-b2c8fc054e18&jobId=1',
      { ats: 'adp_workforcenow', slug: '69abe2ed-59b3-4ab3-bd4a-b2c8fc054e18' }],
    ['https://jobs.silkroad.com/SpecCorp/Careers/jobs/145', { ats: 'silkroad', slug: 'speccorp/careers' }],
    ['https://jobs.gem.com/Apartment-List/am9icG9z', { ats: 'gem', slug: 'apartment-list' }],
    ['https://careers.kula.ai/invoca/37535', { ats: 'kula', slug: 'invoca' }],
  ];
  for (const [url, want] of cases) assert.deepEqual(boardFromUrl(url), want, url);
  for (const url of ['https://myjobs.adp.com/', 'https://myjobs.adp.com/cx/x', 'https://jobs.gem.com/embed/x', 'https://jobs.gem.com/-joinforage',
    'https://jobs.silkroad.com/ErrorHandler/NotFound', 'https://jobs.silkroad.com/SpecCorp/jobs/1', 'https://example.com/careers']) {
    assert.equal(boardFromUrl(url), null, url);
  }
});

test('the stored career_url is one each adapter accepts back as a slug', () => {
  const slug = 'recruiting.ultipro.com/OHI1003/38c0cbd7-a4ea-41e1-82d8-dd797bfd73ae';
  assert.equal(careerUrlFor('ukg', slug), 'https://recruiting.ultipro.com/OHI1003/JobBoard/38c0cbd7-a4ea-41e1-82d8-dd797bfd73ae/');
  assert.ok(ukg.parseSlug(boardFromUrl(careerUrlFor('ukg', slug)).slug));
  assert.equal(careerUrlFor('adp', 'ruan'), 'https://myjobs.adp.com/ruan/cx/job-listing');
  assert.deepEqual(boardFromUrl(careerUrlFor('adp', 'ruan')), { ats: 'adp', slug: 'ruan' });
  assert.equal(boardKey('silkroad', 'SpecCorp/Careers'), boardKey('silkroad', 'speccorp/careers'));
});

test('only boards whose adapter reads jobs are seeded; known and repeated boards are not even checked', async (t) => {
  const asked = [];
  t.mock.method(gem, 'fetchJobs', async (slug) => {
    asked.push(slug);
    if (slug === 'dead-board') throw new Error('Gem HTTP 404 (not found)');
    if (slug === 'flaky') throw new Error('Gem HTTP 503 (retry)');
    return { jobs: slug === 'empty-board' ? [] : [{}, {}] };
  });
  t.mock.method(kula, 'fetchJobs', async () => ({ jobs: [{}], meta: { companyName: 'Invoca' } }));
  const { counts, seeded } = await seedBoards([
    { ats: 'gem', slug: 'acme' }, { ats: 'gem', slug: 'ACME' }, { ats: 'gem', slug: 'known-one' },
    { ats: 'gem', slug: 'dead-board' }, { ats: 'gem', slug: 'empty-board' }, { ats: 'gem', slug: 'flaky' },
    { ats: 'kula', slug: 'invoca', companyName: 'Imported Name' }, { ats: 'greenhouse', slug: 'x' },
  ], { origin: 'test', dryRun: true, known: new Set([boardKey('gem', 'known-one')]) });
  assert.deepEqual(asked.sort(), ['acme', 'dead-board', 'empty-board', 'flaky']);
  assert.deepEqual(counts, { candidates: 5, live: 2, empty: 1, dead: 1, error: 1, inserted: 0 });
  assert.deepEqual(seeded.map((r) => [r.ats, r.careerUrl, r.companyName, r.domain]), [
    ['gem', 'https://jobs.gem.com/acme', null, 'jobs.gem.com'],
    ['kula', 'https://careers.kula.ai/invoca', 'Invoca', 'careers.kula.ai'],
  ]);
});
