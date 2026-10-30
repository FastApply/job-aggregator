'use strict';
/**
 * FA-053 — the check that must return zero. The fake database below answers the three queries the
 * scan issues with the SAME keyset semantics as the SQL, so batch boundaries and rows that share
 * a timestamp are exercised without Postgres.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  scanRecentPostings, listCompanyMatches, formatScan, formatMatches, parseDays,
  SINCE_SQL, SCAN_SQL, COMPANIES_SQL, JOB_COUNTS_SQL,
} = require('../src/tasks/sandbox-check');

function fakeDb({ jobs = [], companies = [], since = '2026-09-16 00:00:00' } = {}) {
  const byCompany = new Map(companies.map((c) => [c.id, c]));
  const calls = [];
  const query = async (sql, params) => {
    calls.push(sql);
    if (sql === SINCE_SQL) return { rows: [{ since }] };
    if (sql === SCAN_SQL) {
      const [at, id, limit] = params;
      const rows = jobs
        .filter((j) => j.first_seen_at > at || (j.first_seen_at === at && j.id > id))
        .sort((a, b) => (a.first_seen_at < b.first_seen_at ? -1 : a.first_seen_at > b.first_seen_at ? 1 : a.id - b.id))
        .slice(0, limit)
        .map((j) => {
          const c = byCompany.get(j.company_id);
          return { id: j.id, url: j.url, first_seen_at: j.first_seen_at, retired: !!j.retired,
            company_id: c.id, company_ats: c.ats, ats_slug: c.ats_slug, career_url: c.career_url };
        });
      return { rows };
    }
    if (sql === COMPANIES_SQL) {
      const [after, limit] = params;
      return { rows: companies.filter((c) => c.id > after).sort((a, b) => a.id - b.id).slice(0, limit) };
    }
    if (sql === JOB_COUNTS_SQL) {
      const [ids] = params;
      return { rows: ids.map((cid) => ({
        company_id: cid,
        live: jobs.filter((j) => j.company_id === cid && !j.retired).length,
        retired: jobs.filter((j) => j.company_id === cid && j.retired).length,
      })).filter((r) => r.live + r.retired > 0) };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  return { query, calls };
}

const COMPANIES = [
  { id: 1, ats: 'greenhouse', ats_slug: 'gitlab', career_url: 'https://boards.greenhouse.io/gitlab', company_name: 'GitLab', status: 'active', origin: 'seed' },
  { id: 2, ats: 'bamboohr', ats_slug: 'ramonabrowndemo', career_url: 'https://ramonabrowndemo.bamboohr.com/careers', company_name: 'Ramona Brown Demo', status: 'active', origin: 'crawl' },
  { id: 3, ats: 'lever', ats_slug: 'leverdemo-8', career_url: 'https://jobs.lever.co/leverdemo-8', company_name: 'Lever Demo', status: 'active', origin: 'crawl' },
  { id: 4, ats: 'simplify', ats_slug: 'some-employer', career_url: 'https://simplify.jobs/c/some-employer', company_name: 'Some Employer', status: 'unlinked', origin: 'simplify' },
  { id: 5, ats: 'greenhouse', ats_slug: 'sandboxvr', career_url: 'https://boards.greenhouse.io/sandboxvr', company_name: 'Sandbox VR', status: 'active', origin: 'seed' },
];

// ids are interleaved with timestamps that collide, so a cursor that dropped the id tiebreak loses rows.
const JOBS = [
  { id: 10, company_id: 1, url: 'https://boards.greenhouse.io/gitlab/jobs/1', first_seen_at: '2026-09-20 09:00:00.000001' },
  { id: 11, company_id: 2, url: 'https://ramonabrowndemo.bamboohr.com/careers/1', first_seen_at: '2026-09-20 09:00:00.5' },
  { id: 12, company_id: 2, url: 'https://ramonabrowndemo.bamboohr.com/careers/2', first_seen_at: '2026-09-20 09:00:00.5', retired: true },
  { id: 13, company_id: 3, url: 'https://jobs.lever.co/leverdemo-8/abc', first_seen_at: '2026-09-20 09:00:00.5' },
  { id: 14, company_id: 4, url: 'https://weedmansandbox.applytojob.com/apply/x/y', first_seen_at: '2026-09-21 10:00:00' },
  { id: 15, company_id: 4, url: 'https://boards.greenhouse.io/someemployer/jobs/9', first_seen_at: '2026-09-21 10:00:01' },
  { id: 16, company_id: 5, url: 'https://boards.greenhouse.io/sandboxvr/jobs/3', first_seen_at: '2026-09-22 08:00:00' },
  { id: 17, company_id: 2, url: 'https://ramonabrowndemo.bamboohr.com/careers/3', first_seen_at: '2026-09-25 23:59:59' },
];

test('the scan finds sandbox boards, counts live and retired apart, and ignores real ones', async () => {
  const { query } = fakeDb({ jobs: JOBS, companies: COMPANIES });
  const r = await scanRecentPostings({ query, days: 30 });

  assert.equal(r.scanned, JOBS.length);
  assert.deepEqual(r.boards.map((b) => `${b.ats}/${b.slug}`), ['bamboohr/ramonabrowndemo', 'jazzhr/weedmansandbox', 'lever/leverdemo-8']);
  const bamboo = r.boards[0];
  assert.deepEqual({ live: bamboo.live, retired: bamboo.retired, companyIds: bamboo.companyIds }, { live: 2, retired: 1, companyIds: [2] });
  assert.equal(bamboo.firstSeen, '2026-09-20 09:00:00.5');
  assert.equal(bamboo.lastSeen, '2026-09-25 23:59:59');
  assert.deepEqual(bamboo.sampleJobIds, [11, 12, 17]);
  assert.equal(r.live, 4);
  assert.equal(r.retired, 1);
});

test('a feed job is caught by its URL even though its company slug is clean', async () => {
  const { query } = fakeDb({ jobs: JOBS, companies: COMPANIES });
  const r = await scanRecentPostings({ query });
  const feed = r.boards.find((b) => b.slug === 'weedmansandbox');
  assert.equal(feed.via, 'url');
  assert.equal(feed.live, 1, 'only the sandbox URL counts, not the same feed company\'s real job');
});

test('a board reached by more than one route says so', async () => {
  const companies = [...COMPANIES, { id: 6, ats: 'jazzhr', ats_slug: 'weedmansandbox', career_url: 'https://weedmansandbox.applytojob.com', company_name: 'W', status: 'active', origin: 'crawl' }];
  const jobs = [...JOBS, { id: 30, company_id: 6, url: 'https://weedmansandbox.applytojob.com/apply/q/r', first_seen_at: '2026-09-22 00:00:00' }];
  const { query } = fakeDb({ jobs, companies });
  const board = (await scanRecentPostings({ query })).boards.find((b) => b.slug === 'weedmansandbox');
  assert.equal(board.via, 'slug+url');
  assert.deepEqual(board.companyIds, [4, 6]);
  assert.equal(board.live, 2);
});

test('batching never drops or repeats a row, whatever the batch size', async () => {
  for (const batchSize of [1, 2, 3, 4, 7, 8, 9, 5000]) {
    const { query } = fakeDb({ jobs: JOBS, companies: COMPANIES });
    const r = await scanRecentPostings({ query, batchSize });
    assert.equal(r.scanned, JOBS.length, `batchSize ${batchSize}`);
    assert.equal(r.live, 4, `batchSize ${batchSize}`);
    assert.equal(r.retired, 1, `batchSize ${batchSize}`);
  }
});

test('a cursor that stops advancing fails loudly instead of looping', async () => {
  const stuck = [
    { id: 5, url: 'https://x.example/1', first_seen_at: '2026-09-20 00:00:00', retired: false, company_id: 1, company_ats: 'greenhouse', ats_slug: 'gitlab', career_url: null },
    { id: 6, url: 'https://x.example/2', first_seen_at: '2026-09-20 00:00:00', retired: false, company_id: 1, company_ats: 'greenhouse', ats_slug: 'gitlab', career_url: null },
  ];
  const query = async (sql) => (sql === SINCE_SQL ? { rows: [{ since: '2026-09-20 00:00:00' }] } : { rows: stuck });
  // The first batch ends at (…00:00:00, 6), which is ahead of the starting (since, 0); a database
  // that then returned the same batch again must be caught on the second pass.
  await assert.rejects(scanRecentPostings({ query, batchSize: 2 }), /did not advance/);
});

test('a clean window reports zero and says so', async () => {
  const { query } = fakeDb({ jobs: JOBS.filter((j) => [10, 16].includes(j.id)), companies: COMPANIES });
  const r = await scanRecentPostings({ query });
  assert.equal(r.live, 0);
  assert.deepEqual(r.boards, []);
  assert.match(formatScan(r), /RESULT: 0 sandbox postings\./);
});

test('an empty window is not an error', async () => {
  const { query } = fakeDb({ jobs: [], companies: COMPANIES });
  const r = await scanRecentPostings({ query });
  assert.equal(r.scanned, 0);
  assert.equal(r.live, 0);
});

test('only retired sandbox postings left: reported, but live is zero so the check passes', async () => {
  const { query } = fakeDb({ jobs: [{ ...JOBS[1], retired: true }], companies: COMPANIES });
  const r = await scanRecentPostings({ query });
  assert.equal(r.live, 0);
  assert.equal(r.retired, 1);
  assert.match(formatScan(r), /0 live sandbox posting\(s\) on 0 board\(s\), 1 already retired/);
});

test('the report names the board, the rule, the dates and a sample URL', () => {
  const text = formatScan({
    days: 30, since: '2026-09-16 00:00:00', scanned: 10, live: 1, retired: 0,
    boards: [{ ats: 'lever', slug: 'leverdemo-8', via: 'slug', rule: 'suffix:demo', companyIds: [3], live: 1, retired: 0,
      firstSeen: 'a', lastSeen: 'b', sampleUrl: 'https://jobs.lever.co/leverdemo-8/abc', sampleJobIds: [13] }],
  });
  for (const part of ['lever/leverdemo-8', 'suffix:demo', 'https://jobs.lever.co/leverdemo-8/abc', 'RESULT: 1 live sandbox posting(s) on 1 board(s)']) {
    assert.ok(text.includes(part), `report should mention ${part}`);
  }
});

test('--days is validated, not coerced', () => {
  assert.equal(parseDays(undefined), 30);
  assert.equal(parseDays('7'), 7);
  for (const bad of ['0', '-1', '1.5', 'abc', '366']) assert.throws(() => parseDays(bad), RangeError, bad);
});

test('list-matches reviews company names, with live counts, across batches', async () => {
  for (const batchSize of [1, 2, 5000]) {
    const { query } = fakeDb({ jobs: JOBS, companies: COMPANIES });
    const r = await listCompanyMatches({ query, batchSize });
    assert.equal(r.scanned, COMPANIES.length);
    assert.deepEqual(r.matches.map((m) => `${m.ats}/${m.slug}`), ['bamboohr/ramonabrowndemo', 'lever/leverdemo-8']);
    const bamboo = r.matches[0];
    assert.deepEqual({ live: bamboo.live, retired: bamboo.retired }, { live: 2, retired: 1 });
  }
  const { query } = fakeDb({ jobs: JOBS, companies: COMPANIES });
  assert.match(formatMatches(await listCompanyMatches({ query })), /Read every line\./);
});

test('list-matches with nothing to review skips the job-count query', async () => {
  const { query, calls } = fakeDb({ jobs: [], companies: [COMPANIES[0], COMPANIES[4]] });
  const r = await listCompanyMatches({ query });
  assert.deepEqual(r.matches, []);
  assert.ok(!calls.includes(JOB_COUNTS_SQL));
});

test('every statement the check can run is a read', () => {
  for (const sql of [SINCE_SQL, SCAN_SQL, COMPANIES_SQL, JOB_COUNTS_SQL]) {
    assert.match(sql.trim(), /^SELECT\b/i);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE)\b/i);
  }
});
