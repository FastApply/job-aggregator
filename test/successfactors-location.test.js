const test = require('node:test');
const assert = require('node:assert/strict');
const { locationFallback } = require('../src/adapters/successfactors');

test("the page's own Location line, on the same line or the next", () => {
  const html = '<div>Location: \n<span>\n\n\t\tUS, Virtual, NOAM\n\t\t</span></div><p>Shape what is next</p>';
  assert.equal(locationFallback(html, 'https://jobs.bcdtravel.com/job/Analyst/1/', 'Analyst'), 'US, Virtual, NOAM');
  assert.equal(locationFallback('<p>Location: Cork, IE</p>', 'https://x.co/job/1/', 'Analyst'), 'Cork, IE');
});

test('a sentence after "Location:" is not a location', () => {
  const html = '<p>Location: We are a distributed company. Our teams work across many countries and offices.</p>';
  assert.equal(locationFallback(html, 'https://x.co/job/1/', 'Analyst'), null);
});

test('the URL names the place in front of the title', () => {
  assert.equal(
    locationFallback(null, 'https://careers.ses.com/job/Bucharest-Analyst%2C-Group-Financial-Reporting/123/', 'Analyst, Group Financial Reporting'),
    'Bucharest',
  );
  assert.equal(
    locationFallback(null, 'https://careers.te.com/job/BANGALORE-ANALYST-II-ENTERPRISE-SYSTEMS/9/', 'ANALYST II ENTERPRISE SYSTEMS'),
    'BANGALORE',
  );
});

test('a URL that is only the title names no place', () => {
  assert.equal(locationFallback(null, 'https://careers.bhp.com/job/Analyst-Material-Planning/9/', 'Analyst Material Planning'), null);
});

