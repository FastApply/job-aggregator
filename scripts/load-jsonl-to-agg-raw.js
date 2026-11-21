#!/usr/bin/env node
/**
 * Load a JSONL dump (one record per line) into agg_raw, the raw capture table that
 * map-aggregators-local.js maps from. Built for the Simplify dump (scripts/fetch-simplify.js),
 * whose records are not pulled by pull-aggregators-local.js, but works for any source.
 *
 * Upserts on (source, ext_id) exactly like the pull script: an existing record gets the new payload
 * and last_fetched_at = now(), a new one also gets first_fetched_at = now(). So after a load,
 *   APPLY=1 SOURCES=simplify SINCE=<load start> node scripts/map-aggregators-local.js
 * maps just what this load touched, and first_fetched_at > <load start> counts what is new.
 *
 *   node scripts/load-jsonl-to-agg-raw.js simplify dump.jsonl            # ext_id = record.id
 *   ID_FIELD=posting_id node scripts/load-jsonl-to-agg-raw.js simplify dump.jsonl
 *
 * LOCAL staging only. Env: DATABASE_URL, ID_FIELD (default id), BATCH (default 2000).
 */
const fs = require('fs');
const readline = require('readline');
const { Pool } = require('pg');

const [SOURCE, FILE] = process.argv.slice(2);
if (!SOURCE || !FILE) { console.error('Usage: node scripts/load-jsonl-to-agg-raw.js <source> <file.jsonl>'); process.exit(1); }
const DB = process.env.DATABASE_URL || 'postgres://codev@localhost:5432/jobs_local';
{
  const h = (() => { try { return new URL(DB).hostname; } catch { return ''; } })();
  if (!['localhost', '127.0.0.1', '::1'].includes(h)) { console.error('Refusing: local staging only.'); process.exit(1); }
}
const ID_FIELD = process.env.ID_FIELD || 'id';
const BATCH = parseInt(process.env.BATCH || '2000', 10);
const pool = new Pool({ connectionString: DB, max: 2 });

(async () => {
  const t0 = new Date();
  let read = 0; let inserted = 0; let updated = 0; let skipped = 0; let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    const { rows } = await pool.query(
      `INSERT INTO agg_raw (source, ext_id, payload)
         SELECT $1, x.id, x.payload FROM jsonb_to_recordset($2::jsonb) AS x(id text, payload jsonb)
       ON CONFLICT (source, ext_id) DO UPDATE SET payload = EXCLUDED.payload, last_fetched_at = now()
       RETURNING (xmax = 0) AS inserted`, [SOURCE, JSON.stringify(batch)]);
    const n = rows.filter((r) => r.inserted).length;
    inserted += n; updated += rows.length - n; batch = [];
  };
  for await (const line of readline.createInterface({ input: fs.createReadStream(FILE), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    read++;
    let doc; try { doc = JSON.parse(line); } catch { skipped++; continue; }
    const id = doc[ID_FIELD];
    if (id === undefined || id === null || id === '') { skipped++; continue; }
    batch.push({ id: String(id), payload: doc });
    if (batch.length >= BATCH) {
      await flush();
      if (read % 100000 < BATCH) process.stdout.write(`\r  ${read.toLocaleString()} read | ${inserted.toLocaleString()} new | ${updated.toLocaleString()} refreshed`);
    }
  }
  await flush();
  console.log(`\n${SOURCE}: ${read.toLocaleString()} read | ${inserted.toLocaleString()} NEW | ${updated.toLocaleString()} refreshed | ${skipped} skipped`);
  console.log(`load started ${t0.toISOString()} — map just this load with SINCE='${t0.toISOString().replace('T', ' ').slice(0, 19)}+00'`);
  await pool.end();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
