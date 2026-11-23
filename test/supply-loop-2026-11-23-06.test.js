'use strict';
// FastApply supply loop, 2026-11-23 06h: a Breezy page with no JSON-LD kept only its 300-character
// og:description, and two perks were stored as salaries.
const { test } = require('node:test');
const assert = require('node:assert');
const { breezyPageDescription } = require('../src/adapters/breezy');
const { extractSalary } = require('../src/utils/extract');

// Committee for Children's "Senior Revenue Operations Manager", cut to its shape: no JSON-LD, the
// text in <div class="description"> with nested markup, the remote states near the end.
const page = [
  '<html><head><meta property="og:description" content="Are you looking for purpose-driven work where you can make a positive impact">',
  '</head><body><div class="container"><ul class="links"></ul></div>',
  '<div class="description"><p><span>Are you looking for purpose-driven work where you can make a positive impact on communities around the world? If so, then Committee for Children is an amazing place to grow your career as a Revenue Operations Manager.</span></p>',
  '<div class="inner"><ul><li>Note: This position is remote; employees are eligible to work remotely in any of the following states: AZ, CA, CO, CT, FL, GA, IL, MA, NJ, NM, NY, OH, OR, PA, TX, VA, WA.</li></ul></div>',
  '<p>The annual base pay hiring range for this position is $140,000-$165,000.</p></div>',
  '<div class="apply"><a>Apply to this job</a></div></body></html>',
].join('');

test('the page description is read whole, nested blocks kept, the page after it left out', () => {
  const d = breezyPageDescription(page);
  assert.ok(d, 'read');
  assert.match(d, /eligible to work remotely in any of the following states: .*TX/);
  assert.match(d, /\$140,000-\$165,000/);
  assert.doesNotMatch(d, /Apply to this job/);
});

test('no description block, or one too short to be a posting, reads nothing', () => {
  assert.strictEqual(breezyPageDescription('<html><body><p>Position Closed</p></body></html>'), null);
  assert.strictEqual(breezyPageDescription('<div class="description"><p>Short.</p></div>'), null);
  assert.strictEqual(breezyPageDescription(''), null);
});

test('a figure given towards something is not the salary', () => {
  assert.strictEqual(
    extractSalary(
      '<ul><li>Award-winning learning and development, with personalised support throughout your career</li><li>Up to £500 per year towards your own personal development</li><li>A monthly book, e-book or audiobook</li></ul>'
    ),
    null
  );
  assert.strictEqual(extractSalary('We give $2,000 a year toward courses and books.'), null);
});

test('an allowance right before the figure is not the salary, after a pay word', () => {
  assert.strictEqual(
    extractSalary(
      'Why Join LPR? • Competitive salary, bonus scheme, and company car or car allowance (up to £550 per month) • 25 days annual leave plus bank holidays'
    ),
    null
  );
});

test('pay stays pay', () => {
  for (const [text, min, max] of [
    ['Salary range: £45,000 - £50,000, plus a car allowance.', '45000', '50000'],
    ['Base pay (excluding bonus): $100,000 - $120,000 per year.', '100000', '120000'],
    ['Competitive salary of £55,000 per year, plus bonus.', '55000', '55000'],
    ['The salary is $90,000 - $110,000, with $5,000 towards relocation.', '90000', '110000'],
  ]) {
    const got = extractSalary(text);
    assert.deepStrictEqual([got?.min, got?.max], [min, max], text);
  }
});
