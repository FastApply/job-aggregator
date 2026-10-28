const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyRemote } = require('../src/utils/classify');

// Built from real postings the FastApply pref-match audit found applied to remote-only users
// (2026-10-27). Each is an onsite role whose only "remote" signal was the word "anywhere".
test('a slogan or a CSS value saying "anywhere" does not make a job remote', () => {
  assert.equal(
    classifyRemote('Analyst, Accounts Payable', 'Iselin, NJ, US', null,
      'We work every day from our many offices. Start here. Go anywhere. This is our promise of movement.'),
    false,
  );
  assert.equal(
    classifyRemote('INTERNSHIP - Media Legal Assistant (F/M/X)', null, null,
      '#cma-s2-left .cma-s2-location-value { white-space: normal !important; overflow-wrap: anywhere; } Location: Paris 15th arrondissement'),
    false,
  );
  assert.equal(
    classifyRemote('Sales Associate (Seasonal)', 'Houston, TX, USA', null,
      "Looking for some great accessories you won't find anywhere else? Check out our store."),
    false,
  );
});

test('"anywhere" that describes where the work happens still reads remote', () => {
  assert.equal(classifyRemote('Writer', null, null, 'You can work from anywhere.'), true);
  assert.equal(classifyRemote('Writer', null, null, 'This role is remote - anywhere in the US.'), true);
  assert.equal(classifyRemote('Writer', null, null, 'Work anywhere you like.'), true);
  assert.equal(classifyRemote('Writer', null, null, 'Open to candidates anywhere in the world.'), true);
  // Location field saying anywhere is unchanged.
  assert.equal(classifyRemote('Writer', 'Anywhere', null, ''), true);
});

// Remote postings on the live board that say where the employee may live rather than "work
// from anywhere" (2026-10-27 sample of remote-flagged postings mentioning "anywhere").
test('where the employee may live or be based still reads remote', () => {
  assert.equal(classifyRemote('Senior iOS Engineer - Mexico', 'Mexico City', null,
    'Employees may live anywhere in Mexico, with availability to travel to the office.'), true);
  assert.equal(classifyRemote('Senior Software Engineer', null, null,
    'You will enjoy the flexibility to telecommute from anywhere within the U.S.'), true);
  assert.equal(classifyRemote('AI Developer', 'Toronto, ON, Canada', null,
    'This role can be based anywhere in Canada.'), true);
});

test('widening the applicant pool or the audience is not a remote job', () => {
  assert.equal(classifyRemote('Ironworker', 'Frederick, MD', null,
    'Preferred Areas: Frederick or Baltimore, MD (Candidates residing anywhere in Maryland will be considered)'), false);
  assert.equal(classifyRemote('Brand Ambassador', 'New York, NY', null,
    'This historic neighborhood is easily commutable from anywhere in NYC.'), false);
  assert.equal(classifyRemote('Operations AI Developer', 'San Jose', null,
    'At Adobe, we believe that great ideas can come from anywhere in the organization.'), false);
});
