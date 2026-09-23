/**
 * Region and bloc resolution for the location filter, plus spelling normalisation.
 *
 * WHY THIS EXISTS. No job posting says its location is "European Union" — it says "Berlin,
 * Germany" or "Dublin, Ireland". So a search for a bloc, a continent or a regional acronym
 * matches almost nothing, no matter how many jobs are in the corpus. Buying more inventory does
 * not fix it; the search has to translate the region into the countries it contains.
 *
 * MEASURED, not assumed. Replaying 60 of the highest-volume searches that search_demand recorded
 * as returning zero: 50 of them now return results on their own (the corpus and the
 * location_tokens work caught up). The 10 that are still empty account for 54,652 searches, and
 * they break down as:
 *
 *   ~41,000  regions and blocs   european union, north america, central america, apac, anz
 *   ~13,300  misspelled / non-English   british colombia, españa, slowaki
 *      ~100  genuinely malformed        smart quotes, truncations, typos
 *
 * So region expansion is where nearly all the recoverable demand is.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not guess. Every mapping here is a place name with
 * one obvious meaning; nothing is inferred from edit distance, because "Georgia" is both a
 * country and a US state and a fuzzy matcher would happily merge them. Terms it does not
 * recognise are returned unchanged, so the existing country/token path handles them exactly as
 * before — this can add matches, never remove them.
 */

// Spellings that resolve to a single country but that resolveCountry() does not know: local-language
// names, and misspellings seen in real traffic. Keys are lowercased and accent-stripped.
const SPELLING = {
  espana: 'spain',
  deutschland: 'germany',
  osterreich: 'austria',
  suisse: 'switzerland',
  schweiz: 'switzerland',
  italia: 'italy',
  brasil: 'brazil',
  mexico: 'mexico',
  nippon: 'japan',
  nihon: 'japan',
  holland: 'netherlands',
  'the netherlands': 'netherlands',
  // Offered as their own options by FastApply's location pickers, which save the name as picked.
  'bosna i hercegovina': 'bosnia and herzegovina',
  shqiperi: 'albania',
  cameroun: 'cameroon',
  mocambique: 'mozambique',
  // Straight misspellings observed in search_demand.
  slowaki: 'slovakia',
  slowakia: 'slovakia',
  'british colombia': 'british columbia',
  phillipines: 'philippines',
  philipines: 'philippines',
  singapor: 'singapore',
  'south korea': 'korea, republic of',
  'united arab emirate': 'united arab emirates',
  england: 'united kingdom',
  scotland: 'united kingdom',
  wales: 'united kingdom',
  britain: 'united kingdom',
  'great britain': 'united kingdom',
};

