const { withoutRemoteBoilerplate, NOT_WORKED_FROM_HOME } = require('./remote-boilerplate');
const { jobStatesHybrid } = require('./hybrid-work');

/**
 * Extraction utilities for enriching job data from descriptions.
 * Extracts salary, workplace type, and employment type from free text.
 */

// Money that is not the job's pay. The first figure in a posting used to be stored as its salary,
// whatever it was. Supply loop, 2026-10-31: Wisetack's "base salary ... is $100,000 plus deal
// issuance commission anticipated between $25,000 - $70,000" was stored as $25,000-$70,000 and
// refused against an $85,000 floor; Sentara's "Adoption, Fertility and Surrogacy Reimbursement up
// to $10,000" is the $10,000 "salary" on 3-29% of Sentara rows, a CFO's included; BT's "allowance
// of £5k per annum" went in as £5,000 a month. Same reading as boardPayIsOtherMoney in the backend.
// Verdict audit, 2026-11-20 11h: Ramp's "Fertility HRA (up to $10,000 per year)" and Lennar's "up to
// $30,000 in Adoption Assistance" were stored as $10,000 and $30,000 a year and refused against
// the candidates' salary floors. Same words as BENEFIT_NAMED in the backend.
const NOT_PAY = /\b(?:bonus(?:es)?|commissions?|sign(?:ing|[\s-]on)|stipend|allowance|tuition|reimburs\w*|relocation|referral|revenue|budget|funding|raised|valuation|quota|equity|401\(?k\)?|deposit|fees?|hra|hsa|fsa|lsa|fertility|adoption|surrogacy|family[\s-]forming|childcare|wellness|assistance|(?:life|disability|ad&d|accident)\s+insurance|insurance\s+coverage)\b/i;
const IS_PAY = /\b(?:salary|salaries|pay|compensation|wages?|earnings|ote|remuneration|hourly|base)\b/i;
const STUDENT_DEBT = /\b(?:student\s+(?:debt|loans?)|debt)\b(?:\s+pay\s*down)?/gi;
const OTHER_MONEY_REACH = 200;
const SENTENCE_START = /(?:[.!?]\s+(?=[A-Z])|\n|•)/g;
const MONEY_FIGURE = /(?:[$£€]|[AC]\$)\s*\d[\d,]*(?:\.\d+)?\s*[kK]?/g;

/**
 * Whether a matched figure is other money. Only what stands between it and the money or sentence
 * before it counts, so "$120,000 - $150,000 + bonus" and "compensation, including sales
 * incentives, is $125,100" are pay, as is a pay word just after it ("... in total cash compensation").
 */
function isOtherMoney(text, match) {
  const at = text.slice(match.index).search(/[$£€\d]|[AC]\$/) + match.index;
  const head = text.slice(Math.max(0, at - OTHER_MONEY_REACH), at);
  let from = 0;
  for (const m of head.matchAll(SENTENCE_START)) from = m.index + m[0].length;
  for (const m of head.matchAll(MONEY_FIGURE)) from = Math.max(from, m.index + m[0].length);
  const raw = head.slice(from);
  const before = raw.replace(STUDENT_DEBT, ' ');
  const tail = text.slice(match.index + match[0].length).split(/[.!?]\s|\n|•/, 1)[0].slice(0, 60);
  if (IS_PAY.test(before) || IS_PAY.test(tail)) return false;
  return before !== raw || NOT_PAY.test(before);
}

/**
 * Extract salary information from job description text.
 * Returns { min, max, currency, interval } or null.
 *
 * Handles:
 *  - Ranges: $120,000 - $180,000, £50k-£70k, 53,000 USD - 80,000 USD
 *  - Hourly: $22 - $28/hr, $18.50 - $24.00 per hour
 *  - Single values: Salary: $85,000, Base salary of $120,000
 *  - Oracle format: Minimum Salary: 53,000 USD Maximum Salary: 80,000 USD
 *  - K suffix: $75K - $95K
 */
