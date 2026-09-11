#!/usr/bin/env node
/**
 * Turn the imported `simplify` company records into real, crawlable ATS boards.
 *
 * SHADOW BY DEFAULT. Nothing is written unless APPLY=1.
 *
 *   node scripts/resolve-simplify-companies.js              # shadow
 *   LIMIT=500 node scripts/resolve-simplify-companies.js    # bounded trial
 *   APPLY=1 node scripts/resolve-simplify-companies.js      # armed
 *
 * Env:
 *   LOCAL_URL    staging DB (default postgres://codev@localhost:5432/jobs_local)
 *   APPLY=1      create companies (default shadow)
 *   LIMIT        stop after N companies (0 = all)
 *   CONCURRENCY  parallel fetches (default 8)
 *   DELAY_MS     pause per worker between fetches (default 150)
 *   CHECKPOINT   resume file (default /tmp/simplify-resolve.checkpoint)
 *
 * ── WHAT THIS DOES ──────────────────────────────────────────────────────────────────────
 * The 23,405 imported simplify companies are status='unlinked' with ats='simplify',
 * domain='simplify.jobs' and a UUID for a slug. Nothing can crawl them: there is no simplify
 * adapter, and claimBatch requires status='active' AND ats IN (...) AND ats_slug IS NOT NULL.
 *
 * But each of their job postings carries `tracked_obj`, which names the EMPLOYER'S OWN board:
 *
 *     smartrecruiters:IHealthLabs/publication/52fa9db6-.../application
 *     ashbyhq:9-mothers/d25a11b2-...
 *     workday:cvmc/XMLNAME-2026-LNA-in-Training...
 *
 * The segment between ':' and the first '/' is exactly the slug our adapters already take
 * (workday.js hands it straight to discoverConfig(), which probes {slug}.wd{N}.myworkdayjobs.com).
 * So ONE request per company — 23,405, not 1,722,859 — is enough to learn its real ATS and
 * slug. Create those as active companies and the existing fleet crawls them directly from then
 * on, with descriptions and liveness, and with no ongoing dependency on a third-party API.
 *
 * ── WHY ONLY SOME PLATFORMS ─────────────────────────────────────────────────────────────
 * A slug is only useful if it is the identifier OUR adapter expects. Every platform in
 * PREFIX_TO_ATS below had a real slug from this corpus fetched against its canonical board URL
 * and confirmed HTTP 200. The rest are SKIPPED rather than guessed:
 *
 *   workday         tracked_obj gives the CAREER SITE slug, not the tenant. `workday:cvmc/...`
 *                   is University of Vermont Health, but cvmc.wd{1,2,3,5,10,12}.myworkdayjobs.com
 *                   all fail to resolve while uvmhealth.wd1 answers 200 — the tenant is a
 *                   different string that tracked_obj does not carry. This one matters: workday
 *                   was 41 of the first 75 new boards found, so including it would have created
 *                   thousands of companies that fail on first crawl.
 *   paylocity       gives a numeric id (4084966); the adapter needs the tenant GUID
 *                   (b0291521-07e0-416d-...). Different identifier entirely.
 *   oraclecloud     gives `hcxg`; our oracle rows look like `fa-exmi-saasfaprod1.ocs.CX_1`.
 *   icims           gives `careers-tabacalerausa`; our rows store `principal`, unprefixed.
 *   successfactors  gives a hostname (`jobs.jetaviation.com`).
 *   workable        the slug is CORRECT (apply.workable.com/milend-inc parses fine) but the
 *                   host answers 429 to us and the IPRoyal proxy account died 2026-08-08, so
 *                   there is no working crawl path. Re-enable when a proxy is provisioned.
 *
 * Inserting any of those would create companies that fail on first crawl and then sit as dead
 * rows — worse than leaving them alone, because a failed board looks like a real one. They are
 * counted and reported so the gap stays visible and can be handled per-platform later.
 */
const fs = require('fs');
const { Client } = require('pg');
const { Agent, setGlobalDispatcher } = require('undici');

// Node's global fetch keeps ONE connection per origin and serialises every request over it.
// With 12 workers that produced exactly one socket at ~1.2s per request — not a hang, but
// ~5.6 hours for 16,805 companies, and it looked identical to a stall (1 socket, 0.3% CPU,
// no checkpoint movement). A real pool is what makes CONCURRENCY mean anything here.
setGlobalDispatcher(new Agent({ connections: 64, keepAliveTimeout: 30000 }));

