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
const { resolveCountry, norm, AMBIGUOUS_COUNTRY_NAMES } = require('../../utils/location-countries');
const { queryTokens } = require('../../utils/city-aliases');
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
  //
  // TWO LEVELS of grouping, because "these are independent choices" and "this is one place
  // narrowed by that" are both real inputs and look identical once flattened to text:
  //
  // 1. TOP LEVEL — each element the caller actually sent (an array entry from repeated
  //    ?location= keys, or the single string given) is its own independent alternative and is
  //    NEVER merged with another one. A caller with a genuine multi-select — e.g. the AI Job
  //    Matcher's automation.cities, which documents picking "San Francisco" and "United States"
  //    as two separate entries to mean EITHER — keeps meaning OR as long as it sends them as
  //    separate entries rather than joining them into one string itself.
  // 2. WITHIN one element — a comma-separated string is read left to right as PLACE terms
  //    followed by the COUNTRY that closes them: terms accumulate until one resolves as a
  //    country, which closes everything accumulated so far into one AND'd group and starts a
  //    fresh one. "Lagos, Nigeria, California" reads as "Lagos, closed by Nigeria" (one group)
  //    then "California" left open at the end (its own group, no country) — "(Lagos AND
  //    Nigeria) OR California", not "(Lagos OR California) AND Nigeria". A pure list of
  //    countries ("United States,Canada,United Kingdom") closes a new zero-place group on every
  //    term, which is just the old flat OR of countries.
  //
  // Reproduced and fixed 2026-09-19, then reproduced again and fixed properly 2026-09-21: the
  // first pass grouped ALL place terms into one bucket and ALL country terms into another,
  // which is right for a single place+country pair but wrong the moment a query has more than
  // one place — it read "Lagos, Nigeria, California" as "(Lagos OR California) in Nigeria"
  // instead of "Lagos in Nigeria, or California" (see above).
  //
  // A term can also arrive as "place|country" (pipe, not comma) — how the auto-apply launcher
  // sends a chosen City/Province together with Country. A comma can't carry "this is one
  // hierarchical place" vs "these are independent alternatives": "Georgia, United States" would
  // be indistinguishable from "United States, Canada" once flattened to text, and "Georgia"
  // itself resolves as a country (Sakartvelo) below, so guessing from content alone would
  // silently produce "Georgia OR United States" instead of "the state of Georgia, in the United
  // States". The pipe fixes each segment's role by position instead of guessing: the LAST
  // segment is always the country, everything before it is always a place, regardless of what
  // it would otherwise resolve to on its own. A pipe pair is always its own closed group too —
  // it never merges with a place term accumulated earlier in the same element.
  const clausesForPlace = (term) => {
    // location_tokens is the tokenised location written at index time. Verified 2026-08-07 at
    // 100% coverage (2,758,541 of 2,758,541 docs) before this line was switched on — filtering
    // on an attribute the index does not carry makes Meilisearch reject the entire search,
    // which sends every city filter to Postgres and returns 500s.
    //
    // Measured: exact filter ~47ms vs `location CONTAINS` at 8,589ms standalone and 12,736ms
    // combined with the ats list the board sends on every search. CONTAINS is an unindexed
    // substring scan and was the last operator forcing this path back onto Postgres.
    //
    // The term is folded the same way the tokens were written (München -> munchen) and
    // expanded to the city's other spellings, so "Munich" also asks for "munchen" and
    // "muenchen". Before the fold, an accented query could never match: the index held
    // "nchen" and the query asked for "münchen". See location-norm.js.
    const [term0, ...aliases] = queryTokens(term);
    const out = [`location_tokens = ${q(term0)}`, ...aliases.map((a) => `location_tokens = ${q(a)}`)];
    // A phrase longer than the tokeniser holds as one unit still needs the substring scan.
    // CONTAINS runs against the raw `location` field, which is NOT folded, so it gets the
    // caller's spelling as typed — "são paulo" must stay "são paulo" here.
    const raw = String(term).trim().toLowerCase();
    if (raw.split(/\s+/).length > 4) out.push(`location CONTAINS ${q(raw)}`);
    return out;
  };

  const resolveTerm = (term) => {
    const country = resolveCountry(term);
    if (country) return { isCountry: true, codes: [country.code], clauses: [`location_countries = ${q(country.code)}`] };

    // A REGION is not a place any posting names. No job says it is in the "European Union" —
    // it says Berlin, or Dublin. So the bloc has to become the countries inside it, which is
    // the same indexed location_countries filter, just OR'd. Measured 2026-08-28: regions
    // accounted for ~41,000 of the 54,652 searches still returning zero, the single largest
    // recoverable group, and no amount of extra inventory would have fixed one of them.
    const region = regionCountries(term);
    if (region) return { isCountry: true, codes: region, clauses: region.map((code) => `location_countries = ${q(code)}`) };

    // Local-language and misspelled names, resolved through a fixed table and then handed back
    // to the country resolver. Nothing here is fuzzy-matched: "Georgia" is a country AND a US
    // state, and an edit-distance guess would silently merge them.
    const fixed = canonicalSpelling(term);
    if (fixed) {
      const fixedCountry = resolveCountry(fixed);
      if (fixedCountry) return { isCountry: true, codes: [fixedCountry.code], clauses: [`location_countries = ${q(fixedCountry.code)}`] };
      return { isCountry: false, clauses: [`location_tokens = ${q(fixed)}`] };
    }

    return { isCountry: false, clauses: clausesForPlace(term) };
  };

  // One closed group (accumulated place terms, optionally closed by a country) -> its filter
  // piece: an AND of the places (OR'd among themselves) and the country (OR'd among itself, in
  // case it resolved to a region), or whichever half is present.
  const groupClause = (places, countryClauses) => {
    const placeClause = places.length
      ? `(${[...new Set(places.flatMap(clausesForPlace))].join(' OR ')})`
      : null;
    const countryClause = countryClauses && countryClauses.length
      ? `(${[...new Set(countryClauses)].join(' OR ')})`
      : null;
    if (placeClause && countryClause) return `(${placeClause} AND ${countryClause})`;
    return placeClause || countryClause;
  };

  // Read one caller-supplied element into its closed groups (see the rule above). A country can
  // close a run of places from EITHER side, not just the trailing one: "United States, Nashville,
  // New Orleans" (32,498 searches in search-demand data 2026-09-13) is a country named first,
  // qualifying the cities after it, exactly as much as "Nashville, United States" would be — a
  // country seen with nothing accumulated yet is held as `pendingCountry` rather than closed
  // immediately, in case places follow it. It only stands alone once something proves it isn't
  // qualifying anything: another country arriving before any place did ("United States,Canada" —
  // two alternatives, not one qualifying the other), or the element simply ending on it.
  const groupsForElement = (raw) => {
    const groups = [];
    let openPlaces = [];
    let openAmbiguous = []; // clauses for e.g. "Georgia" while its run is still undecided
    let pendingCountry = null; // { clauses, codes }
    const flushPending = () => {
      if (pendingCountry) { groups.push(groupClause([], pendingCountry.clauses)); pendingCountry = null; }
    };
    // Closes the current run. `country` is null for an unresolved (trailing) close.
    //
    // An ambiguous term's own country reading ("Georgia" the nation) is only dropped when the
    // run closes on United States specifically — the one country a US state could actually sit
    // inside, so "Georgia, United States" narrowing to just the state is a real geographic claim
    // rather than a guess. Any OTHER closing country keeps both readings: "Georgia, Nigeria"
    // AND-ing "georgia" the word against Nigeria is harmless noise alongside the real answer,
    // but DROPPING the standalone country=ge there would silently discard the far more likely
    // intent — two independent country picks — since a US state cannot sit inside Nigeria.
    const closeRun = (country) => {
      const isUnitedStates = !!country && country.codes.length === 1 && country.codes[0] === 'us';
      if (!isUnitedStates) for (const amb of openAmbiguous) groups.push(groupClause([], amb));
      if (openPlaces.length || country) groups.push(groupClause(openPlaces, country ? country.clauses : null));
      openPlaces = [];
      openAmbiguous = [];
    };

    for (const part of String(raw).split(',').map((s) => s.trim()).filter(Boolean)) {
      const pipeParts = part.includes('|') ? part.split('|').map((s) => s.trim()).filter(Boolean) : null;
      if (pipeParts && pipeParts.length >= 2) {
        const last = resolveTerm(pipeParts[pipeParts.length - 1]);
        if (last.isCountry) {
          // A pipe pair is always its own group — flush whatever came before (unresolved)
          // instead of merging into or being merged with it.
          flushPending();
          closeRun(null);
          groups.push(groupClause(pipeParts.slice(0, -1), last.clauses));
          continue;
        }
        // The trailing segment isn't a recognised country (an unset or unrecognised Country
        // field) — fall through and resolve the original text as one ordinary term instead of
        // silently dropping the rest of it.
      }
      const { isCountry, clauses, codes } = resolveTerm(part);
      if (isCountry && AMBIGUOUS_COUNTRY_NAMES.has(norm(part))) {
        // Hold both readings open rather than committing: "georgia" is carried as an ordinary
        // place term for whatever run it sits in, and its own country reading waits in
        // `openAmbiguous` until closeRun() decides whether United States settled it.
        openAmbiguous.push(clauses);
        openPlaces.push(part);
      } else if (isCountry) {
        if (openPlaces.length || openAmbiguous.length) {
          // Closes with the NEAREST country, not an older pending one — "Austin, Texas, United
          // States" binds to United States, not to something three terms back. A pending
          // country this run passed without using stands alone instead of vanishing.
          flushPending();
          closeRun({ clauses, codes });
        } else {
          // Nothing accumulated yet — hold it in case it qualifies what comes next. An earlier
          // still-pending country stands alone now: two countries back to back are
          // alternatives, neither qualifies the other.
          flushPending();
          pendingCountry = { clauses, codes };
        }
      } else {
        openPlaces.push(part);
      }
    }
    if (openPlaces.length || openAmbiguous.length) closeRun(pendingCountry);
    else flushPending();
    return groups;
  };

  const rawLocations = filters.location == null ? []
    : Array.isArray(filters.location) ? filters.location : [filters.location];
  const groups = rawLocations.flatMap((raw) => (String(raw).trim() ? groupsForElement(raw) : []));
  if (groups.length) parts.push(`(${groups.join(' OR ')})`);

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

