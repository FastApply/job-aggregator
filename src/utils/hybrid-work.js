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
  'work(?:ing|place|force|er|ers|s)?|role|roles|position|positions|job|jobs|schedule|model|arrangements?|set-?up|basis|capacity|' +
  'opportunity|policy|office|offices|remote|remotely|on-?site|in-?office|in-?person|format\\s+(?:with|of)|structure|mode|option|' +
  'flexibility|friendly|employees?|team\\s+members?|presence|attendance|eligible|organi[sz]ation|culture|' +
  'approach\\s+to\\s+work(?:ing)?|ways?\\s+of\\s+working|based|tele(?:commut|work|psychiatr|health)\\w*|setting|hub|flex|' +
  // One environment, not "hybrid environments" (cloud): "Our hybrid environment allows you to balance
  // your work", "hybrid sales environment (home office and in-field)".
  '(?:(?:work|working|sales|office|team)\\s+)?environment(?!s)';
// Not a thing: "remote and hybrid cloud deployments", "hybrid delivery methodologies", "Hybrid Theatre".
const NOT_A_THING =
  '(?![\\s-]+(?:cloud|crypto\\w*|apps?|applications?|vehicles?|cars?|electric|integrations?|infrastructure|environments|' +
  'systems?|solutions?|architectures?|data|deployments?|it|networks?|events?|engines?|mobile|storage|clusters?|servers?|' +
  'enterprise|delivery|retrieval|instruction|formats|theat(?:re|er)s?|schools?|classes|courses|learning|methodolog\\w*|' +
  'approaches?\\s+to\\s+(?!work)|models?\\s+of\\s+care|leadership)\\b)';
const OTHER_MODE =
  '(?:remote(?:ly)?|on-?site|in-?office|in-?person|office-based|work\\s+from\\s+home|wfh|flexible\\s+work(?:ing)?|' +
  '(?:the\\s+)?office|full[\\s-]?time\\s+(?:from|in|at)\\s+(?:our|the)\\s+office|agile\\s+working)';
const LABEL =
  '(?:location|workplace(?:\\s+type)?|work(?:ing)?\\s*(?:mode|modality|model|type|arrangements?|style|setting|location|environment|schedule|place|pattern|location\\s+type|flexibility)|flexible\\s+work(?:ing)?|remote\\s+position|' +
  'arrangements?|position\\s+type|job\\s+type|remote\\s+type|telework\\s+type|employment\\s+type|schedule|site|' +
  'on-?site\\s+or\\s+remote|remote\\s+or\\s+on-?site|flexible\\s+work(?:ing)?\\s+arrangements?|arbeitsmodell|modalidad|modalit[àa])';

