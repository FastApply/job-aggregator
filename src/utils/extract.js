/**
 * Extraction utilities for enriching job data from descriptions.
 * Extracts salary, workplace type, and employment type from free text.
 */

/**
 * Extract salary information from job description text.
 * Returns { min, max, currency, interval } or null.
 *
 * Handles:
 *  - Ranges: $120,000 - $180,000, £50k-£70k, 53,000 USD - 80,000 USD
 *  - Hourly: $22 - $28/hr, $18.50 - $24.00 per hour
 *  - Single values: Salary: $85,000, Base salary of $120,000
 *  - Oracle format: Minimum Salary: 53,000 USD Maximum Salary: 80,000 USD
 *  - K suffix: $75K - $95K
 */
function extractSalary(text) {
  if (!text) return null;

  const currencyMap = {
    '$': 'USD', '£': 'GBP', '€': 'EUR', 'A$': 'AUD', 'C$': 'CAD',
    'USD': 'USD', 'GBP': 'GBP', 'EUR': 'EUR', 'AUD': 'AUD', 'CAD': 'CAD',
    'CHF': 'CHF', 'SGD': 'SGD', 'HKD': 'HKD', 'NZD': 'NZD', 'INR': 'INR',
    'JPY': 'JPY', 'CNY': 'CNY', 'KRW': 'KRW', 'BRL': 'BRL', 'MXN': 'MXN',
    'ZAR': 'ZAR', 'PLN': 'PLN', 'SEK': 'SEK', 'NOK': 'NOK', 'DKK': 'DKK',
  };

  // Detect interval from surrounding context
  function detectInterval(text, matchStart, matchEnd) {
    const ctx = text.substring(Math.max(0, matchStart - 60), matchEnd + 80).toLowerCase();
    if (/per\s*hour|hourly|\/\s*h(?:ou)?r|an\s*hour/i.test(ctx)) return 'hourly';
    if (/per\s*month|monthly|\/\s*month|\/\s*mo\b/i.test(ctx)) return 'monthly';
    if (/per\s*week|weekly|\/\s*week/i.test(ctx)) return 'weekly';
    return 'yearly';
  }

  function parseNum(s) {
    return parseFloat(s.replace(/,/g, ''));
  }

  function applyK(val, raw) {
    if (/[kK]/.test(raw)) return val * 1000;
    return val;
  }

  // Minimum threshold per interval
  function isValidRange(min, max, interval) {
    if (min > max) return false;
    if (max > 50000000) return false;
    if (interval === 'hourly') return min >= 5 && max >= min;
    if (interval === 'monthly') return min >= 500 && max >= min;
    if (interval === 'weekly') return min >= 100 && max >= min;
    return min >= 10000 && max >= min; // yearly
  }

  // ── Pattern 1: Oracle Cloud format "Minimum Salary: 53,000 USD Maximum Salary: 80,000 USD" ──
  const oracleMatch = text.match(
    /[Mm]inim(?:um)?\s*[Ss]alary\s*[:=]?\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*(USD|GBP|EUR|[A-Z]{3})?\s*(?:[-–—]|[Mm]axim(?:um)?\s*[Ss]alary\s*[:=]?\s*)(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*(USD|GBP|EUR|[A-Z]{3})?/
  );
  if (oracleMatch) {
    const min = parseNum(oracleMatch[1]);
    const max = parseNum(oracleMatch[3]);
    const currency = currencyMap[oracleMatch[2] || oracleMatch[4]] || 'USD';
    if (isValidRange(min, max, 'yearly')) {
      return { min: String(min), max: String(max), currency, interval: 'yearly' };
    }
  }

  // ── Pattern 2: Currency symbol ranges $120,000 - $180,000 ──
  const symbolRangeMatch = text.match(
    /([$£€]|[AC]\$)\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)\s*([kK])?\s*(?:[-–—]|to)\s*(?:[$£€]|[AC]\$)?\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)\s*([kK])?/
  );
  if (symbolRangeMatch) {
    const currency = currencyMap[symbolRangeMatch[1]] || 'USD';
    let min = parseNum(symbolRangeMatch[2]);
    let max = parseNum(symbolRangeMatch[4]);
    if (symbolRangeMatch[3]) min *= 1000;
    if (symbolRangeMatch[5] || symbolRangeMatch[3]) max *= 1000; // If min has K, max likely does too
    const interval = detectInterval(text, symbolRangeMatch.index, symbolRangeMatch.index + symbolRangeMatch[0].length);
    if (isValidRange(min, max, interval)) {
      return { min: String(min), max: String(max), currency, interval };
    }
  }

  // ── Pattern 3: Code-prefixed ranges 120,000 USD - 180,000 USD ──
  const codeRangeMatch = text.match(
    /(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*([kK])?\s*(USD|GBP|EUR|AUD|CAD|CHF|SGD|INR|JPY|CNY|BRL|MXN|ZAR)\s*(?:[-–—]|to)\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*([kK])?\s*(?:USD|GBP|EUR|AUD|CAD|CHF|SGD|INR|JPY|CNY|BRL|MXN|ZAR)?/
  );
  if (codeRangeMatch) {
    const currency = currencyMap[codeRangeMatch[3]] || codeRangeMatch[3];
    let min = parseNum(codeRangeMatch[1]);
    let max = parseNum(codeRangeMatch[4]);
    if (codeRangeMatch[2]) min *= 1000;
    if (codeRangeMatch[5] || codeRangeMatch[2]) max *= 1000;
    const interval = detectInterval(text, codeRangeMatch.index, codeRangeMatch.index + codeRangeMatch[0].length);
    if (isValidRange(min, max, interval)) {
      return { min: String(min), max: String(max), currency, interval };
    }
  }

  // ── Pattern 4: Single salary with context "$85,000" or "salary of $120,000" ──
  const singleMatch = text.match(
    /(?:salary|compensation|pay|base|total\s*comp|starting\s*at|up\s*to|earning)\s*(?:range\s*)?(?:of\s*|is\s*|:\s*|=\s*)?([$£€]|[AC]\$)\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)\s*([kK])?/i
  );
  if (singleMatch) {
    const currency = currencyMap[singleMatch[1]] || 'USD';
    let val = parseNum(singleMatch[2]);
    if (singleMatch[3]) val *= 1000;
    const interval = detectInterval(text, singleMatch.index, singleMatch.index + singleMatch[0].length);
    if (isValidRange(val, val, interval)) {
      return { min: String(val), max: String(val), currency, interval };
    }
  }

  // ── Pattern 5: Single amount with currency code "53,000 USD" near salary context ──
  const singleCodeMatch = text.match(
    /(?:salary|compensation|pay|base|earn)\s*(?:range\s*)?(?:of\s*|is\s*|:\s*|=\s*)?(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*([kK])?\s*(USD|GBP|EUR|AUD|CAD|CHF|SGD|INR)/i
  );
  if (singleCodeMatch) {
    const currency = currencyMap[singleCodeMatch[3]] || singleCodeMatch[3];
    let val = parseNum(singleCodeMatch[1]);
    if (singleCodeMatch[2]) val *= 1000;
    if (isValidRange(val, val, 'yearly')) {
      return { min: String(val), max: String(val), currency, interval: 'yearly' };
    }
  }

  // ── Pattern 6: Pay range label "Pay Range: $22 - $28" ──
  const payRangeMatch = text.match(
    /(?:pay\s*range|hourly\s*rate|rate)\s*[:=]?\s*([$£€])\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)\s*[-–—to]+\s*(?:[$£€])?\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)/i
  );
  if (payRangeMatch) {
    const currency = currencyMap[payRangeMatch[1]] || 'USD';
    const min = parseNum(payRangeMatch[2]);
    const max = parseNum(payRangeMatch[3]);
    const interval = detectInterval(text, payRangeMatch.index, payRangeMatch.index + payRangeMatch[0].length);
    if (isValidRange(min, max, interval)) {
      return { min: String(min), max: String(max), currency, interval };
    }
  }

  return null;
}