const LOCAL_URL = process.env.LOCAL_URL || 'postgres://codev@localhost:5432/jobs_local';
const APPLY = process.env.APPLY === '1';
const LIMIT = parseInt(process.env.LIMIT || '0', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '8', 10);
const DELAY_MS = parseInt(process.env.DELAY_MS || '150', 10);
const CHECKPOINT = process.env.CHECKPOINT || '/tmp/simplify-resolve.checkpoint';

// tracked_obj prefix -> the ats value our own tables use. Only platforms whose slug format
// matches what the adapter expects (verified against live rows) appear here.
// Every slug below was fetched live and returned HTTP 200 on its canonical board URL before
// being added here — see the "verified" note in the header.
const PREFIX_TO_ATS = {
  ashbyhq: 'ashby',
  greenhouse: 'greenhouse',
  lever: 'lever',
  smartrecruiters: 'smartrecruiters',
  jazzhr: 'jazzhr',
  rippling: 'rippling',
  bamboohr: 'bamboohr',
  breezy: 'breezy',
  jobvite: 'jobvite',
  // Added after the first full pass. These three are platforms the fleet already crawls, and
  // they were absent from this map purely because none of them appeared in the 300-company
  // sample used to build it — so 41 perfectly resolvable boards were reported as "unsupported"
  // and skipped. The lesson is that the sample sized the WORK, it did not enumerate the
  // PLATFORMS; the allowlist should come from what we can crawl, not from what a sample showed.
  pinpointhq: 'pinpoint',
  recruitee: 'recruitee',
  teamtailor: 'teamtailor',
};

// Canonical board URL per platform. career_url carries a UNIQUE constraint, so building it
// deterministically also makes it a second dedupe key: if a row already holds this URL, the
// insert is a no-op rather than a duplicate company.
const CAREER_URL = {
  ashby: (s) => `https://jobs.ashbyhq.com/${s}`,
  greenhouse: (s) => `https://boards.greenhouse.io/${s}`,
  lever: (s) => `https://jobs.lever.co/${s}`,
  workable: (s) => `https://apply.workable.com/${s}`,
  smartrecruiters: (s) => `https://careers.smartrecruiters.com/${s}`,
  jazzhr: (s) => `https://${s}.applytojob.com`,
  rippling: (s) => `https://ats.rippling.com/${s}/jobs`,
  bamboohr: (s) => `https://${s}.bamboohr.com/careers`,
  breezy: (s) => `https://${s}.breezy.hr`,
  jobvite: (s) => `https://jobs.jobvite.com/${s}`,
  workday: (s) => `https://${s}.myworkdayjobs.com`,
  pinpoint: (s) => `https://${s}.pinpointhq.com`,
  recruitee: (s) => `https://${s}.recruitee.com`,
  teamtailor: (s) => `https://${s}.teamtailor.com`,
};

