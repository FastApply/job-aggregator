'use strict';
/**
 * The crawler marks a company 'failed' for good when the error looks permanent (HTTP 404, "not
 * found", ...). An unexpected page — a maintenance screen, a block, a half-loaded response — is
 * usually temporary. On 2026-10-07 Varbi served such a page for a while, the adapter called it
 * "no RSS feed (not found)", and all 340 Varbi employers were failed and never crawled again.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const crawler = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'crawl-companies-local.js'), 'utf8');
const rule = new RegExp(crawler.match(/const isPermanentError = \(msg\) => \/(.+)\/i\.test/)[1], 'i');

test('an unexpected page is retried; a real 404 is permanent', () => {
  for (const f of ['varbi', 'reachmee', 'jobylon', 'visma', 'recman', 'hrmanager', 'talentadore']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'adapters', `${f}.js`), 'utf8');
    const messages = [...src.matchAll(/throw new Error\('([^']+)'\)/g)].map((m) => m[1]);
    for (const msg of messages.filter((m) => /unexpected page/.test(m))) {
      assert.equal(rule.test(msg), false, `${f}: "${msg}" would fail the company for good`);
    }
    for (const msg of messages.filter((m) => /HTTP 404/.test(m))) {
      assert.equal(rule.test(msg), true, `${f}: a 404 should still be permanent`);
    }
  }
});