function extractSalary(rawText) {
  if (!rawText) return null;
  // Greenhouse's pay block keeps its dash as an entity between spans:
  // "$110,000&mdash;$115,000 USD" after stripHtml. Read as no range, so the row had
  // no pay (2026-10-31: 7 of 9 applied rows with that block).
  const text = String(rawText)
    .replace(/&[mn]dash;/g, '-')
    .replace(/<\/?(?:li|p|br|div|ul|ol|h[1-6]|tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');

  const currencyMap = {
    '$': 'USD', '£': 'GBP', '€': 'EUR', 'A$': 'AUD', 'C$': 'CAD',
    'USD': 'USD', 'GBP': 'GBP', 'EUR': 'EUR', 'AUD': 'AUD', 'CAD': 'CAD',
    'CHF': 'CHF', 'SGD': 'SGD', 'HKD': 'HKD', 'NZD': 'NZD', 'INR': 'INR',
    'JPY': 'JPY', 'CNY': 'CNY', 'KRW': 'KRW', 'BRL': 'BRL', 'MXN': 'MXN',
    'ZAR': 'ZAR', 'PLN': 'PLN', 'SEK': 'SEK', 'NOK': 'NOK', 'DKK': 'DKK',
  };

  // Detect interval from surrounding context
  function detectInterval(text, matchStart, matchEnd) {
    const ctx = text.substring(Math.max(0, matchStart - 60), matchEnd + 80).toLowerCase();
    if (/per\s*hour|hourly|\/\s*h(?:ou)?r|an\s*hour/i.test(ctx)) return 'hourly';
    if (/per\s*month|monthly|\/\s*month|\/\s*mo\b/i.test(ctx)) return 'monthly';
    if (/per\s*week|weekly|\/\s*week/i.test(ctx)) return 'weekly';
    return 'yearly';
  }

  function parseNum(s) {
    return parseFloat(s.replace(/,/g, ''));
  }

  function applyK(val, raw) {
    if (/[kK]/.test(raw)) return val * 1000;
    return val;
  }

  // Minimum threshold per interval
  function isValidRange(min, max, interval) {
    if (min > max) return false;
    if (max > 50000000) return false;
    if (interval === 'hourly') return min >= 5 && max >= min;
    if (interval === 'monthly') return min >= 500 && max >= min;
    if (interval === 'weekly') return min >= 100 && max >= min;
    return min >= 10000 && max >= min; // yearly
  }

  // The first match that is pay, passing over money that is something else (isOtherMoney).
  function firstPay(re) {
    for (const m of text.matchAll(new RegExp(re.source, `${re.flags}g`))) {
      if (!isOtherMoney(text, m)) return m;
    }
    return null;
  }

  // ── Pattern 1: Oracle Cloud format "Minimum Salary: 53,000 USD Maximum Salary: 80,000 USD" ──
  const oracleMatch = text.match(
    /[Mm]inim(?:um)?\s*[Ss]alary\s*[:=]?\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*(USD|GBP|EUR|[A-Z]{3})?\s*(?:[-–—]|[Mm]axim(?:um)?\s*[Ss]alary\s*[:=]?\s*)(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*(USD|GBP|EUR|[A-Z]{3})?/
  );
  if (oracleMatch) {
    const min = parseNum(oracleMatch[1]);
    const max = parseNum(oracleMatch[3]);
    const currency = currencyMap[oracleMatch[2] || oracleMatch[4]] || 'USD';
    if (isValidRange(min, max, 'yearly')) {
      return { min: String(min), max: String(max), currency, interval: 'yearly' };
    }
  }

  // ── Pattern 2: Currency symbol ranges $120,000 - $180,000 ──
  const symbolRangeMatch = firstPay(
    /([$£€]|[AC]\$)\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)\s*([kK])?\s*(?:USD|CAD|AUD|GBP|EUR)?\s*(?:[-–—]|to)\s*(?:[$£€]|[AC]\$)?\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)\s*([kK])?/
  );
  if (symbolRangeMatch) {
    const currency = currencyMap[symbolRangeMatch[1]] || 'USD';
    let min = parseNum(symbolRangeMatch[2]);
    let max = parseNum(symbolRangeMatch[4]);
    if (symbolRangeMatch[3]) min *= 1000;
    if (symbolRangeMatch[5] || symbolRangeMatch[3]) max *= 1000; // If min has K, max likely does too
    const interval = detectInterval(text, symbolRangeMatch.index, symbolRangeMatch.index + symbolRangeMatch[0].length);
    if (isValidRange(min, max, interval)) {
      return { min: String(min), max: String(max), currency, interval };
    }
  }

  // ── Pattern 3: Code-prefixed ranges 120,000 USD - 180,000 USD ──
  const codeRangeMatch = firstPay(
    /(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*([kK])?\s*(USD|GBP|EUR|AUD|CAD|CHF|SGD|INR|JPY|CNY|BRL|MXN|ZAR)\s*(?:[-–—]|to)\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*([kK])?\s*(?:USD|GBP|EUR|AUD|CAD|CHF|SGD|INR|JPY|CNY|BRL|MXN|ZAR)?/
  );
  if (codeRangeMatch) {
    const currency = currencyMap[codeRangeMatch[3]] || codeRangeMatch[3];
    let min = parseNum(codeRangeMatch[1]);
    let max = parseNum(codeRangeMatch[4]);
    if (codeRangeMatch[2]) min *= 1000;
    if (codeRangeMatch[5] || codeRangeMatch[2]) max *= 1000;
    const interval = detectInterval(text, codeRangeMatch.index, codeRangeMatch.index + codeRangeMatch[0].length);
    if (isValidRange(min, max, interval)) {
      return { min: String(min), max: String(max), currency, interval };
    }
  }

  // ── Pattern 4: Single salary with context "$85,000" or "salary of $120,000" ──
  const singleMatch = firstPay(
    /(?:salary|compensation|pay|base|total\s*comp|starting\s*at|up\s*to|earning)\s*(?:range\s*)?(?:of\s*|is\s*|:\s*|=\s*)?([$£€]|[AC]\$)\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)\s*([kK])?/i
  );
  if (singleMatch) {
    const currency = currencyMap[singleMatch[1]] || 'USD';
    let val = parseNum(singleMatch[2]);
    if (singleMatch[3]) val *= 1000;
    const interval = detectInterval(text, singleMatch.index, singleMatch.index + singleMatch[0].length);
    if (isValidRange(val, val, interval)) {
      return { min: String(val), max: String(val), currency, interval };
    }
  }

  // ── Pattern 5: Single amount with currency code "53,000 USD" near salary context ──
  const singleCodeMatch = firstPay(
    /(?:salary|compensation|pay|base|earn)\s*(?:range\s*)?(?:of\s*|is\s*|:\s*|=\s*)?(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*([kK])?\s*(USD|GBP|EUR|AUD|CAD|CHF|SGD|INR)/i
  );
  if (singleCodeMatch) {
    const currency = currencyMap[singleCodeMatch[3]] || singleCodeMatch[3];
    let val = parseNum(singleCodeMatch[1]);
    if (singleCodeMatch[2]) val *= 1000;
    if (isValidRange(val, val, 'yearly')) {
      return { min: String(val), max: String(val), currency, interval: 'yearly' };
    }
  }

  // ── Pattern 6: Pay range label "Pay Range: $22 - $28" ──
  const payRangeMatch = firstPay(
    /(?:pay\s*range|hourly\s*rate|rate)\s*[:=]?\s*([$£€])\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)\s*[-–—to]+\s*(?:[$£€])?\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)/i
  );
  if (payRangeMatch) {
    const currency = currencyMap[payRangeMatch[1]] || 'USD';
    const min = parseNum(payRangeMatch[2]);
    const max = parseNum(payRangeMatch[3]);
    const interval = detectInterval(text, payRangeMatch.index, payRangeMatch.index + payRangeMatch[0].length);
    if (isValidRange(min, max, interval)) {
      return { min: String(min), max: String(max), currency, interval };
    }
  }

  return null;
}

