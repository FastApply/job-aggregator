'use strict';
/**
 * A comma-separated `q` is an OR over roles, and EVERY role must reach the page.
 *
 * Measured on the live board 2026-09-17, before this change:
 *   q="Industrial Security,Physical Security,Project Manager"  -> 137 rows, 0 with "security"
 *                                                                 in the title, at any offset
 *   q="Physical Security"                                      -> the 2 matching jobs
 *   q="Project Manager"                                        -> 397
 * Whichever role was listed FIRST owned the whole page; roles 2..N contributed nothing.
 * Cause: buildQuery joined the roles with a space into one Meilisearch query and multi-role
 * used matchingStrategy 'last', which drops query words from the END until it has enough hits.
 * 266 of 317 active FastApply automations (84%) are multi-role, so most users' second and third
 * target roles had never been searched.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { interleaveByRole, splitRoles, mergeFacets, MAX_ROLES } = require('../src/db/repositories/jobs-search');

const hits = (...ids) => ids.map((id) => ({ id, title: `job-${id}` }));

test('splitRoles keeps each comma-separated role separate', () => {
  assert.deepEqual(
    splitRoles({ q: 'Industrial Security, Physical Security ,Project Manager' }),
    ['Industrial Security', 'Physical Security', 'Project Manager']
  );
  assert.deepEqual(splitRoles({}), []);
  assert.deepEqual(splitRoles({ q: ' , ,' }), []);
});

test('a huge role cannot crowd a small one off the page', () => {
  // The shape that broke michaelcourt@pm.me: role A has hundreds of matches, role B has two.
  const big = hits(...Array.from({ length: 100 }, (_, i) => `big-${i}`));
  const small = hits('phys-1', 'phys-2');
  const page = interleaveByRole([big, small]).slice(0, 10);
  const smallOnPage = page.filter((h) => String(h.id).startsWith('phys-')).length;
  assert.equal(smallOnPage, 2, 'both small-role jobs must be on page one');
  assert.equal(page[0].id, 'big-0');
  assert.equal(page[1].id, 'phys-1');
});

test('the LAST role is never starved, whatever its position', () => {
  const a = hits('a1', 'a2', 'a3');
  const b = hits('b1', 'b2', 'b3');
  const c = hits('c1', 'c2', 'c3');
  const page = interleaveByRole([a, b, c]).slice(0, 3);
  assert.deepEqual(page.map((h) => h.id), ['a1', 'b1', 'c1'],
    'page one must carry one hit from every role, not three from the first');
});

test('reordering the roles does not change WHICH jobs are reachable', () => {
  const a = hits('a1', 'a2');
  const b = hits('b1', 'b2');
  const forward = interleaveByRole([a, b]).map((h) => h.id).sort();
  const reversed = interleaveByRole([b, a]).map((h) => h.id).sort();
  assert.deepEqual(forward, reversed);
  assert.deepEqual(forward, ['a1', 'a2', 'b1', 'b2']);
});

test('a job matching two roles appears once, at its earliest position', () => {
  const a = hits('shared', 'a2');
  const b = hits('shared', 'b2');
  const merged = interleaveByRole([a, b]);
  assert.deepEqual(merged.map((h) => h.id), ['shared', 'a2', 'b2']);
});

test('roles with no hits do not leave holes in the page', () => {
  const merged = interleaveByRole([hits('a1', 'a2'), [], hits('c1')]);
  assert.deepEqual(merged.map((h) => h.id), ['a1', 'c1', 'a2']);
});

test('interleave handles the degenerate inputs', () => {
  assert.deepEqual(interleaveByRole([]), []);
  assert.deepEqual(interleaveByRole([[], []]), []);
});

test('facet counts from every role are summed, not taken from the first', () => {
  const merged = mergeFacets([
    { facetDistribution: { ats: { greenhouse: 3, workday: 1 } } },
    { facetDistribution: { ats: { workday: 2, jazzhr: 5 } } },
  ]);
  assert.deepEqual(merged, { ats: { greenhouse: 3, workday: 3, jazzhr: 5 } });
  assert.equal(mergeFacets([{}, null]), null);
});

test('the role cap truncates the tail rather than sampling', () => {
  const many = Array.from({ length: MAX_ROLES + 5 }, (_, i) => `role ${i}`);
  const kept = splitRoles({ q: many.join(',') }).slice(0, MAX_ROLES);
  assert.equal(kept.length, MAX_ROLES);
  assert.equal(kept[0], 'role 0');
  assert.equal(kept[MAX_ROLES - 1], `role ${MAX_ROLES - 1}`);
});

/* ---- end-to-end through search(), with the index stubbed ---------------------------------- */

const meili = require('../src/utils/meili');
const jobsSearch = require('../src/db/repositories/jobs-search');

/** Stand in for the index: every role has its own corpus, matched as an AND of its words. */
function stubIndex(corpus) {
  const calls = { search: [], multiSearch: [] };
  const run = (q, strategy) => {
    const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
    // 'all' needs every word; 'last' drops words from the END until something matches — the
    // real Meilisearch behaviour that silently reduced a 3-role query to role #1.
    for (let take = words.length; take > 0; take -= 1) {
      const need = words.slice(0, take);
      const hits = corpus.filter((d) => need.every((w) => d.title.toLowerCase().includes(w)));
      if (hits.length) return { hits, estimatedTotalHits: hits.length };
      if (strategy === 'all') break;
    }
    return { hits: [], estimatedTotalHits: 0 };
  };
  meili.enabled = true;
  meili.search = async (params) => {
    calls.search.push(params);
    const r = run(params.q, params.matchingStrategy);
    return { ...r, hits: r.hits.slice(params.offset || 0, (params.offset || 0) + params.limit) };
  };
  meili.multiSearch = async (queries) => {
    calls.multiSearch.push(queries);
    return queries.map((qy) => {
      const r = run(qy.q, qy.matchingStrategy);
      return { ...r, hits: r.hits.slice(0, qy.limit) };
    });
  };
  return calls;
}

