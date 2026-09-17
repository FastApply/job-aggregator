const { exec, query, isPostgres } = require('./connection');
const logger = require('../logger');

async function migrate() {
  const autoId = isPostgres ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  const now = isPostgres ? 'NOW()' : "datetime('now')";

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
      UNIQUE(external_id, company_id)
    )
  `);

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
