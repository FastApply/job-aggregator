/**
 * "Intern" is also Swedish, Norwegian, Danish and Dutch for internal: "Intern revisor" is an
 * internal auditor, "Gruppchef Intern Logistik" runs in-house logistics, "CE Chaufför med fokus på
 * intern körning" drives a truck. Read as English, each was filed as an internship, which matters
 * for the Nordic enterprise customer's searches.
 *
 * The adjective comes before its noun; the English noun ends the role or is set off from it
 * ("Marketing Intern", "Intern - Finance", "Software Development Engineer (Intern)"). So an "intern"
 * means internal only when a word follows it directly and that word, or the title, is Nordic or
 * Dutch: a known noun stem, a letter English does not use, or a Nordic function word elsewhere in
 * the title. English titles on Nordic boards (Teamtailor carries many) keep their internship.
 */

// Noun stems that follow the adjective in the local corpus and in common Nordic / Dutch titles.
// Prefixes, except where the English word would also match ("transport" vs "transportation").
const NOUN_STEMS = [
  'revis', 'kontrol', 'kommunik', 'rekryt', 'rekrut', 'logistik', 'ledning', 'ledelse', 'styrning',
  'styring', 'utbild', 'uddann', 'oppl', 'rådgiv', 'radgiv', 'konsulent', 'transport\\b', 'körning',
  'kørsel', 'kjøring', 'ekonom', 'økonom', 'okonom', 'it-', 'adviseur', 'medewerker', 'medarbe',
  'begeleid', 'sälj', 'selg', 'salg', 'lager', 'sekret', 'koordinator', 'projekt', 'kvalitet', 'kontor',
  'förvalt', 'forvalt', 'tjänst', 'tjenest', 'handl', 'telefon', 'bemanning', 'kund', 'drift', 'teknik',
  'tekniker', 'elektriker', 'jurist', 'redovis', 'regnskab', 'regnskap', 'kunskap', 'kompetens',
  'verksamhet', 'virksomhet', 'säkerhet', 'sikkerhe', 'utred',
];
// Left out though they occur: "service" and "auditor" ("Intern Service Enablement Team" and
// "Intern Auditor - Paris La Défense" are internships written in English).
const NORDIC_LETTER = '[åäöæøÅÄÖÆØ]';
const NORDIC_WORDS = 'och|og|för|til|af|av|inom|hos|samt|eller|chef|medarbetare|medarbeider|medarbejder'
  + '|ansvarig|ansvarlig|handläggare|saksbehandler|avdeling|avdelning|afdeling|enhet|enhed';
// Words that may follow an English "Intern" in a mixed title; never the noun the adjective takes.
const FUNCTION_WORDS = /^(?:med|i|på|for|för|till|til|hos|at|in|with|to|and|och|og|-)$/i;

const INTERN_THEN_WORD = /\bintern\s+([^\s,;:()/|–—-][^\s,;:()/|]*)/gi;
const STEM_START = new RegExp(`^(?:${NOUN_STEMS.join('|')})`, 'i');
const HAS_NORDIC_LETTER = new RegExp(NORDIC_LETTER);
// Case-sensitive: the function words are lowercase in a title, and "AV Technician" is audio-visual.
const NORDIC_TITLE = new RegExp(`${NORDIC_LETTER}|\\b(?:${NORDIC_WORDS})\\b`);

/** The title with every "intern" that means internal blanked out; unchanged otherwise. */
function withoutNordicIntern(title) {
  const t = String(title || '');
  if (!/\bintern\s/i.test(t)) return t;
  const nordicTitle = NORDIC_TITLE.test(t);
  return t.replace(INTERN_THEN_WORD, (whole, next) => {
    const internal = STEM_START.test(next) || HAS_NORDIC_LETTER.test(next)
      || (nordicTitle && !FUNCTION_WORDS.test(next));
    return internal ? whole.replace(/intern/i, ' ') : whole;
  });
}

/**
 * The same test for Postgres (~*), for the SQL search fallback: true when the title has an
 * "intern" followed by a Nordic noun or a word with a Nordic letter. The title-wide cue is left to
 * the index; this only has to keep the fallback from disagreeing on the clear cases.
 */
const NORDIC_INTERN_SQL = `\\mintern\\s+([[:alpha:]-]*${NORDIC_LETTER}|(${NOUN_STEMS.map((s) => s.replace(/\\b$/, '\\M')).join('|')}))`;

module.exports = { withoutNordicIntern, NORDIC_INTERN_SQL };
