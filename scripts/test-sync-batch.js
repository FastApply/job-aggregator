#!/usr/bin/env node
/**
 * Local check for the batched syncForCompany upsert.
 *
 *   DATABASE_URL=postgres://localhost/jobsync_test node scripts/test-sync-batch.js   # Postgres
 *   DATABASE_PATH=/tmp/jobsync-test.db        node scripts/test-sync-batch.js        # SQLite
 *
 * Asserts row STATE after each sync, not just that nothing threw — the batching
 * rewrite has to preserve upsert semantics exactly, including the COALESCE on
 * description and the non-empty guards on visa_sponsorship/experience_level.
 */
const assert = require('assert');

async function main() {
  const { migrate, closeDb } = require('../src/db');
  const { query } = require('../src/db/connection');
  const jobsRepo = require('../src/db/repositories/jobs');
  const dialect = process.env.DATABASE_URL ? 'postgres' : 'sqlite';

  await migrate();
  await query('DELETE FROM jobs');
  await query('DELETE FROM companies');
  await query(
    `INSERT INTO companies (career_url, domain, ats, ats_slug, company_name) VALUES (?, ?, ?, ?, ?)`,
    ['https://example.com/careers', 'example.com', 'greenhouse', 'example', 'Example Co']
  );
  const { rows: [company] } = await query('SELECT id FROM companies LIMIT 1');
  const cid = company.id;

  const mk = (i, over = {}) => ({
    external_id: `job-${i}`,
    title: `Engineer ${i}`,
    location: 'Remote',
    url: `https://example.com/jobs/${i}`,
    description: `Description for ${i}`,
    ...over,
  });

  let failures = 0;
  const check = async (name, fn) => {
    try { await fn(); console.log(`  ok   ${name}`); }
    catch (err) { failures++; console.log(`  FAIL ${name}\n       ${err.message}`); }
  };

  console.log(`\n=== ${dialect} ===`);

  // 1. Fresh insert spanning several chunks (CHUNK is 200).
  await check('inserts 450 jobs across chunk boundaries', async () => {
    const res = await jobsRepo.syncForCompany(cid, 'greenhouse', Array.from({ length: 450 }, (_, i) => mk(i)));
    assert.strictEqual(res.added, 450, `added=${res.added}`);
    assert.strictEqual(res.updated, 0, `updated=${res.updated}`);
    const { rows } = await query('SELECT COUNT(*) AS c FROM jobs WHERE company_id = ?', [cid]);
    assert.strictEqual(Number(rows[0].c), 450, `row count=${rows[0].c}`);
  });

  // 2. Re-sync updates in place rather than duplicating.
  await check('re-sync updates, does not duplicate', async () => {
    const res = await jobsRepo.syncForCompany(cid, 'greenhouse',
      Array.from({ length: 450 }, (_, i) => mk(i, { title: `Updated ${i}` })));
    assert.strictEqual(res.updated, 450, `updated=${res.updated}`);
    assert.strictEqual(res.added, 0, `added=${res.added}`);
    const { rows } = await query('SELECT COUNT(*) AS c FROM jobs WHERE company_id = ?', [cid]);
    assert.strictEqual(Number(rows[0].c), 450, `row count=${rows[0].c}`);
    const { rows: t } = await query('SELECT title FROM jobs WHERE external_id = ? AND company_id = ?', ['job-7', cid]);
    assert.strictEqual(t[0].title, 'Updated 7', `title=${t[0].title}`);
  });

  // 3. The case that breaks a naive multi-row upsert: the same conflict key twice
  //    in ONE statement. Postgres raises "cannot affect row a second time".
  await check('duplicate external_id in one batch does not error (last wins)', async () => {
    const res = await jobsRepo.syncForCompany(cid, 'greenhouse', [
      mk(1000, { title: 'First' }),
      mk(1000, { title: 'Second' }),
      mk(1001),
    ]);
    assert.strictEqual(res.added, 2, `added=${res.added}`);
    const { rows } = await query('SELECT title FROM jobs WHERE external_id = ? AND company_id = ?', ['job-1000', cid]);
    assert.strictEqual(rows.length, 1, `rows=${rows.length}`);
    assert.strictEqual(rows[0].title, 'Second', `title=${rows[0].title}`);
  });

  // 4. description = COALESCE(EXCLUDED.description, jobs.description): a null in a
  //    later sync must NOT wipe a description we already have.
  await check('null description preserves the stored one', async () => {
    await jobsRepo.syncForCompany(cid, 'greenhouse', [mk(2000, { description: 'Full text' })]);
    await jobsRepo.syncForCompany(cid, 'greenhouse', [mk(2000, { description: null })]);
    const { rows } = await query('SELECT description FROM jobs WHERE external_id = ? AND company_id = ?', ['job-2000', cid]);
    assert.strictEqual(rows[0].description, 'Full text', `description=${rows[0].description}`);
  });

  // 5. visa_sponsorship / experience_level keep their value when the new one is ''.
  await check('empty enrichment fields do not overwrite stored values', async () => {
    await jobsRepo.syncForCompany(cid, 'greenhouse', [mk(3000, { visa_sponsorship: 'yes', experience_level: 'senior' })]);
    await jobsRepo.syncForCompany(cid, 'greenhouse', [mk(3000)]);
    const { rows } = await query(
      'SELECT visa_sponsorship, experience_level FROM jobs WHERE external_id = ? AND company_id = ?', ['job-3000', cid]);
    assert.strictEqual(rows[0].visa_sponsorship, 'yes', `visa=${rows[0].visa_sponsorship}`);
    assert.strictEqual(rows[0].experience_level, 'senior', `level=${rows[0].experience_level}`);
  });

  // 5b. The bug that erased an 18.5-hour backfill: an ATS whose list response has no
  //     salary passes NULL every sync, which used to overwrite a backfilled value.
  await check('null salary does not erase a backfilled one', async () => {
    await jobsRepo.syncForCompany(cid, 'greenhouse', [mk(3500)]);
    await query('UPDATE jobs SET salary_min = ?, salary_max = ?, salary_currency = ?, salary_interval = ? WHERE external_id = ? AND company_id = ?',
      ['90000', '120000', 'USD', 'year', 'job-3500', cid]);
    await jobsRepo.syncForCompany(cid, 'greenhouse', [mk(3500)]); // adapter supplies no salary
    const { rows } = await query('SELECT salary_min, salary_max, salary_currency, salary_interval FROM jobs WHERE external_id = ? AND company_id = ?', ['job-3500', cid]);
    assert.strictEqual(String(rows[0].salary_min), '90000', `salary_min=${rows[0].salary_min}`);
    assert.strictEqual(String(rows[0].salary_max), '120000', `salary_max=${rows[0].salary_max}`);
    assert.strictEqual(rows[0].salary_currency, 'USD', `currency=${rows[0].salary_currency}`);
    assert.strictEqual(rows[0].salary_interval, 'year', `interval=${rows[0].salary_interval}`);
  });

  // 5c. But a real incoming salary must still update.
  await check('incoming salary still overwrites', async () => {
    await jobsRepo.syncForCompany(cid, 'greenhouse', [mk(3600, { salary_min: '10', salary_max: '20' })]);
    await jobsRepo.syncForCompany(cid, 'greenhouse', [mk(3600, { salary_min: '55', salary_max: '75' })]);
    const { rows } = await query('SELECT salary_min, salary_max FROM jobs WHERE external_id = ? AND company_id = ?', ['job-3600', cid]);
    assert.strictEqual(String(rows[0].salary_min), '55', `salary_min=${rows[0].salary_min}`);
    assert.strictEqual(String(rows[0].salary_max), '75', `salary_max=${rows[0].salary_max}`);
  });

  // 6. A previously removed job comes back (removed_at = NULL) on re-sync.
  await check('re-syncing a removed job revives it', async () => {
    await jobsRepo.syncForCompany(cid, 'greenhouse', [mk(4000)]);
    await query("UPDATE jobs SET removed_at = NOW_FN WHERE external_id = ? AND company_id = ?"
      .replace('NOW_FN', process.env.DATABASE_URL ? 'NOW()' : "datetime('now')"), ['job-4000', cid]);
    await jobsRepo.syncForCompany(cid, 'greenhouse', [mk(4000)]);
    const { rows } = await query('SELECT removed_at FROM jobs WHERE external_id = ? AND company_id = ?', ['job-4000', cid]);
    assert.strictEqual(rows[0].removed_at, null, `removed_at=${rows[0].removed_at}`);
  });

  // 7. Empty list must be a no-op, not a malformed "VALUES ()".
  await check('empty incoming list is a no-op', async () => {
    const res = await jobsRepo.syncForCompany(cid, 'greenhouse', []);
    assert.strictEqual(res.added, 0);
    assert.strictEqual(res.updated, 0);
  });

  // 8. FA-053: ATS demo/sandbox boards are not employers. Every crawler and feed loader funnels
  // through syncForCompany, so this is where the guard has to hold. SANDBOX_REJECT is unset in
  // the first three (the default is enforce) and set per case in the last.
  const withMode = async (mode, fn) => {
    const prev = process.env.SANDBOX_REJECT;
    if (mode === undefined) delete process.env.SANDBOX_REJECT; else process.env.SANDBOX_REJECT = mode;
    try { await fn(); } finally { if (prev === undefined) delete process.env.SANDBOX_REJECT; else process.env.SANDBOX_REJECT = prev; }
  };
  const addCompany = async (ats, slug, careerUrl) => {
    await query('INSERT INTO companies (career_url, domain, ats, ats_slug, company_name) VALUES (?, ?, ?, ?, ?)',
      [careerUrl, new URL(careerUrl).hostname, ats, slug, slug]);
    const { rows: [co] } = await query('SELECT id FROM companies WHERE career_url = ?', [careerUrl]);
    return co.id;
  };
  const stored = async (companyId) =>
    Number((await query('SELECT COUNT(*) AS n FROM jobs WHERE company_id = ?', [companyId])).rows[0].n);

  await check('FA-053: a demo board stores nothing by default', async () => {
    await withMode(undefined, async () => {
      const id = await addCompany('lever', 'leverdemo-8', 'https://jobs.lever.co/leverdemo-8');
      const res = await jobsRepo.syncForCompany(id, 'lever', [mk(9001, { url: 'https://jobs.lever.co/leverdemo-8/9001' })]);
      assert.strictEqual(res.added, 0);
      assert.strictEqual(res.rejected, 1);
      assert.strictEqual(await stored(id), 0);
    });
  });

  await check('FA-053: a real employer with "sandbox" in its name is stored', async () => {
    await withMode(undefined, async () => {
      const id = await addCompany('greenhouse', 'sandboxvr', 'https://boards.greenhouse.io/sandboxvr');
      const res = await jobsRepo.syncForCompany(id, 'greenhouse', [mk(9002, { url: 'https://boards.greenhouse.io/sandboxvr/jobs/9002' })]);
      assert.strictEqual(res.rejected, 0);
      assert.strictEqual(await stored(id), 1);
    });
  });

  await check('FA-053: a feed company keeps its real postings and loses only the demo ones', async () => {
    await withMode(undefined, async () => {
      const id = await addCompany('simplify', 'feed-employer', 'https://simplify.jobs/c/feed-employer');
      const res = await jobsRepo.syncForCompany(id, 'simplify', [
        mk(9003, { url: 'https://boards.greenhouse.io/someemployer/jobs/9003' }),
        mk(9004, { url: 'https://acme-demo.recruitee.com/o/qa-engineer' }),
        mk(9005, { url: 'https://weedmansandbox.applytojob.com/apply/x/y' }),
      ]);
      assert.strictEqual(res.rejected, 2);
      assert.strictEqual(await stored(id), 1);
    });
  });

  await check('FA-053: SANDBOX_REJECT=log stores everything and SANDBOX_REJECT=off too', async () => {
    for (const mode of ['log', 'off']) {
      await withMode(mode, async () => {
        const id = await addCompany('lever', `leverdemo-${mode}`, `https://jobs.lever.co/leverdemo-${mode}`);
        const res = await jobsRepo.syncForCompany(id, 'lever', [mk(9006, { url: `https://jobs.lever.co/leverdemo-${mode}/9006` })]);
        assert.strictEqual(res.rejected, 0, `${mode}: rejected=${res.rejected}`);
        assert.strictEqual(await stored(id), 1, `${mode}: stored`);
      });
    }
  });

  await check('FA-053: a company handed in by the caller is used, with no lookup of its own', async () => {
    // Company id 999999 does not exist, so a lookup by id would find nothing; and the posting URL
    // carries no marker, so only the handed-in slug can reject it. Rejecting it proves the
    // handed-in company was the evidence.
    await withMode(undefined, async () => {
      const res = await jobsRepo.syncForCompany(999999, 'lever', [mk(9200, { url: 'https://example.com/jobs/9200' })],
        { company: { ats_slug: 'leverdemo-8', career_url: 'https://jobs.lever.co/leverdemo-8' } });
      assert.strictEqual(res.rejected, 1);
      assert.strictEqual(res.added, 0);
    });
  });

  await check('FA-053: SANDBOX_REJECT=off ignores a handed-in sandbox company', async () => {
    await withMode('off', async () => {
      const id = await addCompany('lever', 'plain-co', 'https://jobs.lever.co/plain-co');
      const res = await jobsRepo.syncForCompany(id, 'lever', [mk(9201, { url: 'https://jobs.lever.co/plain-co/9201' })],
        { company: { ats_slug: 'leverdemo-8', career_url: 'https://jobs.lever.co/leverdemo-8' } });
      assert.strictEqual(res.rejected, 0);
      assert.strictEqual(await stored(id), 1);
    });
  });

  await check('FA-053: a demo board is not retired by absence when the guard empties its batch', async () => {
    // The existing rows of a rejected board must be left for the retire script, not silently
    // aged out by the absence counter reading an emptied batch as "everything closed".
    await withMode('off', async () => {
      const id = await addCompany('lever', 'leverdemo-keep', 'https://jobs.lever.co/leverdemo-keep');
      await jobsRepo.syncForCompany(id, 'lever', [mk(9007, { url: 'https://jobs.lever.co/leverdemo-keep/9007' })]);
    });
    await withMode(undefined, async () => {
      const { rows: [co] } = await query("SELECT id FROM companies WHERE ats_slug = 'leverdemo-keep'");
      // Job 9007 is stored. Each sync below carries a DIFFERENT demo posting, so 9007 is absent
      // from every batch: unguarded, the absence counter would tick for it on each one. Guarded,
      // the batch is emptied, which the counter reads as "the adapter returned nothing" and skips.
      for (let i = 0; i < 5; i++) await jobsRepo.syncForCompany(co.id, 'lever', [mk(9100 + i, { url: `https://jobs.lever.co/leverdemo-keep/${9100 + i}` })]);
      const { rows } = await query('SELECT removed_at, absent_syncs FROM jobs WHERE company_id = ? AND external_id = ?', [co.id, 'job-9007']);
      assert.strictEqual(rows.length, 1, 'the stored job is still there');
      assert.strictEqual(rows[0].removed_at, null, 'must not be retired by the sync');
      assert.strictEqual(Number(rows[0].absent_syncs), 0, `must not even be counted absent (absent_syncs=${rows[0].absent_syncs})`);
    });
  });

  // 9. Timing signal: this is the whole point of the change.
  const N = 1000;
  const bulk = Array.from({ length: N }, (_, i) => mk(50000 + i));
  const t0 = Date.now();
  await jobsRepo.syncForCompany(cid, 'greenhouse', bulk);
  console.log(`  ${N} jobs synced in ${Date.now() - t0}ms (${dialect})`);

  await closeDb();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
