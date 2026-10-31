'use strict';
/**
 * Demo / sandbox ATS boards (FA-053).
 *
 * Every ATS vendor runs demo tenants for its own sales and QA. Their postings look like any other
 * posting, carry fake employers, and accept a real candidate's name, contact details and resume.
 * Between 13 and 25 September 2026 ten apply attempts went into six of them (BambooHR
 * `ramonabrowndemo`, SmartRecruiters `RhaegalSandbox`, Greenhouse `builtinintegrationsandbox` and
 * `examplecorpsandbox`, JazzHR `weedmansandbox`, Lever `leverdemo-8`).
 *
 * The one rule that catches all six is about the board's NAME, so this module is that rule and
 * nothing else. It has no database or network access: the ingest paths, the check script
 * (scripts/check-sandbox-postings.js) and the test vectors all call the same functions.
 *
 * What counts as a marker, and why each shape is what it is:
 *   sandbox, demo  as a whole delimiter-separated word (`demo`, `acme-sandbox`, `acme_demo_2`) or
 *                  glued to the END of a word (`ramonabrowndemo`, `weedmansandbox`, `RhaegalSandbox`,
 *                  `leverdemo-8`). Case is ignored, and a camelCase boundary is NOT a word break:
 *                  `SandboxVR` and `DemoGraphics` are real names, not markers.
 *   test           as a whole delimiter-separated word only (`acme-test`). Never as a suffix:
 *                  `latest`, `contest`, `attest` and `TestGorilla` are real.
 *   NOT a prefix   `sandboxvr` is a real employer (Greenhouse board `sandboxvr`) and `democracynow`
 *                  is not a demo. A prefix is never enough.
 *
 * A name rule will have false positives, which cost a real employer its jobs. That is what
 * ALLOWED_BOARDS is for: run `check-sandbox-postings.js --list-matches` over the companies table,
 * read every line, and add the confirmed-real boards there with a note. A board that is only
 * "probably real" stays blocked.
 *
 * What a name rule cannot do is find a sandbox board whose name does not say so. Those need to be
 * added by hand once someone has looked at the board.
 */

const { SUPPORTED_ATS, normalizeAts } = require('./supported-ats');

// Markers that may be a whole word or the end of one, and markers that may only be a whole word.
const WHOLE_OR_SUFFIX = ['sandbox', 'demo'];
const WHOLE_DELIMITED_ONLY = ['test'];

/**
 * Boards confirmed to be real employers despite matching. Key = the slug lower-cased with every
 * non-alphanumeric removed, so `Acme-Demo`, `acme_demo` and `acmedemo` are one entry. Each entry
 * needs a comment saying who looked and when. Keep it in step with ALLOWED_BOARDS in
 * fastapply-backend/src/modules/automations/sandbox-job-board.util.ts.
 */
const ALLOWED_BOARDS = new Set([
  // workable/kleen-test-products: "Kleen Test Products", a real employer. Found 2026-10-20 (FA-053
  // review) by running the rule over the 3,964 employers in scripts/import-ats-companies.sql and
  // the other two import files: it was the only one flagged, by the whole-word `test` rule.
  'kleentestproducts',
]);

// A family of demo tenants a name rule cannot see: Rippling mints one per customer account, each
// `dunder-mifflin<uuid>`, with a body left at its template ("Describe the role and team the
// candidate will be joining"). 34 submissions by 18 candidates into ten such boards, read
// 2026-10-31. Keep it in step with KNOWN_SANDBOX_BOARD_FAMILIES in
// fastapply-backend/src/modules/automations/sandbox-job-board.util.ts.
const SANDBOX_FAMILIES = [/^dunder-mifflin[0-9a-f]{8}-/i];

// Direct-employer adapters: ats_slug is a shard selector, not a tenant id, so the name says
// nothing about the board. Their URLs are checked, their slugs are not.
const SHARD_SLUG_ATS = new Set(['amazon', 'netflix', 'google']);

const compact = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const stripDigits = (t) => t.replace(/\d+$/, '');

/**
 * @returns {string|null} the rule that matched ('suffix:demo', 'word:sandbox', 'word:test'),
 *   or null when the name is clean or allow-listed.
 */
function sandboxSlugRule(slug, { allow = ALLOWED_BOARDS } = {}) {
  const raw = String(slug || '').trim();
  if (!raw) return null;
  if (allow.has(compact(raw))) return null;
  if (SANDBOX_FAMILIES.some((re) => re.test(raw))) return 'family:rippling-demo';

  // Words are split on anything that is not a letter or digit and lower-cased, with a trailing
  // number dropped: `leverdemo-8` -> [leverdemo], `RhaegalSandbox` -> [rhaegalsandbox].
  const words = raw.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(stripDigits);

  for (const word of words) {
    for (const marker of WHOLE_OR_SUFFIX) {
      if (word === marker) return `word:${marker}`;
      if (word.endsWith(marker)) return `suffix:${marker}`;
    }
    for (const marker of WHOLE_DELIMITED_ONLY) {
      if (word === marker) return `word:${marker}`;
    }
  }
  return null;
}

const isSandboxSlug = (slug, opts) => sandboxSlugRule(slug, opts) !== null;

