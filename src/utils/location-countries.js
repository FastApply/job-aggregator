/**
 * Country resolution for job locations.
 *
 * Locations are free text from ~30 ATS platforms, so the same country arrives in every shape:
 * "London, England, GB, GB", "GB - London, United Kingdom", "Remote - United States",
 * "Navi Mumbai, Maharashtra, IN, IN". Postgres handles this with ILIKE plus a word-boundary
 * regex for short aliases (see location-aliases.js). Meilisearch has no word-boundary operator,
 * so `CONTAINS "us"` would return Houston and Austin.
 *
 * The fix is to resolve the country once, at index time, into a filterable code. An exact
 * filter on that code needs no substring matching and no fallback to Postgres.
 *
 * TWO-LETTER CODES ARE ONLY READ FROM THE LAST SEGMENT. "San Francisco, CA, US" must not be
 * tagged Canada, and "Indianapolis, IN, US" must not be tagged India — CA and IN are US state
 * codes as often as they are country codes. Country codes appear last in practice; state codes
 * do not. Spelled-out names are unambiguous and are matched anywhere in the string.
 */

// ISO 3166-1 alpha-2 -> primary name. Compact on purpose: this is data, not logic.
const TABLE = `
af:Afghanistan|al:Albania|dz:Algeria|ad:Andorra|ao:Angola|ag:Antigua and Barbuda|ar:Argentina|
am:Armenia|aw:Aruba|au:Australia|at:Austria|az:Azerbaijan|bs:Bahamas|bh:Bahrain|bd:Bangladesh|
bb:Barbados|by:Belarus|be:Belgium|bz:Belize|bj:Benin|bm:Bermuda|bt:Bhutan|bo:Bolivia|
ba:Bosnia and Herzegovina|bw:Botswana|br:Brazil|bn:Brunei|bg:Bulgaria|bf:Burkina Faso|bi:Burundi|
cv:Cabo Verde|kh:Cambodia|cm:Cameroon|ca:Canada|ky:Cayman Islands|cf:Central African Republic|
td:Chad|cl:Chile|cn:China|co:Colombia|km:Comoros|cg:Congo|cd:DR Congo|cr:Costa Rica|
ci:Cote d'Ivoire|hr:Croatia|cu:Cuba|cw:Curacao|cy:Cyprus|cz:Czechia|dk:Denmark|dj:Djibouti|
dm:Dominica|do:Dominican Republic|ec:Ecuador|eg:Egypt|sv:El Salvador|gq:Equatorial Guinea|
er:Eritrea|ee:Estonia|sz:Eswatini|et:Ethiopia|fo:Faroe Islands|fj:Fiji|fi:Finland|fr:France|
gf:French Guiana|pf:French Polynesia|ga:Gabon|gm:Gambia|ge:Georgia|de:Germany|gh:Ghana|
gi:Gibraltar|gr:Greece|gl:Greenland|gd:Grenada|gp:Guadeloupe|gu:Guam|gt:Guatemala|gg:Guernsey|
gn:Guinea|gw:Guinea-Bissau|gy:Guyana|ht:Haiti|hn:Honduras|hk:Hong Kong|hu:Hungary|is:Iceland|
in:India|id:Indonesia|ir:Iran|iq:Iraq|ie:Ireland|im:Isle of Man|il:Israel|it:Italy|jm:Jamaica|
jp:Japan|je:Jersey|jo:Jordan|kz:Kazakhstan|ke:Kenya|ki:Kiribati|kp:North Korea|kr:South Korea|
kw:Kuwait|kg:Kyrgyzstan|la:Laos|lv:Latvia|lb:Lebanon|ls:Lesotho|lr:Liberia|ly:Libya|
li:Liechtenstein|lt:Lithuania|lu:Luxembourg|mo:Macao|mg:Madagascar|mw:Malawi|my:Malaysia|
mv:Maldives|ml:Mali|mt:Malta|mh:Marshall Islands|mq:Martinique|mr:Mauritania|mu:Mauritius|
mx:Mexico|fm:Micronesia|md:Moldova|mc:Monaco|mn:Mongolia|me:Montenegro|ms:Montserrat|ma:Morocco|
mz:Mozambique|mm:Myanmar|na:Namibia|nr:Nauru|np:Nepal|nl:Netherlands|nc:New Caledonia|
nz:New Zealand|ni:Nicaragua|ne:Niger|ng:Nigeria|mk:North Macedonia|no:Norway|om:Oman|pk:Pakistan|
pw:Palau|ps:Palestine|pa:Panama|pg:Papua New Guinea|py:Paraguay|pe:Peru|ph:Philippines|pl:Poland|
pt:Portugal|pr:Puerto Rico|qa:Qatar|re:Reunion|ro:Romania|ru:Russia|rw:Rwanda|
kn:Saint Kitts and Nevis|lc:Saint Lucia|vc:Saint Vincent and the Grenadines|ws:Samoa|
sm:San Marino|st:Sao Tome and Principe|sa:Saudi Arabia|sn:Senegal|rs:Serbia|sc:Seychelles|
sl:Sierra Leone|sg:Singapore|sk:Slovakia|si:Slovenia|sb:Solomon Islands|so:Somalia|
za:South Africa|ss:South Sudan|es:Spain|lk:Sri Lanka|sd:Sudan|sr:Suriname|se:Sweden|
ch:Switzerland|sy:Syria|tw:Taiwan|tj:Tajikistan|tz:Tanzania|th:Thailand|tl:Timor-Leste|tg:Togo|
to:Tonga|tt:Trinidad and Tobago|tn:Tunisia|tr:Turkey|tm:Turkmenistan|tc:Turks and Caicos Islands|
tv:Tuvalu|ug:Uganda|ua:Ukraine|ae:United Arab Emirates|gb:United Kingdom|us:United States|
uy:Uruguay|uz:Uzbekistan|vu:Vanuatu|va:Vatican City|ve:Venezuela|vn:Vietnam|
vg:British Virgin Islands|vi:US Virgin Islands|eh:Western Sahara|ye:Yemen|zm:Zambia|zw:Zimbabwe
`;

