'use strict';
/**
 * Varbi and ReachMee adapters, against real pages saved 2026-10-04 (test/fixtures): Arvika kommun
 * on Varbi, Espresso House on ReachMee. Both platforms carry most Swedish public-sector and many
 * retail jobs; a Sweden search needs each job's country, which neither site states in its list.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const varbi = require('../src/adapters/varbi');
const reachmee = require('../src/adapters/reachmee');
const { countriesFromLocation } = require('../src/utils/location-countries');
const fx = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');

test('varbi: the feed lists every job with its id and link', () => {
  const items = varbi.parseFeed(fx('varbi-feed.xml'));
  assert.equal(items.length, 12);
  assert.match(items[0].id, /^\d+$/);
  assert.match(items[0].url, /^https:\/\/arvika\.varbi\.com\/.*jobID:\d+/);
  assert.ok(items[0].title);
});

test('varbi: the job page gives town, country and the full description', () => {
  const { info, description } = varbi.parseDetail(fx('varbi-job.html'));
  assert.equal(info.town, 'Arvika');
  assert.equal(info.country, 'Sverige');
  assert.equal(info.county, 'Värmlands län');
  assert.ok(description.length > 2000);
  assert.deepEqual(countriesFromLocation(`${info.town}, ${info.country}`), ['se'], 'a Sweden search must find it');
  assert.equal(varbi.employmentType(info), 'Full-time');
});

test('varbi: Swedish employment wording maps to the board types', () => {
  assert.equal(varbi.employmentType({ 'type-of-employment': 'Visstidsanställning', hours: 'Heltid' }), 'Temporary');
  assert.equal(varbi.employmentType({ 'type-of-employment': 'Tillsvidareanställning', hours: 'Deltid' }), 'Part-time');
});

test('reachmee: the list page gives every job with town, deadline and Sweden from the page language', () => {
  const jobs = reachmee.parseList(fx('reachmee-list.html'));
  assert.equal(jobs.length, 55);
  const j = jobs.find((x) => x.id === '5945');
  assert.equal(j.town, 'Goteborg');
  assert.equal(j.country, 'Sweden');
  assert.match(j.deadline, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(countriesFromLocation(`${j.town}, ${j.country}`), ['se']);
});

test('reachmee: the job page gives the description and department', () => {
  const d = reachmee.parseDetail(fx('reachmee-job.html'));
  assert.equal(d.department, 'Espresso House Sverige');
  assert.ok(d.description.length > 1000);
});

test('both: a slug is an org name, or a full host when it carries one', () => {
  assert.equal(varbi.baseUrl('arvika'), 'https://arvika.varbi.com');
  assert.equal(reachmee.baseUrl('espressohouse-sweden'), 'https://espressohouse-sweden.attract.reachmee.com');
  assert.equal(reachmee.baseUrl('https://foo.attract.reachmee.com/jobs'), 'https://foo.attract.reachmee.com');
});

test('reachmee legacy: the main page table lists every job with its id and deadline', () => {
  const jobs = reachmee.parseLegacyList(fx('reachmee-legacy-list.html'));
  assert.ok(jobs.length > 5, `got ${jobs.length}`);
  const j = jobs.find((x) => x.id === '1739');
  assert.equal(j.title, 'Kommunvägledare till Socialt- stöd och vård');
  assert.equal(j.deadline, '2026-10-12');
  assert.equal(j.country, 'Sweden');
  assert.match(j.url, /job_id=1739/);
});

test('reachmee legacy: the job page gives the description', () => {
  const d = reachmee.parseLegacyDetail(fx('reachmee-legacy-job.html'));
  assert.ok(d.description.length > 2000);
});

test('reachmee legacy: a slug is the main page URL, with an optional default town', () => {
  assert.equal(reachmee.isLegacy('https://web103.reachmee.com/ext/I021/1890/main?site=9&validator=x&lang=SE#loc=Östersund'), true);
  assert.equal(reachmee.isLegacy('espressohouse-sweden'), false);
});

test('named HTML entities in Swedish town names are decoded', () => {
  const { decodeEntities } = require('../src/adapters/html-entities');
  assert.equal(decodeEntities('&Ouml;rnsk&ouml;ldsvik'), 'Örnsköldsvik');
  assert.equal(decodeEntities('V&auml;ster&aring;s &#8211; &#x00C5;re'), 'Västerås – Åre');
  assert.equal(decodeEntities('&unknown;'), '&unknown;');
});

test('reachmee: a list without a town column never puts the deadline in the location', () => {
  const html = '<html lang="sv"><h5 title="Tjänst">Tjänst</h5><h5 title="Sista ansökningsdag">Sista</h5>'
    + '<li class="at-jobs-list-item"><div class="at-jobs-list-cell-40"><a href="https://forex.attract.reachmee.com/jobs/4680-kassor">Kassör</a></div>'
    + '<div class="at-jobs-list-cell-40">2026-11-01</div></li></html>';
  const [j] = reachmee.parseList(html);
  assert.equal(j.town, null);
  assert.equal(j.deadline, '2026-11-01');
});
