#!/usr/bin/env node
/**
 * Turn the pulled aggregator records (agg_raw) into real companies and jobs in STAGING.
 *
 * The pull stores each aggregator's answer verbatim; this is the step that makes those rows
 * usable: resolve the employer's own job board out of the posting URL, create the company if we
 * do not have it, and insert the job against it. A job whose board we can name is a job our
 * crawlers keep current afterwards, and a job users can actually apply to.
 *
 * Set-based on purpose. Two million rows through a per-row JS loop is hours of round trips; the
 * same work as four SQL statements is minutes, and the mapping rules are the same CASE the
 * promoter and demand-crawl already use.
 *
 * WHAT IS SKIPPED, and why
 *   - No board in the URL (employer's own site, aggregator-internal links): resolving those needs
 *     a fetch per job, which is the next pass, not this one.
 *   - Postings older than STALE_MONTHS (default 6) where the source dates them. Measured on jobloo
 *     2026-08-08: 80% of 6-12 month old rows were already dead. Importing them fills the board with
 *     jobs nobody can apply to and leaves the pruner to find out by HTTP, one request at a time.
 *   - URLs we already hold: matched on the URL with query and trailing slash stripped.
 *
 *   node scripts/map-aggregators-local.js                 # shadow: counts only
 *   APPLY=1 node scripts/map-aggregators-local.js         # write staging
 *   SOURCES=jobloo,trueup APPLY=1 node ...                # one source at a time
 *
 * Env: APPLY, SOURCES, STALE_MONTHS, DB (staging only).
 */
const { Pool } = require('pg');

const DB = process.env.DB || 'postgres://codev@localhost:5432/jobs_local';
{
  const h = (() => { try { return new URL(DB).hostname; } catch { return ''; } })();
  if (!['localhost', '127.0.0.1', '::1'].includes(h)) { console.error('Refusing: staging only.'); process.exit(1); }
}
const APPLY = process.env.APPLY === '1';
const STALE_MONTHS = parseInt(process.env.STALE_MONTHS || '0', 10);   // 0 = keep every posting
const RESUME = process.env.RESUME === '1';   // reuse agg_mapped/agg_have/agg_todo from a previous run
// Only look at records pulled since this moment. The pulls keep running for days, so a sweep that
// re-reads all 4.7M raw rows to find the last hour's arrivals spends ~15 minutes scanning to insert
// a few thousand. SINCE keeps a repeat pass proportional to what actually arrived.
const SINCE = process.env.SINCE || '';
const SOURCES = (process.env.SOURCES || '').split(',').map((s) => s.trim()).filter(Boolean);
const pool = new Pool({ connectionString: DB, max: 3, statement_timeout: 0 });
const q = (sql, params) => pool.query(sql, params);
const n = (v) => Number(v).toLocaleString();

/**
 * Read a posting date whatever shape the source sends: jobloo gives epoch milliseconds
 * (1784851200000), trueup epoch seconds, liftmycv fractional seconds, the rest ISO strings. An
 * unguarded ::timestamptz on the millisecond form aborts the whole statement, so anything that
 * does not match a known shape becomes NULL rather than an error.
 */
const TS = (expr) => `CASE
    WHEN (${expr}) ~ '^[0-9]{13}$'            THEN to_timestamp((${expr})::bigint / 1000.0)
    WHEN (${expr}) ~ '^[0-9]{9,10}(\\.[0-9]+)?$' THEN to_timestamp((${expr})::double precision)
    WHEN (${expr}) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN (${expr})::timestamptz
    ELSE NULL END`;

