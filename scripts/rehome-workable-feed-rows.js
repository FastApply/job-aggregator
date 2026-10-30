#!/usr/bin/env node
/**
 * Move live jobs off the Workable "companies" that are a URL's first path word.
 *
 *   DATABASE_URL=... NODE_ENV=production node scripts/rehome-workable-feed-rows.js          # SHADOW
 *   DATABASE_URL=... NODE_ENV=production APPLY=1 node scripts/rehome-workable-feed-rows.js  # armed
 *
 * Feeds filed jobs.workable.com/view/... links under the slug "view" or "company", so one company
 * row holds thousands of employers' postings under the first name that arrived: on 2026-10-30,
 * "Advansys" 29,990 live rows, "Digitals AI Inc" 6,372, "View" 1,548. Each row moves to a company
 * of its own employer, read from the URL. Short links (slug "j", "Deep Science Ventures", 3,416)
 * name no employer and are left: RESOLVE_J=1 follows each one's redirect to its account, one
 * request per row, DELAY_MS apart.
 *
 * Idempotent: a moved row is no longer on a junk company. Uses the same career_url as the feed
 * import, so later imports land on the company this creates.
 * Env: BATCH (2000 rows a step) · DELAY_MS (400) · RESOLVE_J
 */
const { employerSlugOfUrl, workableFeedCompany, nameOfSlug } = require('../src/utils/workable-feed-company');

const JUNK = "c.ats = 'workable' AND c.ats_slug IN ('view','company','j')";

async function shortLinkAccount(url) {
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
  const m = /^(?:https?:\/\/apply\.workable\.com)?\/([^/]+)\/j\//i.exec(res.headers.get('location') || '');
  return m ? m[1] : null;
}

async function main() {
  const db = require('../src/db/connection');
  const APPLY = process.env.APPLY === '1';
  const RESOLVE_J = process.env.RESOLVE_J === '1';
  const BATCH = parseInt(process.env.BATCH || '2000', 10);
  const DELAY_MS = parseInt(process.env.DELAY_MS || '400', 10);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  console.log(`mode: ${APPLY ? 'APPLY' : 'SHADOW'}`);

  const companyIds = new Map();
  async function companyFor(slug, name) {
    if (companyIds.has(slug)) return companyIds.get(slug);
    const c = workableFeedCompany(`https://jobs.workable.com/view/x/y-at-${slug}`, name);
    const { rows } = await db.query(
      `INSERT INTO companies (company_name, domain, ats, ats_slug, career_url, status, origin, created_at, updated_at)
         VALUES ($1, 'jobs.workable.com', 'workable', $2, $3, 'active', 'workable_feed_rehome', NOW(), NOW())
       ON CONFLICT (career_url) DO UPDATE SET updated_at = NOW()
       RETURNING id`, [name, c.slug, c.careerUrl]);
    companyIds.set(slug, rows[0].id);
    return rows[0].id;
  }

  let after = 0, moved = 0, left = 0;
  const employers = new Set();
  for (;;) {
    const { rows } = await db.query(
      `SELECT j.id, j.url FROM jobs j JOIN companies c ON c.id = j.company_id
        WHERE ${JUNK} AND j.id > $1 AND j.removed_at IS NULL ORDER BY j.id LIMIT $2`, [after, BATCH]);
    if (!rows.length) break;
    for (const row of rows) {
      after = row.id;
      let slug = employerSlugOfUrl(row.url), name = slug && nameOfSlug(slug);
      if (!slug && RESOLVE_J && /apply\.workable\.com\/j\//i.test(row.url)) {
        await sleep(DELAY_MS);
        const account = await shortLinkAccount(row.url).catch(() => null);
        if (account) { slug = account.toLowerCase(); name = nameOfSlug(slug); }
      }
      if (!slug) { left++; continue; }
      employers.add(slug);
      moved++;
      if (APPLY) {
        const companyId = await companyFor(slug, name);
        await db.query('UPDATE jobs SET company_id = $1, index_dirty_at = NOW() WHERE id = $2', [companyId, row.id]);
      }
    }
    process.stdout.write(`\r  ${APPLY ? 'moved' : 'would move'} ${moved.toLocaleString()} to ${employers.size.toLocaleString()} employers, left ${left.toLocaleString()}   `);
  }
  console.log(`\n${APPLY ? 'moved' : 'would move'} ${moved.toLocaleString()} rows to ${employers.size.toLocaleString()} employers; ${left.toLocaleString()} left with no employer in the URL`);
  if (db.closeDb) await db.closeDb();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
