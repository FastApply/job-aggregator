/**
 * Meilisearch-backed implementation of the job search read path.
 *
 * Mirrors jobsRepo.findActive / countActive so the route can swap between engines without
 * changing its response shape. Returns null when the index is unavailable or the filter set is
 * one it cannot serve faithfully, and the caller falls back to Postgres — a slower correct
 * answer always beats a fast wrong one.
 *
 * Why this exists: /api/facets, /api/roles and /api/trending each aggregate over 2.8M live rows
 * in Postgres. Even indexed they cost hundreds of ms; uncached and cold they hit 40-60s and blew
 * the statement timeout. Meilisearch returns those counts as a byproduct of the search it has
 * already run, and adds typo tolerance and relevance ranking Postgres full-text cannot.
 */
const meili = require('../../utils/meili');
const logger = require('../../logger');
const { isShortAlias } = require('../../utils/location-aliases');
const { resolveCountry } = require('../../utils/location-countries');
const { parsePostedWindow } = require('../../utils/posted-window');
const { regionCountries, canonicalSpelling } = require('../../utils/location-regions');
const { normalizeEmploymentType } = require('../../utils/extract');

const COUNT_CAP = parseInt(process.env.SEARCH_COUNT_CAP, 10) || 10000;

const toList = (v) => {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  return [...new Set(arr.map((x) => String(x).trim()).filter(Boolean))];
};

/** Meilisearch filter strings need quotes escaped, since values are interpolated. */
const q = (v) => `"${String(v).replace(/["\\]/g, '\\$&')}"`;

/**
 * Build a Meilisearch filter expression from the board's filter object.
 * Returns null if any filter cannot be expressed faithfully — the caller then uses Postgres.
 */
