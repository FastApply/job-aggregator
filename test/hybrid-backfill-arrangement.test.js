'use strict';
// The 2026-11-11 10% shadow of backfill-hybrid-flag.js: about 1 in 6 remote retags were wrong.
const test = require('node:test');
const assert = require('node:assert/strict');
const { retag, statesArrangement } = require('../scripts/backfill-hybrid-flag');

const row = (title, location, description) => ({ title, location, description });

test('kept: the posting states a hybrid or in-office arrangement', () => {
  // JazzHR, Northville, MI
  assert.equal(retag(row('Customer Service Representative', 'Northville, MI',
    '<p>Work model: <span>In office 5 days per week. Hybrid may be available for the right candidate.</span> Remote work considered.</p>')), null);
  // Workday, Toronto
  assert.equal(retag(row('Senior Event Consultant', 'CAN - ON GTA (Remote)',
    '<p>Fully remote team culture.</p><p><b>Role Designation: </b>Hybrid with a requirement to attend our Toronto office based on business need </p>')), null);
  // Workday, Calgary
  assert.equal(retag(row('Field Adjuster', 'Calgary, Canada',
    '<p>This is a remote role.</p><ul><li><p>Hybrid flexible work model.</p></li></ul>')), null);
  // Workday, a bare list item
  assert.equal(retag(row('PCG Internship Summer 2027', 'United States (Remote)',
    '<p>Remote internship.</p><ul><li><p>Must be enrolled in a full-time degree program.</p></li><li>Hybrid</li></ul>')), null);
});

test('kept: the title or a "Type:" field says hybrid (second shadow, 2026-11-12)', () => {
  assert.equal(retag(row('Tax Accountant - Hybrid Portland Metro Area', 'Work From Home OR',
    '<p>This role can be performed remotely.</p>')), null);
  assert.equal(retag(row('Community Health Partner - MD', 'MD - Remote',
    '<p>Job Description: Location: MD Montgomery County Type: Hybrid About the Role. Remote work available.</p>')), null);
});

test('kept: a remote reading the location does not back', () => {
  // Booz Allen, remote only through the title
  assert.equal(retag(row('Remote and Autonomous Systems Logistician, Senior', 'Washington, DC',
    '<p>Support hybrid unmanned systems programs.</p>')), null);
});

test('retagged: "hybrid" is about the product and the location says remote', () => {
  const t = retag(row('Senior OpenStack Engineer', 'KSA-Work from Home, Saudi Arabia',
    '<p>Rackspace Technology is a leading end-to-end, hybrid cloud and AI solutions company. This is a remote position.</p>'));
  assert.equal(t && t.workplace, 'remote');
  assert.equal(t.is_remote, true);
  const f = retag(row('Senior Customer Success Manager', 'Home-United Kingdom',
    '<p>A pioneer in Hybrid ITAM and FinOps. This role is fully remote.</p>'));
  assert.equal(f && f.is_remote, true);
});

test("Booz Allen's definitions of every work model are not this job's arrangement", () => {
  assert.equal(statesArrangement('• Hybrid: If this position is listed as hybrid, you will be expected to work from a Booz Allen facility'), false);
  assert.equal(statesArrangement('A pioneer in Hybrid ITAM and FinOps'), false);
  assert.equal(statesArrangement('This hybrid SDR role combines inbound and outbound'), false);
  assert.equal(statesArrangement('Role Designation: Hybrid'), true);
  assert.equal(statesArrangement('Work Arrangement: On-site'), true);
  assert.equal(statesArrangement('On-site 3 days a week'), true);
});
