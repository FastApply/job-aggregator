'use strict';
/**
 * FA-053 — retiring the sandbox jobs that are already stored. The fake database answers the
 * statements the planner issues, so batch edges and the "plan only reads" promise are exercised
 * without Postgres.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  planRetirement, applyRetirement, formatPlan, reasonFor,
  COMPANY_JOBS_SQL, URL_SCAN_SQL, REASON_PREFIX,
} = require('../src/tasks/sandbox-retire');
const { COMPANIES_SQL, JOB_COUNTS_SQL } = require('../src/tasks/sandbox-check');

const COMPANIES = [
  { id: 1, ats: 'bamboohr', ats_slug: 'ramonabrowndemo', career_url: 'https://ramonabrowndemo.bamboohr.com/careers', company_name: 'Ramona', status: 'active', origin: 'crawl' },
  { id: 2, ats: 'lever', ats_slug: 'leverdemo-8', career_url: 'https://jobs.lever.co/leverdemo-8', company_name: 'Lever Demo', status: 'active', origin: 'crawl' },
  { id: 3, ats: 'greenhouse', ats_slug: 'sandboxvr', career_url: 'https://boards.greenhouse.io/sandboxvr', company_name: 'Sandbox VR', status: 'active', origin: 'seed' },
  { id: 4, ats: 'simplify', ats_slug: 'some-employer', career_url: 'https://simplify.jobs/c/some-employer', company_name: 'Some Employer', status: 'unlinked', origin: 'simplify' },
  { id: 5, ats: 'smartrecruiters', ats_slug: 'TestGorilla', career_url: 'https://jobs.smartrecruiters.com/TestGorilla', company_name: 'TestGorilla', status: 'active', origin: 'seed' },
];

const JOBS = [
  { id: 101, company_id: 1, url: 'https://ramonabrowndemo.bamboohr.com/careers/1' },
  { id: 102, company_id: 1, url: 'https://ramonabrowndemo.bamboohr.com/careers/2' },
  { id: 103, company_id: 1, url: 'https://ramonabrowndemo.bamboohr.com/careers/3', removed: true },   // already retired
  { id: 104, company_id: 2, url: 'https://jobs.lever.co/leverdemo-8/0a1b2c' },
  { id: 105, company_id: 3, url: 'https://boards.greenhouse.io/sandboxvr/jobs/3' },                    // real employer
  { id: 106, company_id: 4, url: 'https://boards.greenhouse.io/someemployer/jobs/9001' },              // feed, real board
  { id: 107, company_id: 4, url: 'https://acme-demo.recruitee.com/o/qa-engineer' },                   // feed, sandbox board
  { id: 108, company_id: 4, url: 'https://weedmansandbox.applytojob.com/apply/x/y' },                 // feed, sandbox board
  { id: 109, company_id: 5, url: 'https://jobs.smartrecruiters.com/TestGorilla/55-test-engineer' },  // real, "test" in the title
];

function fakeDb({ jobs = JOBS, companies = COMPANIES } = {}) {
  const statements = [];
  const updates = [];
  const byCompany = new Map(companies.map((c) => [c.id, c]));
  const query = async (sql, params) => {
    statements.push(sql);
    if (sql === COMPANIES_SQL) {
      const [after, limit] = params;
      return { rows: companies.filter((c) => c.id > after).sort((a, b) => a.id - b.id).slice(0, limit) };
    }
    if (sql === JOB_COUNTS_SQL) {
      return { rows: params[0].map((cid) => ({
        company_id: cid,
        live: jobs.filter((j) => j.company_id === cid && !j.removed).length,
        retired: jobs.filter((j) => j.company_id === cid && j.removed).length,
      })) };
    }
    if (sql === COMPANY_JOBS_SQL) {
      return { rows: jobs.filter((j) => j.company_id === Number(params[0]) && !j.removed).map((j) => ({ id: j.id })) };
    }
    if (sql === URL_SCAN_SQL) {
      const [cursor, limit] = params;
      return {
        rows: jobs
          .filter((j) => !j.removed && j.id > cursor && /sandbox|demo|test/i.test(j.url))
          .sort((a, b) => a.id - b.id)
          .slice(0, limit)
          .map((j) => {
            const c = byCompany.get(j.company_id);
            return { id: j.id, url: j.url, company_id: c.id, company_ats: c.ats, ats_slug: c.ats_slug, career_url: c.career_url };
          }),
      };
    }
    if (/^\s*UPDATE jobs/.test(sql)) {
      updates.push({ sql, params });
      const ids = params[0];
      return { rows: ids.filter((id) => jobs.some((j) => j.id === id && !j.removed)).map((id) => ({ id, external_id: `e${id}` })) };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  return { query, statements, updates };
}

const sorted = (xs) => [...xs].sort((a, b) => a - b);

test('the plan finds whole companies, feed postings by URL, and nothing real', async () => {
  const { query } = fakeDb();
  const plan = await planRetirement({ query });

  const ids = plan.boards.flatMap((b) => b.ids);
  assert.deepEqual(sorted(ids), [101, 102, 104, 107, 108], 'live sandbox jobs only');
  assert.equal(plan.total, 5);
  for (const keep of [103, 105, 106, 109]) assert.ok(!ids.includes(keep), `job ${keep} must stay`);

  const byKey = Object.fromEntries(plan.boards.map((b) => [`${b.ats}/${b.slug}`, b]));
  assert.deepEqual(sorted(byKey['bamboohr/ramonabrowndemo'].ids), [101, 102]);
  assert.equal(byKey['bamboohr/ramonabrowndemo'].via, 'slug');
  assert.deepEqual(byKey['recruitee/acme-demo'].ids, [107]);
  assert.equal(byKey['recruitee/acme-demo'].via, 'url');
  assert.deepEqual(byKey['jazzhr/weedmansandbox'].ids, [108]);
});

test('a sandbox company\'s jobs are retired even when no job URL says so', async () => {
  // Some vendors' job URLs carry no tenant at all, so the company's own slug is the only evidence.
  const companies = [...COMPANIES, { id: 6, ats: 'workday', ats_slug: 'acmedemo', career_url: 'https://acmedemo.wd5.myworkdayjobs.com', company_name: 'Acme', status: 'active', origin: 'crawl' }];
  const jobs = [...JOBS, { id: 110, company_id: 6, url: 'https://wd5.example.com/job/12345' }];
  const plan = await planRetirement({ query: fakeDb({ jobs, companies }).query });
  const board = plan.boards.find((b) => b.slug === 'acmedemo');
  assert.ok(board, 'the company must be found by its slug');
  assert.deepEqual(board.ids, [110]);
  assert.equal(board.via, 'slug');
});

test('a job is planned once even when a company and its URL both name the board', async () => {
  const { query } = fakeDb();
  const plan = await planRetirement({ query });
  const ids = plan.boards.flatMap((b) => b.ids);
  assert.equal(new Set(ids).size, ids.length, 'no job appears under two boards');
  // 101/102 are reached by the company AND by their URLs; they are counted once.
  assert.equal(plan.boards.find((b) => b.slug === 'ramonabrowndemo').count, 2);
});

test('planning only ever reads', async () => {
  const { query, statements } = fakeDb();
  await planRetirement({ query });
  assert.ok(statements.length > 0);
  for (const sql of statements) {
    assert.match(sql.trim(), /^SELECT\b/i);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i);
  }
});

test('the URL scan never drops or repeats a job, whatever the batch size', async () => {
  for (const batchSize of [1, 2, 3, 5000]) {
    const { query } = fakeDb();
    const plan = await planRetirement({ query, batchSize });
    assert.deepEqual(sorted(plan.boards.flatMap((b) => b.ids)), [101, 102, 104, 107, 108], `batchSize ${batchSize}`);
  }
});

test('a clean database plans nothing', async () => {
  const { query } = fakeDb({ jobs: JOBS.filter((j) => [105, 106, 109].includes(j.id)) });
  const plan = await planRetirement({ query });
  assert.deepEqual(plan.boards, []);
  assert.equal(plan.total, 0);
  assert.equal(formatPlan(plan), 'No live sandbox jobs to retire.');
});

test('a scan whose cursor stops advancing fails instead of looping', async () => {
  const stuck = [{ id: 7, url: 'https://x.example/demo', company_id: 4, company_ats: 'simplify', ats_slug: 's', career_url: null }];
  const query = async (sql) => {
    if (sql === COMPANIES_SQL) return { rows: [] };
    return { rows: stuck, rowCount: 1 };
  };
  await assert.rejects(planRetirement({ query, batchSize: 1 }), /did not advance/);
});

test('applying retires with the repo\'s own UPDATE and a reason that names the board', async () => {
  const db = fakeDb();
  const plan = await planRetirement({ query: db.query });
  const result = await applyRetirement({ query: db.query, plan });

  assert.equal(result.retired, 5);
  assert.equal(db.updates.length, plan.boards.length, 'one UPDATE per board when it fits in a chunk');
  for (const u of db.updates) {
    assert.match(u.sql, /SET removed_at = NOW\(\)/);
    assert.match(u.sql, /removed_reason = \$\d+/);
    assert.match(u.sql, /AND removed_at IS NULL/, 're-running must be a no-op');
    assert.doesNotMatch(u.sql, /DELETE/i, 'retirement is soft');
    assert.ok(u.params[u.params.length - 1].startsWith(REASON_PREFIX), 'the undo statement keys on this prefix');
  }
  const reasons = db.updates.map((u) => u.params[u.params.length - 1]);
  assert.ok(reasons.some((r) => r.includes('bamboohr/ramonabrowndemo') && r.includes('suffix:demo')));
});

test('applying chunks a large board, so no single UPDATE is huge', async () => {
  const many = Array.from({ length: 1203 }, (_, i) => ({ id: 1000 + i, company_id: 1, url: `https://ramonabrowndemo.bamboohr.com/careers/${i}` }));
  const db = fakeDb({ jobs: many });
  const plan = await planRetirement({ query: db.query });
  assert.equal(plan.total, 1203);
  const result = await applyRetirement({ query: db.query, plan, chunk: 500 });
  assert.equal(result.retired, 1203);
  assert.deepEqual(db.updates.map((u) => u.params[0].length), [500, 500, 203]);
});

test('running it twice retires nothing the second time', async () => {
  const jobs = JOBS.map((j) => ({ ...j }));
  const db = fakeDb({ jobs });
  const plan1 = await planRetirement({ query: db.query });
  await applyRetirement({ query: db.query, plan: plan1 });
  for (const j of jobs) if ([101, 102, 104, 107, 108].includes(j.id)) j.removed = true; // what the UPDATE did
  const plan2 = await planRetirement({ query: fakeDb({ jobs }).query });
  assert.equal(plan2.total, 0);
});

test('the report names each board, how many jobs, and why', async () => {
  const { query } = fakeDb();
  const text = formatPlan(await planRetirement({ query }));
  for (const part of ['Would retire 5 live job(s) on 4 sandbox board(s)', 'bamboohr/ramonabrowndemo', 'recruitee/acme-demo', 'rule suffix:demo via slug']) {
    assert.ok(text.includes(part), `report should include "${part}"\n${text}`);
  }
  assert.match(formatPlan(await planRetirement({ query }), { apply: true }), /^Retiring 5 live job/);
});

test('reasonFor is bounded and starts with the undo prefix', () => {
  const r = reasonFor({ rule: 'suffix:demo', ats: 'lever', slug: 'x'.repeat(500) });
  assert.ok(r.startsWith(REASON_PREFIX));
  assert.ok(r.length <= 200);
});
