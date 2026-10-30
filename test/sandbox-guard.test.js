'use strict';
/**
 * FA-053 — what the guard does about a sandbox board. The decisions about WHAT is a sandbox are
 * pinned in sandbox-board.test.js; this file is about the three modes, the fail-safe default, and
 * the reporting every ingest path relies on.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { sandboxMode, judgePosting, filterPostings, _resetReported } = require('../src/utils/sandbox-guard');

function sinks() {
  const warnings = [];
  const counts = {};
  return {
    warnings,
    counts,
    logger: { warn: (obj, msg) => warnings.push({ obj, msg }) },
    metrics: { increment: (key, n = 1) => { counts[key] = (counts[key] || 0) + n; } },
  };
}
const withMode = (SANDBOX_REJECT) => ({ env: SANDBOX_REJECT === undefined ? {} : { SANDBOX_REJECT } });

test.beforeEach(() => _resetReported());

test('unset means enforce', () => {
  assert.equal(sandboxMode({}), 'enforce');
  assert.equal(sandboxMode({ SANDBOX_REJECT: '' }), 'enforce');
  assert.equal(sandboxMode({ SANDBOX_REJECT: '   ' }), 'enforce');
});

test('off, log and enforce are read case-insensitively', () => {
  assert.equal(sandboxMode({ SANDBOX_REJECT: 'off' }), 'off');
  assert.equal(sandboxMode({ SANDBOX_REJECT: ' LOG ' }), 'log');
  assert.equal(sandboxMode({ SANDBOX_REJECT: 'Enforce' }), 'enforce');
});

test('a value nobody recognises means enforce, and says so once', () => {
  const s = sinks();
  for (const v of ['0', 'false', 'disabled', 'of']) {
    assert.equal(sandboxMode({ SANDBOX_REJECT: v }, s.logger), 'enforce', `"${v}" must not switch protection off`);
  }
  sandboxMode({ SANDBOX_REJECT: 'of' }, s.logger);
  assert.equal(s.warnings.filter((w) => w.obj.value === 'of').length, 1, 'the same typo is reported once, not every call');
});

test('enforce rejects a sandbox board and counts it', () => {
  const s = sinks();
  const v = judgePosting({ ats: 'lever', slug: 'leverdemo-8' }, { ...withMode('enforce'), ...s, source: 'test' });
  assert.equal(v.reject, true);
  assert.equal(v.match.rule, 'suffix:demo');
  assert.equal(s.counts['sandbox.rejected.lever'], 1);
  assert.equal(s.warnings[0].msg, 'Sandbox board rejected');
});

test('log mode reports the match but rejects nothing', () => {
  const s = sinks();
  const v = judgePosting({ ats: 'lever', slug: 'leverdemo-8' }, { ...withMode('log'), ...s });
  assert.equal(v.reject, false);
  assert.ok(v.match, 'the match is still returned so a caller can log it');
  assert.equal(s.counts['sandbox.flagged.lever'], 1);
  assert.equal(s.counts['sandbox.rejected.lever'], undefined);
  assert.match(s.warnings[0].msg, /not rejected/);
});

test('off mode does nothing at all', () => {
  const s = sinks();
  const v = judgePosting({ ats: 'lever', slug: 'leverdemo-8' }, { ...withMode('off'), ...s });
  assert.deepEqual({ reject: v.reject, match: v.match }, { reject: false, match: null });
  assert.deepEqual(s.counts, {});
  assert.deepEqual(s.warnings, []);
});

test('a real employer is never touched, in any mode', () => {
  for (const mode of ['off', 'log', 'enforce']) {
    const s = sinks();
    for (const posting of [
      { ats: 'greenhouse', slug: 'sandboxvr', url: 'https://boards.greenhouse.io/sandboxvr/jobs/3' },
      { ats: 'smartrecruiters', slug: 'TestGorilla', url: 'https://jobs.smartrecruiters.com/TestGorilla/55-dev' },
      { ats: 'lever', slug: 'netflix', url: 'https://jobs.lever.co/netflix/0a1b2c' },
    ]) {
      assert.equal(judgePosting(posting, { ...withMode(mode), ...s }).reject, false, `${posting.slug} in ${mode}`);
    }
    assert.deepEqual(s.counts, {}, `nothing counted in ${mode}`);
  }
});

test('the allow-list lets a confirmed-real board through', () => {
  const s = sinks();
  const posting = { ats: 'lever', slug: 'acme-demo' };
  assert.equal(judgePosting(posting, { ...withMode('enforce'), ...s }).reject, true);
  assert.equal(judgePosting(posting, { ...withMode('enforce'), ...s, allow: new Set(['acmedemo']) }).reject, false);
});

test('a board is logged once per process however many postings it has', () => {
  const s = sinks();
  const jobs = Array.from({ length: 214 }, (_, i) => ({ external_id: `j${i}`, url: `https://boards.greenhouse.io/examplecorpsandbox/jobs/${i}` }));
  filterPostings(jobs, { ats: 'greenhouse', slug: 'examplecorpsandbox' }, { ...withMode('enforce'), ...s });
  filterPostings(jobs, { ats: 'greenhouse', slug: 'examplecorpsandbox' }, { ...withMode('enforce'), ...s });
  assert.equal(s.warnings.length, 1, 'one log line, not 428');
  assert.equal(s.counts['sandbox.rejected.greenhouse'], 428, 'but every posting is counted');
});

test('filterPostings: a sandbox company loses every posting, in enforce', () => {
  const s = sinks();
  const jobs = [{ url: 'https://ramonabrowndemo.bamboohr.com/careers/1' }, { url: 'https://ramonabrowndemo.bamboohr.com/careers/2' }];
  const r = filterPostings(jobs, { ats: 'bamboohr', slug: 'ramonabrowndemo' }, { ...withMode('enforce'), ...s });
  assert.equal(r.kept.length, 0);
  assert.equal(r.rejected.length, 2);
  assert.equal(r.rejected[0].match.rule, 'suffix:demo');
});

test('filterPostings: a feed company keeps its real jobs and loses only the sandbox ones', () => {
  const s = sinks();
  const jobs = [
    { id: 'a', url: 'https://boards.greenhouse.io/someemployer/jobs/9001' },
    { id: 'b', url: 'https://acme-demo.recruitee.com/o/qa-engineer' },
    { id: 'c', url: 'https://weedmansandbox.applytojob.com/apply/x/y' },
    { id: 'd', url: 'https://jobs.lever.co/netflix/0a1b2c' },
  ];
  const r = filterPostings(jobs, { ats: 'simplify', slug: 'a-feed-employer' }, { ...withMode('enforce'), ...s });
  assert.deepEqual(r.kept.map((j) => j.id), ['a', 'd']);
  assert.deepEqual(r.rejected.map((x) => x.job.id), ['b', 'c']);
  assert.equal(s.warnings.length, 2, 'each distinct board is reported');
});

test('filterPostings: log mode keeps everything but still counts', () => {
  const s = sinks();
  const jobs = [{ url: 'https://jobs.lever.co/leverdemo-8/1' }, { url: 'https://jobs.lever.co/leverdemo-8/2' }];
  const r = filterPostings(jobs, { ats: 'lever', slug: 'leverdemo-8' }, { ...withMode('log'), ...s });
  assert.equal(r.kept.length, 2);
  assert.equal(r.rejected.length, 0);
  assert.equal(s.counts['sandbox.flagged.lever'], 2);
});

test('filterPostings: off mode returns the same array untouched', () => {
  const jobs = [{ url: 'https://jobs.lever.co/leverdemo-8/1' }];
  const r = filterPostings(jobs, { ats: 'lever', slug: 'leverdemo-8' }, withMode('off'));
  assert.equal(r.kept, jobs);
});

test('filterPostings copes with empty and junk input', () => {
  for (const jobs of [[], undefined, null]) {
    const r = filterPostings(jobs, { ats: 'lever', slug: 'x' }, withMode('enforce'));
    assert.deepEqual([r.kept.length, r.rejected.length], [0, 0]);
  }
  const r = filterPostings([null, {}, { url: 'not a url' }], {}, withMode('enforce'));
  assert.equal(r.kept.length, 3, 'nothing to judge, nothing rejected');
});
