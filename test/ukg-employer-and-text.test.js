'use strict';
/**
 * UKG: the crawl names the employer and reads the text of new postings (2026-10-29). Before, every
 * UKG row reached FastApply as "Unknown Company" with no text. Page snippets are cut from live
 * posting pages read that day.
 */
process.env.UKG_GAP_MS = '0';
process.env.UKG_DETAIL_MAX = '2';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ukg = require('../src/adapters/ukg');

const SLUG = 'recruiting2.ultipro.com/MID1019MAOI/63247d04-6f6f-4b92-bfb1-1379e445d4c7';
const logo = (alt) =>
  `<img class="small-logo logo" src="/MID1019MAOI/JobBoard/x/Styles/GetLargeHeaderLogo?brandId=y" alt="${alt}" data-automation="navbar-small-logo" />`;
const posting = (alt, description) =>
  `<html><nav>${alt === null ? '<div id="new-nav-header"></div>' : logo(alt)}</nav><script>` +
  `var d = new US.Opportunity.CandidateOpportunityDetail(${JSON.stringify({ Id: 'x', Description: description })});</script></html>`;

test('ukg employer: the header logo names it; placeholders, browsers and the tenant do not', () => {
  assert.equal(ukg.employerFromPage(logo('Mid-America Overseas, Inc.'), 'MID1019MAOI'), 'Mid-America Overseas, Inc.');
  assert.equal(ukg.employerFromPage(logo('Mystic Lake &amp; Little Six Casino'), 'SHA1014SKOP'), 'Mystic Lake & Little Six Casino');
  assert.equal(ukg.employerFromPage(logo('Surgery Partners Brand'), 'SUR1004SRGY'), 'Surgery Partners');
  assert.equal(ukg.employerFromPage(logo('Default Brand'), 'SAV1005SAVAT'), null);
  assert.equal(ukg.employerFromPage(logo('Career Site Brand'), 'X'), null);
  assert.equal(ukg.employerFromPage(logo('Ready to Join Our Team?'), 'X'), null);
  assert.equal(ukg.employerFromPage(logo('Chrome Logo'), 'X'), null);
  assert.equal(ukg.employerFromPage(logo('MID1019MAOI'), 'MID1019MAOI'), null);
  // The modern layout draws its header by script: no name on the page.
  assert.equal(ukg.employerFromPage('<div slot="header" id="new-nav-header"></div>', 'UNI1108UNAY'), null);
});

/** A fake UKG: the search answers `ids` (newest first); each posting page answers `pages[id]`. */
function fakeUkg(ids, pages) {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    calls.push(String(url));
    if (String(url).endsWith('/JobBoardView/LoadSearchResults')) {
      const opportunities = ids.map((Id, i) => ({ Id, Title: `Role ${i}`, FullTime: true, PostedDate: '2026-10-29T10:00:00Z', Locations: [], JobLocationType: 1 }));
      return new Response(JSON.stringify({ opportunities, totalCount: ids.length }), { status: 200 });
    }
    const id = new URL(url).searchParams.get('opportunityId');
    return new Response(pages[id] ?? posting(null, null), { status: 200 });
  };
  return calls;
}
const pageCalls = (calls) => calls.filter((u) => u.includes('OpportunityDetail'));

test('ukg crawl: reads only new postings, newest first, up to the cap, and names the employer', async () => {
  const ids = ['a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000004'];
  const calls = fakeUkg(ids, {
    [ids[1]]: posting('Mid-America Overseas, Inc.', '<p>Requires 10 years.</p>'),
    [ids[2]]: posting('Mid-America Overseas, Inc.', '<p>Entry level.</p>'),
  });
  const { jobs, meta } = await ukg.fetchJobs(SLUG, { describedIds: new Set([`ukg_${ids[0]}`]), companyName: null });
  assert.equal(meta.companyName, 'Mid-America Overseas, Inc.');
  // ids[0] already has text; the cap (2) takes ids[1] and ids[2]; ids[3] waits for the next crawl.
  assert.deepEqual(pageCalls(calls).map((u) => new URL(u).searchParams.get('opportunityId')), [ids[1], ids[2]]);
  assert.equal(jobs[0].description, null);
  assert.equal(jobs[1].description, '<p>Requires 10 years.</p>');
  assert.equal(jobs[3].description, null);
});

test('ukg crawl: a named company with every posting read costs no page at all', async () => {
  const ids = ['b0000000-0000-0000-0000-000000000001'];
  const calls = fakeUkg(ids, {});
  const { meta } = await ukg.fetchJobs(SLUG, { describedIds: [`ukg_${ids[0]}`], companyName: 'Mid-America Overseas, Inc.' });
  assert.equal(pageCalls(calls).length, 0);
  assert.equal(meta.companyName, null); // nothing new to write
});

