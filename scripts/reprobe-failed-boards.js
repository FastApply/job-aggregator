#!/usr/bin/env node
/**
 * Re-probe boards marked `failed` and reactivate the ones that are actually serving jobs.
 *
 * WHY. A board goes `failed` on one bad response and nothing ever looks at it again: the crawler's
 * claim query only takes status='active'. So a transient 404, a rate-limit misread as a missing
 * config, or an employer briefly unpublishing their board retires it permanently. Found this way on
 * 2026-09-14: ashby/airapps (498 jobs), greenhouse/coinbase (217), greenhouse/asteraearlycareer2026
 * — all `failed` on a 404 that was no longer true. A 120-board random sample put the false-negative
 * rate at 4-5% of the 17,006 failed boards.
 *
 * WHAT. One cheap list request per board against the same endpoint its adapter uses, classified:
 *   live      2xx and at least one job     -> reactivated under APPLY=1
 *   empty     2xx, valid board, zero jobs  -> reactivated only with REACTIVATE_EMPTY=1
 *   dead      404 / 410 / 422              -> left failed (correctly retired)
 *   throttled 429 / 403 / 503              -> left alone. NEVER read as dead: workable 429s
 *                                             residential IPs on every request, and treating that
 *                                             as "gone" is exactly the misread that filled this
 *                                             table in the first place.
 *   error     timeout / network / parse    -> left alone
 *
 * Reactivation sets status='active', clears error_message and last_synced_at so the crawler
 * re-claims the board on its next pass. It skips a row when another ACTIVE row already exists for
 * the same ats+slug, so it cannot resurrect a deliberately superseded duplicate.
 *
 *   node scripts/reprobe-failed-boards.js                 # shadow: probe and report, write nothing
 *   APPLY=1 node scripts/reprobe-failed-boards.js         # reactivate the live ones
 *   ATS=greenhouse,ashby LIMIT=200 node scripts/...       # scope a run
 *
 * Env: DATABASE_URL (default local jobs_local), APPLY, REACTIVATE_EMPTY, ATS, LIMIT, OUT
 */
const fs = require('fs');
const { Pool } = require('pg');

const DB = process.env.DATABASE_URL || 'postgres://codev@localhost:5432/jobs_local';
const APPLY = process.env.APPLY === '1';
const REACTIVATE_EMPTY = process.env.REACTIVATE_EMPTY === '1';
const LIMIT = parseInt(process.env.LIMIT || '0', 10);
const OUT = process.env.OUT || '';
// Which retired states to re-examine. 'unsupported' is included on request: 140 breezy boards sat
// there with no error message, set by a one-off pass on 2026-08-29/30 that no longer exists in
// the tree, and nothing crawls or re-checks that status either.
const STATUSES = (process.env.STATUS || 'failed').split(',').map((s) => s.trim()).filter(Boolean);