/**
 * The roles the caller asked for. `q` is comma-separated and each entry is one role the user
 * would accept; location is a filter, not a term.
 */
function splitRoles(filters) {
  return filters.q ? String(filters.q).split(',').map((r) => r.trim()).filter(Boolean) : [];
}

/**
 * Build the free-text query for a SINGLE-role (or no-role) search.
 *
 * Multi-role searches do NOT come through here — see searchMultiRole. This used to join every
 * role with a space and hand the result to one Meilisearch query, which silently destroyed the
 * OR: `matchingStrategy: 'last'` drops query words from the END until it has enough hits, so
 * "Industrial Security,Physical Security,Project Manager" became the word bag
 * "Industrial Security Physical Security Project Manager", the tail was dropped, and only the
 * FIRST role was ever really searched. Measured on the live board 2026-09-17: that exact query
 * returned 137 rows with ZERO "security" titles among them, while "Physical Security" alone
 * returned the 2 matching jobs. Whichever role was listed first owned the entire page; roles
 * 2..N contributed nothing, at any offset. 266 of 317 active FastApply automations (84%) are
 * multi-role, so most users' second and third target roles had never been searched at all.
 */
function buildQuery(filters) {
  return splitRoles(filters).join(' ').trim();
}

/**
 * How many hits, summed over every role, one multi-role request may pull from the index.
 *
 * The merge happens in memory over the hits actually fetched, so serving offset N needs
 * N + limit rows from EVERY role (a role can be starved by the merge — its hits dedupe away
 * against an earlier role, or it has fewer than its share — so each sub-query fetches the whole
 * page depth, not `limit / roleCount`). The budget is shared, so the depth a request can reach
 * scales with how many roles it carries: two roles page 40 deep at 50/page, three page 26, the
 * automation's 24-role worst case pages 3. A flat per-role cap was the wrong shape — it let a
 * two-role board search fall off the merge at page 5, where the user would have silently
 * dropped back to seeing one role, which is the symptom this exists to remove.
 *
 * Past the budget the request keeps the old single-query behaviour: imperfect, but exactly what
 * production served before, and never an EMPTY page at a depth the total says exists.
 */
