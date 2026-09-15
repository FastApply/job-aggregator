#!/usr/bin/env node
/**
 * Repair the imported `simplify` corpus in the LOCAL staging database.
 *
 * SHADOW BY DEFAULT. Nothing is written unless APPLY=1.
 *
 *   node scripts/enrich-simplify-jobs.js                 # shadow, whole corpus
 *   LIMIT=500 node scripts/enrich-simplify-jobs.js       # bounded sample
 *   APPLY=1 node scripts/enrich-simplify-jobs.js         # armed
 *   MODE=url APPLY=1 node scripts/enrich-simplify-jobs.js  # URL+ats only, no liveness
 *
 * Env:
 *   LOCAL_URL    staging DB (default postgres://codev@localhost:5432/jobs_local)
 *   APPLY=1      write (default shadow)
 *   MODE         'full' (default) = URL + ats + liveness; 'url' = skip the liveness call
 *   LIMIT        stop after N jobs (0 = all)
 *   CONCURRENCY  parallel workers (default 12)
 *   DELAY_MS     per-worker pause (default 60)
 *   BATCH        rows per DB flush (default 500)
 *   CHECKPOINT   resume file (default /tmp/simplify-enrich.checkpoint)
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────────────────
 * All 1,722,859 imported rows carry `url = https://simplify.jobs/p/<uuid>` — the aggregator's
 * own landing page, not the employer's posting. On a job board every apply click therefore
 * sends the user to a competitor. That alone makes the corpus unfit to promote.
 *
 * It is also not liveness-checked. Sampled 40 live rows against the API: 6 came back
 * `active: false`. Roughly one in seven is a closed posting we present as open.
 *
 * Both are fixable per job:
 *
 *   GET https://simplify.jobs/jobs/click/{posting_id}   -> 307 to the REAL posting
 *   GET https://api.simplify.jobs/v2/job-posting/:id/{posting_id}/company  -> {active}
 *
 * The redirect is the authority for the URL, NOT tracked_obj. For the Draper posting
 * tracked_obj reads `workday:Draper_Careers/...` — the career SITE slug — while the redirect
 * gives `draper.wd5.myworkdayjobs.com/Draper_Careers/job/...`, carrying the tenant that
 * tracked_obj omits. Reading tracked_obj as the source of truth is what made workday look
 * unresolvable earlier; it is not, the tenant was simply in a different field.
 *
 * ── COST ────────────────────────────────────────────────────────────────────────────────
 * MODE=url  is ONE cheap redirect per job (no body).
 * MODE=full adds the API call, which returns ~30KB — about 52GB across the whole corpus.
 * Run MODE=url first if the priority is getting apply links off simplify.jobs; liveness can
 * follow. `:id` is a literal path segment in the API route, not a placeholder.
 */
const fs = require('fs');
const { Client } = require('pg');
const { Agent, setGlobalDispatcher } = require('undici');

// Node's global fetch keeps one connection per origin and serialises everything over it, which
// silently caps throughput at ~1 request/sec no matter what CONCURRENCY says.
setGlobalDispatcher(new Agent({ connections: 64, keepAliveTimeout: 30000 }));

const LOCAL_URL = process.env.LOCAL_URL || 'postgres://codev@localhost:5432/jobs_local';
const APPLY = process.env.APPLY === '1';
const MODE = (process.env.MODE || 'full').toLowerCase();
const LIMIT = parseInt(process.env.LIMIT || '0', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '12', 10);
const DELAY_MS = parseInt(process.env.DELAY_MS || '60', 10);
const BATCH = parseInt(process.env.BATCH || '500', 10);
const CHECKPOINT = process.env.CHECKPOINT || '/tmp/simplify-enrich.checkpoint';

