/**
 * Dead-job detection + pruning.
 *
 * Fetches a job's career-page URL and decides whether the posting is still live.
 * Used by:
 *   - the worker's runDeadJobPruning loop (src/worker.js), and
 *   - the scripts/check-dead-jobs.js CLI.
 *
 * Only *confirmed* dead postings (404/410 or an explicit dead-page phrase) are
 * pruned. Anything uncertain (timeout, 5xx, transient network error) is left
 * alone and simply re-checked on a later rotation.
 */

const DEAD_INDICATORS = [
  'this job posting is no longer available',
  'this position has been filled',
  'this job is no longer available',
  'this posting has expired',
  'job not found',
  'page not found',
  'position is no longer available',
  'this requisition is no longer available',
  'opportunity is no longer available',
  'this job has been closed',
  'job has expired',
  'no longer accepting applications',
  'this role has been filled',
  'listing has been removed',
  'sorry, this job is no longer open',
  'this position is closed',
  'the job you are looking for is no longer available',
  'this job listing has expired',
];

// Last meaningful path segment of a job URL — the posting's own identifier. Query strings and
// trailing slashes are ignored. Used to tell a redirect that keeps the posting from one that
// drops it (see checkUrl).
function lastPathSegment(u) {
  try {
    const parts = new URL(u).pathname.split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : null;
  } catch { return null; }
}

// Returns { alive: true|false|null, reason }. null = uncertain (do NOT prune).
async function checkUrl(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobChecker/1.0)' },
    });
    clearTimeout(timeout);

    if (res.status === 404 || res.status === 410) return { alive: false, reason: `HTTP ${res.status}` };
    if (!res.ok) return { alive: null, reason: `HTTP ${res.status}` };

    // Redirected off the posting entirely — the board root, or a listing index. Several ATS
    // platforms retire a job this way instead of 404ing: Breezy sends /p/{id}-{slug} to / with a
    // 200 and no dead-page phrase, so every check here said "alive" for a posting that is gone.
    // Found via a job a user reported by hand (church-of-the-highlands, id 229085207); the tell
    // is that the final URL no longer contains the posting's own identifier.
    //
    // Only fires when the original URL HAS an identifiable last segment and the destination has
    // dropped it. A canonicalising redirect that keeps the id is untouched, and a redirect to a
    // deeper path still containing the id stays alive.
    const finalUrl = res.url || url;
    if (finalUrl !== url) {
      const idSeg = lastPathSegment(url);
      if (idSeg && idSeg.length >= 6 && !finalUrl.toLowerCase().includes(idSeg.toLowerCase())) {
        return { alive: false, reason: `redirected off posting -> ${finalUrl.slice(0, 80)}` };
      }
    }

    const html = (await res.text()).toLowerCase();
    for (const indicator of DEAD_INDICATORS) {
      if (html.includes(indicator)) return { alive: false, reason: indicator };
    }
    if (html.length < 500 && (html.includes('sorry') || html.includes('error') || html.includes('not found'))) {
      return { alive: false, reason: `Short error page (${html.length} chars)` };
    }
    return { alive: true, reason: null };
  } catch (err) {
    if (err.name === 'AbortError') return { alive: null, reason: 'Timeout (15s)' };
    return { alive: null, reason: err.message };
  }
}

async function runWithConcurrency(items, maxConcurrency, fn) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(maxConcurrency, items.length) }, () => worker()));
  return results;
}

