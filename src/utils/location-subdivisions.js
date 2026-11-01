/**
 * Countries written as ISO alpha-3 codes, and Australian states / Canadian provinces written as
 * their postal codes. Both are how large ATS platforms write locations, and neither was read.
 *
 * MEASURED on the live board 2026-10-30 (supply loop), by re-running the index-time tagger over
 * the locations the API returned:
 *
 *   - Alpha-3. "Toronto, ON, CAN", "Gurugram, HR, IND", "AUS - NSW - Macquarie Park", "Dublin,
 *     IRL", "Sao Paulo, SP, BRA". Of the rows carrying a CAN segment, 389 of 389 had no country
 *     tag, so location=Canada never found them. The same held for every code checked (GBR 297 of
 *     373, IND 285 of 293, DEU 282 of 311, BRA 312 of 340, CHN 301 of 303, ...).
 *   - Province / state codes with no country after them: "Ottawa, ON", "Calgary, AB",
 *     "Newcastle, NSW", "Brisbane QLD". About half the ON / BC / AB / QC rows and a fifth of the
 *     NSW / QLD / VIC rows carried no country. "Adelaide, SA" was tagged Saudi Arabia,
 *     "Regina, SK" Slovakia and "St. John's, NL" the Netherlands, because those codes are also
 *     ISO country codes.
 *   - Query side: location=New South Wales never matched "Wollongong, NSW, Australia", and
 *     location=Ontario never matched "Toronto, ON, Canada". Postings write the code, not the
 *     name. Business Analyst in Ontario: 49 on-title rows -> 111 when ON postings in Canada
 *     count.
 *
 * Nothing is guessed. An alpha-3 code counts only when written in capitals as the first or last
 * part of an address (a mid-address "CHE" is Chennai in "IND - CHE - PDS"; a lowercase "can" or
 * "are" is a word). A province code counts only as the address's final part when no country is
 * named, and the codes that collide with something else (BC is also Baja California; SK, NL, PE,
 * SA are country codes; MB, NB, NS, NT are also Italian / Dutch / Australian abbreviations) count
 * only next to a city of that province.
 */

// ISO 3166-1 alpha-3 -> alpha-2, for the countries whose postings carry real volume. USA is not
// here: "usa" is already an alias of the US.
const ALPHA3 = {
  can: 'ca', aus: 'au', gbr: 'gb', ind: 'in', deu: 'de', fra: 'fr', mex: 'mx', bra: 'br',
  nld: 'nl', esp: 'es', ita: 'it', irl: 'ie', nzl: 'nz', sgp: 'sg', phl: 'ph', zaf: 'za',
  are: 'ae', jpn: 'jp', chn: 'cn', pol: 'pl', che: 'ch', swe: 'se', bel: 'be', arg: 'ar',
  col: 'co', chl: 'cl', kor: 'kr', isr: 'il', prt: 'pt', aut: 'at', dnk: 'dk', nor: 'no',
  fin: 'fi', cze: 'cz', hun: 'hu', rou: 'ro', grc: 'gr', tur: 'tr', sau: 'sa', qat: 'qa',
  egy: 'eg', nga: 'ng', ken: 'ke', mys: 'my', tha: 'th', idn: 'id', vnm: 'vn', hkg: 'hk',
  twn: 'tw', pak: 'pk', bgd: 'bd', lka: 'lk', per: 'pe', ury: 'uy', cri: 'cr', pan: 'pa',
  dom: 'do', gtm: 'gt', ecu: 'ec', svk: 'sk', svn: 'si', hrv: 'hr', srb: 'rs', bgr: 'bg',
  ukr: 'ua', ltu: 'lt', lva: 'lv', est: 'ee', lux: 'lu', isl: 'is', mlt: 'mt', cyp: 'cy',
  mar: 'ma', tun: 'tn', gha: 'gh', kwt: 'kw', bhr: 'bh', omn: 'om', jor: 'jo',
};

// State / province code -> country, read when it ends an address that names no country.
const SAFE_CODES = {
  // Australia. Three letters, none of them a country code or a US state.
  nsw: 'au', qld: 'au', vic: 'au', tas: 'au', act: 'au',
  // Canada. Not ISO codes and not US states.
  on: 'ca', ab: 'ca', qc: 'ca',
};

