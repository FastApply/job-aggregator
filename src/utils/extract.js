/**
 * Extraction utilities for enriching job data from descriptions.
 * Extracts salary, workplace type, and employment type from free text.
 */

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
function extractSalary(text) {
  if (!text) return null;

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
  const symbolRangeMatch = text.match(
    /([$£€]|[AC]\$)\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)\s*([kK])?\s*(?:[-–—]|to)\s*(?:[$£€]|[AC]\$)?\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)\s*([kK])?/
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
  const codeRangeMatch = text.match(
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
  const singleMatch = text.match(
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
  const singleCodeMatch = text.match(
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
  const payRangeMatch = text.match(
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
function extractWorkplaceType(title, location, description) {
  const fields = [title, location, description].filter(Boolean).join(' ').toLowerCase();

  if (/\bremote\b|\bwork from home\b|\bwfh\b|\bfully remote\b|\b100% remote\b/.test(fields)) {
    if (/\bhybrid\b/.test(fields)) return 'hybrid';
    return 'remote';
  }
  if (/\bhybrid\b|\bflex\s*office\b|\bpartially remote\b/.test(fields)) return 'hybrid';
  if (/\bon-site\b|\bonsite\b|\bin-office\b|\bin office\b|\bon site\b/.test(fields)) return 'onsite';

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

module.exports = { extractSalary, extractWorkplaceType, extractEmploymentType, normalizeEmploymentType, EMPLOYMENT_TYPES };
