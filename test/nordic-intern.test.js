const test = require('node:test');
const assert = require('node:assert/strict');
const { withoutNordicIntern } = require('../src/utils/nordic-intern');
const { classifyExperienceLevel } = require('../src/utils/classify');

// "Intern" is Swedish, Norwegian, Danish and Dutch for internal. Every title here is from the
// local corpus (2026-10-30): 16 of 148,197 intern-titled rows read this way, all correctly.
const INTERNAL = [
  'Intern revisor',
  'Gruppchef Intern Logistik & Lager',
  'Avdelningschef Intern ledning och samordning',
  'CE Chaufför med fokus på intern körning med släp/trailer',
  'Specialist inom intern styrning och kontroll',
  'Receptionist till intern reception på bank i city (vikariat)',
  'Medewerker Intern Transport Logistiek',
  'Intern Adviseur Zorg & Inkomen',
];
const INTERNSHIP = [
  'Marketing Intern', 'Intern', 'Intern - Finance', 'Software Development Engineer (Intern)',
  'Intern Software Engineer', 'Intern Transportation Planner', 'Intern Service Enablement Team',
  'Intern Auditor - Paris La Défense', 'Ark Encounter AV Technician Embark Intern Summer 2027',
  'Marketing Intern med fokus på B2B', 'Communications intern supporting WWF corporate partnerships',
];

test('a Nordic or Dutch "intern" before its noun is internal', () => {
  for (const t of INTERNAL) {
    assert.notEqual(withoutNordicIntern(t), t, t);
    assert.notEqual(classifyExperienceLevel(t, ''), 'internship', t);
  }
});

test('an English intern stays an internship, on any board', () => {
  for (const t of INTERNSHIP) {
    assert.equal(withoutNordicIntern(t), t, t);
    assert.equal(classifyExperienceLevel(t, ''), 'internship', t);
  }
});