/**
 * Detect workplace type from job fields.
 */
// A location that is ONLY a global token -- "Global", "Worldwide", "Anywhere", "Remote - Global
// Anywhere" -- is the employer's own structured statement that the role has no place attached.
// Anchored to the whole string on purpose, because "global" is common inside real place and
// office names: "Bonifacio Global City, , Philippines" (a district of Manila), "NYC Global HQ",
// "Berlin | Global Team" must NOT be read as worldwide, and a substring test reads all three
// as global. Verified against the live corpus: this matches 972 jobs and excludes every one of
// those.
const LOCATION_IS_GLOBAL = /^\s*(remote\s*[-–—:]?\s*)?(global|worldwide|anywhere)(\s+(anywhere|global|remote))?\s*$/i;

// Non-English work-model wording. The English rules below read "remote" and "hybrid" and nothing
// else, so a German, Italian, French, Spanish or Dutch posting stayed untagged -- or, worse, a
// German "Remote-Arbeit und Präsenztage" (remote work AND office days) read as fully remote.
// Measured on "scrum master / agile coach" in Germany + Italy, 2026-09-28: 48 postings, every one
// hybrid or on-site by its own text ("flexible Arbeitszeiten im Homeoffice und Büro", "smart
// working – hybrid"), 5 untagged and 1 tagged on-site against its text.
//
// Fully remote, in so many words, in the other languages. Checked first: these are unambiguous.
// English "100% remote" is left to the English rules below, which also see "not able to offer a
// permanent 100% remote option" next to "hybrid arrangement" and correctly call it hybrid.
const FULL_REMOTE_INTL = new RegExp([
  '100\\s?%\\s?(?:homeoffice|home-office|mobil|télétravail|teletravail|teletrabajo|remoto|da remoto|thuiswerk)',
  '(?:vollständig|vollstaendig|komplett|ausschließlich|ausschliesslich|voll)\\s+(?:remote|im homeoffice|aus dem homeoffice)',
  '(?:completamente|totalmente|interamente)\\s+(?:da\\s+)?remoto',
  'remoto\\s+al\\s+100',
  'full\\s+télétravail|télétravail\\s+(?:complet|total|à\\s*100)',
  'teletrabajo\\s+(?:completo|total|100)',
  'volledig\\s+(?:remote|thuis)',
].join('|'), 'i');
// Explicitly hybrid: the word in any of these languages, office days named alongside home
// working, or remote days counted per week. The German and Dutch inflected forms count only next to
// a work word: "hybride Hotellerie" and "einem hybriden System" are about hotels and software. English wording is deliberately absent beyond the
// word "hybrid" itself -- measured on a 29k live sample, "home office" is as often a US company's
// headquarters ("our home office in Louisville"), a stipend or an insurance product, and "3 days
// per week" as often a shift pattern, as a work model. \b on both ends of "hybrid": Word-exported
// HTML carries "hybridMultilevel" in its list markup.
// The English word itself is read by hybrid-work.js (jobStatesHybrid): only as a work arrangement,
// never "hybrid crypto schemes" or "hybrid cloud".
const HYBRID_INTL = new RegExp([
  '\\bhybride[nrs]?\\s+(?:arbeit\\w*|modell\\w*|werken|work\\w*|model|arbeitsmodell|arbeitsweise)', '\\bwerkplek:?\\s*hybride\\b', '\\bibrid[oa]\\b', '\\bh[ií]brid[oa]\\b', '\\bsmart[\\s-]?working\\b',
  '\\blavoro agile\\b', '\\bdeels thuis\\b', // A few office days a quarter or a year is a remote job with meetups, not hybrid.
  'pr(?:ä|ae)senz(?:tag|zeit)(?:e|en)?\\b(?!\\s+(?:pro|im|per|je)\\s+(?:quartal|jahr|halbjahr))',
  '\\b(?:homeoffice|home-office|mobil(?:es|em)? arbeiten)\\b.{0,60}\\b(?:büro|buero|vor ort|standort)',
  '\\b(?:büro|buero|vor ort)\\b.{0,60}\\b(?:homeoffice|home-office|mobil(?:es|em)? arbeiten)\\b',
  '\\b[1-4]\\s*(?:tag|tage|giorn[oi]|jours?|d[ií]as?)\\s*(?:\\/|pro|in der|a|alla|par|por|a la)\\s*(?:woche|settimana|semaine|semana)\\b',
].join('|'), 'i');
// Home working offered without saying how much of it. Read as hybrid only when nothing else in the
// text says remote -- "Homeoffice" in a fully remote German posting must not demote it. The German
// one-word spelling only: the English "home office" is usually a headquarters (see above).
const HOME_WORK_INTL = /\bhomeoffice\b|\bhome-office\b(?=.{0,30}\b(?:möglich|tage?|anteil|regelung|option)\b)|\bmobil(?:es|em)?\s+arbeiten\b|\btélétravail\b|\bteletravail\b|\bteletrabajo\b|\bthuiswerk(?:en)?\b|\blavoro da remoto\b/i;

// A weekday, spelled out or short, or "F" as in "M-Th on site, F - WFH".
const WEEK_DAY = '(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri)(?:day)?|f';
// Named days in the office: part of the week, so hybrid whatever else the text says. Applied
// 2026-10-30 for candidates who work remotely only, each tagged remote on the word WFH: Ketryx's
// "Monday, Tuesday, Thursday, Friday in office, Wednesday WFH option" and Performix's "M-Th on
// site, F - WFH". Not Monday to Friday: that is the whole week.
const OFFICE_DAY = '(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri)(?:day)?\\.?';
const OFFICE_DAYS = new RegExp(
  `\\b(?:${OFFICE_DAY}(?:\\s*(?:,\\s*and|,|/|&|and)\\s*${OFFICE_DAY}){1,3}` +
  `|(?!mon(?:day)?\\.?\\s*(?:-|–|—|to|through|thru)\\s*fri)${OFFICE_DAY}\\s*(?:-|–|—|to|through|thru)\\s*${OFFICE_DAY}` +
  `|m\\s*\\\\?[-–—]\\s*th)\\s*[:(]?\\s*(?:(?:are|is)\\s+)?(?:in[\\s-]?(?:the\\s+|our\\s+)?office|on[\\s-]?site|in[\\s-]?person)\\b`, 'i');