const UA = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', accept: 'application/json, text/xml, */*' };
const enc = encodeURIComponent;
const countTag = (tag) => (t) => (t.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
const arr = (pick) => (t) => { const d = JSON.parse(t); const v = pick(d); return Array.isArray(v) ? v.length : -1; };

// Per-ATS probe: request, how to count jobs, and a concurrency that host tolerates.
const PROBES = {
  greenhouse:      { conc: 8, req: (s) => [`https://boards-api.greenhouse.io/v1/boards/${enc(s)}/jobs`], count: arr((d) => d.jobs) },
  ashby:           { conc: 8, req: (s) => [`https://api.ashbyhq.com/posting-api/job-board/${enc(s)}`], count: arr((d) => d.jobs) },
  lever:           { conc: 6, req: (s) => [`https://api.lever.co/v0/postings/${enc(s)}?mode=json`], count: arr((d) => d) },
  breezy:          { conc: 6, req: (s) => [`https://${enc(s)}.breezy.hr/json`, { redirect: 'manual' }], count: arr((d) => d) },
  recruitee:       { conc: 6, req: (s) => [`https://${enc(s)}.recruitee.com/api/offers`], count: arr((d) => d.offers) },
  pinpoint:        { conc: 6, req: (s) => [`https://${enc(s)}.pinpointhq.com/postings.json`], count: arr((d) => d.data) },
  personio:        { conc: 6, req: (s) => [`https://${enc(s)}.jobs.personio.de/xml`], count: countTag('position') },
  teamtailor:      { conc: 6, req: (s) => [`https://${enc(s)}.teamtailor.com/jobs.rss`], count: countTag('item') },
  smartrecruiters: { conc: 4, req: (s) => [`https://api.smartrecruiters.com/v1/companies/${enc(s)}/postings?limit=1`], count: (t) => { const d = JSON.parse(t); return typeof d.totalFound === 'number' ? d.totalFound : -1; } },
  bamboohr:        { conc: 4, req: (s) => [`https://${enc(s)}.bamboohr.com/careers/list`], count: arr((d) => d.result) },
  rippling:        { conc: 4, req: (s) => [`https://api.rippling.com/platform/api/ats/v1/board/${enc(s)}/jobs`], count: arr((d) => d) },
  workable:        { conc: 2, pauseMs: 600, req: (s) => [`https://apply.workable.com/api/v3/accounts/${enc(s)}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '', location: [], department: [], worktype: [], remote: [] }) }], count: (t) => { const d = JSON.parse(t); return typeof d.total === 'number' ? d.total : (Array.isArray(d.results) ? d.results.length : -1); } },
};
const ATS = (process.env.ATS || Object.keys(PROBES).join(',')).split(',').map((s) => s.trim()).filter((a) => PROBES[a]);

async function probe(ats, slug) {
  const p = PROBES[ats];
  const [url, extra = {}] = p.req(slug);
  let res;
  try {
    res = await fetch(url, { ...extra, headers: { ...UA, ...(extra.headers || {}) }, signal: AbortSignal.timeout(25000) });
  } catch { return { verdict: 'error', jobs: 0 }; }
  if ([404, 410, 422].includes(res.status)) return { verdict: 'dead', jobs: 0, status: res.status };
  if (res.status >= 300 && res.status < 400) return { verdict: 'dead', jobs: 0, status: res.status };   // breezy redirects a closed board to marketing
  if ([429, 403, 503].includes(res.status)) return { verdict: 'throttled', jobs: 0, status: res.status };
  if (!res.ok) return { verdict: 'error', jobs: 0, status: res.status };
  let n;
  try { n = p.count(await res.text()); } catch { return { verdict: 'error', jobs: 0, status: res.status }; }
  if (n < 0) return { verdict: 'error', jobs: 0, status: res.status };
  return { verdict: n > 0 ? 'live' : 'empty', jobs: n, status: res.status };
}

(async () => {
  const pool = new Pool({ connectionString: DB, max: 4 });
  const { rows } = await pool.query(`
    SELECT c.id, c.ats, c.ats_slug
      FROM companies c
     WHERE c.status = ANY($2::text[]) AND c.ats = ANY($1::text[]) AND c.ats_slug IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM companies a WHERE a.ats = c.ats AND lower(a.ats_slug) = lower(c.ats_slug) AND a.status = 'active')
     ORDER BY c.ats, c.id ${LIMIT ? `LIMIT ${LIMIT}` : ''}`, [ATS, STATUSES]);
  console.log(`${APPLY ? 'APPLY' : 'SHADOW'} | ${rows.length} ${STATUSES.join('/')} boards across ${ATS.length} ATS${REACTIVATE_EMPTY ? ' | reactivating empty boards too' : ''}\n`);

  const results = [];
  const byAts = {};
  for (const r of rows) (byAts[r.ats] ||= []).push(r);

  // Hosts are probed in parallel with each other, each at its own concurrency.
  await Promise.all(Object.entries(byAts).map(async ([ats, list]) => {
    const p = PROBES[ats]; let i = 0;
    await Promise.all(Array.from({ length: p.conc }, async () => {
      while (i < list.length) {
        const r = list[i++];
        const out = await probe(ats, r.ats_slug);
        results.push({ ...r, ...out });
        if (p.pauseMs) await new Promise((x) => setTimeout(x, p.pauseMs));
      }
    }));
    process.stdout.write(`  ${ats.padEnd(16)} done (${list.length})\n`);
  }));

  const t = {}; let liveJobs = 0;
  for (const r of results) { (t[r.ats] ||= { live: 0, empty: 0, dead: 0, throttled: 0, error: 0, jobs: 0 })[r.verdict]++; if (r.verdict === 'live') { t[r.ats].jobs += r.jobs; liveJobs += r.jobs; } }
  console.log(`\n  ${'ats'.padEnd(16)} ${'live'.padStart(6)} ${'jobs'.padStart(7)} ${'empty'.padStart(6)} ${'dead'.padStart(6)} ${'thrott'.padStart(7)} ${'error'.padStart(6)}`);
  for (const [a, v] of Object.entries(t).sort()) {
    console.log(`  ${a.padEnd(16)} ${String(v.live).padStart(6)} ${String(v.jobs).padStart(7)} ${String(v.empty).padStart(6)} ${String(v.dead).padStart(6)} ${String(v.throttled).padStart(7)} ${String(v.error).padStart(6)}`);
  }
  const live = results.filter((r) => r.verdict === 'live');
  const empty = results.filter((r) => r.verdict === 'empty');
  console.log(`\n  recoverable: ${live.length} boards with ${liveJobs} jobs  (+${empty.length} valid but empty)`);
  if (OUT) fs.writeFileSync(OUT, results.map((r) => [r.id, r.ats, r.ats_slug, r.verdict, r.jobs, r.status || ''].join('\t')).join('\n'));

  if (APPLY) {
    // One row per board. The NOT EXISTS above rules out a slug that already has an ACTIVE row, but
    // a slug with two retired rows would otherwise have both revived and crawled twice. Lowest id
    // wins, matching how the promoter's company index picks a canonical row.
    const seen = new Set();
    const ids = [...live, ...(REACTIVATE_EMPTY ? empty : [])]
      .sort((a, b) => Number(a.id) - Number(b.id))
      .filter((r) => { const k = `${r.ats}|${String(r.ats_slug).toLowerCase()}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .map((r) => r.id);
    if (ids.length) {
      const { rowCount } = await pool.query(
        `UPDATE companies SET status='active', error_message=NULL, last_synced_at=NULL, updated_at=NOW()
          WHERE id = ANY($1::bigint[]) AND status = ANY($2::text[])`, [ids, STATUSES]);
      console.log(`  reactivated: ${rowCount}`);
    }
  } else {
    console.log('\n  SHADOW — nothing written. Re-run with APPLY=1.');
  }
  await pool.end();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
