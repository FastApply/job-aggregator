const { query, transaction, isPostgres } = require('../connection');
const logger = require('../../logger');
const { aliasGroup, isShortAlias } = require('../../utils/location-aliases');
const { resolveCountry, norm, AMBIGUOUS_COUNTRY_NAMES } = require('../../utils/location-countries');
const { normalizeEmploymentType, normalizeWorkplaceType } = require('../../utils/extract');
const { parsePostedWindow } = require('../../utils/posted-window');

// Upper bound on result counts — see countActive. Env-tunable.
const COUNT_CAP = parseInt(process.env.SEARCH_COUNT_CAP, 10) || 10000;

/**
 * Build WHERE clauses from filters.
 * Returns { clauses: string[], params: any[], needsJoin: boolean }
 */
function buildFilters(filters = {}) {
  const clauses = ['j.removed_at IS NULL'];
  const params = [];
  let needsJoin = false;

  // Salary. Filters on the annualised numeric copies, never the raw TEXT columns, and EXCLUDES
  // unpriced jobs by design — asking for "over 100k" and being shown jobs with no stated salary
  // is not a useful answer. Currency is filtered alongside the amount because no FX conversion
  // happens and 56 currencies are present.
  if (filters.salaryMin) {
    const n = parseInt(filters.salaryMin, 10);
    if (Number.isFinite(n)) { clauses.push('j.salary_min_annual IS NOT NULL AND j.salary_min_annual >= ?'); params.push(n); }
  }
  if (filters.salaryMax) {
    const n = parseInt(filters.salaryMax, 10);
    // Bounded by the LOW end of the posted range: a job advertised 80k-250k satisfies
    // "up to 120k" for a candidate whose ceiling is 120k.
    if (Number.isFinite(n)) { clauses.push('j.salary_min_annual IS NOT NULL AND j.salary_min_annual <= ?'); params.push(n); }
  }
  if (filters.salaryCurrency) {
    clauses.push('j.salary_currency = ?');
    params.push(String(filters.salaryCurrency).toUpperCase());
  }

  // Role / Keywords — use full-text search on Postgres, ILIKE fallback on SQLite
  if (filters.q) {
    // Support comma-separated role queries: "Senior Developer, technical writer"
    // Each comma-separated term is a separate role query, OR'd together
    const roles = filters.q.split(',').map(r => r.trim()).filter(Boolean);

    if (isPostgres) {
      // ONE tsquery, not one per role. Words within a role are AND'd, roles are OR'd:
      //   "data analyst, product manager" -> (data & analyst) | (product & manager)
      //
      // This used to emit a separate `search_vector @@ to_tsquery(...)` per role, OR'd in
      // SQL. The automation sends up to 22 roles in a single request, which meant 22 GIN
      // index lookups instead of one. Measured on 2.8M live jobs, 10 roles + a location
      // filter: 16,405ms as separate clauses vs 1,738ms combined — 9.4x.
      //
      // Terms are stripped of tsquery syntax characters (& | ! : * ( ) ') because they are
      // interpolated into the query string, not passed as data. An unsanitised apostrophe or
      // ampersand in a job title would otherwise be a syntax error that fails the whole
      // search — and the single combined query means one bad term would take out every role.
      const clean = (word) => word.replace(/[^\p{L}\p{N}_-]+/gu, '');
      const groups = roles
        .map((role) => role.split(/\s+/).map(clean).filter(Boolean).join(' & '))
        .filter(Boolean)
        .map((g) => `(${g})`);
      if (groups.length) {
        clauses.push("j.search_vector @@ to_tsquery('english', ?)");
        params.push(groups.join(' | '));
      }
    } else {
      if (roles.length === 1) {
        const terms = roles[0].split(/\s+/).filter(Boolean);
        for (const term of terms) {
          clauses.push('(j.title ILIKE ? OR j.department ILIKE ? OR c.company_name ILIKE ?)');
          const pattern = `%${term}%`;
          params.push(pattern, pattern, pattern);
          needsJoin = true;
        }
      } else {
        const roleClauses = roles.map(role => {
          const terms = role.split(/\s+/).filter(Boolean);
          const termClauses = terms.map(term => {
            const pattern = `%${term}%`;
            params.push(pattern, pattern, pattern);
            return '(j.title ILIKE ? OR j.department ILIKE ? OR c.company_name ILIKE ?)';
          });
          return '(' + termClauses.join(' AND ') + ')';
        });
        clauses.push('(' + roleClauses.join(' OR ') + ')');
        needsJoin = true;
      }
    }
  }

  // Helper: normalize a filter that may be string | array | comma-separated string
  // into a deduped array of trimmed non-empty values, lowercased for
  // case-insensitive callers. Returns [] if nothing usable.
  const toList = (v) => {
    if (v == null) return [];
    const arr = Array.isArray(v) ? v : String(v).split(',');
    const out = [];
    const seen = new Set();
    for (const item of arr) {
      const s = String(item).trim();
      if (!s) continue;
      const k = s.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(s);
    }
    return out;
  };

  // Work mode: remote, hybrid, onsite — multi-value (OR semantics)
  // Each mode adds its own OR-block; the whole work_mode group is then OR'd
  // together so e.g. work_mode=remote,hybrid returns ANY remote OR hybrid job.
  {
    const modes = toList(filters.workMode).map((m) => m.toLowerCase()).filter((m) => m !== 'any');
    if (modes.length > 0) {
      // Exact matches, not ILIKE. workplace_type holds 9 distinct values that are really
      // three concepts (onsite / on_site / OnSite / On-site), so listing the variants lets
      // idx_jobs_workplace_active serve the filter; a leading-wildcard ILIKE cannot use it.
      // Remote uses the indexed is_remote boolean, which is also what the separate
      // `remote=true` filter uses — previously the two disagreed, and requests sending both
      // paid for an unindexable scan on top of an indexed one.
      //
      // Measured on 2.8M live jobs: the old three-way ILIKE for remote took 41,296ms vs
      // 6,347ms for the boolean. Note the boolean matches slightly MORE rows (353,862 vs
      // 342,965) because classifyJob also infers remoteness from the description.
      // Canonical values first, then the legacy spellings still present in older rows. Listing
      // both means the filter keeps working across the normalisation backfill in either
      // direction — no window where onsite silently matches nothing.
      const WORKPLACE_VARIANTS = {
        hybrid: ['Hybrid', 'hybrid'],
        onsite: ['Onsite', 'onsite', 'on_site', 'OnSite', 'On-site', 'on-site'],
      };
      const groups = [];
      for (const m of modes) {
        if (m === 'remote') {
          groups.push('j.is_remote = true');
        } else if (m === 'hybrid') {
          groups.push(`j.workplace_type IN (${WORKPLACE_VARIANTS.hybrid.map(() => '?').join(', ')})`);
          params.push(...WORKPLACE_VARIANTS.hybrid);
        } else if (m === 'onsite' || m === 'on-site' || m === 'on_site') {
          groups.push(`j.workplace_type IN (${WORKPLACE_VARIANTS.onsite.map(() => '?').join(', ')})`);
          params.push(...WORKPLACE_VARIANTS.onsite);
        }
      }
      if (groups.length > 0) clauses.push('(' + groups.join(' OR ') + ')');
    }
  }

  // Employment type: full-time, part-time, contract, internship — multi-value
  {
    const types = toList(filters.employmentType).filter((t) => t.toLowerCase() !== 'any');
    if (types.length > 0) {
      // Exact match on the canonical value, normalising the caller's input through the same
      // function that normalises writes ("full-time" -> "Full-time").
      //
      // This used to be `employment_type ILIKE '%x%' OR title ILIKE '%x%'`. The title
      // fallback existed because employment_type held 4,784 free-text spellings of about six
      // real values, so matching the column alone missed jobs. That column is now normalised,
      // making the fallback both unnecessary and expensive: an unindexable substring scan of
      // title on every filtered search. Measured on 2.8M live jobs — 27,829ms with the
      // fallback vs 6,068ms without, for a 0.1% difference in rows matched (1,402,461 ->
      // 1,401,111).
      const canon = [...new Set(types.map(normalizeEmploymentType).filter(Boolean))];
      if (canon.length) {
        clauses.push(`j.employment_type IN (${canon.map(() => '?').join(', ')})`);
        params.push(...canon);
      }
    }
  }

  // Location — multi-value free-text match, with country-alias expansion so e.g. "UAE" also
  // matches jobs stored as "United Arab Emirates" (and USA/US<->United States, UK<->United
  // Kingdom, ...). Long unambiguous aliases use a substring match; short ones (us/uk/usa/uae)
  // use a word-boundary regex so "us" doesn't match "Houston".
  //
  // TWO LEVELS of grouping — see buildFilter in jobs-search.js for the full rationale, this
  // mirrors it exactly. TOP LEVEL: each element the caller actually sent (an array entry from
  // repeated ?location= keys, or the single string given) is independent and never merges with
  // another — this is what keeps a genuine multi-select (the AI Job Matcher's automation.cities,
  // which documents two separate entries as meaning EITHER) meaning OR. WITHIN one element: a
  // comma-separated string reads left to right as PLACE terms followed by the COUNTRY that
  // closes them, so "Lagos, Nigeria, California" is "(Lagos AND Nigeria) OR California", not
  // "(Lagos OR California) AND Nigeria" (which is what a flat two-bucket version of this fix
  // produced — reproduced and fixed 2026-09-19, then reproduced again and fixed properly
  // 2026-09-21 once a query had more than one place term).
  //
  // Classification uses resolveCountry, which has full ISO coverage, rather than aliasGroup
  // below, which only expands the 5 hand-curated ambiguous-abbreviation groups (US/UK/UAE/
  // Netherlands/Germany) — aliasGroup still decides what the generated clause looks like, this
  // only decides which bucket it lands in. Without it "Nigeria" (no alias group of its own)
  // would never be read as a country here.
  //
  // A term can also arrive as "place|country" (pipe) — see jobs-search.js buildFilter for why:
  // the auto-apply launcher sends a chosen City/Province and Country this way specifically so
  // this code never has to guess which half is the country from content alone (it can't:
  // "Georgia" resolves as a country in its own right, so a flattened "Georgia, United States"
  // would otherwise read as two alternative countries instead of one state within one country).
  // A pipe pair is always its own closed group, never merged with a place term accumulated
  // earlier in the same element.
  {
    const clausesForTerm = (term) => {
      const raw = String(term).trim().toLowerCase();
      const group = aliasGroup(term);
      // Match the term itself plus every alias in its country group (deduped).
      const variants = group ? Array.from(new Set([raw, ...group])) : [term];
      return variants.map((v) => (
        // Word-boundary only for KNOWN short aliases (us/uk/usa/uae) so they match as whole
        // words; everything else (incl. arbitrary short input like "NY") stays substring.
        isPostgres && isShortAlias(v) && aliasGroup(v)
          ? { sql: "j.location ~* ('\\y' || ? || '\\y')", param: String(v).toLowerCase() }
          : { sql: 'j.location ILIKE ?', param: `%${v}%` }
      ));
    };

    // One closed group -> its SQL piece plus the param entries it needs, kept together so the
    // final param list can never drift out of step with the `?` placeholders in the SQL text.
    const groupSql = (places, countryEntries) => {
      const placeEntries = places.flatMap(clausesForTerm);
      const hasPlace = placeEntries.length > 0;
      const hasCountry = !!(countryEntries && countryEntries.length);
      if (hasPlace && hasCountry) {
        return {
          sql: `((${placeEntries.map((e) => e.sql).join(' OR ')}) AND (${countryEntries.map((e) => e.sql).join(' OR ')}))`,
          entries: [...placeEntries, ...countryEntries],
        };
      }
      if (hasPlace) return { sql: `(${placeEntries.map((e) => e.sql).join(' OR ')})`, entries: placeEntries };
      return { sql: `(${countryEntries.map((e) => e.sql).join(' OR ')})`, entries: countryEntries };
    };

    // Read one caller-supplied element into its closed groups. A country can close a run of
    // places from EITHER side, not just the trailing one — see the matching comment in
    // jobs-search.js buildFilter for the full rationale and the "United States, Nashville, New
    // Orleans" real-world case (32,498 search-demand searches, 2026-09-13) this handles. A
    // country seen with nothing accumulated yet is held as `pendingCountry` rather than closed
    // immediately, in case places follow it; it stands alone once something proves it isn't
    // qualifying anything (another country arriving first, or the element ending on it).
    const groupsForElement = (raw) => {
      const groups = [];
      let openPlaces = [];
      let openAmbiguous = []; // entries for e.g. "Georgia" while its run is still undecided
      let pendingCountry = null; // { entries, isUS }
      const flushPending = () => {
        if (pendingCountry) { groups.push(groupSql([], pendingCountry.entries)); pendingCountry = null; }
      };
      // Closes the current run. `country` is null for an unresolved (trailing) close. An
      // ambiguous term's own country reading is only dropped when the run closes on United
      // States specifically — see the matching comment in jobs-search.js buildFilter for why
      // any other closing country keeps both readings instead of silently discarding one.
      const closeRun = (country) => {
        if (!country || !country.isUS) for (const amb of openAmbiguous) groups.push(groupSql([], amb));
        if (openPlaces.length || country) groups.push(groupSql(openPlaces, country ? country.entries : null));
        openPlaces = [];
        openAmbiguous = [];
      };

      for (const part of String(raw).split(',').map((s) => s.trim()).filter(Boolean)) {
        const pipeParts = part.includes('|') ? part.split('|').map((s) => s.trim()).filter(Boolean) : null;
        if (pipeParts && pipeParts.length >= 2 && resolveCountry(pipeParts[pipeParts.length - 1])) {
          // A pipe pair is always its own group — flush whatever came before (unresolved)
          // instead of merging into or being merged with it.
          flushPending();
          closeRun(null);
          groups.push(groupSql(pipeParts.slice(0, -1), clausesForTerm(pipeParts[pipeParts.length - 1])));
          continue;
        }
        // If it had a pipe but the trailing segment isn't a recognised country, fall through
        // and resolve the original text as one ordinary term instead of silently dropping half.
        const country = resolveCountry(part);
        if (country && AMBIGUOUS_COUNTRY_NAMES.has(norm(part))) {
          // Hold both readings open rather than committing: "georgia" is carried as an ordinary
          // place term for whatever run it sits in, and its own country reading waits in
          // `openAmbiguous` until closeRun() decides whether United States settled it.
          openAmbiguous.push(clausesForTerm(part));
          openPlaces.push(part);
        } else if (country) {
          const entry = { entries: clausesForTerm(part), isUS: country.code === 'us' };
          if (openPlaces.length || openAmbiguous.length) {
            // Closes with the NEAREST country, not an older pending one. A pending country this
            // run passed without using stands alone instead of vanishing.
            flushPending();
            closeRun(entry);
          } else {
            // Nothing accumulated yet — hold it in case it qualifies what comes next. An
            // earlier still-pending country stands alone now: two countries back to back are
            // alternatives, neither qualifies the other.
            flushPending();
            pendingCountry = entry;
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
    if (groups.length > 0) {
      clauses.push(`(${groups.map((g) => g.sql).join(' OR ')})`);
      for (const g of groups) for (const e of g.entries) params.push(e.param);
    }
  }

  // Posted — time window. Accepts Nh / Nd / Nw / Nm (e.g. 2h, 6h, 24h, 7d, 30d, 90d, 3m).
  // (Old code only knew 24h/7d/30d/90d and silently ignored anything else — so "2h" and
  // the documented "3m" did nothing at all.)
  if (filters.posted) {
    // Shared parser (utils/posted-window.js) so this and the index path cannot disagree about
    // what "7days" means. The regex that used to live here accepted "7d" but not "7days", and
    // an unparsed value added NO clause at all — the filter silently did nothing and the query
    // degraded to the expensive unfiltered one.
    const parsed = parsePostedWindow(filters.posted);
    if (parsed) {
      const { n, unit } = parsed; // n is an integer — safe to interpolate
      {
        // Filter on the date the UI shows as "Posted": posted_at when the source provides it,
        // else first_seen_at (which equals created_at — the UI's own fallback). Filtering on
        // first_seen_at alone surfaced freshly-crawled but long-posted listings (a newly
        // onboarded company's back-catalog) under "last 24h" — 94% of results weren't actually
        // posted in-window. Per-row single value => still monotonic across windows.
        //
        // This used to be spelled as an OR to keep planner estimates accurate, because no
        // posted_at index existed. One does now, so the COALESCE form is both equivalent and
        // indexable — see below.
        if (isPostgres) {
          const t = `NOW() - INTERVAL '${n} ${unit}'`;
          // COALESCE, not the OR form, so it can use idx_jobs_active_posted_ats — an
          // expression index on (COALESCE(posted_at, first_seen_at), ats). The OR form is
          // logically identical but unindexable, and countActive over it took 60s for a
          // 24h+ats filter; via the index the same count is 1.6s.
          clauses.push(`COALESCE(j.posted_at, j.first_seen_at) >= ${t}`);
        } else {
          // SQLite has no 'weeks' modifier — express weeks as days.
          const sUnit = unit === 'weeks' ? 'days' : unit;
          const sN = unit === 'weeks' ? n * 7 : n;
          const t = `datetime('now', '-${sN} ${sUnit}')`;
          clauses.push(`(j.posted_at >= ${t} OR (j.posted_at IS NULL AND j.first_seen_at >= ${t}))`);
        }
      }
    }
  }

  // Remote filter (uses indexed boolean column)
  if (filters.remote === 'true') {
    clauses.push('j.is_remote = true');
  }

  // Remote worldwide filter
  if (filters.remoteWorldwide === 'true') {
    clauses.push('j.remote_worldwide = true');
  }

  // Visa sponsorship filter
  if (filters.visa) {
    clauses.push('j.visa_sponsorship = ?');
    params.push(filters.visa);
  }

  // Experience level filter — multi-value (SQL IN)
  {
    const levels = toList(filters.experienceLevel);
    if (levels.length > 0) {
      clauses.push(`j.experience_level IN (${levels.map(() => '?').join(', ')})`);
      params.push(...levels);
    }
  }

  // Exact filters
  if (filters.companyId) {
    clauses.push('j.company_id = ?');
    params.push(filters.companyId);
  }
  {
    // ATS filter now uses toList so callers may pass either an array OR a
    // comma-separated string (the route handler historically split on commas,
    // but with toList we accept both forms transparently).
    const atsList = toList(filters.ats);
    if (atsList.length > 0) {
      clauses.push(`j.ats IN (${atsList.map(() => '?').join(', ')})`);
      params.push(...atsList);
    }
  }

  return { clauses, params, needsJoin };
}

const jobsRepo = {
  async findActive(filters = {}) {
    const { clauses, params, needsJoin } = buildFilters(filters);

    // Always join companies for company data in response
    // Optionally include description (excluded by default for performance)
    const descCol = filters.includeDescription ? ', j.description' : '';
    const cols = `SELECT j.id, j.external_id, j.company_id, j.ats, j.title, j.department,
        j.location, j.workplace_type, j.employment_type, j.salary_min, j.salary_max,
        j.salary_currency, j.salary_interval, j.salary_min_annual, j.salary_max_annual,
        j.url, j.posted_at, j.first_seen_at,
        j.is_remote, j.remote_worldwide, j.visa_sponsorship, j.experience_level,
        c.domain, c.ats_slug, c.company_name, c.logo_url${descCol}`;

    // With ORDER BY first_seen_at DESC + LIMIT the planner walks idx_jobs_active_firstseen in
    // date order and filters each row, ignoring the GIN index, because it assumes it will hit
    // the LIMIT quickly. Add a location/ats filter and it must walk far deeper — that is the
    // shape that ran 100-240s on 2026-08-05 and exhausted the pool.
    //
    // Materialising the filter first drops the ORDER BY that makes the date index look
    // attractive, so the GIN index is used and the sort covers only matching rows. Applied
    // ONLY when the search is narrowed, because measured on 2.8M live jobs:
    //   bare common term ("software")     order-then-filter   379ms | CTE 10,653ms
    //   bare rare term                                        264ms | CTE    236ms
    //   term + location + ats                               1,305ms | CTE    537ms
    // A bare keyword matches plenty of recent jobs, so the date walk fills the LIMIT almost
    // immediately and materialising every match instead is 28x worse.
    const narrowed = !!(filters.location || filters.ats || filters.companyId
      || filters.employmentType || filters.experienceLevel);

    let sql;
    if (isPostgres && filters.q && narrowed) {
      sql = `WITH matched AS MATERIALIZED (
          SELECT j.id, j.first_seen_at, j.random_rank
            FROM jobs j JOIN companies c ON j.company_id = c.id
           WHERE ${clauses.join(' AND ')}
        )
        ${cols}
          FROM matched m
          JOIN jobs j ON j.id = m.id
          JOIN companies c ON j.company_id = c.id
         ORDER BY m.first_seen_at DESC, m.random_rank`;
    } else {
      sql = `${cols}
      FROM jobs j JOIN companies c ON j.company_id = c.id
      WHERE ${clauses.join(' AND ')}
      ORDER BY j.first_seen_at DESC, j.random_rank`;
    }

    if (filters.limit) {
      sql += ' LIMIT ?';
      params.push(filters.limit);
      if (filters.offset) {
        sql += ' OFFSET ?';
        params.push(filters.offset);
      }
    }

    const { rows } = await query(sql, params);
    return rows;
  },

  async countActive(filters = {}) {
    const { clauses, params, needsJoin } = buildFilters(filters);

    // For unfiltered counts on Postgres, use fast estimated count
    const isUnfiltered = clauses.length === 1 && clauses[0] === 'j.removed_at IS NULL';
    if (isUnfiltered && isPostgres) {
      const { rows } = await query(
        "SELECT reltuples::bigint AS count FROM pg_class WHERE relname = 'jobs'"
      );
      const estimate = parseInt(rows[0]?.count, 10);
      // Use estimate if reasonable (> 0), otherwise fall back to exact
      if (estimate > 0) return estimate;
    }

    // Counting is capped. An exact count has to visit every matching row, so it scales with
    // how popular the filter is rather than with what the user sees: a filter matching 1.4M
    // jobs was costing 40-60s under load while the 20 rows actually rendered took ~300ms.
    // Stopping at COUNT_CAP+1 makes the cost bounded no matter how broad the search.
    //
    // The cap is deliberately far beyond real paging (10,000 = 200 pages at 50/page). Callers
    // can tell a capped count from an exact one because it comes back as exactly COUNT_CAP+1.
    const inner = needsJoin
      ? `SELECT 1 FROM jobs j JOIN companies c ON j.company_id = c.id WHERE ${clauses.join(' AND ')} LIMIT ${COUNT_CAP + 1}`
      : `SELECT 1 FROM jobs j WHERE ${clauses.join(' AND ')} LIMIT ${COUNT_CAP + 1}`;

    const { rows } = await query(`SELECT COUNT(*) as count FROM (${inner}) t`, params);
    return parseInt(rows[0].count, 10);
  },

  async findById(id) {
    const { rows } = await query(
      `SELECT j.*, c.domain, c.ats_slug, c.company_name, c.logo_url FROM jobs j
       JOIN companies c ON j.company_id = c.id WHERE j.id = ?`,
      [id]
    );
    return rows[0] || null;
  },

  async syncForCompany(companyId, ats, incomingJobs) {
    let added = 0;
    let updated = 0;
    let removed = 0;
    let skippedRemoval = false;

    // Only sync jobs posted within the last 30 days — users want fresh listings.
    // Jobs without a posted date are kept (can't determine age).
    const THIRTY_DAYS_AGO = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const freshJobs = incomingJobs.filter(job => {
      if (!job.posted_at) return true;
      const posted = new Date(job.posted_at);
      return !isNaN(posted.getTime()) && posted >= THIRTY_DAYS_AGO;
    });

    await transaction(async (tx) => {
      const { rows: existingJobs } = await tx.query(
        'SELECT id, external_id FROM jobs WHERE company_id = ? AND removed_at IS NULL',
        [companyId]
      );

      const existingMap = new Map(existingJobs.map(j => [j.external_id, j.id]));
      const incomingIds = new Set(freshJobs.map(j => j.external_id));

      for (const job of freshJobs) {
        await tx.query(
          `INSERT INTO jobs (
            external_id, company_id, ats, title, department, location,
            workplace_type, employment_type,
            salary_min, salary_max, salary_currency, salary_interval,
            description, url, posted_at, raw_data,
            visa_sponsorship, experience_level, is_remote, remote_worldwide,
            first_seen_at, last_seen_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
          ON CONFLICT(external_id, company_id) DO UPDATE SET
            title = EXCLUDED.title,
            department = EXCLUDED.department,
            location = EXCLUDED.location,
            workplace_type = EXCLUDED.workplace_type,
            employment_type = EXCLUDED.employment_type,
            salary_min = EXCLUDED.salary_min,
            salary_max = EXCLUDED.salary_max,
            salary_currency = EXCLUDED.salary_currency,
            salary_interval = EXCLUDED.salary_interval,
            description = COALESCE(EXCLUDED.description, jobs.description),
            url = EXCLUDED.url,
            posted_at = EXCLUDED.posted_at,
            raw_data = EXCLUDED.raw_data,
            visa_sponsorship = CASE WHEN EXCLUDED.visa_sponsorship != '' THEN EXCLUDED.visa_sponsorship ELSE jobs.visa_sponsorship END,
            experience_level = CASE WHEN EXCLUDED.experience_level != '' THEN EXCLUDED.experience_level ELSE jobs.experience_level END,
            is_remote = EXCLUDED.is_remote,
            remote_worldwide = EXCLUDED.remote_worldwide,
            last_seen_at = datetime('now'),
            removed_at = NULL`,
          [
            job.external_id, companyId, ats,
            job.title, job.department || null, job.location,
            // Normalised at the single point every sync path funnels through, so the
            // filters above can match canonical values exactly instead of scanning with ILIKE.
            normalizeWorkplaceType(job.workplace_type), normalizeEmploymentType(job.employment_type),
            job.salary_min || null, job.salary_max || null,
            job.salary_currency || null, job.salary_interval || null,
            job.description || null, job.url, job.posted_at || null,
            JSON.stringify(job.raw_data || null),
            job.visa_sponsorship || '',
            job.experience_level || '',
            job.is_remote || false,
            job.remote_worldwide || false,
          ]
        );
        if (existingMap.has(job.external_id)) {
          updated++;
        } else {
          added++;
        }
      }

      // Guard against partial API responses wiping out jobs
      const existingCount = existingMap.size;
      const missingCount = [...existingMap.keys()].filter(id => !incomingIds.has(id)).length;
      const skipRemoval = existingCount > 0 && (
        freshJobs.length === 0 ||
        missingCount / existingCount > 0.5
      );

      if (skipRemoval) {
        skippedRemoval = true;
        logger.warn(
          { companyId, ats, existingCount, incomingCount: freshJobs.length, missingCount },
          'Skipping job removal — incoming count dropped too much, likely partial API response'
        );
      } else {
        for (const [externalId, dbId] of existingMap) {
          if (!incomingIds.has(externalId)) {
            await tx.query("UPDATE jobs SET removed_at = datetime('now') WHERE id = ?", [dbId]);
            removed++;
          }
        }
      }
    });

    logger.info({ companyId, added, updated, removed, skippedRemoval }, 'Job sync diff complete');
    return { added, updated, removed };
  },
};

module.exports = jobsRepo;
module.exports.COUNT_CAP = COUNT_CAP;
