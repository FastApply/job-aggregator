#!/usr/bin/env node
/**
 * Name the employer, and fill the text, of UKG rows already stored.
 *
 * Until 2026-10-29 the UKG crawl stored no employer (the search names none, and
 * crawl-companies-local never wrote an adapter's name) and no description (left to
 * backfill-descriptions, which walks oldest first, 40 rows a cycle). So every UKG posting read
 * "Unknown Company" with no text to FastApply, whose First Apply then could not check repeat
 * companies, blacklists or the posting's stated years. The crawl now reads both for new postings
 * (src/adapters/ukg.js); this pass is for the backlog. Re-runnable: it only ever touches a company
 * with no name and a job with no description, so a second run picks up only what is left.
 *
 *   1. companies: each live UKG company with no company_name gets the employer its newest
 *      posting's page names, read by the crawl's own reader (src/adapters/ukg.js employerFromPage:
 *      header logo, board name, or the text's introduction of the employer checked against the
 *      tenant alias; brand placeholders and generic board titles are never names).
 *      company_name and index_dirty_at are written together, so the Meili sync re-indexes that
 *      company's jobs with the name (the companies trigger would also mark it).
 *   2. descriptions (DESCRIPTIONS=1): live UKG jobs with no description, NEWEST first (the ones
 *      First Apply can still apply to), get the posting's text; index_dirty_at is set on each.
 *
 * Small batches with a pause between pages (UKG answers a page in 3-25 s). Nothing is deleted.
 *
 *   DRY=1 node scripts/backfill-ukg-employers.js                     # report only
 *   node scripts/backfill-ukg-employers.js                           # name companies
 *   DESCRIPTIONS=1 DESC_LIMIT=2000 node scripts/backfill-ukg-employers.js   # also fill text
 *
 * Env: DATABASE_URL (the board's Postgres), DRY=1, BATCH (default 20), LIMIT (companies, default
 * all), DESCRIPTIONS=1, DESC_LIMIT (default 1000), GAP_MS (pause between pages, default 500).
 */
const { query, closeDb } = require('../src/db/connection');
const { fetchPosting } = require('../src/adapters/ukg');

const DRY = process.env.DRY === '1';
const BATCH = parseInt(process.env.BATCH || '20', 10);
const LIMIT = parseInt(process.env.LIMIT || '0', 10) || Infinity;
const DESCRIPTIONS = process.env.DESCRIPTIONS === '1';
const DESC_LIMIT = parseInt(process.env.DESC_LIMIT || '1000', 10);
const GAP_MS = parseInt(process.env.GAP_MS || '500', 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function nameCompanies() {
  let cursor = 0, seen = 0, named = 0, missed = 0, failed = 0;
  const sample = [];
  while (seen < LIMIT) {
    // Keyset on id; a company whose page names nobody stays unnamed and is passed over.
    const { rows } = await query(
      `SELECT c.id, c.ats_slug,
              (SELECT j.url FROM jobs j
                WHERE j.company_id = c.id AND j.removed_at IS NULL
                ORDER BY j.posted_at DESC NULLS LAST LIMIT 1) AS url
         FROM companies c
        WHERE c.ats = 'ukg' AND (c.company_name IS NULL OR c.company_name = '') AND c.id > $1
        ORDER BY c.id
        LIMIT $2`,
      [cursor, BATCH]
    );
    if (!rows.length) break;
    for (const co of rows) {
      cursor = co.id;
      if (seen >= LIMIT) break;
      seen++;
      if (!co.url) { missed++; continue; } // no live posting to read
      let page = null;
      try { page = await fetchPosting(co.url); } catch { failed++; }
      await sleep(GAP_MS);
      if (!page) continue;
      if (!page.companyName) { missed++; continue; }
      named++;
      if (sample.length < 15) sample.push({ id: co.id, slug: co.ats_slug, name: page.companyName });
      if (!DRY) {
        await query(
          `UPDATE companies SET company_name = $1, index_dirty_at = NOW(), updated_at = NOW()
            WHERE id = $2 AND (company_name IS NULL OR company_name = '')`,
          [page.companyName.slice(0, 255), co.id]
        );
      }
    }
    process.stderr.write(`  companies: checked ${seen}, named ${named}, no name on page ${missed}, failed ${failed}\n`);
  }
  return { seen, named, missed, failed, sample };
}

async function fillDescriptions() {
  let cursor = null, seen = 0, filled = 0, empty = 0, failed = 0;
  while (seen < DESC_LIMIT) {
    // Newest first by id (ids grow with insertion), keyset downward.
    const { rows } = await query(
      `SELECT id, url FROM jobs
        WHERE ats = 'ukg' AND removed_at IS NULL AND description IS NULL
          ${cursor === null ? '' : 'AND id < $2'}
        ORDER BY id DESC
        LIMIT $1`,
      cursor === null ? [BATCH] : [BATCH, cursor]
    );
    if (!rows.length) break;
    for (const job of rows) {
      cursor = job.id;
      if (seen >= DESC_LIMIT) break;
      seen++;
      let page = null;
      try { page = await fetchPosting(job.url); } catch { failed++; }
      await sleep(GAP_MS);
      if (!page) continue;
      if (!page.description) { empty++; continue; }
      filled++;
      if (!DRY) {
        await query(
          `UPDATE jobs SET description = $1, index_dirty_at = COALESCE(index_dirty_at, NOW())
            WHERE id = $2 AND description IS NULL`,
          [page.description, job.id]
        );
      }
    }
    process.stderr.write(`  descriptions: checked ${seen}, filled ${filled}, no text ${empty}, failed ${failed}\n`);
  }
  return { seen, filled, empty, failed };
}

(async () => {
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL (the board Postgres)'); process.exit(1); }
  const companies = await nameCompanies();
  console.log({ dry: DRY, companies: { ...companies, sample: undefined } });
  console.table(companies.sample);
  if (DESCRIPTIONS) console.log({ dry: DRY, descriptions: await fillDescriptions() });
  await closeDb();
})().catch((e) => { console.error(e.message); process.exit(1); });
