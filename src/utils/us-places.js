/**
 * Towns of the US states whose two-letter code is also a country's ISO code.
 *
 * WHY. "Vida at Morgan Hill, Morgan Hill, CA", "Carolinas Medical Center - 1000 Blythe Blvd,
 * Charlotte, NC" and "Streeterville, Chicago, IL" are a site or neighbourhood, then a US town and
 * its state. With three or more parts the trailing code was read as a country (location-countries.js
 * keeps it for "Toronto, ON, CA"), so those rows were tagged Canada, New Caledonia and Israel: a
 * Canada search returned California property-management jobs, and a United States search lost
 * about 8,600 live US rows (supply loop, 2026-11-06). The town in front of the code settles it.
 *
 * Data: us-places-data.js, built by scripts/build-us-places.js from the Census Gazetteer.
 */
const { norm } = require('./location-norm');

/** The form both sides are compared in: folded, no dots, punctuation to spaces. */
function placeKey(s) {
  return norm(s).replace(/\./g, '').replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

let BY_STATE = null;
function load() {
  if (BY_STATE) return BY_STATE;
  BY_STATE = new Map();
  let data = {};
  try { data = require('./us-places-data'); } catch { /* the builder runs before the data exists */ }
  for (const [st, names] of Object.entries(data)) BY_STATE.set(st, new Set(names.split('|')));
  return BY_STATE;
}

/** Whether `place` is a town (incorporated or census-designated) of the US state `st`. */
function isUsPlace(st, place) {
  const names = load().get(String(st || '').toLowerCase());
  return !!names && names.has(placeKey(place));
}

module.exports = { isUsPlace, placeKey };