// Codes that are also something else: read only beside a city of that state or province.
const CITY_CODES = [
  ['bc', 'ca', ['vancouver', 'north vancouver', 'west vancouver', 'burnaby', 'surrey', 'richmond',
    'victoria', 'kelowna', 'kamloops', 'nanaimo', 'abbotsford', 'coquitlam', 'langley', 'delta',
    'new westminster', 'port coquitlam', 'maple ridge', 'chilliwack', 'prince george', 'squamish',
    'whistler', 'vernon', 'penticton', 'courtenay', 'campbell river', 'white rock', 'saanich']],
  ['mb', 'ca', ['winnipeg', 'brandon', 'steinbach', 'thompson', 'portage la prairie', 'selkirk']],
  ['sk', 'ca', ['regina', 'saskatoon', 'prince albert', 'moose jaw', 'swift current', 'yorkton',
    'north battleford', 'estevan', 'lloydminster']],
  ['ns', 'ca', ['halifax', 'dartmouth', 'truro', 'bedford', 'berwick', 'kentville', 'new glasgow',
    'antigonish', 'wolfville', 'yarmouth', 'sydney mines', 'bridgewater', 'lower sackville']],
  ['nb', 'ca', ['moncton', 'fredericton', 'saint john', 'dieppe', 'miramichi', 'bathurst',
    'edmundston', 'riverview', 'quispamsis', 'rothesay']],
  ['nl', 'ca', ["st john's", 'st johns', "saint john's", 'mount pearl', 'corner brook', 'gander',
    'paradise', 'conception bay south', 'grand falls windsor', 'happy valley goose bay']],
  ['pe', 'ca', ['charlottetown', 'summerside', 'stratford', 'cornwall']],
  ['yt', 'ca', ['whitehorse', 'dawson city']],
  ['nu', 'ca', ['iqaluit', 'rankin inlet', 'cambridge bay']],
  ['nt', 'ca', ['yellowknife', 'inuvik', 'hay river', 'fort smith']],
  ['nt', 'au', ['darwin', 'alice springs', 'palmerston', 'katherine', 'tennant creek']],
  // "Melbourne, Victoria": the state's name, not its code, and Victoria is also a Canadian city.
  ['victoria', 'au', ['melbourne', 'geelong', 'ballarat', 'bendigo', 'shepparton', 'mildura',
    'warrnambool', 'frankston', 'dandenong', 'box hill', 'cremorne', 'carlton', 'docklands',
    'southbank', 'clayton', 'werribee', 'traralgon', 'wodonga', 'tarneit', 'doreen', 'wollert']],
  // Indian state codes that are also ISO codes: "Mumbai, MH" read as the Marshall Islands,
  // "Hyderabad, TG" as Togo and "Gurugram, HR" as Croatia, so India searches lost them (supply
  // loop, 2026-11-01).
  ['mh', 'in', ['mumbai', 'navi mumbai', 'thane', 'pune', 'nagpur', 'nashik', 'aurangabad']],
  ['tg', 'in', ['hyderabad', 'secunderabad', 'warangal']],
  ['hr', 'in', ['gurgaon', 'gurugram', 'faridabad']],
  ['sa', 'au', ['adelaide', 'mount gambier', 'whyalla', 'port augusta', 'port lincoln',
    'murray bridge', 'gawler', 'port pirie', 'mawson lakes', 'salisbury', 'elizabeth']],
];
const BY_CITY_CODE = new Map();
for (const [code, country, cities] of CITY_CODES) {
  for (const city of cities) BY_CITY_CODE.set(`${city}|${code}`, country);
}

const scrub = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/\./g, '').replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

// Alpha-3 codes that US postings write for something else, and the cue that must sit in the same
// address before the code counts as the country. EST is the US time zone ("Remote - EST",
// "FL - Virtual - B+ - EST", "CST/EST"), against one "Tallinn, EST" in the local corpus; AUS is
// Austin's airport ("Austin, TX - AUS"), while "International - Townsville - AUS" is Australia.
const ALPHA3_NEEDS = {
  est: (address) => /estonia|eesti|tallinn|tartu|narva|p[aä]rnu/i.test(address),
  aus: (address) => !/\baustin\b/i.test(address),
};

/**
 * Countries named by an alpha-3 code at the start or end of an address. Reads the RAW text: the
 * code must be in capitals. Several addresses can share one string ("Boeblingen, DEU / Munich,
 * BY, DEU"), so each is read on its own.
 */
function alpha3Countries(rawText) {
  const out = new Set();
  for (const address of String(rawText || '').split(/[;|/]/)) {
    const parts = address.split(/,|\s+-\s+/).map((p) => p.trim()).filter(Boolean);
    if (!parts.length) continue;
    // "ITA-Milan-Piazza Armando Diaz 2", "ZAF-Cape Town-1st Floor": the code heads the address.
    const head = parts[0].split('-')[0].trim();
    // "Cremorne, AUS-VIC, AUS", "Huangpu, Shanghai - CHN": the code ends it.
    const tail = parts[parts.length - 1];
    for (const candidate of [head, tail]) {
      const code = candidate.toLowerCase();
      if (/^[A-Z]{3}$/.test(candidate) && ALPHA3[code] && (!ALPHA3_NEEDS[code] || ALPHA3_NEEDS[code](address))) {
        out.add(ALPHA3[code]);
      }
    }
  }
  return out;
}

