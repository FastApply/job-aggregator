'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { feedRemoteTags, checkedFeedWorkplace, feedWorkplace } = require('../src/utils/feed-workplace');
const { plan } = require('../scripts/retag-feed-remote');

// Micron's "Program Manager, SIG" as Wonsulting fed it (work_setting "remote"; Micron's Workday
// lists it on-site in San Jose), 2026-11-24: nothing in its text says remote.
const micron = {
  id: 1584110908,
  title: 'Program Manager, SIG',
  location: 'San Jose, CA',
  description:
    '<p>Role Overview The Senior Technical Program Manager will lead the Technical Program Managers of the Sight product teams, setting common standards for program plans, dependency management, risk tracking, and status reporting.</p><p>The role will be responsible for translating strategy and the annual plan into daily, weekly, and monthly execution, maintaining the structure and rhythm of a global, multi-product team.</p>',
};
const remote = {
  id: 7,
  title: 'Account Executive',
  location: 'United States',
  description:
    '<p>This is a fully remote role open to candidates anywhere in the United States.</p><p>You will own a book of mid-market accounts, run discovery, build proposals and close new business across the territory, working with marketing and solutions engineering.</p>',
};

test("a feed's remote the posting's own text does not state becomes an unknown work mode", () => {
  assert.deepEqual(feedRemoteTags(micron), { workplace_type: null, is_remote: false, remote_worldwide: false });
  assert.equal(checkedFeedWorkplace('remote', micron), null);
});

test("a feed's remote the text states is kept, and is_remote agrees", () => {
  const t = feedRemoteTags(remote);
  assert.equal(t.workplace_type, 'remote');
  assert.equal(t.is_remote, true);
  assert.equal(t.remote_worldwide, false);
  assert.equal(checkedFeedWorkplace('Remote', remote), 'remote');
});

test('a row with no text to read is unknown, not remote', () => {
  assert.equal(feedRemoteTags({ title: 'Program Manager', location: 'San Jose, CA', description: 'Apply now.' }).workplace_type, null);
});

test('a remote title is read as the posting saying so', () => {
  const t = feedRemoteTags({ ...micron, title: 'Program Manager (Remote)' });
  assert.equal(t.is_remote, true);
});

test('hybrid and on-site stay as the feed says', () => {
  assert.equal(checkedFeedWorkplace('hybrid', micron), 'hybrid');
  assert.equal(checkedFeedWorkplace('on-site', micron), 'onsite');
  assert.equal(feedWorkplace('in-person'), 'onsite');
  assert.equal(checkedFeedWorkplace(null, micron), null);
});

test('the retag plan keeps the confirmed rows and clears the rest', () => {
  const p = plan([micron, remote]);
  assert.deepEqual(p.keep, [7]);
  assert.deepEqual(p.ww, [false]);
  assert.deepEqual(p.clear, [1584110908]);
});
