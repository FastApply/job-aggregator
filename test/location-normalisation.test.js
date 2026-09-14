'use strict';
/**
 * Accented and local-language place names must resolve exactly like their ASCII / English
 * forms, at index time and at query time.
 *
 * Measured on the live board 2026-09-14 before this change: every accented location the
 * FastApply dashboard offers returned ZERO — Düsseldorf 0 (Dusseldorf 8), München 0, Köln 0,
 * Zürich 0, São Paulo 0 (Sao Paulo 241), Montréal 0 (Montreal 988), Kraków 0, Cancún 0. And
 * `location=Munich` returned 1,500 while free text found 6,032 postings written "München".
 * Cause: location-countries.js lowercased without folding diacritics and then scrubbed every
 * non-ASCII letter, so "München" was indexed as the tokens "m nchen" / "nchen" and a query for
 * it could never match. The same scrub meant "Madrid, España" carried no country code, so it
 * was invisible to `location=Spain` even though the query side maps España → Spain.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  countriesFromLocation,
  locationTokens,
  resolveCountry,
  norm,
} = require('../src/utils/location-countries');
const { queryTokens } = require('../src/utils/city-aliases');
const { buildFilter } = require('../src/db/repositories/jobs-search');

test('norm folds diacritics and the letters NFKD leaves alone', () => {
  assert.equal(norm('München'), 'munchen');
  assert.equal(norm('São Paulo'), 'sao paulo');
  assert.equal(norm('Straße'), 'strasse');
  assert.equal(norm('Ærø, Danmark'), 'aero, danmark');
  assert.equal(norm('Łódź'), 'lodz');
  assert.equal(norm('Đà Nẵng'), 'da nang');
  assert.equal(norm('İstanbul'), 'istanbul');
});

test('index time: accented cities keep their letters instead of being cut in half', () => {
  const t = locationTokens('München, Deutschland');
  assert.ok(t.includes('munchen'), JSON.stringify(t));
  assert.ok(!t.includes('nchen'), JSON.stringify(t));
  assert.ok(!t.includes('m nchen'), JSON.stringify(t));
  assert.ok(locationTokens('São Paulo, Brasil').includes('sao paulo'));
  assert.ok(locationTokens('Zürich, Schweiz').includes('zurich'));
  assert.ok(locationTokens('Kraków, Polska').includes('krakow'));
});

test('index time: local-language country names resolve to the country code', () => {
  const cases = {
    'Madrid, España': 'es',
    'Wien, Österreich': 'at',
    'Ciudad de México, México': 'mx',
    'Utrecht, Nederland': 'nl',
    'Warszawa, Polska': 'pl',
    'Zürich, Schweiz': 'ch',
    'Genève, Suisse': 'ch',
    'Lugano, Svizzera': 'ch',
    'Milano, Italia': 'it',
    'Rio de Janeiro, Brasil': 'br',
    'Bruxelles, Belgique': 'be',
    'Antwerpen, België': 'be',
    'Stockholm, Sverige': 'se',
    'Oslo, Norge': 'no',
    'København, Danmark': 'dk',
    'Helsinki, Suomi': 'fi',
    'Praha, Česko': 'cz',
    'Budapest, Magyarország': 'hu',
    'Athina, Ellada': 'gr',
    'Zagreb, Hrvatska': 'hr',
    'Bratislava, Slovensko': 'sk',
    'Ljubljana, Slovenija': 'si',
    'Beograd, Srbija': 'rs',
    'Kyiv, Ukraina': 'ua',
    'Vilnius, Lietuva': 'lt',
    'Riga, Latvija': 'lv',
    'Tallinn, Eesti': 'ee',
    'Luxemburg, Luxemburg': 'lu',
    'Auckland, Aotearoa': 'nz',
    'Casablanca, Maroc': 'ma',
    'Alger, Algérie': 'dz',
    'Tunis, Tunisie': 'tn',
    'Santo Domingo, República Dominicana': 'do',
    'Tokyo, Nippon': 'jp',
    'München, Deutschland': 'de',
    'Côte d\'Ivoire': 'ci',
    'Willemstad, Curaçao': 'cw',
    'Saint-Denis, Réunion': 're',
  };
  for (const [text, code] of Object.entries(cases)) {
    assert.deepEqual(countriesFromLocation(text), [code], text);
  }
});

test('query time: local-language country names resolve directly', () => {
  for (const [term, code] of [['España', 'es'], ['Nederland', 'nl'], ['Polska', 'pl'],
    ['Deutschland', 'de'], ['Österreich', 'at'], ['Schweiz', 'ch'], ['Italia', 'it'],
    ['Brasil', 'br'], ['México', 'mx'], ['Sverige', 'se']]) {
    assert.equal(resolveCountry(term)?.code, code, term);
  }
});

test('index time: the names neighbouring languages use resolve too', () => {
  const cases = {
    'Barcelona, Catalogne, Espagne': 'es',
    'Irun, Pays Basque, Espagne': 'es',
    'Berlin, Allemagne': 'de',
    'Amsterdam, Pays-Bas': 'nl',
    'Paris, Frankreich': 'fr',
    'Warszawa, Polen': 'pl',
    'Mailand, Italien': 'it',
    'Lisboa, Portogallo': 'pt',
    'Wien, Austria': 'at',
    'Bruxelles, Belgique': 'be',
    'Genf, Schweiz': 'ch',
  };
  for (const [text, code] of Object.entries(cases)) {
    assert.deepEqual(countriesFromLocation(text), [code], text);
  }
  assert.equal(resolveCountry('Pays-Bas')?.code, 'nl');
  assert.equal(resolveCountry('Espagne')?.code, 'es');
});

test('a US town called Nederland or Holland is not the Netherlands', () => {
  assert.deepEqual(countriesFromLocation('Nederland, Texas, United States'), ['us']);
  assert.deepEqual(countriesFromLocation('Nederland, CO'), []);
  assert.deepEqual(countriesFromLocation('Holland, MI'), []);
  assert.deepEqual(countriesFromLocation('Holland, Michigan, United States'), ['us']);
  // ...while the real thing still resolves, with or without a province in the middle.
  assert.deepEqual(countriesFromLocation('Utrecht, Nederland'), ['nl']);
  assert.deepEqual(countriesFromLocation('Zuid-Holland, Nederland'), ['nl']);
  assert.deepEqual(countriesFromLocation('Nederland, Utrecht, Nederland'), ['nl']);
});

test('names that are also places elsewhere are deliberately not aliases', () => {
  assert.deepEqual(countriesFromLocation('Dania Beach, FL'), []); // not Denmark
  assert.deepEqual(countriesFromLocation('Franca, SP, Brasil'), ['br']); // not France
  assert.deepEqual(countriesFromLocation('Long Island, NY'), []); // not Iceland
});

test('the guards that existed before still hold', () => {
  // US state codes are not countries.
  assert.deepEqual(countriesFromLocation('Wilmington, DE'), []);
  assert.deepEqual(countriesFromLocation('Indianapolis, IN, US'), ['us']);
  assert.deepEqual(countriesFromLocation('Richmond, VA'), []);
  // Repeated trailing codes are countries.
  assert.deepEqual(countriesFromLocation('London, England, GB, GB'), ['gb']);
  // Substrings are not countries.
  assert.deepEqual(countriesFromLocation('Nigeria'), ['ng']);
  assert.deepEqual(countriesFromLocation('Indianapolis'), []);
  // "Island" must never read as Iceland (Ísland): it is in thousands of US locations.
  assert.deepEqual(countriesFromLocation('Long Island, NY'), []);
  assert.deepEqual(countriesFromLocation('Staten Island'), []);
  // Georgia stays ambiguous on purpose; the query side ORs the substring in.
  assert.deepEqual(countriesFromLocation('Atlanta, Georgia'), ['ge']);
});

test('index time: a city carries its other spellings so either one finds it', () => {
  assert.ok(locationTokens('München, Deutschland').includes('munich'));
  assert.ok(locationTokens('München, Deutschland').includes('muenchen'));
  assert.ok(locationTokens('Munich, Germany').includes('munchen'));
  assert.ok(locationTokens('Köln').includes('cologne'));
  assert.ok(locationTokens('Milano, Italia').includes('milan'));
  assert.ok(locationTokens('Warsaw, Poland').includes('warszawa'));
  assert.ok(locationTokens('Wien').includes('vienna'));
  assert.ok(locationTokens('Ciudad de México').includes('mexico city'));
  // Untouched places stay as they were.
  assert.deepEqual(locationTokens('Springfield, IL'), ['springfield', 'il']);
});

test('query time: a city term expands to every spelling, folded', () => {
  assert.deepEqual(queryTokens('München'), ['munchen', 'munich', 'muenchen']);
  assert.deepEqual(queryTokens('Milan'), ['milan', 'milano', 'mailand']);
  assert.deepEqual(queryTokens('Düsseldorf'), ['dusseldorf', 'duesseldorf']);
  assert.deepEqual(queryTokens('Springfield'), ['springfield']);
});

test('buildFilter: an accented city or endonym produces the same filter as its English form', () => {
  const f = (location) => buildFilter({ location }).filter;

  const de = f('Deutschland');
  assert.equal(de, f('Germany'));
  assert.match(de, /location_countries = "de"/);

  assert.equal(f('España'), f('Spain'));
  assert.equal(f('Österreich'), f('Austria'));
  assert.equal(f('Nederland'), f('Netherlands'));
  assert.equal(f('Polska'), f('Poland'));

  const muc = f('München');
  assert.match(muc, /location_tokens = "munchen"/);
  assert.match(muc, /location_tokens = "munich"/);
  assert.ok(!/"nchen"/.test(muc), muc);
  // Either spelling asks for the same set.
  assert.equal(new Set(muc.match(/"[^"]+"/g)).size, new Set(f('Munich').match(/"[^"]+"/g)).size);

  const dus = f('Düsseldorf');
  assert.match(dus, /location_tokens = "dusseldorf"/);
  assert.match(dus, /location_tokens = "duesseldorf"/);

  // A long phrase still gets the substring scan, against the field's own spelling.
  const long = f('Vila Olímpia São Paulo Field Based');
  assert.match(long, /location_tokens = "vila olimpia sao paulo field based"/);
  assert.match(long, /location CONTAINS "vila olímpia são paulo field based"/);
});
