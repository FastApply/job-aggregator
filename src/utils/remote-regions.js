/**
 * Countries a REMOTE job's region wording opens it to, for the index's location_countries.
 *
 * "Remote, EMEA", "Remote - Europe", "Remote - Nordics" name no country, so they got no country
 * tag and a location=Sweden search never saw them: 867 live remote jobs on First Apply platforms
 * on 2026-10-04. Only remote jobs are tagged — an office called "Europe HQ" is not a job anywhere
 * in Europe — and the codes are added to whatever countries the location names.
 *
 * EMEA is read as Europe only. It formally spans the Middle East and Africa too, but in postings it
 * almost always means a European time zone; tagging Africa would put these jobs in Lagos searches
 * on a guess.
 */
const EUROPE = ['at', 'be', 'bg', 'hr', 'cy', 'cz', 'dk', 'ee', 'fi', 'fr', 'de', 'gr', 'hu', 'ie', 'it',
  'lv', 'lt', 'lu', 'mt', 'nl', 'pl', 'pt', 'ro', 'sk', 'si', 'es', 'se', 'gb', 'no', 'ch', 'is'];
const RULES = [
  [/\b(europe|european union|eu|emea|eea|cet|cest|central european)\b/i, EUROPE],
  [/\bnordics?\b/i, ['se', 'no', 'dk', 'fi', 'is']],
  [/\bscandinavia\b/i, ['se', 'no', 'dk']],
  [/\bdach\b/i, ['de', 'at', 'ch']],
  [/\bbenelux\b/i, ['be', 'nl', 'lu']],
  [/\bbaltics?\b/i, ['ee', 'lv', 'lt']],
];

/** Region-implied country codes for a remote job's location, or [] when it names no region. */
function remoteRegionCountries(location) {
  const text = String(location || '');
  const out = new Set();
  for (const [re, codes] of RULES) if (re.test(text)) codes.forEach((c) => out.add(c));
  return [...out];
}

module.exports = { remoteRegionCountries, EUROPE };
