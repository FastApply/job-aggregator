'use strict';
// Workable short links resolved on the VPS over IPv6 (2026-11-12), read back with J_MAP.
const test = require('node:test');
const assert = require('node:assert/strict');
const { accountOfRedirect, parseJMap } = require('../scripts/rehome-workable-feed-rows');

test('a redirect names the account the posting belongs to', () => {
  assert.equal(accountOfRedirect('https://apply.workable.com/fairmoney/j/00007C69D0'), 'fairmoney');
  assert.equal(accountOfRedirect('https://apply.workable.com/sealink-travel-group/j/000118F443/apply'), 'sealink-travel-group');
  assert.equal(accountOfRedirect('/raydar/j/6C8904B858/apply'), 'raydar');
});

test("Workable's /oops page is a posting that is gone", () => {
  assert.equal(accountOfRedirect('https://apply.workable.com/oops'), 'gone');
});

test('no redirect, or one to anywhere else, names nobody', () => {
  assert.equal(accountOfRedirect(''), null);
  assert.equal(accountOfRedirect(null), null);
  assert.equal(accountOfRedirect('https://www.workable.com/'), null);
});

test('the map file: url, status, target per line; blank and partial lines skipped', () => {
  const m = parseJMap([
    'https://apply.workable.com/j/00007C69D0\t301\thttps://apply.workable.com/fairmoney/j/00007C69D0',
    'https://apply.workable.com/j/0013EB9766/apply\t302\thttps://apply.workable.com/oops',
    'https://apply.workable.com/j/DEADBEEF00\t000\t',
    '',
  ].join('\n'));
  assert.equal(m.size, 3);
  assert.equal(accountOfRedirect(m.get('https://apply.workable.com/j/00007C69D0')), 'fairmoney');
  assert.equal(accountOfRedirect(m.get('https://apply.workable.com/j/0013EB9766/apply')), 'gone');
  assert.equal(accountOfRedirect(m.get('https://apply.workable.com/j/DEADBEEF00')), null);
});
