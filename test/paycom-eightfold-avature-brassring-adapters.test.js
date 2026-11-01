'use strict';
/** Paycom, Eightfold, Avature and BrassRing: the offline parts, shapes taken from live answers 2026-10-23. */
const test = require('node:test');
const assert = require('node:assert/strict');
const paycom = require('../src/adapters/paycom');
const eightfold = require('../src/adapters/eightfold');
const avature = require('../src/adapters/avature');
const brassring = require('../src/adapters/brassring');

test('paycom: a preview and its detail become a job', () => {
  const preview = { jobId: 563831, jobTitle: 'Field Service Technician', positionType: 'Full Time', remoteType: '', locations: 'Anaheim - Anaheim, CA 92806', description: 'cut…', isHotJob: true };
  const detail = {
    jobId: 563831, clientCode: '0RL77', location: 'Anaheim - Anaheim, CA 92806', secondaryLocations: [], remoteType: 'Remote',
    salaryRange: '$33.80 - $39.00 Hourly', positionType: 'Full Time', jobCategory: '', description: '<p>SUMMARY</p>',
    qualifications: '<ul><li>CDL</li></ul>', qualificationsTitle: 'Qualifications', googleJobJson: '{"datePosted":"2026-08-04"}',
  };
  const j = paycom.toJob(preview, detail, 'd8dcaf39235301d992f0c8f292e8f69d');
  assert.equal(j.external_id, 'paycom_563831');
  assert.equal(j.location, 'Anaheim, CA 92806');
  assert.equal(j.workplace_type, 'remote');
  assert.deepEqual([j.salary_min, j.salary_max, j.salary_currency, j.salary_interval], [33.8, 39, 'USD', 'hour']);
  assert.match(j.description, /SUMMARY[\s\S]*Qualifications[\s\S]*CDL/);
  assert.equal(j.posted_at, '2026-08-04T00:00:00.000Z');
  assert.equal(j.url, 'https://www.paycomonline.net/v4/ats/web.php/portal/d8dcaf39235301d992f0c8f292e8f69d/jobs/563831');
  // A failed detail keeps the list row.
  assert.equal(paycom.toJob(preview, null, 'd8dcaf39235301d992f0c8f292e8f69d').description, 'cut…');
  assert.deepEqual(paycom.parseSalary('$65,000.00 Salary'), { salary_min: 65000, salary_max: null, salary_currency: 'USD', salary_interval: 'year' });
  assert.equal(paycom.placeOf('Remote'), 'Remote');
  assert.throws(() => paycom.keyOf('not-a-key'), /HTTP 404/);
});

test('eightfold: PCSX and v2 positions become jobs', () => {
  assert.deepEqual(eightfold.parseSlug('Starbucks'), { tenant: 'starbucks', domain: null });
  assert.deepEqual(eightfold.parseSlug('app/volkscience.com'), { tenant: 'app', domain: 'volkscience.com' });
  assert.throws(() => eightfold.parseSlug('a b'), /HTTP 404/);
  const pcsx = { id: 481081432318, name: 'data engineer sr', locations: ['1101 Church ST, Nashville, Tennessee, United States'], standardizedLocations: ['Nashville, TN, US'], postedTs: 1792785647, department: null, workLocationOption: 'hybrid', atsJobId: '260086047' };
  const j = eightfold.toJob(pcsx, { jobDescription: '<p>x</p>', efcustomTextPayRange: '$90,000 - $120,000 per year' }, { tenant: 'starbucks', domain: 'starbucks.com' });
  assert.equal(j.external_id, 'eightfold_481081432318');
  assert.equal(j.location, 'Nashville, TN, US');
  assert.equal(j.workplace_type, 'hybrid');
  assert.equal(j.url, 'https://starbucks.eightfold.ai/careers/job/481081432318');
  assert.deepEqual([j.salary_min, j.salary_max, j.salary_currency, j.salary_interval], [90000, 120000, 'USD', 'year']);
  const v2 = { id: '446721369335', name: 'Account Executive', location: 'Fort Lauderdale, Florida, United States of America', locations: ['Fort Lauderdale, Florida, United States of America'], t_create: '1790812800', work_location_option: 'onsite', ats_job_id: 'R40033' };
  const k = eightfold.toJob(v2, null, { tenant: 'app', domain: 'costar.com' });
  assert.equal(k.description, null);
  assert.equal(k.workplace_type, 'onsite');
  assert.equal(k.url, 'https://app.eightfold.ai/careers/job/446721369335?domain=costar.com');
  assert.equal(k.posted_at, new Date(1790812800 * 1000).toISOString());
});