test('ukg crawl: an unnamed company with nothing new reads one page for the name, then not again for a day', async () => {
  const slug = 'recruiting2.ultipro.com/UNI1108UNAY/58a16832-7db2-47b4-aa7f-68266f035ef6';
  const ids = ['c0000000-0000-0000-0000-000000000001'];
  let calls = fakeUkg(ids, {}); // modern page: no logo
  let r = await ukg.fetchJobs(slug, { describedIds: [`ukg_${ids[0]}`], companyName: null });
  assert.equal(pageCalls(calls).length, 1);
  assert.equal(r.meta.companyName, null);
  calls = fakeUkg(ids, {});
  r = await ukg.fetchJobs(slug, { describedIds: [`ukg_${ids[0]}`], companyName: null });
  assert.equal(pageCalls(calls).length, 0);
});

test('ukg description backfill still reads the posting text', async () => {
  fakeUkg([], { d1: posting('X Corp', '<p>Text</p>') });
  const url = 'https://recruiting2.ultipro.com/MID1019MAOI/JobBoard/63247d04-6f6f-4b92-bfb1-1379e445d4c7/OpportunityDetail?opportunityId=d1';
  assert.equal(await ukg.fetchDescription(url), '<p>Text</p>');
  assert.deepEqual(await ukg.fetchPosting(url), { description: '<p>Text</p>', companyName: 'X Corp' });
});

test('the crawler hands UKG its stored state and fills a blank (or slug-only) company name', () => {
  const crawler = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'crawl-companies-local.js'), 'utf8');
  assert.equal(ukg.wantsStoredState, true);
  assert.match(crawler, /adapter\.wantsStoredState/);
  assert.match(crawler, /description IS NOT NULL/);
  assert.match(crawler, /RETURNING id, ats, ats_slug, career_url, error_message, company_name/);
  assert.match(crawler, /SET company_name = \?, index_dirty_at = NOW\(\).*WHERE id = \? AND \(company_name IS NULL OR company_name = '' OR company_name = ats_slug\)/);
});

// Real pages of both layouts, cut to the parts the reader looks at (read live 2026-10-29).
const PAGES = require('./fixtures/ukg-pages.json');

test('ukg employer, classic layout: the header logo names it', () => {
  assert.equal(ukg.employerFromPage(PAGES.COR1031CORC, 'COR1031CORC'), 'Corovan Corporation');
  assert.equal(ukg.employerFromPage(PAGES.MID1019MAOI, 'MID1019MAOI'), 'Mid-America Overseas, Inc.');
});

test('ukg employer, modern layout: no logo, so the board name in the title script names it', () => {
  // Header drawn by script; the browser title reads "Welder (MIG) - 1st Shift | UNITED ALLOY INC.".
  assert.match(PAGES.UNI1108UNAY, /new-nav-header/);
  assert.doesNotMatch(PAGES.UNI1108UNAY, /navbar-small-logo/);
  assert.equal(ukg.employerFromPage(PAGES.UNI1108UNAY, 'UNI1108UNAY'), 'UNITED ALLOY INC.');
  // "Default Brand" logo, board "CONTINUUM Applied Technology "; the text's "At CAMP Systems, we
  // are..." starts like the tenant (cam1010csii: CAMP Systems International) and wins.
  assert.equal(ukg.employerFromPage(PAGES.cam1010csii, 'cam1010csii'), 'CAMP Systems');
});

test('ukg employer: a generic board title and no logo fall back to the text, checked against the tenant alias', () => {
  // Board "Opportunities" + "Default Brand"; text: "Hastings Insurance is seeking ..." (HAS1004...).
  assert.equal(ukg.employerFromPage(PAGES.has1004hmic, 'has1004hmic'), 'Hastings Insurance');
  // Board "Careers", no logo; text: "... Candidates Structure Medical is seeking CNC Machinists".
  assert.equal(ukg.employerFromPage(PAGES.str1026strme, 'str1026strme'), 'Structure Medical');
  // A capitalised name that does not start like the tenant is never taken from the text.
  assert.equal(ukg.employerFromText('<p>Acme Corp is seeking a welder.</p>', 'STR1026STRME'), null);
  assert.equal(ukg.employerFromText('<p>Structure Medical is seeking a welder.</p>', 'STR1026STRME'), 'Structure Medical');
});

test('ukg employer: a logo slogan loses to a name that starts like the tenant', () => {
  // BUN1000BUNZL's logo alt is "Unlimited Potential"; its text names Bunzl.
  assert.match(PAGES.BUN1000BUNZL, /alt="Unlimited Potential"/);
  assert.equal(ukg.employerFromPage(PAGES.BUN1000BUNZL, 'BUN1000BUNZL'), 'Bunzl');
});

