const { query, transaction, isPostgres } = require('../connection');
const logger = require('../../logger');
const { aliasGroup, isShortAlias } = require('../../utils/location-aliases');
const { annualiseSalary } = require('../../utils/salary');

/**
 * Build WHERE clauses from filters.
 * Returns { clauses: string[], params: any[], needsJoin: boolean }
 */
function buildFilters(filters = {}) {
  const clauses = ['j.removed_at IS NULL'];
  const params = [];
  let needsJoin = false;

  // Role / Keywords — use full-text search on Postgres, ILIKE fallback on SQLite
  if (filters.q) {
    // Support comma-separated role queries: "Senior Developer, technical writer"
    // Each comma-separated term is a separate role query, OR'd together
    const roles = filters.q.split(',').map(r => r.trim()).filter(Boolean);

    if (isPostgres) {
      if (roles.length === 1) {
        // Single role: AND all words together
        const tsquery = roles[0].split(/\s+/).filter(Boolean).join(' & ');
        clauses.push("j.search_vector @@ to_tsquery('english', ?)");
        params.push(tsquery);
      } else {
        // Multiple roles: each role is AND'd internally, roles are OR'd together
        const tsqueries = roles.map(role => {
          const words = role.split(/\s+/).filter(Boolean).join(' & ');
          params.push(words);
          return "j.search_vector @@ to_tsquery('english', ?)";
        });
        clauses.push('(' + tsqueries.join(' OR ') + ')');
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
      const groups = [];
      for (const m of modes) {
        if (m === 'remote') {
          groups.push('(j.workplace_type ILIKE ? OR j.location ILIKE ? OR j.title ILIKE ?)');
          params.push('%remote%', '%remote%', '%remote%');
        } else if (m === 'hybrid') {
          groups.push('(j.workplace_type ILIKE ? OR j.location ILIKE ?)');
          params.push('%hybrid%', '%hybrid%');
        } else if (m === 'onsite' || m === 'on-site' || m === 'on_site') {
          groups.push('(j.workplace_type ILIKE ? OR j.workplace_type ILIKE ?)');
          params.push('%on-site%', '%onsite%');
        }
      }
      if (groups.length > 0) clauses.push('(' + groups.join(' OR ') + ')');
    }
  }

  // Employment type: full-time, part-time, contract, internship — multi-value
  {
    const types = toList(filters.employmentType).filter((t) => t.toLowerCase() !== 'any');
    if (types.length > 0) {
      const groups = types.map(() => '(j.employment_type ILIKE ? OR j.title ILIKE ?)');
      clauses.push('(' + groups.join(' OR ') + ')');
      for (const t of types) params.push(`%${t}%`, `%${t}%`);
    }
  }

  // Location — multi-value free-text match (OR'd), with country-alias expansion so e.g.
  // "UAE" also matches jobs stored as "United Arab Emirates" (and USA/US<->United States,
  // UK<->United Kingdom, ...). Long unambiguous aliases use a substring match; short ones
  // (us/uk/usa/uae) use a word-boundary regex so "us" doesn't match "Houston".
  {
    const locs = toList(filters.location);
    if (locs.length > 0) {
      const or = [];
      for (const l of locs) {
        const raw = String(l).trim().toLowerCase();
        const group = aliasGroup(l);
        // Match the term itself plus every alias in its country group (deduped).
        const terms = group ? Array.from(new Set([raw, ...group])) : [l];
        for (const term of terms) {
          // Word-boundary only for KNOWN short aliases (us/uk/usa/uae) so they match as whole
          // words; everything else (incl. arbitrary short input like "NY") stays substring.
          if (isPostgres && isShortAlias(term) && aliasGroup(term)) {
            or.push("j.location ~* ('\\y' || ? || '\\y')"); params.push(String(term).toLowerCase());
          } else {
            or.push('j.location ILIKE ?'); params.push(`%${term}%`);
          }
        }
      }
      clauses.push('(' + or.join(' OR ') + ')');
    }
  }

  // Posted — time window. Accepts Nh / Nd / Nw / Nm (e.g. 2h, 6h, 24h, 7d, 30d, 90d, 3m).
  // (Old code only knew 24h/7d/30d/90d and silently ignored anything else — so "2h" and
  // the documented "3m" did nothing at all.)
  if (filters.posted) {
    const m = String(filters.posted).trim().match(/^(\d+)\s*([hdwm])$/i);
    if (m) {
      const n = parseInt(m[1], 10); // integer — safe to interpolate
      const unit = { h: 'hours', d: 'days', w: 'weeks', m: 'months' }[m[2].toLowerCase()];
      if (n > 0 && unit) {
        // Filter on the date the UI shows as "Posted": posted_at when the source provides it,
        // else first_seen_at (which equals created_at — the UI's own fallback). Filtering on
        // first_seen_at alone surfaced freshly-crawled but long-posted listings (a newly
        // onboarded company's back-catalog) under "last 24h" — 94% of results weren't actually
        // posted in-window. The OR-form is equivalent to COALESCE(posted_at, first_seen_at) but
        // keeps an accurate planner row estimate (no posted_at index exists). Per-row single
        // value => still monotonic across windows.
        if (isPostgres) {
          const t = `NOW() - INTERVAL '${n} ${unit}'`;
          clauses.push(`(j.posted_at >= ${t} OR (j.posted_at IS NULL AND j.first_seen_at >= ${t}))`);
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
    let sql = `SELECT j.id, j.external_id, j.company_id, j.ats, j.title, j.department,
        j.location, j.workplace_type, j.employment_type, j.salary_min, j.salary_max,
        j.salary_currency, j.salary_interval, j.url, j.posted_at, j.first_seen_at,
        j.is_remote, j.remote_worldwide, j.visa_sponsorship, j.experience_level,
        c.domain, c.ats_slug, c.company_name, c.logo_url${descCol}
      FROM jobs j JOIN companies c ON j.company_id = c.id
      WHERE ${clauses.join(' AND ')}
      ORDER BY j.first_seen_at DESC, j.random_rank`;

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

    let sql;
    if (needsJoin) {
      sql = `SELECT COUNT(*) as count FROM jobs j JOIN companies c ON j.company_id = c.id WHERE ${clauses.join(' AND ')}`;
    } else {
      sql = `SELECT COUNT(*) as count FROM jobs j WHERE ${clauses.join(' AND ')}`;
    }

    const { rows } = await query(sql, params);
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

    // NOTE: posting age is a query-time concern (the API/UI filters by posted_at),
    // NOT an ingest-time one. We used to drop >30-day-old postings from the incoming
    // set before upserting, which meant any company whose live inventory skewed old
    // never got those rows' last_seen_at refreshed. Always upsert everything the
    // adapter returns.
    //
    // Removal no longer happens here at all. It used to be list-diff based (mark
    // removed_at on any stored external_id missing from this sync's incoming set),
    // guarded by a >50%-missing skip heuristic meant to protect against partial API
    // responses. In production that guard caused more harm than it prevented: it
    // conflated "adapter had a bad response" with "this company's inventory
    // genuinely shrank," freezing real closures forever (confirmed via ashby's
    // jerry.ai: 350 stored -> 48 actually open, frozen because 97% were "missing").
    // Worse, list-diffing itself is unreliable — external_id churn (a job reposted
    // under a new id while still live at the same URL) showed up independently on
    // both Greenhouse (bayada: 603 "missing" jobs, 15/15 HTTP-verified still alive)
    // and Workday (stout, same pattern at 23-job scale) — see
    // docs/DATA-QUALITY-PLAN.md and the project_greenhouse_external_id_churn memory.
    // A blind list-diff would have deleted hundreds of live jobs.
    //
    // Removal is now handled entirely by pruneDeadJobs() in
    // src/tasks/dead-job-check.js, which only marks a job removed on an
    // HTTP-confirmed 404/410 or an explicit "no longer available" page — never on
    // a diff heuristic. Its eligibility query is extended to prioritize jobs whose
    // company just completed a sync that didn't touch them (see there), so the
    // "missing from latest sync" population gets verified promptly instead of
    // waiting out the general 30-day-old rotation.

    await transaction(async (tx) => {
      const { rows: existingJobs } = await tx.query(
        'SELECT id, external_id FROM jobs WHERE company_id = ? AND removed_at IS NULL',
        [companyId]
      );

      const existingMap = new Map(existingJobs.map(j => [j.external_id, j.id]));

      // Deduplicate by external_id before batching. A multi-row INSERT ... ON CONFLICT
      // errors outright ("cannot affect row a second time") if one statement carries the
      // same conflict key twice, and adapters do occasionally emit a duplicate posting.
      // Last occurrence wins, which is what the old row-at-a-time loop ended up with.
      const deduped = [...new Map(incomingJobs.map(j => [j.external_id, j])).values()];

      for (const job of deduped) {
        if (existingMap.has(job.external_id)) updated++;
        else added++;
      }

      // Insert in chunks rather than one statement per job. The whole loop runs inside a
      // single transaction, so a round-trip per job meant a big tenant held its connection
      // (as "idle in transaction") for minutes — with ~11 crawlers doing that concurrently
      // the essential-2 40-connection cap was permanently near exhaustion. Batching cuts
      // round-trips ~200x and the hold time from minutes to seconds.
      //
      // CHUNK is bounded by Postgres's 65535 bind-parameter ceiling: 20 params/row, so
      // 200 rows = 4000 params, comfortably clear.
      const CHUNK = 200;
      for (let i = 0; i < deduped.length; i += CHUNK) {
        const slice = deduped.slice(i, i + CHUNK);
        const rowSql = `(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`;
        const params = [];
        for (const job of slice) {
          params.push(
            job.external_id, companyId, ats,
            job.title, job.department || null, job.location,
            job.workplace_type || null, job.employment_type || null,
            job.salary_min || null, job.salary_max || null,
            job.salary_currency || null, job.salary_interval || null,
            job.description || null, job.url, job.posted_at || null,
            JSON.stringify(job.raw_data || null),
            job.visa_sponsorship || '',
            job.experience_level || '',
            job.is_remote || false,
            job.remote_worldwide || false,
            // Annualised so salary is comparable between postings: the raw columns are TEXT and
            // each posting states its own interval, so hourly and yearly rows cannot be compared
            // without this. Null when the interval is missing or implausible for the amount.
            annualiseSalary(job.salary_min, job.salary_interval),
            annualiseSalary(job.salary_max, job.salary_interval)
          );
        }

        await tx.query(
          `INSERT INTO jobs (
            external_id, company_id, ats, title, department, location,
            workplace_type, employment_type,
            salary_min, salary_max, salary_currency, salary_interval,
            description, url, posted_at, raw_data,
            visa_sponsorship, experience_level, is_remote, remote_worldwide,
            salary_min_annual, salary_max_annual,
            first_seen_at, last_seen_at
          )
          VALUES ${slice.map(() => rowSql).join(', ')}
          ON CONFLICT(external_id, company_id) DO UPDATE SET
            title = EXCLUDED.title,
            department = EXCLUDED.department,
            location = EXCLUDED.location,
            workplace_type = EXCLUDED.workplace_type,
            employment_type = EXCLUDED.employment_type,
            -- COALESCE, not a plain overwrite. Several ATS (paylocity, workable, ...) carry
            -- no salary in the list response, so the adapter passes NULL every sync — an
            -- unconditional assignment therefore ERASED anything the description/salary
            -- backfill had recovered. Measured: of 29,710 salaries a one-time paylocity
            -- sweep recovered over 18.5h, only ~2.6k survived, and jobs not re-synced in
            -- the last 3h still held salary at 9.8% vs 2.0% for those that were.
            -- Trade-off is the same one description already makes: a salary an employer
            -- genuinely removes stays until the row is replaced.
            salary_min = COALESCE(EXCLUDED.salary_min, jobs.salary_min),
            salary_max = COALESCE(EXCLUDED.salary_max, jobs.salary_max),
            salary_currency = COALESCE(EXCLUDED.salary_currency, jobs.salary_currency),
            salary_interval = COALESCE(EXCLUDED.salary_interval, jobs.salary_interval),
            -- Same COALESCE as the columns they derive from, or a sync carrying no salary would
            -- blank the annualised copy while the raw values survive, and the two would disagree.
            salary_min_annual = COALESCE(EXCLUDED.salary_min_annual, jobs.salary_min_annual),
            salary_max_annual = COALESCE(EXCLUDED.salary_max_annual, jobs.salary_max_annual),
            -- description and raw_data are the two large (TOASTed) columns, and nearly every
            -- sync re-sends them unchanged. Assigning EXCLUDED.* writes a fresh TOAST copy even
            -- when it is byte-identical; handing back jobs.* keeps the stored pointer, so nothing
            -- is rewritten. Measured on the prod schema and settings (isolated instance, 2,000
            -- realistic jobs, unchanged re-sync): WAL 27.3 MB -> 3.6 MB steady state, 43.9 MB ->
            -- 4.2 MB right after a checkpoint. The rewrites had the VPS writing ~29 GB of WAL an
            -- hour and queueing commits on WALWrite (2026-09-26).
            description = CASE WHEN EXCLUDED.description IS NOT NULL
                                AND EXCLUDED.description IS DISTINCT FROM jobs.description
                               THEN EXCLUDED.description ELSE jobs.description END,
            url = EXCLUDED.url,
            posted_at = EXCLUDED.posted_at,
            raw_data = CASE WHEN EXCLUDED.raw_data IS DISTINCT FROM jobs.raw_data
                            THEN EXCLUDED.raw_data ELSE jobs.raw_data END,
            visa_sponsorship = CASE WHEN EXCLUDED.visa_sponsorship != '' THEN EXCLUDED.visa_sponsorship ELSE jobs.visa_sponsorship END,
            experience_level = CASE WHEN EXCLUDED.experience_level != '' THEN EXCLUDED.experience_level ELSE jobs.experience_level END,
            is_remote = EXCLUDED.is_remote,
            remote_worldwide = EXCLUDED.remote_worldwide,
            last_seen_at = datetime('now'),
            removed_at = NULL`,
          params
        );
      }
    });

    logger.info({ companyId, added, updated }, 'Job sync diff complete');
    // removed is always 0 now — see the comment above. Kept in the return shape
    // since sync.queue.js reports it in metrics/logs; a non-zero removal count
    // will only ever come from pruneDeadJobs, not from here.
    return { added, updated, removed: 0 };
  },
};

module.exports = jobsRepo;