test('avature: list items across templates, and a job page with fields', () => {
  const list = `
    <article class="article article--result"><div class="article__header"><div class="article__header__text">
      <h3 class="article__header__text__title"><a class="link" href="https://bloomberg.avature.net/careers/JobDetail/Accounting-Analyst/45808"> Accounting Analyst </a></h3>
      <div class="article__header__text__subtitle"><span class="list-item-location">New York, New York, United States of America</span></div>
    </div></div></article>
    <article class="article article--result"><div class="article__header"><div class="article__header__text">
      <h5 class="article__header__text__subtitle"> Georgia-Pacific </h5>
      <ul class="list list--share"><li class="list__item"><a href="mailto:?body=x">Share</a></li></ul>
      <h3><a href="https://koch.avature.net/en_US/careers/JobDetail/OATARI-TECH-TRAINEE/196695">OATARI TECH TRAINEE</a></h3>
    </div></div><div class="article__content"><div class="article__content__field"><div class="article__content__field__label">Location</div><div class="article__content__field__value">Camden, Texas</div></div></div></article>
    <article class="article article--result"><h3><a href="/careers/JobDetail/Accounting-Manager/34985">Accounting Manager</a></h3>
      <div class="article__header__text__subtitle"><span> Remote - USA, United States </span> · · Posted 18-Aug-2026</div></article>`;
  const rows = avature.parseList(list, 'https://nva.avature.net/careers/SearchJobs/?jobOffset=0');
  assert.deepEqual(rows.map((r) => [r.id, r.title, r.location]), [
    ['45808', 'Accounting Analyst', 'New York, New York, United States of America'],
    ['196695', 'OATARI TECH TRAINEE', 'Camden, Texas'],
    ['34985', 'Accounting Manager', 'Remote - USA, United States'],
  ]);
  assert.equal(rows[2].url, 'https://nva.avature.net/careers/JobDetail/Accounting-Manager/34985');
  const page = `<div class="article__content__view">
    <div class="article__content__view__field"><div class="article__content__view__field__label">Location(s)</div><div class="article__content__view__field__value">Camden, Texas</div></div>
    <div class="article__content__view__field"><div class="article__content__view__field__value"><p>${'Repair or replace defective equipment. '.repeat(10)}</p></div></div>
  </div>`;
  const d = avature.parseDetail(page);
  assert.equal(d.location, 'Camden, Texas');
  assert.match(d.description, /Repair or replace/);
  const old = `<div class="infoTitle">Key Tasks</div><div class="infoDes"><p>${'Configure test rigs. '.repeat(5)}</p></div>
    <script type="application/ld+json">{"@type":"JobPosting","description":"","datePosted":"2026-09-08"}</script>`;
  const o = avature.parseDetail(old);
  assert.match(o.description, /<h3>Key Tasks<\/h3>/);
  assert.equal(o.posted_at, '2026-09-08T00:00:00.000Z');
  assert.throws(() => avature.parseSlug('koch'), /HTTP 404/);
});