const MULTI_ROLE_HIT_BUDGET = 4000;

/**
 * Roles beyond this are dropped from a single request.
 *
 * Set to match the CALLER's own ceiling rather than to a round number: FastApply's
 * broadenSearchKeywords caps its expansion at 24 roles, and it emits each original role
 * followed by that role's broader variants — so the originals are spread through the list, not
 * bunched at the front. A lower cap here would truncate the tail and silently drop whole user
 * roles, which is the exact bug this change set exists to fix, reintroduced one layer down.
 *
 * The cost of the higher ceiling is paid back below by not requesting facets per sub-query.
 */
const MAX_ROLES = 24;

/**
 * Interleave per-role result lists round-robin: role A's best hit, role B's best, role C's
 * best, then each role's second, and so on.
 *
 * Round-robin is the half of this fix that the user actually sees. Concatenating instead would
 * restore the old symptom by a different route: a role with 10,000 matches would fill the page
 * and a role with 2 would never appear on it, even though both queries ran. Interleaving gives
 * every role page presence proportional to its RANK within its own result set, never to the
 * size of its corpus — so "Physical Security" (2 matches) lands on page one next to
 * "Project Manager" (10,000).
 *
 * Deduped by document id: a job matching two roles is one job, and it keeps the position of
 * the first role that claimed it.
 */
