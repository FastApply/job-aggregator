'use strict';
/**
 * Feed twins (src/utils/feed-twins.js): a feed's row for a posting the ATS crawl also holds is
 * never served. The cases are the two First Apply applications that went to the wrong job
 * through one (pref-match loop, 2026-10-28) and the guards that keep unrelated rows apart.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { atsPostingKey, isAtsRow, findFeedTwins } = require('../src/utils/feed-twins');

// The rows as the live board held them (ids and URLs real, descriptions dropped).
const APPLOVIN_ATS = { id: 766180088, ats: 'greenhouse', external_id: 'greenhouse_4723320006', url: 'https://boards.greenhouse.io/applovin/jobs/4723320006?gh_jid=4723320006', location: 'Palo Alto, CA' };
const APPLOVIN_FEED = { id: 927294059, ats: 'greenhouse', external_id: '185dfc341bf5b2076745a365bad6fb6307215fcde89cc3128e1c7f245dfa0d86', url: 'https://job-boards.greenhouse.io/applovin/jobs/4723320006', location: 'Palo Alto, CA, Toronto' };
const PROPERTYSE_ATS = { id: 525008742, ats: 'workable', external_id: 'workable_6756FD5D61', url: 'https://apply.workable.com/propertyse/j/6756FD5D61/', employment_type: 'contract' };
const PROPERTYSE_FEED = { id: 480193819, ats: 'workable', external_id: '10b7e08fb674c0dd5c7c440b330504a0cd982c43710ad822312ba3afe403460c', url: 'https://apply.workable.com/propertyse/j/6756FD5D61/', employment_type: null };

/** A query stub over a fixed set of live rows, recording what it was asked. */
function fakeDb(liveRows) {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (/FROM jobs\s+WHERE external_id = ANY/.test(sql)) {
      return { rows: liveRows.filter((r) => params[0].includes(r.external_id)) };
    }
    return { rows: [], rowCount: 0 };
  };
  return { query, calls };
}

test('the URL names the posting the ATS crawl keys on, whatever host form the feed used', () => {
  assert.deepEqual(atsPostingKey('greenhouse', APPLOVIN_FEED.url), { externalId: 'greenhouse_4723320006', board: 'applovin' });
  assert.deepEqual(atsPostingKey('greenhouse', APPLOVIN_ATS.url), { externalId: 'greenhouse_4723320006', board: 'applovin' });
  assert.deepEqual(atsPostingKey('workable', PROPERTYSE_FEED.url), { externalId: 'workable_6756FD5D61', board: 'propertyse' });
  assert.deepEqual(atsPostingKey('lever', 'https://jobs.lever.co/acme/0b4c7e1a-1111-2222-3333-444455556666/apply'),
    { externalId: 'lever_0b4c7e1a-1111-2222-3333-444455556666', board: 'acme' });
  assert.deepEqual(atsPostingKey('bamboohr', 'https://acme.bamboohr.com/careers/77'), { externalId: 'bamboohr_77', board: 'acme' });
});

test('URLs that do not carry the posting id are never keyed', () => {
  assert.equal(atsPostingKey('workable', 'https://jobs.workable.com/view/ohVMqWoHVJdhjPZbbKPxWZ/remote-marketing'), null);
  assert.equal(atsPostingKey('greenhouse', 'https://careers.example.com/open-roles'), null);
  assert.equal(atsPostingKey('workday', 'https://x.wd1.myworkdayjobs.com/en-US/ext/job/R1'), null, 'unrecognised ATS');
  assert.equal(atsPostingKey('greenhouse', 'not a url'), null);
});

test('a row the ATS crawl wrote is told apart from a feed row', () => {
  assert.equal(isAtsRow(APPLOVIN_ATS), true);
  assert.equal(isAtsRow(PROPERTYSE_ATS), true);
  assert.equal(isAtsRow(APPLOVIN_FEED), false);
  assert.equal(isAtsRow(PROPERTYSE_FEED), false);
});

test('both real feed twins are found against their live ATS rows, in one lookup', async () => {
  const db = fakeDb([APPLOVIN_ATS, PROPERTYSE_ATS]);
  const twins = await findFeedTwins([APPLOVIN_FEED, PROPERTYSE_FEED, APPLOVIN_ATS, PROPERTYSE_ATS], db.query);
  assert.deepEqual([...twins.entries()].sort(), [[480193819, 525008742], [927294059, 766180088]]);
  assert.equal(db.calls.length, 1);
  assert.deepEqual(db.calls[0].params[0].sort(), ['greenhouse_4723320006', 'workable_6756FD5D61']);
});