/**
 * Detect workplace type from job fields.
 */
// A location that is ONLY a global token -- "Global", "Worldwide", "Anywhere", "Remote - Global
// Anywhere" -- is the employer's own structured statement that the role has no place attached.
// Anchored to the whole string on purpose, because "global" is common inside real place and
// office names: "Bonifacio Global City, , Philippines" (a district of Manila), "NYC Global HQ",
// "Berlin | Global Team" must NOT be read as worldwide, and a substring test reads all three
// as global. Verified against the live corpus: this matches 972 jobs and excludes every one of
// those.
const LOCATION_IS_GLOBAL = /^\s*(remote\s*[-–—:]?\s*)?(global|worldwide|anywhere)(\s+(anywhere|global|remote))?\s*$/i;

// Non-English work-model wording. The English rules below read "remote" and "hybrid" and nothing
// else, so a German, Italian, French, Spanish or Dutch posting stayed untagged -- or, worse, a
// German "Remote-Arbeit und Präsenztage" (remote work AND office days) read as fully remote.
// Measured on "scrum master / agile coach" in Germany + Italy, 2026-09-28: 48 postings, every one
// hybrid or on-site by its own text ("flexible Arbeitszeiten im Homeoffice und Büro", "smart
// working – hybrid"), 5 untagged and 1 tagged on-site against its text.
//
// Fully remote, in so many words, in the other languages. Checked first: these are unambiguous.
// English "100% remote" is left to the English rules below, which also see "not able to offer a
// permanent 100% remote option" next to "hybrid arrangement" and correctly call it hybrid.
const FULL_REMOTE_INTL = new RegExp([
  '100\\s?%\\s?(?:homeoffice|home-office|mobil|télétravail|teletravail|teletrabajo|remoto|da remoto|thuiswerk)',
  '(?:vollständig|vollstaendig|komplett|ausschließlich|ausschliesslich|voll)\\s+(?:remote|im homeoffice|aus dem homeoffice)',
  '(?:completamente|totalmente|interamente)\\s+(?:da\\s+)?remoto',
  'remoto\\s+al\\s+100',
  'full\\s+télétravail|télétravail\\s+(?:complet|total|à\\s*100)',
  'teletrabajo\\s+(?:completo|total|100)',
  'volledig\\s+(?:remote|thuis)',
].join('|'), 'i');
// Explicitly hybrid: the word in any of these languages, office days named alongside home
// working, or remote days counted per week. The German and Dutch inflected forms count only next to
// a work word: "hybride Hotellerie" and "einem hybriden System" are about hotels and software. English wording is deliberately absent beyond the
// word "hybrid" itself -- measured on a 29k live sample, "home office" is as often a US company's
// headquarters ("our home office in Louisville"), a stipend or an insurance product, and "3 days
// per week" as often a shift pattern, as a work model. \b on both ends of "hybrid": Word-exported
// HTML carries "hybridMultilevel" in its list markup.
const HYBRID_INTL = new RegExp([
  '\\bhybrid\\b', '\\bhybride[nrs]?\\s+(?:arbeit\\w*|modell\\w*|werken|work\\w*|model|arbeitsmodell|arbeitsweise)', '\\bwerkplek:?\\s*hybride\\b', '\\bibrid[oa]\\b', '\\bh[ií]brid[oa]\\b', '\\bsmart[\\s-]?working\\b',
  '\\blavoro agile\\b', '\\bdeels thuis\\b', // A few office days a quarter or a year is a remote job with meetups, not hybrid.
  'pr(?:ä|ae)senz(?:tag|zeit)(?:e|en)?\\b(?!\\s+(?:pro|im|per|je)\\s+(?:quartal|jahr|halbjahr))',
  '\\b(?:homeoffice|home-office|mobil(?:es|em)? arbeiten)\\b.{0,60}\\b(?:büro|buero|vor ort|standort)',
  '\\b(?:büro|buero|vor ort)\\b.{0,60}\\b(?:homeoffice|home-office|mobil(?:es|em)? arbeiten)\\b',
  '\\b[1-4]\\s*(?:tag|tage|giorn[oi]|jours?|d[ií]as?)\\s*(?:\\/|pro|in der|a|alla|par|por|a la)\\s*(?:woche|settimana|semaine|semana)\\b',
].join('|'), 'i');
// Home working offered without saying how much of it. Read as hybrid only when nothing else in the
// text says remote -- "Homeoffice" in a fully remote German posting must not demote it. The German
// one-word spelling only: the English "home office" is usually a headquarters (see above).
const HOME_WORK_INTL = /\bhomeoffice\b|\bhome-office\b(?=.{0,30}\b(?:möglich|tage?|anteil|regelung|option)\b)|\bmobil(?:es|em)?\s+arbeiten\b|\btélétravail\b|\bteletravail\b|\bteletrabajo\b|\bthuiswerk(?:en)?\b|\blavoro da remoto\b/i;