function interleaveByRole(perRole) {
  const out = [];
  const seen = new Set();
  const depth = Math.max(0, ...perRole.map((hits) => hits.length));
  for (let rank = 0; rank < depth; rank += 1) {
    for (const hits of perRole) {
      const hit = hits[rank];
      if (!hit) continue;
      const key = hit.id != null ? String(hit.id) : (hit.url || JSON.stringify(hit));
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(hit);
    }
  }
  return out;
}

/**
 * Merge the facet counts of several sub-queries by summing each value.
 *
 * A job matching two roles is counted twice here. That is the same overcount the merged `total`
 * carries and for the same reason: dedupe is only possible over the hits actually fetched, not
 * over the whole result set. These are already `estimatedTotalHits`-class numbers, capped at
 * COUNT_CAP, and they drive facet chips — not correctness.
 */
function mergeFacets(results) {
  const merged = {};
  let any = false;
  for (const res of results) {
    const dist = (res && res.facetDistribution) || null;
    if (!dist) continue;
    any = true;
    for (const [facet, values] of Object.entries(dist)) {
      merged[facet] = merged[facet] || {};
      for (const [value, count] of Object.entries(values)) {
        merged[facet][value] = (merged[facet][value] || 0) + count;
      }
    }
  }
  return any ? merged : null;
}

/**
 * Multi-role search: one sub-query per role, merged round-robin.
 *
 * Every role gets `matchingStrategy: 'all'` — the SAME precision a single-role search already
 * gets — because the whole reason the roles are separate queries is that each one is its own
 * AND-of-words, exactly like the Postgres path's `(a & b) | (c & d)`. The old shared-bag query
 * could not express that and was strictly looser AND strictly narrower at once: looser within
 * the surviving role, and narrower in that the other roles vanished.
 *
 * Returns null when the index has no multi-search (or it failed), so the caller falls back.
 */
