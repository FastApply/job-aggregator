#!/usr/bin/env node
/**
 * Checks on classifyVisa(), written around a real miss.
 *
 *   node scripts/test-classify-visa.js
 *
 * The bug: VISA_NO_PATTERNS required `no` to sit adjacent to `sponsorship`, so
 * "No NEW H1B sponsorship available" did not match as a refusal. Control fell through to
 * VISA_YES_PATTERNS, which matched /h1b\s*transfer/ against the "H1B transfers welcomed"
 * sentence that follows it in the wild — so a posting opening with a refusal classified as
 * `yes`. Graded against employer-stated H1B data from Simplify: 756 of the 757 rows carrying
 * this phrasing were labelled `yes`, every one of them wrong.
 *
 * The false-positive cases below matter as much as the fix. The obvious repair is a generic
 * `(?:\w+\s+)*` gap between `no` and `sponsorship`, which makes the pattern span a whole clause
 * and reads "no reason to doubt our generous visa sponsorship" as a refusal. The enumerated
 * qualifier list exists to keep that from happening, so it is tested explicitly.
 */
const assert = require('assert');
const { classifyVisa } = require('../src/utils/classify');

let failures = 0;

/**
 * Some guards only care that a sentence is NOT read as a refusal. Asserting an exact value
 * there would bake in whatever the YES patterns happen to do today — and they have their own
 * gaps ("visa sponsorship IS available" matches nothing, because that list also requires
 * adjacency). The invariant under test is the absence of a false negative, so assert that.
 */
function checkNot(forbidden, text, note) {
  const got = classifyVisa(text);
  if (got !== forbidden) {
    console.log(`  ok    not ${JSON.stringify(forbidden)} (got ${JSON.stringify(got)}) ${note}`);
  } else {
    failures++;
    console.log(`  FAIL  must not be ${JSON.stringify(forbidden)} — ${note}`);
    console.log(`        text: ${text.slice(0, 100)}`);
  }
}

function check(expected, text, note) {
  const got = classifyVisa(text);
  try {
    assert.strictEqual(got, expected);
    console.log(`  ok    ${JSON.stringify(expected).padEnd(7)} ${note}`);
  } catch {
    failures++;
    console.log(`  FAIL  expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)} — ${note}`);
    console.log(`        text: ${text.slice(0, 100)}`);
  }
}

console.log('the regression this fixes:');
// Verbatim shape of the Bright Vision Technologies boilerplate, 1,439 postings' worth.
check('no', 'Sponsorship: No new H1B sponsorship available. H1B transfers welcomed for qualified candidates.',
  'refusal + "H1B transfers welcomed" in the same posting');
check('no', 'We have no new visa sponsorship available for this role.', 'no new visa sponsorship');
check('no', 'There is no additional sponsorship available this cycle.', 'no additional sponsorship');
check('no', 'No further H1B sponsorship will be offered.', 'no further H1B sponsorship');
check('no', 'No current sponsorship available.', 'no current sponsorship');
check('no', 'No immediate visa sponsorship available.', 'no immediate visa sponsorship');

console.log('\nfalse positives the enumerated qualifier list guards against:');
// These are why the qualifier set is a fixed list and not `(?:\w+\s+)*`.
checkNot('no', 'There is no reason to doubt our generous visa sponsorship program — we proudly sponsor H1B candidates.',
  '"no reason ... visa sponsorship"');
checkNot('no', 'No matter your background, visa sponsorship is available for this role.',
  '"No matter ... visa sponsorship is available"');

console.log('\nlinking verbs on the positive side (same adjacency bug, YES list):');
// "visa sponsorship IS available" matched nothing before — a clear offer read as unknown.
check('yes', 'Visa sponsorship is available for this role.', 'sponsorship IS available');
check('yes', 'Visa sponsorship will be provided for the right candidate.', 'sponsorship WILL BE provided');
check('yes', 'H1B sponsorship is available for qualified candidates.', 'H1B sponsorship IS available');
check('yes', 'Visa support is offered to international hires.', 'visa support IS offered');

console.log('\nnegation still beats the linking-verb forms (NO list runs first):');
// The linking-verb group cannot swallow "will NOT be", so these must never reach the YES list.
check('no', 'Visa sponsorship will not be available for this position.', 'sponsorship WILL NOT BE available');
check('no', 'Visa sponsorship is not available.', 'sponsorship IS NOT available');
check('no', 'Sponsorship may not be offered for this req.', 'sponsorship MAY NOT BE offered');
check('no', 'Sponsorship is unavailable.', 'sponsorship is unavailable');

console.log('\nwork-authorization boilerplate is NOT a refusal:');
// This rule fired on 20.8% of every production row stored as 'no', against 6.0% for the genuine
// refusal form — the largest single source of false negatives in the column. Requiring work
// authorization says nothing about sponsorship; sponsoring an H1B is how an employer grants it.
check(null, 'Applicants must be legally authorized to work in the United States.', 'must be authorized to work (US)');
check(null, 'Candidates must be authorized to work in the US.', 'must be authorized to work (short)');
check(null, 'You must be eligible to work in the country where the role is based.', 'must be eligible to work');

console.log('\n...but the "without sponsorship" clause still is:');
check('no', 'Applicants must be authorized to work in the US without sponsorship now or in the future.', 'authorized to work WITHOUT sponsorship');
check('no', 'You must be authorized to work in the United States without company sponsorship.', 'without COMPANY sponsorship');
check('no', 'Candidates must be eligible to work in the UK without visa sponsorship.', 'non-US, without visa sponsorship');
check('no', 'This role is not eligible for visa sponsorship.', 'not eligible for sponsorship');

console.log('\nexport-control boilerplate is not immigration language:');
// Cloudflare's entire job set classified 'no' on this one sentence.
check(null, 'Must be able to access technology subject to US export laws without sponsorship for an export license.',
  '"without sponsorship for an export license"');
check('no', 'We can offer this role without sponsorship only; no visa support is available.',
  '"without sponsorship" in a genuine visa context still counts');

console.log('\npre-existing behaviour, unchanged:');
check('no', 'Sponsorship: No H1B sponsorship available.', 'bare adjacency still matches');
check('no', 'We do not offer visa sponsorship.', 'do not offer');
check('no', 'We are unable to provide visa sponsorship at this time.', 'unable to provide');
check('yes', 'Visa sponsorship available for exceptional candidates.', 'sponsorship available');
check('yes', 'We are willing to sponsor the right candidate.', 'willing to sponsor');
check('yes', 'H1B transfer candidates are encouraged to apply.', 'H1B transfer alone, no refusal present');
check(null, 'We are hiring a backend engineer to work on our payments platform.', 'no visa language at all');
check(null, '', 'empty description');
check(null, null, 'null description');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
