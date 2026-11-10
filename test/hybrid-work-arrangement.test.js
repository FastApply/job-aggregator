'use strict';
// pref-match audit, 2026-11-10: Solidigm's remote Senior Security Application Engineer was stored
// Hybrid because its requirements say "hybrid crypto schemes". "Hybrid" is a work model only where
// it names one.
const { test } = require('node:test');
const assert = require('node:assert');
const { statesHybridWork, jobStatesHybrid } = require('../src/utils/hybrid-work');
const { extractWorkplaceType } = require('../src/utils/extract');
const { classifyRemote } = require('../src/utils/classify');

const SOLIDIGM =
  'Post-quantum cryptography (PQC) — practical experience with ML-DSA, LMS/LMOD, or hybrid crypto schemes; familiarity with CNSA 2.0+ and NIST PQC standards.';

test('"hybrid crypto schemes" is no work model (Solidigm)', () => {
  assert.strictEqual(statesHybridWork(SOLIDIGM), false);
  assert.strictEqual(
    extractWorkplaceType('Senior Security Application Engineer - Automation & Detection', 'Rancho Cordova, CA, United States', SOLIDIGM),
    null
  );
  assert.notStrictEqual(
    classifyRemote('Senior Security Engineer', 'Remote, United States', null, SOLIDIGM),
    false,
    'a remote location is not overruled by the adjective'
  );
});

test('hybrid as an adjective of a thing does not count', () => {
  for (const text of [
    'Experience designing hybrid cloud and multi-cloud architectures.',
    'Support remote and hybrid cloud deployments for our customers.',
    'We build hybrid and multi-cloud environments.',
    'Knowledge of hybrid vehicles and battery systems.',
    'Our documentation is Git-based, wiki, or hybrid.',
    'Build hybrid mobile apps with Ionic.',
    'Run workloads hybrid in the cloud and on premises.',
  ]) {
    assert.strictEqual(statesHybridWork(text), false, text);
  }
});

test('hybrid as the way the job is worked counts', () => {
  for (const text of [
    'This is a hybrid role based in our Austin office.',
    'We offer a hybrid work model with two days in office.',
    'Hybrid (3 days in office)',
    'Hybrid, 2 days a week in Denver',
    'Location: Hybrid',
    'Work Model: Hybrid',
    'Workplace type - Hybrid',
    'Senior Analyst - Hybrid',
    'Senior Analyst (Hybrid)',
    'This position can be remote or hybrid.',
    'On-site, hybrid or remote',
    'The role is hybrid, with Tuesdays and Thursdays in the office.',
    'Hybrid in Austin, TX',
    'Hybrid Remote',
    'hybrid-remote schedule',
  ]) {
    assert.strictEqual(statesHybridWork(text), true, text);
  }
});

test('the location field counts on the word alone', () => {
  assert.strictEqual(jobStatesHybrid('Engineer', 'USA and Global (Hybrid)', ''), true);
  assert.strictEqual(jobStatesHybrid('Engineer', 'Hybrid, Chicago, IL', ''), true);
  assert.strictEqual(jobStatesHybrid('Hybrid Cloud Engineer', 'Austin, TX', 'Design hybrid cloud platforms.'), false);
  assert.strictEqual(extractWorkplaceType('Hybrid Cloud Engineer', 'Austin, TX', 'Design hybrid cloud platforms.'), null);
});

test('a hybrid work statement still beats remote wording, as before', () => {
  assert.strictEqual(
    extractWorkplaceType('Product Manager', 'Austin, TX', 'This is a remote position with a hybrid work schedule for local candidates.'),
    'hybrid'
  );
});