// Home or remote work on named days of the week: the rest of the week is in the office, so the
// job is hybrid, never remote. Each of these was stored remote on the words "work from home" or
// "work remotely", so it sat in remote-only searches and out of hybrid and on-site ones (supply
// loop 2026-11-21 18h: 14 of 5,995 sampled US remote rows): CoStar's "in office Monday through
// Thursday and work from home on Friday", "onsite in the Brooklyn office Monday - Thursday and
// work remotely on Fridays", "In-office Monday through Thursday and work from home on Fridays",
// "in the office Monday through Wednesday and may work remotely the rest of the week", "Work from
// home Fridays". Not a half day ("½ day work from home Fridays" is a perk of an office job, read
// as nothing here), and not "Monday through Friday", the whole week.
const WEEK_DAYS = '(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri)(?:days?)?';
const PART_WEEK_REMOTE = new RegExp([
  `(?<!(?:½|half|1/2)[\\s-]?days?\\s)\\b(?:work(?:ing|s)?\\s+(?:from\\s+home|remotely|remote)|wfh|remote(?:ly)?)\\s+(?:on\\s+)?(?:the\\s+)?${WEEK_DAYS}\\b`,
  `\\bwork(?:ing)?\\s+remotely\\s+(?:for\\s+)?the\\s+rest\\s+of\\s+the\\s+week\\b`,
  `\\bwith\\s+${WEEK_DAYS}\\s+(?:remote|wfh|from\\s+home)\\b`,
  `\\b(?:in[\\s-]?(?:the\\s+|our\\s+)?office|on[\\s-]?site|in[\\s-]?person)\\s+(?:on\\s+)?(?!mon(?:day)?\\.?\\s*(?:-|–|—|to|through|thru)\\s*fri)${OFFICE_DAY}\\s*(?:-|–|—|to|through|thru)\\s*${OFFICE_DAY}(?=[^.]{0,80}\\b(?:remote(?:ly)?|from\\s+home|wfh)\\b)`,
].join('|'), 'i');
// Home or remote work on a condition ("whenever it suits", "if the work activity allows"): read by
// the remote statement below as no work model. Exported for scripts/retag-part-week-remote.js.
//
// Not a condition on where the employee lives: that is how a remote job names its area. "Candidates
// may work remotely, provided they reside in a state where Verano currently has business
// operations", "available to work remotely as long as you live in one of these states: AR, AZ, FL",
// "open to this person working remote as long as consistency with UK timezone" (retag of
// 2026-11-22: 21 of the 91 rows put back by hand).
const RESIDENCE_CONDITION =
  '(?=[^.;!?]{0,60}?\\b(?:live|lives|living|reside|resides|residing|residents?|located|based(?!\\s+on\\b)|time\\s*-?\\s*zones?)\\b)';
const ON_CONDITION = '\\s*,?\\s*(?:if|when(?:ever)?|where(?:ver)?|depending|subject\\s+to|as\\s+long\\s+as|provided)\\b';
const CONDITIONAL_HOME_WORK = new RegExp(`\\bwork(?:ing|s)?\\s+(?:from\\s+home|remotely|remote)${ON_CONDITION}(?!${RESIDENCE_CONDITION})`, 'i');

