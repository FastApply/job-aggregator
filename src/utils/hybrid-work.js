'use strict';
// "Hybrid" as the way a job is worked, not "hybrid" as an adjective of something else.
//
// The bare word decided the work model: Solidigm's Senior Security Application Engineer
// (SmartRecruiters, whose own location says remote: true) was stored Hybrid because its
// requirements list "ML-DSA, LMS/LMOD, or hybrid crypto schemes". A remote-only candidate's
// search and the match verdict both read that tag (pref-match audit, 2026-11-10). The same
// word is "hybrid cloud", "hybrid vehicles", "hybrid app", "hybrid and multi-cloud".
//
// So the word counts only where it names a work arrangement:
//   - next to a work noun: "hybrid role", "hybrid work model", "hybrid schedule", "Hybrid Remote";
//   - with a place or office days (HYBRID_IN_PLACE): "hybrid in Austin", "Hybrid (3 days in office)";
//   - as a label's value or a tag: "Location: Hybrid", "Work Model: Hybrid", "(Hybrid)", "- Hybrid";
//   - beside another work mode: "remote or hybrid", "hybrid/on-site";
//   - after the role: "this role is hybrid", "the position will be hybrid";
//   - anywhere in the LOCATION field, which names places and modes and no technology.

const WORK_NOUNS =
  'work(?:ing|place|force|s)?|role|roles|position|positions|job|jobs|schedule|model|arrangements?|set-?up|basis|capacity|' +
  'opportunity|policy|office|offices|remote|remotely|on-?site|in-?office|in-?person|format|structure|mode|option|' +
  'flexibility|employees?|team\\s+members?|presence|attendance|environment\\s+with\\s+(?:\\d|one|two|three|four)';
// Not a thing: "remote and hybrid cloud deployments", "the platform is hybrid infrastructure".
const NOT_A_THING =
  '(?![\\s-]+(?:cloud|crypto\\w*|apps?|applications?|vehicles?|cars?|integrations?|infrastructure|environments?|systems?|' +
  'solutions?|architectures?|data|deployments?|it|networks?|events?|engines?|mobile|storage|clusters?|servers?|models?\\s+of\\s+care))';
const OTHER_MODE = '(?:remote(?:ly)?|on-?site|in-?office|in-?person|office-based|work\\s+from\\s+home|wfh)';

const HYBRID_WORK = new RegExp([
  // "hybrid role", "hybrid work model", "hybrid-remote", "Hybrid Remote".
  `\\bhybrid[\\s-]+(?:${WORK_NOUNS})\\b`,
  // "Hybrid (3 days in office)", "hybrid, 2 days a week", "hybrid - 3 days onsite".
  '\\bhybrid\\s*[(,:\\-–—]\\s*(?:\\d|one|two|three|four|minimum|at\\s+least|\\w+\\s+days?)',
  // A label's value: "Location: Hybrid", "Work Model: Hybrid", "Workplace type - Hybrid".
  '\\b(?:location|workplace(?:\\s+type)?|work\\s*(?:mode|model|type|arrangement|style|setting|location|environment|schedule)|' +
    'arrangement|position\\s+type|job\\s+type|remote\\s+type|employment\\s+type|schedule|site)\\s*[:\\-–—]\\s*' +
    '(?:[\\w .,/&]{0,30}?[,/|\\-–—]\\s*)?hybrid\\b',
  // A tag: "(Hybrid)", "[Hybrid]", "Engineer - Hybrid", "Hybrid | Austin".
  '[(\\[]\\s*hybrid\\s*[)\\]]', '[\\-–—|]\\s*hybrid\\s*(?:$|[,.;|)(\\-–—])', '^\\s*hybrid\\s*(?:$|[,;|\\-–—:(])',
  // Beside another mode: "remote or hybrid", "hybrid/on-site", "on-site, hybrid or remote".
  `\\b${OTHER_MODE}\\s*(?:,|/|\\bor\\b|\\band\\b|&)\\s*(?:a\\s+)?hybrid\\b${NOT_A_THING}`,
  `\\bhybrid\\s*(?:,|/|\\bor\\b|\\band\\b|&)\\s*(?:fully\\s+)?${OTHER_MODE}`,
  // After the role: "this role is hybrid", "the position will be hybrid", "we work hybrid".
  '\\b(?:role|position|job|opportunity|schedule|arrangement|team|we)\\s+(?:is|are|will\\s+be|would\\s+be|can\\s+be|work|works)\\s+' +
    `(?:currently\\s+|fully\\s+|a\\s+)?hybrid\\b${NOT_A_THING}`,
].join('|'), 'i');

// "hybrid in Austin", "Hybrid out of our Denver office": a capitalised place, read with case.
const HYBRID_IN_PLACE = /\b[Hh]ybrid\s+(?:in|at|from|out\s+of|based\s+in|near)\s+(?:our\s+|the\s+)?[A-Z][a-z]/;
const HYBRID_WORD = /\bhybrid\b/i;

/** Whether `text` (a title or description) names hybrid as a work arrangement. */
function statesHybridWork(text) {
  const s = String(text || '').replace(/\s+/g, ' ');
  return HYBRID_WORD.test(s) && (HYBRID_WORK.test(s) || HYBRID_IN_PLACE.test(s));
}

/**
 * The same for a job's fields: the location counts on the word alone (it names places and work
 * modes, not technology), the title and description only in work-arrangement wording.
 */
function jobStatesHybrid(title, location, description) {
  if (HYBRID_WORD.test(String(location || ''))) return true;
  return statesHybridWork(title) || statesHybridWork(description);
}

module.exports = { statesHybridWork, jobStatesHybrid, HYBRID_WORK };
