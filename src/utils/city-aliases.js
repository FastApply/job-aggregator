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
  // Regions, and the cities above did not cover, by their English and local names. FastApply's
  // location pickers save whichever the user picked ("Bayern", "Nordrhein-Westfalen"). Hyphenated
  // names carry the spaced form too: the index writes "nordrhein westfalen", the query folds to
  // "nordrhein-westfalen", and without both the two never met. Piedmont, Andalusia and Valencia
  // are left out for the same US-market reason as the cities above.
  // Germany
  ['bavaria', 'bayern'],
  ['hesse', 'hessen'],
  ['lower saxony', 'niedersachsen'],
  ['north rhine-westphalia', 'north rhine westphalia', 'nordrhein-westfalen', 'nordrhein westfalen'],
  ['rhineland-palatinate', 'rhineland palatinate', 'rheinland-pfalz', 'rheinland pfalz'],
  ['saxony', 'sachsen'],
  ['saxony-anhalt', 'saxony anhalt', 'sachsen-anhalt', 'sachsen anhalt'],
  ['thuringia', 'thuringen'],
  // Austria
  ['carinthia', 'karnten'],
  ['lower austria', 'niederosterreich'],
  ['styria', 'steiermark'],
  ['tyrol', 'tirol'],
  ['upper austria', 'oberosterreich'],
  // Switzerland
  ['basel-land', 'basel land', 'basel-landschaft', 'basel landschaft'],
  // Netherlands
  ['north brabant', 'noord-brabant', 'noord brabant'],
  ['north holland', 'noord-holland', 'noord holland'],
  ['south holland', 'zuid-holland', 'zuid holland'],
  ['friesland', 'fryslan'],
  // Belgium
  ['brussels-capital region', 'brussels capital region', 'region de bruxelles-capitale', 'region de bruxelles capitale', 'brussels hoofdstedelijk gewest'],
  ['east flanders', 'oost-vlaanderen', 'oost vlaanderen'],
  ['flanders', 'vlaanderen'],
  ['flemish brabant', 'vlaams-brabant', 'vlaams brabant'],
  ['wallonia', 'wallonie'],
  ['walloon brabant', 'brabant wallon'],
  ['west flanders', 'west-vlaanderen', 'west vlaanderen'],
  ['louvain', 'leuven'],
  // Italy
  ['aosta valley', "valle d'aosta"],
  ['apulia', 'puglia'],
  ['lombardy', 'lombardia'],
  ['sardinia', 'sardegna'],
  ['sicily', 'sicilia'],
  ['south tyrol', 'alto adige', 'sudtirol'],
  ['trentino-south tyrol', 'trentino south tyrol', 'trentino-alto adige', 'trentino alto adige'],
  ['tuscany', 'toscana'],
  ['metropolitan city of bari', 'citta metropolitana di bari'],
  ['metropolitan city of bologna', 'citta metropolitana di bologna'],
  ['metropolitan city of cagliari', 'citta metropolitana di cagliari'],
  ['metropolitan city of catania', 'citta metropolitana di catania'],
  ['metropolitan city of florence', 'citta metropolitana di firenze'],
  ['metropolitan city of genoa', 'citta metropolitana di genova'],
  ['metropolitan city of messina', 'citta metropolitana di messina'],
  ['metropolitan city of milan', 'citta metropolitana di milano'],
  ['metropolitan city of naples', 'citta metropolitana di napoli'],
  ['metropolitan city of palermo', 'citta metropolitana di palermo'],
  ['metropolitan city of reggio calabria', 'citta metropolitana di reggio calabria'],
  ['metropolitan city of rome', 'citta metropolitana di roma capitale'],
  ['metropolitan city of turin', 'citta metropolitana di torino'],
  ['metropolitan city of venice', 'citta metropolitana di venezia'],
  ['mantua', 'mantova'],
  // Spain
  ['balearic islands', 'illes balears', 'islas baleares'],
  ['basque country', 'pais vasco', 'euskadi'],
  ['canary islands', 'canarias', 'islas canarias'],
  ['castile and leon', 'castilla y leon'],
  ['castilla la mancha', 'castilla-la mancha'],
  ['catalonia', 'cataluna', 'catalunya'],
  ['comunidad valenciana', 'comunitat valenciana'],
  // Poland
  ['greater poland voivodeship', 'wielkopolskie', 'wojewodztwo wielkopolskie'],
  ['kuyavian-pomeranian voivodeship', 'kuyavian pomeranian voivodeship', 'kujawsko-pomorskie', 'kujawsko pomorskie', 'wojewodztwo kujawsko-pomorskie', 'wojewodztwo kujawsko pomorskie'],
  ['lesser poland voivodeship', 'malopolskie', 'wojewodztwo malopolskie'],
  ['lower silesian voivodeship', 'dolnoslaskie', 'wojewodztwo dolnoslaskie'],
  ['lublin voivodeship', 'lubelskie', 'wojewodztwo lubelskie'],
  ['lubusz voivodeship', 'lubuskie', 'wojewodztwo lubuskie'],
  ['masovian voivodeship', 'mazowieckie', 'wojewodztwo mazowieckie'],
  ['opole voivodeship', 'opolskie', 'wojewodztwo opolskie'],
  ['podkarpackie voivodeship', 'podkarpackie', 'wojewodztwo podkarpackie'],
  ['podlaskie voivodeship', 'podlaskie', 'wojewodztwo podlaskie'],
  ['pomeranian voivodeship', 'pomorskie', 'wojewodztwo pomorskie'],
  ['silesian voivodeship', 'slaskie', 'wojewodztwo slaskie'],
  ['warmian-masurian voivodeship', 'warmian masurian voivodeship', 'warminsko-mazurskie', 'warminsko mazurskie', 'wojewodztwo warminsko-mazurskie', 'wojewodztwo warminsko mazurskie'],
  ['west pomeranian voivodeship', 'zachodniopomorskie', 'wojewodztwo zachodniopomorskie'],
  ['lodz voivodeship', 'lodzkie', 'wojewodztwo lodzkie'],
  ['swietokrzyskie voivodeship', 'swietokrzyskie', 'wojewodztwo swietokrzyskie'],
  // Czechia
  ['central bohemian region', 'stredocesky kraj'],
  ['south bohemian region', 'jihocesky kraj'],
  ['plzen region', 'plzensky kraj'],
  ['karlovy vary region', 'karlovarsky kraj'],
  ['usti nad labem region', 'ustecky kraj'],
  ['liberec region', 'liberecky kraj'],
  ['hradec kralove region', 'kralovehradecky kraj'],
  ['pardubice region', 'pardubicky kraj'],
  ['vysocina region', 'kraj vysocina'],
  ['south moravian region', 'jihomoravsky kraj'],
  ['olomouc region', 'olomoucky kraj'],
  ['zlin region', 'zlinsky kraj'],
  ['moravian-silesian region', 'moravian silesian region', 'moravskoslezsky kraj'],
  ['pilsen', 'plzen'],
  // Slovakia
  ['banska bystrica region', 'banskobystricky kraj'],
  ['bratislava region', 'bratislavsky kraj'],
  ['kosice region', 'kosicky kraj'],
  ['nitra region', 'nitriansky kraj'],
  ['presov region', 'presovsky kraj'],
  ['trencin region', 'trenciansky kraj'],
  ['trnava region', 'trnavsky kraj'],
  ['zilina region', 'zilinsky kraj'],
  // Denmark
  ['capital region of denmark', 'region hovedstaden'],
  ['central denmark region', 'region midtjylland'],
  ['north denmark region', 'region nordjylland'],
  ['region zealand', 'region sjaelland'],
  ['region of southern denmark', 'region syddanmark'],
  ['elsinore', 'helsingor'],
  // Sweden
  ['blekinge', 'blekinge lan'],
  ['dalarna county', 'dalarnas lan'],
  ['gotland county', 'gotlands lan'],
  ['gavleborg county', 'gavleborgs lan'],
  ['halland county', 'hallands lan'],
  ['jonkoping county', 'jonkopings lan'],
  ['kalmar county', 'kalmar lan'],
  ['kronoberg county', 'kronobergs lan'],
  ['norrbotten county', 'norrbottens lan'],
  ['skane county', 'skane lan'],
  ['stockholm county', 'stockholms lan'],
  ['sodermanland county', 'sodermanlands lan'],
  ['uppsala county', 'uppsala lan'],
  ['varmland county', 'varmlands lan'],
  ['vasterbotten county', 'vasterbottens lan'],
  ['vasternorrland county', 'vasternorrlands lan'],
  ['vastmanland county', 'vastmanlands lan'],
  ['vastra gotaland county', 'vastra gotalands lan'],
  ['orebro county', 'orebro lan'],
  ['ostergotland county', 'ostergotlands lan'],
  // Finland
  ['central finland', 'keski-suomi', 'keski suomi'],
  ['central ostrobothnia', 'keski-pohjanmaa', 'keski pohjanmaa'],
  ['finland proper', 'varsinais-suomi', 'varsinais suomi'],
  ['lapland', 'lappi'],
  ['north karelia', 'pohjois-karjala', 'pohjois karjala'],
  ['northern ostrobothnia', 'pohjois-pohjanmaa', 'pohjois pohjanmaa'],
  ['northern savonia', 'pohjois-savo', 'pohjois savo'],
  ['ostrobothnia', 'pohjanmaa'],
  ['paijanne tavastia', 'paijat-hame', 'paijat hame'],
  ['south karelia', 'etela-karjala', 'etela karjala'],
  ['southern ostrobothnia', 'etela-pohjanmaa', 'etela pohjanmaa'],
  ['southern savonia', 'etela-savo', 'etela savo'],
  ['tavastia proper', 'kanta-hame', 'kanta hame'],
  ['aland islands', 'ahvenanmaa', 'aland'],
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