// Remote as the way THIS job is worked, read from a description. The bare word is no evidence:
// rows the ATS gives no work model for are tagged here, and a remote-only candidate's search is
// is_remote and nothing else, while the match verdict refuses only a mode the posting STATES, so
// a wrong tag is an application. pref-match audit, 2026-10-30, all applied for remote-only users:
// a Sentara hospital coordinator ("For positions that are available as remote work, Sentara
// employs associates in..."), ManTech's "remote sensing techniques", desktop support with "remote
// tech support", "remote job sites" (a field geologist), "building Remote Teams", "opportunity to
// do remote work as needed".
//
// Singular on purpose: "a remote position" is this one, "for fully remote positions, compensation
// will..." is an employer's boilerplate about others. A benefit line ("remote work options",
// "Remote Work Opportunities") is not read as a work model either; such a row stays untagged.
const REMOTE_STATEMENT = new RegExp([
  // fully remote / 100% remote, unless what follows shows it is about other jobs.
  '\\b(?:fully|100\\s?%|completely|entirely|permanently|exclusively|totally)[\\s-]+remote(?:ly)?\\b(?!\\s+(?:positions|roles|jobs|employees|workers|staff|status)\\b)',
  // "Candidates residing in the following states will be considered for remote employment" (Oracle).
  '\\bremote\\s+(?:working\\s+)?(?:position|role|job|opportunity|assignment|contract|employee|worker|based|employment)\\b(?!\\s+sites?\\b)',
  '\\bremote[\\s-](?:first|only)\\b',
  // Not the people: "overseeing ... all remote employees reporting to that office" (Vega, an
  // office manager in Newport Beach, CA, applied for a candidate in Indiana, 2026-11-02).
  '\\ball[\\s-]remote\\b(?!\\s+(?:employees?|workers?|staff|teams?|team\\s+members?|associates?|colleagues|locations?|sites?|offices?))',
  '#li-remote\\b', '\\bwork\\s+from\\s+anywhere\\b',
  // WFH on its own, not one day of the week ("Wednesday WFH option", "F - WFH").
  `(?<!(?:${WEEK_DAY})\\s*(?:[-–—:]\\s*)?)\\bwfh\\b(?!\\s+(?:option|day|days|flex\\w*|policy|allowance|stipend))`,
  // Nor a condition: "You can work from home, if the work activity allows" (OMV), "our flexible work
  // policy so you can work from home whenever it suits" (Emirates NBD, on every posting), "Able to
  // work remotely if required": a flexibility perk of an office job (supply loop 2026-11-21 18h:
  // 14 of 15,908 sampled remote rows, Dubai bank roles out of Dubai on-site searches).
  // "work remotely", "can work fully remote", "working from home". Not "work with remote teams",
  // a stipend for it, or a few days of it ("work remotely up to 2 days a week").
  // Nor a perk: "the option to work from home" (Frequentis, an office job in Vienna, 2026-10-31).
  `(?<!\\b(?:option|ability|possibility|opportunity|chance|flexibility)\\s+to\\s)\\bwork(?:ing|s)?\\s+(?:(?:fully|entirely|completely|primarily|mostly|100\\s?%)\\s+)?(?:remotely|remote(?!\\s+(?:teams?|sites?|locations?|areas?|staff|colleagues|stakeholders|clients|customers|employees|workers))|from\\s+home(?!\\s+(?:stipend|reimbursement|allowance|equipment|budget|(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri)(?:days?)?\\b)))\\b(?!\\s+(?:\\d|up\\s+to|one|two|three|four|once|twice|on\\s+occasion|occasionally|as\\s+needed|part[\\s-]|some|\\w+\\s+days?\\b))(?!${ON_CONDITION}(?!${RESIDENCE_CONDITION}))`,
  // "Location: Remote", "Location : India, Remote", "Work Arrangement: Fully remote", "Position Type: Full-Time, Remote".
  '\\b(?:location|workplace|arrangement|set-?up|working\\s+conditions|work\\s+(?:mode|model|style|type|schedule)|position\\s+type|job\\s+type)\\s*(?:\\([^)]*\\))?\\s*[:;\\-–—]?\\s*(?:[\\w .,/&\\-]{0,30}[,:/|\\-–—]\\s*)?remote\\b(?!\\s+(?:sites?|locations?|areas?))',
  // Workday's field: "Remote Type - Remote"; "Remote Type: On-site" reads as on-site below.
  '\\bremote\\s+type\\s*[:\\-–—]?\\s*(?:fully\\s+)?remote\\b',
  '\\bis\\s+an?\\s+remote\\b', '\\bremote\\s+worldwide\\b', '\\blocation\\s*:?\\s*virtual\\b', '\\bhourly,\\s*remote\\b',
  '\\bremote\\s*[-–—]\\s*[a-z]+\\s+based\\b',
  // German postings borrow the word: "Remote-Arbeit innerhalb Deutschlands".
  '\\bremote[\\s-]arbeit(?:en)?\\b',
  // "REMOTE - US Residents Only", "Remote (US)", "Sales Manager – Remote".
  '\\bremote\\s*[(\\-–—:|]\\s*(?:us|u\\.s\\.|usa|united\\s+states|uk|united\\s+kingdom|canada|india|europe|emea|apac|latam|latin\\s+america|north\\s+america|anywhere|global|worldwide|nationwide)\\b',
  '\\bremote\\s*\\(\\s*[a-z]', '\\(\\s*remote\\s*\\)', '[–—]\\s*remote\\b(?!\\s+(?:sensing|monitoring|access|support))',
  '\\bremote\\s+work\\s*:', '\\bcomfort\\s+of\\s+your\\s+(?:own\\s+)?home\\b',
  // "This role will be remote", "may be filled remotely". Not "may be eligible for remote work up
  // to 2 days per week" (City of New York, an office job, 2026-11-02) or "...in select geographic
  // locations, subject to approval" (PNC): a chance of it is not how the job is worked.
  '\\b(?:position|role|job)\\s+(?!(?:may|might|could)\\s+be\\s+eligible\\b)(?:is|can\\s+be|will\\s+be|may\\s+be|could\\s+be|would\\s+be)\\s+(?:\\w+\\s+){0,2}?(?:remote|(?:performed|done|filled|based|worked)\\s+remotely)\\b',
].join('|'), 'i');

function statesRemote(title, description) {
  const text = withoutRemoteBoilerplate(String(description || '').replace(/\s+/g, ' '));
  if (!text || NOT_REMOTE_EN.test(text) || NOT_WORKED_FROM_HOME.test(text) || REMOTE_FIELD_NO.test(text) || OFFICE_DAYS.test(text) || PART_WEEK_REMOTE.test(text)) return false;
  if (REMOTE_STATEMENT.test(text)) return true;
  // "Ajaia is hiring a remote Product Manager": the word against the job's own title.
  const name = String(title || '').trim().toLowerCase();
  return name.length > 3 && text.toLowerCase().includes(`remote ${name}`);
}

// The posting says THIS job is hybrid: "This is a hybrid role", "the position will be hybrid", its
// own "#LI-Hybrid" tag, a field of its own ("Location: Hybrid", "Location Designation: Hybrid - 3
// days per quarter"). Not the employer's policy for hybrid roles ("If this role is Hybrid, ..."),
// which remote-boilerplate.js cuts before this is read, nor an offer of either ("Location: Hybrid
// or remote").
const THIS_JOB_HYBRID = new RegExp([
  '(?<!\\b(?:if|unless|whether|when|where)\\s+)\\b(?:this|the)\\s+(?:is\\s+an?\\s+hybrid|(?:role|position|job|opportunity)\\s+(?:is|will\\s+be)\\s+(?:an?\\s+)?hybrid)\\b',
  '#li-hybrid\\b',
  '\\b(?:location(?:\\s+designation)?|work(?:place)?\\s*(?:type|model|mode|arrangement|location))\\s*:\\s*hybrid\\b(?!\\s*(?:or|/|,)\\s*(?:fully\\s+)?remote)',
].join('|'), 'i');

