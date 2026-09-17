const { exec, query, isPostgres } = require('./connection');
const logger = require('../logger');

async function migrate() {
  const autoId = isPostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  // SQLite requires a parenthesised expression in a column DEFAULT — bare
  // `DEFAULT datetime('now')` is a syntax error, which made migrate() fail on the
  // very first CREATE TABLE and left the local DB with zero tables. Every use of
  // `now` below is a column DEFAULT, so the parens are safe for all of them.
  const now = isPostgres ? 'NOW()' : "(datetime('now'))";

  await exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id                 ${autoId},
      career_url         TEXT NOT NULL UNIQUE,
      domain             TEXT NOT NULL,
      ats                TEXT,
      ats_slug           TEXT,
      status             TEXT DEFAULT 'pending',
      last_discovered_at TIMESTAMP,
      last_synced_at     TIMESTAMP,
      error_message      TEXT,
      company_name       TEXT,
      logo_url           TEXT,
      origin             TEXT DEFAULT 'seed',
      created_at         TIMESTAMP DEFAULT ${now},
      updated_at         TIMESTAMP DEFAULT ${now}
    )
  `);

  await exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id              ${autoId},
      external_id     TEXT NOT NULL,
      company_id      INTEGER NOT NULL REFERENCES companies(id),
      ats             TEXT NOT NULL,
      title           TEXT NOT NULL,
      department      TEXT,
      location        TEXT,
      workplace_type  TEXT,
      employment_type TEXT,
      salary_min      TEXT,
      salary_max      TEXT,
      salary_currency TEXT,
      salary_interval TEXT,
      description     TEXT,
      url             TEXT,
      posted_at       TIMESTAMP,
      raw_data        TEXT,
      first_seen_at   TIMESTAMP DEFAULT ${now},
      last_seen_at    TIMESTAMP DEFAULT ${now},
      removed_at      TIMESTAMP,
      created_at      TIMESTAMP DEFAULT ${now},
      -- Classification columns. syncForCompany always writes these, so they belong in
      -- the base table: SQLite has no ALTER TABLE ... ADD COLUMN IF NOT EXISTS, and the
      -- ALTERs below are Postgres-only, which left a fresh SQLite DB missing them.
      -- On an existing Postgres database this CREATE is a no-op and the ALTERs still
      -- cover the upgrade path.
      visa_sponsorship TEXT,
      experience_level TEXT,
      is_remote        BOOLEAN DEFAULT FALSE,
      remote_worldwide BOOLEAN DEFAULT FALSE,
      -- Same story, and for the same reason: syncForCompany's upsert names role_category in
      -- its column list and absent_syncs in its ON CONFLICT clause on EVERY path, Postgres or
      -- not. SQLite prepares the whole statement up front, so a missing column here is not a
      -- latent bug that shows up on conflict — it fails the very first sync with
      -- "table jobs has no column named role_category". Both were Postgres-only ALTERs below,
      -- which left a fresh SQLite DB unable to ingest a single job.
      role_category    TEXT,
      absent_syncs     INTEGER NOT NULL DEFAULT 0,
      -- Annualised, numeric copies of salary_min/max, so salary is filterable at all.
      -- salary_min/max are TEXT (decimals, odd formats), which makes "> 200000" a STRING
      -- comparison where "90000" sorts above "200000"; and the interval varies as widely as the
      -- amount — hourly and yearly rows are near-equally common — so an un-annualised number is
      -- not comparable between postings. Written by syncForCompany via annualiseSalary().
      salary_min_annual  BIGINT,
      salary_max_annual  BIGINT,
      -- Ordering tiebreaker, read by findWithFilters on BOTH engines
      -- (ORDER BY j.first_seen_at DESC, j.random_rank), so it cannot be Postgres-only
      -- either: without it /api/jobs is a 500 on SQLite. The parenthesised default parses
      -- on both — SQLite requires the parens, Postgres tolerates them.
      random_rank      DOUBLE PRECISION DEFAULT (random()),
      UNIQUE(external_id, company_id)
    )
  `);

  // Upgrade path for local SQLite databases created before role_category, absent_syncs and
  // random_rank moved into the CREATE TABLE above. SQLite has no ADD COLUMN IF NOT EXISTS, so
  // each ALTER is attempted and ONLY "duplicate column name" is swallowed — anything else is a
  // real failure and must not be silently lost. random_rank carries no default here because
  // SQLite rejects a non-constant one on ADD COLUMN ("Cannot add a column with non-constant
  // default"); it is backfilled instead, and new rows get their default from the CREATE above.
  if (!isPostgres) {
    for (const [col, decl] of [
      ['salary_min_annual', 'BIGINT'],
      ['salary_max_annual', 'BIGINT'],
      ['role_category', 'TEXT'],
      ['absent_syncs', 'INTEGER NOT NULL DEFAULT 0'],
      ['random_rank', 'DOUBLE PRECISION'],
    ]) {
      try {
        await exec(`ALTER TABLE jobs ADD COLUMN ${col} ${decl}`);
        if (col === 'random_rank') await exec('UPDATE jobs SET random_rank = random() WHERE random_rank IS NULL');
      } catch (err) {
        if (!/duplicate column name/i.test(err.message)) throw err;
      }
    }
  }

  await exec('CREATE INDEX IF NOT EXISTS idx_jobs_company_id ON jobs(company_id)');
  await exec('CREATE INDEX IF NOT EXISTS idx_jobs_external_id ON jobs(external_id)');
  await exec('CREATE INDEX IF NOT EXISTS idx_jobs_removed_at ON jobs(removed_at)');
  await exec('CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status)');

  await exec(`
    CREATE TABLE IF NOT EXISTS crawl_sources (
      id          ${autoId},
      ats         TEXT NOT NULL,
      slug        TEXT NOT NULL,
      source      TEXT NOT NULL,
      crawl_run   TEXT,
      created_at  TIMESTAMP DEFAULT ${now},
      UNIQUE(ats, slug)
    )
  `);

  await exec('CREATE INDEX IF NOT EXISTS idx_crawl_sources_ats ON crawl_sources(ats)');

  // Demand capture: every user search (via the board API) is recorded + aggregated here so the
  // crawlers can be steered toward what users actually look for. `demand_key` is a normalized
  // string of the (query,location,type,experience,work_mode) combo used for upsert dedup — a
  // composite UNIQUE would break on NULLs, so we key on the derived string instead. A new
  // empty table -> CREATE takes no lock on jobs/companies (safe on boot).
  await exec(`
    CREATE TABLE IF NOT EXISTS search_demand (
      id                ${autoId},
      demand_key        TEXT NOT NULL UNIQUE,
      query_text        TEXT,
      location          TEXT,
      employment_type   TEXT,
      experience_level  TEXT,
      work_mode         TEXT,
      search_count      INTEGER DEFAULT 1,
      last_result_count INTEGER,
      min_result_count  INTEGER,
      first_seen_at     TIMESTAMP DEFAULT ${now},
      last_seen_at      TIMESTAMP DEFAULT ${now}
    )
  `);
  await exec('CREATE INDEX IF NOT EXISTS idx_search_demand_priority ON search_demand(search_count DESC, last_result_count ASC)');
  await exec('CREATE INDEX IF NOT EXISTS idx_search_demand_last_seen ON search_demand(last_seen_at DESC)');

  // Fix salary columns from INTEGER to TEXT (avoid type issues with decimals)
  if (isPostgres) {
    try {
      await exec('ALTER TABLE jobs ALTER COLUMN salary_min TYPE TEXT USING salary_min::TEXT');
      await exec('ALTER TABLE jobs ALTER COLUMN salary_max TYPE TEXT USING salary_max::TEXT');
    } catch { /* already text */ }
  }

  // Additional indexes for search/sort performance
  if (isPostgres) {
    try { await exec('CREATE EXTENSION IF NOT EXISTS pg_trgm'); } catch { /* may not have permission */ }
    await exec('CREATE INDEX IF NOT EXISTS idx_jobs_location ON jobs(location)');
    await exec('CREATE INDEX IF NOT EXISTS idx_jobs_first_seen ON jobs(first_seen_at DESC)');
    await exec('CREATE INDEX IF NOT EXISTS idx_companies_name ON companies(company_name)');
  }

  // Job classification columns for persona targeting (H1B, remote, entry-level)
  if (isPostgres) {
    await exec('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS visa_sponsorship TEXT');
    await exec('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS experience_level TEXT');
    await exec('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS is_remote BOOLEAN DEFAULT FALSE');
    await exec('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS remote_worldwide BOOLEAN DEFAULT FALSE');
    await exec('CREATE INDEX IF NOT EXISTS idx_jobs_is_remote ON jobs(is_remote) WHERE removed_at IS NULL AND is_remote = TRUE');
    await exec('CREATE INDEX IF NOT EXISTS idx_jobs_remote_worldwide ON jobs(remote_worldwide) WHERE removed_at IS NULL AND remote_worldwide = TRUE');
    await exec('CREATE INDEX IF NOT EXISTS idx_jobs_visa ON jobs(visa_sponsorship) WHERE removed_at IS NULL');
    await exec('CREATE INDEX IF NOT EXISTS idx_jobs_experience ON jobs(experience_level) WHERE removed_at IS NULL');
  }

  // Absence counter — the mechanism that lets SYNC retire jobs again.
  //
  // Removal was taken out of syncForCompany because list-diffing was unsafe: a single partial
  // adapter response marked every unreturned job dead, and the >50%-missing guard bolted on to
  // stop that then froze real closures forever (ashby's jerry.ai held 350 stored against 48
  // actually open). Nothing replaced it, so a 5,000-per-cycle HTTP scan became the ONLY
  // retirement path for a 5M-row table — jobs leaked in far faster than it could clear them.
  //
  // A counter fixes the thing that made list-diffing unsafe. One absence proves nothing and
  // retires nothing; it takes N CONSECUTIVE successful syncs without a job before it goes. A
  // flaky page, a rate limit or a truncated response costs one increment and is wiped the moment
  // the job reappears, while a genuine closure still clears in N syncs instead of never.
  if (isPostgres) {
    await exec('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS absent_syncs INTEGER NOT NULL DEFAULT 0');
    // Partial: only live rows that have actually gone missing at least once are ever scanned,
    // which keeps this index tiny relative to the 5M-row table and shrinking as jobs return.
    await exec('CREATE INDEX IF NOT EXISTS idx_jobs_absent_syncs ON jobs(company_id, absent_syncs) WHERE removed_at IS NULL AND absent_syncs > 0');
  }

  // Annualised salary — added here too so an existing Postgres database gains the columns.
  if (isPostgres) {
    await exec('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS salary_min_annual BIGINT');
    await exec('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS salary_max_annual BIGINT');
    // Partial: only priced, live rows are ever scanned by a salary filter, and the filter
    // always excludes unpriced jobs, so the index never has to carry them.
    await exec('CREATE INDEX IF NOT EXISTS idx_jobs_salary_annual ON jobs (salary_min_annual) WHERE removed_at IS NULL AND salary_min_annual IS NOT NULL');
  }

  // Random rank for shuffling jobs from same sync batch
  if (isPostgres) {
    await exec('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS random_rank DOUBLE PRECISION DEFAULT random()');
  }

  // Why a job was retired, when something other than the absence counter retired it — today that
  // is the apply automation reporting a posting it found gone (POST /api/jobs/retire). Removal is
  // soft, so this is the only record of who removed a row and on what evidence; without it a
  // wrongly-retired job looks identical to one the crawlers stopped seeing.
  if (isPostgres) {
    await exec('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS removed_reason TEXT');
  }

  // Dead-job pruning: records when each job's URL was last verified live. The worker
  // rotates through jobs least-recently-checked first; partial index keeps that scan cheap.
  if (isPostgres) {
    await exec('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMP');
    await exec('CREATE INDEX IF NOT EXISTS idx_jobs_last_checked ON jobs(last_checked_at) WHERE removed_at IS NULL');
  }

  // Facet/aggregate indexes. The sidebar counts (/api/facets) and the totals on the landing
  // page GROUP BY these columns across every live job. Without a partial index covering the
  // grouped column they are sequential scans of ~2.8M rows: measured 37-64 SECONDS each, and
  // they ran ~18k times apiece — by total execution time they were the single largest load on
  // the database, far above anything the crawlers did.
  //
  // The index alone is not enough. An index-only scan needs the visibility map, which is empty
  // until the table is vacuumed — on a freshly restored database these same queries still took
  // 45s WITH the indexes present, and only dropped to sub-second after VACUUM. See the
  // autovacuum settings below: if autovacuum falls behind, the visibility map goes stale and
  // every one of these silently reverts to a full scan.
  if (isPostgres) {
    // role_category is derived from the title at write time (classifyRoleCategory). It used
    // to be computed at query time by a ~25-branch CASE over every live job, which made
    // /api/roles a 40s full scan that Heroku's router killed at 30s — so the endpoint could
    // never populate its own cache. Stored and indexed, that becomes an indexed GROUP BY.
    await exec('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS role_category TEXT');
    await exec('CREATE INDEX IF NOT EXISTS idx_jobs_role_category_active ON jobs (role_category) WHERE removed_at IS NULL');

    await exec('CREATE INDEX IF NOT EXISTS idx_jobs_emptype_active ON jobs (employment_type) WHERE removed_at IS NULL AND employment_type IS NOT NULL');
    await exec('CREATE INDEX IF NOT EXISTS idx_jobs_ats_active ON jobs (ats) WHERE removed_at IS NULL');
    await exec('CREATE INDEX IF NOT EXISTS idx_jobs_workplace_active ON jobs (workplace_type) WHERE removed_at IS NULL AND workplace_type IS NOT NULL');
    await exec('CREATE INDEX IF NOT EXISTS idx_jobs_location_active ON jobs (location) WHERE removed_at IS NULL AND location IS NOT NULL');
    // COUNT(*) + COUNT(*) FILTER (WHERE is_remote) on the landing page. The pre-existing
    // idx_jobs_is_remote only covers is_remote = TRUE, so it could not serve the total.
    await exec('CREATE INDEX IF NOT EXISTS idx_jobs_isremote_all_active ON jobs (is_remote) WHERE removed_at IS NULL');
    // "Hot locations in the last 24h" — first_seen_at alone still needed a heap fetch per row
    // for location; carrying location in the index makes it index-only (9.5s -> 0.3s).
    await exec('CREATE INDEX IF NOT EXISTS idx_jobs_active_fs_loc ON jobs (first_seen_at DESC, location) WHERE removed_at IS NULL');

    // Location filtering is `location ILIKE '%text%'`, which no btree index can serve because
    // of the leading wildcard — so it was evaluated row by row against every job matching the
    // keyword. That, not the plan shape, is what made "engineer" + "%remote%" take 15-17s
    // whichever way the query was written. A trigram index makes the ILIKE indexable:
    //   engineer + %remote%, order-then-filter   16,750ms -> 4,571ms
    //   engineer + %remote%, materialised CTE    14,944ms -> 2,499ms
    // 142 MB on 2.8M live jobs.
    try {
      await exec('CREATE INDEX IF NOT EXISTS idx_jobs_location_trgm ON jobs USING GIN (location gin_trgm_ops) WHERE removed_at IS NULL');
    } catch { /* needs pg_trgm, created above; skip if the extension was not permitted */ }
    // The "posted in the last N" filter is COALESCE(posted_at, first_seen_at) >= t. posted_at
    // had no index at all, so countActive over a 24h + ats filter scanned a huge slice of the
    // table: 60s, which blew the statement timeout and returned 500s. The expression index
    // makes the predicate indexable, and carrying ats in it makes the count index-only:
    //   count, OR form (unindexable)              60,551ms
    //   count, COALESCE + expression index        17,149ms
    //   count, COALESCE + (expr, ats) composite    1,610ms
    await exec('CREATE INDEX IF NOT EXISTS idx_jobs_active_posted_eff ON jobs (COALESCE(posted_at, first_seen_at) DESC) WHERE removed_at IS NULL');
    await exec('CREATE INDEX IF NOT EXISTS idx_jobs_active_posted_ats ON jobs (COALESCE(posted_at, first_seen_at) DESC, ats) WHERE removed_at IS NULL');

    // jobs churns constantly (every sync touches last_seen_at). At the default scale factor
    // autovacuum waits for ~20% of 4.4M rows to change before running, by which point the
    // visibility map is stale and the index-only scans above degrade to seq scans. Vacuum far
    // more eagerly on this one table — it is the difference between a 0.4s and a 45s sidebar.
    try {
      await exec('ALTER TABLE jobs SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01)');
    } catch { /* not permitted on some plans */ }
  }

  // Search-index outbox.
  //
  // The external search index has to learn about every row change, and there are ~30 distinct
  // writers: syncForCompany, the dead-job pruner, the stale-job DELETE, four description/salary/
  // classification backfills, two crawlers with their own upserts, and a long tail of one-off
  // scripts that run on a laptop and will never import application code. Polling cannot catch
  // them either: `jobs` has no updated_at, and the backfills deliberately touch no timestamp,
  // so "changed since T" would silently miss every description and salary fill.
  //
  // A trigger is the only thing that sees all of them. index_dirty_at is set on INSERT and on
  // any UPDATE that alters an indexed field; the sync task clears it once the document is
  // shipped. Deletes are handled separately — the stale-job cleanup already RETURNs the ids it
  // removed, and soft-deletes come through as an ordinary UPDATE of removed_at.
  if (isPostgres) {
    await exec('ALTER TABLE jobs ADD COLUMN IF NOT EXISTS index_dirty_at TIMESTAMP');
    // Partial index: only dirty rows are ever scanned, so this stays tiny (it is the work
    // queue, not a copy of the table).
    await exec('CREATE INDEX IF NOT EXISTS idx_jobs_index_dirty ON jobs (index_dirty_at) WHERE index_dirty_at IS NOT NULL');
    await exec(`
      CREATE OR REPLACE FUNCTION jobs_mark_index_dirty() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          NEW.index_dirty_at := NOW();
          RETURN NEW;
        END IF;
        -- Only re-index when something the index actually stores changed. Without this guard
        -- every sync would dirty every row it touches (syncForCompany bumps last_seen_at on
        -- ~every job, every cycle) and the queue would never drain.
        IF (NEW.title, NEW.location, NEW.company_id, NEW.ats, NEW.department,
            NEW.workplace_type, NEW.employment_type, NEW.experience_level,
            NEW.visa_sponsorship, NEW.is_remote, NEW.remote_worldwide,
            NEW.role_category, NEW.salary_min, NEW.salary_max, NEW.url,
            NEW.posted_at, NEW.removed_at)
           IS DISTINCT FROM
           (OLD.title, OLD.location, OLD.company_id, OLD.ats, OLD.department,
            OLD.workplace_type, OLD.employment_type, OLD.experience_level,
            OLD.visa_sponsorship, OLD.is_remote, OLD.remote_worldwide,
            OLD.role_category, OLD.salary_min, OLD.salary_max, OLD.url,
            OLD.posted_at, OLD.removed_at)
        THEN
          NEW.index_dirty_at := NOW();
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await exec('DROP TRIGGER IF EXISTS trig_jobs_index_dirty ON jobs');
    await exec('CREATE TRIGGER trig_jobs_index_dirty BEFORE INSERT OR UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION jobs_mark_index_dirty()');
  }

  // Company changes also invalidate index documents.
  //
  // Each job document carries denormalised company fields — logo_url, company_name, domain,
  // ats_slug — so a logo refresh or a rename makes every one of that company's documents
  // stale. The jobs trigger cannot see that: updating `companies` touches no job row.
  //
  // The flag goes on the COMPANY, not on its jobs. Marking jobs directly would fan out
  // immediately — 36 jobs per company on average but up to 39,523 for the largest, and ~59k
  // companies change in a week — which is the bulk-UPDATE pattern that starves the API. With
  // the flag on the company, only ~100k rows can ever be marked, and the fan-out happens in
  // the sync loop where it is already batched and throttled.
  if (isPostgres) {
    await exec('ALTER TABLE companies ADD COLUMN IF NOT EXISTS index_dirty_at TIMESTAMP');
    await exec('CREATE INDEX IF NOT EXISTS idx_companies_index_dirty ON companies (index_dirty_at) WHERE index_dirty_at IS NOT NULL');
    await exec(`
      CREATE OR REPLACE FUNCTION companies_mark_index_dirty() RETURNS trigger AS $$
      BEGIN
        -- Only the fields the index actually stores. Without this guard every last_synced_at
        -- bump would re-index the company's whole job set.
        IF (NEW.logo_url, NEW.company_name, NEW.domain, NEW.ats_slug)
           IS DISTINCT FROM
           (OLD.logo_url, OLD.company_name, OLD.domain, OLD.ats_slug)
        THEN
          NEW.index_dirty_at := NOW();
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await exec('DROP TRIGGER IF EXISTS trig_companies_index_dirty ON companies');
    await exec('CREATE TRIGGER trig_companies_index_dirty BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION companies_mark_index_dirty()');
  }

  // Full-text search (PostgreSQL only)
  if (isPostgres) {
    await exec(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS search_vector tsvector`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_jobs_search ON jobs USING GIN(search_vector)`);
    await exec(`
      CREATE OR REPLACE FUNCTION jobs_search_update() RETURNS trigger AS $$
      BEGIN
        NEW.search_vector := to_tsvector('english', coalesce(NEW.title, '') || ' ' || coalesce(NEW.department, '') || ' ' || coalesce(NEW.location, ''));
        RETURN NEW;
      END $$ LANGUAGE plpgsql
    `);
    await exec(`DROP TRIGGER IF EXISTS trig_jobs_search ON jobs`);
    await exec(`CREATE TRIGGER trig_jobs_search BEFORE INSERT OR UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION jobs_search_update()`);
    // Backfill existing rows (run in background, don't block startup)
    exec(`UPDATE jobs SET search_vector = to_tsvector('english', coalesce(title, '') || ' ' || coalesce(department, '') || ' ' || coalesce(location, '')) WHERE search_vector IS NULL`)
      .then(r => { if (r?.rowCount) logger.info({ rows: r.rowCount }, 'Backfilled search_vector'); })
      .catch(() => {});
  }

  // Reset empty-string descriptions back to NULL so backfill retries them
  exec(`UPDATE jobs SET description = NULL WHERE description = '' AND removed_at IS NULL`)
    .then(r => { if (r?.rowCount) logger.info({ rows: r.rowCount }, 'Reset empty descriptions to NULL for backfill retry'); })
    .catch(() => {});

  logger.info({ engine: isPostgres ? 'postgresql' : 'sqlite' }, 'Database schema migrated');
}

if (require.main === module) {
  migrate().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}

module.exports = { migrate };