// Read off the 2026-11-10 shadow sample of stored Hybrid rows (2% of 335,163 crawl rows).
test('the work-model wordings the shadow sample found count', () => {
  for (const text of [
    '#LI-Hybrid', 'privacy-notice/) #LI-HYBRID', 'Closing Date: Hybrid Worker',
    'Our hybrid environment allows you to balance your work and life.',
    'Hybrid sales environment (home office and in-field)',
    'candidates who can work in a remote or hybrid environment, depending on business needs',
    'other business sites (e.g., Hanscom AFB), hybrid, or fully remote.',
    "That's why we've adopted a hybrid approach including required in-office days.",
    'Hybrid or flexible work options may be offered after onboarding.',
    'Work modality: Hybrid', 'Working Arrangement Hybrid Salary range', 'Work Model Hybrid Background Check',
    'Arbeitsmodell: Hybrid', 'Work location: • Hybrid Eligible', 'WORK MODE: • Hybrid/Split',
    'Work Arrangement: • Hybrid: Tuesday, Wednesday, Thursday required office days',
    'Product Analyst, Digital Assets (Hybrid - NYC)', 'Legal Counsel Derby (Three days Derby/hybrid) Full time',
    'We offer a dynamic, hybrid-friendly culture.',
    'This role is categorized as hybrid. This means the selected candidate is expected on site.',
    'We embrace a hybrid approach to work.', 'On-site or Remote: Hybrid', '#LI-SA1 #Hybrid',
    'impactful, flexible-hybrid careers', 'We are proud to be a hybrid organization that offers flexibility.',
    'Flexible Work Arrangements: Hybrid', 'a hybrid home/office workplace', 'flexible, agile and hybrid ways of working',
    'Telework Type: Hybrid', "This position's work mode is hybrid.", 'Tokyo Osaka - Office Remote Hybrid',
    'Working place: Hybrid', 'Spring 2027 internships will be hybrid.', 'Work Flexibility: Hybrid',
    'Flexible work: hybrid or full-time from our office in Monterrey', 'we have a hybrid-hub model',
    'Remote-first flexibility - work from home, the office, or hybrid', 'Flexible, hybrid and agile working',
    'Location: Indianapolis, IN - Global Headquarters • Hybrid', 'Gleitzeitmodell und hybrid (remote und im Office)',
    'the availability to work in a hybrid setting 32 hrs/wk', 'hybrid-flex work arrangements',
    'full-time work in the office or hybrid type of work is possible', 'Location: Vadodara (Client office, Hybrid)',
    'Physically located in and working hybrid from our (Irvine, CA) Office.', 'Working Pattern: Hybrid, with flexibility to work remotely',
    'Hybrid telecommuting from within the U.S. permitted', 'You will work in a Hybrid based environment',
    'Hybrid telepsychiatry schedule', 'Work Location Type: Hybrid',
    'Clinical Therapist (LMSW, LCSW, LMHC) - Hybrid Forest Hills- Full Time or Part Time', '<p>Location:</strong> London | <strong>Work Model:</strong> Hybrid</span></p>',
  ]) {
    assert.strictEqual(statesHybridWork(text), true, text);
  }
});

test('the other hybrids the shadow sample found do not', () => {
  for (const text of [
    'Familiarity with Agile, Waterfall, or hybrid delivery methodologies.',
    'Support hybrid enterprise and cloud-native environments',
    'telecom networks, datacenters, cloud or hybrid infrastructure, 5G',
    'including virtual and hybrid formats.',
    'ready to step into a hybrid leadership role, combining hands-on patient care',
    'Lead the design and development of hybrid retrieval architectures',
    'Experience with online or hybrid instruction is preferred.',
    'our Cardiac Catheterisation Laboratories and Hybrid Theatre perform a range of interventions',
    'Our brick-and-mortar, virtual, and hybrid schools specialize in closing gaps',
    'the EL9, a nine-passenger, hybrid-electric aircraft',
    'Komponenten für PKW, Hybrid-, Erdgas- und Wasserstofffahrzeuge',
    'advanced packaging technologies including TSVs, hybrid bonding, and 3D integration',
    'automation, control, SCADA, hybrid energy systems', 'immunocapturing hybrid assays',
    'a high performance, light weight, hybrid metallic and composite structure',
    'working a hybrid list of net-new and existing accounts', 'The Data Scientist will be a hybrid professional',
    'delivering projects using waterfall, hybrid, and agile methodologies.',
    'strategy across cloud, hybrid, and on-prem environments', 'Azure AI Search for hybrid retrieval',
  ]) {
    assert.strictEqual(statesHybridWork(text), false, text);
  }
});

test("Booz Allen's per-mode policy names no mode for this job", () => {
  const text =
    'Employees working virtually are generally expected to have their cameras on. • Remote: If this position is listed as remote, there may still be occasions when you are required to work in person at a Booz Allen or customer facility. • Hybrid: If this position is listed as hybrid, you will be expected to work from a Booz Allen or customer facility. • Onsite: If this position is listed as onsite, you will work from a Booz Allen or customer facility.';
  assert.strictEqual(extractWorkplaceType('Cloud Computing Infrastructure Architect, Mid', 'Warner Robins, GA', text), null);
});
