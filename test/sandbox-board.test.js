'use strict';
/**
 * FA-053 — the demo/sandbox board rule.
 *
 * The positive vectors are the six boards real candidates' applications went into. The negative
 * ones are the reason the rule is not a substring match: a real employer losing its jobs is a
 * cost too, so each shape that looks like a marker but is a real word is pinned here.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sandboxSlugRule, isSandboxSlug, boardFromUrl, sandboxMatch, isSandboxPosting,
} = require('../src/utils/sandbox-board');

const TICKET_BOARDS = [
  // [ats, slug as stored in companies.ats_slug, a posting URL on that board]
  ['bamboohr', 'ramonabrowndemo', 'https://ramonabrowndemo.bamboohr.com/careers/12'],
  ['smartrecruiters', 'RhaegalSandbox', 'https://jobs.smartrecruiters.com/RhaegalSandbox/743999-test-role'],
  ['greenhouse', 'builtinintegrationsandbox', 'https://job-boards.greenhouse.io/builtinintegrationsandbox/jobs/123'],
  ['greenhouse', 'examplecorpsandbox', 'https://boards.greenhouse.io/examplecorpsandbox/jobs/456'],
  ['jazzhr', 'weedmansandbox', 'https://weedmansandbox.applytojob.com/apply/AbC123/Role'],
  ['lever', 'leverdemo-8', 'https://jobs.lever.co/leverdemo-8/0a1b2c'],
];

test('every board from the ticket is caught by its slug', () => {
  for (const [ats, slug] of TICKET_BOARDS) {
    const m = sandboxMatch({ ats, slug });
    assert.ok(m, `${ats}/${slug} must be flagged`);
    assert.equal(m.via, 'slug');
  }
});

test('every board from the ticket is caught by its posting URL alone', () => {
  for (const [ats, slug, url] of TICKET_BOARDS) {
    const m = sandboxMatch({ url });
    assert.ok(m, `${url} must be flagged`);
    assert.equal(m.via, 'url');
    assert.equal(m.ats, ats);
    assert.equal(m.slug, slug);
  }
});

test('the rule that fired is reported, so a review can see why', () => {
  assert.equal(sandboxSlugRule('ramonabrowndemo'), 'suffix:demo');
  assert.equal(sandboxSlugRule('weedmansandbox'), 'suffix:sandbox');
  assert.equal(sandboxSlugRule('RhaegalSandbox'), 'suffix:sandbox', 'case is ignored');
  assert.equal(sandboxSlugRule('leverdemo-8'), 'suffix:demo', 'a trailing number does not hide the marker');
  assert.equal(sandboxSlugRule('acme-test'), 'word:test');
  assert.equal(sandboxSlugRule('demo'), 'word:demo');
  assert.equal(sandboxSlugRule('acme_sandbox_2'), 'word:sandbox');
});

test('real employers whose names contain a marker are not flagged', () => {
  const clean = [
    'sandboxvr',            // the Greenhouse board that made PR #144 refuse a pattern
    'democracynow',         // prefix only
    'demographix',
    'latest', 'contest', 'attest', 'fastest', 'protest',   // end in "test", never a marker
    'TestGorilla', 'testgorilla',       // "test" is only ever a delimited whole word
    'SandboxVR', 'DemoGraphics',        // a camelCase boundary is not a word break
    'gitlab', 'stripe', 'acme-robotics', 'lever', 'greenhouse',
  ];
  for (const slug of clean) assert.equal(sandboxSlugRule(slug), null, `${slug} must stay clean`);
});

test('empty and junk input never throws and never matches', () => {
  for (const v of [undefined, null, '', '   ', 0, {}]) assert.equal(sandboxSlugRule(v), null);
  assert.equal(sandboxMatch(), null);
  assert.equal(sandboxMatch({}), null);
  assert.equal(boardFromUrl('not a url'), null);
  assert.equal(boardFromUrl('javascript:alert(1)'), null);
  assert.equal(boardFromUrl(undefined), null);
});

test('the allow-list exempts a confirmed-real board and nothing else', () => {
  const allow = new Set(['acmedemo']);
  assert.equal(sandboxSlugRule('acmedemo', { allow }), null);
  assert.equal(sandboxSlugRule('Acme-Demo', { allow }), null, 'separators and case do not defeat the entry');
  assert.equal(sandboxSlugRule('otherdemo', { allow }), 'suffix:demo');
  assert.ok(sandboxMatch({ ats: 'lever', slug: 'acmedemo' }), 'acmedemo is not in the default allow-list');
  assert.equal(sandboxMatch({ ats: 'lever', slug: 'acmedemo' }, { allow }), null);
});

// FA-053 review, 2026-10-20: the one real employer the rule caught among 3,964 imported ones.
test('Kleen Test Products, a real employer, is allow-listed by default in every spelling and URL shape', () => {
  for (const slug of ['kleen-test-products', 'Kleen-Test-Products', 'kleen_test_products', 'kleentestproducts']) {
    assert.equal(sandboxSlugRule(slug), null, `${slug} must not be flagged`);
    assert.equal(sandboxMatch({ ats: 'workable', slug }), null, `workable/${slug} must not be flagged`);
  }
  for (const url of [
    'https://apply.workable.com/kleen-test-products',
    'https://apply.workable.com/kleen-test-products/j/ABC123/',
    'https://kleen-test-products.recruitee.com/o/operator',
  ]) {
    assert.equal(sandboxMatch({ url }), null, `${url} must not be flagged`);
  }
});

test('allow-listing Kleen does not loosen the "test" rule for any other board', () => {
  assert.equal(sandboxSlugRule('acme-test'), 'word:test');
  assert.equal(sandboxSlugRule('kleen-test'), 'word:test', 'a similar name is not exempt');
  assert.ok(sandboxSlugRule('kleen-test-products-demo'), 'nor is a longer one');
  assert.ok(sandboxMatch({ ats: 'workable', slug: 'kleen-test' }));
});

test('boardFromUrl reads the tenant from each vendor shape', () => {
  const cases = [
    ['https://boards.greenhouse.io/gitlab/jobs/1', 'greenhouse', 'gitlab'],
    ['https://job-boards.eu.greenhouse.io/acme/jobs/1', 'greenhouse', 'acme'],
    ['https://boards.greenhouse.io/embed/job_app?for=acme&token=9', 'greenhouse', 'acme'],
    ['https://jobs.eu.lever.co/acme/abc', 'lever', 'acme'],
    ['https://jobs.ashbyhq.com/acme/abc', 'ashby', 'acme'],
    ['https://apply.workable.com/acme/j/ABC123/', 'workable', 'acme'],
    ['https://acme.workable.com/jobs/1', 'workable', 'acme'],
    ['https://acme.recruitee.com/o/role', 'recruitee', 'acme'],
    ['https://acme.breezy.hr/p/abc-role', 'breezy', 'acme'],
    ['https://acme.teamtailor.com/jobs/1', 'teamtailor', 'acme'],
    ['https://acme.jobs.personio.de/job/1', 'personio', 'acme'],
    ['https://ats.rippling.com/acme/jobs/1', 'rippling', 'acme'],
    ['https://jobs.jobvite.com/acme/job/oX1', 'jobvite', 'acme'],
    ['https://www.comeet.com/jobs/acme/12.345', 'comeet', 'acme'],
    ['https://acme.wd5.myworkdayjobs.com/Careers/job/x', 'workday', 'acme'],
  ];
  for (const [url, ats, slug] of cases) assert.deepEqual(boardFromUrl(url), { ats, slug }, url);
});

test('boardFromUrl does not invent a tenant from a route or an employer domain', () => {
  for (const url of [
    'https://www.bamboohr.com/careers',            // the vendor's own site
    'https://jobs.lever.co/',                      // no path
    'https://boards.greenhouse.io/embed/job_app',  // embed with no board
    'https://apply.workable.com/j/ABC123',         // short link has no tenant
    'https://careers.demo-corp.com/jobs/1',        // employer's own domain: name says nothing about ATS
    'https://example.com/sandbox/jobs/1',
  ]) assert.equal(boardFromUrl(url), null, url);
});

test('a feed company is judged by the posting URL, never by its slug', () => {
  // Simplify files jobs under ats='simplify' with its own slug for the employer. A real
  // employer called "Demo Day Capital" must not be flagged for that.
  assert.equal(sandboxMatch({ ats: 'simplify', slug: 'demo-day-capital', url: 'https://boards.greenhouse.io/demoday/jobs/1' }), null,
    'board "demoday" is not a marker (only a whole word or a suffix is)');
  // ...but when the URL is on a sandbox board, the feed's job is caught.
  const m = sandboxMatch({ ats: 'simplify', slug: 'whatever', url: 'https://weedmansandbox.applytojob.com/apply/x/y' });
  assert.deepEqual({ ats: m.ats, slug: m.slug, via: m.via }, { ats: 'jazzhr', slug: 'weedmansandbox', via: 'url' });
});

test('a direct employer is not judged by its shard slug', () => {
  assert.equal(sandboxMatch({ ats: 'google', slug: 'demo-shard-1' }), null);
  assert.equal(sandboxMatch({ ats: 'amazon', slug: 'test' }), null);
});

test('vendor aliases are folded before the ATS is judged', () => {
  assert.ok(sandboxMatch({ ats: 'grnhse', slug: 'examplecorpsandbox' }));
});

test('career_url is checked too, and reported as such', () => {
  const m = sandboxMatch({ ats: 'simplify', slug: 'x', careerUrl: 'https://ramonabrowndemo.bamboohr.com/careers' });
  assert.equal(m.via, 'career_url');
  assert.equal(m.slug, 'ramonabrowndemo');
});

test('isSandboxPosting / isSandboxSlug agree with sandboxMatch / sandboxSlugRule', () => {
  assert.equal(isSandboxSlug('weedmansandbox'), true);
  assert.equal(isSandboxSlug('gitlab'), false);
  assert.equal(isSandboxPosting({ ats: 'lever', slug: 'leverdemo-8' }), true);
  assert.equal(isSandboxPosting({ ats: 'lever', slug: 'netflix' }), false);
});

test('Rippling demo tenants are one family, whatever their uuid', () => {
  assert.equal(sandboxSlugRule('dunder-mifflin0e41a933-d8b8-4f29-856e-fd54380549e3'), 'family:rippling-demo');
  assert.equal(sandboxSlugRule('Dunder-Mifflin50317daf-bf46-4119-a983-c418321babdc64b6d522e654ea8f9c154f84'), 'family:rippling-demo');
  assert.equal(sandboxSlugRule('dunder-mifflin-paper'), null);
});

test('a demo tenant read by hand is a sandbox; a real name starting with demo is not', () => {
  assert.equal(sandboxSlugRule('demorecruiting'), 'known:demo');
  assert.equal(sandboxSlugRule('demodesk-gmbh'), null);
});

test('Teamtailor sandboxes minted with an epoch are one family; a name starting "sandbox" is not', () => {
  assert.equal(sandboxSlugRule('sandboxnytlaegejob-1732104705'), 'family:teamtailor-demo');
  assert.equal(sandboxSlugRule('sandboxsaurtestjtmo-1743074489'), 'family:teamtailor-demo');
  assert.equal(sandboxSlugRule('sandboxinteractive'), null);
  assert.equal(sandboxSlugRule('sandboxvr'), null);
});

test('the worker refuses the same hand-read tenants as main', () => {
  assert.equal(sandboxSlugRule('cmsprep'), 'known:demo');
  assert.equal(sandboxSlugRule('demorecruiting'), 'known:demo');
});