const HEADERS = {
  accept: 'application/json',
  origin: 'https://simplify.jobs',
  referer: 'https://simplify.jobs/',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const n = (v) => Number(v).toLocaleString();

/**
 * Host -> the `ats` value our own tables use. Derived from the redirect target, which is the
 * employer's real board, so this is observed rather than inferred.
 */
function atsFromHost(host) {
  const h = (host || '').toLowerCase();
  if (h.endsWith('.myworkdayjobs.com')) return 'workday';
  if (h.endsWith('smartrecruiters.com')) return 'smartrecruiters';
  if (h.endsWith('workable.com')) return 'workable';
  if (h.endsWith('greenhouse.io')) return 'greenhouse';
  if (h.endsWith('.applytojob.com')) return 'jazzhr';
  if (h === 'recruiting.paylocity.com') return 'paylocity';
  if (h.endsWith('.eightfold.ai')) return 'eightfold';
  if (h.endsWith('ashbyhq.com')) return 'ashby';
  if (h.endsWith('lever.co')) return 'lever';
  if (h.endsWith('.bamboohr.com')) return 'bamboohr';
  if (h.endsWith('.breezy.hr')) return 'breezy';
  if (h === 'ats.rippling.com') return 'rippling';
  if (h.endsWith('.teamtailor.com')) return 'teamtailor';
  if (h.endsWith('.recruitee.com')) return 'recruitee';
  if (h.endsWith('.pinpointhq.com')) return 'pinpoint';
  if (h.endsWith('jobvite.com')) return 'jobvite';
  if (h.endsWith('.icims.com')) return 'icims';
  if (h.endsWith('oraclecloud.com')) return 'oracle';
  if (h.endsWith('.successfactors.com') || h.endsWith('.sapsf.com')) return 'successfactors';
  if (h.endsWith('.taleo.net')) return 'taleo';
  if (h.endsWith('.comeet.co')) return 'comeet';
  if (h.endsWith('.personio.de') || h.endsWith('.personio.com')) return 'personio';
  if (h.endsWith('.zohorecruit.com')) return 'zoho';
  if (h.endsWith('.jobs.net') || h.endsWith('.brassring.com')) return 'brassring';
  if (h.endsWith('.adp.com')) return 'adp';
  if (h.endsWith('.dayforcehcm.com')) return 'dayforce';
  if (h.endsWith('.ultipro.com')) return 'ultipro';
  if (h.endsWith('.jobvite.com')) return 'jobvite';
  return null; // employer's own careers page, or a platform we have no adapter for
}

/**
 * Remove Simplify's attribution from an employer URL, and NOTHING else.
 *
 * Only these four keys are attribution, and only when they literally read "Simplify" — that is
 * the value every one of them carries in this corpus. Everything else in the query string is
 * FUNCTIONAL and stripping it would break the apply link:
 *
 *   job=04GK0, gh_jid=4584837101   the job identifier itself — the link 404s without it
 *   icims=1, ats=pinpointhq, embed=true, needsRedirect=false, mobile=true,
 *   token=..., job_board_id=..., nl, fr, hub
 *
 * Measured across the corpus before writing this: gh_src(27,697) lever-source(11,252)
 * source(168) all = "Simplify"; job(3,528) and gh_jid(7,890) are ids. A blanket "drop the query
 * string" would have silently broken ~11,000 apply links.
 */
const ATTRIBUTION_KEYS = ['utm_source', 'gh_src', 'lever-source', 'source'];
function stripAttribution(raw) {
  try {
    const u = new URL(raw);
    for (const k of ATTRIBUTION_KEYS) {
      const v = u.searchParams.get(k);
      if (v != null && v.toLowerCase() === 'simplify') u.searchParams.delete(k);
    }
    return u.toString().replace(/\?$/, '');
  } catch { return raw; }
}

async function withDeadline(p, ms, controller, label) {
  let timer;
  try {
    return await Promise.race([p, new Promise((_, rej) => {
      timer = setTimeout(() => { try { controller.abort(); } catch { /* gone */ } rej(new Error(`deadline:${label}`)); }, ms);
    })]);
  } finally { clearTimeout(timer); }
}

/** Follow the click redirect WITHOUT downloading the employer's page. */
async function resolveUrl(pid, attempt = 0) {
  const ctrl = new AbortController();
  try {
    const res = await withDeadline(
      fetch(`https://simplify.jobs/jobs/click/${pid}`, {
        method: 'GET', redirect: 'manual', headers: { 'user-agent': HEADERS['user-agent'] }, signal: ctrl.signal,
      }), 20000, ctrl, 'click');
    if (res.status === 429) {
      if (attempt >= 4) return { rateLimited: true };
      await sleep(4000 * (attempt + 1));
      return resolveUrl(pid, attempt + 1);
    }
    const loc = res.headers.get('location');
    try { await withDeadline(res.text(), 5000, ctrl, 'drain'); } catch { /* ignore */ }
    if (!loc) return { noRedirect: true, status: res.status };
    let clean = stripAttribution(loc);
    return { url: clean, host: (() => { try { return new URL(clean).host; } catch { return null; } })() };
  } catch (e) {
    if (attempt < 2) { await sleep(1200 * (attempt + 1)); return resolveUrl(pid, attempt + 1); }
    return { netError: e.message };
  }
}

/** Liveness only. Skipped entirely in MODE=url. */
async function fetchActive(pid, attempt = 0) {
  const ctrl = new AbortController();
  try {
    const res = await withDeadline(
      fetch(`https://api.simplify.jobs/v2/job-posting/:id/${pid}/company`, { headers: HEADERS, signal: ctrl.signal }),
      25000, ctrl, 'api');
    if (res.status === 429) {
      if (attempt >= 4) return { rateLimited: true };
      await sleep(5000 * (attempt + 1));
      return fetchActive(pid, attempt + 1);
    }
    if (!res.ok) { try { await withDeadline(res.text(), 5000, ctrl, 'drain'); } catch { /* ignore */ } return { httpError: res.status }; }
    const body = await withDeadline(res.json(), 20000, ctrl, 'body');
    return { active: body.active !== false };
  } catch (e) {
    if (attempt < 2) { await sleep(1200 * (attempt + 1)); return fetchActive(pid, attempt + 1); }
    return { netError: e.message };
  }
}

(async () => {
  const db = new Client({ connectionString: LOCAL_URL });
  await db.connect();

  console.log(`mode: ${APPLY ? 'APPLY (writing)' : 'SHADOW (no writes)'} | resolve=${MODE}`);
  console.log(`concurrency ${CONCURRENCY} | delay ${DELAY_MS}ms | limit ${LIMIT || 'all'}\n`);

  let done = new Set();
  try { done = new Set(JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8'))); } catch { /* first run */ }
  if (done.size) console.log(`resuming: ${n(done.size)} already enriched`);

  const { rows: targets } = await db.query(`
    SELECT id, (raw_data::jsonb)->>'posting_id' AS pid
      FROM jobs
     WHERE ats = 'simplify' AND (raw_data::jsonb) ? 'posting_id'
     ORDER BY id ${LIMIT ? `LIMIT ${LIMIT}` : ''}`);
  const work = targets.filter((t) => !done.has(t.id));
  console.log(`jobs to enrich: ${n(work.length)}\n`);

  const stats = { processed: 0, resolved: 0, noRedirect: 0, rateLimited: 0, netError: 0,
    inactive: 0, active: 0, updated: 0, retired: 0, unmappedHost: 0 };
  const hosts = {};
  const atsCounts = {};
  const samples = [];
  let pending = [];

  async function flush() {
    if (!pending.length) return;
    const batch = pending.splice(0, pending.length);
    if (!APPLY) return;
    // One statement per batch via unnest, not per row.
    const ids = batch.map((b) => b.id);
    const urls = batch.map((b) => b.url);
    const atss = batch.map((b) => b.ats);
    const deads = batch.map((b) => b.dead);
    const res = await db.query(
      `UPDATE jobs j SET
         url = u.url,
         ats = COALESCE(u.ats, j.ats),
         removed_at = CASE WHEN u.dead THEN COALESCE(j.removed_at, NOW()) ELSE j.removed_at END,
         -- Confirming active=true against the API IS a sighting, so record it. Without this the
         -- whole corpus keeps last_seen_at at its import date (2026-08-30) forever, and every
         -- freshness guard downstream rejects 100% of it as stale — sync-local-to-prod.js and
         -- promote-missing-to-prod.js both gate on MAX_AGE_H. Measured before this line existed:
         -- 0 of 775,629 enriched rows passed a 24h check, so the corpus was unpromotable by
         -- construction. Only set on a LIVE confirmation; a dead row must never look freshly seen.
         last_seen_at = CASE WHEN u.dead THEN j.last_seen_at ELSE NOW() END
       FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::text[]) AS url,
                    unnest($3::text[]) AS ats, unnest($4::boolean[]) AS dead) u
      WHERE j.id = u.id`,
      [ids, urls, atss, deads]);
    stats.updated += res.rowCount;
    stats.retired += batch.filter((b) => b.dead).length;
  }

  let idx = 0;
  async function worker() {
    for (;;) {
      const i = idx++;
      if (i >= work.length) return;
      const t = work[i];

      const r = await resolveUrl(t.pid);
      if (r.rateLimited) { stats.rateLimited++; continue; }   // not checkpointed — retried on resume
      if (r.netError) { stats.netError++; continue; }
      stats.processed++;
      done.add(t.id);

      if (r.noRedirect) { stats.noRedirect++; continue; }
      stats.resolved++;
      hosts[r.host] = (hosts[r.host] || 0) + 1;
      const ats = atsFromHost(r.host);
      if (ats) atsCounts[ats] = (atsCounts[ats] || 0) + 1; else stats.unmappedHost++;

      let dead = false;
      if (MODE === 'full') {
        const a = await fetchActive(t.pid);
        if (a.rateLimited) stats.rateLimited++;
        else if (a.active === false) { dead = true; stats.inactive++; }
        else if (a.active === true) stats.active++;
      }

      pending.push({ id: Number(t.id), url: r.url, ats, dead });
      if (samples.length < 8) samples.push(`${(ats || '(unmapped)').padEnd(16)} ${r.url.slice(0, 96)}`);

      if (pending.length >= BATCH) await flush();
      if (stats.processed % 200 === 0) {
        process.stdout.write(`\r  ${n(stats.processed)}/${n(work.length)} | resolved ${n(stats.resolved)} | dead ${n(stats.inactive)} | updated ${n(stats.updated)} | err ${n(stats.rateLimited + stats.netError)}   `);
        // Only checkpoint when we actually wrote. A shadow run that records progress makes the
        // subsequent APPLY run skip exactly the rows it just examined and never fix them —
        // the resolver lost 434 boards to that before it was caught.
        if (APPLY) fs.writeFileSync(CHECKPOINT, JSON.stringify([...done]));
      }
      if (DELAY_MS) await sleep(DELAY_MS);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await flush();
  if (APPLY) fs.writeFileSync(CHECKPOINT, JSON.stringify([...done]));

  console.log('\n');
  if (samples.length) { console.log('sample of resolved URLs:'); for (const s of samples) console.log('  ' + s); console.log(''); }
  console.log('result:');
  console.log(`  processed        : ${n(stats.processed)}`);
  console.log(`  redirect resolved: ${n(stats.resolved)}`);
  console.log(`  no redirect      : ${n(stats.noRedirect)}`);
  console.log(`  host unmapped    : ${n(stats.unmappedHost)}`);
  if (MODE === 'full') {
    console.log(`  active           : ${n(stats.active)}`);
    console.log(`  INACTIVE (dead)  : ${n(stats.inactive)}`);
  }
  console.log(`  rate limited     : ${n(stats.rateLimited)}`);
  console.log(`  net errors       : ${n(stats.netError)}`);
  console.log(`  rows ${APPLY ? 'UPDATED' : 'would update'}: ${n(APPLY ? stats.updated : stats.resolved)}`);
  if (APPLY && MODE === 'full') console.log(`  rows retired     : ${n(stats.retired)}`);

  console.log('\nreal hosts behind the redirects:');
  for (const [h, c] of Object.entries(hosts).sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`  ${String(c).padStart(7)}  ${h}${atsFromHost(h) ? '' : '   <- no adapter'}`);
  }
  console.log('\nats derived:', JSON.stringify(atsCounts));
  if (!APPLY) console.log('\nSHADOW — nothing written. Re-run with APPLY=1.');

  await db.end();
})().catch((e) => { console.error('\nFATAL', e.message); process.exit(1); });
