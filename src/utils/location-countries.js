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

// Full US state names, folded. See usStateReading.
const US_STATE_NAMES = new Set(['alabama', 'alaska', 'arizona', 'arkansas', 'california',
  'colorado', 'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois',
  'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts',
  'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada',
  'new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio',
  'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina', 'south dakota',
  'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington', 'west virginia', 'wisconsin',
  'wyoming', 'district of columbia', 'puerto rico']);

// "City, ST" where the city belongs to another country that uses the same two letters — as its
// ISO code (Montreal, CA; Bogota, CO) or as its own state abbreviation (Perth, WA is Western
// Australia; Chennai, TN is Tamil Nadu). Built from the cities that actually appear in the live
// corpus next to each code (2% sample, 2026-09-26): every code there is overwhelmingly the US
// state, and these are the exceptions it showed plus each country's other major cities.
const FOREIGN_CITY_STATE = [
  ['ca', 'ca', ['toronto', 'montreal', 'vancouver', 'ottawa', 'calgary', 'edmonton', 'winnipeg',
    'mississauga', 'brampton', 'markham', 'oakville', 'burnaby', 'surrey', 'laval', 'gatineau',
    'quebec', 'quebec city', 'halifax', 'victoria', 'saskatoon', 'regina', 'kitchener',
    'waterloo', 'london', 'vaughan', 'richmond hill']],
  ['in', 'in', ['bangalore', 'bengaluru', 'mumbai', 'navi mumbai', 'thane', 'pune', 'hyderabad',
    'chennai', 'delhi', 'new delhi', 'gurgaon', 'gurugram', 'noida', 'greater noida', 'ghaziabad',
    'faridabad', 'kolkata', 'ahmedabad', 'jaipur', 'kochi', 'cochin', 'coimbatore', 'trivandrum',
    'thiruvananthapuram', 'chandigarh', 'mohali', 'indore', 'nagpur', 'lucknow', 'bhubaneswar',
    'vadodara', 'surat', 'visakhapatnam', 'mysore', 'mysuru', 'mangalore', 'mangaluru',
    'vijayawada', 'madurai', 'nashik', 'bhopal', 'patna', 'ranchi', 'guwahati', 'dehradun']],
  ['tn', 'in', ['chennai', 'coimbatore', 'madurai', 'tiruchirappalli', 'trichy', 'hosur',
    'vellore', 'tirunelveli', 'tiruppur', 'erode']],
  ['tn', 'tn', ['tunis', 'sfax', 'sousse']],
  ['or', 'in', ['bhubaneswar', 'cuttack', 'rourkela']],
  ['wa', 'au', ['perth', 'fremantle', 'joondalup', 'bunbury', 'mandurah', 'kalgoorlie',
    'karratha', 'port hedland', 'broome', 'geraldton']],
  ['co', 'co', ['bogota', 'medellin', 'cali', 'barranquilla', 'cartagena', 'bucaramanga',
    'pereira']],
  ['ar', 'ar', ['buenos aires', 'tigre', 'cordoba', 'rosario', 'mendoza', 'la plata', 'caba']],
  ['id', 'id', ['jakarta', 'south jakarta', 'bandung', 'surabaya', 'bali', 'denpasar', 'medan',
    'yogyakarta', 'tangerang', 'bekasi', 'semarang', 'batam']],
  ['mt', 'mt', ['sliema', 'valletta', 'st julians', 'saint julians', 'msida', 'birkirkara',
    'gzira', 'san gwann', 'mosta', 'qormi', 'swieqi']],
  ['mt', 'br', ['sorriso', 'cuiaba', 'rondonopolis', 'sinop']],
  ['sc', 'br', ['florianopolis', 'joinville', 'blumenau', 'itajai', 'chapeco', 'criciuma']],
  ['pa', 'br', ['belem']],
  ['pa', 'pa', ['panama', 'panama city', 'ciudad de panama']],
  ['ma', 'ma', ['casablanca', 'rabat', 'marrakech', 'tangier', 'tanger', 'fes', 'agadir']],
  ['ma', 'br', ['sao luis']],
  ['ms', 'br', ['campo grande', 'dourados']],
  ['al', 'al', ['tirana', 'durres']],
  ['al', 'br', ['maceio']],
  ['il', 'il', ['tel aviv', 'tel aviv yafo', 'jerusalem', 'haifa', 'herzliya', 'petah tikva',
    'petach tikva', 'raanana', "ra'anana", 'netanya', 'beer sheva', 'rehovot', 'yokneam',
    'ramat gan', 'rosh haayin', 'hod hasharon']],
  ['ga', 'ga', ['libreville']],
  ['az', 'az', ['baku']],
  ['md', 'md', ['chisinau']],
  ['me', 'me', ['podgorica']],
  ['mn', 'mn', ['ulaanbaatar', 'ulan bator']],
  ['la', 'la', ['vientiane']],
  ['ky', 'ky', ['george town', 'grand cayman']],
  ['mo', 'mo', ['macau', 'macao']],
  ['nc', 'nc', ['noumea']],
  ['ne', 'ne', ['niamey']],
  ['sd', 'sd', ['khartoum']],
];
const FOREIGN_BY_CITY_STATE = new Map();
for (const [st, country, cities] of FOREIGN_CITY_STATE) {
  for (const city of cities) FOREIGN_BY_CITY_STATE.set(`${city}|${st}`, country);
}

