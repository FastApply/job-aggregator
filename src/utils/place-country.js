/**
 * The posting's country, written onto a place that names none, from the ATS's own field.
 *
 * WHY. A country search filters on location_countries, which is read from the location TEXT at
 * index time (location-countries.js). A bare city names no country, so "Berlin", "PARIS", "Madrid
 * Office" or "Copenhagen" was in no country search at all: 5-25% of the postings a city search
 * found in 22 large job markets (supply loop, 2026-11-11: Paris 70 of 300, London 71, Berlin 55,
 * Copenhagen 52, Madrid 47), mostly Workday and Ashby rows. Both ATSes state the country in a field
 * of its own (Workday's detail `country` / `jobRequisitionLocation.country.alpha2Code`, Ashby's
 * `address.postalAddress.addressCountry`) that the adapters dropped.
 *
 * Nothing is guessed: the country is the employer's own field, and it is added only when the text
 * names no country already, holds a single place, and is not a remote/global token. "Berlin" with
 * a United States country becomes "Berlin, United States", which is also right.
 */
const { resolveCountry, countriesFromLocation, NAME } = require('./location-countries');

// Several places in one string: one country field cannot speak for all of them.
const SEVERAL_PLACES = /[/;|]|\s&\s|\band\b|\d+\s+locations?\b/i;
// Remote or global: the country field is often the employer's HQ, not where the job is open.
const NOT_A_PLACE = /\bremote\b|\bworldwide\b|\banywhere\b|\bglobal\b|\bvirtual\b|\bhome[\s-]*based\b|\btelecommut/i;

/**
 * `location` with the country appended, or `location` unchanged.
 * @param {string|null} location  the ATS's place text
 * @param {{ code?: string, name?: string }} country  ISO alpha-2 code and/or the country's name
 */
function withCountry(location, country) {
  const loc = typeof location === 'string' ? location.trim() : '';
  if (!loc || !country) return location;
  if (SEVERAL_PLACES.test(loc) || NOT_A_PLACE.test(loc)) return location;
  if (countriesFromLocation(loc).length > 0) return location;
  const alpha2 = String(country.code || '').trim().toLowerCase();
  const code = (alpha2.length === 2 && NAME.has(alpha2)) ? alpha2 : resolveCountry(country.name || '')?.code;
  if (!code) return location;
  const out = `${loc}, ${NAME.get(code)}`;
  // Only when the result reads as exactly that country ("Georgia" and the like stay as they were).
  const read = countriesFromLocation(out);
  return read.length === 1 && read[0] === code ? out : location;
}

module.exports = { withCountry };