// US state/territory abbreviations. Only used to veto a lone trailing two-letter code from being
// read as a country — see countriesFromLocation.
const US_STATES = new Set(['al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in',
  'ia','ks','ky','la','me','md','ma','mi','mn','ms','mo','mt','ne','nv','nh','nj','nm','ny','nc',
  'nd','oh','ok','or','pa','ri','sc','sd','tn','tx','ut','vt','va','wa','wv','wi','wy','dc','pr','vi','gu']);

/** code -> primary name */
const NAME = new Map();
/** normalised name or alias -> code */
const LOOKUP = new Map();

// Folds diacritics — see location-norm.js for why that is load-bearing. Everything below that
// scrubs `[^a-z0-9' ]` relies on the letters having been folded to ASCII first, not deleted.
const { norm } = require('./location-norm');
const { cityAliasGroup } = require('./city-aliases');

for (const entry of TABLE.split('|')) {
  const [code, name] = entry.split(':').map((x) => x && x.trim());
  if (!code || !name) continue;
  NAME.set(code, name);
  LOOKUP.set(code, code);
  LOOKUP.set(norm(name), code);
}

// Common variants people actually type or that ATS platforms actually emit. The UK constituent
// countries map to gb deliberately: "London, England, GB" is a United Kingdom job, and someone
// filtering by United Kingdom expects it.
//
// A list of pairs, not an object, so a country can appear more than once without a later entry
// silently replacing an earlier one.
//
// Local-language names (endonyms) and the names neighbouring languages use (exonyms) are in
// their FOLDED form, because norm() folds both the alias and the text before lookup:
// "Österreich" and "Oesterreich" arrive as "osterreich" / "oesterreich". They matter at INDEX
// time: a posting written "Madrid, España" carried no country code before they were here, so
// `location=Spain` — which resolves to es — never found it, even though the query side already
// mapped España to Spain. "Barcelona, Catalogne, Espagne" is a real SmartRecruiters location.
//
// Every entry names exactly one country when it appears in a location string. Multi-word
// entries use spaces, never hyphens: the n-gram scan sees scrubbed words. Deliberately absent
// because they are also place names elsewhere: "Island" (Ísland — inside thousands of US
// locations), "Franca" (a Brazilian city) for France, "Dania" (Dania Beach, FL) for Denmark.
// "Nederland" and "Holland" are in, with a veto for US towns of that name — see
// countriesFromLocation.
const ALIASES = [
  ['us', ['usa', 'u.s.', 'u.s.a.', 'america', 'united states of america',
    'etats unis', 'vereinigte staaten', 'estados unidos', 'stati uniti', 'verenigde staten',
    'stany zjednoczone']],
  ['gb', ['uk', 'u.k.', 'britain', 'great britain', 'england', 'scotland', 'wales',
    'northern ireland', 'royaume uni', 'grossbritannien', 'vereinigtes konigreich',
    'reino unido', 'regno unito', 'verenigd koninkrijk', 'wielka brytania']],
  ['ae', ['uae', 'emirates']],
  ['de', ['deutschland', 'allemagne', 'alemania', 'germania', 'duitsland', 'alemanha', 'niemcy']],
  ['fr', ['frankreich', 'francia', 'frankrijk', 'francja']],
  ['es', ['espana', 'espagne', 'spanien', 'spagna', 'spanje', 'espanha', 'hiszpania']],
  ['it', ['italia', 'italie', 'italien', 'wlochy']],
  ['nl', ['holland', 'the netherlands', 'nederland', 'pays bas', 'niederlande', 'paises bajos',
    'paesi bassi', 'holanda', 'paises baixos', 'holandia']],
  ['at', ['osterreich', 'oesterreich', 'autriche', 'oostenrijk']],
  ['ch', ['schweiz', 'suisse', 'svizzera', 'svizra', 'suiza', 'zwitserland', 'suica',
    'szwajcaria']],
  ['be', ['belgique', 'belgie', 'belgien', 'belgica', 'belgio']],
  ['lu', ['luxemburg', 'letzebuerg']],
  ['pt', ['portogallo']],
  ['pl', ['polska', 'pologne', 'polen', 'polonia']],
  ['cz', ['czech republic', 'cesko', 'ceska republika', 'tschechien', 'czechy']],
  ['hu', ['magyarorszag', 'hongrie', 'ungarn']],
  ['gr', ['ellada', 'hellas', 'grece', 'griechenland', 'grecia']],
  ['ie', ['eire', 'irlande', 'irland', 'irlanda', 'ierland', 'irlandia']],
  ['se', ['sverige', 'suede', 'schweden', 'suecia', 'svezia', 'zweden', 'szwecja']],
  ['no', ['norge', 'noreg', 'norvege', 'norwegen', 'noruega', 'norvegia', 'noorwegen',
    'norwegia']],
  ['dk', ['danmark', 'danemark', 'dinamarca', 'danimarca', 'denemarken']],
  ['fi', ['suomi', 'finlande', 'finnland', 'finlandia']],
  ['ro', ['roumanie', 'rumanien']],
  ['hr', ['hrvatska', 'kroatien']],
  ['sk', ['slovensko', 'slowakei']],
  ['si', ['slovenija', 'slowenien']],
  ['rs', ['srbija', 'serbien']],
  ['ua', ['ukraina']],
  ['lt', ['lietuva']],
  ['lv', ['latvija']],
  ['ee', ['eesti']],
  ['ru', ['russian federation', 'russie', 'russland', 'rusia']],
  ['tr', ['turkiye', 'turquie', 'turkei', 'turquia', 'turchia']],
  ['br', ['brasil', 'bresil', 'brasilien', 'brasile', 'brazilie']],
  ['mx', ['mexique', 'mexiko', 'messico']],
  ['ca', ['kanada']],
  ['do', ['republica dominicana']],
  ['nz', ['aotearoa']],
  ['ma', ['maroc']],
  ['dz', ['algerie']],
  ['tn', ['tunisie']],
  ['cn', ['chine', 'cina']],
  ['in', ['inde', 'indien']],
  ['jp', ['nippon', 'nihon', 'japon', 'japao', 'giappone']],
  ['kr', ['korea', 'republic of korea']],
  ['kp', ['dprk']],
  ['ci', ['ivory coast']],
  ['mm', ['burma']],
  ['cv', ['cape verde']],
  ['sz', ['swaziland']],
  ['mk', ['macedonia']],
  ['va', ['vatican', 'holy see']],
  ['tl', ['east timor']],
  ['cd', ['democratic republic of the congo', 'congo-kinshasa']],
  ['cg', ['republic of the congo', 'congo-brazzaville']],
  ['tw', ['republic of china']],
  ['vn', ['viet nam']],
  ['sy', ['syrian arab republic']],
  ['tz', ['united republic of tanzania']],
  ['bo', ['plurinational state of bolivia']],
  ['ve', ['bolivarian republic of venezuela']],
  ['ir', ['islamic republic of iran']],
  ['la', ["lao people's democratic republic"]],
  ['md', ['republic of moldova']],
];
for (const [code, list] of ALIASES) {
  for (const a of list) LOOKUP.set(norm(a), code);
}