const HYBRID_WORK = new RegExp([
  // "hybrid role", "hybrid work model", "hybrid-remote", "Hybrid Remote", "Hybrid Worker".
  `\\bhybrid[\\s-]+(?:${WORK_NOUNS})\\b`,
  // "Hybrid (3 days in office)", "hybrid, 2 days a week", "hybrid - 3 days onsite", "Hybrid: Tuesday".
  '\\bhybrid\\s*[(,:\\-–—]\\s*(?:\\d|one|two|three|four|minimum|at\\s+least|\\w+\\s+days?|(?:mon|tues?|wed|thu|fri)\\w*)',
  // A label's value, with or without a colon or a bullet: "Location: Hybrid", "Work Model Hybrid",
  // "Work modality: Hybrid", "Working Arrangement Hybrid", "WORK MODE: • Hybrid/Split".
  `\\b${LABEL}\\s*[:\\-–—]?\\s*(?:[•·*]\\s*)?(?:[\\w .,/&()'’-]{0,60}?[\\s,/|(\\-–—•·]\\s*)?hybrid\\b${NOT_A_THING}`,
  // "working hybrid from our Irvine office", "Hybrid (remote und im Office)".
  `\\bwork(?:ing|s)?\\s+hybrid\\b${NOT_A_THING}`, '\\bhybrid\\s*\\(\\s*(?:remote|office|on-?site|home|\\d)',
  // The employer's tags: "#LI-Hybrid", "#Hybrid"; "flexible-hybrid careers".
  '#(?:li[\\s-]*)?hybrid\\b', '\\bflexible[\\s-]+hybrid\\b',
  // "This role is categorized as hybrid".
  `\\b(?:is|are)\\s+(?:categori[sz]ed|classified|considered|designated|structured|set\\s+up)\\s+as\\s+(?:a\\s+)?hybrid\\b${NOT_A_THING}`,
  // A tag: "(Hybrid)", "(Hybrid - NYC)", "[Hybrid]", "Engineer - Hybrid", "Hybrid | Austin", "Derby/hybrid)".
  `[(\\[]\\s*hybrid\\b${NOT_A_THING}`, '[\\-–—|/]\\s*hybrid\\s*(?:$|[,.;|)(\\-–—])', '^\\s*hybrid\\s*(?:$|[,;|\\-–—:(])',
  // Beside another mode: "remote or hybrid", "hybrid/on-site", "hybrid, or fully remote", "Hybrid or flexible work".
  `\\b${OTHER_MODE}\\s*(?:,\\s*)?(?:,|/|\\bor\\b|\\band\\b|&)?\\s*(?:a\\s+)?hybrid\\b${NOT_A_THING}`,
  `\\bhybrid\\s*(?:,\\s*)?(?:,|/|\\bor\\b|\\band\\b|&)\\s*(?:fully\\s+)?${OTHER_MODE}`,
  // After the role: "this role is hybrid", "the position will be hybrid", "we work hybrid".
  '\\b(?:role|position|job|opportunity|schedule|arrangement|team|we|mode|model|set-?up|internships?|placements?|' +
    'contract|assignment)\\s+(?:is|are|will\\s+be|would\\s+be|can\\s+be|work|works)\\s+' +
    `(?:currently\\s+|fully\\s+|a\\s+)?hybrid\\b${NOT_A_THING}`,
  // The office or home in the same sentence: "a hybrid approach including required in-office days",
  // "a hybrid approach, with teams in the office", "hybrid sales environment (home office and in-field".
  `\\bhybrid\\b${NOT_A_THING}[^.;!?•]{0,80}?\\b(?:in[\\s-]?office|in\\s+the\\s+office|office\\s+days?|days?\\s+(?:in|at)\\s+(?:the\\s+)?office|` +
    'on[\\s-]?site|in[\\s-]person|from\\s+home|home\\s*(?:/\\s*)?office|days?\\s+(?:a|per)\\s+week)\\b',
].join('|'), 'i');

// "hybrid in Austin", "Hybrid out of our Denver office": a capitalised place, read with case.
// A title's tag before the place: "Clinical Therapist - Hybrid Forest Hills".
// And after it, at the end of a title or line: "UX Designer - Barcelona Hybrid", "Karlsruhe oder London, Hybrid".
const HYBRID_IN_PLACE =
  /[-–—|,]\s*[A-Z][a-zäöüé]+(?:\s+[A-Z][a-zäöüé]+)?\s+[Hh]ybrid\s*$|,\s*[Hh]ybrid(?![\s-]+(?:[Cc]loud|IT|[Ii]nfrastructure|[Ee]nvironments|[Ss]olutions?|[Dd]eployments?)\b)(?=\s*(?:$|[.;|•]|\s+[A-ZÄÖÜ]))|\b[Hh]ybrid\s+(?:in|at|from|out\s+of|based\s+in|near)\s+(?:our\s+|the\s+)?[A-Z][a-z]|[-–—|]\s*[Hh]ybrid\s+(?!(?:Cloud|Infrastructure|Integration|Data|Systems?|Solutions?|Apps?|Applications?|Networks?|Storage|Energy|Vehicles?|Power|Retrieval|Search|Work|Remote)\b)[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s*(?:$|[-–—|,(])/;
const HYBRID_WORD = /\bhybrid\b/i;

/** Whether `text` (a title or description) names hybrid as a work arrangement. */
function statesHybridWork(text) {
  // Tags out first: a posting's "<strong>Work Model:</strong> Hybrid" is the label and its value.
  const s = String(text || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  return HYBRID_WORD.test(s) && (HYBRID_WORK.test(s) || HYBRID_IN_PLACE.test(s));
}

/**
 * The same for a job's fields: the location counts on the word alone (it names places and work
 * modes, not technology), the title and description only in work-arrangement wording.
 */
// A title that opens with the mode: "Hybrid Immunization Specialist (Vaccines) Winchester, VA".
const TITLE_OPENS_HYBRID =
  /^\s*hybrid\s+(?!(?:cloud|it|infrastructure|integration|data|systems?|solutions?|apps?|applications?|networks?|storage|energy|vehicles?|power|retrieval|search|bonding|product|engineer|architect|rn|nurse|care)\b)/i;

function jobStatesHybrid(title, location, description) {
  if (HYBRID_WORD.test(String(location || ''))) return true;
  if (TITLE_OPENS_HYBRID.test(String(title || ''))) return true;
  return statesHybridWork(title) || statesHybridWork(description);
}

module.exports = { statesHybridWork, jobStatesHybrid, HYBRID_WORK };