/**
 * Whether a job whose LOCATION says remote stays remote although its description names hybrid work.
 * The location is the ATS's field for this job; the hybrid words in a body are mostly an offer of
 * either ("Hybrid or remote working setup across the Netherlands", "Fully Remote / Hybrid (2 days in
 * the office)", "Superhuman offers a dynamic hybrid model, and candidates in this role can be based
 * remotely") or a company perk ("Hybrid working (blend of home and office working)"). Those were
 * stored hybrid, out of remote-only searches (retag of 2026-11-22: 38 of the 91 rows put back by
 * hand). Hybrid still wins where the location or title names it, where the body sets office days
 * ("Tuesday through Thursday, with the option to work remotely on Mondays and Fridays"), or where it
 * says this job is hybrid.
 */
function remoteLocationOutranksHybrid(title, location, body) {
  const loc = String(location || '');
  if (!REMOTE_IN_HEAD.test(loc) || /\bhybrid\b/i.test(loc)) return false;
  if (HYBRID_INTL.test(`${title || ''} ${loc}`.toLowerCase()) || jobStatesHybrid(title, loc, '')) return false;
  const text = String(body || '').replace(/\s+/g, ' ');
  return !OFFICE_DAYS.test(text) && !PART_WEEK_REMOTE.test(text) && !THIS_JOB_HYBRID.test(text);
}

function extractWorkplaceType(title, location, description) {
  // Checked BEFORE the combined blob below, which is the bug this guards.
  //
  // That blob joins title + location + description and tests /\bhybrid\b/ across all of it, so a
  // single word in a long body overrode the location entirely. Measured on greenhouse/platacard
  // "Risk Data Governance Lead", location "Worldwide", whose 11,117-character description says
  // "Git-based, wiki, or hybrid" -- about DOCUMENTATION TOOLING. That set workplace_type
  // 'hybrid', and classifyRemote() short-circuits on that before it ever looks at the location,
  // so is_remote became false and remote_worldwide with it, dropping a confirmed
  // work-from-anywhere job off the global-remote board. 201 live jobs whose location is purely a
  // global token were stored Onsite or Hybrid this way.
  //
  // The location's own wording can still say hybrid/on-site ("USA and Global (Hybrid)"), which
  // fails the anchored match above and falls through to the normal rules.
  if (LOCATION_IS_GLOBAL.test(location || '')) return 'remote';

  // Policy sentences for every mode ("If this position is listed as onsite, ...") name none for
  // this job (remote-boilerplate.js), so no reader here sees them.
  const body = withoutRemoteBoilerplate(String(description || ''));
  const fields = [title, location, body].filter(Boolean).join(' ').toLowerCase();
  const hybrid = HYBRID_INTL.test(fields) || jobStatesHybrid(title, location, body);

  // Unless hybrid is named too: "hasta 20 días al año de trabajo 100% remoto" is a perk on a hybrid
  // job, and "ob voll remote oder in einem unserer Büros" offers a choice.
  if (FULL_REMOTE_INTL.test(fields) && !hybrid) return 'remote';
  // Remote only when the job is said to be worked that way, not on the word: see statesRemote.
  // Not against the posting's own on-site statement (onsiteStated): a description's remote words
  // there are the company's ("we are a remote-first company") or the work's ("support colleagues
  // working remotely"), and a title that says on-site outranks a location field named "Remote".
  const head = `${title || ''} ${location || ''}`;
  const onsite = onsiteStated(title, location, body);
  if ((REMOTE_IN_HEAD.test(head) && !onsite.head) || (!REMOTE_IN_HEAD.test(head) && !onsite.any && statesRemote(title, description))) {
    if (hybrid && !remoteLocationOutranksHybrid(title, location, body)) return 'hybrid';
    return 'remote';
  }
  // "This is an on-site position 4 days/week", "an in-person role ... with flexibility for some
  // remote work": on site with home days, so hybrid.
  if (onsite.any && !hybrid && !OFFICE_DAYS.test(fields) && !PART_WEEK_REMOTE.test(fields)) {
    return ONSITE_THEN_HOME.test(String(body || '').replace(/\s+/g, ' ')) ? 'hybrid' : 'onsite';
  }
  if (/\bflex\s*office\b|\bpartially remote\b/.test(fields) || hybrid || OFFICE_DAYS.test(fields) || PART_WEEK_REMOTE.test(fields)) return 'hybrid';
  if (HOME_WORK_INTL.test(fields)) return 'hybrid';
  if (/\bon-site\b|\bonsite\b|\bin-office\b|\bin office\b|\bon site\b/.test(fields)) return 'onsite';

  return null;
}

