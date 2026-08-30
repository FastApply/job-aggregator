#!/usr/bin/env node
/**
 * Fill gaps in already-imported jobs from the Simplify rows sitting in the same local DB.
 *
 *   node scripts/enrich-from-simplify.js            # SHADOW — reports, writes nothing
 *   APPLY=1 node scripts/enrich-from-simplify.js    # armed
 *
 * Simplify's index carries no description and no employer URL, so as *postings* those rows are
 * thin. What they do carry is fact we cannot otherwise get: an employer-stated H1B answer, a
 * structured salary, and a stated seniority. This copies those onto the jobs we already hold.
 *
 * MATCHING is on normalised (company_name, title). That is a blunt key, so two rules keep it
 * honest:
 *
 *   1. Only ever fills a column that is currently EMPTY. Nothing already known is overwritten,
 *      so a bad match can add noise but can never destroy a fact we ingested from the employer.
 *   2. Only fills from an UNAMBIGUOUS match. Where several Simplify rows share a company+title
 *      and disagree on a value, that field is skipped for that key — detected per field with
 *      MIN(x) = MAX(x) over the group, so one field staying ambiguous does not block the others.
 *
 * Shadow by default because this rewrites rows in bulk, which is the shape of change this repo
 * has been bitten by before.
 */
// The point of this guard is "never write to the LIVE board by accident", not "never use
// Postgres" — the local corpus now lives in a local Postgres (jobs_local), so a loopback URL is
// exactly where these importers are meant to write. Only a REMOTE host needs the override.
const dbHost = (() => { try { return new URL(process.env.DATABASE_URL).hostname; } catch { return ''; } })();
const isLocalDb = ['localhost', '127.0.0.1', '::1', ''].includes(dbHost);
if (process.env.DATABASE_URL && !isLocalDb && process.env.ALLOW_POSTGRES !== '1') {
  console.error('Refusing to run: DATABASE_URL points at a REMOTE database.');
  process.exit(1);
}

const { query, closeDb } = require('../src/db/connection');

const APPLY = process.env.APPLY === '1';

// One row per (company, title) seen in the Simplify rows, carrying each field only when every
// Simplify row in the group agrees on it.
const BUILD_MATCH = `
  CREATE TEMP TABLE simplify_match AS
  SELECT
    lower(trim(c.company_name)) || '|' || lower(trim(j.title)) AS k,
    COUNT(*) AS n,
    CASE WHEN MIN(COALESCE(j.visa_sponsorship,'')) = MAX(COALESCE(j.visa_sponsorship,''))
         AND MIN(COALESCE(j.visa_sponsorship,'')) != '' THEN MIN(j.visa_sponsorship) END AS visa,
    CASE WHEN MIN(COALESCE(j.salary_min,'')) = MAX(COALESCE(j.salary_min,''))
         AND MIN(COALESCE(j.salary_min,'')) != '' THEN MIN(j.salary_min) END AS salary_min,
    CASE WHEN MIN(COALESCE(j.salary_max,'')) = MAX(COALESCE(j.salary_max,''))
         AND MIN(COALESCE(j.salary_max,'')) != '' THEN MIN(j.salary_max) END AS salary_max,
    CASE WHEN MIN(COALESCE(j.salary_currency,'')) = MAX(COALESCE(j.salary_currency,''))
         AND MIN(COALESCE(j.salary_currency,'')) != '' THEN MIN(j.salary_currency) END AS salary_currency,
    CASE WHEN MIN(COALESCE(j.salary_interval,'')) = MAX(COALESCE(j.salary_interval,''))
         AND MIN(COALESCE(j.salary_interval,'')) != '' THEN MIN(j.salary_interval) END AS salary_interval,
    CASE WHEN MIN(COALESCE(j.experience_level,'')) = MAX(COALESCE(j.experience_level,''))
         AND MIN(COALESCE(j.experience_level,'')) != '' THEN MIN(j.experience_level) END AS experience_level
  FROM jobs j JOIN companies c ON c.id = j.company_id
  WHERE j.ats = 'simplify' AND c.company_name IS NOT NULL AND j.title IS NOT NULL
  GROUP BY k`;