function buildFilter(filters = {}) {
  const parts = [];

  const modes = toList(filters.workMode).map((m) => m.toLowerCase()).filter((m) => m !== 'any');
  if (modes.length) {
    const or = [];
    for (const m of modes) {
      if (m === 'remote') or.push('is_remote = true');
      else if (m === 'hybrid') or.push(`workplace_type = ${q('Hybrid')}`);
      else if (['onsite', 'on-site', 'on_site'].includes(m)) {
        // Both spellings, because the index is NOT the clean copy this line once assumed.
        // toDocument copies workplace_type through untouched, so the deferred Postgres backfill
        // left `on_site` sitting next to `onsite` — 49,820 documents that a single equality
        // filter silently drops. Postgres matches both, so filtering on one under-counted by
        // exactly that population. Equality is case-insensitive, so casing is not the issue.
        or.push(`workplace_type = ${q('Onsite')}`);
        or.push(`workplace_type = ${q('on_site')}`);
      }
    }
    if (or.length) parts.push(`(${or.join(' OR ')})`);
  }

  const types = toList(filters.employmentType).filter((t) => t.toLowerCase() !== 'any')
    .map(normalizeEmploymentType).filter(Boolean);
  if (types.length) parts.push(`(${types.map((t) => `employment_type = ${q(t)}`).join(' OR ')})`);

  const levels = toList(filters.experienceLevel);
  if (levels.length) parts.push(`(${levels.map((l) => `experience_level = ${q(l)}`).join(' OR ')})`);

  const ats = toList(filters.ats);
  if (ats.length) parts.push(`(${ats.map((a) => `ats = ${q(a)}`).join(' OR ')})`);

  if (filters.companyId) parts.push(`company_id = ${parseInt(filters.companyId, 10)}`);
  if (filters.remote === 'true') parts.push('is_remote = true');
  if (filters.remoteWorldwide === 'true') parts.push('remote_worldwide = true');
  if (filters.visa) parts.push(`visa_sponsorship = ${q(filters.visa)}`);
  // Salary. Mirrors the SQL path exactly, including that a salary filter EXCLUDES unpriced jobs:
  // `salary_min_annual EXISTS` is Meilisearch's way of saying IS NOT NULL, and without it the
  // index would happily return documents whose field is null.
  if (filters.salaryMin || filters.salaryMax) {
    parts.push('salary_min_annual EXISTS');
    const lo = parseInt(filters.salaryMin, 10);
    if (Number.isFinite(lo)) parts.push(`salary_min_annual >= ${lo}`);
    // Bounded by the LOW end of the posted range, same as the SQL path: a job advertised
    // 80k-250k satisfies "up to 120k" for a candidate whose ceiling is 120k.
    const hi = parseInt(filters.salaryMax, 10);
    if (Number.isFinite(hi)) parts.push(`salary_min_annual <= ${hi}`);
    if (filters.salaryCurrency) parts.push(`salary_currency = ${q(String(filters.salaryCurrency).toUpperCase())}`);
  }

  // Location: the SQL path does substring matching plus country-alias expansion.
  //
  // This used to fold the location terms into the free-text query instead, on the reasoning that
  // an equality filter would drop "Remote - United States" for someone searching "United States".
  // True, but it made location a ranking signal rather than a filter: `location=London` reported
  // 10,000+ matches where Postgres found 1,396, and results past the first page drifted to jobs
  // nowhere near London. An inflated count on the page is worse than a slower query.
  //
  // CONTAINS is the faithful equivalent of the SQL `ILIKE '%term%'` (it needs the containsFilter
  // experimental flag, enabled on the instance) and is case-insensitive, so terms go in lowered.
  //
  // A country term does not go through CONTAINS at all. Short aliases can't: location-aliases.js
  // requires us/uk/uae to match as whole words, and CONTAINS "us" would return Houston. Instead
  // the term resolves to a country code and filters on location_countries, which meili.js
  // resolved at index time. The canonical name is OR'd in as a substring so a location that
  // names the country without a parseable code ("Work from United States") still matches, and
  // so an ambiguous term keeps its other meaning — "Georgia" finds both the country and Atlanta.
  const locs = toList(filters.location);
  if (locs.length) {
    const or = [];
    for (const l of locs) {
      const country = resolveCountry(l);
      if (country) {
        or.push(`location_countries = ${q(country.code)}`);
        continue; // indexed, ~47ms — no substring scan needed
      }

      // A REGION is not a place any posting names. No job says it is in the "European Union" —
      // it says Berlin, or Dublin. So the bloc has to become the countries inside it, which is
      // the same indexed location_countries filter, just OR'd. Measured 2026-08-28: regions
      // accounted for ~41,000 of the 54,652 searches still returning zero, the single largest
      // recoverable group, and no amount of extra inventory would have fixed one of them.
      const region = regionCountries(l);
      if (region) {
        for (const code of region) or.push(`location_countries = ${q(code)}`);
        continue;
      }

      // Local-language and misspelled names, resolved through a fixed table and then handed back
      // to the country resolver. Nothing here is fuzzy-matched: "Georgia" is a country AND a US
      // state, and an edit-distance guess would silently merge them.
      const fixed = canonicalSpelling(l);
      if (fixed) {
        const fixedCountry = resolveCountry(fixed);
        if (fixedCountry) { or.push(`location_countries = ${q(fixedCountry.code)}`); continue; }
        or.push(`location_tokens = ${q(fixed)}`);
        continue;
      }
      // location_tokens is the tokenised location written at index time. Verified 2026-08-07 at
      // 100% coverage (2,758,541 of 2,758,541 docs) before this line was switched on — filtering
      // on an attribute the index does not carry makes Meilisearch reject the entire search,
      // which sends every city filter to Postgres and returns 500s.
      //
      // Measured: exact filter ~47ms vs `location CONTAINS` at 8,589ms standalone and 12,736ms
      // combined with the ats list the board sends on every search. CONTAINS is an unindexed
      // substring scan and was the last operator forcing this path back onto Postgres.
      const term = String(l).trim().toLowerCase();
      or.push(`location_tokens = ${q(term)}`);
      // A phrase longer than the tokeniser holds as one unit still needs the substring scan.
      if (term.split(/\s+/).length > 4) or.push(`location CONTAINS ${q(term)}`);
    }
    parts.push(`(${[...new Set(or)].join(' OR ')})`);
  }

  if (filters.posted) {
    // Same shared parser as the SQL path. This used to carry its own copy of the regex, so a
    // window it could not parse returned null and pushed the request onto Postgres — which then
    // could not parse it either, dropped the filter, and ran unfiltered until it timed out.
    const parsed = parsePostedWindow(filters.posted);
    if (!parsed) return null;
    parts.push(`posted_ts >= ${Math.floor(Date.now() / 1000) - parsed.seconds}`);
  }

  return { filter: parts.length ? parts.join(' AND ') : undefined };
}

/** Build the free-text query. Roles are comma-separated; location is a filter, not a term. */
function buildQuery(filters) {
  const roles = filters.q ? String(filters.q).split(',').map((r) => r.trim()).filter(Boolean) : [];
  return roles.join(' ').trim();
}

/**
 * Search. Returns { rows, total, totalIsCapped } shaped like the Postgres path, or null to fall
 * back. Rows are index documents mapped back to the column names formatJob expects.
 */