// Per-source field names. Every aggregator calls the same thing something different; this is the
// only place that knows which.
const FIELDS = {
  liftmycv:   { url: "payload->>'jobUrl'", title: "payload->>'role'", company: "payload->>'company'", location: "payload->>'location'", desc: "coalesce(payload->>'description', payload->>'formattedDescription')", posted: TS("payload->>'jobCreatedAt'"), workplace: "lower(payload->>'workplaceType')", etype: 'NULL', smin: 'NULL', smax: 'NULL', scur: 'NULL' },
  wonsulting: { url: "payload->>'apply_url'", title: "payload->>'job_title'", company: "payload->>'company'", location: "payload->>'location'", desc: "payload->>'description'", posted: TS("payload->>'posted_at'"), workplace: "lower(payload->>'work_setting')", etype: "payload->>'job_type'", smin: "payload->>'min_salary'", smax: "payload->>'max_salary'", scur: "'USD'" },
  jobhose:    { url: "payload->>'url'", title: "payload->>'title'", company: "payload->>'organization'", location: "coalesce(payload#>>'{jobLocations,0,city}', payload#>>'{locationsAltRaw,0}')", desc: "coalesce(payload->>'descriptionHtml', payload->>'descriptionText')", posted: TS("payload->>'datePosted'"), workplace: "lower(payload->>'aiWorkArrangement')", etype: "payload->>'employmentType'", smin: "payload->>'aiSalaryAnnualMin'", smax: "payload->>'aiSalaryAnnualMax'", scur: "payload->>'aiSalaryCurrency'" },
  jobloo:     { url: "coalesce(payload->>'applyUrl', payload->>'hostedUrl')", title: "payload->>'title'", company: "payload->>'company'", location: "payload->>'location'", desc: "coalesce(payload->>'description', payload->>'descriptionBody')", posted: TS("payload->>'createdAt'"), workplace: "lower(payload->>'workplaceType')", etype: "payload->>'commitmentType'", smin: 'NULL', smax: 'NULL', scur: 'NULL' },
  resumly:    { url: "payload->>'url'", title: "payload->>'title'", company: "payload->>'organization'", location: "payload#>>'{locations_derived,0}'", desc: "payload->>'description'", posted: TS("payload->>'date_posted'"), workplace: "lower(payload->>'ai_work_arrangement')", etype: "payload->>'employment_type'", smin: 'NULL', smax: 'NULL', scur: 'NULL' },
  trueup:     { url: "payload->>'url'", title: "payload->>'title'", company: "payload->>'company_name'", location: "payload->>'location'", desc: "payload->>'business_description_short'", posted: TS("payload->>'updated_at_timestamp'"), workplace: 'NULL', etype: 'NULL', smin: "payload->>'salary_range_min'", smax: "payload->>'salary_range_max'", scur: "'USD'" },
  simplify:   { url: "'https://simplify.jobs/p/' || (payload->>'posting_id')", title: "payload->>'title'", company: "payload->>'company_name'", location: "payload#>>'{locations,0}'", desc: 'NULL', posted: TS("payload->>'start_date'"), workplace: 'NULL', etype: "payload->>'type'", smin: 'NULL', smax: 'NULL', scur: "payload->>'currency_type'", ats: "'simplify'", slug: "payload->>'company_id'" },
  // Job-page boards (pull-aggregators-local.js): applyUrl is the employer's application page. A
  // Teamtailor custom domain (careers.shine.co) carries teamtailorHost, which no host rule could infer.
  trulyremotework: { url: "payload->>'applyUrl'", title: "payload->>'title'", company: "payload->>'company'", location: "payload->>'location'", desc: "payload->>'description'", posted: TS("payload->>'datePosted'"), workplace: "CASE WHEN payload->>'remote' = 'TELECOMMUTE' THEN 'remote' END", etype: 'NULL', smin: 'NULL', smax: 'NULL', scur: 'NULL', ats: "CASE WHEN payload->>'teamtailorHost' IS NOT NULL THEN 'teamtailor' END", slug: "lower(payload->>'teamtailorHost')" },
  thehub:     { url: "payload->>'applyUrl'", title: "payload->>'title'", company: "payload->>'company'", location: "payload->>'location'", desc: "payload->>'description'", posted: TS("payload->>'datePosted'"), workplace: 'NULL', etype: "payload->>'employmentType'", smin: 'NULL', smax: 'NULL', scur: 'NULL', ats: "CASE WHEN payload->>'teamtailorHost' IS NOT NULL THEN 'teamtailor' END", slug: "lower(payload->>'teamtailorHost')" },
  // sprout: the open job-detail payload. Its description is Sprout's own AI summary (the raw text is
  // not in that payload), and its ids never match a crawler's (sprout_<id> vs workday_<id>, and its
  // Workday links carry /en-US/), so a Sprout job on a board we crawl became a DUPLICATE of the
  // crawled one rather than being replaced by it (2026-11-10: 65% of Sprout Workday rows on crawled
  // boards had a same-title crawled twin). So employerOnly: on a board an adapter covers, Sprout
  // only creates the company and the crawl brings the jobs; jobs are kept for 'direct' sites only.
  // Every location is kept ("City, State, Country; City, ..."), not just the first.
  // Only ACTIVE postings: the band also holds jobs Sprout has marked expired.
  sprout:     { url: "payload->>'postingUrl'", title: "payload->>'title'", company: "payload->>'company'", location: "(SELECT string_agg(DISTINCT concat_ws(', ', nullif(l->>'city',''), nullif(l->>'state',''), nullif(l->>'country','')), '; ') FROM jsonb_array_elements(CASE jsonb_typeof(payload->'locations') WHEN 'array' THEN payload->'locations' ELSE '[]'::jsonb END) l)", desc: "payload->>'summary'", descKind: 'aggregator_summary', employerOnly: true, posted: TS("payload->>'postedAt'"), workplace: "replace(lower(payload->>'workLocation'), '_', '')", etype: "payload#>>'{jobTypes,0}'", smin: "nullif(payload->>'salaryMin','0')", smax: "nullif(payload->>'salaryMax','0')", scur: "payload->>'currency'", where: "coalesce(payload->>'status','ACTIVE') = 'ACTIVE'" },
  // aiapply: /api/jobs hits (pull-aggregators-local.js). `url` is the employer's own posting and
  // `description` the employer's text (Fantastic.jobs / Workable XML); aiapply's own AI fields
  // (description_short, core_responsibilities, requirements_summary) are left out. Its ids never
  // match a crawler's, so like Sprout it is employerOnly: on a board an adapter covers it creates
  // the company and the crawl brings the jobs; jobs are kept for 'direct' sites and Workday.
  aiapply:    { url: "payload->>'url'", title: "payload->>'title'", company: "payload->>'company_name'", location: "coalesce(nullif((SELECT string_agg(DISTINCT x, '; ') FROM jsonb_array_elements_text(CASE jsonb_typeof(payload->'full_locations') WHEN 'array' THEN payload->'full_locations' ELSE '[]'::jsonb END) x), ''), payload->>'full_location')", desc: "payload->>'description'", employerOnly: true, posted: TS("payload->>'posted_at'"), workplace: "lower(payload->>'work_arrangement')", etype: "payload#>>'{hours,0}'", smin: "nullif(nullif(payload->>'minimum_salary',''),'0')", smax: "nullif(nullif(payload->>'salary',''),'0')", scur: "nullif(payload->>'minimum_salary_currency','')", ats: "CASE WHEN payload->>'ats' = 'SuccessFactors' AND payload->>'url' ~* '^https?://[^/]+/([^/]+/)?job/[^/]+/[0-9]{6,}/?(\\?|$)' THEN 'successfactors' END", slug: "CASE WHEN payload->>'ats' = 'SuccessFactors' AND payload->>'url' ~* '^https?://[^/]+/([^/]+/)?job/[^/]+/[0-9]{6,}/?(\\?|$)' THEN lower(split_part(regexp_replace(payload->>'url','^https?://',''),'/',1)) END" },
  allscm:     { url: "payload->>'application_link'", title: "payload->>'title'", company: "payload->>'company_name'", location: "payload->>'location'", desc: "payload->>'description'", posted: TS("payload->>'published_at'"), workplace: "lower(payload->>'location_type')", etype: "payload->>'arrangement'", smin: 'NULL', smax: 'NULL', scur: "payload->>'salary_currency'" },
};

