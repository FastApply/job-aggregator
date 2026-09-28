'use strict';
/**
 * Marketplace retirement must never run on a walk that did not see (nearly) the whole marketplace:
 * an absence only means "closed" if the walk would have seen the job had it still been listed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { retirementVerdict } = require('../src/tasks/crawl-workable-marketplace');

const walk = (o) => ({ complete: true, totalSize: 169403, processed: 168000, startedAt: new Date(), ...o });

test('a complete walk that saw the marketplace may retire', () => {
  assert.equal(retirementVerdict(walk()).ok, true);
});

test('a walk that stopped early (page cap, error) may not', () => {
  assert.equal(retirementVerdict(walk({ complete: false })).ok, false);
});

test('a walk that reached the end but saw too little may not', () => {
  const v = retirementVerdict(walk({ processed: 20000 }));
  assert.equal(v.ok, false);
  assert.match(v.reason, /11\.8%/);
});

test('no total from the API, no retirement', () => {
  assert.equal(retirementVerdict(walk({ totalSize: null })).ok, false);
  assert.equal(retirementVerdict(null).ok, false);
});