async function searchMultiRole(roles, base, { limit, offset, filters }) {
  const depth = offset + limit;
  if (depth * roles.length > MULTI_ROLE_HIT_BUDGET) return null;
  // No `facets` per sub-query. /api/facets serves the board's facet counts from its own
  // zero-query search (loadFacets -> jobsSearch.facets), and the route reads only rows, total
  // and totalIsCapped off this result — the facetDistribution a search computes is returned and
  // never read by anybody. Asking 24 sub-queries for counts nothing consumes is what would make
  // a wide role list expensive; skipping it keeps a multi-role request in the same cost class as
  // the single faceted query it replaces. mergeFacets still merges whatever does come back, so
  // a future reader gets correct numbers rather than the first role's.
  const { facets: _facets, ...roleBase } = base;
  const queries = roles.map((role) => ({
    ...roleBase,
    q: role,
    limit: depth,
    offset: 0,
    matchingStrategy: 'all',
  }));

  let results;
  try {
    results = await meili.multiSearch(queries);
  } catch (err) {
    // An index too old to have /multi-search answers 404, which `call` raises. Let the caller
    // use the single-query path instead of letting this reach search()'s catch, which would
    // send EVERY multi-role board search to Postgres — measured there at 9s, 18s with a date
    // window, i.e. past the statement timeout. A worse answer beats no answer; a timeout is
    // neither.
    logger.warn({ err: err.message, roles: roles.length },
      'Meili multi-search unavailable — using the single-query path for this multi-role search');
    return null;
  }
  if (!results) return null;

  // Same recall safety net the single-role path has, applied to the search as a WHOLE rather
  // than per role. Widening one role while others have real hits would spend page slots on
  // loosely-related jobs ("Technical Writer" -> "Technical Recruiter") next to exact matches,
  // which is the precision complaint this file already fixed once. Only a search that found
  // nothing at all is worth trading precision for, because an empty board is worse than a
  // loose one.
  let widened = false;
  const totalHits = results.reduce((n, r) => n + ((r && r.hits) || []).length, 0);
  if (totalHits === 0) {
    const loose = await meili.multiSearch(
      roles.map((role) => ({ ...roleBase, q: role, limit: depth, offset: 0, matchingStrategy: 'last' }))
    );
    const looseHits = (loose || []).reduce((n, r) => n + ((r && r.hits) || []).length, 0);
    if (looseHits > 0) {
      logger.info({
        roles: roles.length,
        q: roles.join(',').slice(0, 60),
        widenedTo: looseHits,
        filters: summariseFilters(filters),
      }, 'Meili: no exact-match results for any role, widened the query');
      results = loose;
      widened = true;
    }
  }

  const merged = interleaveByRole(results.map((r) => (r && r.hits) || []));

  // Sum, not max: the roles are an OR, so a board that has 2 "Physical Security" jobs and 397
  // "Project Manager" jobs has ~399 for the pair. Overlapping jobs are counted twice — see
  // mergeFacets — and the figure is capped by the caller like every other total here.
  const total = results.reduce(
    (n, r) => n + ((r && (r.estimatedTotalHits ?? r.totalHits)) || 0),
    0
  );

  return {
    hits: merged.slice(offset, offset + limit),
    total,
    facetDistribution: mergeFacets(results),
    // Surfaced as meta.widened by the route (feat/search-widened-flag): a client that asked for
    // roles and is handed jobs matching only some of their words needs to know. FastApply's
    // starved-platform rescue refuses a widened page rather than paying an AI verdict to reject
    // every row of it.
    widened,
  };
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

  // The SQL path AND's the words inside one role but OR's the roles against each other, so
  // `q` = "developer,designer" must match either. A single Meilisearch query cannot express
  // that OR — 'all' would demand every word at once (a job somehow both), and 'last' drops the
  // tail, which silently reduced the search to role #1. So multi-role runs one query per role
  // and merges (searchMultiRole); only a single-role search is one query, where 'all' is both
  // expressible and correct.
  const roles = splitRoles(filters).slice(0, MAX_ROLES);
  const strict = roles.length === 1;

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
    // Multi-role: one sub-query per role, merged round-robin. Falls through to the single-query
    // path when the index has no /multi-search, so an older Meilisearch degrades to the old
    // behaviour rather than to no results.
    let res = null;
    if (roles.length > 1) {
      // `base` carries the caller's page window; each sub-query needs its own, so strip it here
      // rather than letting searchMultiRole override two keys it did not set.
      const { limit: _l, offset: _o, ...roleBase } = base;
      res = await searchMultiRole(roles, roleBase, { limit, offset, filters });
    }

    // matchingStrategy defaults to 'last', which DROPS query words from the end until it finds
    // enough results — so "senior technical writer" happily returned "Senior Technical Program
    // Manager", and with title/company_name/department/location all searchable it could satisfy
    // "senior" from the title and "technical" from the department. 'all' requires every term.
    if (!res) res = await meili.search({ ...base, q, matchingStrategy: strict ? 'all' : 'last' });

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
    const total = res.total ?? res.estimatedTotalHits ?? res.totalHits ?? rows.length;
    return {
      rows,
      total,
      totalIsCapped: total >= COUNT_CAP,
      facets: res.facetDistribution || null,
      widened: res.widened === true,
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

module.exports = {
  search, facets, buildFilter, buildQuery, splitRoles, interleaveByRole, mergeFacets,
  MAX_ROLES, COUNT_CAP,
};