// host/path -> (ats, slug, career_url). Same rules as scripts/promote-missing-to-prod.js and
// src/tasks/demand-crawl.js, kept in SQL so the whole pass stays set-based.
const ATS_CASE = `
  CASE
    WHEN host ~ '\\.myworkdayjobs\\.com$' THEN 'workday'
    WHEN host ~ '^wd[0-9]+\\.myworkdaysite\\.com$' AND lower(split_part(bare,'/',2))='recruiting' THEN 'workday'
    WHEN host ~ '(^|\\.)greenhouse\\.io$' THEN 'greenhouse'
    WHEN host = 'jobs.lever.co' THEN 'lever'
    WHEN host = 'jobs.ashbyhq.com' THEN 'ashby'
    WHEN host = 'apply.workable.com' THEN 'workable'
    WHEN host ~ 'smartrecruiters\\.com$' THEN 'smartrecruiters'
    WHEN host ~ '\\.icims\\.com$' THEN 'icims'
    WHEN host ~ '\\.fa\\.[a-z0-9]+\\.oraclecloud\\.com$' AND bare ~ '/sites/[^/?#]+' THEN 'oracle'
    WHEN host ~ '\\.taleo\\.net$' AND host !~ '\\.tbe\\.taleo\\.net$' THEN 'taleo'
    WHEN host ~ '\\.applytojob\\.com$' THEN 'jazzhr'
    WHEN host ~ '\\.bamboohr\\.com$' THEN 'bamboohr'
    WHEN host ~ '\\.breezy\\.hr$' THEN 'breezy'
    WHEN host ~ '\\.recruitee\\.com$' THEN 'recruitee'
    WHEN host ~ '\\.pinpointhq\\.com$' THEN 'pinpoint'
    WHEN host ~ '\\.teamtailor\\.com$' AND split_part(host,'.',1) <> 'teamtailor' THEN 'teamtailor'
    WHEN host = 'ats.rippling.com' THEN 'rippling'
    WHEN host ~ '\\.jobs\\.personio\\.(de|com)$' THEN 'personio'
    WHEN host ~ '\\.zohorecruit\\.' THEN 'zoho'
    WHEN host = 'jobs.jobvite.com' THEN 'jobvite'
    WHEN host ~ 'paylocity\\.com$' AND url ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' THEN 'paylocity'
    -- Platforms the worker has adapters for (render-deploy src/adapters), added 2026-11-15. Until
    -- then these all fell to 'direct', so their boards were never created or crawled.
    WHEN host = 'jobs.dayforcehcm.com' AND bare ~ '^jobs\\.dayforcehcm\\.com/[A-Za-z]{2}-[A-Za-z]{2}/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+' THEN 'dayforce'
    WHEN (host ~ '^recruiting[0-9]*\\.ultipro\\.(com|ca)$' OR host ~ '\\.rec\\.pro\\.ukg\\.net$') AND bare ~* '/[^/]+/JobBoard/[0-9a-f-]{36}' THEN 'ukg'
    WHEN host = 'careers-page.com' AND split_part(bare,'/',2) <> '' THEN 'manatal'
    WHEN host ~ '^[a-z0-9-]+\\.careerplug\\.com$' AND split_part(host,'.',1) NOT IN ('www','app','api') THEN 'careerplug'
    WHEN host = 'myjobs.adp.com' AND split_part(bare,'/',2) <> '' THEN 'adp'
    WHEN host = 'workforcenow.adp.com' AND url ~* 'cid=[0-9a-f-]{36}' THEN 'adp_workforcenow'
    WHEN host ~ '\\.jobs\\.hr\\.cloud\\.sap$' THEN 'successfactors'
    -- Everything else still belongs in staging. It lands under 'direct', which no adapter claims,
    -- so the row is stored and searchable without any crawler trying to sync a board we cannot read.
    WHEN host IS NOT NULL AND host <> '' THEN 'direct'
    ELSE NULL END`;
