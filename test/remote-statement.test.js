const test = require('node:test');
const assert = require('node:assert');
const { extractWorkplaceType } = require('../src/utils/extract');
const { classifyRemote } = require('../src/utils/classify');
const { retag } = require('../scripts/backfill-remote-flag');

// Real postings, cut to the words that decided them. Remote-only First Apply users were applied
// to the "not remote" ones in the 2026-10-30 pref-match audit, or they are from the live sample.
const notRemote = [
  ['Operations Coordinator', 'Virginia Beach, VA', 'support to the Director in a clinical setting. For positions that are available as remote work, Sentara Health employs associates in the following states: Alabama'],
  ['GEOINT Analyst', 'Location: USA-VA-Springfield', 'activity-based intelligence (ABI), GIS, and remote sensing techniques to enhance analytic products'],
  ['Technical/Desktop Support Analyst', 'Columbia Heights, MN', 'Provide remote tech support for hardware (printers, desktops)'],
  ['IT Support Specialist', 'Brooklyn Heights, OH', 'Utilize service management, remote support, and diagnostic tools'],
  ['Traveling Staff Engineer', 'Dallas (Grapevine)', 'Perform oversight of other field personnel on remote job sites.'],
  ['Regional Manager - Tampa FL', 'Tampa, FL', 'For fully remote positions, compensation will comply with all applicable laws'],
  ['Software Developer', 'Rapid City, SD', 'ON-SITE ONLY — THIS IS NOT A REMOTE POSITION'],
  ['Global Product Manager', 'Heidenheim', 'at the specific location where you are based - this is not a fully remote position.'],
  ['ANALYST HRIS', 'Houston, TX', 'Flexible work schedules and opportunity to do remote work as needed'],
  ['Senior Data Analyst', 'Manila', 'flexible delivery models ranging from building Remote Teams to comprehensive outsourcing'],
  ['Power Apps Developer', 'Chennai', 'Job Schedule: Full time Remote: No Job Description: The opportunity'],
  ['Heavy Equipment Operator', 'Fort McMurray, AB', 'to join our remote mining site team in the Fort McMurray area'],
  ['Registered Nurse', 'New Orleans', 'to determine whether the position you are interested in is remote or on-site.'],
  ['Remote Operations Center Specialist', 'GA Atlanta', 'Live sports production, coordination and oversight.'],
  ['Software Engineer', 'Strykow', 'Ability to work with remote teams across regions.'],
  ['Analyst', 'Racine', 'You can work remotely up to 2 days a week.'],
];
const remote = [
  ['Customer Success Manager', 'Arlington, VA', 'Role Location: Fully remote within the continental United States.'],
  ['Data Analyst', 'Riverside, Wyoming', 'REMOTE - US Residents Only We are looking for'],
  ['Project Manager', 'Hyderabad', 'Project Manager Experience : 6+ years Location : Remote Required Skills:'],
  ['Java Developer', 'India', 'integrations. Location : India, Remote Employment Type : Contract'],
  ['Technical Specialist', 'South Central', 'Location: South Central - USA, Remote, US #job-location'],
  ['Customer Success Manager', 'United States', 'Remote (EST): Candidates must live and work within the US'],
  ['Senior QA Engineer', 'US - Texas', 'This role will be remote. Travel 1-2 times per quarter'],
  ['Sales Manager', 'Pakistan', 'Position Type: Full-Time, Remote Working Hours: U.S. Business Hours'],
  ['Product Manager', 'India', 'Ajaia is hiring a remote Product Manager to own products'],
  ['Sr Product Owner', 'United States', 'request Human Resources. #LI-Remote'],
  ['Account Manager', 'Kansas City', 'Title; Account Manager Location Remote Travel: 80-100% within territory'],
  ['Associate', 'Lublin', 'Remote Type - Remote Work Shift - Standard (Poland)'],
  ['Network Security Engineer', null, 'Job Title: Network Security Engineer Location: Virtual, US 99999'],
  ['Senior Product Manager', null, 'Remote worldwide, with substantial Europe time-zone overlap'],
  ['Technical Project Manager', 'Manila', 'Work Set-up / Work Schedule Remote Shifting EST'],
  ['Default Loan Specialist', 'Fort Mill', 'Pay Range: $23.37 - $31.15 Hourly, Remote This hiring range'],
  ['Collections and Billing', 'Cerritos, California', 'Remote- California based career'],
  ['Director', 'Atlanta', '***This is a fully remote position that can be home-based anywhere within the US'],
];

test('the word in a description does not make a job remote', () => {
  for (const [t, l, d] of notRemote) {
    const wt = extractWorkplaceType(t, l, d);
    assert.notStrictEqual(wt, 'remote', t);
    assert.strictEqual(classifyRemote(t, l, wt, d), false, t);
  }
});

test('a posting that says the job is remote stays remote', () => {
  for (const [t, l, d] of remote) {
    assert.strictEqual(extractWorkplaceType(t, l, d), 'remote', t);
    assert.strictEqual(classifyRemote(t, l, 'remote', d), true, t);
  }
});

test('title and location still decide when they say remote', () => {
  assert.strictEqual(extractWorkplaceType('Sales Manager - Remote', 'Austin, TX', ''), 'remote');
  assert.strictEqual(extractWorkplaceType('Sales Manager', 'Remote - Texas', ''), 'remote');
});