// Aliases that are also the names of US towns: Nederland, TX; Holland, MI. See the veto in
// countriesFromLocation.
const US_TOWN_ALIASES = new Set(['nederland', 'holland']);

/**
 * Resolve a user-supplied location term to a country.
 * Returns { code, name } for a country, or null for a city/region/anything else.
 */
function resolveCountry(term) {
  const n = norm(term);
  const code = LOOKUP.get(n) || LOOKUP.get(n.replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim());
  return code ? { code, name: NAME.get(code) } : null;
}

/**
 * Extract country codes from a stored location string. Used at index time.
 *
 * Spelled-out names are matched in any segment. Two-letter codes are read ONLY from the final
 * segment — see the header note on CA/IN being US state codes.
 */
function countriesFromLocation(text) {
  // Dots go first so "Remote - U.S." reads as "us" in both scans below.
  const s = norm(text).replace(/\./g, '');
  if (!s) return [];

  const found = new Set();
  let dutchOnlyByUsTown = false;

  // Word n-grams, not substrings. A plain `includes` tags "Indianapolis" as India and
  // "Nigeria" as Niger, because both country names are substrings of the city/country that
  // contains them. Names run to four words ("saint vincent and the grenadines" is longer, but
  // its distinctive head matches at four).
  const words = s.replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
  for (let n = 1; n <= 4; n++) {
    for (let i = 0; i + n <= words.length; i++) {
      const key = words.slice(i, i + n).join(' ');
      if (key.length <= 2) continue; // two-letter codes only count in the final segment, below
      const code = LOOKUP.get(key);
      if (!code) continue;
      if (code === 'nl') dutchOnlyByUsTown = US_TOWN_ALIASES.has(key) && !found.has('nl');
      found.add(code);
    }
  }

  // Trailing two-letter code: "London, England, GB, GB" -> gb. Only here, never mid-string.
  //
  // AND never when it is a US state abbreviation that is not repeated. More than 20 US state
  // codes collide with ISO country codes, so "Wilmington, DE" was being tagged Germany,
  // "Richmond, VA" Vatican City and "Halethorpe, MD" Moldova — every US location written as
  // "City, ST" got a wrong country. Reading only the final segment (the earlier guard) does not
  // help here, because in "City, ST" the state IS the final segment.
  //
  // The tell is repetition: ATS platforms that emit a real country code double it —
  // "London, England, GB, GB", "Navi Mumbai, Maharashtra, IN, IN". A lone trailing state code
  // does not repeat. Where it is ambiguous and unrepeated ("Berlin, DE" could be Delaware or
  // Germany) emit nothing rather than guess: an unknown country is recoverable, a wrong one is
  // silently wrong in search results.
  const segments = s.split(/[,/]|\s+-\s+/).map((x) => x.trim()).filter(Boolean);
  const last = segments[segments.length - 1];
  const prev = segments[segments.length - 2];
  if (last && /^[a-z]{2}$/.test(last) && NAME.has(last)) {
    // The veto applies only to the bare "City, ST" shape, which is how US locations are written
    // and where the trailing code is certainly a state. With three or more segments the trailing
    // code is a country in practice ("Toronto, ON, CA", "London, England, GB, GB") — there the
    // state, if any, sits in the middle and the earlier mid-string guard already ignores it.
    const bareCityState = segments.length <= 2 && US_STATES.has(last);
    if (!bareCityState || last === prev) found.add(last);
  }

  // "Nederland, TX, US, 77627" and "Holland, MI" are US towns. When the Dutch reading rests on
  // one of those two words alone and the string also carries US evidence — a resolved us, or a
  // US state as a segment — the US reading wins.
  if (dutchOnlyByUsTown && (found.has('us') || segments.some((seg) => US_STATES.has(seg)))) {
    found.delete('nl');
  }

  return [...found];
}