// A description saying fully remote in so many words. The crawl-time rule above calls a job remote
// on the bare word anywhere in its text, which on a 20k live sample of late-fetched descriptions was
// wrong about half the time: "not conducive of telecommuting or remote work", "remote access",
// "ocean remote sensing", "the remote and calming areas of Sandbridge", a nurse role whose
// employer notes that SOME positions are remote.
const STRONG_REMOTE_EN = new RegExp([
  '\\b(?:is|be|are|operating in an?)\\s+(?:100%|fully|completely|entirely|permanently)\\s+remote\\b',
  '\\b(?:fully|100%|completely|entirely|permanently)\\s+remote\\s+(?:position|role|job|opportunity|capacity|company|team)\\b',
  '\\b(?:is|as)\\s+(?:(?!not\\b)\\w+\\s+)?an?\\s+(?:(?!not\\b)\\w+\\s+)?remote\\s+(?:position|role|job|opportunity)\\b',
  '\\bremote[\\s-](?:first|only)\\b', '\\bwork\\s+from\\s+anywhere\\b', '#li-remote\\b',
].join('|'), 'i');
// ...and the ways postings say the opposite with the same words: "this is not a remote position"
// (Kimley-Horn, on every posting), "fully remote work is not available", "does not apply to fully
// remote roles", "exceptions will be granted for those in fully remote status".
const NOT_REMOTE_EN = /\bnot\s+(?:an?\s+)?(?:\w+\s+)?remote\b|\bnot\s+suitable\s+for\s+(?:fully\s+)?remote\b|\bwork\s+remotely\s*:?\s*no\b|\botherwise\s+indicated\s+as\s+(?:fully\s+)?remote\b|\bto\s+fully\s+remote\b|\boccasional\s+(?:wfh|remote|work\s+from\s+home)\b|\bnon[\s-]remote\b|\bno\s+remote\b|\bremote(?:\s+work)?\s+is\s+not\b|\bdoes\s+not\s+apply\s+to\s+(?:fully\s+)?remote\b|\bexceptions?\b.{0,80}\bremote\b/i;
// An ATS field answered no: Celestica's SuccessFactors postings carry "Remote Position: No" on
// every on-site role, and "Remote Position" alone read as remote (556 of its 645 remote-tagged rows,
// a production operator in Johor Bahru among them, supply loop 2026-11-11). "Remote: No",
// "Remote Work: No", "Remote Eligible? No" are the same field.
const REMOTE_FIELD_NO = /\bremote(?:\s+(?:position|role|job|work(?:ing)?|eligible|eligibility|option|status|opportunity))?\s*\??\s*:\s*no\b|\bremote\s+(?:position|role|job|work(?:ing)?|eligible|eligibility|option|status|opportunity)\s*\??\s*[-–—]\s*no\b/i;
// Remote as part of a thing, not a work model: "Senior Program Manager - Remote Sensing".
// Nor its negation: "MSP Tier 2 IT Support Technician -Not Remote" (CareerPlug), "Human Resources
// Generalist - Sausalito, CA (Not Remote)" (Breezy) were stored remote on the word (supply loop
// 2026-11-23 12h).
const REMOTE_IN_HEAD = /(?<!\bnot\s+|\bnon[\s-]?)\bremote\b(?!\s+(?:sensing|monitoring|access|patient|pilot|resolution|operations?\s+cent(?:er|re)))|\btelecommute\b|\bwork from home\b/i;

/**
 * The posting says THIS job is worked on site, in its title or in so many words. Supply loop
 * 2026-11-23 12h: office jobs stored remote sat in remote-only searches, where the verdict refused
 * them, and out of on-site searches for their own city. 77 of 3,605 remote rows served to 26
 * remote-only automations said on-site; among them Digital Eclipse "Location: On-Site - Emeryville,
 * CA" (its text: "colleagues working remotely across the United States"), NFI Vermont "This is an
 * onsite position" ("work remotely with colleagues"), Truepill's "This is an onsite role in El Paso,
 * TX" under "We are a remote-first company", Optum's "Senior Manager ... - MN On site", Kimley-Horn,
 * an Indeed-style "Work Remotely • No" field, and titles "(Onsite - Night Shift)", "(Onsite: Deer
 * Park, IL)", "Onsite Desktop Support Engineer - Plymouth" (location "Remote, ENG, GB").
 * Not an offer of both ("Remote/Onsite IT Support Specialist", "Both Onsite & Remotely", "Remote
 * (Eastern Time Zone preferred), or office-based in Hopewell, NJ"), nor a policy for other roles
 * ("some pharmacy operations roles require onsite clinic presence", "For office-based employees").
 * Returns { head, any }: head when the title or location says it.
 */
const ONSITE_WORD = '(?:on[\\s-]?site|in[\\s-]person|in[\\s-]office|office[\\s-]based)';
const ONSITE_IN_TITLE = new RegExp(
  `(?:^|[(\\[|,:–—-]\\s*)${ONSITE_WORD}(?=\\s*(?:$|[)\\]|,:–—-]|\\s(?:desktop|support|technician|engineer|role|position|only)\\b))|\\b${ONSITE_WORD}\\s*(?:$|[)\\]])|\\bnot\\s+remote\\b|\\bnon[\\s-]?remote\\b`, 'i');
const ONSITE_STATEMENT = new RegExp([
  `\\bthis\\s+(?:is|will\\s+be)\\s+an?\\s+(?:fully\\s+|100\\s?%\\s+)?${ONSITE_WORD}\\s+(?:position|role|job|opportunity)\\b`,
  `\\b(?:this|the)\\s+(?:position|role|job)\\s+is\\s+(?:an?\\s+)?(?:fully\\s+|100\\s?%\\s+)?${ONSITE_WORD}\\b(?!\\s*(?:,\\s*)?(?:or|and|\\/)\\s)`,
  `\\blocation\\s*:\\s*${ONSITE_WORD}\\b(?!\\s*(?:or|\\/|,)\\s*(?:fully\\s+)?remote)`,
  '\\bwork\\s+remotely\\s*[•·:\\-–—]\\s*no\\b',
].join('|'), 'i');
// "Job Location: Onsite at Juno Beach, FL is preferred, Remote candidates will be considered".
const BOTH_MODES = /\bremote\s+(?:candidates|applicants)\s+(?:will\s+(?:also\s+)?be\s+|are\s+(?:also\s+)?)?(?:considered|welcome)\b|\bremote\s*(?:\/|&|\$|and|or)\s*on[\s-]?site\b|\bon[\s-]?site\s*(?:\/|&|\$|and|or)\s*remote(?:ly)?\b|\bremote\b[^.;]{0,60}\bor\s+(?:office[\s-]based|on[\s-]?site|in[\s-]person)\b/i;

// Not "fully office based, with no work from home option".
const ONSITE_THEN_HOME = new RegExp(`${ONSITE_WORD}\\b[^.;!?]{0,80}?(?<!\\bno\\s+(?:work\\s+)?|\\bnot\\s+(?:work\\s+)?)(?:\\bremote(?:ly)?\\b|\\b(?:work\\s+)?from\\s+home\\b|\\bwfh\\b|\\b[1-4]\\s*days?\\s*(?:\\/|a|per|each)\\s*week\\b)`, 'i');

