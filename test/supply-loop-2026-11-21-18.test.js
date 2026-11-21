const test = require('node:test');
const assert = require('node:assert');
const { extractWorkplaceType } = require('../src/utils/extract');
const { classifyRemote } = require('../src/utils/classify');

// Supply loop 2026-11-21 18h. Home or remote work on named days is part of the week: the rest is
// in the office, so the job is hybrid. Each of these was stored remote, so it sat in remote-only
// searches and out of hybrid and on-site ones. Real postings, cut to the words that decided them.
const partWeek = [
  ['Senior Technical Business Analyst- Arlington, VA', 'US-VA Arlington', 'This position is located in Arlington, VA and is in office Monday through Thursday and work from home on Friday.'],
  ['Financial Analyst I', 'Brooklyn, NY', 'Ability to work onsite in the Brooklyn office Monday - Thursday and work remotely on Fridays. Our Culture & Values'],
  ['Staff Accountant', 'Chicago, IL', 'Mother&rsquo;s lounge onsite Flexible PTO plan In-office Monday through Thursday and work from home on Fridays Free brand-new gym'],
  ['Electrical Engineer VI', 'Baton Rouge, LA', 'Expected to be in the office Monday through Wednesday and may work remotely the rest of the week.'],
  ['Senior Tax Accountant', 'San Diego, CA', 'Monday through Thursday are in-office for collaboration, with the opportunity to work remotely on Friday.'],
  ['Quantitative Developer III', 'New York, NY', 'Work from anywhere 3 weeks out of the year • Work from home Fridays Salary Range $137,770.00'],
  ['Engineer in Training', 'Calgary, AB', 'This position may work remotely Mondays and Fridays and in the office Tuesday to Thursday.'],
  ['Coordinator, Campus Recruitment', 'New York, NY', 'Prime midtown office with state-of-the-art amenities Option to WFH Thursday and Friday'],
  ['Business Analyst', 'Philadelphia, PA', 'in the office Monday through Thursday, with Fridays remote'],
];

test('home or remote work on named days is hybrid, never remote', () => {
  for (const [t, l, d] of partWeek) {
    assert.strictEqual(extractWorkplaceType(t, l, d), 'hybrid', t);
    assert.strictEqual(classifyRemote(t, l, 'hybrid', d), false, t);
  }
});

test('the whole week, a half day, and a fully remote job are not part-week', () => {
  // Monday through Friday in the office is the whole week.
  assert.strictEqual(extractWorkplaceType('Clerk', 'Austin, TX', 'Work on-site Monday through Friday, 8am-5pm.'), 'onsite');
  // A half day at home is a perk of an office job, not a work model.
  assert.notStrictEqual(extractWorkplaceType('Engineer I (ICT)', 'New York, NY', 'Transit/parking employer stipend ½ day work from home Fridays all year long'), 'hybrid');
  // Fully remote still reads remote.
  assert.strictEqual(extractWorkplaceType('Customer Success Manager', 'Arlington, VA', 'Role Location: Fully remote within the continental United States.'), 'remote');
  // Office days with no home work after them stay as they were (a 4x10 schedule is on-site).
  assert.notStrictEqual(extractWorkplaceType('Technician', 'Dayton, OH', 'This is an in office Monday through Thursday, 10 hour shift role.'), 'hybrid');
});

// Work from home on a condition is a flexibility perk of an office job, never a remote work model.
// Emirates NBD says it on every posting, so its Dubai bank roles sat out of Dubai on-site searches.
test('work from home on a condition is not remote', () => {
  const conditional = [
    ['Manager - Project Finance', 'Dubai', 'benefits and perks too, like our flexible work policy so you can work from home whenever it suits'],
    ['Specialist Customer Service Export', 'Bucharest, RO', 'You can work from home, if the work activity allows.'],
    ['Customer Service Representative', 'Paris', 'Able to work remotely if required – access to reliable internet connection required'],
    ['Senior Accountant - Financial Planning', 'Latham, NY', 'This position is primarily onsite at our Latham, NY office. Eligible to work from home when schedule allows.'],
  ];
  for (const [t, l, d] of conditional) {
    assert.notStrictEqual(extractWorkplaceType(t, l, d), 'remote', t);
  }
  // Remote without a condition still reads remote.
  assert.strictEqual(extractWorkplaceType('Support Engineer', 'United States', 'You will work remotely from anywhere in the US.'), 'remote');
});
