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

function withoutRemoteBoilerplate(text) {
  return String(text || '').replace(CONDITIONAL_REMOTE, ' ');
}

module.exports = { withoutRemoteBoilerplate };
