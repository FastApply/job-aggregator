#!/usr/bin/env node
/**
 * Load a Simplify dump (scripts/fetch-simplify.js output) into the LOCAL SQLite DB.
 *
 *   node scripts/load-simplify.js dump.jsonl            # group, map, upsert
 *   node scripts/load-simplify.js dump.jsonl --report   # map + summarise, write nothing
 *
 * LOCAL ONLY — refuses to run with DATABASE_URL set unless ALLOW_POSTGRES=1. Same reasoning as
 * fetch-xeruit.js: every importer shares one connection module, and this one writes ~1.7M rows.
 *
 * WHAT THIS SOURCE IS. Simplify's search index carries no job description and no employer apply
 * URL — the scoped key excludes `url` server-side and no query shape recovers it. So these rows
 * are metadata, not postings: title, company, location, salary, level, and the fields nothing
 * else we ingest provides — sponsors_h1b, company_size, funding_stage/total, year_founded.
 *
 *   url          synthesised as https://simplify.jobs/p/{posting_id}. Verified real: a live
 *                posting returns 200 and a bogus UUID returns 404, so the dead-job pruner works
 *                against it unmodified.
 *   description  left NULL. schema.js resets '' to NULL precisely so backfills retry, and the
 *                Simplify posting page does carry the text if that is ever worth harvesting.
 *
 * These rows CANNOT merge with natively-crawled jobs: without an employer board URL there is no
 * (ats, ats_slug) to key on, so companies land under ats='simplify' in their own namespace and
 * a posting we also crawl from Greenhouse will exist twice. That is inherent to the source.
 *
 * GROUPING. jobsRepo.syncForCompany opens one transaction per company, and the dump is ordered
 * by shuffle_key (random), so companies are scattered across the whole 1.7M-row file. Streaming
 * it directly would open a transaction per company PER CHUNK — hundreds of thousands of them.
 * The file is therefore externally sorted by company_id first (unix sort, bounded memory), so
 * each company is contiguous and costs exactly one transaction.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');

if (process.env.DATABASE_URL && process.env.ALLOW_POSTGRES !== '1') {
  console.error('Refusing to run: DATABASE_URL is set, and this importer writes to the LOCAL SQLite DB.\n' +
                'Unset it (env -u DATABASE_URL ...) or pass ALLOW_POSTGRES=1 deliberately.');
  process.exit(1);
}

const { companiesRepo, jobsRepo, migrate, closeDb } = require('../src/db');
const { query } = require('../src/db/connection');
const { classifyJob } = require('../src/utils/classify');

const IN = process.argv[2];
const REPORT = process.argv.includes('--report');
const KEEP_TMP = process.env.KEEP_TMP === '1';


// ── mapping ─────────────────────────────────────────────────────────────────────────────

// salary_period is an opaque enum. Inferred from median max_salary across 60k docs:
//   1 -> median 24       hourly
//   4 -> median 145,000  yearly
// Those two are 98.6% of all priced rows and are unambiguous. 2 (median 1,350), 3 (3,100) and
// 5 (900) are each consistent with more than one reading — 3,100 is a plausible weekly OR
// monthly figure — so they are left NULL rather than guessed. Same call as the Xeruit
// salaryFrequency defect: a wrong interval is worse than a missing one.
const SALARY_PERIOD = { 1: 'hourly', 4: 'yearly' };

// Their level vocabulary -> ours. "Expert or higher" is Staff/Principal territory, which maps
// to lead rather than executive (we reserve executive for VP/C-level).
const LEVELS = {
  'Internship': 'internship',
  'Entry Level/New Grad': 'entry',
  'Junior': 'entry',
  'Mid Level': 'mid',
  'Senior': 'senior',
  'Expert or higher': 'lead',
};
// Multi-level postings ("Entry Level/New Grad|Junior|Mid Level") are stored at their LOWEST
// level: the column answers "who may apply", and a seeker filtering entry-level should see it.
const LEVEL_ORDER = ['internship', 'entry', 'mid', 'senior', 'lead', 'executive'];

function mapExperience(levels) {
  const mapped = (levels || []).map((l) => LEVELS[l]).filter(Boolean);
  if (!mapped.length) return null;
  return mapped.sort((a, b) => LEVEL_ORDER.indexOf(a) - LEVEL_ORDER.indexOf(b))[0];
}

// Postgres btree entries cap at ~2704 bytes and location is indexed; a handful of postings
// carry a dozen locations.
const truncate = (s, max = 2000) => (s && s.length > max ? s.slice(0, max) : s) || null;

function mapJob(doc) {
  const title = doc.title || '';
  const location = truncate((doc.locations || []).filter(Boolean).join('; '));
  // sponsors_h1b is tri-state: absent on ~82% of docs, so absent means UNKNOWN, not "no".
  // Where present it is an employer-stated fact, which is strictly better than classifyVisa()
  // guessing from description prose — and these rows have no description to guess from.
  const visa = doc.sponsors_h1b === true ? 'yes' : doc.sponsors_h1b === false ? 'no' : null;

  // No description exists, so classifyJob only ever sees title/location/workplace_type.
  const cls = classifyJob({ title, description: '', location, workplace_type: doc.travel_requirements || '' });

  const period = SALARY_PERIOD[doc.salary_period] || null;
  const hasSalary = doc.min_salary != null || doc.max_salary != null;

  return {
    external_id: `simplify_${doc.posting_id || doc.id}`,
    title,
    department: null,
    location,
    // travel_requirements is a genuine field here (In Person 80% / Hybrid 12% / Remote 8%),
    // unlike Xeruit's workType which was constant. normalizeWorkplaceType maps all three.
    workplace_type: doc.travel_requirements || null,
    employment_type: doc.type || null,
    salary_min: doc.min_salary != null ? String(doc.min_salary) : null,
    salary_max: doc.max_salary != null ? String(doc.max_salary) : null,
    salary_currency: hasSalary ? doc.currency_type || null : null,
    salary_interval: hasSalary ? period : null,
    description: null,
    url: `https://simplify.jobs/p/${doc.posting_id || doc.id}`,
    posted_at: doc.start_date ? new Date(doc.start_date * 1000).toISOString() : null,
    is_remote: cls.is_remote,
    remote_worldwide: cls.remote_worldwide,
    visa_sponsorship: visa,
    experience_level: mapExperience(doc.experience_level),
    raw_data: {
      source: 'simplify',
      simplify_id: doc.id,
      posting_id: doc.posting_id,
      company_id: doc.company_id,
      logoUrl: doc.company_logo || null,
      locations: doc.locations || null,
      functions: doc.functions?.length ? doc.functions : null,
      majors: doc.majors?.length ? doc.majors : null,
      seasons: doc.seasons?.filter((s) => s && s !== 'N/A') || null,
      experience_levels: doc.experience_level || null,
      sponsors_h1b: doc.sponsors_h1b ?? null,
      salary_period_raw: doc.salary_period ?? null,
      // Company facts we hold in no column — the reason this source is worth importing.
      company_size: doc.company_size || null,
      funding_stage: doc.funding_stage || null,
      funding_total: doc.funding_total ?? null,
      year_founded: doc.year_founded ?? null,
      is_scout_job_posting: doc.is_scout_job_posting ?? null,
      updated_date: doc.updated_date ?? null,
      fetchedAt: new Date().toISOString(),
    },
  };
}

// ── load ────────────────────────────────────────────────────────────────────────────────

async function upsertCompany(doc) {
  // company_id is Simplify's own stable uuid, so it is the company key. The career_url is
  // synthetic-but-stable and unique, which is all the schema needs it to be; status='unlinked'
  // keeps these out of the crawler's claim query and out of sync-jobs-to-postgres, both of
  // which require ats_slug IS NOT NULL on an ats we have an adapter for.
  const careerUrl = `https://simplify.jobs/c/${doc.company_id}`;
  await query(
    `INSERT INTO companies (company_name, domain, ats, ats_slug, career_url, logo_url, status, origin, created_at, updated_at)
     VALUES (?, ?, 'simplify', ?, ?, ?, 'unlinked', 'simplify', datetime('now'), datetime('now'))
     ON CONFLICT(career_url) DO NOTHING`,
    [doc.company_name || null, 'simplify.jobs', doc.company_id, careerUrl, doc.company_logo || null]
  );
  const row = await companiesRepo.findByUrl(careerUrl);
  return row?.id || null;
}

async function main() {
  // Checked here rather than at module scope so the mappers stay importable for testing.
  if (!IN || !fs.existsSync(IN)) { console.error('usage: node scripts/load-simplify.js <dump.jsonl> [--report]'); process.exit(1); }
  if (!REPORT) await migrate();

  // External sort by company_id so each company is contiguous — see the header note.
  const tmp = path.join(os.tmpdir(), `simplify-bycompany-${process.pid}.tsv`);
  console.log('grouping by company (external sort)...');
  const t0 = Date.now();
  {
    const out = fs.createWriteStream(tmp + '.raw');
    const rl = readline.createInterface({ input: fs.createReadStream(IN), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      const i = line.indexOf('"company_id":"');
      if (i === -1) continue;
      const cid = line.slice(i + 14, line.indexOf('"', i + 14));
      out.write(`${cid}\t${line}\n`);
    }
    out.end();
    await new Promise((r) => out.on('finish', r));
  }
  execFileSync('sort', ['-t\t', '-k1,1', '-o', tmp, tmp + '.raw'], { stdio: 'inherit', maxBuffer: 1 << 28 });
  fs.unlinkSync(tmp + '.raw');
  console.log(`  sorted in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  const stats = { docs: 0, added: 0, updated: 0, companies: 0, skipped: 0, withSalary: 0, withVisa: 0, withLevel: 0 };
  let curId = null, curDoc = null, batch = [];

  async function flush() {
    if (!batch.length) return;
    stats.companies++;
    if (!REPORT) {
      const companyId = await upsertCompany(curDoc);
      if (!companyId) { stats.skipped += batch.length; batch = []; return; }
      const { added, updated } = await jobsRepo.syncForCompany(companyId, 'simplify', batch);
      stats.added += added;
      stats.updated += updated;
    }
    batch = [];
  }

  const rl = readline.createInterface({ input: fs.createReadStream(tmp), crlfDelay: Infinity });
  for await (const line of rl) {
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const cid = line.slice(0, tab);
    let doc; try { doc = JSON.parse(line.slice(tab + 1)); } catch { continue; }
    if (cid !== curId) { await flush(); curId = cid; }
    curDoc = doc;
    const job = mapJob(doc);
    if (job.salary_min || job.salary_max) stats.withSalary++;
    if (job.visa_sponsorship) stats.withVisa++;
    if (job.experience_level) stats.withLevel++;
    batch.push(job);
    stats.docs++;
    if (stats.docs % 25000 === 0) process.stdout.write(`\r  ${stats.docs.toLocaleString()} docs | ${stats.companies.toLocaleString()} companies | +${stats.added.toLocaleString()} new   `);
  }
  await flush();

  if (!KEEP_TMP) fs.unlinkSync(tmp);

  console.log(`\n\n=== ${REPORT ? 'REPORT (nothing written)' : 'DONE'} ===`);
  console.log(`docs read        ${stats.docs.toLocaleString()}`);
  console.log(`companies        ${stats.companies.toLocaleString()}`);
  if (!REPORT) {
    console.log(`  inserted       ${stats.added.toLocaleString()}`);
    console.log(`  updated        ${stats.updated.toLocaleString()}`);
    if (stats.skipped) console.log(`  skipped        ${stats.skipped.toLocaleString()}`);
  }
  console.log(`with salary      ${stats.withSalary.toLocaleString()} (${(stats.withSalary / stats.docs * 100).toFixed(1)}%)`);
  console.log(`with h1b answer  ${stats.withVisa.toLocaleString()} (${(stats.withVisa / stats.docs * 100).toFixed(1)}%)`);
  console.log(`with level       ${stats.withLevel.toLocaleString()} (${(stats.withLevel / stats.docs * 100).toFixed(1)}%)`);

  await closeDb();
}

module.exports = { mapJob, mapExperience };

if (require.main === module) main().catch((err) => { console.error('\n', err); process.exit(1); });