test('ukg employer: board titles lose their board words; a generic title is no name', () => {
  const page = (b) => `<script>var params = ${JSON.stringify({ opportunityTitle: 'X', jobBoardName: b })};</script>`;
  const cases = {
    'Corovan Careers': 'Corovan', 'Careers at Acme': 'Acme', 'Acme Corp - External': 'Acme Corp',
    'Fortegra Career Site': 'Fortegra', "Marvin's Building Materials Jobs": "Marvin's Building Materials",
    'Cleveland Museum of Art Job Openings': 'Cleveland Museum of Art', 'Pinnacle Home': 'Pinnacle Home',
    'Opportunities ': null, 'Employment Opportunities': null, 'Career Opportunities': null, Careers: null,
    'Job Board': null, 'Join Our Team': null, 'External Careers': null, ZZZ1000ZZZ: null,
  };
  for (const [board, want] of Object.entries(cases)) assert.equal(ukg.employerFromPage(page(board), 'ZZZ1000ZZZ'), want, board);
  // Logo text: "Farmers Logo 2022" is Farmers; an asset name or an entity-encoded name is read right.
  const logoPage = (alt) => `<img alt="${alt}" data-automation="navbar-small-logo" />`;
  assert.equal(ukg.employerFromPage(logoPage('Farmers Logo 2022'), 'FAR1008FNBC'), 'Farmers');
  assert.equal(ukg.employerFromPage(logoPage('MW_enterprise'), 'MEL1004MHTC'), null);
  assert.equal(ukg.employerFromPage(logoPage('Germain H&#xF4;tels'), 'GRO5006GRGEI'), 'Germain Hôtels');
});

test('ukg page read keeps a body the server never finishes sending', async () => {
  const html = posting('Corovan Corporation', '<p>Text</p>') + '</html>';
  global.fetch = async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream({
      start(c) { c.enqueue(enc.encode(html.slice(0, 50))); c.enqueue(enc.encode(html.slice(50))); /* never closes */ },
    });
    return new Response(body, { status: 200 });
  };
  const url = 'https://recruiting.ultipro.com/COR1031CORC/JobBoard/793e0120-ef20-4600-b246-c0be5cd3cb03/OpportunityDetail?opportunityId=f1';
  assert.deepEqual(await ukg.fetchPosting(url), { description: '<p>Text</p>', companyName: 'Corovan Corporation' });
});

test('ukg employer: "<X> Brand" names the employer only when X starts like the tenant', () => {
  const logoPage = (alt) => `<img alt="${alt}" data-automation="navbar-small-logo" />`;
  assert.equal(ukg.employerFromPage(logoPage('Surgery Partners Brand'), 'SUR1004SRGY'), 'Surgery Partners');
  assert.equal(ukg.employerFromPage(logoPage('Maryland Brand'), 'CHI1001CHIM'), null);
});

test('ukg employer: a heading run is not a name; the sentence that introduces the employer is', () => {
  // Live MEL1001MEL.
  const d = '<h2>Melaleuca Award Winning Culture Flexibility Growth Benefits</h2><p>At Melaleuca, our mission has remained constant.</p><p>Melaleuca Award Winning Culture Flexibility Growth is hiring.</p>';
  assert.equal(ukg.employerFromText(d, 'MEL1001MEL'), 'Melaleuca');
});

test('ukg employer: board words are cut only as whole words, and text overrides a logo only on a strong alias tie', () => {
  const logo = (alt) => `<img class="logo" alt="${alt}" data-automation="navbar-small-logo" />`;
  const page = (alt, description) => (alt === null ? '' : logo(alt)) +
    `<script>var d = new US.Opportunity.CandidateOpportunityDetail(${JSON.stringify({ Id: 'x', Description: description })});</script>`;
  // Names ending in a board word's letters keep them.
  for (const name of ['Hillebrand', 'Firebrand', 'Snagajob', 'Musical Compositions']) {
    assert.equal(ukg.employerFromPage(logo(name), 'XYZ1000XYZ'), name);
  }
  for (const alt of ['Acme Careers', 'Acme (US)', 'Acme - Job Board']) assert.equal(ukg.employerFromPage(logo(alt), 'XYZ1000XYZ'), 'Acme');
  // A heading or a three-letter coincidence in the text does not replace the logo.
  assert.equal(ukg.employerFromPage(page('Hartford Insurance', '<p>The Company is seeking a driver.</p>'), 'THE1000THEH'), 'Hartford Insurance');
  assert.equal(ukg.employerFromPage(page('Acme Health', '<p>Position Summary The Registered Nurse is a key member.</p>'), 'POS1000POSX'), 'Acme Health');
  assert.equal(ukg.employerFromPage(page(null, '<p>The Company is seeking a driver.</p>'), 'THE1000THEH'), null);
  // The alias spelling the name still lets the text win over a slogan logo, and fills a page with none.
  assert.equal(ukg.employerFromPage(page('Unlimited Potential', '<p>Bunzl is a leading distributor.</p>'), 'BUN1000BUNZL'), 'Bunzl');
  assert.equal(ukg.employerFromPage(page(null, '<p>Structure Medical is seeking a rep.</p>'), 'STR1026STRME'), 'Structure Medical');
});
