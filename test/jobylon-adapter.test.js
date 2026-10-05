'use strict';
/** Jobylon adapter against real pages saved 2026-10-05: Epassi Deutschland's widget, an Epassi job. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const jobylon = require('../src/adapters/jobylon');
const { countriesFromLocation } = require('../src/utils/location-countries');
const fx = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');

test('jobylon: the widget lists every job with title, town, function and link', () => {
  const jobs = jobylon.parseList(fx('jobylon-widget.html'));
  assert.equal(jobs.length, 7);
  const j = jobs.find((x) => x.id === '299344');
  assert.match(j.title, /^Sales Manager \(f\/m\/d\)/);
  assert.equal(j.town, 'Bremen');
  assert.equal(j.department, 'Verkauf');
  assert.match(j.url, /^https:\/\/emp\.jobylon\.com\/jobs\/299344-/);
});

test('jobylon: the job page gives the full description, date and a location with its country', () => {
  const d = jobylon.parseDetail(fx('jobylon-job.html'));
  assert.ok(d.description.length > 3000);
  assert.equal(d.posted_at, '2026-09-17T10:18:30+00:00');
  assert.equal(d.location, 'Milan, Metropolitan City of Milan, Italy');
  assert.deepEqual(countriesFromLocation(d.location), ['it']);
  assert.equal(d.company, 'Epassi');
});
