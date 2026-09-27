#!/usr/bin/env node
/**
 * Local companion crawler — runs the SAME per-company sync the Heroku worker runs,
 * against the SAME Heroku Postgres, to add crawl throughput and fill jobs faster.
 *
 * Coordination with the Heroku worker (so we don't both crawl the same company):
 *   each loop atomically CLAIMS a batch of due companies with
 *   `... FOR UPDATE SKIP LOCKED` and bumps last_synced_at=NOW() in the same
 *   statement. Once claimed, that company is no longer "due", so the Heroku
 *   worker's findDueForSync skips it (and SKIP LOCKED stops two local batches
 *   colliding). Same ATS allowlist as the worker's findDueForSync.
 *
 * Reuses getAdapter + jobsRepo.syncForCompany so rows are byte-identical to a
 * normal worker sync (classification, dedup, 30-day freshness).
 *
 * Run:
 *   DATABASE_URL=$(heroku config:get DATABASE_URL -a fastapply-board) NODE_ENV=production \
 *     node scripts/crawl-companies-local.js
 * Env: CONCURRENCY (default 8), BATCH (default 40), STALE_MIN (default 60),
 *      ATS (comma list to override allowlist), ONCE=1 (drain due queue then exit).
 */
const { getAdapter } = require('../src/adapters');
const { discoveryMissOutcome } = require('../src/adapters/workday');
const { companiesRepo, jobsRepo } = require('../src/db');
const { query } = require('../src/db/connection');
const { extractSalary, extractWorkplaceType, extractEmploymentType } = require('../src/utils/extract');
const { stripHtml } = require('../src/utils/html');
const { classifyJob } = require('../src/utils/classify');
const proxy = require('../src/utils/proxy'); // rotating residential proxy (only active when IPROYAL_* env set — i.e. instance E)

// Mirror the Heroku worker's findDueForSync allowlist (the actively-synced ATS).
const DEFAULT_ATS = ['greenhouse', 'ashby', 'breezy', 'smartrecruiters', 'bamboohr', 'lever', 'workday', 'icims', 'oracle'];
const ATS = (process.env.ATS ? process.env.ATS.split(',') : DEFAULT_ATS).map(s => s.trim()).filter(Boolean);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '8');
const BATCH = parseInt(process.env.BATCH || '40');
const STALE_MIN = parseInt(process.env.STALE_MIN || '60');
const FETCH_TIMEOUT = parseInt(process.env.FETCH_TIMEOUT || '60000');
const DELAY_MS = parseInt(process.env.DELAY_MS || '0'); // per-company delay to stay under ATS rate limits
const ONCE = process.env.ONCE === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A dead board / malformed slug (404, 400, gone) will never succeed — mark it
// 'failed' so it drops out of the queue instead of re-looping forever. Rate limits
// / timeouts / connection blips are transient — retry those soon.
//
// "could not discover config" is deliberately NOT here any more: one missed Workday discovery was
// retiring the tenant for good, and most of them were throttling, not dead boards (1,516 in 24h on
// 2026-09-27; 4 of 5 sampled were live). Discovery misses are counted instead — see below.
const isPermanentError = (msg) => /HTTP 40[04]\b|not found|no longer|invalid/i.test(msg || '');
const isDiscoveryMiss = (msg) => /could not discover config/i.test(msg || '');
// How long a Workday tenant waits after a discovery miss before it is tried again.
const DISCOVERY_RETRY_MIN = parseInt(process.env.DISCOVERY_RETRY_MIN || '360', 10);

const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('fetch timeout ' + label)), ms))]);

// Atomically claim up to BATCH due companies (and mark them synced so neither the
// Heroku worker nor another local batch re-grabs them).
async function claimBatch() {
  const inList = ATS.map(a => `'${a}'`).join(',');
  const { rows } = await query(
    `UPDATE companies SET last_synced_at = NOW()
       WHERE id IN (
         SELECT id FROM companies
          WHERE status = 'active' AND ats IS NOT NULL AND ats IN (${inList}) AND ats_slug IS NOT NULL
            AND (last_synced_at IS NULL OR last_synced_at < NOW() - INTERVAL '${STALE_MIN} minutes')
          ORDER BY last_synced_at ASC NULLS FIRST
          LIMIT ${BATCH}
          FOR UPDATE SKIP LOCKED
       )
       RETURNING id, ats, ats_slug, career_url, error_message`
  );
  return rows;
}