// First label of the host is the tenant on these (`ramonabrowndemo.bamboohr.com`).
const SUBDOMAIN_TENANT = [
  ['bamboohr', /(^|\.)bamboohr\.com$/],
  ['jazzhr', /(^|\.)applytojob\.com$/],
  ['recruitee', /(^|\.)recruitee\.com$/],
  ['breezy', /(^|\.)breezy\.hr$/],
  ['teamtailor', /(^|\.)teamtailor\.com$/],
  ['pinpoint', /(^|\.)pinpointhq\.com$/],
  ['zoho', /(^|\.)zohorecruit\.(com|eu|in)$/],
  ['personio', /(^|\.)jobs\.personio\.(de|com)$/],
  ['workable', /(^|\.)workable\.com$/],
  ['workday', /(^|\.)myworkdayjobs\.com$/],
  ['icims', /(^|\.)icims\.com$/],
  ['taleo', /(^|\.)taleo\.net$/],
];
// Host labels that are the vendor's own, never a tenant.
const VENDOR_LABELS = new Set(['www', 'jobs', 'careers', 'apply', 'app', 'api', 'ats', 'boards', 'hire', 'recruiting']);

// First path segment is the tenant on these (`jobs.lever.co/leverdemo-8/<id>`).
const PATH_TENANT = [
  ['greenhouse', /(^|\.)greenhouse\.io$/],
  ['lever', /(^|\.)lever\.co$/],
  ['ashby', /^jobs\.ashbyhq\.com$/],
  ['smartrecruiters', /(^|\.)smartrecruiters\.com$/],
  ['workable', /^apply\.workable\.com$/],
  ['rippling', /^ats\.rippling\.com$/],
  ['jobvite', /^jobs\.jobvite\.com$/],
];
// Path words that are routes of the vendor's site, not a tenant.
const ROUTE_WORDS = new Set(['embed', 'api', 'j', 'o', 'v1', 'jobs', 'job', 'apply']);

/**
 * The ATS board a hosted posting/apply URL belongs to, or null when the URL is not on a vendor
 * host we can read a tenant from (an employer's own domain, a vendor with no tenant in the URL).
 * @returns {{ats: string, slug: string}|null}
 */
function boardFromUrl(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl || '').trim()); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);

  for (const [ats, re] of SUBDOMAIN_TENANT) {
    if (!re.test(host)) continue;
    // `acme.jobs.personio.de` -> acme; `acme.bamboohr.com` -> acme. `apply.workable.com/<slug>`
    // is path-based and falls through to the next table.
    const label = host.split('.')[0];
    if (!VENDOR_LABELS.has(label)) return { ats, slug: label };
  }
  for (const [ats, re] of PATH_TENANT) {
    if (!re.test(host)) continue;
    // Greenhouse's embed form carries the board in the query: /embed/job_app?for=<slug>.
    if (ats === 'greenhouse' && parts[0] === 'embed') {
      const forBoard = url.searchParams.get('for');
      return forBoard ? { ats, slug: forBoard } : null;
    }
    if (parts[0] && !ROUTE_WORDS.has(parts[0].toLowerCase())) return { ats, slug: parts[0] };
  }
  // Comeet puts the tenant second: www.comeet.com/jobs/<slug>/<id>.
  if (/(^|\.)comeet\.(com|co)$/.test(host) && parts[0] === 'jobs' && parts[1]) return { ats: 'comeet', slug: parts[1] };
  return null;
}

/**
 * Is this posting on a demo/sandbox board? Looks at every place the board's name can show up:
 * the company's own (ats, ats_slug), its career_url, and the posting URL. The URL matters because
 * third-party feeds (Simplify, Resumly, ...) file their jobs under the FEED's namespace
 * (`ats = 'simplify'`) with an arbitrary slug, and only the URL says which board it really is.
 *
 * @param {{ats?: string, slug?: string, careerUrl?: string, url?: string}} posting
 * @returns {{ats: string, slug: string, via: 'slug'|'career_url'|'url', rule: string}|null}
 */
function sandboxMatch({ ats, slug, careerUrl, url } = {}, opts) {
  const kind = normalizeAts(ats);
  // A real vendor's slug IS the board name. A feed's slug (`simplify`) or a direct employer's
  // shard is not, so a name rule on it would flag real employers.
  if (slug && SUPPORTED_ATS.has(kind) && !SHARD_SLUG_ATS.has(kind)) {
    const rule = sandboxSlugRule(slug, opts);
    if (rule) return { ats: kind, slug: String(slug), via: 'slug', rule };
  }
  for (const [via, u] of [['career_url', careerUrl], ['url', url]]) {
    const board = boardFromUrl(u);
    if (!board) continue;
    const rule = sandboxSlugRule(board.slug, opts);
    if (rule) return { ats: board.ats, slug: board.slug, via, rule };
  }
  return null;
}

const isSandboxPosting = (posting, opts) => sandboxMatch(posting, opts) !== null;

module.exports = {
  sandboxSlugRule, isSandboxSlug, boardFromUrl, sandboxMatch, isSandboxPosting,
  ALLOWED_BOARDS, WHOLE_OR_SUFFIX, WHOLE_DELIMITED_ONLY,
};
