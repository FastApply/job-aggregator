'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { workplaceOf } = require('../src/adapters/breezy');
const { classifyJob } = require('../src/utils/classify');

// Precision's "Executive Assistant & Office Manager (DC Office)" as Breezy's /json serves it, 2026-11-19.
const hybrid = {
  city: 'Washington',
  name: 'Washington, DC',
  is_remote: true,
  remote_details: { value: 'hybrid', label: 'Hybrid (Some remote, some in person)' },
};
// Journey Education's "Purchasing Coordinator", same day.
const remote = {
  city: 'Dallas',
  name: 'Dallas, TX',
  is_remote: true,
  remote_details: { value: 'remote', label: 'Fully remote, no location restrictions' },
};

test('Breezy Hybrid is hybrid, not remote', () => {
  assert.equal(workplaceOf(hybrid), 'hybrid');
  const tags = classifyJob({ title: 'Executive Assistant & Office Manager (DC Office)', location: 'Washington, DC', workplace_type: workplaceOf(hybrid), description: 'In this hybrid role' });
  assert.equal(tags.is_remote, false);
});

test('Breezy remote stays remote; a place with no setting has none', () => {
  assert.equal(workplaceOf(remote), 'remote');
  assert.equal(workplaceOf({ ...remote, remote_details: { value: 'remote-location' } }), 'remote');
  assert.equal(workplaceOf({ city: 'Austin', is_remote: false }), null);
  assert.equal(workplaceOf(null), null);
});