const SLUG_CASE = `
  CASE
    WHEN host ~ '\\.myworkdayjobs\\.com$' THEN split_part(host,'.',1)
    WHEN host ~ '^wd[0-9]+\\.myworkdaysite\\.com$' THEN lower(split_part(bare,'/',3))
    WHEN host ~ '(^|\\.)greenhouse\\.io$' THEN lower(CASE WHEN split_part(bare,'/',2)='embed' THEN substring(url from 'for=([^&#]+)') ELSE split_part(bare,'/',2) END)
    WHEN host IN ('jobs.lever.co','jobs.ashbyhq.com','apply.workable.com','ats.rippling.com','jobs.jobvite.com') OR host ~ 'smartrecruiters\\.com$' THEN lower(split_part(bare,'/',2))
    WHEN host ~ '\\.fa\\.[a-z0-9]+\\.oraclecloud\\.com$' THEN lower(split_part(host,'.fa.',1) || '.' || split_part(split_part(host,'.fa.',2),'.',1) || '.' || substring(bare from '/sites/([^/?#]+)'))
    WHEN host ~ 'paylocity\\.com$' THEN lower(substring(url from '(?i)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'))
    -- Same shapes the adapters parse and prod already stores: dayforce "tenant" (board
    -- CANDIDATEPORTAL) or "tenant/board"; ukg "host/tenant/uuid"; adp_workforcenow the cid.
    WHEN ats = 'dayforce' THEN lower(split_part(bare,'/',3)) || CASE WHEN upper(split_part(bare,'/',4)) = 'CANDIDATEPORTAL' THEN '' ELSE '/' || lower(split_part(bare,'/',4)) END
    WHEN ats = 'ukg' THEN host || '/' || lower(split_part(bare,'/',2)) || '/' || lower(substring(bare from '(?i)/JobBoard/([0-9a-f-]{36})'))
    WHEN ats IN ('manatal','adp') THEN lower(split_part(bare,'/',2))
    WHEN ats = 'adp_workforcenow' THEN lower(substring(url from '(?i)cid=([0-9a-f-]{36})'))
    WHEN ats = 'successfactors' THEN host
    -- 'direct': one row per EMPLOYER, not per host. Keying on the host alone would pile every
    -- employer on a shared host (jobs.workable.com/view/..., brassring, eightfold) onto a single
    -- company row -- the collapse demand-crawl documents, where 978 postings from 625 employers
    -- ended up under one name. The company name the source gave keeps them apart.
    WHEN ats = 'direct' THEN left(coalesce(nullif(regexp_replace(lower(company_name), '[^a-z0-9]+', '-', 'g'), '-'), host) || '@' || host, 180)
    ELSE lower(split_part(host,'.',1)) END`;
