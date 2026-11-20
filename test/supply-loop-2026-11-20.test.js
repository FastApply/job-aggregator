'use strict';
// Supply loop 2026-11-20: Workday remote types that say no, or part remote, were stored remote
// because the word "remote" is in them ("Not Remote", "Remote work is not available", "Partially
// Remote"), so those office and hybrid postings sat in remote-only searches.
const test = require('node:test');
const assert = require('node:assert/strict');
const { workModelOf } = require('../src/adapters/workday');
const { classifyJob } = require('../src/utils/classify');

test('Workday: a remote type that says no is on-site', () => {
  for (const rt of ['Not Remote', 'Not remote', 'Non-Remote', 'Non Remote', 'No Remote', 'Remote work is not available', 'Remote Not Allowed']) {
    assert.equal(workModelOf({ remoteType: rt }), 'onsite', rt);
  }
});

test('Workday: part remote is hybrid', () => {
  for (const rt of ['Partially Remote', 'Partly Remote', 'Part Remote', 'Semi-Remote', 'Remote Partial']) {
    assert.equal(workModelOf({ remoteType: rt }), 'hybrid', rt);
  }
});

test('Workday: office and site types are on-site, virtual is remote', () => {
  for (const [rt, want] of [
    ['Office', 'onsite'], ['Site Based', 'onsite'], ['Office Based', 'onsite'], ['In-Office', 'onsite'], ['In Person', 'onsite'],
    ['Virtual', 'remote'], ['Remote/Virtual', 'remote'],
  ]) assert.equal(workModelOf({ remoteType: rt }), want, rt);
});

test('Workday: the remote types read before keep their reading', () => {
  for (const [rt, want] of [
    ['On-Site', 'onsite'], ['Onsite', 'onsite'], ['On Site', 'onsite'], ['Fully Onsite', 'onsite'],
    ['Remote', 'remote'], ['Fully Remote', 'remote'], ['Remote Working', 'remote'], ['Remote - US', 'remote'],
    ['Fully Remote (Washington/Oregon Only)', 'remote'], ['Remote: Work from Home Full-Time', 'remote'],
    ['Hybrid', 'hybrid'], ['Remote/Hybrid', 'hybrid'], ['Hybrid Remote', 'hybrid'], ['Hybrid (Remote & On-site)', 'hybrid'],
    ['Flex Commuter / Hybrid', 'hybrid'],
    ['Not Applicable', null], ['No', null], ['Flexible', null], ['Office - Flexible', null], ['Office Focused', null], [undefined, null],
  ]) assert.equal(workModelOf({ remoteType: rt }), want, String(rt));
});

test("Brambles' Not Remote Operations Supervisor is no remote job", () => {
  const wt = workModelOf({ remoteType: 'Not Remote' });
  const c = classifyJob({
    title: 'Operations Supervisor',
    location: 'Wilmington, Massachusetts, USA',
    workplace_type: wt,
    description: 'And you can maximize your work-life balance and flexibility through our Hybrid Work Model. Remote Type Not Remote',
  });
  assert.equal(c.is_remote, false);
});
