'use strict';
/**
 * Three ways the board hid jobs First Apply users were searching for, measured on the live board
 * 2026-10-27 by replaying the exact queries of the 216 starved First Apply automations:
 *
 *  1. A location with punctuation matched nothing. Index tokens have punctuation replaced by
 *     spaces; the query side kept it. "St. Louis" 0 rows (St Louis 258), "Cluj-Napoca" 0 (Cluj 23).
 *  2. The same posting under two document ids filled two page slots: 17% of rows on those pages
 *     repeated a URL already on the page.
 *  3. work_mode / employment_type dropped postings that state neither — most of what they removed
 *     (198 of 322 and 170 of 212 rows). include_unlabeled keeps them for callers that check the
 *     posting themselves.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFilter, dedupeHits, interleaveByRole, placeSpellings } = require('../src/db/repositories/jobs-search');

const filterFor = (f) => buildFilter(f).filter;

test('a punctuated place also asks for the punctuation-free token the index holds', () => {
  const f = filterFor({ location: 'St. Louis' });
  assert.match(f, /location_tokens = "st louis"/);
  assert.match(f, /location_tokens = "saint louis"/, 'the spelled-out form is a separate posting set');
  assert.match(filterFor({ location: 'Cluj-Napoca' }), /location_tokens = "cluj napoca"/);
  assert.match(filterFor({ location: 'KwaZulu-Natal' }), /location_tokens = "kwazulu natal"/);
});

test('saint/fort/mount forms go both ways and leave other places alone', () => {
  assert.ok(placeSpellings('Saint Paul').includes('st paul'));
  assert.ok(placeSpellings('Ft. Worth').includes('fort worth'));
  assert.ok(placeSpellings('Mount Vernon').includes('mt vernon'));
  assert.deepEqual(placeSpellings('London'), ['London', 'london']);
  // "St" alone is not a place prefix to expand.
  assert.deepEqual(placeSpellings('St'), ['St', 'st']);
});

test('a plain place keeps exactly the clause it had', () => {
  const before = filterFor({ location: 'Denver' });
  assert.match(before, /location_tokens = "denver"/);
  assert.doesNotMatch(before, /saint|fort /);
});

test('the same posting under two ids takes one page slot', () => {
  const hits = [
    { id: 1, url: 'https://x.wd1.myworkdayjobs.com/a/job/1' },
    { id: 2, url: 'https://x.wd1.myworkdayjobs.com/a/job/1' },
    { id: 3, url: 'https://x.wd1.myworkdayjobs.com/a/job/1/' },
    { id: 4, url: 'https://boards.greenhouse.io/b/jobs/9' },
  ];
  assert.deepEqual(dedupeHits(hits).map((h) => h.id), [1, 4]);
});

test('the multi-role merge dedupes by URL too, keeping the first claim', () => {
  const a = [{ id: 10, url: 'u-shared' }, { id: 11, url: 'u-a' }];
  const b = [{ id: 20, url: 'u-shared' }, { id: 21, url: 'u-b' }];
  assert.deepEqual(interleaveByRole([a, b]).map((h) => h.id), [10, 11, 21]);
});

test('hits without a url still dedupe by id', () => {
  assert.deepEqual(dedupeHits([{ id: 1 }, { id: 1 }, { id: 2 }]).map((h) => h.id), [1, 2]);
});

test('include_unlabeled keeps postings with no employment type', () => {
  const plain = filterFor({ employmentType: 'full-time' });
  assert.doesNotMatch(plain, /IS NULL/, 'the board UI keeps its strict filter');
  const kept = filterFor({ employmentType: 'full-time', includeUnlabeled: 'true' });
  assert.match(kept, /\(employment_type = "[^"]+" OR employment_type IS NULL OR NOT employment_type EXISTS\)/);
});

test('include_unlabeled keeps unlabeled non-remote postings for an office mode', () => {
  const kept = filterFor({ workMode: 'hybrid', includeUnlabeled: 'true' });
  assert.match(kept, /workplace_type = "Hybrid" OR \(\(workplace_type IS NULL OR NOT workplace_type EXISTS\) AND NOT is_remote = true\)/);
  assert.doesNotMatch(filterFor({ workMode: 'hybrid' }), /IS NULL/);
  // Remote alone is a flag the posting carries; nothing unlabeled to add.
  assert.doesNotMatch(filterFor({ workMode: 'remote', includeUnlabeled: 'true' }), /IS NULL/);
});
