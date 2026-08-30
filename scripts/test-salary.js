#!/usr/bin/env node
/**
 * Checks on salary annualisation.
 *
 *   node scripts/test-salary.js
 *
 * The point of annualising at all: on the live corpus hourly (495k rows) and yearly (482k) are
 * almost equally common, so comparing raw salary_min across postings compares $50/hr with
 * $50,000/yr as though they were the same number.
 */
const { annualiseSalary, normalizeSalaryInterval } = require('../src/utils/salary');

let failures = 0;
const check = (want, got, note) => {
  if (got === want) { console.log(`  ok    ${String(got).padStart(9)}  ${note}`); }
  else { failures++; console.log(`  FAIL  got ${JSON.stringify(got)}, want ${JSON.stringify(want)} — ${note}`); }
};

console.log('interval spellings seen in the live corpus:');
for (const [raw, want] of [
  ['yearly', 'yearly'], ['year', 'yearly'], ['per-year-salary', 'yearly'], ['annually', 'yearly'],
  ['hourly', 'hourly'], ['hour', 'hourly'], ['per-hour-wage', 'hourly'],
  ['monthly', 'monthly'], ['month', 'monthly'], ['weekly', 'weekly'], ['daily', 'daily'],
]) check(want, normalizeSalaryInterval(raw), `"${raw}"`);

console.log('\ncompound intervals must beat the bare word they contain:');
// A bare /week/ rule would otherwise claim "biweekly", halving every fortnightly salary.
check('biweekly', normalizeSalaryInterval('bi-weekly'), '"bi-weekly" is not weekly');
check('biweekly', normalizeSalaryInterval('fortnightly'), '"fortnightly" is biweekly');
check('semimonthly', normalizeSalaryInterval('semi-monthly'), '"semi-monthly" is not monthly');

console.log('\nannualisation:');
check(200000, annualiseSalary('200000', 'yearly'), '200000/yr');
check(104000, annualiseSalary('50', 'hourly'), '$50/hr -> 104000 (2080h)');
check(120000, annualiseSalary('10000', 'monthly'), '10000/mo');
check(104000, annualiseSalary('2000', 'weekly'), '2000/wk');
check(130000, annualiseSalary('500', 'daily'), '500/day (260d)');
check(200000, annualiseSalary('200,000', 'yearly'), 'comma-formatted input');

console.log('\nrefuses to guess rather than inventing a number:');
// Deliberate: the corpus contains rows stored as "USD 120,000 - 155,000 hourly", so stated
// interval and magnitude genuinely disagree in the source. A guess would be unauditable; a null
// simply keeps the row out of salary filters.
check(null, annualiseSalary('150000', null), 'no interval -> null, NOT assumed yearly');
check(null, annualiseSalary('150000', 'per widget shipped'), 'unrecognised interval -> null');
check(null, normalizeSalaryInterval('per widget shipped'), 'unrecognised interval names nothing');
check(null, annualiseSalary(null, 'yearly'), 'no amount');
check(null, annualiseSalary('0', 'yearly'), 'zero');
check(null, annualiseSalary('abc', 'yearly'), 'non-numeric');
check(null, annualiseSalary('120000', 'hourly'), 'absurd result (120k/hr) -> null');

console.log('\nmislabelled intervals are rejected, not annualised:');
// Real rows: "35000 hourly", "USD 120,000 - 155,000 hourly" — annual figures carrying an hourly
// label. Without a per-interval ceiling, 35000/hr became $72.8M/yr and topped every high-salary
// search with a $35k job.
check(null, annualiseSalary('35000', 'hourly'), '35000/hr is an annual figure mislabelled');
check(null, annualiseSalary('600000', 'monthly'), '600k/month is past the monthly ceiling');
check(null, annualiseSalary('90000', 'weekly'), '90k/week — a real corpus row, an annual figure mislabelled');
check(null, annualiseSalary('70000', 'weekly'), '70k/week — ditto ("Alliances Manager")');

console.log('\n...but the ceilings must not cap genuine high earners:');
// The ceilings exist to catch a mislabelled INTERVAL, not to decide what a person may earn.
// Set them too low and real executive and consultant pay disappears from the filter entirely.
check(2080000, annualiseSalary('1000', 'hourly'), '$1000/hr consultant ($2.08M/yr)');
check(1200000, annualiseSalary('100000', 'monthly'), '$100k/month executive ($1.2M/yr)');
check(520000, annualiseSalary('10000', 'weekly'), '$10k/week contractor ($520k/yr)');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
