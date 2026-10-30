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
 * import, so later imports land on the company this creates. A short link resolved to an account
 * goes to that account's own company when it has one (apply.workable.com/<account>).
 *
 * jobs is UNIQUE(external_id, company_id), and since the feed fix demand-crawl files new copies of
 * these postings under the employer directly, so the target often already holds the posting. Then
 * the junk row is the duplicate and is retired (removed_at) instead of moved; without that the
 * first such row threw and every rerun stopped on it again.
 *
 * Each move queues the row for the index, so this waits while the outbox holds MAX_OUTBOX rows.
 * Env: BATCH (2000 rows a step) · DELAY_MS (400) · RESOLVE_J · MAX_OUTBOX (20000) · POLL_MS (20000)
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
  const MAX_OUTBOX = parseInt(process.env.MAX_OUTBOX || '20000', 10);
  const POLL_MS = parseInt(process.env.POLL_MS || '20000', 10);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  console.log(`mode: ${APPLY ? 'APPLY' : 'SHADOW'}`);

  const companyIds = new Map();
  async function companyFor(slug, name, isAccount) {
    const key = `${isAccount ? 'acct' : 'name'}:${slug}`;
    if (companyIds.has(key)) return companyIds.get(key);
    if (isAccount) {
      const { rows: [own] } = await db.query(
        `SELECT id FROM companies WHERE ats = 'workable' AND lower(ats_slug) = $1
          ORDER BY (status = 'active') DESC, id LIMIT 1`, [slug]);
      if (own) { companyIds.set(key, own.id); return own.id; }
    }
    const c = workableFeedCompany(`https://jobs.workable.com/view/x/y-at-${slug}`, name);
    const { rows } = await db.query(
      `INSERT INTO companies (company_name, domain, ats, ats_slug, career_url, status, origin, created_at, updated_at)
         VALUES ($1, 'jobs.workable.com', 'workable', $2, $3, 'active', 'workable_feed_rehome', NOW(), NOW())
       ON CONFLICT (career_url) DO UPDATE SET updated_at = NOW()
       RETURNING id`, [name, c.slug, c.careerUrl]);
    companyIds.set(key, rows[0].id);
    return rows[0].id;
  }

  // Retire the junk row when the target already has this posting; move it otherwise.
  async function rehome(companyId, jobId) {
    const retire = () => db.query('UPDATE jobs SET removed_at = NOW() WHERE id = $1 AND removed_at IS NULL', [jobId]);
    try {
      const r = await db.query(
        `UPDATE jobs j SET company_id = $1, index_dirty_at = NOW() WHERE j.id = $2
            AND NOT EXISTS (SELECT 1 FROM jobs t WHERE t.company_id = $1 AND t.external_id = j.external_id)`,
        [companyId, jobId]);
      if (r.rowCount) return 'moved';
    } catch (err) {
      if (err.code !== '23505') throw err; // a feed import inserted the twin between the check and the write
    }
    await retire();
    return 'retired';
  }

  async function waitForOutbox() {
    for (;;) {
      const { rows: [o] } = await db.query('SELECT COUNT(*)::int n FROM jobs WHERE index_dirty_at IS NOT NULL');
      if (o.n < MAX_OUTBOX) return;
      await sleep(POLL_MS);
    }
  }

  let after = 0, moved = 0, retired = 0, left = 0;
  const employers = new Set();
  for (;;) {
    const { rows } = await db.query(
      `SELECT j.id, j.url FROM jobs j JOIN companies c ON c.id = j.company_id
        WHERE ${JUNK} AND j.id > $1 AND j.removed_at IS NULL ORDER BY j.id LIMIT $2`, [after, BATCH]);
    if (!rows.length) break;
    if (APPLY) await waitForOutbox();
    for (const row of rows) {
      after = row.id;
      let slug = employerSlugOfUrl(row.url), name = slug && nameOfSlug(slug), isAccount = false;
      if (!slug && RESOLVE_J && /apply\.workable\.com\/j\//i.test(row.url)) {
        await sleep(DELAY_MS);
        const account = await shortLinkAccount(row.url).catch(() => null);
        if (account) { slug = account.toLowerCase(); name = nameOfSlug(slug); isAccount = true; }
      }
      if (!slug) { left++; continue; }
      employers.add(slug);
      if (!APPLY) { moved++; continue; }
      const outcome = await rehome(await companyFor(slug, name, isAccount), row.id);
      if (outcome === 'moved') moved++; else retired++;
    }
    process.stdout.write(`\r  ${APPLY ? 'moved' : 'would move'} ${moved.toLocaleString()}${APPLY ? `, retired ${retired.toLocaleString()} duplicates` : ''} to ${employers.size.toLocaleString()} employers, left ${left.toLocaleString()}   `);
  }
  console.log(`\n${APPLY ? 'moved' : 'would move'} ${moved.toLocaleString()} rows to ${employers.size.toLocaleString()} employers; ${APPLY ? `retired ${retired.toLocaleString()} already held there; ` : ''}${left.toLocaleString()} left with no employer in the URL`);
  if (db.closeDb) await db.closeDb();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