// Blocs, continents and the regional acronyms recruiters actually type. Values are ISO-3166
// alpha-2 codes, which is what meili.js writes into location_countries at index time.
//
// Kept to countries with a realistic share of English-language postings — a full continent list
// would push the filter past a useful size for no extra matches. EU is the exception: it is a
// legal bloc with a fixed membership, so all 27 belong.
const REGIONS = {
  'european union': ['at', 'be', 'bg', 'hr', 'cy', 'cz', 'dk', 'ee', 'fi', 'fr', 'de', 'gr',
    'hu', 'ie', 'it', 'lv', 'lt', 'lu', 'mt', 'nl', 'pl', 'pt', 'ro', 'sk', 'si', 'es', 'se'],
  eu: ['at', 'be', 'bg', 'hr', 'cy', 'cz', 'dk', 'ee', 'fi', 'fr', 'de', 'gr',
    'hu', 'ie', 'it', 'lv', 'lt', 'lu', 'mt', 'nl', 'pl', 'pt', 'ro', 'sk', 'si', 'es', 'se'],
  // Europe is wider than the EU — the UK, Switzerland, Norway and Ukraine carry real volume.
  europe: ['gb', 'ie', 'de', 'fr', 'es', 'it', 'nl', 'be', 'pt', 'se', 'dk', 'no', 'fi', 'is',
    'pl', 'cz', 'at', 'ch', 'gr', 'ro', 'hu', 'sk', 'bg', 'hr', 'si', 'lt', 'lv', 'ee', 'lu',
    'mt', 'cy', 'ua', 'rs'],
  emea: ['gb', 'ie', 'de', 'fr', 'es', 'it', 'nl', 'be', 'se', 'dk', 'no', 'fi', 'pl', 'cz',
    'at', 'ch', 'pt', 'gr', 'ro', 'hu', 'ae', 'sa', 'il', 'tr', 'eg', 'za', 'ng', 'ke', 'ma'],
  'north america': ['us', 'ca', 'mx'],
  'central america': ['mx', 'gt', 'bz', 'sv', 'hn', 'ni', 'cr', 'pa'],
  'south america': ['br', 'ar', 'cl', 'co', 'pe', 'uy', 'py', 'bo', 'ec', 've'],
  'latin america': ['mx', 'br', 'ar', 'cl', 'co', 'pe', 'uy', 'cr', 'pa', 'gt', 'ec', 'do'],
  latam: ['mx', 'br', 'ar', 'cl', 'co', 'pe', 'uy', 'cr', 'pa', 'gt', 'ec', 'do'],
  americas: ['us', 'ca', 'mx', 'br', 'ar', 'cl', 'co', 'pe', 'cr', 'pa', 'uy'],
  apac: ['au', 'nz', 'sg', 'jp', 'in', 'cn', 'kr', 'hk', 'tw', 'my', 'th', 'ph', 'id', 'vn'],
  'asia pacific': ['au', 'nz', 'sg', 'jp', 'in', 'cn', 'kr', 'hk', 'tw', 'my', 'th', 'ph', 'id', 'vn'],
  apj: ['au', 'nz', 'sg', 'jp', 'in', 'kr', 'hk', 'tw', 'my', 'th', 'ph', 'id', 'vn'],
  asia: ['in', 'cn', 'jp', 'kr', 'sg', 'hk', 'tw', 'my', 'th', 'ph', 'id', 'vn', 'ae', 'sa', 'il', 'pk', 'bd'],
  'southeast asia': ['sg', 'my', 'th', 'ph', 'id', 'vn', 'kh', 'la', 'mm'],
  anz: ['au', 'nz'],
  'australia and new zealand': ['au', 'nz'],
  'middle east': ['ae', 'sa', 'il', 'qa', 'kw', 'bh', 'om', 'jo', 'lb', 'tr'],
  mena: ['ae', 'sa', 'il', 'qa', 'kw', 'bh', 'om', 'jo', 'lb', 'eg', 'ma', 'tn', 'dz'],
  gcc: ['ae', 'sa', 'qa', 'kw', 'bh', 'om'],
  africa: ['za', 'ng', 'ke', 'eg', 'gh', 'ma', 'tz', 'ug', 'rw', 'et', 'sn', 'ci'],
  nordics: ['se', 'no', 'dk', 'fi', 'is'],
  scandinavia: ['se', 'no', 'dk'],
  benelux: ['nl', 'be', 'lu'],
  dach: ['de', 'at', 'ch'],
  uki: ['gb', 'ie'],
  'uk and ireland': ['gb', 'ie'],
};

/** Lowercase, strip accents and punctuation, collapse whitespace. */
function norm(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // Smart quotes appear in real traffic ("remote" with curly quotes returned zero results).
    .replace(/[‘’“”]/g, '')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** ISO codes for a region term, or null if the term is not a region. */
function regionCountries(term) {
  const key = norm(term);
  return REGIONS[key] ? [...REGIONS[key]] : null;
}

/**
 * Canonical spelling for a term, or null if there is no correction.
 * Returns a place name for the caller to feed back into resolveCountry().
 */
function canonicalSpelling(term) {
  const key = norm(term);
  return SPELLING[key] || null;
}

module.exports = { regionCountries, canonicalSpelling, norm, REGIONS, SPELLING };