test('no live ATS row, no twin: a feed row is the only copy and stays', async () => {
  const db = fakeDb([]);
  assert.equal((await findFeedTwins([APPLOVIN_FEED], db.query)).size, 0);
});

test('a per-board id on ANOTHER board is not a twin', async () => {
  const other = { id: 1, ats: 'bamboohr', external_id: 'bamboohr_77', url: 'https://othercorp.bamboohr.com/careers/77' };
  const feed = { id: 2, ats: 'bamboohr', external_id: 'feedhash', url: 'https://acme.bamboohr.com/careers/77' };
  assert.equal((await findFeedTwins([feed], fakeDb([other]).query)).size, 0);
});

test('nothing recognisable costs no query', async () => {
  const db = fakeDb([]);
  await findFeedTwins([APPLOVIN_ATS, { id: 3, ats: 'workday', external_id: 'x', url: 'https://x.wd1.myworkdayjobs.com/a' }], db.query);
  assert.equal(db.calls.length, 0);
});

test('the Meili sync deletes a dirty feed twin from the index instead of indexing it', async () => {
  const added = [], deleted = [];
  const db = fakeDb([APPLOVIN_ATS]);
  const dirty = [{ ...APPLOVIN_FEED, removed_at: null, dirty_txt: '2026-10-28 21:00:00' }, { ...APPLOVIN_ATS, removed_at: null, dirty_txt: '2026-10-28 21:00:01' }];
  const query = async (sql, params) => {
    if (/WHERE j\.index_dirty_at IS NOT NULL/.test(sql)) return { rows: dirty };
    if (/UPDATE jobs SET index_dirty_at = NULL/.test(sql)) return { rowCount: params[0].length };
    if (/FROM companies/.test(sql)) return { rows: [] };
    return db.query(sql, params);
  };
  const conn = path.resolve(__dirname, '../src/db/connection.js');
  const meili = path.resolve(__dirname, '../src/utils/meili.js');
  const sync = path.resolve(__dirname, '../src/tasks/meili-sync.js');
  const saved = [conn, meili, sync].map((k) => require.cache[k]);
  require.cache[conn] = { id: conn, filename: conn, loaded: true, exports: { query } };
  require.cache[meili] = { id: meili, filename: meili, loaded: true, exports: {
    enabled: true, health: async () => ({ ok: true }), toDocument: (r) => ({ id: r.id }),
    addDocuments: async (docs) => added.push(...docs.map((d) => d.id)), deleteDocuments: async (ids) => deleted.push(...ids) } };
  delete require.cache[sync];
  try {
    const { syncMeili } = require(sync);
    const out = await syncMeili();
    assert.deepEqual(added, [766180088], 'the ATS row is indexed');
    assert.deepEqual(deleted, [927294059], 'the twin leaves the index');
    assert.equal(out.feedTwins, 1);
  } finally {
    [conn, meili, sync].forEach((k, i) => { if (saved[i]) require.cache[k] = saved[i]; else delete require.cache[k]; });
  }
});

test('the demand crawler does not store a twin of a live ATS row', async () => {
  const sqls = [];
  const db = fakeDb([APPLOVIN_ATS]);
  const query = async (sql, params) => { sqls.push(sql); return db.query(sql, params); };
  const conn = path.resolve(__dirname, '../src/db/connection.js');
  const crawl = path.resolve(__dirname, '../src/tasks/demand-crawl.js');
  const saved = [conn, crawl].map((k) => require.cache[k]);
  require.cache[conn] = { id: conn, filename: conn, loaded: true, exports: { query, closeDb: async () => {} } };
  delete require.cache[crawl];
  try {
    const { upsertNormalized } = require(crawl);
    const added = await upsertNormalized({
      externalId: 'lmcv-123', source: 'liftmycv', atsHint: 'greenhouse', company: 'AppLovin',
      applyUrl: 'https://job-boards.greenhouse.io/applovin', jobUrl: APPLOVIN_FEED.url,
      title: 'Business Operations Analyst', location: 'Palo Alto, CA, Toronto',
    });
    assert.equal(added, 0);
    assert.equal(db.calls.length, 1, 'the twin lookup ran (the job was not dropped for another reason)');
    assert.equal(sqls.filter((s) => /INSERT INTO (jobs|companies)/.test(s)).length, 0, 'nothing written');
  } finally {
    [conn, crawl].forEach((k, i) => { if (saved[i]) require.cache[k] = saved[i]; else delete require.cache[k]; });
  }
});
