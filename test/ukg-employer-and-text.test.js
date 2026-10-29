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

test('the crawler hands UKG its stored state and fills a blank company name', () => {
  const crawler = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'crawl-companies-local.js'), 'utf8');
  assert.equal(ukg.wantsStoredState, true);
  assert.match(crawler, /adapter\.wantsStoredState/);
  assert.match(crawler, /description IS NOT NULL/);
  assert.match(crawler, /RETURNING id, ats, ats_slug, career_url, error_message, company_name/);
  assert.match(crawler, /SET company_name = \?, index_dirty_at = NOW\(\).*WHERE id = \? AND \(company_name IS NULL OR company_name = ''\)/);
});
