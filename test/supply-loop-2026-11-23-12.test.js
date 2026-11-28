const test = require('node:test');
const assert = require('node:assert');
const { extractWorkplaceType } = require('../src/utils/extract');
const { classifyRemote, classifyJob } = require('../src/utils/classify');
const { retagOnsiteStated } = require('../scripts/retag-onsite-stated');

// Supply loop 2026-11-23 12h. Office jobs whose posting says, in its title or in so many words,
// that THIS job is worked on site were stored remote: the description's remote words were the
// company's ("We are a remote-first company") or the work's ("support colleagues working remotely
// across the United States"). They sat in remote-only searches, where the verdict refused them,
// and out of on-site searches for their own city. Real postings, cut to the words that decided them.
const onsite = [
  ['IT Support Specialist, US & Studio Technology', 'Emeryville, California', 'Location: On-Site - Emeryville, CA Employment Type: Full-Time. You will support studio operations, as well as colleagues working remotely across the United States.'],
  ['Accounts Receivable Coordinator', 'South Burlington, VT, USA', 'We are currently seeking an accounts receivable coordinator to support our business and finance team in South Burlington. This is an onsite position. Candidates must be able to work remotely with colleagues to problem-solve.'],
  ['Pharmacist In Charge (Specialty) - El Paso, TX', 'El Paso, TX', 'We are a remote-first company, however some pharmacy operations roles require onsite clinic presence. This is an onsite role in El Paso, TX. What You\'ll Do'],
  ['Product Owner, Customer Support Tools', 'Billings, MT', 'This is an on-site role in Billings, Montana, reporting to the Internal Tools lead. Outdoor-Centric Culture: Features remote-first flexibility, employee discounts.'],
  ['Senior Manager, AI/ ML Software Engineering - MN On site', '', 'You\'ll enjoy the flexibility to work remotely * from anywhere within the U.S. as you take on some tough challenges.'],
  ['MSP Tier 2 IT Support Technician -Not Remote', 'Durham, NC, US', 'Remote Monitoring & Ticketing Systems: Experience with RMM tools.'],
  ['Human Resources Generalist - Sausalito, CA (Not Remote)', 'Sausalito, CA', 'HR support for 7 US offices. Handle Remote Employee PEO and EOR payroll compliance.'],
  ['US Accounts Receivable Specialist (Onsite - Night Shift)', 'Eastwood, Quezon City, Philippines', 'You\'ll work remotely while collaborating with a US-based business.'],
  ['Onsite Desktop Support Engineer - Plymouth', 'Remote, ENG, GB', 'An understanding of LAN/WAN and VPN/remote connectivity.'],
  ['Tier II Remote Resolution Specialist', 'US-VA-Quantico', 'Resolve escalated Tier II incidents remotely. THIS IS AN ONSITE ROLE IN QUANTICO, VA (RKB) WITH UP TO 10% OF TRAVEL INVOLVED.'],
  ['Administrative Assistant', 'Oklahoma City, OK, United States', 'Problem-solving and decision-making skills. Work Remotely • No Job Type: Full-time Pay: $16.00 - $19.00 per hour'],
  ['Sales Specialist', 'Sydney', 'This role is fully office based, with no work from home option. The interview includes two stages.'],
];

test('a posting that says THIS job is on site is on-site, whatever remote words it holds', () => {
  for (const [t, l, d] of onsite) {
    assert.strictEqual(extractWorkplaceType(t, l, d), 'onsite', t);
    assert.strictEqual(classifyRemote(t, l, 'onsite', d), false, t);
  }
});

test('on site with home days is hybrid', () => {
  assert.strictEqual(extractWorkplaceType('Executive Director: Data Management', 'Warren, United States', 'Where and When: This is an on-site position 4 days/week, primarily based at our Sloan campus. Our teams work remotely on Fridays.'), 'hybrid');
  assert.strictEqual(extractWorkplaceType('Customer Success Manager', 'New York, NY', 'This is an in-person role based out of our New York City office, with flexibility for some remote work.'), 'hybrid');
});

test('an offer of both, or the employer saying the job is remote too, is not changed', () => {
  // Offers of both modes.
  assert.strictEqual(extractWorkplaceType('Remote/Onsite IT Support Specialist', 'San Diego, California, United States', ''), 'remote');
  assert.strictEqual(extractWorkplaceType('System Planning Engineer', 'OTHER, MA, US', 'Job Location: Onsite at Juno Beach, FL is preferred, Remote candidates will be considered. You will work remotely with planners.'), 'remote');
  // The employer's own contradiction stays as it was read before (owner, 2026-11-05).
  assert.strictEqual(extractWorkplaceType('Executive Assistant (Onsite: Deer Park, IL)', 'Deer Park, Illinois, United States', 'This position is a remote role and reports to the Group Executive.'), 'remote');
  assert.strictEqual(extractWorkplaceType('Sr Network Test Engineer', 'DENVER, CO, US', 'Location: This is an onsite position at the Zuni St lab in Denver, CO. #LI-Remote'), 'remote');
  // A remote job keeps its location's word.
  assert.strictEqual(extractWorkplaceType('IT Support Specialist, Tier 2', 'Remote, US', 'Support on-site systems at our El Dorado Hills, CA location when needed.'), 'remote');
  assert.strictEqual(extractWorkplaceType('Senior Program Manager - Remote', 'United States', 'Work from anywhere in the US.'), 'remote');
});

test('the title and location words: "Not Remote" and a remote desk are not remote', () => {
  assert.strictEqual(classifyRemote('MSP Tier 1 IT Support Tech-Not Remote', 'Durham, NC, US', null, ''), false);
  assert.strictEqual(classifyRemote('Data Analyst', 'Non-Remote, Austin, TX', null, ''), false);
  assert.strictEqual(classifyRemote('Data Analyst - Remote', 'Austin, TX', null, ''), true);
});

test('the retag touches only on-site statements the reader and classifier now agree on', () => {
  const row = (title, location, description) => ({ title, location, description });
  assert.deepStrictEqual(retagOnsiteStated(row(...onsite[1])), { workplace: 'onsite', is_remote: false, remote_worldwide: false });
  assert.strictEqual(retagOnsiteStated(row('Data Engineer', 'United States', 'This is a fully remote role. We work remotely across time zones.')), null);
  assert.strictEqual(retagOnsiteStated(row('Executive Assistant (Onsite: Deer Park, IL)', 'Deer Park, IL', 'This position is a remote role.')), null);
  const tags = classifyJob({ title: onsite[0][0], location: onsite[0][1], workplace_type: 'onsite', description: onsite[0][2] });
  assert.strictEqual(tags.is_remote, false);
});

// A bare "$" with the dollar named after the figure: Greenhouse's pay block "$55,000 — $65,000
// CAD" (346 of 6,144 rows with pay in a remote sample were stored USD), Zoho's "a monthly pay of
// $670.00 AUD".
test('a dollar named after the figure is that dollar', () => {
  const { extractSalary } = require('../src/utils/extract');
  assert.strictEqual(extractSalary('Base Salary Range $55,000 &mdash; $65,000 CAD').currency, 'CAD');
  assert.strictEqual(extractSalary('Start with a monthly pay of $670.00 AUD during the probationary period').currency, 'AUD');
  assert.strictEqual(extractSalary('Base pay $60k-$70k AUD').currency, 'AUD');
  assert.strictEqual(extractSalary('Salary: $120,000 - $150,000 USD per year').currency, 'USD');
  assert.strictEqual(extractSalary('salary of $85,000 per year').currency, 'USD');
  assert.strictEqual(extractSalary('The pay is £40,000 - £45,000').currency, 'GBP');
});