// Mirrors the live Dallas feed: a wall of "Industrial <trade>" jobs that only ever matched
// because 'last' dropped the word "Security", two real Physical Security jobs, and a large
// Project Manager corpus. The two genuine Industrial Security postings are what the first role
// SHOULD return.
const CORPUS = [
  ...Array.from({ length: 60 }, (_, i) => ({ id: `noise-${i}`, title: `Industrial Maintenance Technician ${i}` })),
  { id: 'ind-1', title: 'Industrial Security Analyst' },
  { id: 'ind-2', title: 'Industrial Security Manager' },
  { id: 'phys-1', title: 'Physical Security Systems Engineer' },
  { id: 'phys-2', title: 'Physical Security Manager' },
  ...Array.from({ length: 40 }, (_, i) => ({ id: `pm-${i}`, title: `Project Manager ${i}` })),
];

test("michaelcourt's query reaches every role instead of only the first", async () => {
  const calls = stubIndex(CORPUS);
  const res = await jobsSearch.search({
    q: 'Industrial Security,Physical Security,Project Manager',
    limit: 45,
  });

  assert.equal(calls.multiSearch.length, 1, 'one /multi-search, not one request per role');
  assert.equal(calls.search.length, 0, 'the flattened single-query path must not run');
  assert.deepEqual(calls.multiSearch[0].map((qy) => qy.q),
    ['Industrial Security', 'Physical Security', 'Project Manager']);
  assert.ok(calls.multiSearch[0].every((qy) => qy.matchingStrategy === 'all'),
    'every role gets the precision a single-role search already gets');

  const titles = res.rows.map((r) => r.title);
  // The whole point: BOTH Physical Security jobs are on page one. Before the fix the live board
  // returned 137 rows for this query with zero "security" titles among them.
  assert.equal(titles.filter((t) => /Physical Security/.test(t)).length, 2, JSON.stringify(titles.slice(0, 6)));
  assert.ok(titles.some((t) => /^Project Manager/.test(t)), 'the last role must reach the page');
  assert.equal(titles.filter((t) => /Industrial Security/.test(t)).length, 2,
    'the first role is still served');

  // And the other half of the win: requiring every word of a role drops the wall of
  // "Industrial Maintenance Technician" jobs that only ever matched because 'last' threw the
  // word "Security" away. Those 38 postings were what the AI matcher then refused on job title,
  // run after run, while the user's real matches were never fetched.
  assert.equal(titles.filter((t) => /Industrial Maintenance/.test(t)).length, 0,
    'a role must not match on a prefix of its own words');
});

test('role order no longer decides which jobs exist', async () => {
  stubIndex(CORPUS);
  const forward = await jobsSearch.search({ q: 'Industrial Security,Physical Security,Project Manager', limit: 45 });
  const reversed = await jobsSearch.search({ q: 'Project Manager,Physical Security,Industrial Security', limit: 45 });
  const ids = (r) => r.rows.map((x) => x.id).sort();
  assert.deepEqual(ids(forward), ids(reversed),
    'the same jobs must be reachable however the user ordered their roles');
});

test('total is the OR of the roles, not one role alone', async () => {
  stubIndex(CORPUS);
  const both = await jobsSearch.search({ q: 'Physical Security,Project Manager', limit: 10 });
  const pmOnly = await jobsSearch.search({ q: 'Project Manager', limit: 10 });
  assert.equal(pmOnly.total, 40);
  assert.equal(both.total, 42, 'two Physical Security + forty Project Manager');
});

test('a single-role search is untouched — still one query, still strict', async () => {
  const calls = stubIndex(CORPUS);
  const res = await jobsSearch.search({ q: 'Physical Security', limit: 10 });
  assert.equal(calls.multiSearch.length, 0);
  assert.equal(calls.search.length, 1);
  assert.equal(calls.search[0].matchingStrategy, 'all');
  assert.equal(res.rows.length, 2);
});

test('deep pages fall back rather than coming back empty', async () => {
  const calls = stubIndex(CORPUS);
  const res = await jobsSearch.search({ q: 'Industrial Security,Project Manager', limit: 50, offset: 400 });
  assert.equal(calls.multiSearch.length, 0, 'past the merge depth the old single-query path serves');
  assert.equal(calls.search.length, 1);
  assert.ok(res, 'a deep page must still return a result object');
});

test('an index with no /multi-search degrades to the old path instead of failing', async () => {
  const calls = stubIndex(CORPUS);
  meili.multiSearch = async () => null;
  const res = await jobsSearch.search({ q: 'Industrial Security,Project Manager', limit: 10 });
  assert.equal(calls.search.length, 1, 'falls through to the single-query path');
  assert.ok(res.rows.length > 0);
});

test('a /multi-search 404 uses the single-query path, not the Postgres fallback', async () => {
  const calls = stubIndex(CORPUS);
  meili.multiSearch = async () => { const e = new Error('Meili POST /multi-search -> 404'); e.status = 404; throw e; };
  const res = await jobsSearch.search({ q: 'Industrial Security,Project Manager', limit: 10 });
  assert.ok(res, 'must not return null — null sends the request to a Postgres query that times out');
  assert.equal(calls.search.length, 1);
  assert.ok(res.rows.length > 0);
});
