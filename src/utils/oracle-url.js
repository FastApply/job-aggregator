/**
 * Oracle Candidate Experience posting URL -> REST API coordinates.
 *
 * Oracle serves career sites under TWO host shapes:
 *
 *   https://{tenant}.fa.{region}.oraclecloud.com/hcmUI/CandidateExperience/{lang}/sites/{site}/job/{id}
 *   https://{tenant}.fa.oraclecloud.com/hcmUI/CandidateExperience/{lang}/sites/{site}/job/{id}
 *
 * The second is REGION-LESS and the original regex did not allow for it, because every tenant
 * we had looked at carried a region. JPMorgan Chase does not. Measured 2026-08-24: 317 of the
 * 2,594 live oraclecloud rows missing a description were on `jpmc.fa.oraclecloud.com` and were
 * rejected before a request was ever made — while the tenant answers normally and the stored
 * requisition ids are live (job 210764737 returns items=1 with a full description).
 *
 * Both shapes expose the same JSON detail endpoint on their own host:
 *
 *   https://{host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails
 *     ?onlyData=true&expand=all&finder=ById;Id={jobId},siteNumber={site}
 *
 * This lives in its own module because two callers need it and they must not drift: the
 * description backfill (which fills from it) and the dead-job pruner (which decides whether a
 * posting still exists from it). A parser that disagrees between those two would either fill
 * descriptions for jobs we then delete, or delete jobs we can still fill — the same reason
 * src/utils/workday-url.js exists.
 *
 * Host matching is endsWith on the full suffix, never includes: `includes('oraclecloud.com')`
 * also matches `evil-oraclecloud.com.attacker.net`, which would point the fetcher at an
 * attacker-controlled host and leak whatever the caller sends.
 */

/** Returns { host, tenant, region, siteNumber, jobId } or null if not an Oracle CE posting URL. */
function parseOracleUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    if (!u.hostname.endsWith('.oraclecloud.com')) return null;

    // {tenant}.fa.{region}.oraclecloud.com  ->  ['tenant','fa','region']
    // {tenant}.fa.oraclecloud.com           ->  ['tenant','fa']
    const labels = u.hostname.slice(0, -'.oraclecloud.com'.length).split('.');
    if (labels.length < 2 || labels[1] !== 'fa') return null;
    const tenant = labels[0];
    const region = labels[2] || null;
    if (!tenant) return null;

    // .../sites/{site}/job/{id} with an optional `requisitions/` segment before `job`.
    const parts = u.pathname.split('/').filter(Boolean);
    const sitesIdx = parts.indexOf('sites');
    const jobIdx = parts.indexOf('job');
    if (sitesIdx < 0 || jobIdx < sitesIdx + 2) return null;
    const siteNumber = parts[sitesIdx + 1];
    const jobId = parts[jobIdx + 1];
    if (!siteNumber || !/^\d+$/.test(jobId || '')) return null;

    return { host: u.hostname, tenant, region, siteNumber, jobId };
  } catch { return null; }
}

/**
 * The JSON detail endpoint for a parsed posting.
 *
 * Built from the parsed HOST rather than reassembled from tenant+region, so the region-less
 * shape needs no special case here and a future third shape only has to be taught to the parser.
 */
function oracleDetailUrl(p) {
  return `https://${p.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails`
    + `?onlyData=true&expand=all&finder=ById;Id=${encodeURIComponent(p.jobId)}`
    + `,siteNumber=${encodeURIComponent(p.siteNumber)}`;
}

module.exports = { parseOracleUrl, oracleDetailUrl };
