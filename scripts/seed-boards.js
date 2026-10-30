#!/usr/bin/env node
/**
 * Seed UKG / ADP / ADP Workforce Now / SilkRoad / Gem / Kula boards from a list, checking each
 * with its own adapter first (src/tasks/seed-boards.js).
 *
 *   node scripts/seed-boards.js --file boards.txt --origin cc_urls_2026_10_29 [--dry-run]
 *   node scripts/seed-boards.js --recent-jobs [--days 30] [--dry-run]
 *
 * A --file line is either a URL (any posting or board link) or "ats slug" ("gem acme-inc").
 */
const fs = require('fs');
const { seedBoards, seedBoardsFromRecentJobs } = require('../src/tasks/seed-boards');
const { boardFromUrl } = require('../src/utils/board-urls');

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const dryRun = process.argv.includes('--dry-run');

function parseLine(line) {
  const s = line.trim();
  if (!s || s.startsWith('#')) return null;
  if (/^https?:\/\//i.test(s)) return boardFromUrl(s);
  const [ats, slug] = s.split(/\s+/);
  return ats && slug ? { ats, slug } : null;
}

(async () => {
  let out;
  if (process.argv.includes('--recent-jobs')) {
    out = await seedBoardsFromRecentJobs({ days: parseInt(arg('--days') || '2', 10), dryRun });
  } else {
    const file = arg('--file');
    const origin = arg('--origin');
    if (!file || !origin) throw new Error('usage: --file <path> --origin <label> [--dry-run]  |  --recent-jobs [--days N]');
    const candidates = fs.readFileSync(file, 'utf8').split('\n').map(parseLine).filter(Boolean);
    out = await seedBoards(candidates, {
      origin, dryRun,
      onProgress: (n, total, counts) => console.log(`  ${n}/${total} checked`, JSON.stringify(counts)),
    });
  }
  console.log(JSON.stringify(out.counts));
  const byAts = {};
  for (const r of out.seeded) byAts[r.ats] = (byAts[r.ats] || 0) + 1;
  console.log(`${dryRun ? 'would seed' : 'seeded'} by platform:`, JSON.stringify(byAts));
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
