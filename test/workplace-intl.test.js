'use strict';
/**
 * Work model read from non-English postings, without changing how English ones read.
 *
 * Every case below is wording from a live posting (2026-09-28). The English cases pin behaviour
 * that must NOT move: on a 30k live sample the first draft of these rules turned US postings
 * hybrid on "our home office in Louisville" (headquarters) and "12-hour shifts, 3 days per week".
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractWorkplaceType } = require('../src/utils/extract');

const wt = (text, location = 'Berlin, Germany') => extractWorkplaceType('Scrum Master', location, text);

test('German, Italian, French, Spanish and Dutch hybrid wording reads as hybrid', () => {
  for (const text of [
    'Homeoffice: flexible Arbeitszeiten im Homeoffice und Büro.',
    'Flexibilität inkl. Remote-Arbeit und Präsenztagen an unseren Standorten',
    'der Möglichkeit zu Remote Work an 1 Tag/ Woche',
    'The work model for the role is: smart working – hybrid',
    'flexible Arbeitszeiten und mobiles Arbeiten möglich',
    'hybrides Arbeitsmodell im Land',
    'Télétravail 2 jours par semaine',
    'Beneficios: modelo de trabajo híbrido',
    'werkplek: hybride, Utrecht',
  ]) assert.equal(wt(text), 'hybrid', text);
});

test('fully remote in so many words reads as remote', () => {
  for (const text of ['Die Stelle ist vollständig remote. Homeoffice-Ausstattung inklusive',
    'Lavoro da remoto al 100%', 'Poste en télétravail complet',
    'Remote-Arbeit innerhalb Deutschlands (2 Präsenztage pro Quartal in München)']) {
    assert.equal(wt(text), 'remote', text);
  }
});

test('a full-remote perk on a hybrid job stays hybrid', () => {
  assert.equal(wt('hasta 20 días al año de trabajo 100% remoto. Modelo de trabajo híbrido'), 'hybrid');
  assert.equal(wt('ob voll remote oder in einem unserer Büros', 'Hybrid (München)'), 'hybrid');
});

test('the adjective "hybrid" about something other than work does not count', () => {
  assert.equal(wt('Meininger Hotels. Hybride Hotellerie neu definiert.'), null);
  assert.equal(wt('Entwicklung der App – einem hybriden System aus Flutter'), null);
  assert.equal(wt('<p class="MsoListParagraph" style="mso-list:l0 level1 lfo1;hybridMultilevel">x</p>'), null);
  assert.equal(wt('Präsenzpflicht im Büro'), null, 'required attendance is not hybrid');
});

test('English wording reads exactly as before', () => {
  assert.equal(wt('Our teams, whether at our home office or inside our schools', 'Nashua, NH'), null);
  assert.equal(wt('rotating 2-week schedule of 12-hour shifts, 3 days per week', 'Louisville, KY'), null);
  assert.equal(wt('$1,250 annual home office stipend. This is a remote role.', 'Remote - US'), 'remote');
  assert.equal(wt('We are not able to offer a permanent 100% remote option. We are seeking a hybrid arrangement'), 'hybrid');
  assert.equal(wt('This is a 100% remote position'), 'remote');
  assert.equal(wt('Join us on-site in Munich'), 'onsite');
  assert.equal(wt('Great team, competitive salary'), null);
});

test('a purely global location is remote whatever the description says', () => {
  assert.equal(extractWorkplaceType('Lead', 'Worldwide', 'Git-based, wiki, or hybrid documentation'), 'remote');
});
