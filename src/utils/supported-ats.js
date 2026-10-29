/**
 * Single source of truth for the ATS platforms we can actually crawl AND apply to.
 *
 * Import paths (demand-crawl, fetch-resumly*, fetch-wonsulting, import-resumly-file) ingest
 * whatever ATS a third-party source returns. Without this gate they re-fill the DB with jobs on
 * platforms we have no adapter for — jobs users can't apply to and the automation backend rejects.
 * This mirrors the adapter registry in src/adapters/index.js, plus:
 *   - oraclecloud            : Oracle Fusion (variant of oracle; kept per product decision)
 *
 * Alias labels are NOT members of this set. They used to be, on the grounds that they are
 * "applyable via the parent adapter" — but getAdapter() only knows real adapter names and
 * throws on an alias, so every row stored under one was uncrawlable for life: 175 rows
 * holding 1,522 live jobs had to be repaired by hand on 2026-08-04. They are now folded to
 * their parent by normalizeAts() *before* the gate, so the gate only ever sees a label some
 * adapter answers to.
 *
 * Keep this list in sync with src/adapters/index.js when adapters are added/removed.
 */
const SUPPORTED_ATS = new Set([
  // Adapters in src/adapters/index.js
  'greenhouse', 'ashby', 'lever', 'workable', 'recruitee', 'smartrecruiters', 'rippling',
  'personio', 'breezy', 'jazzhr', 'workday', 'zoho', 'icims', 'oracle', 'bamboohr', 'taleo',
  'pinpoint', 'successfactors', 'comeet', 'paylocity', 'teamtailor', 'jobvite',
  // Oracle Fusion (kept)
  'oraclecloud',
  // Nordic platforms (2026-10-04 .. 10-22), kept for the Nordic enterprise customer.
  'varbi', 'reachmee', 'jobylon', 'visma', 'recman', 'hrmanager', 'talentadore',
  // Enterprise platforms (2026-10-23), in CRAWL_LIST.
  'dayforce', 'manatal', 'paycom', 'eightfold', 'avature', 'brassring',
  // 2026-10-29 (2714990). adp = myjobs.adp.com; adp_workforcenow = workforcenow.adp.com.
  'ukg', 'adp', 'adp_workforcenow', 'silkroad', 'gem', 'kula',
]);

// Labels third-party feeds use for a platform we already have an adapter for. Deliberately
// absent: taleo_rss (in practice Taleo *Business Edition* — x.tbe.taleo.net/{portal}/ats/...,
// a different product our taleo adapter cannot read) and oraclepeoplesoft (no adapter at all).
// Those stay unsupported so the ingest gate drops them instead of minting dead rows.
const ATS_ALIAS = {
  grnhse: 'greenhouse',
  myworkdayjobs: 'workday',
  icims2: 'icims',
  zohorecruit: 'zoho',
  jworkable: 'workable',
  taleo_careersection: 'taleo',
  taleo_selectminds: 'taleo',
  // UKG Pro Recruiting was UltiPro.
  ultipro: 'ukg',
};

function normalizeAts(ats) {
  const a = String(ats || '').toLowerCase().trim();
  return ATS_ALIAS[a] || a;
}

function isSupportedAts(ats) {
  return SUPPORTED_ATS.has(normalizeAts(ats));
}

module.exports = { SUPPORTED_ATS, ATS_ALIAS, normalizeAts, isSupportedAts };
