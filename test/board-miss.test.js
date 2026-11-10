'use strict';
/**
 * A board is retired only after its "gone" answer has held for a week — not on the first one.
 * BambooHR 404'd most tenants on 2026-10-19..21 and 18,610 live boards were failed for good.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { boardMissOutcome, isBoardMiss } = require('../src/utils/board-miss');

const DAY = 86400000;
const t0 = new Date('2026-10-19T12:00:00.000Z');

test('the first miss never retires a board', () => {
  const out = boardMissOutcome(null, 'BambooHR HTTP 404', t0);
  assert.equal(out.retire, false);
  assert.equal(out.misses, 1);
  assert.equal(out.message, 'BambooHR HTTP 404 (missing since 2026-10-19T12:00:00.000Z, miss 1)');
  assert.ok(isBoardMiss(out.message));
});

test('a three-day outage does not retire a board, however many misses it racks up', () => {
  let msg = null;
  for (let h = 0; h <= 72; h += 6) {
    const out = boardMissOutcome(msg, 'BambooHR HTTP 404', new Date(t0.getTime() + h * 3600000));
    assert.equal(out.retire, false, `retired after ${h}h`);
    msg = out.message;
  }
  assert.match(msg, /missing since 2026-10-19T12:00:00\.000Z, miss 13\)$/);
});

test('a miss that holds for a week retires the board', () => {
  let msg = null;
  let out;
  for (let d = 0; d <= 7; d++) {
    out = boardMissOutcome(msg, 'BambooHR HTTP 404', new Date(t0.getTime() + d * DAY));
    msg = out.message;
  }
  assert.equal(out.retire, true);
  assert.equal(out.misses, 8);
});

test('a week-old first miss still needs the minimum number of misses', () => {
  const prev = 'Greenhouse HTTP 404 (missing since 2026-10-01T00:00:00.000Z, miss 1)';
  assert.equal(boardMissOutcome(prev, 'Greenhouse HTTP 404', t0).retire, false);
});

test('an unrelated earlier error does not count as a miss', () => {
  const out = boardMissOutcome('Workday: could not discover config for acme (miss 4/5)', 'Workday HTTP 404', t0);
  assert.equal(out.misses, 1);
  assert.equal(out.retire, false);
});

test('the error text does not pile up suffixes', () => {
  const a = boardMissOutcome(null, 'X HTTP 404', t0);
  const b = boardMissOutcome(a.message, a.message, new Date(t0.getTime() + DAY));
  assert.equal(b.message, 'X HTTP 404 (missing since 2026-10-19T12:00:00.000Z, miss 2)');
});

test('neither crawler fails a board on a single permanent-looking error', () => {
  const queue = fs.readFileSync(path.join(__dirname, '..', 'src', 'queues', 'sync.queue.js'), 'utf8');
  assert.doesNotMatch(queue, /markFailed\(job\.data\.companyId, err\.message\)/);
  assert.match(queue, /boardMissOutcome\(/);
  const local = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'crawl-companies-local.js'), 'utf8');
  const branch = local.slice(local.indexOf('isPermanentError(e.message) && !proxy.enabled'));
  assert.match(branch.slice(0, 600), /boardMissOutcome\(co\.error_message, e\.message\)/);
});
