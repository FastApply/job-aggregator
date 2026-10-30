'use strict';
/**
 * A posting whose title names it an internship is indexed as one, whatever hours the ATS states.
 *
 * Workday's only type field is the time type, so "ASIC Intern" and "Firmware Engineering Intern"
 * arrive as "Full time" and employment_type=internship never returned them. Measured live
 * 2026-10-30 (supply loop) on a starved First Apply search (firmware / embedded / hardware
 * engineering interns, US, internship only): 176 intern-titled rows on its first four pages
 * without the filter, 105 with it; 74 dropped were labeled Full-time / Part-time / Contract /
 * Temporary.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { toDocument } = require('../src/utils/meili');

const doc = (title, employment_type) => toDocument({ id: 1, title, employment_type });

test('an intern title is indexed as Internship whatever type the ATS stated', () => {
  assert.equal(doc('ASIC Intern', 'Full time').employment_type, 'Internship');
  assert.equal(doc('Firmware Engineering Intern', 'Full-time').employment_type, 'Internship');
  assert.equal(doc('Summer 2027 Internship - Hardware', 'Part time').employment_type, 'Internship');
  assert.equal(doc('Intern - ASIC Digital Design', null).employment_type, 'Internship');
  assert.equal(doc('Software Engineering Interns (Fall)', 'Temporary').employment_type, 'Internship');
  assert.equal(doc('Stagiaire Marketing', 'CDD').employment_type, 'Internship');
});

test('other titles keep the stated type, including look-alike words', () => {
  assert.equal(doc('Internal Auditor', 'Full time').employment_type, 'Full-time');
  assert.equal(doc('International Sales Manager', 'Part time').employment_type, 'Part-time');
  assert.equal(doc('Internist', 'Full time').employment_type, 'Full-time');
  assert.equal(doc('Co-op Store Manager', 'Full time').employment_type, 'Full-time');
  assert.equal(doc('Internship Program Coordinator', 'Full time').employment_type, 'Full-time');
  assert.equal(doc('Intern Recruiter', 'Full time').employment_type, 'Full-time');
  assert.equal(doc('University Programs - Intern Program Manager', 'Full time').employment_type, 'Full-time');
  assert.equal(doc('Software Engineer', null).employment_type, null);
  assert.equal(doc(undefined, 'Contractor').employment_type, 'Contract');
});