// DE is the one code the corpus does NOT read as the state by default: about half the bare
// "City, DE" rows are German (Berlin, Hamburg, München, "Mehrere Standorte"). Delaware is small
// enough to list instead.
const DELAWARE_TOWNS = new Set(['wilmington', 'newark', 'dover', 'middletown', 'new castle',
  'lewes', 'georgetown', 'milford', 'smyrna', 'seaford', 'bear', 'rehoboth beach', 'claymont',
  'hockessin', 'harrington', 'laurel', 'selbyville', 'millsboro', 'delmar', 'camden', 'elsmere',
  'glasgow', 'townsend', 'felton', 'frankford', 'milton', 'ocean view', 'bethany beach',
  'greenwood', 'bridgeville', 'newport', 'clayton', 'delaware city', 'pike creek', 'christiana',
  'north wilmington']);

// "X, Georgia" is the US state unless X is one of the country's own cities.
const GEORGIA_COUNTRY_CITIES = new Set(['tbilisi', 'batumi', 'kutaisi', 'rustavi', 'zugdidi',
  'gori', 'telavi', 'poti']);

// US territories carry their own ISO code as well as being part of the US.
const US_TERRITORIES = new Set(['pr', 'vi', 'gu']);

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

  const state = usStateReading(segments, text);
  if (state) {
    // The state and the place in front of it are one address, so a country named inside either
    // is a false reading ("New Mexico" -> Mexico, "Jersey City" -> Jersey, "Lebanon, Tennessee"
    // -> Lebanon). Countries named EARLIER in the string are separate places and stay:
    // "London, United Kingdom / Austin, Texas" and "Toronto, ON, Canada; Chicago, IL, USA" are
    // both. A US state name earlier on ("Georgia, North Carolina, Tennessee") is not a country.
    const earlier = namedCodes(state.earlierText);
    return [...new Set([...[...found].filter((c) => earlier.has(c)), ...state.codes])];
  }

  return [...found];
}

/** Country codes spelled out in `text` — the same word n-gram scan countriesFromLocation runs. */
function namedCodes(text) {
  const out = new Set();
  const words = String(text).replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
  for (let n = 1; n <= 4; n++) {
    for (let i = 0; i + n <= words.length; i++) {
      const key = words.slice(i, i + n).join(' ');
      if (key.length <= 2) continue;
      const code = LOOKUP.get(key);
      if (code) out.add(code);
    }
  }
  return out;
}

/**
 * Does this location end in a US state? Returns { codes, cityIndex } or null.
 *
 * Without this, a US address that never spells out the country got NO country: "Austin, TX" and
 * "Buffalo, New York" were invisible to location=United States. Measured 2026-09-26 on a 2%
 * sample of live jobs, that was 38% of all US jobs (13% "City, ST", 9% "City, State"), and
 * "Niagara Falls, United States" returned 2 of one employer's 106 Niagara Falls jobs.
 *
 * A state counts only at the END of the address: the last segment, or followed by nothing but
 * US evidence ("United States", "USA", a ZIP). A state name in the middle ("Montana, Bulgaria",
 * "Florida, Uruguay") is a place in some other country.
 *
 * Full names are read on their own. A two-letter code is read in the bare "City, ST" shape, or
 * when a US country token follows it ("Jersey City, NJ, US"). It is NOT read mid-string
 * otherwise, because "Chennai, TN, IN" is Tamil Nadu, India. In the bare shape the city settles
 * the collisions: FOREIGN_BY_CITY_STATE for the known foreign cities, DELAWARE_TOWNS for DE.
 *
 * Case matters for the bare code, so it is read from the raw text: one source writes ISO country
 * codes in lowercase ("Berlin, de", "Pune, in", "Montreal, ca", "Paris, fr", "Chicago, us") and in
 * the live corpus every lowercase code that collides with a state was that country. A lowercase
 * ISO code is the country; only an uppercase one, or one that is no country ("tx"), is a state.
 * The case is only a signal when the rest of the text has capitals: an all-lowercase
 * "san francisco, ca" says nothing either way and falls through to the city rules.
 */
