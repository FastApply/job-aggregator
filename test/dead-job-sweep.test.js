const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { readCandidates, resetSweepPosition } = require('../src/tasks/dead-job-check');

const OPTS = { limit: 5, tailDays: 30, recheckDays: 14, partitionMod: 1, partitionRemainder: 0 };
const row = (id, page) => ({ id, url: `https://x/${id}`, heap_page: String(page), missing_from_sync: false });

/** A database with `perWindow(start)` candidate rows in each window it is asked for. */
function fakeDb({ heapPages, perWindow }) {
  const windows = [];
  const query = async (sql, params) => {
    if (/pg_relation_size/.test(sql)) return { rows: [{ pages: String(heapPages) }] };
    const start = Number(params[1].match(/\((\d+),/)[1]);
    windows.push({ start, end: Number(params[2].match(/\((\d+),/)[1]), want: params[0], sql });
    const rows = Array.from({ length: perWindow(start) }, (_, i) => row(start * 1000 + i, start + i))
      .slice(0, params[0]);
    return { rows };
  };
  return { query, windows };
}

test.beforeEach(() => resetSweepPosition());

test('a sweep reads a page window, never the whole table', async () => {
  const db = fakeDb({ heapPages: 2276526, perWindow: () => 5 });
  const jobs = await readCandidates(db.query, { ...OPTS, startPage: 1200000 });
  assert.equal(jobs.length, 5);
  assert.deepEqual(db.windows.map((w) => [w.start, w.end]), [[1200000, 1204000]]);
  assert.match(db.windows[0].sql, /j\.ctid >= \$2::tid AND j\.ctid < \$3::tid/);
});

test('the next sweep carries on where the last stopped', async () => {
  const db = fakeDb({ heapPages: 100000, perWindow: () => 2 });
  await readCandidates(db.query, { ...OPTS, limit: 2, startPage: 500 });
  await readCandidates(db.query, { ...OPTS, limit: 2 });
  // The first window filled the limit on page 501, so that is where the second begins.
  assert.deepEqual(db.windows.map((w) => w.start), [500, 501]);
});

test('a window with too few rows moves on to the next until the limit is met', async () => {
  const db = fakeDb({ heapPages: 100000, perWindow: () => 2 });
  const jobs = await readCandidates(db.query, { ...OPTS, startPage: 0 });
  assert.equal(jobs.length, 5);
  assert.deepEqual(db.windows.map((w) => w.start), [0, 4000, 8000]);
  assert.deepEqual(db.windows.map((w) => w.want), [5, 3, 1]);
});

test('a stretch with nothing eligible costs at most the page budget', async () => {
  const db = fakeDb({ heapPages: 2276526, perWindow: () => 0 });
  const jobs = await readCandidates(db.query, { ...OPTS, startPage: 0 });
  assert.equal(jobs.length, 0);
  assert.equal(db.windows.length, 10); // 40,000 pages: 1.8% of this heap
});

test('wraps at the end of the table, and a small table is read once', async () => {
  const db = fakeDb({ heapPages: 6000, perWindow: () => 0 });
  await readCandidates(db.query, { ...OPTS, startPage: 4000 });
  assert.deepEqual(db.windows.map((w) => w.start), [4000, 0]);
});

test('an empty table reads nothing', async () => {
  const db = fakeDb({ heapPages: 0, perWindow: () => 0 });
  assert.deepEqual(await readCandidates(db.query, OPTS), []);
  assert.equal(db.windows.length, 0);
});

test('eligibility is unchanged: partition, recheck and tail are all still applied', async () => {
  const db = fakeDb({ heapPages: 8000, perWindow: () => 5 });
  await readCandidates(db.query, { ...OPTS, partitionMod: 2, partitionRemainder: 1, startPage: 0 });
  const { sql } = db.windows[0];
  assert.match(sql, /j\.id % 2 = 1/);
  assert.match(sql, /INTERVAL '14 days'/);
  assert.match(sql, /INTERVAL '30 days'/);
  assert.match(sql, /j\.removed_at IS NULL/);
});

test('the worker claims every id: no runner owns the odd half', () => {
  const src = fs.readFileSync(path.join(__dirname, '../scripts/render-worker.js'), 'utf8');
  assert.doesNotMatch(src, /pruneDeadJobs\(\{[^}]*partitionMod/);
});
