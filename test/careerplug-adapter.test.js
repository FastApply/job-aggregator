'use strict';
/** CareerPlug: the offline parts, fixtures trimmed from live pages 2026-11-15 (KRE Security, Floor Coverings International, Apollo Mens Health). */
process.env.CAREERPLUG_GAP_MS = '0';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const careerplug = require('../src/adapters/careerplug');
const { getAdapter } = require('../src/adapters');
const { isSupportedAts } = require('../src/utils/supported-ats');

const fixture = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
const LIST = fixture('careerplug-list.html');
const LIST_LAST = fixture('careerplug-list-last.html');
const JOB = fixture('careerplug-job.html');
const EMPTY = fixture('careerplug-empty.html');
const FUTURE = fixture('careerplug-job-future-opening.html');

const crawler = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'crawl-companies-local.js'), 'utf8');
const permanent = new RegExp(crawler.match(/const isPermanentError = \(msg\) => \/(.+)\/i\.test/)[1], 'i');

const html = (body, status = 200, headers = {}) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });

test('careerplug is registered and passes the ingest gate', () => {
  assert.equal(typeof getAdapter('careerplug').fetchJobs, 'function');
  assert.equal(isSupportedAts('careerplug'), true);
});

test('careerplug: the slug is the subdomain, from a bare name, a board URL or a "name@host" row', () => {
  assert.equal(careerplug.slugOf('KRE-Security'), 'kre-security');
  assert.equal(careerplug.slugOf('https://kre-security.careerplug.com/jobs/3229026/apps/new'), 'kre-security');
  assert.equal(careerplug.slugOf('apollo-health@apollo-mens-health-2-pllc.careerplug.com'), 'apollo-mens-health-2-pllc');
  assert.throws(() => careerplug.slugOf('www'), /HTTP 404/);
  assert.throws(() => careerplug.slugOf('bad slug!'), /HTTP 404/);
});

test('careerplug: a list page gives each posting once, with its title and "ST-City-ZIP" location read as "City, ST"', () => {
  assert.deepEqual(careerplug.parseListPage(LIST), [
    { id: '3671403', title: 'Armed School Security Officer Full Time-Act 235', location: 'Allentown, PA' },
    { id: '3669791', title: 'Patrol Philadelphia Stay Alert and Watch Out for That Fox', location: 'Bensalem, PA' },
  ]);
  assert.equal(careerplug.hasNextPage(LIST), true);
  assert.equal(careerplug.hasNextPage(LIST_LAST), false);
  assert.deepEqual(careerplug.parseListPage(LIST_LAST), [{ id: '1944042', title: 'Experienced Carpet Installer', location: 'Orange City, FL' }]);
  assert.deepEqual(careerplug.boardMeta(LIST), { companyName: 'KRE Security', logoUrl: 'https://d2zpdrfrohaf9r.cloudfront.net/system/logos/532892/original/KRE_Logo.png' });
  assert.equal(careerplug.rowLocation('PA-Wilkes-Barre-18701'), 'Wilkes-Barre, PA');
  assert.equal(careerplug.isListPage(EMPTY), true);
  assert.equal(careerplug.isListPage('<html><body>Down for maintenance</body></html>'), false);
});