async function search(filters = {}) {
  if (!meili.enabled) return null;



  const built = buildFilter(filters);
  if (!built) {
    // The other silent fallback: a filter set the index cannot express faithfully. Same cost as
    // the catch below — the request lands on the slow Postgres path — so it gets the same warning.
    logger.warn({ filters: summariseFilters(filters) },
      'Meili filter not expressible — falling back to Postgres (expect a slow query)');
    return null;
  }

  const limit = Math.min(parseInt(filters.limit, 10) || 50, 200);
  const offset = parseInt(filters.offset, 10) || 0;

  const q = buildQuery(filters);
  const facets = ['employment_type', 'experience_level', 'ats', 'workplace_type', 'role_category'];

  // How many distinct roles the caller asked for. The SQL path AND's the words inside one role
  // but OR's the roles against each other, so `q` = "developer,designer" must match either. A
  // single Meilisearch query cannot express that OR, and 'all' would demand both words at once —
  // turning a two-role search into a search for jobs that are somehow both. So 'all' is applied
  // only to single-role queries; multi-role keeps the permissive default, which is no worse than
  // today's behaviour and is the case the SQL path already disagreed with.
  const roleCount = filters.q ? String(filters.q).split(',').map((r) => r.trim()).filter(Boolean).length : 0;
  const strict = roleCount === 1;

  // Freshness ordering is applied ONLY when there is no search text.
  //
  // Passing an explicit `sort` activates the `sort` ranking rule, which sits at position 5 of
  // ['words','typo','proximity','attribute','sort','exactness', ...] — ahead of `exactness`. So on
  // a text query it demoted an exact title match below a fresher loose one. With no `sort`, the
  // trailing `first_seen_ts:desc` ranking rule still breaks ties by recency, which is the
  // behaviour we actually wanted: relevance first, newest among equals.
  const base = {
    filter: built.filter,
    limit,
    offset,
    facets,
    ...(q ? {} : { sort: ['first_seen_ts:desc'] }),
  };

  try {
    // matchingStrategy defaults to 'last', which DROPS query words from the end until it finds
    // enough results — so "senior technical writer" happily returned "Senior Technical Program
    // Manager", and with title/company_name/department/location all searchable it could satisfy
    // "senior" from the title and "technical" from the department. 'all' requires every term.
    let res = await meili.search({ ...base, q, matchingStrategy: strict ? 'all' : 'last' });

    // Requiring every term can legitimately return nothing on a long or unusual query, and an
    // empty board is worse than a loose one. Fall back to the permissive strategy only then, so
    // precision is the default and recall is the safety net rather than the other way round.
    if (strict && res && !(res.hits || []).length && q && q.trim().split(/\s+/).length > 1) {
      const loose = await meili.search({ ...base, q, matchingStrategy: 'last' });
      if (loose && (loose.hits || []).length) {
        // Log what it took to rescue the search, not just that we rescued it. `widenedTo` is the
        // number the user actually sees; a small number means the strict query was merely
        // over-tight, while a large one means we have swapped precision for a page of loosely
        // related jobs — which is the complaint this whole change set exists to fix. `filters`
        // distinguishes "nobody hires this role in that city" from "the query itself is wrong",
        // and those want opposite responses.
        logger.info({
          q: q.slice(0, 60),
          words: q.trim().split(/\s+/).length,
          widenedTo: loose.estimatedTotalHits ?? (loose.hits || []).length,
          filters: summariseFilters(filters),
        }, 'Meili: no exact-match results, widened the query');
        res = loose;
      }
    }
    if (!res) return null;

    // An empty board is the single most user-visible failure this path can produce, and until now
    // it was the ONLY outcome that logged nothing at all: strict found nothing, widening either
    // did not run or also found nothing, and the request returned zero rows silently. Whether
    // that is correct ("no jobs match, fair enough") or a bug (a filter we build wrong, a
    // location token that never matches) is not answerable without knowing what was asked.
    if (!(res.hits || []).length) {
      logger.info({ q: q.slice(0, 60) || null, filters: summariseFilters(filters) },
        'Meili: zero results');
    }

    const rows = (res.hits || []).map((h) => ({
      id: h.id,
      external_id: h.external_id,
      title: h.title,
      department: h.department,
      location: h.location,
      workplace_type: h.workplace_type,
      employment_type: h.employment_type,
      experience_level: h.experience_level,
      visa_sponsorship: h.visa_sponsorship,
      is_remote: h.is_remote,
      remote_worldwide: h.remote_worldwide,
      ats: h.ats,
      url: h.url,
      posted_at: h.posted_at,
      salary_min: h.salary_min,
      salary_max: h.salary_max,
      salary_min_annual: h.salary_min_annual ?? null,
      salary_max_annual: h.salary_max_annual ?? null,
      salary_currency: h.salary_currency,
      salary_interval: h.salary_interval,
      company_id: h.company_id,
      company_name: h.company_name,
      domain: h.company_domain,
      ats_slug: h.company_ats_slug,
      logo_url: h.company_logo_url,
    }));

    // Descriptions live in Postgres, not the index. meili.js leaves them out on purpose: they
    // are an order of magnitude larger than the title/company/location metadata, and indexing
    // 23GB of them would need a bigger disk and far more memory than the search itself does.
    //
    // So hydrate instead of falling back. This is the standard search-index shape — the index
    // answers "which jobs, in what order" and the database supplies the heavy column for just
    // the page being returned. It is a primary-key lookup on at most `limit` ids, nothing like
    // the full-table scans that made the SQL search path slow in the first place.
    //
    // Without this, /api/jobs?include=description came back with description: null on every row
    // while reporting servedBy: meili — a successful-looking response with the content missing.
    if (filters.includeDescription && rows.length) {
      const { query } = require('../connection');
      const { rows: descs } = await query(
        'SELECT id, description FROM jobs WHERE id = ANY($1::bigint[])',
        [rows.map((r) => r.id)]
      );
      const byId = new Map(descs.map((d) => [String(d.id), d.description]));
      for (const r of rows) r.description = byId.get(String(r.id)) ?? null;
    }

    // estimatedTotalHits is bounded by the index's maxTotalHits (10000), matching the cap the
    // SQL path applies — so pagination behaves identically either way.
    const total = res.estimatedTotalHits ?? res.totalHits ?? rows.length;
    return {
      rows,
      total,
      totalIsCapped: total >= COUNT_CAP,
      facets: res.facetDistribution || null,
    };
  } catch (err) {
    // Never let an index problem break the board — but say so. Falling back is not free: the
    // Postgres equivalent of a narrow ATS filter measured 9s (18s with a date window) and blows
    // the statement timeout, so a silent `return null` here surfaces to users as "failed to
    // fetch" with nothing in the log to explain it. On 2026-08-10 that cost a full round of
    // diagnosis for 33 timeouts whose cause was invisible.
    logger.warn({ err: err.message, filters: summariseFilters(filters) },
      'Meili search failed — falling back to Postgres (expect a slow query)');
    return null;
  }
}