module.exports = { resolveCountry, countriesFromLocation, NAME };

/**
 * Split a stored location into filterable tokens, so the query side can use an exact filter
 * instead of a substring scan.
 *
 * "London, England, GB, GB" -> ["london", "england", "gb"]
 * "San Francisco, CA, US"   -> ["san francisco", "san", "francisco", "ca", "us"]
 *
 * Both the whole comma-separated segment AND its individual words are emitted: a user searching
 * "San Francisco" must match, and so must "Francisco". Multi-word segments are capped at four
 * words so a free-text location blob cannot explode the token list.
 */
function locationTokens(text) {
  const s = norm(text);
  if (!s) return [];
  const out = new Set();
  for (const seg of s.split(/[,/|]|\s+-\s+/).map((x) => x.trim()).filter(Boolean)) {
    const clean = seg.replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    const words = clean.split(' ');
    if (words.length <= 4) out.add(clean);
    for (const w of words) if (w.length > 1) out.add(w);
    // A city with more than one spelling carries all of them, so "Munich" finds a posting
    // written "München" and vice versa. Segment first, then single words, because "München
    // Bayern" is one segment on some boards.
    for (const candidate of [clean, ...words]) {
      const group = cityAliasGroup(candidate);
      if (group) for (const a of group) out.add(a);
    }
  }
  return [...out];
}

module.exports.locationTokens = locationTokens;
module.exports.norm = norm;