async function crawlCompany(co) {
  const adapter = getAdapter(co.ats);
  // careerUrl lets the workday adapter use the pod/site already on the row; others ignore it.
  const result = await withTimeout(adapter.fetchJobs(co.ats_slug, { careerUrl: co.career_url }), FETCH_TIMEOUT, co.ats);
  // A tenant that answers again has its discovery-miss count cleared.
  if (co.error_message && isDiscoveryMiss(co.error_message)) {
    await query('UPDATE companies SET error_message = NULL WHERE id = ?', [co.id]).catch(() => {});
  }
  const incoming = (result && (result.jobs || result)) || [];
  if (!incoming.length) return { jobs: 0, added: 0 };
  for (const job of incoming) {
    const plainDesc = job.description ? stripHtml(job.description) : null;
    if (!job.salary_min && plainDesc) {
      const s = extractSalary(plainDesc);
      if (s) { job.salary_min = s.min; job.salary_max = s.max; job.salary_currency = s.currency; job.salary_interval = s.interval; }
    }
    if (!job.workplace_type) job.workplace_type = extractWorkplaceType(job.title, job.location, plainDesc);
    if (!job.employment_type) job.employment_type = extractEmploymentType(job.title, plainDesc);
    const tags = classifyJob(job);
    job.is_remote = tags.is_remote; job.remote_worldwide = tags.remote_worldwide; job.experience_level = tags.experience_level;
  }
  const diff = await jobsRepo.syncForCompany(co.id, co.ats, incoming);
  // syncForCompany doesn't bump last_synced_at; we already did at claim time.
  return { jobs: incoming.length, added: diff.added };
}

(async () => {
  // Route outbound fetch through rotating residential IPs (only when IPROYAL_* env
  // is set — instance E). Fresh IP per request defeats workable's per-IP block.
  const proxied = proxy.install();
  console.log(`Local companion crawler | ATS: ${ATS.join(',')} | concurrency ${CONCURRENCY} | batch ${BATCH} | ${ONCE ? 'drain-once' : 'continuous'}${proxied ? ' | PROXIED (rotating residential)' : ''}`);
  let totalCo = 0, totalAdded = 0, totalRemoved = 0, errors = 0, retired = 0, emptyRounds = 0;
  const t0 = Date.now();

  while (true) {
    let batch;
    try { batch = await claimBatch(); }
    catch (e) { console.error('claim failed:', e.message); await new Promise(r => setTimeout(r, 10000)); continue; }

    if (!batch.length) {
      if (ONCE) break;
      emptyRounds++;
      if (emptyRounds % 5 === 1) console.log(`  queue drained — ${totalCo} companies crawled, +${totalAdded} jobs. idling 60s...`);
      await new Promise(r => setTimeout(r, 60000));
      continue;
    }
    emptyRounds = 0;

    let i = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.length) }, async () => {
      while (i < batch.length) {
        const co = batch[i++];
        try { const r = await crawlCompany(co); totalCo++; totalAdded += r.added; }
        catch (e) {
          errors++; totalCo++;
          try {
            // When proxied, a 404/400 is unreliable (IP/geo-dependent), NOT proof the
            // company is dead — so never retire; just re-due and retry with a new IP.
            if (isDiscoveryMiss(e.message)) {
              // Counted, not fatal: retire only after DISCOVERY_MISS_LIMIT misses in a row, and
              // space the retries so a throttled window cannot burn through them.
              const { retire, message } = discoveryMissOutcome(co.error_message, e.message);
              if (retire && !proxy.enabled) {
                await query("UPDATE companies SET status = 'failed', error_message = ?, updated_at = NOW() WHERE id = ?", [message, co.id]);
                retired++;
              } else {
                await query(`UPDATE companies SET error_message = ?, last_synced_at = NOW() + INTERVAL '${Math.max(0, DISCOVERY_RETRY_MIN - STALE_MIN)} minutes' WHERE id = ?`, [message, co.id]);
              }
            } else if (isPermanentError(e.message) && !proxy.enabled) {
              // dead board / bad slug — retire it so it stops clogging the queue
              await query("UPDATE companies SET status = 'failed', error_message = ?, updated_at = NOW() WHERE id = ?", [String(e.message).slice(0, 200), co.id]);
              retired++;
            } else {
              // transient (rate limit / timeout / drop) — re-due in ~10 min
              await query(`UPDATE companies SET last_synced_at = NOW() - INTERVAL '${Math.max(0, STALE_MIN - 10)} minutes' WHERE id = ?`, [co.id]);
            }
          } catch { /* ignore */ }
        }
        if (DELAY_MS) await sleep(DELAY_MS);
      }
    }));

    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    console.log(`  +batch ${batch.length} | total companies ${totalCo} | jobs added ${totalAdded} | errors ${errors} | retired ${retired} | ${mins}m | ${(totalCo / Math.max(1, (Date.now() - t0) / 60000)).toFixed(0)}/min`);
  }
  console.log(`DONE: ${totalCo} companies | ${totalAdded} jobs added | ${errors} errors`);
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
