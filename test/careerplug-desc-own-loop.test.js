'use strict';
/**
 * CareerPlug descriptions drain in a loop of their own (scripts/render-worker.js runOwnDescLoop).
 * Big franchise boards hold thousands of postings past the 400 a crawl reads; at 30 rows a shared
 * cycle, FastApply still saw 52 "Industry cannot be checked: the posting has no description"
 * refusals in 12 h on 2026-11-22, every one a CareerPlug row.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { ATS_CONFIG } = require('../src/tasks/backfill-descriptions');

test('CareerPlug drains in its own loop, one posting at a time', () => {
  assert.equal(ATS_CONFIG.careerplug.ownLoop, true);
  assert.equal(ATS_CONFIG.careerplug.concurrency, 1);
});

test('the shared cycle leaves CareerPlug to its own loop', () => {
  const shared = Object.entries(ATS_CONFIG).filter(([, cfg]) => !cfg.ownLoop).map(([ats]) => ats);
  assert.ok(!shared.includes('careerplug'));
  assert.ok(shared.includes('avature'));
});
