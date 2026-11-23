/**
 * Sentences about remote work that say nothing about THIS job, cut before the remote readers
 * (statesRemote in extract.js, classifyRemote in classify.js) look at a description.
 *
 * A condition: Convergint's pay note, on every UKG posting it has, "If the position is posted in
 * multiple locations or is a remote position, the salary range may vary" tagged an operations
 * manager in Renton, WA and an office manager in Hoffman Estates, IL remote, and both went to
 * candidates in other states (First Apply, 2026-11-02). The same words in a statement of fact
 * ("This is a remote position", "Where You'll Work: this is a remote role") are not touched, nor
 * an address to the reader ("If you are looking for a remote role").
 */
const CONDITIONAL_REMOTE = /\b(?:if|unless|whether)\s+(?:this|the|it)\b[^.;!?]{0,70}\bremote\s+(?:position|role|job|opportunity)\b/gi;
// The same condition with the mode after the job: Checkr's pay note, on every posting it has,
// "If this role is remote, we have listed the top to the bottom of the possible range" tagged its
// San Francisco, Denver and Nashville office roles remote ("At Checkr, we believe an in office
// work environment strengthens collaboration"), and remote-only and New York searchers got them
// (supply loop 2026-11-22 00h).
//
// And the same policy for the other modes, with its label: PointClickCare's "For Hybrid Roles: If
// this role is Hybrid, there will be an expectation to..." sits on every posting, its remote ones
// too ("Remote - US", "Remote or Mississauga"), and its "hybrid" made all of them hybrid (retag of
// 2026-11-22, 30 of the 91 rows put back by hand).
const CONDITIONAL_MODE = /(?:\bfor\s+(?:remote|hybrid|on-?site|in[\s-]office)\s+(?:roles|positions|jobs)\s*:\s*)?\b(?:if|unless|whether)\s+(?:this|the|your)\s+(?:position|role|job|opportunity)\s+is\s+(?:fully\s+|100%\s+)?(?:remote|hybrid|on-?site|in[\s-]office)\b[^.;!?]*/gi;

/**
 * A perk with a length, from a benefits list: Altruist's "One month work from anywhere policy" on
 * a Los Angeles and San Francisco job (Greenhouse names only those two offices) went to a
 * candidate in Dallas who works remotely only (First Apply, 2026-11-02). "We work from anywhere"
 * and "Work from anywhere in the US" state how the job is worked and are not touched.
 */
//
// The same perk quoted or with its length after it, on every posting of employers with office
// roles (supply loop 2026-11-22 00h, 27 of 15,908 sampled remote rows): Easyship's "The freedom to
// 'Work from Anywhere' for 4 weeks in a year" (onsite in Bengaluru, 5 days a week), Kepler's
// "Annual Work From Anywhere 4 weeks per year" (New York), Thomson Reuters' "work from anywhere for
// up to 8 weeks per year", Ocado's "30 days of 'work from anywhere' policy", Caronsale's 25 "Work
// from Anywhere" days per year, Quantexa's 'Work from Anywhere' policy.
const PERK_Q = '[\"\'\u2018\u2019\u201c\u201d]?';
const PERK_N = '(?:\\d+|one|two|three|four|five|six|eight|ten|twelve)';
const ANYWHERE_PERK = new RegExp([
  `\\b(?:${PERK_N}\\s+)?(?:months?|weeks?|days?)\\s+(?:of\\s+|a\\s+year\\s+(?:of\\s+)?)?${PERK_Q}work\\s+from\\s+anywhere\\b${PERK_Q}`,
  `\\b${PERK_N}\\s+${PERK_Q}work\\s+from\\s+anywhere${PERK_Q}\\s+(?:days?|weeks?|months?)\\b`,
  `\\bwork\\s+from\\s+anywhere${PERK_Q}\\s+(?:polic(?:y|ies)|programs?|programmes?|perks?|benefits?|stipends?|schemes?|allowances?|days?|weeks?|months?)\\b`,
  `\\bwork\\s+from\\s+anywhere${PERK_Q}\\s*(?:for\\s+)?(?:up\\s+to\\s+)?${PERK_N}\\s*\\+?\\s*(?:weeks?|days?|months?)\\b`,
].join('|'), 'gi');

/**
 * The employer's policy for each mode, on every posting: Booz Allen's "• Remote: If this position
 * is listed as remote, there may still be occasions ... • Hybrid: If this position is listed as
 * hybrid, ..." It names no mode for THIS job. Its "hybrid" used to make every such row hybrid; once
 * the hybrid reader stopped reading the bare word, "position is listed as remote" read as remote
 * (2026-11-10 shadow of stored Hybrid rows).
 */
const LISTED_AS_MODE =
  /(?:\b(?:remote|hybrid|on-?site|in[\s-]office)\s*:\s*)?\b(?:if|when|where)\s+(?:this|the|a|your)\s+(?:position|role|job|opportunity)\s+is\s+(?:listed|posted|designated|advertised|marked|identified)\s+as\s+(?:remote|hybrid|on-?site|in[\s-]office)\b[^.;!?•]*/gi;