const CAREER_CASE = `
  CASE ats
    WHEN 'workday' THEN 'https://' || slug || '.myworkdayjobs.com'
    WHEN 'greenhouse' THEN 'https://boards.greenhouse.io/' || slug
    WHEN 'lever' THEN 'https://jobs.lever.co/' || slug
    WHEN 'ashby' THEN 'https://jobs.ashbyhq.com/' || slug
    WHEN 'workable' THEN 'https://apply.workable.com/' || slug
    WHEN 'smartrecruiters' THEN 'https://careers.smartrecruiters.com/' || slug
    WHEN 'icims' THEN 'https://' || slug || '.icims.com'
    WHEN 'oracle' THEN 'https://' || split_part(slug,'.',1) || '.fa.' || split_part(slug,'.',2) || '.oraclecloud.com/hcmUI/CandidateExperience/en/sites/' || split_part(slug,'.',3)
    WHEN 'taleo' THEN 'https://' || slug || '.taleo.net'
    WHEN 'jazzhr' THEN 'https://' || slug || '.applytojob.com'
    WHEN 'bamboohr' THEN 'https://' || slug || '.bamboohr.com/careers'
    WHEN 'breezy' THEN 'https://' || slug || '.breezy.hr'
    WHEN 'recruitee' THEN 'https://' || slug || '.recruitee.com'
    WHEN 'pinpoint' THEN 'https://' || slug || '.pinpointhq.com'
    -- A slug with a dot is a Teamtailor custom domain (careers.shine.co): the board lives there.
    WHEN 'teamtailor' THEN CASE WHEN slug LIKE '%.%' THEN 'https://' || slug ELSE 'https://' || slug || '.teamtailor.com' END
    WHEN 'rippling' THEN 'https://ats.rippling.com/' || slug || '/jobs'
    WHEN 'personio' THEN 'https://' || slug || '.jobs.personio.com'
    WHEN 'zoho' THEN 'https://' || slug || '.zohorecruit.com'
    WHEN 'jobvite' THEN 'https://jobs.jobvite.com/' || slug
    WHEN 'paylocity' THEN 'https://recruiting.paylocity.com/recruiting/jobs/All/' || slug
    WHEN 'dayforce' THEN 'https://jobs.dayforcehcm.com/en-US/' || split_part(slug,'/',1) || '/' || CASE WHEN slug LIKE '%/%' THEN upper(split_part(slug,'/',2)) ELSE 'CANDIDATEPORTAL' END
    WHEN 'ukg' THEN 'https://' || split_part(slug,'/',1) || '/' || split_part(slug,'/',2) || '/JobBoard/' || split_part(slug,'/',3) || '/'
    WHEN 'manatal' THEN 'https://www.careers-page.com/' || slug
    WHEN 'careerplug' THEN 'https://' || slug || '.careerplug.com'
    WHEN 'adp' THEN 'https://myjobs.adp.com/' || slug || '/cx/job-listing'
    WHEN 'adp_workforcenow' THEN 'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=' || slug
    WHEN 'successfactors' THEN 'https://' || slug
    WHEN 'simplify' THEN 'https://simplify.jobs/c/' || slug
    WHEN 'direct' THEN 'https://' || split_part(slug, '@', 2) || '/#' || split_part(slug, '@', 1)
    ELSE NULL END`;

