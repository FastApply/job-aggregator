'use strict';
/**
 * Two field rules for rows imported from aggregator feeds (scripts/map-aggregators-local.js), kept
 * here so the mapper's SQL and the repair scripts read them the same way, and so they can be tested
 * without a database.
 *
 * 1. LOCATION. aiapply joins every one of a posting's full_locations with "; ", and the mapper used
 *    to keep left(location, 300). A long list was cut mid-place: Southland Industries' "Project
 *    Manager" (aiapply_46774300, Workday R-2000003, 49 offices) ended "...El Paso, Texas, United
 *    States; F" and lost Houston, TX, so FastApply measured a Houston candidate who will not
 *    relocate 147 miles from the nearest office it could read (pref-match loop, 2026-11-22 00h; 3
 *    of 5,145 postings judged in the window had exactly 300-character locations). jobs.location is
 *    TEXT: the whole list is kept up to LOCATION_CAP, and a longer one is cut after its last whole
 *    place, never inside one.
 *
 * 2. COMPANY NAME. The mapper names a new board after the LONGEST company name any feed row gave
 *    it, so a parse artifact can win: Workable board kent-companies was created as "Description
 *    This" (its widget says "Kent Companies"), and so were raydar and other Workable employers.
 *    FastApply keys "one application per company" on the employer's name, so seven First Apply
 *    attempts at different employers shared one key. An artifact name is never picked; with no
 *    real name the slug stands in, and the crawler's own name (the ATS widget) replaces it on the
 *    next sync.
 */

const LOCATION_CAP = 2000;
const SEPARATOR = ';';

/** The list cut after its last whole place within `cap` characters (JS twin of cutLocationSql). */
function cutLocationList(location, cap = LOCATION_CAP) {
  if (location == null) return location;
  const s = String(location);
  if (s.length <= cap) return s;
  const head = s.slice(0, cap + 1);
  const at = head.lastIndexOf(SEPARATOR);
  if (at <= 0) return s.slice(0, cap);
  return head.slice(0, at).trimEnd();
}

/** SQL for the same cut, over any text expression. */
function cutLocationSql(expr, cap = LOCATION_CAP) {
  const x = `(${expr})`;
  return `CASE WHEN ${x} IS NULL OR length(${x}) <= ${cap} THEN ${x}
    WHEN position('${SEPARATOR}' in left(${x}, ${cap + 1})) > 1
      THEN rtrim(regexp_replace(left(${x}, ${cap + 1}), '${SEPARATOR}[^${SEPARATOR}]*$', ''))
    ELSE left(${x}, ${cap}) END`;
}

/**
 * Names that are a scrape of a heading or a placeholder, not an employer. Narrow on purpose: a
 * whole-name match only, so "Description Technologies" or "Unknown Worlds Entertainment" stand.
 */
const ARTIFACT_COMPANY_PATTERN = String.raw`^\s*(?:(?:company\s+)?description(?:\s+this)?|about\s+us|job\s+description|company\s+overview|unknown(?:\s+company)?|n\s*/\s*a|n\.a\.?)\s*$`;
const ARTIFACT_COMPANY = new RegExp(ARTIFACT_COMPANY_PATTERN, 'i');

function isArtifactCompanyName(name) {
  return name == null || String(name).trim() === '' || ARTIFACT_COMPANY.test(String(name));
}

/** SQL: true when `expr` is a real company name (Postgres ARE, case-insensitive). */
function realCompanyNameSql(expr) {
  return `(nullif(btrim(${expr}), '') IS NOT NULL AND ${expr} !~* '${ARTIFACT_COMPANY_PATTERN.replace(/'/g, "''")}')`;
}

module.exports = {
  LOCATION_CAP,
  cutLocationList,
  cutLocationSql,
  ARTIFACT_COMPANY,
  ARTIFACT_COMPANY_PATTERN,
  isArtifactCompanyName,
  realCompanyNameSql,
};