function extractWorkplaceType(title, location, description) {
  // Checked BEFORE the combined blob below, which is the bug this guards.
  //
  // That blob joins title + location + description and tests /\bhybrid\b/ across all of it, so a
  // single word in a long body overrode the location entirely. Measured on greenhouse/platacard
  // "Risk Data Governance Lead", location "Worldwide", whose 11,117-character description says
  // "Git-based, wiki, or hybrid" -- about DOCUMENTATION TOOLING. That set workplace_type
  // 'hybrid', and classifyRemote() short-circuits on that before it ever looks at the location,
  // so is_remote became false and remote_worldwide with it, dropping a confirmed
  // work-from-anywhere job off the global-remote board. 201 live jobs whose location is purely a
  // global token were stored Onsite or Hybrid this way.
  //
  // The location's own wording can still say hybrid/on-site ("USA and Global (Hybrid)"), which
  // fails the anchored match above and falls through to the normal rules.
  if (LOCATION_IS_GLOBAL.test(location || '')) return 'remote';

  const fields = [title, location, description].filter(Boolean).join(' ').toLowerCase();

  // Unless hybrid is named too: "hasta 20 días al año de trabajo 100% remoto" is a perk on a hybrid
  // job, and "ob voll remote oder in einem unserer Büros" offers a choice.
  if (FULL_REMOTE_INTL.test(fields) && !HYBRID_INTL.test(fields)) return 'remote';
  if (/\bremote\b|\bwork from home\b|\bwfh\b|\bfully remote\b|\b100% remote\b/.test(fields)) {
    if (HYBRID_INTL.test(fields)) return 'hybrid';
    return 'remote';
  }
  if (/\bflex\s*office\b|\bpartially remote\b/.test(fields) || HYBRID_INTL.test(fields)) return 'hybrid';
  if (HOME_WORK_INTL.test(fields)) return 'hybrid';
  if (/\bon-site\b|\bonsite\b|\bin-office\b|\bin office\b|\bon site\b/.test(fields)) return 'onsite';

  return null;
}

