'use strict';
/**
 * Marketplace jobs are retired only on Workable's own answer for that job: 410 Gone (or a
 * non-published state). Anything ambiguous decides nothing, and a 429 stops the run.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { livenessAction } = require('../src/tasks/crawl-workable-marketplace');

test('410 Gone retires the job', () => assert.equal(livenessAction(410), 'retire'));
test('200 published keeps it', () => assert.equal(livenessAction(200, { state: 'published' }), 'alive'));
test('200 with a closed state retires it', () => assert.equal(livenessAction(200, { state: 'closed' }), 'retire'));
test('200 with an unreadable body keeps it', () => assert.equal(livenessAction(200, null), 'alive'));
test('429 backs off', () => assert.equal(livenessAction(429), 'back-off'));
test('404, 5xx and network errors decide nothing', () => {
  for (const s of [404, 500, 502, 0]) assert.equal(livenessAction(s), 'unknown', String(s));
});
