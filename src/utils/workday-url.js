/**
 * Workday posting URL -> CXS API coordinates.
 *
 * Workday serves career sites under TWO host shapes and the tenant sits in a different place
 * in each, so both have to be parsed:
 *
 *   https://{tenant}.wd{N}.myworkdayjobs.com/[lang/]{site}/job/{path}
 *   https://wd{N}.myworkdaysite.com/recruiting/{tenant}/{site}/job/{path}
 *
 * Both then expose the same JSON detail endpoint:
 *
 *   https://{host}/wday/cxs/{tenant}/{site}{externalPath}
 *
 * This lives in its own module because two callers need it and they must not drift: the
 * description backfill (which fills from it) and the dead-job pruner (which decides whether a
 * posting still exists from it). A parser that disagrees between those two would either fill
 * descriptions for jobs we then delete, or delete jobs we can still fill.
 *
 * Host matching is endsWith, never includes: `includes('myworkdayjobs.com')` also matches
 * `evil-myworkdayjobs.com.attacker.net`, which would point the fetcher at an attacker host.
 */

/** Returns { host, tenant, site, externalPath } or null if this is not a Workday posting URL. */
function parseWorkdayUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const jobIdx = parts.indexOf('job');
    if (jobIdx < 1) return null;
    const externalPath = '/' + parts.slice(jobIdx).join('/');
    const site = parts[jobIdx - 1];

    if (u.hostname.endsWith('.myworkdayjobs.com')) {
      const tenant = u.hostname.split('.')[0];
      if (!tenant || !/\.wd\d+\./.test(u.hostname)) return null;
      return { host: u.hostname, tenant, site, externalPath };
    }
    // myworkdaysite.com carries the tenant in the path, not the hostname.
    if (u.hostname.endsWith('.myworkdaysite.com') && parts[0] === 'recruiting' && parts[1]) {
      return { host: u.hostname, tenant: parts[1], site, externalPath };
    }
    return null;
  } catch { return null; }
}

/** The JSON detail endpoint for a parsed posting. */
function workdayCxsUrl(p) {
  return `https://${p.host}/wday/cxs/${p.tenant}/${p.site}${p.externalPath}`;
}

module.exports = { parseWorkdayUrl, workdayCxsUrl };
