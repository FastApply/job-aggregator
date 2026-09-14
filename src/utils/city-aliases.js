/**
 * Cities that job postings spell more than one way: the local name, the English name, and the
 * ASCII transliteration German speakers type (ue/oe/ae). Every member of a group is written in
 * the folded form location-norm.js produces, because that is what location_tokens holds.
 *
 * WHY. location_tokens is an exact-match filter, so "Milan" and "Milano" were disjoint sets —
 * 499 vs 282 on the live board 2026-09-14, "Warsaw" 1,193 vs "Warszawa" 186 — and a "Munich"
 * search returned 1,500 while 6,032 postings were written "München". A German user picking
 * Munich saw a quarter of what exists; picking Köln saw nothing (see location-norm.js).
 *
 * At index time every member of a group is written into location_tokens, so either spelling
 * finds the posting. At query time the term expands to its group too, which is what makes the
 * change take effect for postings indexed before the backfill re-runs.
 *
 * Only pairs that name one place belong here. A city whose English name is also a sizeable US
 * job market is left out on purpose — Athens (GA), Florence (SC), Naples (FL), Venice (CA),
 * Hanover (PA), Canton (OH), Brunswick / New Brunswick — because merging it with the European
 * city would hand a US search foreign postings. For those only the non-English spellings are
 * grouped, so "Firenze" and "Florenz" still find each other. Three-letter forms ("Rom", "Åbo")
 * are out for the same reason: too short to be safe as a whole-token alias.
 */
const GROUPS = [
  // Germany
  ['munich', 'munchen', 'muenchen'],
  ['cologne', 'koln', 'koeln'],
  ['nuremberg', 'nurnberg', 'nuernberg'],
  ['dusseldorf', 'duesseldorf'],
  ['frankfurt', 'frankfurt am main'],
  ['gottingen', 'goettingen'],
  ['lubeck', 'luebeck'],
  ['osnabruck', 'osnabrueck'],
  ['saarbrucken', 'saarbruecken'],
  ['tubingen', 'tuebingen'],
  ['wurzburg', 'wuerzburg'],
  // Austria / Switzerland
  ['vienna', 'wien'],
  ['zurich', 'zuerich'],
  ['geneva', 'geneve', 'genf'],
  ['basel', 'bale', 'basle'],
  ['bern', 'berne'],
  ['lucerne', 'luzern'],
  // Italy
  ['milan', 'milano', 'mailand'],
  ['rome', 'roma'],
  ['turin', 'torino'],
  ['napoli', 'neapel'],
  ['firenze', 'florenz'],
  ['venezia', 'venedig'],
  ['genoa', 'genova', 'genua'],
  ['padua', 'padova'],
  // Spain / Portugal
  ['seville', 'sevilla'],
  ['zaragoza', 'saragossa'],
  ['san sebastian', 'donostia'],
  ['a coruna', 'la coruna', 'corunna'],
  ['lisbon', 'lisboa', 'lissabon'],
  ['porto', 'oporto'],
  // Benelux / Nordics
  ['brussels', 'bruxelles', 'brussel'],
  ['antwerp', 'antwerpen', 'anvers'],
  ['ghent', 'gent', 'gand'],
  ['bruges', 'brugge'],
  ['the hague', 'den haag', "'s-gravenhage", 's gravenhage'],
  ['copenhagen', 'kobenhavn', 'kopenhagen'],
  ['aarhus', 'arhus'],
  ['gothenburg', 'goteborg'],
  ['helsinki', 'helsingfors'],
  // Central / Eastern Europe
  ['prague', 'praha', 'prag'],
  ['warsaw', 'warszawa', 'warschau'],
  ['cracow', 'krakow', 'krakau'],
  ['wroclaw', 'breslau'],
  ['gdansk', 'danzig'],
  ['poznan', 'posen'],
  ['athina', 'athen'],
  ['bucharest', 'bucuresti', 'bukarest'],
  ['belgrade', 'beograd'],
  ['sofia', 'sofiya'],
  ['kyiv', 'kiev'],
  ['moscow', 'moskva', 'moskau'],
  ['saint petersburg', 'st petersburg', 'st. petersburg', 'sankt peterburg'],
  // France
  ['marseille', 'marseilles'],
  ['lyon', 'lyons'],
  ['strasbourg', 'strassburg'],
  // Latin America
  ['mexico city', 'ciudad de mexico', 'cdmx'],
  ['havana', 'la habana'],
  // Asia / Middle East / Africa
  ['tokyo', 'tokio'],
  ['beijing', 'peking'],
  ['hong kong', 'hongkong'],
  ['busan', 'pusan'],
  ['mumbai', 'bombay'],
  ['kolkata', 'calcutta'],
  ['chennai', 'madras'],
  ['bengaluru', 'bangalore'],
  ['pune', 'poona'],
  ['kochi', 'cochin'],
  ['thiruvananthapuram', 'trivandrum'],
  ['vadodara', 'baroda'],
  ['ho chi minh city', 'saigon'],
  ['yangon', 'rangoon'],
  ['algiers', 'alger'],
  ['casablanca', 'dar el beida'],
  ['cairo', 'al qahira'],
];

const { norm } = require('./location-norm');

const MAP = new Map();
for (const g of GROUPS) {
  const folded = [...new Set(g.map(norm))];
  for (const a of folded) MAP.set(a, folded);
}

/** Every spelling of the place named by `token` (already folded), or null when it has one. */
function cityAliasGroup(token) {
  return MAP.get(token) || null;
}

/**
 * Query-side expansion: the folded term first, then its other spellings. A term with no group
 * comes back as a one-element list, so callers need no special case.
 */
function queryTokens(term) {
  const t = norm(term);
  const group = MAP.get(t);
  if (!group) return [t];
  return [t, ...group.filter((a) => a !== t)];
}

module.exports = { cityAliasGroup, queryTokens, GROUPS };