// A description saying fully remote in so many words. The crawl-time rule above calls a job remote
// on the bare word anywhere in its text, which on a 20k live sample of late-fetched descriptions was
// wrong about half the time: "not conducive of telecommuting or remote work", "remote access",
// "ocean remote sensing", "the remote and calming areas of Sandbridge", a nurse role whose
// employer notes that SOME positions are remote.
const STRONG_REMOTE_EN = new RegExp([
  '\\b(?:is|be|are|operating in an?)\\s+(?:100%|fully|completely|entirely|permanently)\\s+remote\\b',
  '\\b(?:fully|100%|completely|entirely|permanently)\\s+remote\\s+(?:position|role|job|opportunity|capacity|company|team)\\b',
  '\\b(?:is|as)\\s+(?:(?!not\\b)\\w+\\s+)?an?\\s+(?:(?!not\\b)\\w+\\s+)?remote\\s+(?:position|role|job|opportunity)\\b',
  '\\bremote[\\s-](?:first|only)\\b', '\\bwork\\s+from\\s+anywhere\\b', '#li-remote\\b',
].join('|'), 'i');
// ...and the ways postings say the opposite with the same words: "this is not a remote position"
// (Kimley-Horn, on every posting), "fully remote work is not available", "does not apply to fully
// remote roles", "exceptions will be granted for those in fully remote status".
const NOT_REMOTE_EN = /\bnot\s+(?:an?\s+)?(?:\w+\s+)?remote\b|\bnon[\s-]remote\b|\bno\s+remote\b|\bremote(?:\s+work)?\s+is\s+not\b|\bdoes\s+not\s+apply\s+to\s+(?:fully\s+)?remote\b|\bexceptions?\b.{0,80}\bremote\b/i;
// Remote as part of a thing, not a work model: "Senior Program Manager - Remote Sensing".
const REMOTE_IN_HEAD = /\bremote\b(?!\s+(?:sensing|monitoring|access|patient|pilot|operations?\s+cent(?:er|re)))|\btelecommute\b|\bwork from home\b/i;

/**
 * extractWorkplaceType for a description fetched after the crawl, which is written onto a job the
 * crawl left untagged and so puts it in or out of remote searches on the text alone. Hybrid and
 * on-site read as the crawl reads them; remote needs the title or location to say so, or the text
 * to say it unambiguously. Anything weaker leaves the job untagged, as it was.
 */
function extractWorkplaceTypeFromDescription(title, location, description) {
  const wt = extractWorkplaceType(title, location, description);
  if (wt !== 'remote') return wt;
  const head = `${title || ''} ${location || ''}`;
  if (REMOTE_IN_HEAD.test(head) || LOCATION_IS_GLOBAL.test(location || '')) return 'remote';
  const text = String(description || '');
  if (NOT_REMOTE_EN.test(text)) return null;
  if (FULL_REMOTE_INTL.test(text) || STRONG_REMOTE_EN.test(text)) return 'remote';
  return null;
}

/**
 * Detect employment type from job fields.
 */