// A sweep reads a bounded run of heap pages and the next one carries on after it.
//
// It used to be one SELECT with a LIMIT and no cursor, so every sweep started at the top of the
// table and walked past everything it had stamped in the last recheckDays before reaching a row
// it could use. Measured 2026-11-01: 563 sweeps averaged 2.16M blocks touched of a 2.28M-page
// heap to return 5,000 rows, 37 s each (60 s at worst), 9 GB read and 2.3 GB of OTHER queries'
// dirty pages written, a quarter of all reads and 44% of all writes pg_stat_statements tracks.
// Through an index it went past the ring buffer, so all of that cycled the 6 GB buffer pool.
// This read, same day: 5,000 rows, 3,808 blocks read, 358 ms.
//
// On a slow disk it was worse than wasteful. It ran into the 60 s statement ceiling, verified
// nothing, and came back 20 minutes later to read it all again: on 2026-11-01 the attempts at
// 01:57, 02:18 and 02:39 ran 57-58 s and were each cancelled, and a cancelled statement never
// reaches pg_stat_statements, so the 563 above undercounts. In the 02:39 attempt and the two
// minutes after it, 13 of 20 board searches took over 3 s, against 14 of 56 in the seven minutes
// before and 0 of 11 after.
//
// The ORDER BY the old comment warned about is gone for good: this one only sorts a window.
// ctid moves when a row is updated, which is harmless here: a row that moves ahead was just
// stamped, and one that moves behind waits for the next pass.
const WINDOW_PAGES = parseInt(process.env.PRUNE_WINDOW_PAGES || '4000', 10);
const MAX_PAGES_PER_SWEEP = parseInt(process.env.PRUNE_MAX_PAGES_PER_SWEEP || '40000', 10);

// In memory on purpose. A restart starts somewhere else, which costs nothing: the next pass
// covers what this one missed, and no sweep can ever cost more than MAX_PAGES_PER_SWEEP.
let nextPage = null;

/**
 * The rows one sweep will verify, read from at most MAX_PAGES_PER_SWEEP heap pages.
 * Eligibility is what it always was; only the way to the rows changed.
 */
async function readCandidates(query, {
  limit, tailDays, recheckDays, partitionMod, partitionRemainder, startPage,
}) {
  const { rows: [{ pages }] } = await query(
    `SELECT (pg_relation_size('jobs') / current_setting('block_size')::int)::bigint AS pages`);
  const heapPages = Number(pages);
  if (!heapPages) return [];

  let page = startPage ?? nextPage ?? Math.floor(Math.random() * heapPages);
  if (page >= heapPages) page = 0;
  const jobs = [];
  const budget = Math.min(MAX_PAGES_PER_SWEEP, heapPages);
  for (let read = 0; read < budget && jobs.length < limit; read += WINDOW_PAGES) {
    const want = limit - jobs.length;
    const { rows } = await query(
      `SELECT j.id, j.url, (j.ctid::text::point)[0]::bigint AS heap_page,
              (c.last_synced_at IS NOT NULL AND j.last_seen_at < c.last_synced_at - INTERVAL '5 minutes') AS missing_from_sync
         FROM jobs j
         JOIN companies c ON c.id = j.company_id
        WHERE j.ctid >= $2::tid AND j.ctid < $3::tid
          AND j.removed_at IS NULL
          AND j.url IS NOT NULL
          AND j.id % ${partitionMod} = ${partitionRemainder}
          AND (j.last_checked_at IS NULL OR j.last_checked_at < NOW() - INTERVAL '${recheckDays} days')
          AND (
            (j.posted_at IS NOT NULL AND j.posted_at < NOW() - INTERVAL '${tailDays} days')
            OR (c.last_synced_at IS NOT NULL AND j.last_seen_at < c.last_synced_at - INTERVAL '5 minutes')
          )
        ORDER BY j.ctid
        LIMIT $1`,
      [want, `(${page},0)`, `(${page + WINDOW_PAGES},0)`]
    );
    jobs.push(...rows);
    // A window with rows left resumes on the page it stopped at; its stamped rows drop out.
    page = rows.length === want ? Number(rows[rows.length - 1].heap_page) : page + WINDOW_PAGES;
    if (page >= heapPages) page = 0;
  }
  nextPage = page;
  return jobs;
}

/** For tests: forget where the last sweep stopped. */
function resetSweepPosition() {
  nextPage = null;
}