/**
 * The country of an address ending in a state / province code, or null. `segments` are the
 * address's comma parts, already folded. "Brisbane QLD" and "Melbourne VIC 3000" carry the code
 * as the segment's last word; "Ottawa, ON" as its own segment.
 */
function subdivisionCountry(segments) {
  if (!segments.length) return null;
  const last = scrub(segments[segments.length - 1]).replace(/(?: \d{4})+$/, '');
  const prev = segments.length >= 2 ? scrub(segments[segments.length - 2]) : null;
  if (!last) return null;
  const words = last.split(' ');
  const code = words[words.length - 1];
  const city = words.length > 1 ? words.slice(0, -1).join(' ') : prev;
  if (city && BY_CITY_CODE.has(`${city}|${code}`)) return BY_CITY_CODE.get(`${city}|${code}`);
  // A bare code is not an address ("ON" alone could be a word): it needs a place before it,
  // as its own segment ("Ottawa, ON") or in front of it ("Toronto ON", "Brisbane QLD 4000").
  if (!city) return null;
  return SAFE_CODES[code] || null;
}

// Query side: a state / province NAME -> the code postings write, and the country that code
// must sit in to mean this place (ON alone is a word; NSW inside Malta's "Tas-Sliema" is not).
// Left out, as on the index side: Victoria, which is also the capital of British Columbia (and a
// Texas city), so location=Victoria or "Victoria, BC" must not also match every Melbourne "VIC".
const NAME_TO_CODE = {
  'new south wales': ['nsw', 'au'], queensland: ['qld', 'au'],
  tasmania: ['tas', 'au'], 'australian capital territory': ['act', 'au'],
  'western australia': ['wa', 'au'], 'south australia': ['sa', 'au'],
  'northern territory': ['nt', 'au'],
  ontario: ['on', 'ca'], 'british columbia': ['bc', 'ca'], alberta: ['ab', 'ca'],
  quebec: ['qc', 'ca'], manitoba: ['mb', 'ca'], saskatchewan: ['sk', 'ca'],
  'nova scotia': ['ns', 'ca'], 'new brunswick': ['nb', 'ca'],
  'newfoundland and labrador': ['nl', 'ca'], newfoundland: ['nl', 'ca'],
  'prince edward island': ['pe', 'ca'], yukon: ['yt', 'ca'],
  'northwest territories': ['nt', 'ca'], nunavut: ['nu', 'ca'],
};

/** [code, country] postings use for a folded state / province name, or null. */
function subdivisionCode(name) {
  return NAME_TO_CODE[name] || null;
}

// Province / state NAMES that name one country wherever they appear in an address. Index side
// only: resolveCountry() must never read them, or a search for Ontario would widen to all of
// Canada. Left out: Victoria (also the capital of British Columbia), and the Australian names
// that already contain "Australia".
const PROVINCE_NAMES = {
  ontario: 'ca', quebec: 'ca', 'british columbia': 'ca', alberta: 'ca', manitoba: 'ca',
  saskatchewan: 'ca', 'nova scotia': 'ca', 'new brunswick': 'ca', newfoundland: 'ca',
  'prince edward island': 'ca', yukon: 'ca', 'northwest territories': 'ca', nunavut: 'ca',
  queensland: 'au', tasmania: 'au', 'northern territory': 'au',
};

/**
 * Countries named by a province / state name in an address (word n-grams, never substrings).
 *
 * A name followed by a US state is that US town, when the state cannot be the ISO "CA" after a
 * real province ("Toronto, Ontario, CA"): it opens the address ("Santa Ana, CA, US; Ontario, CA,
 * US"), the state is spelled out ("Ontario, California"), or a ZIP follows ("Ontario, CA 91761").
 * `isUsState` is passed in because the state tables live in location-countries.js, which requires
 * this file.
 */
function provinceNameCountries(text, isUsState = () => false) {
  const out = new Set();
  for (const address of String(text || '').split(/[;|/]/)) {
    const segments = address.split(/,|\s+-\s+/).map(scrub).filter(Boolean);
    segments.forEach((segment, index) => {
      const words = segment.split(' ');
      for (let n = 1; n <= 3; n++) {
        for (let i = 0; i + n <= words.length; i++) {
          const country = PROVINCE_NAMES[words.slice(i, i + n).join(' ')];
          if (!country) continue;
          const next = segments[index + 1];
          if (next && ((index === 0 && isUsState(next)) || (next.length > 2 && isUsState(next))
            || /^[a-z]{2} \d{5}/.test(next))) continue;
          out.add(country);
        }
      }
    });
  }
  return out;
}

/** The country a "City, CODE" pair names when CODE is a colliding province / state code, or null. */
function cityCodeCountry(city, code) {
  return BY_CITY_CODE.get(`${scrub(city)}|${code}`) || null;
}

module.exports = {
  alpha3Countries, subdivisionCountry, subdivisionCode, cityCodeCountry, provinceNameCountries,
  ALPHA3, NAME_TO_CODE,
};
