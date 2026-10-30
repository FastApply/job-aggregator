/**
 * Seed employer boards for the URL-named platforms (UKG, ADP, ADP Workforce Now, SilkRoad, Gem,
 * Kula) as companies rows the crawler then picks up.
 *
 * A board is seeded only after its own adapter reads at least one job from it, so a dead link, an
 * empty board or a mistyped name never reaches the crawl queue. Boards already stored under the
 * same platform (case-insensitively, by ats_slug) are skipped before any request is made.
 *
 * seedBoardsFromRecentJobs runs from the worker once a day: imports (Simplify, Xeruit, Jobhose ...)
 * keep bringing job URLs that name boards we do not crawl yet; on 2026-10-29 that one source held
 * 3,052 such boards. The placeholder companies those imported jobs sit under are left alone: they
 * come from local_promote, and changing their career_url makes promote-cycle re-create them.
 */
const { query } = require('../db/connection');
const logger = require('../logger');
const { getAdapter } = require('../adapters');
const { boardFromUrl, careerUrlFor, boardKey, BOARD_URL_ATS, BOARD_URL_SQL_RE } = require('../utils/board-urls');

const CHECK_TIMEOUT_MS = 3 * 60 * 1000;
const isPermanent = (msg) => /HTTP 40[04]\b|not found|no longer|invalid/i.test(msg || '');

async function knownBoards() {
  const { rows } = await query(
    'SELECT ats, ats_slug FROM companies WHERE ats = ANY(?::text[]) AND ats_slug IS NOT NULL',
    [BOARD_URL_ATS]
  );
  return new Set(rows.map((r) => boardKey(r.ats, r.ats_slug)));
}

/** Read the board with its own adapter: { status: 'live' | 'empty' | 'dead' | 'error', jobs, companyName }. */
async function checkBoard(ats, slug) {
  try {
    const res = await Promise.race([
      getAdapter(ats).fetchJobs(slug),
      new Promise((_, reject) => setTimeout(() => reject(new Error('check timeout')), CHECK_TIMEOUT_MS)),
    ]);
    const jobs = (res && res.jobs) || [];
    return { status: jobs.length ? 'live' : 'empty', jobs: jobs.length, companyName: (res && res.meta && res.meta.companyName) || null };
  } catch (e) {
    return { status: isPermanent(e.message) ? 'dead' : 'error', jobs: 0, error: e.message };
  }
}

/**
 * candidates: [{ ats, slug, companyName? }]. Returns counts by outcome and the rows inserted.
 * `dryRun` checks and reports without writing; `known` (a Set of boardKey) replaces the lookup.
 */
async function seedBoards(candidates, { origin, dryRun = false, known = null, onProgress = null } = {}) {
  if (!origin) throw new Error('seedBoards needs an origin');
  const have = known || (await knownBoards());
  const todo = new Map();
  for (const c of candidates) {
    if (!c || !BOARD_URL_ATS.includes(c.ats) || !c.slug) continue;
    const key = boardKey(c.ats, c.slug);
    if (have.has(key) || todo.has(key)) continue;
    todo.set(key, c);
  }
  const counts = { candidates: todo.size, live: 0, empty: 0, dead: 0, error: 0, inserted: 0 };
  const seeded = [];
  let n = 0;
  for (const c of todo.values()) {
    const r = await checkBoard(c.ats, c.slug);
    counts[r.status]++;
    if (r.status === 'live') {
      const careerUrl = careerUrlFor(c.ats, c.slug);
      const row = { careerUrl, ats: c.ats, slug: c.slug, companyName: r.companyName || c.companyName || null, domain: new URL(careerUrl).hostname, jobs: r.jobs };
      if (!dryRun) {
        const { rowCount } = await query(
          `INSERT INTO companies (career_url, ats, ats_slug, company_name, domain, status, origin, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?, NOW(), NOW()) ON CONFLICT (career_url) DO NOTHING`,
          [careerUrl, c.ats, c.slug, row.companyName, row.domain, origin]
        );
        counts.inserted += rowCount || 0;
      }
      seeded.push(row);
    }
    n++;
    if (onProgress && n % 50 === 0) onProgress(n, todo.size, counts);
  }
  return { counts, seeded };
}

/** Boards named by job URLs first seen in the last `days` days, under companies not crawled as that platform. */
async function seedBoardsFromRecentJobs({ days = 2, origin = 'job_url_boards_auto', dryRun = false } = {}) {
  const { rows } = await query(
    `SELECT j.url, c.company_name
       FROM jobs j JOIN companies c ON c.id = j.company_id
      WHERE j.removed_at IS NULL
        AND j.first_seen_at > NOW() - make_interval(days => ?::int)
        AND c.ats <> ALL(?::text[])
        AND j.url ~* ?`,
    [days, BOARD_URL_ATS, BOARD_URL_SQL_RE]
  );
  const candidates = [];
  for (const r of rows) {
    const b = boardFromUrl(r.url);
    if (b) candidates.push({ ...b, companyName: r.company_name || null });
  }
  const out = await seedBoards(candidates, { origin, dryRun });
  logger.info({ days, jobUrls: rows.length, ...out.counts }, 'seed-boards: boards from recent job URLs');
  return out;
}

module.exports = { seedBoards, seedBoardsFromRecentJobs, checkBoard, knownBoards };