test('careerplug: a posting page JSON-LD becomes a job with HTML text, pay, date and the hiring franchisee', () => {
  const j = careerplug.toJob({ id: '3430205', title: 'x', location: null }, 'floor-coverings-international-careers', careerplug.parsePosting(JOB));
  assert.equal(j.external_id, 'careerplug_3430205');
  assert.equal(j.title, 'Production Coordinator');
  assert.equal(j.location, 'Denver, CO, US');
  assert.equal(j.employment_type, 'Full-time');
  assert.deepEqual([j.salary_min, j.salary_max, j.salary_currency, j.salary_interval], [60000, 60000, 'USD', 'year']);
  assert.equal(j.posted_at, '2026-05-29T16:00:48+00:00');
  assert.equal(j.url, 'https://floor-coverings-international-careers.careerplug.com/jobs/3430205/apps/new');
  assert.match(j.description, /^<div class="benefits">/);
  assert.match(j.description, /<li>Training & development<\/li>/);
  assert.match(j.description, /That's a big reason/);
  assert.equal(j.raw_data.hiring_company, 'Floor Coverings International of Douglas County');
  // A pay range, as KRE posts some hourly roles.
  const ranged = careerplug.toJob({ id: '1', title: 'Guard', location: 'Bensalem, PA' }, 'kre-security',
    { baseSalary: { currency: 'USD', value: { unitText: 'HOUR', minValue: '16.00', maxValue: '20.00' } }, jobLocationType: 'TELECOMMUTE' });
  assert.deepEqual([ranged.salary_min, ranged.salary_max, ranged.salary_interval, ranged.workplace_type], [16, 20, 'hour', 'remote']);
  // No posting page read: the list row stands on its own.
  const bare = careerplug.toJob({ id: '2', title: 'Guard', location: 'Bensalem, PA' }, 'kre-security', null);
  assert.deepEqual([bare.title, bare.location, bare.description, bare.salary_min, bare.posted_at], ['Guard', 'Bensalem, PA', null, null, null]);
});

test('careerplug: a "Future Opening" posting has no JSON-LD, so its text is read off the page', () => {
  assert.equal(careerplug.parsePosting(FUTURE), null);
  const d = careerplug.pageDescription(FUTURE);
  assert.match(d, /^<div class="trix-content">/);
  assert.match(d, /as a Warehouse Help!/);
  assert.doesNotMatch(d, /About the franchise/);
  const j = careerplug.toJob({ id: '3537696', title: 'Warehouse Help', location: 'Orlando, FL' }, 'floor-coverings-international-careers', null, d);
  assert.deepEqual([j.title, j.location, j.description], ['Warehouse Help', 'Orlando, FL', d]);
});

test('careerplug: fetchJobs walks the pager, then reads each posting', async (t) => {
  const seen = [];
  t.mock.method(global, 'fetch', async (url) => {
    seen.push(String(url).replace('https://kre-security.careerplug.com', ''));
    if (/\/jobs\?page=1$/.test(url)) return html(LIST);
    if (/\/jobs\?page=2$/.test(url)) return html(LIST_LAST);
    if (/\/jobs\/3669791\/apps\/new$/.test(url)) return html('gone', 404);
    if (/\/jobs\/1944042\/apps\/new$/.test(url)) return html(FUTURE);
    if (/\/apps\/new$/.test(url)) return html(JOB);
    throw new Error(`unexpected ${url}`);
  });
  const { jobs, meta } = await careerplug.fetchJobs('kre-security');
  assert.deepEqual(seen, ['/jobs?page=1', '/jobs?page=2', '/jobs/3671403/apps/new', '/jobs/3669791/apps/new', '/jobs/1944042/apps/new']);
  assert.deepEqual(jobs.map((j) => j.external_id), ['careerplug_3671403', 'careerplug_3669791', 'careerplug_1944042']);
  assert.equal(jobs[0].posted_at, '2026-05-29T16:00:48+00:00');
  // The posting that would not load keeps its list row.
  assert.deepEqual([jobs[1].title, jobs[1].location, jobs[1].description], ['Patrol Philadelphia Stay Alert and Watch Out for That Fox', 'Bensalem, PA', null]);
  assert.match(jobs[2].description, /as a Warehouse Help!/);
  assert.deepEqual(meta, { companyName: 'KRE Security', logoUrl: 'https://d2zpdrfrohaf9r.cloudfront.net/system/logos/532892/original/KRE_Logo.png', capped: false });
});

test('careerplug: an empty board is no jobs, not an error', async (t) => {
  t.mock.method(global, 'fetch', async () => html(EMPTY));
  const { jobs, meta } = await careerplug.fetchJobs('apollo-mens-health-2-pllc');
  assert.deepEqual(jobs, []);
  assert.equal(meta.companyName, 'APOLLO MENS HEALTH 2 PLLC');
});

test('careerplug: an unknown board (302 to app.careerplug.com) is permanent; a strange page is retried', async (t) => {
  t.mock.method(global, 'fetch', async () => html('', 302, { location: 'https://app.careerplug.com/' }));
  await assert.rejects(careerplug.fetchJobs('zz-no-such-board'), (e) => permanent.test(e.message));
  t.mock.restoreAll();
  t.mock.method(global, 'fetch', async () => html('<html><body>Down for maintenance</body></html>'));
  await assert.rejects(careerplug.fetchJobs('kre-security'), (e) => /unexpected page/.test(e.message) && !permanent.test(e.message));
});

test('careerplug: posting URLs are read as boards by ingest, the page scanner and the sandbox check', () => {
  const { deriveCompany } = require('../src/tasks/demand-crawl');
  const { extractAtsSlugFromHtml } = require('../src/adapters/extractor');
  const { boardFromUrl } = require('../src/utils/sandbox-board');
  const url = 'https://charley-s-steak-house.careerplug.com/jobs/3633160/apps/new';
  assert.deepEqual(deriveCompany(url, null, "Charley's", 'feed'),
    { ats: 'careerplug', slug: 'charley-s-steak-house', careerUrl: 'https://charley-s-steak-house.careerplug.com/jobs', domain: 'charley-s-steak-house.careerplug.com' });
  assert.equal(deriveCompany('https://www.careerplug.com/jobs/1', null, 'X', 'feed').ats, 'feed');
  assert.deepEqual(extractAtsSlugFromHtml('<a href="https://www.careerplug.com">by</a> <a href="https://kre-security.careerplug.com/jobs">Jobs</a>'),
    { ats: 'careerplug', clientname: 'kre-security' });
  assert.deepEqual(boardFromUrl(url), { ats: 'careerplug', slug: 'charley-s-steak-house' });
  assert.equal(boardFromUrl('https://app.careerplug.com/'), null);
});

test('careerplug: a Xeruit link names the board and the same job id the adapter keys on', () => {
  const { resolveBoard } = require('../scripts/xeruit-board');
  const r = resolveBoard('https://kre-security.careerplug.com/jobs/3229026/apps/new');
  assert.deepEqual([r.ats, r.slug, r.nativeId, r.crawlable], ['careerplug', 'kre-security', 'careerplug_3229026', true]);
  assert.equal(resolveBoard('https://www.careerplug.com/jobs').crawlable, false);
});