// The ATS's own job id where the URL carries one, so a mapped row and a crawled row of the same
// posting collide on UNIQUE(external_id, company_id) instead of both existing.
const EXTERNAL_ID_CASE = `
  CASE ats
    WHEN 'greenhouse' THEN 'greenhouse_' || coalesce(substring(bare from '/jobs/([0-9]+)'), substring(url from 'gh_jid=([0-9]+)'), ext_id)
    WHEN 'lever' THEN 'lever_' || coalesce(substring(bare from '/[^/]+/([0-9a-f-]{16,})'), ext_id)
    WHEN 'ashby' THEN 'ashby_' || coalesce(substring(bare from '/[^/]+/([0-9a-f-]{16,})'), ext_id)
    WHEN 'workable' THEN 'workable_' || coalesce(substring(bare from '/j/([A-Za-z0-9]+)'), ext_id)
    WHEN 'breezy' THEN 'breezy_' || coalesce(substring(bare from '/p/([0-9a-f]+)'), ext_id)
    WHEN 'smartrecruiters' THEN 'smartrecruiters_' || coalesce(substring(bare from '-([0-9]{6,})$'), ext_id)
    WHEN 'careerplug' THEN 'careerplug_' || coalesce(substring(bare from '/jobs/([0-9]+)'), ext_id)
    WHEN 'dayforce' THEN 'dayforce_' || coalesce(substring(bare from '/jobs/([0-9]+)'), ext_id)
    ELSE source || '_' || ext_id END`;

// Dedup key for a posting URL: no query, fragment or trailing slash, and on Workday no locale
// segment, since Sprout links carry /en-US/ where the crawler's do not.
const URL_KEY = (col) => `substr(md5(lower(regexp_replace(regexp_replace(split_part(split_part(${col},'?',1),'#',1),'/+$',''), '(myworkdayjobs\\.com)/[a-z]{2}-[a-z]{2}/', '\\1/', 'i'))),1,12)`;
// Sources whose jobs are imported only for boards no adapter covers (ats 'direct'); elsewhere they
// contribute the company alone. And sources whose description is not the employer's text.
const EMPLOYER_ONLY = Object.keys(FIELDS).filter((s) => FIELDS[s].employerOnly);
// Workday keeps its Sprout jobs until the worker crawls the site a company row names: sync.queue
// calls fetchJobs(atsSlug) without career_url, so a multi-site tenant (thales, lilly, roberthalf)
// is crawled on one discovered site only, and Sprout is the only source for the rest (2026-11-11:
// 12/12 sampled Sprout Workday jobs missing from the crawl were live).
const JOBS_KEPT_ATS = "'workday'";
const DESC_KIND_CASE = Object.keys(FIELDS).filter((s) => FIELDS[s].descKind)
  .map((s) => `WHEN '${s}' THEN '${FIELDS[s].descKind}'`).join(' ') || "WHEN '' THEN NULL";

