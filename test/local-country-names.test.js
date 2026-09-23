'use strict';
/**
 * FastApply's location pickers offer each country by its own name ("Deutschland (Germany)") and
 * save it as picked, so these reach search as-is. Every one must resolve to its country's code,
 * or the search treats it as a literal place name and returns nothing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFilter } = require('../src/db/repositories/jobs-search');

const filterFor = (location) => buildFilter({ location }).filter;

const LOCAL_NAMES = {
  de: ['Deutschland'],
  at: ['Österreich'],
  ch: ['Schweiz', 'Suisse', 'Svizzera'],
  nl: ['Nederland'],
  be: ['België', 'Belgique', 'Belgien'],
  lu: ['Luxemburg'],
  it: ['Italia'],
  es: ['España'],
  pl: ['Polska'],
  cz: ['Česká republika'],
  sk: ['Slovensko'],
  dk: ['Danmark'],
  se: ['Sverige'],
  no: ['Norge'],
  fi: ['Suomi'],
  ee: ['Eesti'],
  lv: ['Latvija'],
  lt: ['Lietuva'],
  hu: ['Magyarország'],
  ro: ['România'],
  hr: ['Hrvatska'],
  si: ['Slovenija'],
  ba: ['Bosna i Hercegovina'],
  al: ['Shqipëri'],
  tr: ['Türkiye'],
  br: ['Brasil'],
  mx: ['México'],
  pe: ['Perú'],
  pa: ['Panamá'],
  do: ['República Dominicana'],
  vn: ['Việt Nam'],
  cm: ['Cameroun'],
  sn: ['Sénégal'],
  mz: ['Moçambique'],
};

for (const [code, names] of Object.entries(LOCAL_NAMES)) {
  for (const name of names) {
    test(`"${name}" searches ${code.toUpperCase()}`, () => {
      assert.equal(filterFor(name), `((location_countries = "${code}"))`);
    });
  }
}

test('a local city still finds its other spelling', () => {
  assert.match(filterFor('München'), /"munich"/);
});

test('a local region name finds its English spelling, and the reverse', () => {
  assert.match(filterFor('Bayern'), /"bavaria"/);
  assert.match(filterFor('Bavaria'), /"bayern"/);
  assert.match(filterFor('Mazowieckie'), /"masovian voivodeship"/);
});

test('a hyphenated region matches the spaced form the index writes', () => {
  assert.match(filterFor('Nordrhein-Westfalen'), /"nordrhein westfalen"/);
});

test('names shared with US job markets stay ungrouped', () => {
  for (const name of ['Piedmont', 'Andalusia', 'Valencia', 'Naples', 'Syracuse']) {
    assert.doesNotMatch(filterFor(name), / OR /, name);
  }
});
