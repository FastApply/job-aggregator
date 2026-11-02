'use strict';
/**
 * Feed rows take their job type and publish date from the posting's own ATS
 * (src/utils/ats-posting-facts.js, src/tasks/feed-ats-facts.js). Cases are the rows FastApply
 * applied to between 2026-10-27 and 2026-11-02, anonymised.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// The connection reads its path when first required: a throwaway SQLite file, set first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-facts-'));
delete process.env.DATABASE_URL;
process.env.DATABASE_PATH = path.join(dir, 't.db');
const { feedOf, atsFactsSource, factsFromBody, fetchAtsFacts, ATS_WITH_FACTS } = require('../src/utils/ats-posting-facts');
const { refreshFeedAtsFacts, selectBatch, changesOf, keepInternship } = require('../src/tasks/feed-ats-facts');

const facts = (ats, url, body) => factsFromBody(atsFactsSource(ats, url), body);
const ld = (posting) =>
  `<html><script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', ...posting })}</script></html>`;

test('a feed is named by the external_id prefix; a crawled row has none', () => {
  assert.equal(feedOf('simplify_a29fd757-0144'), 'simplify');
  assert.equal(feedOf('wonsulting_9'), 'wonsulting');
  assert.equal(feedOf('liftmycv_1'), 'liftmycv');
  assert.equal(feedOf('smartrecruiters_744000057641515'), null);
  assert.equal(feedOf('greenhouse_4372306009'), null);
  assert.equal(feedOf(null), null);
});

test("SmartRecruiters: Domino's Part-time, released 2025-05-05 (the feed said Full-time, 2026-08-13)", () => {
  const url = 'https://jobs.smartrecruiters.com/Example/744000057641515';
  assert.match(atsFactsSource('smartrecruiters', url).api, /api\.smartrecruiters\.com\/v1\/companies\/Example\/postings\/744000057641515$/);
  assert.deepEqual(facts('smartrecruiters', url, { typeOfEmployment: { label: 'Part-time' }, releasedDate: '2025-05-05T18:27:28.067Z' }), {
    employment_type: 'Part-time',
    posted_at: '2025-05-05T18:27:28.067Z',
  });
});

test('Workable, Workday, Lever and Oracle state type and date; Greenhouse and Eightfold date only', () => {
  assert.deepEqual(facts('workable', 'https://apply.workable.com/example/j/6EC2B3DAD2/apply', { type: 'part', published: '2023-03-08T00:00:00.000Z' }), {
    employment_type: 'Part-time',
    posted_at: '2023-03-08T00:00:00.000Z',
  });
  const wd = 'https://example.wd1.myworkdayjobs.com/en-US/external/job/Stutensee-Germany/Material-Compliance-Manager_JR-019451-1';
  assert.match(atsFactsSource('workday', wd).api, /\/wday\/cxs\/example\/external\/job\//);
  assert.deepEqual(facts('workday', wd, { jobPostingInfo: { timeType: 'Full time', startDate: '2025-08-25' } }), {
    employment_type: 'Full-time',
    posted_at: '2025-08-25T00:00:00.000Z',
  });
  assert.deepEqual(facts('lever', 'https://jobs.lever.co/example/0b6f8a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b', { createdAt: 1700000000000, categories: { commitment: 'Part Time' } }), {
    employment_type: 'Part-time',
    posted_at: new Date(1700000000000).toISOString(),
  });
  const oracle = 'https://example.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/155801';
  assert.deepEqual(facts('oracle', oracle, { items: [{ JobSchedule: 'Full time', ExternalPostedStartDate: '2026-01-14T16:17:52+00:00' }] }), {
    employment_type: 'Full-time',
    posted_at: '2026-01-14T16:17:52.000Z',
  });
  assert.deepEqual(facts('greenhouse', 'https://job-boards.greenhouse.io/example/jobs/4372306009?gh_src=Simplify', { first_published: '2026-02-18T10:00:00-05:00' }), {
    employment_type: null,
    posted_at: '2026-02-18T15:00:00.000Z',
  });
  assert.deepEqual(facts('eightfold', 'https://example.eightfold.ai/careers/job/446717843734', { t_create: 1775433600 }), {
    employment_type: null,
    posted_at: '2026-04-06T00:00:00.000Z',
  });
});

test('JazzHR and Jobvite from the page; BambooHR from its detail resource', () => {
  assert.deepEqual(facts('jazzhr', 'https://example.applytojob.com/apply/KwNXPZfIQB/Senior-Developer', ld({ employmentType: 'CONTRACTOR', datePosted: '2026-10-18' })), {
    employment_type: 'Contract',
    posted_at: '2026-10-18T00:00:00.000Z',
  });
  assert.deepEqual(facts('jobvite', 'https://jobs.jobvite.com/example/job/o1AKxfwC?nl=1', ld({ employmentType: 'Full-Time', datePosted: '2025-09-05' })), {
    employment_type: 'Full-time',
    posted_at: '2025-09-05T00:00:00.000Z',
  });
  // Two types offered is not one type stated.
  assert.equal(facts('jobvite', 'https://jobs.jobvite.com/example/job/o1', ld({ employmentType: ['FULL_TIME', 'PART_TIME'] })).employment_type, null);
  assert.deepEqual(facts('bamboohr', 'https://example.bamboohr.com/careers/371', { result: { jobOpening: { employmentStatusLabel: 'Part-Time', datePosted: '2026-10-29' } } }), {
    employment_type: 'Part-time',
    posted_at: '2026-10-29T00:00:00.000Z',
  });
});

test('no source for an ATS without a per-posting resource, or a URL that is not a posting', () => {
  assert.equal(atsFactsSource('ashby', 'https://jobs.ashbyhq.com/example/63d7d126-efaf-4a48-b328-f8d85b640ebf'), null);
  assert.equal(atsFactsSource('icims', 'https://careers-example.icims.com/jobs/1234/job'), null);
  assert.equal(atsFactsSource('workday', 'https://example.wd1.myworkdayjobs.com/external'), null);
  assert.equal(atsFactsSource('smartrecruiters', 'https://simplify.jobs/p/abc'), null);
  assert.ok(!ATS_WITH_FACTS.includes('ashby'));
});

test('a fetch that fails, or a posting that states nothing, is null', async () => {
  const url = 'https://jobs.smartrecruiters.com/Example/744000057641515';
  assert.equal(await fetchAtsFacts('smartrecruiters', url, { fetchImpl: async () => ({ ok: false }) }), null);
  assert.equal(await fetchAtsFacts('smartrecruiters', url, { fetchImpl: async () => { throw new Error('timeout'); } }), null);
  assert.equal(await fetchAtsFacts('smartrecruiters', url, { fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }), null);
});

test('the batch reads only live, unmarked feed rows on a readable ATS', () => {
  const recent = selectBatch({ sinceHours: 48, limit: 200 });
  assert.match(recent.sql, /removed_at IS NULL/);
  assert.match(recent.sql, /ats_facts_at IS NULL/);
  assert.match(recent.sql, /first_seen_at >= \?/);
  assert.match(recent.sql, /ORDER BY first_seen_at DESC LIMIT \?$/);
  assert.ok(recent.params.includes('simplify\\_%'));
  const backfill = selectBatch({ afterId: 10, limit: 50 });
  assert.match(backfill.sql, /id > \? ORDER BY id LIMIT \?$/);
  assert.deepEqual(backfill.params.slice(-2), [10, 50]);
});

test('a reading that moves a posting past 180 days is reported', () => {
  const now = Date.parse('2026-11-02T00:27:28Z');
  const row = { employment_type: 'Full-time', posted_at: '2026-08-13T06:43:34.000Z' };
  assert.deepEqual(changesOf(row, { employment_type: 'Part-time', posted_at: '2025-05-05T18:27:28.067Z' }, now), { type: true, date: true, nowOld: true });
  assert.deepEqual(changesOf(row, { employment_type: 'Full-time', posted_at: '2026-08-13T06:43:34.000Z' }, now), { type: false, date: false, nowOld: false });
});

test('an Internship label is kept over the hours the ATS states', () => {
  const intern = { employment_type: 'Internship' };
  assert.equal(keepInternship(intern, { employment_type: 'Full-time', posted_at: null }).employment_type, null);
  assert.equal(keepInternship(intern, { employment_type: 'Contract', posted_at: null }).employment_type, 'Contract');
  assert.equal(keepInternship({ employment_type: 'Full-time' }, { employment_type: 'Part-time' }).employment_type, 'Part-time');
  assert.equal(keepInternship(intern, null), null);
});

function fakeDb(rows) {
  const writes = [];
  return {
    writes,
    query: async (sql, params) => {
      if (/^SELECT/.test(sql)) return { rows };
      writes.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
  };
}
const domino = { id: 7, external_id: 'simplify_a29f', ats: 'smartrecruiters', url: 'https://jobs.smartrecruiters.com/Example/744000057641515', employment_type: 'Full-time', posted_at: '2026-08-13T06:43:34.000Z' };
const srAnswer = async () => ({ ok: true, json: async () => ({ typeOfEmployment: { label: 'Part-time' }, releasedDate: '2025-05-05T18:27:28.067Z' }) });

test('a dry run reads and reports, and writes nothing', async () => {
  const db = fakeDb([domino]);
  const s = await refreshFeedAtsFacts({ apply: false, sinceHours: 48, fetchImpl: srAnswer, db });
  assert.equal(s.read, 1);
  assert.equal(s.typeChanged, 1);
  assert.equal(s.nowOld, 1);
  assert.equal(db.writes.length, 0);
});

test('applied, the row takes the ATS type and date and is marked; a miss is marked only', async () => {
  const db = fakeDb([domino, { ...domino, id: 8 }]);
  let n = 0;
  const fetchImpl = async (...a) => (++n === 1 ? srAnswer(...a) : { ok: false });
  const s = await refreshFeedAtsFacts({ apply: true, sinceHours: 48, concurrency: 1, fetchImpl, db });
  assert.equal(s.read, 1);
  assert.equal(s.missed, 1);
  assert.match(db.writes[0].sql, /employment_type = COALESCE\(\?, employment_type\), posted_at = COALESCE\(\?, posted_at\), ats_facts_at/);
  assert.deepEqual(db.writes[0].params, ['Part-time', '2025-05-05T18:27:28.067Z', 7]);
  assert.match(db.writes[1].sql, /SET ats_facts_at = datetime\('now'\) WHERE id = \?$/);
  assert.deepEqual(db.writes[1].params, [8]);
});

// The upsert, on a real (SQLite) database: a feed re-sync must not put its values back.
let sqliteOk = true;
try { require('better-sqlite3'); new (require('better-sqlite3'))(':memory:').close(); } catch { sqliteOk = false; }

test('a feed re-sync keeps the ATS values on a marked row, and overwrites an unmarked one', { skip: !sqliteOk && 'better-sqlite3 is not built for this Node' }, async () => {
  const { migrate, jobsRepo, companiesRepo, closeDb } = require('../src/db');
  const { query } = require('../src/db/connection');
  try {
    await migrate();
    const c = await companiesRepo.createFromCrawl({ ats: 'simplify', atsSlug: 'example', origin: 'simplify' });
    const feedRow = (id) => ({ external_id: `simplify_${id}`, title: 'HR Administrative Assistant', url: `https://jobs.smartrecruiters.com/Example/74400005764151${id}`, employment_type: 'Full-time', posted_at: '2026-08-13T06:43:34.000Z', location: 'Kansas City, MO' });
    await jobsRepo.syncForCompany(c.id, 'simplify', [feedRow(1), feedRow(2)]);
    await query(`UPDATE jobs SET employment_type = 'Part-time', posted_at = '2025-05-05T18:27:28.067Z', ats_facts_at = datetime('now') WHERE external_id = 'simplify_1'`);
    await query(`UPDATE jobs SET employment_type = 'Contract' WHERE external_id = 'simplify_2'`);
    await jobsRepo.syncForCompany(c.id, 'simplify', [feedRow(1), feedRow(2)]);
    const { rows } = await query('SELECT external_id, employment_type, posted_at FROM jobs ORDER BY external_id');
    assert.equal(rows[0].employment_type, 'Part-time');
    assert.equal(String(rows[0].posted_at), '2025-05-05T18:27:28.067Z');
    assert.equal(rows[1].employment_type, 'Full-time', 'an unmarked row still follows its source');
  } finally {
    await closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