async function main() {
  const sources = Object.keys(FIELDS).filter((s) => !SOURCES.length || SOURCES.includes(s));
  console.log(`${APPLY ? 'APPLY' : 'SHADOW'} | sources: ${sources.join(', ')} |${SINCE ? ` pulled since ${SINCE} |` : ''} ${STALE_MONTHS ? `skipping postings older than ${STALE_MONTHS} months` : 'keeping every posting'}\n`);

  // 1. One flat table: every raw row with the fields we insert, plus the board it belongs to.
  if (!RESUME) {
  await q('DROP TABLE IF EXISTS agg_mapped');
  const parts = sources.map((s) => {
    const f = FIELDS[s];
    return `SELECT '${s}'::text AS source, ext_id, ${f.url} AS url, ${f.title} AS title, ${f.company} AS company_name,
                   ${f.ats || 'NULL'}::text AS ats_override, ${f.slug || 'NULL'}::text AS slug_override,
                   ${f.location} AS location, ${f.desc} AS description, ${f.posted} AS posted_at,
                   ${f.workplace} AS workplace_type, ${f.etype} AS employment_type,
                   ${f.smin}::text AS salary_min, ${f.smax}::text AS salary_max, ${f.scur}::text AS salary_currency
              FROM agg_raw WHERE source = '${s}'${f.where ? ` AND (${f.where})` : ''}${SINCE ? ` AND last_fetched_at > '${SINCE.replace(/'/g, '')}'::timestamptz` : ''}`;
  });
  await q(`CREATE UNLOGGED TABLE agg_mapped AS
    WITH r AS (${parts.join(' UNION ALL ')}),
    b AS (
      SELECT r.*, lower(split_part(regexp_replace(url,'^https?://(www\\.)?','','i'),'/',1)) AS host,
             regexp_replace(split_part(split_part(url,'?',1),'#',1),'^https?://(www\\.)?','','i') AS bare,
             ${URL_KEY('url')} AS k
        FROM r WHERE url IS NOT NULL AND url <> '' AND title IS NOT NULL AND title <> '')
    SELECT b.*, coalesce(ats_override, ${ATS_CASE}) AS ats, NULL::text AS slug FROM b`);
  await q(`UPDATE agg_mapped SET slug = coalesce(slug_override, ${SLUG_CASE}) WHERE ats IS NOT NULL`);
  // A generic path word is not an employer id on a real ATS, but it is fine for a 'direct' row,
  // whose slug comes from the company name.
  await q(`DELETE FROM agg_mapped WHERE ats IS NULL OR slug IS NULL OR slug = ''
             OR (ats <> 'direct' AND slug IN ('jobs','careers','search','apply','job','embed','en-us','recruiting','www'))`);
  if (STALE_MONTHS > 0) {
    await q(`DELETE FROM agg_mapped WHERE posted_at IS NOT NULL AND posted_at < now() - interval '${STALE_MONTHS} months'`);
  }
  await q('CREATE INDEX ON agg_mapped (ats, slug)');
  await q('CREATE INDEX ON agg_mapped (k)');
  const { rows: [m] } = await q('SELECT count(*) rows, count(DISTINCT k) jobs, count(DISTINCT (ats, slug)) boards FROM agg_mapped');
  console.log(`  mappable: ${n(m.rows)} rows -> ${n(m.jobs)} distinct jobs on ${n(m.boards)} boards`);

  // 2. Drop what we already hold, by URL.
  await q('DROP TABLE IF EXISTS agg_have');
  await q(`CREATE UNLOGGED TABLE agg_have AS SELECT DISTINCT ${URL_KEY('url')} k FROM jobs`);
  await q('CREATE INDEX ON agg_have (k)');
  await q('ANALYZE agg_have');
  const { rows: [nw] } = await q('SELECT count(DISTINCT k) FROM agg_mapped m WHERE NOT EXISTS (SELECT 1 FROM agg_have h WHERE h.k = m.k)');
  console.log(`  not already in staging: ${n(nw.count)} jobs`);

  }
  const { rows: [nb] } = await q(`SELECT count(*) FROM (SELECT DISTINCT ats, slug FROM agg_mapped) b
     WHERE NOT EXISTS (SELECT 1 FROM companies c WHERE c.ats = b.ats AND lower(c.ats_slug) = b.slug)`);
  console.log(`  boards to create: ${n(nb.count)}`);

  if (!APPLY) { console.log('\nSHADOW — nothing written. Re-run with APPLY=1.'); return; }

  // 3. Companies first: a job cannot exist without one.
  const ins = await q(`
    WITH b AS (
      SELECT ats, slug, (array_agg(company_name ORDER BY length(coalesce(company_name,'')) DESC))[1] AS name
        FROM agg_mapped WHERE company_name IS NOT NULL GROUP BY ats, slug),
    n AS (SELECT b.*, ${CAREER_CASE} AS career_url FROM b
           WHERE NOT EXISTS (SELECT 1 FROM companies c WHERE c.ats = b.ats AND lower(c.ats_slug) = b.slug))
    INSERT INTO companies (company_name, domain, ats, ats_slug, career_url, status, origin, last_synced_at, created_at, updated_at)
    SELECT coalesce(name, slug), split_part(regexp_replace(career_url,'^https?://',''),'/',1), ats, slug, career_url,
           'active', 'aggregator_pull', NULL, NOW(), NOW()
      FROM n WHERE career_url IS NOT NULL
    ON CONFLICT (career_url) DO NOTHING`);
  console.log(`  companies created: ${n(ins.rowCount)}`);

  // 4. Jobs. The to-do list is built ONCE, numbered, and then walked by row ranges.
  //
  // The first cut re-ran `SELECT DISTINCT ON (k) ... WHERE NOT EXISTS (agg_have) LIMIT 20000` per
  // batch. That re-sorts millions of rows every time and gets slower as agg_have fills: it fell
  // from 8,000 inserts a minute to a few hundred. Numbering the work up front turns each batch
  // into an index range scan that costs the same at row 10,000 and row 1,500,000.
  if (!RESUME) {
  await q('DROP TABLE IF EXISTS agg_todo');
  await q(`CREATE UNLOGGED TABLE agg_todo AS
    SELECT row_number() OVER (ORDER BY k) AS rn, m.*
      FROM (SELECT DISTINCT ON (k) * FROM agg_mapped ORDER BY k, posted_at DESC NULLS LAST) m
     WHERE NOT EXISTS (SELECT 1 FROM agg_have h WHERE h.k = m.k)
       ${EMPLOYER_ONLY.length ? `AND NOT (m.source IN (${EMPLOYER_ONLY.map((x) => `'${x}'`).join(',')}) AND m.ats NOT IN ('direct', ${JOBS_KEPT_ATS}))` : ''}`);
  await q('CREATE UNIQUE INDEX ON agg_todo (rn)');
  }
  const { rows: [todo] } = await q('SELECT coalesce(max(rn), 0) AS n FROM agg_todo');
  console.log(`  queued for insert: ${n(todo.n)}`);

  const STEP = 20000;
  let inserted = 0;
  for (let from = 1; from <= Number(todo.n); from += STEP) {
    const res = await q(`
      WITH batch AS (SELECT * FROM agg_todo WHERE rn >= $1 AND rn < $2),
      j AS (
        SELECT b.*, c.id AS company_id, ${EXTERNAL_ID_CASE} AS external_id
          FROM batch b JOIN LATERAL (
            SELECT id FROM companies c WHERE c.ats = b.ats AND lower(c.ats_slug) = b.slug ORDER BY id LIMIT 1) c ON true),
      ins AS (
        INSERT INTO jobs (external_id, company_id, ats, title, location, workplace_type, employment_type,
                          salary_min, salary_max, salary_currency, description, url, posted_at, raw_data,
                          first_seen_at, last_seen_at, created_at)
        SELECT external_id, company_id, ats, left(title, 500), left(location, 300),
               CASE WHEN workplace_type ~ 'remote' THEN 'remote' WHEN workplace_type ~ 'hybrid' THEN 'hybrid'
                    WHEN workplace_type ~ 'site|onsite' THEN 'onsite' ELSE NULL END,
               left(employment_type, 50), salary_min, salary_max, salary_currency, description, url, posted_at,
               json_build_object('source', 'aggregator:' || source, 'ext_id', ext_id,
                 'description_kind', CASE source ${DESC_KIND_CASE} ELSE NULL END)::text,
               NOW(), NOW(), NOW()
          FROM j
        ON CONFLICT (external_id, company_id) DO NOTHING
        RETURNING 1)
      SELECT (SELECT count(*) FROM ins) AS inserted`, [from, from + STEP]);
    inserted += Number(res.rows[0].inserted);
    if (((from - 1) / STEP) % 5 === 0) process.stdout.write(`\r  jobs inserted: ${n(inserted)} / ${n(todo.n)}   `);
  }
  console.log(`\r  jobs inserted: ${n(inserted)}        `);
}

main().then(() => pool.end()).catch(async (e) => { console.error('FATAL', e.message); await pool.end(); process.exit(1); });
