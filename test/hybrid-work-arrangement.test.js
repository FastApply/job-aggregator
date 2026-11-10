'use strict';
// pref-match audit, 2026-11-10: Solidigm's remote Senior Security Application Engineer was stored
// Hybrid because its requirements say "hybrid crypto schemes". "Hybrid" is a work model only where
// it names one.
const { test } = require('node:test');
const assert = require('node:assert');
const { statesHybridWork, jobStatesHybrid } = require('../src/utils/hybrid-work');
const { extractWorkplaceType } = require('../src/utils/extract');
const { classifyRemote } = require('../src/utils/classify');

const SOLIDIGM =
  'Post-quantum cryptography (PQC) — practical experience with ML-DSA, LMS/LMOD, or hybrid crypto schemes; familiarity with CNSA 2.0+ and NIST PQC standards.';

test('"hybrid crypto schemes" is no work model (Solidigm)', () => {
  assert.strictEqual(statesHybridWork(SOLIDIGM), false);
  assert.strictEqual(
    extractWorkplaceType('Senior Security Application Engineer - Automation & Detection', 'Rancho Cordova, CA, United States', SOLIDIGM),
    null
  );
  assert.notStrictEqual(
    classifyRemote('Senior Security Engineer', 'Remote, United States', null, SOLIDIGM),
    false,
    'a remote location is not overruled by the adjective'
  );
});

test('hybrid as an adjective of a thing does not count', () => {
  for (const text of [
    'Experience designing hybrid cloud and multi-cloud architectures.',
    'Support remote and hybrid cloud deployments for our customers.',
    'We build hybrid and multi-cloud environments.',
    'Knowledge of hybrid vehicles and battery systems.',
    'Our documentation is Git-based, wiki, or hybrid.',
    'Build hybrid mobile apps with Ionic.',
    'Run workloads hybrid in the cloud and on premises.',
  ]) {
    assert.strictEqual(statesHybridWork(text), false, text);
  }
});

test('hybrid as the way the job is worked counts', () => {
  for (const text of [
    'This is a hybrid role based in our Austin office.',
    'We offer a hybrid work model with two days in office.',
    'Hybrid (3 days in office)',
    'Hybrid, 2 days a week in Denver',
    'Location: Hybrid',
    'Work Model: Hybrid',
    'Workplace type - Hybrid',
    'Senior Analyst - Hybrid',
    'Senior Analyst (Hybrid)',
    'This position can be remote or hybrid.',
    'On-site, hybrid or remote',
    'The role is hybrid, with Tuesdays and Thursdays in the office.',
    'Hybrid in Austin, TX',
    'Hybrid Remote',
    'hybrid-remote schedule',
  ]) {
    assert.strictEqual(statesHybridWork(text), true, text);
  }
});

test('the location field counts on the word alone', () => {
  assert.strictEqual(jobStatesHybrid('Engineer', 'USA and Global (Hybrid)', ''), true);
  assert.strictEqual(jobStatesHybrid('Engineer', 'Hybrid, Chicago, IL', ''), true);
  assert.strictEqual(jobStatesHybrid('Hybrid Cloud Engineer', 'Austin, TX', 'Design hybrid cloud platforms.'), false);
  assert.strictEqual(extractWorkplaceType('Hybrid Cloud Engineer', 'Austin, TX', 'Design hybrid cloud platforms.'), null);
});

test('a hybrid work statement still beats remote wording, as before', () => {
  assert.strictEqual(
    extractWorkplaceType('Product Manager', 'Austin, TX', 'This is a remote position with a hybrid work schedule for local candidates.'),
    'hybrid'
  );
});