// The posting also says THIS job is remote: the employer contradicts itself (Lumen's "This is an
// onsite position at Lumen's Zuni St lab" over "#LI-Remote", Danaher's "(Onsite: Deer Park, IL)"
// over "This position is a remote role") or offers remote on a condition ("This is a Remote
// position Only if you currently reside in the state of Texas... Otherwise, this is an Onsite
// position"). The stored reading stays (owner, 2026-11-05: an employer's own contradiction is left).
const JOB_REMOTE = /\b(?:this|the)\s+(?:is|will\s+be)\s+an?\s+(?:fully\s+|100\s?%\s+)?remote\s+(?:position|role|job|opportunity)\b|\b(?:this|the)\s+(?:position|role|job)\s+is\s+(?:an?\s+)?(?:fully\s+|100\s?%\s+)?remote\b|#li-remote\b/i;

function onsiteStated(title, location, body) {
  const t = String(title || '');
  const text = String(body || '').replace(/\s+/g, ' ');
  if (BOTH_MODES.test(`${t} ${location || ''}`) || JOB_REMOTE.test(text)) return { head: false, any: false };
  const head = ONSITE_IN_TITLE.test(t) || /\bnot\s+remote\b|\bnon[\s-]?remote\b/i.test(String(location || ''));
  return { head, any: head || (ONSITE_STATEMENT.test(text) && !BOTH_MODES.test(text)) };
}

/**
 * extractWorkplaceType for a description fetched after the crawl, which is written onto a job the
 * crawl left untagged and so puts it in or out of remote searches on the text alone. Hybrid and
 * on-site read as the crawl reads them; remote needs the title or location to say so, or the text
 * to say it unambiguously. Anything weaker leaves the job untagged, as it was.
 */
function extractWorkplaceTypeFromDescription(title, location, description) {
  const wt = extractWorkplaceType(title, location, description);
  if (wt !== 'remote') return wt;
  const head = `${title || ''} ${location || ''}`;
  if (REMOTE_IN_HEAD.test(head) || LOCATION_IS_GLOBAL.test(location || '')) return 'remote';
  const text = String(description || '');
  if (NOT_REMOTE_EN.test(text) || NOT_WORKED_FROM_HOME.test(text) || REMOTE_FIELD_NO.test(text)) return null;
  if (FULL_REMOTE_INTL.test(text) || STRONG_REMOTE_EN.test(text)) return 'remote';
  return null;
}

/**
 * Detect employment type from job fields.
 */
function extractEmploymentType(title, description) {
  const text = [title, description].filter(Boolean).join(' ').toLowerCase();

  if (/\bfull[\s-]?time\b/.test(text)) return 'Full-time';
  if (/\bpart[\s-]?time\b/.test(text)) return 'Part-time';
  if (/\bcontract(?:or)?\b|\bfreelance\b|\b1099\b/.test(text)) return 'Contract';
  if (/\binternship\b|\bintern\b/.test(text)) return 'Internship';
  if (/\btemporary\b|\btemp\b/.test(text)) return 'Temporary';

  return null;
}

// Canonical employment types. Every ATS spells these differently and we stored whatever they
// sent: 4,784 distinct values across 1.87M live jobs, of which "Full time", "Full-time",
// "Full-Time", "Full Time", "FULL_TIME", "FullTime", "full_time" and "fulltime_permanent" are
// all the same thing. That made the sidebar facet useless (thousands of "types") and the
// employment_type filter unreliable, since a user picking one spelling missed the rest.
const EMPLOYMENT_TYPES = ['Full-time', 'Part-time', 'Contract', 'Internship', 'Temporary', 'Volunteer'];

function normalizeEmploymentType(raw) {
  if (!raw) return null;
  // Strip HTML entities and separators so "Full &amp; Part-Time" / "full_time" both reduce.
  const t = String(raw).toLowerCase().replace(/&amp;/g, '&').replace(/[_/]+/g, ' ').trim();
  if (!t || t === 'other' || t === 'n/a' || t === 'unknown' || t === 'none') return null;

  // Order matters. Internship and temporary win over the full/part qualifier that usually
  // accompanies them ("Internship - Full Time" is an internship). Part-time is checked before
  // full-time because "Permanent - Part Time" contains both signals and part-time is the
  // specific one.
  // Non-English spellings are checked before the English "temp" rule on purpose: French
  // "temps plein" (full time) must not be read as "temporary".
  if (/\btemps plein\b/.test(t)) return 'Full-time';
  if (/\btemps partiel\b/.test(t)) return 'Part-time';

  if (/\bintern(ship)?\b|\bstagiaire\b|\bpracticante\b/.test(t)) return 'Internship';
  if (/\bvolunteer\b|\bvoluntario\b/.test(t)) return 'Volunteer';
  // PRN and per-diem are the healthcare boards' term for shift-by-shift work.
  if (/\btemp(orary)?\b|\bseasonal\b|\bfixed[\s-]?term\b|\binterim\b|\bcasual\b|\bprn\b|\bper[\s-]?diem\b/.test(t)) return 'Temporary';
  if (/\bcontract(or|ed)?\b|\bfreelance\b|\b1099\b|\bconsultant\b|\bb2b\b|\bcontrato\b/.test(t)) return 'Contract';
  if (/\bpart[\s-]?time\b|\bparttime\b|\bmoonlight(er)?\b|\bmedio tiempo\b|\btiempo parcial\b|\bteilzeit\b/.test(t)) return 'Part-time';
  if (/\bfull[\s-]?time\b|\bfulltime\b|\bpermanent\b|\bregular\b|\btiempo completo\b|\bvollzeit\b/.test(t)) return 'Full-time';
  return null; // unrecognised free text is dropped rather than shown as a filter option
}

module.exports = { PART_WEEK_REMOTE, CONDITIONAL_HOME_WORK, REMOTE_FIELD_NO, onsiteStated, isOtherMoney, extractSalary, extractWorkplaceType, extractWorkplaceTypeFromDescription, statesRemote, extractEmploymentType, normalizeEmploymentType, EMPLOYMENT_TYPES };
