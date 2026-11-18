'use strict';
/**
 * A crawl that carries no job type or publish date keeps the stored ones (src/db/repositories/
 * jobs.js). A Workday detail call that fails sends NULL for both while the description is kept,
 * and FastApply's matcher then saw a "Full time" role as having no type and a 237-day posting as
 * undated (pref-match 2026-11-18).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-type-date-'));
delete process.env.DATABASE_URL;
process.env.DATABASE_PATH = path.join(dir, 't.db');

let sqliteOk = true;
try { require('better-sqlite3'); new (require('better-sqlite3'))(':memory:').close(); } catch { sqliteOk = false; }

test('a sync with no type or date keeps the stored ones; a sync with new ones replaces them', { skip: !sqliteOk && 'better-sqlite3 is not built for this Node' }, async () => {
  const { migrate, jobsRepo, companiesRepo, closeDb } = require('../src/db');
  const { query } = require('../src/db/connection');
  try {
    await migrate();
    const c = await companiesRepo.createFromCrawl({ ats: 'workday', atsSlug: 'pjtpartners', origin: 'crawl' });
    const row = (over) => ({
      external_id: 'workday_R0003304',
      title: 'Risk Manager - Corporate',
      url: 'https://pjtpartners.wd1.myworkdayjobs.com/Careers/job/New-York/Risk-Manager---Corporate_R0003304',
      location: 'New York',
      description: '<p>Risk Manager</p>',
      employment_type: 'Full time',
      posted_at: '2026-03-26',
      ...over,
    });
    await jobsRepo.syncForCompany(c.id, 'workday', [row({})]);
    // The detail call failed: no description, type or date.
    await jobsRepo.syncForCompany(c.id, 'workday', [row({ description: null, employment_type: null, posted_at: null })]);
    let { rows } = await query('SELECT employment_type, posted_at, description FROM jobs');
    assert.equal(rows[0].employment_type, 'Full-time');
    assert.equal(String(rows[0].posted_at).slice(0, 10), '2026-03-26');
    assert.equal(rows[0].description, '<p>Risk Manager</p>');
    // A real change still lands.
    await jobsRepo.syncForCompany(c.id, 'workday', [row({ employment_type: 'Part time', posted_at: '2026-11-12' })]);
    ({ rows } = await query('SELECT employment_type, posted_at FROM jobs'));
    assert.equal(rows[0].employment_type, 'Part-time');
    assert.equal(String(rows[0].posted_at).slice(0, 10), '2026-11-12');
  } finally {
    await closeDb();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