// The key for a row we might enrich. Same normalisation as above.
//
// Parameterised by table alias on purpose: the counting queries below run over `jobs j`, but an
// UPDATE's SET subquery is correlated to the bare table name `jobs`, where no alias `j` exists.
// Hard-coding `j.` here compiled fine in shadow mode (which only ever COUNTs) and then failed on
// the first real write with "no such column: j.company_id".
const keyFor = (a) => `lower(trim((SELECT company_name FROM companies WHERE id = ${a}.company_id))) || '|' || lower(trim(${a}.title))`;
const TARGET_KEY = keyFor('j');
const NOT_SIMPLIFY = `j.ats != 'simplify'`;

const FIELDS = [
  { col: 'visa_sponsorship', src: 'visa', empty: `(j.visa_sponsorship IS NULL OR j.visa_sponsorship = '')` },
  { col: 'experience_level', src: 'experience_level', empty: `(j.experience_level IS NULL OR j.experience_level = '')` },
  { col: 'salary_min', src: 'salary_min', empty: `j.salary_min IS NULL` },
  { col: 'salary_max', src: 'salary_max', empty: `j.salary_max IS NULL` },
  { col: 'salary_currency', src: 'salary_currency', empty: `j.salary_currency IS NULL` },
  { col: 'salary_interval', src: 'salary_interval', empty: `j.salary_interval IS NULL` },
];

async function main() {
  const one = async (sql, p = []) => (await query(sql, p)).rows[0];

  const simplify = await one(`SELECT COUNT(*) c FROM jobs WHERE ats = 'simplify'`);
  const targets = await one(`SELECT COUNT(*) c FROM jobs j WHERE ${NOT_SIMPLIFY}`);
  console.log(`simplify rows: ${simplify.c.toLocaleString()} | enrichable rows: ${targets.c.toLocaleString()}\n`);
  if (!simplify.c) { console.log('No simplify rows loaded — run scripts/load-simplify.js first.'); await closeDb(); return; }

  console.log('building match table...');
  await query('DROP TABLE IF EXISTS simplify_match');
  await query(BUILD_MATCH);
  await query('CREATE INDEX idx_simplify_match_k ON simplify_match(k)');
  const m = await one('SELECT COUNT(*) c FROM simplify_match');
  console.log(`  ${m.c.toLocaleString()} distinct (company, title) keys\n`);

  const matched = await one(
    `SELECT COUNT(*) c FROM jobs j WHERE ${NOT_SIMPLIFY} AND ${TARGET_KEY} IN (SELECT k FROM simplify_match)`);
  console.log(`rows with a Simplify counterpart: ${matched.c.toLocaleString()} (${(matched.c / targets.c * 100).toFixed(1)}%)\n`);

  console.log(APPLY ? 'APPLYING:' : 'SHADOW (nothing written) — would fill:');
  for (const f of FIELDS) {
    const where = `${NOT_SIMPLIFY} AND ${f.empty} AND EXISTS (
        SELECT 1 FROM simplify_match m WHERE m.k = ${TARGET_KEY} AND m.${f.src} IS NOT NULL)`;
    const n = (await one(`SELECT COUNT(*) c FROM jobs j WHERE ${where}`)).c;
    if (APPLY && n) {
      await query(
        `UPDATE jobs SET ${f.col} = (
           SELECT m.${f.src} FROM simplify_match m WHERE m.k = ${keyFor('jobs')})
         WHERE id IN (SELECT j.id FROM jobs j WHERE ${where})`);
    }
    console.log(`  ${f.col.padEnd(18)} ${String(n).padStart(7)}`);
  }

  // Company logos, matched on name alone — a logo is a property of the company, not the posting.
  const logoWhere = `logo_url IS NULL AND company_name IS NOT NULL AND EXISTS (
      SELECT 1 FROM companies s WHERE s.ats = 'simplify' AND s.logo_url IS NOT NULL
        AND lower(trim(s.company_name)) = lower(trim(companies.company_name)))`;
  const logos = (await one(`SELECT COUNT(*) c FROM companies WHERE ${logoWhere}`)).c;
  if (APPLY && logos) {
    await query(
      `UPDATE companies SET logo_url = (
         SELECT s.logo_url FROM companies s WHERE s.ats = 'simplify' AND s.logo_url IS NOT NULL
           AND lower(trim(s.company_name)) = lower(trim(companies.company_name)) LIMIT 1)
       WHERE ${logoWhere}`);
  }
  console.log(`  ${'companies.logo_url'.padEnd(18)} ${String(logos).padStart(7)}`);

  if (!APPLY) console.log('\nRe-run with APPLY=1 to write.');
  await closeDb();
}

main().catch((err) => { console.error(err); process.exit(1); });