/**
 * CareerPlug's footer for the employer's "flexible" remote setting, on every such posting:
 * "Flexible work from home options available." NEOSTEK's Program Manager in Washington, DC carries
 * it beside "Hybrid – Minimum 50% On-Site Required", Mighty Dog Roofing's roof-inspection sales rep
 * in Grand Prairie, TX beside nothing else; tagged remote on it, both kinds went to remote-only
 * users and were spared the city radius (verdict audit, 2026-11-16 08h). A fully remote CareerPlug
 * posting says so in its own words ("This is a remote position.") and its JSON-LD (TELECOMMUTE).
 */
const CAREERPLUG_FLEXIBLE_FOOTER = /\bflexible\s+work\s+from\s+home\s+options?\s+(?:are\s+)?available\b\.?/gi;

function withoutRemoteBoilerplate(text) {
  return String(text || '')
    .replace(CONDITIONAL_REMOTE, ' ')
    .replace(CONDITIONAL_MODE, ' ')
    .replace(LISTED_AS_MODE, ' ')
    .replace(ANYWHERE_PERK, ' ')
    .replace(CAREERPLUG_FLEXIBLE_FOOTER, ' ');
}

/**
 * A posting saying, in so many words, that THIS job is not worked from home. Read by statesRemote
 * (extract.js) and classifyRemote (classify.js), where each one keeps the job out of remote. Supply
 * loop 2026-11-22 00h, each one stored remote: SpaceX's "This role requires being onsite in
 * Starbase, TX – remote work will not be considered" (its "– remote" read as a remote label),
 * ePac's "This is a 100% On-site Position. There is no work from home provision", 2070Health's
 * "on-site role. No work from home", Wainwright's "This position does not offer a Work from Home
 * option", Steri-Clean's "This is not a work from home position", Five Iron's "5iron does not use a
 * Virtual SOC in which Security Analysts work from home" (an on-site SOC in Franklin, TN), and
 * Honda Motor Europe's "no contractual right to work from home" (office roles in Bracknell).
 * Not a limit on where a remote job may be done ("does not support remote work outside the US"), nor
 * a company without offices ("We do not use offices. Everyone can work from home").
 */
const NOT_WORKED_FROM_HOME = new RegExp([
  // Not where from: "Remote work will not be permitted from any other state at this time" (Oracle's
  // remote postings, after the states it hires in).
  '\\bremote(?:\\s+work(?:ing)?)?\\s+(?:will|would|can|could|may)\\s+not\\s+be\\s+(?:considered|offered|available|possible|permitted|allowed|supported|accepted|an?\\s+option)\\b(?!\\s+(?:from|in|outside)\\b[^.;!?]{0,40}?\\b(?:other|another|outside|abroad|countr(?:y|ies)|states?|provinces?|regions?)\\b)',
  '\\bno\\s+(?:work(?:ing)?[\\s-]+from[\\s-]+home|wfh)\\b(?!\\s+(?:days?|stipends?|allowances?|equipment|budget))',
  '\\bnot\\s+(?:an?\\s+)?(?:\\w+\\s+)?work[\\s-]+from[\\s-]+home\\s+(?:position|role|job|opportunity)\\b',
  '\\bno\\s+(?:\\w+\\s+){0,2}right\\s+to\\s+work\\s+(?:from\\s+home|remotely)\\b',
  // Five Iron's on-site SOC, on each of its postings.
  '\\bdoes\\s+not\\s+use\\s+a\\s+virtual\\s+(?:soc|security\\s+operations|office|team)\\b',
  // Not a limit on where: "We do not support international remote work arrangements for this role.
  // ... While this is a remote position" (Dayforce, a remote job within the US).
  '\\b(?:does|do|will)\\s+not\\s+(?:allow|permit|support|offer)\\b(?![^.;!?]{0,80}?\\b(?:international(?:ly)?|overseas|cross[\\s-]border|out[\\s-]of[\\s-](?:state|country)|foreign)\\b)[^.;!?]{0,80}?\\b(?:work(?:ing)?[\\s-]+from[\\s-]+home|wfh|remote\\s+work(?:ing)?)\\b(?![^.;!?]{0,40}\\b(?:outside|abroad|internationally|from\\s+(?:other|another)\\s+(?:countr|state)|across\\s+borders))',
].join('|'), 'i');

/**
 * Whether the text holds one of the wordings above that took remote off a job in the 2026-11-22
 * change (a quoted or timed work-from-anywhere perk, "If this role is remote", NOT_WORKED_FROM_HOME).
 * For scripts/retag-part-week-remote.js, which re-reads only such rows.
 */
function hasRemoteCaveat(text) {
  const t = String(text || '');
  return [ANYWHERE_PERK, CONDITIONAL_MODE, NOT_WORKED_FROM_HOME].some((re) => new RegExp(re.source, 'i').test(t));
}

module.exports = { withoutRemoteBoilerplate, NOT_WORKED_FROM_HOME, hasRemoteCaveat };