function usStateReading(segments, rawText) {
  // Several addresses joined by ";" or "|" share one comma segment: "Toronto, ON, Canada;
  // Chicago, IL, USA". Only the last one belongs to the trailing state.
  const tail = (seg) => seg.split(/[;|]/).pop();
  const clean = segments.map((seg) => tail(seg).replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim());
  let end = clean.length;
  let usTail = false;
  while (end > 0) {
    const seg = clean[end - 1];
    if (/^\d{5}(\s?\d{4})?$/.test(seg)) { end -= 1; continue; }
    if (LOOKUP.get(seg) === 'us' && !US_STATE_NAMES.has(seg)) { usTail = true; end -= 1; continue; }
    break;
  }
  if (end === 0) return null;

  const st = clean[end - 1];
  const city = end >= 2 ? clean[end - 2] : null;
  // Everything before the city: whole segments, plus any address the city's own segment carries
  // ahead of a ";" — minus segments that are themselves US states.
  const cityRaw = end >= 2 ? segments[end - 2] : '';
  const startsAddress = tail(cityRaw) !== cityRaw; // "London, UK; Austin, TX": Austin opens one
  const earlierParts = [
    ...segments.slice(0, Math.max(0, end - 2)),
    cityRaw.slice(0, cityRaw.length - tail(cityRaw).length),
  ].flatMap((seg) => seg.split(/[;|]/))
    .map((part) => part.replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const earlierText = earlierParts
    .filter((part, i) => !US_STATE_NAMES.has(part)
      || (part === 'georgia' && GEORGIA_COUNTRY_CITIES.has(earlierParts[i - 1])))
    .join(' ');
  const reading = (codes) => ({ codes, earlierText });

  if (US_STATE_NAMES.has(st)) {
    if (st === 'georgia') {
      if (city && GEORGIA_COUNTRY_CITIES.has(city)) return null;
      // A city written in a script that folds to nothing ("თბილისი, , Georgia") is Georgian.
      if (segments.slice(0, end - 1).some((seg) => /[^\u0000-\u024f]/.test(seg))) return null;
      // A lone "Georgia" names nothing else to decide by. Keep both readings.
      if (!city && !usTail) return reading(['us', 'ge']);
    }
    return reading(st === 'puerto rico' ? ['us', 'pr'] : ['us']);
  }

  if (!US_STATES.has(st) || city === st) return null;
  if (!usTail && end !== 2 && !startsAddress) return null;
  if (usTail) return reading(US_TERRITORIES.has(st) ? ['us', st] : ['us']);

  const rawLast = String(rawText).split(/[,/]|\s+-\s+/).map((x) => x.trim()).filter(Boolean).pop() || '';
  if (/^[a-z]{2}$/.test(rawLast) && /[A-Z]/.test(String(rawText)) && NAME.has(st)) return reading([st]);
  const foreign = FOREIGN_BY_CITY_STATE.get(`${city}|${st}`);
  if (foreign) return reading([foreign]);
  if (st === 'de' && !DELAWARE_TOWNS.has(city)) return reading(['de']);
  return reading(US_TERRITORIES.has(st) ? ['us', st] : ['us']);
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
// Whether the trailing-US-state rule decides this location's countries. Every tag the rule
// changed on 2026-09-26 went through it, so this is exactly the set of stored documents that
// scripts/requeue-index-recall.js has to re-send.
module.exports.endsInUsState = (text) => {
  const s = norm(text).replace(/\./g, '');
  return !!s && !!usStateReading(s.split(/[,/]|\s+-\s+/).map((x) => x.trim()).filter(Boolean), text);
};
