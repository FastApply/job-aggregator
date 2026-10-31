#!/usr/bin/env node
/**
 * Clear stored salaries that are other money in the posting (extract.js, isOtherMoney).
 *
 *   DATABASE_URL=... NODE_ENV=production node scripts/backfill-other-money-salary.js          # SHADOW
 *   DATABASE_URL=... NODE_ENV=production APPLY=1 node scripts/backfill-other-money-salary.js  # armed
 *
 * The reader took the first money in a posting, so Sentara's fertility benefit is the $10,000
 * "salary" on 3-29% of its rows, and a candidate with any salary floor is refused them. The new
 * reader cannot fix a stored row: the crawl only reads salary when the row has none.
 *
 * A row changes only when every place its text states the stored low figure is other money. The
 * reader's new answer is stored in its place, or nothing. A figure the text never states came from
 * the ATS and stays. The index trigger queues each changed row, so this waits while the outbox
 * holds MAX_OUTBOX rows. Walks the primary key, resumable from CKPT.
 * Env: BATCH (5000 ids per step) · MAX_OUTBOX (20000) · POLL_MS (20000) · CKPT
 */
const fs = require('fs');
const { stripHtml } = require('../src/utils/html');
const { extractSalary, isOtherMoney } = require('../src/utils/extract');
const { annualiseSalary } = require('../src/utils/salary');

/** Pure. The row's new salary (null fields when none is left), or null when it stays as stored. */
function reread(row) {
  const figure = Number(row.salary_min);
  if (!Number.isFinite(figure) || figure <= 0) return null;
  const plain = stripHtml(row.description);
  const spelled = figure.toLocaleString('en-US').replace(/[.,]/g, '[.,]');
  const stated = [...plain.matchAll(new RegExp(`(?:[$£€]|[AC]\\$)\\s*${spelled}(?![\\d,])`, 'g'))];
  if (stated.length === 0 || !stated.every((m) => isOtherMoney(plain, m))) return null;
  const fresh = extractSalary(plain);
  return {
    min: fresh?.min ?? null,
    max: fresh?.max ?? null,
    currency: fresh?.currency ?? null,
    interval: fresh?.interval ?? null,
    minAnnual: fresh ? annualiseSalary(fresh.min, fresh.interval) : null,
    maxAnnual: fresh ? annualiseSalary(fresh.max, fresh.interval) : null,
  };
}

async function main() {
  const db = require('../src/db/connection');
  const run = db.queryWithTimeout
    ? (sql, params) => db.queryWithTimeout(sql, params, 120000)
    : (sql, params) => db.query(sql, params);
  const APPLY = process.env.APPLY === '1';
  const BATCH = parseInt(process.env.BATCH || '5000', 10);
  const MAX_OUTBOX = parseInt(process.env.MAX_OUTBOX || '20000', 10);
  const POLL_MS = parseInt(process.env.POLL_MS || '20000', 10);
  const CKPT = process.env.CKPT || '/tmp/other-money-salary.pos';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  console.log(`mode: ${APPLY ? 'APPLY' : 'SHADOW'}`);
  const { rows: [b] } = await run('SELECT MIN(id) AS lo, MAX(id) AS hi FROM jobs');
  let from = Number(b.lo) - 1;
  const hi = Number(b.hi);
  if (APPLY && fs.existsSync(CKPT)) {
    const saved = parseInt(fs.readFileSync(CKPT, 'utf8').trim(), 10);
    if (Number.isFinite(saved) && saved > from) from = saved;
  }
  let scanned = 0, changed = 0;
  const samples = [];
  while (from < hi) {
    const to = Math.min(from + BATCH, hi);
    const { rows } = await run(
      `SELECT id, title, salary_min, description FROM jobs
        WHERE id > ${from} AND id <= ${to} AND removed_at IS NULL
          AND salary_min IS NOT NULL AND description IS NOT NULL AND description <> 'N/A'`);
    scanned += rows.length;
    const fixes = [];
    for (const row of rows) {
      const fix = reread(row);
      if (!fix) continue;
      fixes.push({ id: row.id, ...fix });
      if (samples.length < 25) samples.push(`${row.salary_min} -> ${fix.min} | ${row.title}`);
    }
    if (APPLY && fixes.length) {
      for (;;) {
        const { rows: [o] } = await run('SELECT COUNT(*)::int n FROM jobs WHERE index_dirty_at IS NOT NULL');
        if (o.n < MAX_OUTBOX) break;
        await sleep(POLL_MS);
      }
      for (const f of fixes) {
        await run(
          `UPDATE jobs SET salary_min = $2, salary_max = $3, salary_currency = $4, salary_interval = $5,
                           salary_min_annual = $6, salary_max_annual = $7
            WHERE id = $1`,
          [f.id, f.min, f.max, f.currency, f.interval, f.minAnnual, f.maxAnnual]
        );
      }
      fs.writeFileSync(CKPT, String(to));
    }
    changed += fixes.length;
    from = to;
    process.stdout.write(`\r${from}/${hi} scanned ${scanned} changed ${changed}`);
  }
  console.log(`\nscanned ${scanned} · ${APPLY ? 'changed' : 'would change'} ${changed}`);
  console.log(samples.join('\n'));
  process.exit(0);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { reread };