test('a stated on-site or hybrid job is read as before', () => {
  assert.strictEqual(extractWorkplaceType('Nurse', 'Boston', 'Remote Type: On-site Salary Range'), 'onsite');
  assert.strictEqual(extractWorkplaceType('Engineer', 'London', 'remote monitoring. Hybrid - 3 days'), 'hybrid');
});

test('the backfill clears a row tagged on the word and leaves the rest', () => {
  const row = (title, location, description) => ({ title, location, description });
  assert.deepStrictEqual(retag(row('GEOINT Analyst', 'Springfield, VA', '<p>remote sensing techniques</p>')), { workplace: null, is_remote: false, remote_worldwide: false });
  assert.strictEqual(retag(row('Analyst', 'Texas', '<p>This is a fully remote position.</p>')), null);
  // No such word: the tag came from the ATS.
  assert.strictEqual(retag(row('Retail Specialist', 'Quincy, IL', '<p>Stock shelves.</p>')), null);
  assert.strictEqual(retag(row('Sales Manager', 'Remote - Texas', '<p>Selling remote monitoring.</p>')), null);
});

test('the backfill keeps a tag the title, location or a stated wording gives', () => {
  const row = (title, location, description) => ({ title, location, description });
  // Real rows from the 2026-11-09 shadow sample that the reader alone would have cleared.
  const kept = [
    ['Account Manager, AdTech - British Columbia', 'Remote', '<p>a remote work environment in PST hours. Hybrid teams</p>'],
    ['Radiologist - Remote, Evening', 'Remote', '<p>onsite/hybrid and remote positions</p>'],
    ['Claims Team Lead', 'Telecommuter GA', '<p>NY Preferred (Remote). Hybrid</p>'],
    ['Principal Sales Engineer', 'Virtual', '<p>live greater than 100 miles from the office for the remote option. on-site</p>'],
    ['Virtual Financial Advisor', 'Home Location-CO (COH01)', '<p>you will be remote within the footprint. on site</p>'],
    ['Alliances & Channels Leader', 'Home Based - Americas; Home based - EMEA', '<p>These are globally remote positions.</p>'],
    ['Customer Success Manager', 'UK London Area OFFSITE', '<p>#Remote #SaaS</p>'],
    ['Outside Sales Representative', 'FRESNO, CALIFORNIA', '<p>#LI- Remote Compensation</p>'],
    ['College Internship', 'Ohio, United States', '<p>operates in a remote/virtual professional office environment</p>'],
    ['Head of Analytics', 'Limassol, Cyprus', '<p>Limassol, Cyprus (or remote within UTC-1 to UTC+4)</p>'],
    ['QA Engineer Lead', 'Washington, District of Columbia', '<p>QA Engineer Lead</p><p>Remote</p><p>We are seeking an experienced lead. on-site</p>'],
    ['Claims Resolution Specialist I', 'United States', '<p>Country: United States of AmericaLocation: Florida - Remote WHY JOIN</p>'],
    ['Senior Manager, Salesforce', 'Washington, District of Columbia', '<p>headquarters are located in Washington, D.C. Remote candidates will be considered.</p>'],
    ['POD Pharmacist', 'Texas, TX, USA', '<p>Remote positions located within communities that Monogram Health serves</p>'],
    ['Senior Consultant', 'United Kingdom', '<p>This role offers flexible and remote working, with travel to our Horsham office</p>'],
    ['Care Manager (Bilingual)', 'Houston (statewide), Texas', '<p>with Every Call Remote | Full-Time | Bilingual The Kind of Person</p>'],
    ['Support Engineer, L2', 'Kyiv, Ukraine', '<p>Type of engagement: B2B Type of environment: Remote Location: Ukraine</p>'],
    ['Data Engineer', 'United States', '<p>Benefits: • Remote with flexible hours • 401(k)</p>'],
    ['Head of B2B Growth', null, '<p>Logistics Remote. Anywhere within +/- 3h of CET.</p>'],
    ['Specialist', 'Texas', '<p>• What &amp; Where: Remote &amp; Full Time, Permanent</p>'],
  ];
  for (const [title, location, description] of kept) {
    assert.strictEqual(retag(row(title, location, description)), null, `${title} | ${location}`);
  }
  // Still cleared: the word is about something else.
  const cleared = [
    ['Retail Merchandise Processor', 'Kingman Store (Kingman, Arizona)', '<p>conducting remote "interviews," and making artificial job offers</p>'],
    ['Monitor Tech', 'Little Rock', '<p>monitoring patients on remote telemetry</p>'],
    ['Postdoc: Microwave Remote Sensing', 'JPL Campus', '<p>research in microwave remote sensing</p>'],
    ['Executive Assistant', 'Springfield, Illinois', '<p>No remote option</p>'],
    ['DevOps Software Engineer', 'Bethesda, Maryland', '<p>Location: Bethesda, MD Category: DevOps Remote Type: No Clearance</p>'],
    ['Registered Nurse', 'St Albans', '<p>advice, and treatment, including remote GP appointments, physiotherapy</p>'],
    ['Technical Account Manager', 'Cape Town', '<p>The role is office-based and not remote.</p>'],
  ];
  for (const [title, location, description] of cleared) {
    assert.notStrictEqual(retag(row(title, location, description)), null, `${title} | ${location}`);
  }
});
