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

/**
 * A perk with a length, from a benefits list: Altruist's "One month work from anywhere policy" on
 * a Los Angeles and San Francisco job (Greenhouse names only those two offices) went to a
 * candidate in Dallas who works remotely only (First Apply, 2026-11-02). "We work from anywhere"
 * and "Work from anywhere in the US" state how the job is worked and are not touched.
 */
const ANYWHERE_PERK = /\b(?:(?:\d+|one|two|three|four|six|eight|twelve)\s+)?(?:months?|weeks?|days?)\s+(?:of\s+|a\s+year\s+)?work\s+from\s+anywhere\b|\bwork\s+from\s+anywhere\s+(?:polic(?:y|ies)|programs?|perks?|benefits?|stipends?|days?|weeks?|months?)\b/gi;

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
    .replace(LISTED_AS_MODE, ' ')
    .replace(ANYWHERE_PERK, ' ')
    .replace(CAREERPLUG_FLEXIBLE_FOOTER, ' ');
}

module.exports = { withoutRemoteBoilerplate };
