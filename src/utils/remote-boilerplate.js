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

function withoutRemoteBoilerplate(text) {
  return String(text || '').replace(CONDITIONAL_REMOTE, ' ').replace(ANYWHERE_PERK, ' ');
}

module.exports = { withoutRemoteBoilerplate };
