#!/usr/bin/env node
/**
 * Simplify.jobs bulk dump — the whole Typesense `jobs` collection (~1.72M docs) to JSONL.
 *
 *   SIMPLIFY_KEY=<x-typesense-api-key> node scripts/fetch-simplify.js out.jsonl
 *
 * The key is the scoped search-only key Simplify ships to its own web client; lift it from the
 * x-typesense-api-key header of any request simplify.jobs makes. It is read-only and carries an
 * embedded exclude_fields that no query can override (verified: asking include_fields=url,title,id
 * returns only id and title). So `url`, `skills`, `industries` and friends are unobtainable.
 *
 * TWO CONSTRAINTS SHAPE THIS SCRIPT:
 *
 *   per_page caps at 250 (251 is a hard error), and offset caps at exactly 1,000,000 rows —
 *   page 4000 works, page 4001 returns an EMPTY result set with NO error. That silent
 *   truncation is the trap: a plain offset walk looks like it succeeded while quietly
 *   capturing 58% of the corpus.
 *
 * So the collection is cut into disjoint half-open windows on shuffle_key, a STABLE random int
 * in 0..999,999. Each window holds ~86k docs, far inside the offset ceiling, and windows are
 * independent — every (window, page) pair is an independent request, so the whole walk
 * parallelises with no cursor state.
 *
 * Windows are half-open RANGES rather than a `shuffle_key:>last` cursor on purpose:
 * shuffle_key is not unique (250 consecutive rows spanned 122 distinct values), and a cursor
 * would silently skip every row sharing a boundary value.
 *
 * Env: WINDOWS (20) · CONC (8) · resumable — existing ids in the output file are skipped.
 */
const fs = require('fs');
const readline = require('readline');

const KEY = process.env.SIMPLIFY_KEY;
const OUT = process.argv[2];
const WINDOWS = parseInt(process.env.WINDOWS || '20', 10);
const CONC = parseInt(process.env.CONC || '8', 10);
const PER_PAGE = 250;          // hard API cap
const OFFSET_CEILING = 1000000; // hard API cap, fails silently past it
const KEY_MAX = 1000000;        // shuffle_key domain
const API = 'https://js-ha.simplify.jobs/multi_search?use_cache=true&cache_ttl=120';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!KEY) { console.error('SIMPLIFY_KEY is required'); process.exit(1); }
if (!OUT) { console.error('usage: node scripts/fetch-simplify.js <out.jsonl>'); process.exit(1); }

async function search(body, attempt = 0) {
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: {
        'x-typesense-api-key': KEY,
        'content-type': 'application/json',
        origin: 'https://simplify.jobs',
        referer: 'https://simplify.jobs/',
      },
      body: JSON.stringify({ searches: [body] }),
      signal: AbortSignal.timeout(90000),
    });
    if (res.status === 429) { await sleep(3000 * (attempt + 1)); return search(body, attempt + 1); }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const r = (await res.json()).results?.[0];
    if (r?.error) throw new Error(r.error);
    return r;
  } catch (err) {
    if (attempt >= 5) { console.error(`\n  request failed permanently: ${err.message}`); return null; }
    await sleep(1500 * (attempt + 1));
    return search(body, attempt + 1);
  }
}

const q = (extra) => ({ collection: 'jobs', q: '*', query_by: 'title', sort_by: 'shuffle_key:asc', ...extra });

async function loadSeen(path) {
  const seen = new Set();
  if (!fs.existsSync(path)) return seen;
  const rl = readline.createInterface({ input: fs.createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) { try { seen.add(JSON.parse(line).id); } catch { /* truncated final line */ } }
  return seen;
}

async function main() {
  const seen = await loadSeen(OUT);
  if (seen.size) console.log(`resuming: ${seen.size.toLocaleString()} ids already dumped`);
  const out = fs.createWriteStream(OUT, { flags: 'a' });

  const total = (await search(q({ page: 1, per_page: 1 })))?.found || 0;
  if (!total) { console.error('could not read collection size — is the key still valid?'); process.exit(1); }
  console.log(`collection holds ${total.toLocaleString()} docs`);

  // Size every window first, so the request list is known up front and progress is meaningful.
  const width = Math.ceil(KEY_MAX / WINDOWS);
  const tasks = [];
  let counted = 0;
  for (let w = 0; w < WINDOWS; w++) {
    const lo = w * width;
    const filter = `shuffle_key:>=${lo} && shuffle_key:<${lo + width}`;
    const found = (await search(q({ filter_by: filter, page: 1, per_page: 1 })))?.found || 0;
    counted += found;
    const pages = Math.ceil(found / PER_PAGE);
    // The whole point of windowing. If this ever trips, raise WINDOWS.
    if (pages * PER_PAGE > OFFSET_CEILING) {
      console.error(`window ${w} needs ${pages} pages, past the ${OFFSET_CEILING} offset ceiling — raise WINDOWS`);
      process.exit(1);
    }
    for (let p = 1; p <= pages; p++) tasks.push({ filter, page: p });
  }
  console.log(`${WINDOWS} windows cover ${counted.toLocaleString()} docs (${(counted / total * 100).toFixed(2)}%) in ${tasks.length.toLocaleString()} requests`);

  let done = 0, written = 0, empty = 0, failed = 0, cursor = 0;
  const started = Date.now();
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (cursor < tasks.length) {
      const t = tasks[cursor++];
      const r = await search(q({ filter_by: t.filter, page: t.page, per_page: PER_PAGE }));
      done++;
      if (!r) { failed++; continue; }
      const hits = r.hits || [];
      if (!hits.length) empty++;
      for (const h of hits) {
        const doc = h.document;
        if (!doc?.id || seen.has(doc.id)) continue;
        seen.add(doc.id);
        out.write(JSON.stringify(doc) + '\n');
        written++;
      }
      if (done % 25 === 0) {
        const rate = done / ((Date.now() - started) / 1000);
        process.stdout.write(`\r  ${done}/${tasks.length} reqs | ${seen.size.toLocaleString()} unique | empty ${empty} | failed ${failed} | ${rate.toFixed(1)}/s | ETA ${((tasks.length - done) / rate / 60).toFixed(1)}m   `);
      }
    }
  }));

  out.end();
  await new Promise((r) => out.on('finish', r));
  console.log(`\ndone: ${seen.size.toLocaleString()} unique docs (+${written.toLocaleString()} this run) | ${empty} empty pages | ${failed} failed requests`);
  console.log(`coverage: ${(seen.size / total * 100).toFixed(2)}% of ${total.toLocaleString()}`);
  if (failed) console.log('re-run the same command to fill the gaps — it resumes from the output file.');
}

main().catch((err) => { console.error('\nFATAL', err); process.exit(1); });
