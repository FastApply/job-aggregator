#!/usr/bin/env node
/**
 * Probe the Simplify job-posting API to find out what the imported corpus can actually become.
 *
 * READ-ONLY. Writes nothing to any database. Run this before any bulk enrichment.
 *
 *   node scripts/probe-simplify-api.js            # 300 companies, 1 job each
 *   SAMPLE=1000 node scripts/probe-simplify-api.js
 *
 * WHY THIS EXISTS
 * The 1,722,859 imported `simplify` rows carry a URL and no description, sit on 23,405 companies
 * that are status='unlinked' with no ATS identity, and have never been liveness-checked (0
 * removals across the whole corpus). That makes them unusable as-is: not crawlable, not
 * promotable, and impossible to tell live from closed.
 *
 * The API changes that. GET /v2/job-posting/:id/{posting_id}/company returns, per posting:
 *   description / requirements / responsibilities  — fills the empty bodies
 *   active, visible, archive                       — the missing liveness signal
 *   ats (int) + tracked_obj ("smartrecruiters:PilotCompany/...")  — the EMPLOYER'S OWN ATS
 *
 * `:id` is a literal path segment, not a placeholder — omitting it 404s. That is a quirk of
 * their routing, not a typo.
 *
 * tracked_obj is the prize. If it names an ATS we already have an adapter for, the company can
 * be resolved to a real board and crawled DIRECTLY by the existing fleet — no ongoing dependency
 * on a third party, and the jobs arrive with descriptions like every other platform. Enrichment
 * through this API is the fallback for whatever does not resolve.
 *
 * So the number that decides the strategy is: what share of companies resolve to an ATS we
 * support? This measures that on a sample instead of guessing, and instead of spending 1.7M
 * requests to find out.
 */
const fs = require('fs');
const { Client } = require('pg');

const LOCAL_URL = process.env.LOCAL_URL || 'postgres://codev@localhost:5432/jobs_local';
const SAMPLE = parseInt(process.env.SAMPLE || '300', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '4', 10);
const DELAY_MS = parseInt(process.env.DELAY_MS || '300', 10);
const OUT = process.env.OUT || '/tmp/simplify-probe.json';

// Adapters that exist in src/adapters. tracked_obj prefixes are matched against these.
const SUPPORTED = new Set(['greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters',
  'recruitee', 'bamboohr', 'breezy', 'pinpoint', 'personio', 'zoho', 'jazzhr', 'rippling',
  'workday', 'teamtailor', 'jobvite', 'comeet', 'paylocity', 'icims', 'oracle', 'taleo']);