const HEADERS = {
  accept: 'application/json',
  origin: 'https://simplify.jobs',
  referer: 'https://simplify.jobs/',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `p` under a hard deadline, aborting the underlying socket if it expires.
 *
 * AbortSignal.timeout() on fetch() covers the request only up to response headers; a stalled
 * BODY read afterwards has no timeout at all. This is defensive rather than a fix for anything
 * observed — worth keeping, because a wedged body read would be invisible.
 *
 * NOT the cause of the 81-minute stall on the first armed run, though it looked exactly like it
 * (alive at 0.1% CPU, 2 sockets for 16 workers, no checkpoint movement). That was the missing
 * connection pool: Node's fetch serialises every request over one socket per origin, so the
 * workers were queued behind each other, not hung. See setGlobalDispatcher above. Recording the
 * wrong diagnosis here would send the next person hunting a timeout bug that does not exist.
 */
async function withDeadline(p, ms, controller, label) {
  let timer;
  try {
    return await Promise.race([
      p,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          try { controller.abort(); } catch { /* already gone */ }
          reject(new Error(`deadline:${label}`));
        }, ms);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

async function fetchPosting(id, attempt = 0) {
  const ctrl = new AbortController();
  try {
    const res = await withDeadline(
      fetch(`https://api.simplify.jobs/v2/job-posting/:id/${id}/company`,
        { headers: HEADERS, signal: ctrl.signal }),
      25000, ctrl, 'headers');
    if (res.status === 429) {
      if (attempt >= 4) return { rateLimited: true };
      await sleep(5000 * (attempt + 1));
      return fetchPosting(id, attempt + 1);
    }
    if (!res.ok) {
      // Drain rather than leak the socket into the pool half-read.
      try { await withDeadline(res.text(), 5000, ctrl, 'drain'); } catch { /* ignore */ }
      return { httpError: res.status };
    }
    return { body: await withDeadline(res.json(), 20000, ctrl, 'body') };
  } catch (e) {
    if (attempt < 2) { await sleep(1500 * (attempt + 1)); return fetchPosting(id, attempt + 1); }
    return { netError: e.message };
  }
}

function parseTracked(tracked) {
  if (!tracked || !tracked.includes(':')) return null;
  const prefix = tracked.slice(0, tracked.indexOf(':')).toLowerCase();
  const rest = tracked.slice(tracked.indexOf(':') + 1);
  const slug = (rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : rest).trim();
  if (!slug) return null;
  return { prefix, slug };
}

(async () => {
  const db = new Client({ connectionString: LOCAL_URL });
  await db.connect();

  console.log(`mode: ${APPLY ? 'APPLY (creating companies)' : 'SHADOW (no writes)'}`);
  console.log(`concurrency ${CONCURRENCY} | delay ${DELAY_MS}ms | limit ${LIMIT || 'all'}\n`);

  // Existing (ats, lower(slug)) pairs, so a company we already crawl is never duplicated.
  const { rows: existing } = await db.query(
    `SELECT ats, lower(ats_slug) AS slug FROM companies WHERE ats_slug IS NOT NULL`);
  const known = new Set(existing.map((e) => `${e.ats}|${e.slug}`));
  console.log(`already known (ats, slug) pairs: ${known.size.toLocaleString()}`);

  let doneIds = new Set();
  try { doneIds = new Set(JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8'))); } catch { /* first run */ }
  if (doneIds.size) console.log(`resuming: ${doneIds.size.toLocaleString()} companies already probed`);

  const { rows: targets } = await db.query(`
    SELECT DISTINCT ON (j.company_id)
           j.company_id, c.company_name, (j.raw_data::jsonb)->>'posting_id' AS pid
      FROM jobs j JOIN companies c ON c.id = j.company_id
     WHERE j.ats = 'simplify' AND c.ats = 'simplify' AND (j.raw_data::jsonb) ? 'posting_id'
     ORDER BY j.company_id, j.id
     ${LIMIT ? `LIMIT ${LIMIT}` : ''}`);
  const work = targets.filter((t) => !doneIds.has(t.company_id));
  console.log(`companies to probe: ${work.length.toLocaleString()}\n`);

  const stats = { fetched: 0, httpError: 0, netError: 0, rateLimited: 0,
    noTracked: 0, unsupported: 0, alreadyKnown: 0, newBoards: 0, created: 0 };
  const unsupportedBy = {};
  const newByAts = {};
  const pending = [];   // rows to insert
  const seenNew = new Set();
  const samples = [];

  let processed = 0;

  // Insert whatever has accumulated and clear the buffer. Safe to call at any point.
  async function flushPending() {
    if (!pending.length) return;
    const batch = pending.splice(0, pending.length);
    for (let i = 0; i < batch.length; i += 500) {
      const chunk = batch.slice(i, i + 500);
      const vals = [];
      const params = [];
      chunk.forEach((c, k) => {
        const b = k * 6;
        const url = CAREER_URL[c.ats](c.slug);
        // domain is NOT NULL on this table and carries the board's hostname (jobs.ashbyhq.com,
        // {slug}.applytojob.com, ...). Deriving it from the canonical career_url keeps the two
        // consistent by construction. Omitting it is what silently failed every insert on the
        // first armed run — the batch only ran at the very end, so the constraint error never
        // surfaced until a short slice was run in the foreground.
        params.push(c.name, c.ats, c.slug, url, new URL(url).host, 'simplify_resolve');
        vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},'active',$${b + 6},NOW(),NOW())`);
      });
      const res = await db.query(
        `INSERT INTO companies (company_name, ats, ats_slug, career_url, domain, status, origin, created_at, updated_at)
         VALUES ${vals.join(',')} ON CONFLICT (career_url) DO NOTHING`, params);
      stats.created += res.rowCount;
    }
  }

  let idx = 0;
  async function worker() {
    for (;;) {
      const i = idx++;
      if (i >= work.length) return;
      const t = work[i];
      const out = await fetchPosting(t.pid);

      // Only checkpoint a company once it has actually been ANSWERED. Marking it done before
      // testing the outcome means a 429 or a network error is recorded as complete, and every
      // later resume skips it forever — a silent, permanent loss.
      //
      // This is not hypothetical. The first armed run marked 6,254 companies done, then died
      // before its end-of-run insert, so all 6,254 were skipped by every subsequent run while
      // having created nothing. That cost 434 real boards, only found because a later pass
      // happened to start from a cleared checkpoint. A 429 here would have cost the same way.
      if (out.rateLimited || out.httpError || out.netError) {
        if (out.rateLimited) stats.rateLimited++;
        else if (out.httpError) stats.httpError++;
        else stats.netError++;
        processed++;
        continue;   // deliberately NOT added to doneIds — a resume retries it
      }
      doneIds.add(t.company_id);

      // Counted here, BEFORE the continues below. Placing it after them meant it only counted
      // new boards (~5% of rows), so the checkpoint needed ~4,000 companies to advance once and
      // real progress was invisible.
      processed++;
      if (processed % 200 === 0) {
        process.stdout.write(`\r  processed ${processed.toLocaleString()}/${work.length.toLocaleString()} | new ${stats.newBoards.toLocaleString()} | known ${stats.alreadyKnown.toLocaleString()} | unsupported ${stats.unsupported.toLocaleString()} | err ${(stats.httpError + stats.netError + stats.rateLimited).toLocaleString()}   `);
        fs.writeFileSync(CHECKPOINT, JSON.stringify([...doneIds]));
      }

      stats.fetched++;

      const parsed = parseTracked(out.body.tracked_obj);
      if (!parsed) { stats.noTracked++; continue; }

      const ats = PREFIX_TO_ATS[parsed.prefix];
      if (!ats) {
        stats.unsupported++;
        unsupportedBy[parsed.prefix] = (unsupportedBy[parsed.prefix] || 0) + 1;
        continue;
      }

      const key = `${ats}|${parsed.slug.toLowerCase()}`;
      if (known.has(key)) { stats.alreadyKnown++; continue; }
      if (seenNew.has(key)) { stats.alreadyKnown++; continue; }
      seenNew.add(key);
      stats.newBoards++;
      newByAts[ats] = (newByAts[ats] || 0) + 1;
      pending.push({ ats, slug: parsed.slug, name: t.company_name });
      if (samples.length < 8) samples.push(`${ats.padEnd(16)} ${parsed.slug.padEnd(28)} ${t.company_name}`);

      // Flush inserts as we go. Holding every row to the end meant an interrupted run wrote
      // nothing at all, however far it had got.
      if (APPLY && pending.length >= 500) await flushPending();
      if (DELAY_MS) await sleep(DELAY_MS);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  fs.writeFileSync(CHECKPOINT, JSON.stringify([...doneIds]));

  // Final flush for whatever did not reach a 500-row batch. status='active' is what makes
  // claimBatch pick these up; origin records where they came from so the population stays
  // identifiable later.
  if (APPLY) await flushPending();

  console.log('\n');
  if (samples.length) {
    console.log('sample of new boards:');
    for (const s of samples) console.log('  ' + s);
    console.log('');
  }
  console.log('result:');
  console.log(`  fetched ok            : ${stats.fetched.toLocaleString()}`);
  console.log(`  http errors           : ${stats.httpError}`);
  console.log(`  net errors            : ${stats.netError}`);
  console.log(`  RATE LIMITED          : ${stats.rateLimited}`);
  console.log(`  no tracked_obj        : ${stats.noTracked}`);
  console.log(`  unsupported platform  : ${stats.unsupported}  ${JSON.stringify(unsupportedBy)}`);
  console.log(`  already crawling      : ${stats.alreadyKnown.toLocaleString()}`);
  console.log(`  ${APPLY ? 'CREATED' : 'would create'} new boards : ${(APPLY ? stats.created : stats.newBoards).toLocaleString()}`);
  console.log(`\n  new boards by ats: ${JSON.stringify(newByAts)}`);
  if (!APPLY) console.log('\nSHADOW — nothing written. Re-run with APPLY=1 to create them.');

  await db.end();
})().catch((e) => { console.error('\nFATAL', e.message); process.exit(1); });