test('avature: the place when the template gives it no label', () => {
  const li = (title, id, subtitle) => `<li class="list__item list__item--boxed"><div class="list__item__text">
    <div class="list__item__text__title"><a href="https://x.avature.net/careers/JobDetail/a/${id}">${title}</a></div>
    <div class="list__item__text__subtitle collapaseIcon">${subtitle}</div></div></li>`;
  const list = li('Sales Engineer (all genders)', 3677, 'Air Traffic Management | Austria | Vienna | FREQUENTIS AG')
    + li('Expert Engineer', 23476, '<span>R&amp;D / Engineering.</span> <span>Zürich.</span> <span>Nänikon-Greifensee.</span> <span>Switzerland.</span> <span>30-Oct-2026.</span>')
    + li('Business Analyst', 5992, '<span>Chicago, IL, United States</span> <span>Job ID:14282</span>')
    + li('Marketing Manager', 11, 'Marketing | Corporate');
  assert.deepEqual(avature.parseList(list, 'https://x.avature.net/careers/SearchJobs/').map((r) => r.location), [
    'Vienna, Austria', 'Nänikon-Greifensee, Switzerland', 'Chicago, IL, United States', null,
  ]);
  const table = `<table><thead><tr><th scope="col">Title</th><th scope="col">Location(s)</th><th scope="col">Attendance</th></tr></thead><tbody>
    <tr><th scope="row"><a class="link" href="https://emplois.bnc.ca/en_CA/careers/JobDetail/A3V80-ADJOINT/36578" title="Associate"> Associate </a></th><td> Surrey, British Columbia </td><td> On-Site </td></tr></tbody></table>`;
  assert.equal(avature.parseList(table, 'https://emplois.bnc.ca/en_CA/careers/SearchJobs/')[0].location, 'Surrey, British Columbia');
  const field = (l, v) => `<div class="article__content__view__field"><div class="article__content__view__field__label">${l}</div><div class="article__content__view__field__value">${v}</div></div>`;
  const body = `<div class="infoTitle">Key Tasks</div><div class="infoDes"><p>${'Configure test rigs. '.repeat(5)}</p></div>`;
  assert.equal(avature.parseDetail(field('State', 'Hawaii') + field('City', 'Kona') + body).location, 'Kona, Hawaii');
  assert.equal(avature.parseDetail(`<div class=" moreDetail taUppercase"><span>Vienna </span><span>FREQUENTIS AG </span></div>${body}`).location, 'Vienna');
});

test('brassring: a search job becomes a job, the place read from the site layout', () => {
  const pre = { JobFieldsToDisplay: { Position1: 'formtext26', JobTitle: 'formtext15', Position3: ['autoreq', 'formtext2'], Summary: 'jobdescription' } };
  const layout = brassring.layoutOf(pre);
  const job = { Link: 'https://sjobs.brassring.com/TGnewUI/Search/home/HomeWithPreLoad?partnerid=25633&siteid=5439&PageType=JobDetails&jobid=2253289',
    Questions: [['reqid', '2253289'], ['lastupdated', '10/23/2026'], ['jobtitle', 'Lead Consultant'], ['formtext15', 'Lead Consultant &amp; Architect'],
      ['jobdescription', '<p>Role</p>'], ['autoreq', '155185BR'], ['formtext2', 'Perth '], ['formtext26', 'Delivery']].map(([QuestionName, Value]) => ({ QuestionName, Value })) };
  const j = brassring.toJob(job, layout, '25633', '5439');
  assert.equal(j.external_id, 'brassring_2253289');
  assert.equal(j.title, 'Lead Consultant & Architect');
  assert.equal(j.location, 'Perth');
  assert.equal(j.description, '<p>Role</p>');
  assert.equal(j.posted_at, new Date('10/23/2026').toISOString());
  assert.equal(j.raw_data.auto_req, '155185BR');
  assert.deepEqual(brassring.parseSlug('25526/5032'), { partnerId: '25526', siteId: '5032' });
  assert.throws(() => brassring.parseSlug('25526'), /HTTP 404/);
});

test('brassring: the employer is read from the page title (2026-10-30)', () => {
  assert.equal(brassring.employerFromTitle('<title id="title">Job Search | Infosys</title>'), 'Infosys');
  assert.equal(brassring.employerFromTitle('<title id="title">Databricks and AI Architect | Infosys</title>'), 'Infosys');
  assert.equal(brassring.employerFromTitle('<title id="title">Job Search | Home Depot</title>'), 'Home Depot');
  assert.equal(brassring.employerFromTitle('<title>Error</title>'), null);
  assert.equal(brassring.employerFromTitle('<title>Job Search</title>'), null);
  assert.equal(brassring.employerFromTitle(''), null);
});