const HEADERS = {
  accept: 'application/json',
  origin: 'https://simplify.jobs',
  referer: 'https://simplify.jobs/',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPosting(id, attempt = 0) {
  try {
    const res = await fetch(`https://api.simplify.jobs/v2/job-posting/:id/${id}/company`, {
      headers: HEADERS, signal: AbortSignal.timeout(30000),
    });
    if (res.status === 429) {
      // Back off hard and report it: a 429 here decides whether bulk enrichment is viable at all.
      await sleep(5000 * (attempt + 1));
      if (attempt < 3) return fetchPosting(id, attempt + 1);
      return { rateLimited: true };
    }
    if (!res.ok) return { httpError: res.status };
    return { body: await res.json(), bytes: Number(res.headers.get('content-length') || 0) };
  } catch (e) {
    if (attempt < 2) { await sleep(1500 * (attempt + 1)); return fetchPosting(id, attempt + 1); }
    return { netError: e.message };
  }
}

(async () => {
  const db = new Client({ connectionString: LOCAL_URL });
  await db.connect();

  // One posting per company, so the resolve-rate is measured across COMPANIES (what we would
  // create as crawlable boards), not across postings (which would over-weight big employers).
  const { rows } = await db.query(`
    SELECT DISTINCT ON (j.company_id)
           j.company_id, c.company_name, (j.raw_data::jsonb)->>'posting_id' AS pid
      FROM jobs j JOIN companies c ON c.id = j.company_id
     WHERE j.ats = 'simplify' AND (j.raw_data::jsonb) ? 'posting_id'
     ORDER BY j.company_id, j.id
     LIMIT $1`, [SAMPLE]);
  await db.end();

  console.log(`probing ${rows.length} companies (1 posting each), concurrency ${CONCURRENCY}\n`);

  const stats = {
    ok: 0, httpError: 0, netError: 0, rateLimited: 0,
    active: 0, inactive: 0, withDesc: 0, noDesc: 0,
    resolvable: 0, unresolvable: 0, totalBytes: 0,
  };
  const atsCodes = {};      // ats int -> count
  const prefixes = {};      // tracked_obj prefix -> count
  const unresolved = [];
  const results = [];

  let idx = 0;
  async function worker() {
    for (;;) {
      const i = idx++;
      if (i >= rows.length) return;
      const r = rows[i];
      const out = await fetchPosting(r.pid);

      if (out.rateLimited) { stats.rateLimited++; continue; }
      if (out.httpError) { stats.httpError++; continue; }
      if (out.netError) { stats.netError++; continue; }

      stats.ok++;
      stats.totalBytes += out.bytes || JSON.stringify(out.body).length;
      const d = out.body;
      d.active ? stats.active++ : stats.inactive++;
      (d.description || '').length > 0 ? stats.withDesc++ : stats.noDesc++;
      atsCodes[d.ats] = (atsCodes[d.ats] || 0) + 1;

      const tracked = d.tracked_obj || '';
      const prefix = tracked.includes(':') ? tracked.split(':')[0].toLowerCase() : '(none)';
      prefixes[prefix] = (prefixes[prefix] || 0) + 1;
      if (SUPPORTED.has(prefix)) stats.resolvable++;
      else { stats.unresolvable++; if (unresolved.length < 25) unresolved.push(`${prefix} | ${tracked.slice(0, 60)}`); }

      results.push({
        company: r.company_name, ats: d.ats, tracked_obj: tracked,
        active: d.active, desc: (d.description || '').length, prefix,
      });

      if (stats.ok % 25 === 0) process.stdout.write(`\r  ${stats.ok}/${rows.length} fetched   `);
      if (DELAY_MS) await sleep(DELAY_MS);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const done = stats.ok || 1;
  console.log('\n');
  console.log('fetch results:');
  console.log(`  ok            : ${stats.ok}`);
  console.log(`  http errors   : ${stats.httpError}`);
  console.log(`  net errors    : ${stats.netError}`);
  console.log(`  RATE LIMITED  : ${stats.rateLimited}`);
  console.log(`  avg payload   : ${Math.round(stats.totalBytes / done / 1024)} KB`);
  console.log(`  projected for 1,722,859 postings: ${(stats.totalBytes / done * 1722859 / 1e9).toFixed(0)} GB\n`);

  console.log('content:');
  console.log(`  active        : ${stats.active}  (${(100 * stats.active / done).toFixed(1)}%)`);
  console.log(`  inactive/dead : ${stats.inactive}  (${(100 * stats.inactive / done).toFixed(1)}%)`);
  console.log(`  has description: ${stats.withDesc}  (${(100 * stats.withDesc / done).toFixed(1)}%)\n`);

  console.log('ATS resolution — the number that decides the strategy:');
  console.log(`  resolvable to an adapter we have : ${stats.resolvable}  (${(100 * stats.resolvable / done).toFixed(1)}%)`);
  console.log(`  not resolvable                   : ${stats.unresolvable}  (${(100 * stats.unresolvable / done).toFixed(1)}%)`);
  console.log(`  -> of 23,405 companies, ~${Math.round(23405 * stats.resolvable / done).toLocaleString()} could become directly crawlable\n`);

  console.log('tracked_obj prefixes seen:');
  for (const [p, c] of Object.entries(prefixes).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${SUPPORTED.has(p) ? '[adapter]' : '[  none ]'} ${p.padEnd(18)} ${c}`);
  }
  console.log('\nats code -> count:');
  for (const [a, c] of Object.entries(atsCodes).sort((x, y) => y[1] - x[1])) console.log(`  ats=${String(a).padEnd(4)} ${c}`);
  if (unresolved.length) {
    console.log('\nsample unresolved tracked_obj:');
    for (const u of unresolved.slice(0, 12)) console.log('  ' + u);
  }

  fs.writeFileSync(OUT, JSON.stringify({ stats, atsCodes, prefixes, results }, null, 2));
  console.log(`\nfull results -> ${OUT}`);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