// Small, bounded description of a filter set for logs — never the raw object, which carries
// free-text search terms.
function summariseFilters(filters = {}) {
  // Every filter that can NARROW a result set to zero belongs here, because the whole point of
  // these lines is explaining a zero. The first cut logged only keys/ats/posted, and when
  // "Project Manager" started widening 86 times a day there was no way to tell whether the
  // culprit was a location nobody hires in or something wrong with the query — the same
  // "logged the symptom, not the cause" gap that cost a round of diagnosis on the fleet launcher.
  const s = {
    keys: Object.keys(filters).sort().join(','),
    ats: Array.isArray(filters.ats) ? filters.ats.join('|').slice(0, 60) : undefined,
    posted: filters.posted ? String(filters.posted).slice(0, 24) : undefined,
    location: filters.location ? String(filters.location).slice(0, 40) : undefined,
    workMode: filters.workMode || undefined,
    experienceLevel: filters.experienceLevel || undefined,
    employmentType: filters.employmentType || undefined,
    remote: filters.remote === undefined ? undefined : !!filters.remote,
    visa: filters.visa === undefined ? undefined : !!filters.visa,
    companyId: filters.companyId || undefined,
  };
  // Drop the absent ones so a broad search logs one short line rather than ten nulls.
  for (const k of Object.keys(s)) if (s[k] === undefined) delete s[k];
  return s;
}

/** Facet counts with no query — replaces the four GROUP BY scans behind /api/facets. */
async function facets() {
  if (!meili.enabled) return null;
  try {
    const res = await meili.search({
      q: '',
      limit: 0,
      facets: ['employment_type', 'experience_level', 'ats', 'workplace_type', 'role_category'],
    });
    return (res && res.facetDistribution) || null;
  } catch {
    return null;
  }
}

module.exports = { search, facets, buildFilter, buildQuery, COUNT_CAP };