/**
 * Verify a rotating batch of jobs and prune confirmed-dead postings. This is now
 * the ONLY place jobs get marked removed_at — syncForCompany() (jobs.js) used to
 * also remove jobs via list-diff (any stored external_id missing from a sync's
 * incoming set), guarded by a >50%-missing skip heuristic. That was retired: the
 * heuristic froze real closures (ashby's jerry.ai: 350->48 jobs, frozen because
 * 97% were "missing"), and list-diffing itself proved unreliable — external_id
 * churn (a job reposted under a new id while still live at the same URL) showed
 * up independently on Greenhouse and Workday, where a blind diff would have
 * deleted hundreds of still-open jobs. HTTP verification doesn't have that
 * failure mode: a job is only ever removed on a confirmed 404/410 or an explicit
 * dead-page phrase.
 *
 * Scope is now the union of two populations, both eligible once `recheckDays`
 * has passed since their last check:
 *   1. The original tail — jobs posted more than `tailDays` ago (recent jobs are
 *      kept fresh by the crawler, so we don't waste fetches on them).
 *   2. Jobs "missing from the latest sync" — j.last_seen_at predates their
 *      company's last_synced_at by more than a few minutes, meaning the most
 *      recent successful sync didn't include them. This is the population that
 *      needs verifying now that nothing removes them at sync time. Prioritized
 *      first since it's fresh, actionable signal rather than background hygiene.
 *
 * `partitionMod`/`partitionRemainder` split the eligible population by
 * `j.id % partitionMod = partitionRemainder`, so multiple independent runners
 * (e.g. the Render worker and a local process) can each own a disjoint slice
 * with zero coordination and no risk of double-checking the same job — useful
 * for spreading outbound verification traffic across separate IPs/networks.
 * Defaults to no partitioning (mod=1, remainder=0 matches everything).
 *
 * @returns {Promise<{checked:number, dead:number, uncertain:number}>}
 */
async function pruneDeadJobs({
  limit = 400, concurrency = 10, tailDays = 30, recheckDays = 14,
  partitionMod = 1, partitionRemainder = 0, startPage,
} = {}) {
  const { query } = require('../db/connection');
  const t = Number(tailDays) || 30;
  const r = Number(recheckDays) || 14;
  const pMod = Number(partitionMod) || 1;
  const pRem = ((Number(partitionRemainder) || 0) % pMod + pMod) % pMod;

  const jobs = await readCandidates(query, {
    limit, tailDays: t, recheckDays: r, partitionMod: pMod, partitionRemainder: pRem, startPage,
  });
  if (!jobs.length) return { checked: 0, dead: 0, uncertain: 0 };

  const deadIds = [];
  let uncertain = 0;
  await runWithConcurrency(jobs, concurrency, async (job) => {
    const result = await checkUrl(job.url);
    if (result.alive === false) deadIds.push(job.id);
    else if (result.alive === null) uncertain++;
  });

  // Write back in chunks with a breath between them. Both columns are indexed, so a single
  // 3000-row UPDATE is a real write on a 28GB table with 26 indexes — the shape that has
  // starved the API before. 500 at a time keeps each statement well inside the pool timeout
  // and leaves gaps for user queries.
  // SORTED, and each chunk locks in id order. Splitting one UPDATE into several introduced
  // `deadlock detected`: eleven crawlers upsert into this table continuously, and two
  // transactions touching the same rows in opposite orders deadlock by definition. Postgres
  // takes row locks in the order rows are visited, so every writer ascending by id can only
  // ever wait — never form a cycle. `ORDER BY id` inside the subquery is what enforces that;
  // `id = ANY(array)` alone does not guarantee visit order.
  const writeInChunks = async (sql, ids) => {
    const sorted = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (let i = 0; i < sorted.length; i += 500) {
      await query(sql, [sorted.slice(i, i + 500)]);
      if (i + 500 < sorted.length) await new Promise((r) => setTimeout(r, 250));
    }
  };

  if (deadIds.length) {
    await writeInChunks(
      `UPDATE jobs SET removed_at = NOW() WHERE id IN (
         SELECT id FROM jobs WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE
       )`, deadIds);
  }
  // Stamp every checked job so the rotation advances (including the ones we pruned).
  await writeInChunks(
    `UPDATE jobs SET last_checked_at = NOW() WHERE id IN (
       SELECT id FROM jobs WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE
     )`, jobs.map((j) => j.id));

  return { checked: jobs.length, dead: deadIds.length, uncertain };
}

module.exports = { DEAD_INDICATORS, checkUrl, runWithConcurrency, pruneDeadJobs, readCandidates, resetSweepPosition };
