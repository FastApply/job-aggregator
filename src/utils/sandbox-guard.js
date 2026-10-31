'use strict';
/**
 * FA-053 — keeping ATS demo/sandbox boards out of the job board.
 *
 * sandbox-board.js decides WHAT is a sandbox; this module decides what to DO about it, and is the
 * one thing every ingest path calls. The behaviour is set by SANDBOX_REJECT:
 *
 *   enforce (default)  matching boards and postings are not ingested
 *   log                matches are logged and counted, nothing is rejected
 *   off                the guard does nothing (emergency switch if a real employer is caught)
 *
 * Unset means enforce. A value nobody recognises ALSO means enforce: a typo must never be the way
 * protection gets switched off.
 *
 * Two kinds of check, because the evidence is in different places:
 *   judgePosting  one board or one posting. Used before a crawl (is this whole board a sandbox?)
 *                 and by the direct-insert paths.
 *   filterPostings a batch of postings from one company. The company is judged by its slug and
 *                 career_url, each posting by its own URL — a third-party feed files jobs under its
 *                 own namespace, so the URL is the only thing that names the real board.
 *
 * Reporting is deliberately loud and cheap: every rejection bumps a counter, and each board is
 * logged once per process so a 200-posting sandbox does not write 200 lines every sync.
 */
const defaultLogger = require('../logger');
const defaultMetrics = require('./metrics');
const { sandboxMatch } = require('./sandbox-board');

const MODES = new Set(['off', 'log', 'enforce']);
const reported = new Set();

function sandboxMode(env = process.env, logger = defaultLogger) {
  const raw = String(env.SANDBOX_REJECT ?? '').trim().toLowerCase();
  if (!raw) return 'enforce';
  if (MODES.has(raw)) return raw;
  const key = `bad-mode:${raw}`;
  if (!reported.has(key)) {
    reported.add(key);
    logger.warn({ value: raw }, 'SANDBOX_REJECT is not one of off|log|enforce; treating it as enforce');
  }
  return 'enforce';
}

function report(match, { mode, source, sampleUrl, count = 1 }, { logger, metrics }) {
  const verb = mode === 'enforce' ? 'rejected' : 'flagged';
  metrics.increment(`sandbox.${verb}.${match.ats}`, count);
  const key = `${verb}:${match.ats}:${String(match.slug).toLowerCase()}`;
  if (reported.has(key)) return;
  reported.add(key);
  logger.warn(
    { ats: match.ats, slug: match.slug, rule: match.rule, via: match.via, mode, source, sampleUrl },
    mode === 'enforce' ? 'Sandbox board rejected' : 'Sandbox board flagged (SANDBOX_REJECT=log, not rejected)'
  );
}

function deps(opts) {
  return {
    env: opts.env || process.env,
    // sandboxMatch takes its options as { allow }; undefined keeps the module's own ALLOWED_BOARDS.
    matchOpts: opts.allow ? { allow: opts.allow } : undefined,
    logger: opts.logger || defaultLogger,
    metrics: opts.metrics || defaultMetrics,
  };
}

/**
 * Judge one board or one posting: { ats, slug, careerUrl, url }.
 * @returns {{match: object|null, reject: boolean, mode: string}}
 */
function judgePosting(posting, opts = {}) {
  const d = deps(opts);
  const mode = sandboxMode(d.env, d.logger);
  if (mode === 'off') return { match: null, reject: false, mode };
  const match = sandboxMatch(posting, d.matchOpts);
  if (!match) return { match: null, reject: false, mode };
  report(match, { mode, source: opts.source, sampleUrl: posting.url || posting.careerUrl }, d);
  return { match, reject: mode === 'enforce', mode };
}

/**
 * Split one company's incoming postings into those to keep and those to reject.
 * `board` is the company: { ats, slug, careerUrl }. In log/off mode nothing is rejected.
 * @returns {{kept: object[], rejected: Array<{job: object, match: object}>, mode: string}}
 */
function filterPostings(jobs, board = {}, opts = {}) {
  const d = deps(opts);
  const mode = sandboxMode(d.env, d.logger);
  const list = Array.isArray(jobs) ? jobs : [];
  if (mode === 'off' || !list.length) return { kept: list, rejected: [], mode };

  const kept = [];
  const rejected = [];
  const perBoard = new Map();
  for (const job of list) {
    const match = sandboxMatch({ ats: board.ats, slug: board.slug, careerUrl: board.careerUrl, url: job && job.url }, d.matchOpts);
    if (!match) { kept.push(job); continue; }
    const key = `${match.ats}:${String(match.slug).toLowerCase()}`;
    const seen = perBoard.get(key);
    if (seen) seen.count += 1; else perBoard.set(key, { match, count: 1, sampleUrl: job && job.url });
    if (mode === 'enforce') rejected.push({ job, match }); else kept.push(job);
  }
  for (const { match, count, sampleUrl } of perBoard.values()) {
    report(match, { mode, source: opts.source, sampleUrl, count }, d);
  }
  return { kept, rejected, mode };
}

/** Test hook: forget which boards this process has already logged. */
function _resetReported() { reported.clear(); }

module.exports = { sandboxMode, judgePosting, filterPostings, _resetReported, MODES };
