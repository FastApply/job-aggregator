const test = require('node:test');
const assert = require('node:assert');
const { extractWorkplaceType } = require('../src/utils/extract');
const { classifyRemote } = require('../src/utils/classify');
const { retagPartWeek } = require('../scripts/retag-part-week-remote');

// Supply loop 2026-11-22 00h. Each of these office jobs was stored remote, so it sat in remote-only
// searches (and Remote Worldwide ones, for the work-from-anywhere perk) and was refused there, while
// the city's own on-site searchers never saw it. Real postings, cut to the words that decided them.
const officeJobs = [
  // A work-from-anywhere perk, quoted or with its length after it.
  ['Customer Success Manager - Growth', 'Bengaluru, Karnataka, India', 'This is a full-time role based onsite in Bengaluru, 5 days a week. The freedom to ‘Work from Anywhere’ for 4 weeks in a year. Generous vacation policy.'],
  ['Manager, Data Strategy & Analytics, Retail', 'New York', 'One-time $200 New Hire Home Office Equipment Stipend. Annual Work From Anywhere 4 weeks per year. Kepler is a people first organization.'],
  ['Manager, Solution Consulting', 'Bengaluru, India', 'This builds upon our flexible work arrangements, including work from anywhere for up to 8 weeks per year, empowering employees to achieve a better work-life balance.'],
  ['Analyst', 'Hatfield, Hertfordshire, United Kingdom', "• Flexible Work: Enjoy 30 days of 'work from anywhere' policy for a balanced life. • Generous Leave: Begin with 25 days."],
  ['Senior Backend Engineer (m/w/d)', 'Berlin', 'What to expect from us 25 "Work from Anywhere" days per year 28 days annual leave'],
  ['Sales Director, Insurance - UK', 'London', 'Up to 3 months working outside of your country of employment over a rolling 12-month period with our ‘Work from Anywhere’ policy'],
  // "If this role is remote": a pay note about other jobs.
  ['Senior Software Engineer (Ruby/Rails), MVR', 'San Francisco, California, United States', 'If this role is remote, we have listed the top to the bottom of the possible range, but we will specify the target range for an exact location. At Checkr, we believe an in office work environment strengthens collaboration.'],
  // The posting says it is not worked from home.
  ['Recruiting Coordinator (Starbase)', 'Starbase, TX', 'Schedule onsite interviews. This role requires being onsite in Starbase, TX – remote work will not be considered.'],
  ['Prepress Coordinator', 'Fort Collins, CO', 'Note: This is a 100% On-site Position. There is no work from home provision.'],
  ['Office Manager (Mumbai)', 'Mumbai', 'This is a full-time, on-site role. No work from home'],
  ['Senior Accountant - Construction', 'Phoenix, AZ', 'This position does not offer a Work from Home option.'],
  ['Office Administrator - Full Time', 'Orlando, FL, US', 'This is not a work from home position. The ideal candidate is a self-starter.'],
  ['Endpoint Engineer', 'Franklin, Tennessee, United States', '5iron does not use a Virtual SOC in which Security Analysts work from home or another remote location which can slow response times.'],
  ['Wholesale Support Coordinator', 'Bracknell', 'Whilst there is no contractual right to work from home, the flexibility we offer is that you can request to work from home 2 days per week.'],
];

test('perks, pay notes and "not worked from home" keep an office job out of remote', () => {
  for (const [t, l, d] of officeJobs) {
    const wt = extractWorkplaceType(t, l, d);
    assert.notStrictEqual(wt, 'remote', t);
    assert.strictEqual(classifyRemote(t, l, wt, d), false, t);
  }
});

test('remote jobs saying the same words in other ways stay remote', () => {
  const remote = [
    ['Senior Engineer', 'United States', 'We work from anywhere. This is a fully remote role.'],
    ['Account Executive', 'Remote', 'Work from anywhere in the US. 4 weeks of paid vacation.'],
    ['Support Engineer', 'United States', 'We do not use offices. Everyone can work from home anywhere in the United States.'],
    ['Implementation Consultant', 'Remote - US', 'Fully remote. Our company does not support remote work from outside the United States.'],
    ['Data Analyst', 'Canada', 'This role is 100% remote. No travel required.'],
  ];
  for (const [t, l, d] of remote) {
    const wt = extractWorkplaceType(t, l, d);
    assert.strictEqual(wt, 'remote', t);
    assert.strictEqual(classifyRemote(t, l, wt, d), true, t);
  }
});

test('the retag script takes these rows out of remote, and leaves remote ones', () => {
  const [t, l, d] = officeJobs[0];
  assert.deepStrictEqual(retagPartWeek({ title: t, location: l, description: d }), { workplace: 'onsite', is_remote: false, remote_worldwide: false });
  assert.strictEqual(retagPartWeek({ title: 'Senior Engineer', location: 'Remote', description: 'We work from anywhere. This is a fully remote role.' }), null);
});
