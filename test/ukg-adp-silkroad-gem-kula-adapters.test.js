'use strict';
/** UKG, ADP (myjobs + Workforce Now), SilkRoad, Gem, Kula: the offline parts, shapes from live answers 2026-10-29. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ukg = require('../src/adapters/ukg');
const adp = require('../src/adapters/adp');
const wfn = require('../src/adapters/adp_workforcenow');
const silkroad = require('../src/adapters/silkroad');
const gem = require('../src/adapters/gem');
const kula = require('../src/adapters/kula');
const { getAdapter } = require('../src/adapters');

const crawler = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'crawl-companies-local.js'), 'utf8');
const permanent = new RegExp(crawler.match(/const isPermanentError = \(msg\) => \/(.+)\/i\.test/)[1], 'i');

test('every new platform is registered under the name FastApply searches the board by', () => {
  for (const ats of ['ukg', 'adp', 'adp_workforcenow', 'silkroad', 'gem', 'kula']) assert.equal(typeof getAdapter(ats).fetchJobs, 'function');
});

test('ukg: slug is host/tenant/board, and a bad one is permanent', () => {
  assert.deepEqual(ukg.parseSlug('recruiting.ultipro.com/OHI1003/38C0CBD7-a4ea-41e1-82d8-dd797bfd73ae'),
    { host: 'recruiting.ultipro.com', tenant: 'OHI1003', board: '38c0cbd7-a4ea-41e1-82d8-dd797bfd73ae' });
  assert.ok(ukg.parseSlug('gusea1p01.rec.pro.ukg.net/BOS1501BGMP/3ebc7d47-2d31-4b8d-817d-db673315517a'));
  assert.throws(() => ukg.parseSlug('example.com/OHI1003/38c0cbd7-a4ea-41e1-82d8-dd797bfd73ae'), (e) => permanent.test(e.message));
});

test('ukg: a search row becomes a job; JobLocationType 0/1/2 is hybrid/onsite/remote', () => {
  const ref = ukg.parseSlug('recruiting.ultipro.com/OHI1003/38c0cbd7-a4ea-41e1-82d8-dd797bfd73ae');
  const row = { Id: '6368B48A-e0d1-4552-9a15-a5cffd97e978', Title: ' Events Intern, Paid ', RequisitionNumber: 'EVENT008858', FullTime: true,
    JobCategoryName: 'Intern', PostedDate: '2026-10-16T17:33:40.664Z', BriefDescription: 'OhioGuidestone has served...', JobLocationType: 0,
    Locations: [{ LocalizedName: null, Address: { City: 'Berea', State: { Code: 'OH' }, Country: { Code: 'USA' } } },
      { LocalizedName: 'Remote', Address: {} }] };
  const j = ukg.toJob(row, ref);
  assert.equal(j.external_id, 'ukg_6368b48a-e0d1-4552-9a15-a5cffd97e978');
  assert.equal(j.title, 'Events Intern, Paid');
  assert.equal(j.location, 'Berea, OH, USA / Remote');
  assert.equal(j.workplace_type, 'hybrid');
  assert.equal(j.employment_type, 'Full-time');
  assert.equal(j.description, null, 'the backfill only fills NULL descriptions; the teaser lives in raw_data');
  assert.equal(j.raw_data.teaser, 'OhioGuidestone has served...');
  assert.equal(j.url, 'https://recruiting.ultipro.com/OHI1003/JobBoard/38c0cbd7-a4ea-41e1-82d8-dd797bfd73ae/OpportunityDetail?opportunityId=6368B48A-e0d1-4552-9a15-a5cffd97e978');
  assert.equal(ukg.toJob({ ...row, JobLocationType: 1 }, ref).workplace_type, 'onsite');
  assert.equal(ukg.toJob({ ...row, JobLocationType: 2 }, ref).workplace_type, 'remote');
  assert.equal(ukg.toJob({ ...row, JobLocationType: null }, ref).workplace_type, null);
});

test('ukg: the posting JSON is read out of the page script that follows it', () => {
  const page = 'x new US.Opportunity.CandidateOpportunityDetail({"Id":"a","Description":"<p>Hi {there} \\"q\\"</p>","N":{"a":1}}); more()';
  const at = page.indexOf('(') + 1;
  assert.equal(ukg.parseJsonPrefix(page.slice(at)).value.Description, '<p>Hi {there} "q"</p>');
});

test('adp: requests carry a literal $ in the OData names and an explicit accept-language', async (t) => {
  const seen = [];
  t.mock.method(global, 'fetch', async (url, init) => {
    seen.push({ url: String(url), headers: init.headers });
    if (String(url).includes('/career-site/')) return new Response(JSON.stringify({ clientName: 'Ruan', active: true, myJobsToken: 'tok' }));
    return new Response(JSON.stringify({ count: 1, jobRequisitions: [{ reqId: '5001225334400', publishedJobTitle: 'Dispatch Coordinator', jobDescription: '<p>d</p>',
      jobQualifications: '<p>q</p>', workLevelCode: 'Full-time', postingDate: '2026-10-28T19:03:13Z',
      requisitionLocations: [{ address: { cityName: 'East Hartford', countrySubdivisionLevel1: { codeValue: 'CT' }, country: { codeValue: 'USA' } } }] }] }));
  });
  const r = await adp.fetchJobs('Ruan');
  const list = seen.find((s) => s.url.includes('apply-custom-filters'));
  assert.match(list.url, /\?\$select=.*&\$top=50&\$skip=0&\$filter=$/);
  assert.equal(list.headers['accept-language'], 'en-US', "Node's default `*` makes ADP answer count 0");
  assert.equal(list.headers.myJobsToken, 'tok');
  assert.equal(list.headers.rolecode, 'manager');
  const [j] = r.jobs;
  assert.equal(j.url, 'https://myjobs.adp.com/ruan/cx/job-details?reqId=5001225334400');
  assert.equal(j.location, 'East Hartford, CT, USA');
  assert.equal(j.description, '<p>d</p>\n<p>q</p>');
  assert.equal(r.meta.companyName, 'Ruan');
});

test('adp: an unknown tenant is permanent', async (t) => {
  t.mock.method(global, 'fetch', async () => new Response('{"message":"Careersite not found"}', { status: 400 }));
  await assert.rejects(adp.fetchJobs('nobody'), (e) => permanent.test(e.message));
});

test('adp workforce now: the posting URL carries ExternalJobID as jobId', () => {
  const cid = '69abe2ed-59b3-4ab3-bd4a-b2c8fc054e18';
  const j = wfn.toJob({ itemID: '9207596332409_1', requisitionTitle: 'Marketing Operations Specialist', postDate: '2026-10-14T22:11:00',
    workLevelCode: { shortName: 'Full Time' },
    customFieldGroup: { stringFields: [{ nameCode: { codeValue: 'ExternalJobID' }, stringValue: '1009803' }] },
    requisitionLocations: [{ address: { cityName: 'Remote - SLC Area Preferred', countrySubdivisionLevel1: { codeValue: 'UT' } },
      nameCode: { shortName: ' Remote - SLC Area Preferred, UT, US' } }] }, cid);
  assert.equal(j.url, `https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=${cid}&jobId=1009803&lang=en_US`);
  assert.equal(j.external_id, `adpwfn_${cid}_9207596332409_1`);
  assert.equal(j.location, 'Remote - SLC Area Preferred, UT, US');
  assert.equal(j.workplace_type, 'remote');
  assert.deepEqual(j.raw_data, { cid, itemID: '9207596332409_1', jobId: '1009803', clientRequisitionID: null });
  assert.throws(() => wfn.cidOf('not-a-uuid'), (e) => permanent.test(e.message));
});

const silkPage = `
  <h2 id="Jobs_PagedJobList_Category__36306">Accounting &amp; Finance</h2>
  <a id="Jobs_PagedJobList_Job-145" class="sr-panel" href="/SpecCorp/Careers/jobs/145">
    <div class="sr-panel__title" id="Jobs_PagedJobList_JobTitle-145"> Account Payable Representative </div>
    <div class="sr-panel__location" id="Jobs_PagedJobList_JobLocation-145"><span class="sr-panel__meta">Roeland Park, Kansas</span></div>
  </a>
  <h2 id="Jobs_PagedJobList_Category__1">Sales</h2>
  <a id="Jobs_PagedJobList_Job-17" class="sr-panel" href="/SpecCorp/Careers/jobs/17">
    <div class="sr-panel__title" id="Jobs_PagedJobList_JobTitle-17">Outside Sales Representative</div>
  </a>
  <button id="Jobs_PagedJobList_NextLink" type="submit" class="sr-pagination__button" data-href="/SpecCorp/Careers?page=2">Next</button>`;

test('silkroad: board panels become jobs under their department heading', () => {
  const rows = silkroad.parsePage(silkPage);
  assert.deepEqual(rows.map((r) => [r.id, r.title, r.location, r.department]), [
    ['145', 'Account Payable Representative', 'Roeland Park, Kansas', 'Accounting & Finance'],
    ['17', 'Outside Sales Representative', null, 'Sales'],
  ]);
  assert.equal(silkroad.hasNextPage(silkPage), true);
  assert.equal(silkroad.hasNextPage(silkPage.replace(/data-href="[^"]+"/, '')), false);
  const j = silkroad.toJob(rows[0], silkroad.parseSlug('speccorp/careers'));
  assert.equal(j.url, 'https://jobs.silkroad.com/SpecCorp/Careers/jobs/145');
  assert.equal(j.external_id, 'silkroad_speccorp_careers_145');
  assert.throws(() => silkroad.parseSlug('SpecCorp'), (e) => permanent.test(e.message));
});

test('silkroad: a redirect to the not-found page is permanent', async (t) => {
  t.mock.method(global, 'fetch', async () => new Response('', { status: 302, headers: { location: '/ErrorHandler/NotFound' } }));
  await assert.rejects(silkroad.fetchJobs('NoCo/Careers'), (e) => permanent.test(e.message));
});

test('gem: a job post becomes a job; in_office reads onsite', () => {
  const p = { id: 'am9icG9zdDq3', title: 'Senior Staff Product Designer, Core', absolute_url: 'https://jobs.gem.com/apartment-list/am9icG9zdDq3',
    content: '<p>x</p>', location: { name: 'Canada - Remote' }, location_type: 'remote', employment_type: 'full_time',
    departments: [{ name: 'Product Design' }], first_published_at: '2026-10-07T23:41:39.433Z' };
  const j = gem.toJob(p, 'apartment-list');
  assert.deepEqual([j.external_id, j.url, j.location, j.workplace_type, j.department], ['gem_am9icG9zdDq3', p.absolute_url, 'Canada - Remote', 'remote', 'Product Design']);
  assert.equal(gem.toJob({ ...p, location_type: 'in_office' }, 'apartment-list').workplace_type, 'onsite');
});

test('kula: a post becomes a job with its pay range; internal-only posts are left out', async (t) => {
  const post = { id: 37535, account_id: 1519, title: 'Staff AI Platform Engineer', listed: true, kind: 'internal_and_external', launch_at: '2026-03-25T19:07:03.000Z',
    ats_job: { job_description: '<h2>About</h2>', workplace: 'remote', work_type_name: 'Full time', ats_department: { name: 'Engineering' },
      offices: [{ location: 'San Francisco, California, United States' }, { location: 'Denver, Colorado, United States' }],
      compensation: { base_salary: { currency: 'USD', interval: 'yearly', min_amount: '182000.00', max_amount: '273600.00' } } } };
  const j = kula.toJob(post, 'invoca');
  assert.equal(j.url, 'https://careers.kula.ai/invoca/37535');
  assert.equal(j.location, 'San Francisco, California, United States / Denver, Colorado, United States');
  assert.deepEqual([j.salary_min, j.salary_max, j.salary_currency, j.salary_interval], [182000, 273600, 'USD', 'year']);
  t.mock.method(global, 'fetch', async () => new Response(JSON.stringify({ meta: { pages: 1 },
    data: [post, { ...post, id: 1, kind: 'internal' }, { ...post, id: 2, kind: 'external' }, { ...post, id: 3, listed: false }] })));
  assert.deepEqual((await kula.fetchJobs('invoca')).jobs.map((x) => x.external_id), ['kula_37535', 'kula_2']);
});

test('kula: a closed account is permanent', async (t) => {
  t.mock.method(global, 'fetch', async () => new Response('{}', { status: 403 }));
  await assert.rejects(kula.fetchJobs('closed'), (e) => permanent.test(e.message));
});

// Live answers 2026-10-31: an unknown cid gets openresty's page every time; a known cid sometimes
// lands on a cluster that does not host it and gets the ingress's "default backend - 404".
const OPENRESTY_404 = '<html>\r\n<head><title>404 Not Found</title></head>\r\n<body>\r\n<center><h1>404 Not Found</h1></center>\r\n<hr><center>openresty</center>\r\n</body>\r\n</html>\r\n';
const MISROUTED_404 = 'default backend - 404';

function stubFetch(answers) {
  const real = global.fetch;
  let n = 0;
  global.fetch = async () => {
    const [status, body] = answers[Math.min(n++, answers.length - 1)];
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { calls: () => n, restore: () => { global.fetch = real; } };
}

test('adp workforce now: a misrouted 404 is retried, not read as a closed career center', async () => {
  const cid = '69abe2ed-59b3-4ab3-bd4a-b2c8fc054e18';
  assert.ok(wfn.isMisrouted(MISROUTED_404));
  assert.ok(!wfn.isMisrouted(OPENRESTY_404));
  const s = stubFetch([[404, MISROUTED_404], [200, { meta: { totalNumber: 1 }, jobRequisitions: [{ itemID: '1_1', requisitionTitle: 'Nurse' }] }]]);
  try {
    const { jobs } = await wfn.fetchJobs(cid);
    assert.equal(jobs.length, 1);
    assert.equal(s.calls(), 2);
  } finally { s.restore(); }
});

test('adp workforce now: only openresty\'s 404 is permanent', async () => {
  const cid = '69abe2ed-59b3-4ab3-bd4a-b2c8fc054e18';
  const s = stubFetch([[404, OPENRESTY_404]]);
  try {
    await assert.rejects(wfn.fetchJobs(cid), (e) => permanent.test(e.message));
  } finally { s.restore(); }
});

test('adp workforce now: a missing or empty posting is SKIP, a real one returns its HTML', async () => {
  const raw = { cid: '69abe2ed-59b3-4ab3-bd4a-b2c8fc054e18', itemID: '1_1' };
  let s = stubFetch([[200, { postingInstructions: [], links: [] }]]);
  try { assert.equal(await wfn.fetchDescription('u', raw), 'SKIP'); } finally { s.restore(); }
  s = stubFetch([[200, { itemID: '1_1', requisitionDescription: '<p>Care for patients on a 30-bed unit.</p>' }]]);
  try { assert.equal(await wfn.fetchDescription('u', raw), '<p>Care for patients on a 30-bed unit.</p>'); } finally { s.restore(); }
  assert.equal(await wfn.fetchDescription('u', {}), 'SKIP');
});