function extractEmploymentType(title, description) {
  const text = [title, description].filter(Boolean).join(' ').toLowerCase();

  if (/\bfull[\s-]?time\b/.test(text)) return 'Full-time';
  if (/\bpart[\s-]?time\b/.test(text)) return 'Part-time';
  if (/\bcontract(?:or)?\b|\bfreelance\b|\b1099\b/.test(text)) return 'Contract';
  if (/\binternship\b|\bintern\b/.test(text)) return 'Internship';
  if (/\btemporary\b|\btemp\b/.test(text)) return 'Temporary';

  return null;
}

// Canonical employment types. Every ATS spells these differently and we stored whatever they
// sent: 4,784 distinct values across 1.87M live jobs, of which "Full time", "Full-time",
// "Full-Time", "Full Time", "FULL_TIME", "FullTime", "full_time" and "fulltime_permanent" are
// all the same thing. That made the sidebar facet useless (thousands of "types") and the
// employment_type filter unreliable, since a user picking one spelling missed the rest.
const EMPLOYMENT_TYPES = ['Full-time', 'Part-time', 'Contract', 'Internship', 'Temporary', 'Volunteer'];

function normalizeEmploymentType(raw) {
  if (!raw) return null;
  // Strip HTML entities and separators so "Full &amp; Part-Time" / "full_time" both reduce.
  const t = String(raw).toLowerCase().replace(/&amp;/g, '&').replace(/[_/]+/g, ' ').trim();
  if (!t || t === 'other' || t === 'n/a' || t === 'unknown' || t === 'none') return null;

  // Order matters. Internship and temporary win over the full/part qualifier that usually
  // accompanies them ("Internship - Full Time" is an internship). Part-time is checked before
  // full-time because "Permanent - Part Time" contains both signals and part-time is the
  // specific one.
  // Non-English spellings are checked before the English "temp" rule on purpose: French
  // "temps plein" (full time) must not be read as "temporary".
  if (/\btemps plein\b/.test(t)) return 'Full-time';
  if (/\btemps partiel\b/.test(t)) return 'Part-time';

  if (/\bintern(ship)?\b|\bstagiaire\b|\bpracticante\b/.test(t)) return 'Internship';
  if (/\bvolunteer\b|\bvoluntario\b/.test(t)) return 'Volunteer';
  // PRN and per-diem are the healthcare boards' term for shift-by-shift work.
  if (/\btemp(orary)?\b|\bseasonal\b|\bfixed[\s-]?term\b|\binterim\b|\bcasual\b|\bprn\b|\bper[\s-]?diem\b/.test(t)) return 'Temporary';
  if (/\bcontract(or|ed)?\b|\bfreelance\b|\b1099\b|\bconsultant\b|\bb2b\b|\bcontrato\b/.test(t)) return 'Contract';
  if (/\bpart[\s-]?time\b|\bparttime\b|\bmoonlight(er)?\b|\bmedio tiempo\b|\btiempo parcial\b|\bteilzeit\b/.test(t)) return 'Part-time';
  if (/\bfull[\s-]?time\b|\bfulltime\b|\bpermanent\b|\bregular\b|\btiempo completo\b|\bvollzeit\b/.test(t)) return 'Full-time';
  return null; // unrecognised free text is dropped rather than shown as a filter option
}


// Canonical workplace types. Same disease as employment_type, smaller: the column holds 9
// distinct values that are really three concepts (onsite / on_site / OnSite / On-site), which
// forced the work_mode filter to use unindexable ILIKE matching.
const WORKPLACE_TYPES = ['Remote', 'Hybrid', 'Onsite'];

function normalizeWorkplaceType(raw) {
  if (!raw) return null;
  const t = String(raw).toLowerCase().replace(/[_\-\s]+/g, ' ').trim();
  if (!t || t === 'unspecified' || t === 'other' || t === 'n/a' || t === 'unknown') return null;
  if (/\bhybrid\b/.test(t)) return 'Hybrid';                 // before remote: "hybrid remote" is hybrid
  if (/\bremote\b|\bwork from home\b|\bwfh\b/.test(t)) return 'Remote';
  if (/\bon ?site\b|\bin office\b|\bin person\b|\boffice\b/.test(t)) return 'Onsite';
  return null;
}

module.exports = { extractSalary, extractWorkplaceType, extractWorkplaceTypeFromDescription, extractEmploymentType, normalizeEmploymentType, EMPLOYMENT_TYPES, normalizeWorkplaceType, WORKPLACE_TYPES };
