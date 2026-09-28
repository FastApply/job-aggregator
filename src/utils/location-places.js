/**
 * Place names that searchers type but postings never write, translated into what postings do write.
 *
 * WHY. location_tokens is an exact-match filter over the posting's own words, so a search only
 * finds postings that spell the place the same way. Three spellings that real searches use missed
 * almost everything (search_demand, 30 days to 2026-09-28):
 *
 *   US state names   "Illinois" (7k), "Georgia" (73k), "Texas" (57k), ...  Postings mostly write the
 *                    two-letter code: "Chicago, IL" is tokenised ["chicago", "il"], so a search for
 *                    Illinois never saw it. The name is matched as before, and the code is added —
 *                    but only on a posting already tagged as US, because a bare code is not safe on
 *                    its own ("CA" is also Canada, "DE" Germany, "IN" India).
 *   Suffixed names   "New York State" (23k), "Lagos State", "Greater London". The suffix is not
 *                    part of any posting's location, so "new york state" matched nothing at all.
 *   Metro areas      "Delhi NCR" (45k), "Greater Toronto Area", "Bay Area". A posting names the city
 *                    it is in — Gurugram, Mississauga, Palo Alto — not the region around it.
 *
 * Like location-regions.js, nothing here guesses: every entry is a name with one meaning, and the
 * original term is always kept, so this can only add matches.
 */
const { norm } = require('./location-norm');

// Full state name -> USPS code. District of Columbia and Puerto Rico included: postings write "DC"
// and "PR" the same way. Montana is left out: "mt" is also the "Mt." of Mt. Pleasant and Mt. Kisco,
// which made up 157 of 1,000 sampled US postings carrying the token (live index, 2026-09-28).
// The other word-like codes measured at 0-2% stray matches ("De Pere, WI" for Delaware, "Aspen or
// Snowmass" for Oregon) and stay, since they recover thousands of "City, ST" postings each.
const US_STATE_CODES = {
  alabama: 'al', alaska: 'ak', arizona: 'az', arkansas: 'ar', california: 'ca', colorado: 'co',
  connecticut: 'ct', delaware: 'de', florida: 'fl', georgia: 'ga', hawaii: 'hi', idaho: 'id',
  illinois: 'il', indiana: 'in', iowa: 'ia', kansas: 'ks', kentucky: 'ky', louisiana: 'la',
  maine: 'me', maryland: 'md', massachusetts: 'ma', michigan: 'mi', minnesota: 'mn',
  mississippi: 'ms', missouri: 'mo', nebraska: 'ne', nevada: 'nv',
  'new hampshire': 'nh', 'new jersey': 'nj', 'new mexico': 'nm', 'new york': 'ny',
  'north carolina': 'nc', 'north dakota': 'nd', ohio: 'oh', oklahoma: 'ok', oregon: 'or',
  pennsylvania: 'pa', 'rhode island': 'ri', 'south carolina': 'sc', 'south dakota': 'sd',
  tennessee: 'tn', texas: 'tx', utah: 'ut', vermont: 'vt', virginia: 'va', washington: 'wa',
  'west virginia': 'wv', wisconsin: 'wi', wyoming: 'wy', 'district of columbia': 'dc',
  'puerto rico': 'pr',
};

// A metro or region -> the cities postings inside it actually name. Only regions with one meaning:
// a bare "NCR" is also Metro Manila, so only "Delhi NCR" is here.
const METROS = {
  'delhi ncr': ['delhi', 'new delhi', 'gurugram', 'gurgaon', 'noida', 'greater noida', 'faridabad', 'ghaziabad'],
  'greater toronto area': ['toronto', 'mississauga', 'brampton', 'markham', 'vaughan', 'oakville', 'richmond hill'],
  gta: ['toronto', 'mississauga', 'brampton', 'markham', 'vaughan', 'oakville', 'richmond hill'],
  'bay area': ['san francisco', 'oakland', 'san jose', 'palo alto', 'mountain view', 'sunnyvale',
    'menlo park', 'redwood city', 'santa clara', 'berkeley', 'fremont', 'san mateo', 'cupertino'],
};
METROS['san francisco bay area'] = METROS['bay area'];
METROS['sf bay area'] = METROS['bay area'];

// "Greater London", "New York State", "Lagos State", "Eastern Province", "Seattle Metro Area".
const PREFIX_RE = /^greater\s+/;
const SUFFIX_RE = /\s+(?:state|province|metro(?:politan)? area|metro|area)$/;
// What a stripped wrapper must not leave behind: a word that names no place on its own and would
// match every posting carrying it ("United State" -> "united", "Eastern Province" -> "eastern").
const GENERIC = new Set(['united', 'free', 'new', 'central', 'capital', 'eastern', 'western', 'northern',
  'southern', 'north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest']);

/**
 * Every place name a posting might use for `term`: the term itself first, then a metro's cities or
 * the term with its "Greater"/"State"/"Area" wrapper removed. Returns folded names.
 */
function placeVariants(term) {
  const t = norm(term);
  if (!t) return [];
  const out = [t];
  if (METROS[t]) out.push(...METROS[t]);
  else {
    const bare = t.replace(PREFIX_RE, '').replace(SUFFIX_RE, '').trim();
    if (bare && bare !== t && !GENERIC.has(bare)) out.push(...(METROS[bare] ? [bare, ...METROS[bare]] : [bare]));
  }
  return [...new Set(out)];
}

/** USPS code for a folded US state name, or null. */
function usStateCode(name) {
  return US_STATE_CODES[name] || null;
}

module.exports = { placeVariants, usStateCode, US_STATE_CODES, METROS };
