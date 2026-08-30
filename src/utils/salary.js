/**
 * Salary normalisation, so amounts are comparable across postings.
 *
 * Two things stop raw salary_min/salary_max being filterable:
 *
 *   1. They are TEXT (deliberately — decimals and odd formats), so `salary_min > 200000`
 *      compares strings and "90000" sorts above "200000".
 *   2. The interval varies as much as the amount. On the live corpus hourly (495k rows) and
 *      yearly (482k) are almost exactly as common as each other, so an un-annualised comparison
 *      is not merely imprecise — it is meaningless. $50/hr and $50,000/yr are the same number.
 *
 * annualiseSalary() collapses both problems into one numeric, comparable figure.
 */

// Stored interval spellings, from the live corpus: hourly, hour, per-hour-wage, yearly, year,
// per-year-salary, month, monthly, week, weekly... Each adapter names the same thing its own way,
// the same disease normalizeEmploymentType() already treats.
const INTERVAL_ALIASES = [
  [/\b(year|yearly|annual|annually|annum|yr|per-year|salary)\b/i, 'yearly'],
  [/\b(month|monthly|per-month|mo)\b/i, 'monthly'],
  [/\b(semimonthly|semi-monthly|twice[-\s]?monthly)\b/i, 'semimonthly'],
  [/\b(biweekly|bi-weekly|fortnight(ly)?)\b/i, 'biweekly'],
  [/\b(week|weekly|per-week|wk)\b/i, 'weekly'],
  [/\b(day|daily|per-day|diem)\b/i, 'daily'],
  [/\b(hour|hourly|per-hour|hr|wage)\b/i, 'hourly'],
];

// Largest amount that is credible FOR THAT INTERVAL. Anything above is a mislabelled interval,
// not a real figure — see the note in annualiseSalary().
// Tuned against the real distribution, not guessed. Stored "weekly" amounts cluster in two
// groups: ~1,000 rows under $9k (real weekly rates) and ~900 rows between $60k and $900k, which
// are annual salaries carrying a weekly label — "Alliances Manager, 70,000-90,000 weekly" is
// $3.64M/yr on its face. The split sits far below the old $100k ceiling, so that ceiling passed
// every one of them through.
//
// The error cost is asymmetric, so these lean strict: one mislabelled row annualised to millions
// pollutes the top of EVERY high-salary search, while a genuine outlier that gets excluded is
// merely absent from salary filters — it still appears in ordinary search, with its salary shown.
const MAX_PLAUSIBLE = {
  yearly: 10000000,     // $10M/yr
  monthly: 125000,      // $1.5M/yr
  semimonthly: 60000,   // $1.44M/yr
  biweekly: 50000,      // $1.3M/yr
  weekly: 25000,        // $1.3M/yr
  daily: 10000,         // $2.6M/yr
  hourly: 1500,         // $3.12M/yr
};

// Hours and periods per year. 2080 = 40h x 52w, the US convention these postings assume.
const PER_YEAR = {
  yearly: 1,
  monthly: 12,
  semimonthly: 24,
  biweekly: 26,
  weekly: 52,
  daily: 260,
  hourly: 2080,
};

/**
 * Canonical interval name, or null when the source says nothing usable.
 * Order matters: "per-year-salary" must read as yearly before the "wage"/hour rules see it,
 * and "semimonthly"/"biweekly" must be tested before the bare week/month rules they contain.
 */
function normalizeSalaryInterval(raw) {
  if (!raw) return null;
  const t = String(raw).toLowerCase().trim();
  if (!t) return null;
  // Compound spellings first — a bare /week/ would otherwise claim "biweekly".
  if (/\b(semimonthly|semi-monthly)\b/.test(t)) return 'semimonthly';
  if (/\b(biweekly|bi-weekly|fortnight)/.test(t)) return 'biweekly';
  for (const [re, name] of INTERVAL_ALIASES) if (re.test(t)) return name;
  return null;
}

/**
 * Annualised amount, or null when it cannot be computed honestly.
 *
 * Returns null — rather than assuming yearly — when the interval is missing or unrecognised.
 * Guessing from magnitude was considered and rejected: the corpus already contains rows stored
 * as "USD 120,000 - 155,000 hourly", so magnitude and stated interval genuinely disagree in the
 * source data, and a guess would silently manufacture a number nobody can audit. A null keeps
 * the row out of salary filters, which is the honest outcome.
 */
function annualiseSalary(amount, interval) {
  if (amount === null || amount === undefined || amount === '') return null;
  const n = typeof amount === 'number' ? amount : Number(String(amount).replace(/[, ]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  const iv = normalizeSalaryInterval(interval);
  const mult = PER_YEAR[iv];
  if (!mult) return null;
  // Per-interval plausibility ceiling, because the stated interval is often simply wrong. Real
  // rows in the corpus read "35000 hourly" and "120,000 - 155,000 hourly" — annual figures
  // carrying an hourly label. A single absolute ceiling let 35000/hr through as $72.8M/yr, which
  // then satisfied every high salary filter and put a $35k job at the top of a "$900k+" search.
  //
  // These are deliberately generous — a genuine $1,500/hr consultant still passes — so the only
  // rows rejected are ones no plausible reading supports. Mirrors the lower-bound sanity checks
  // extract.js already applies when parsing salary out of prose.
  if (n > MAX_PLAUSIBLE[iv]) return null;
  const annual = n * mult;
  if (annual > 100000000) return null;
  return Math.round(annual);
}

module.exports = { normalizeSalaryInterval, annualiseSalary, PER_YEAR };
