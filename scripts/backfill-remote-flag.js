#!/usr/bin/env node
/**
 * Clear the remote tag from live jobs that are remote only by a word in their text.
 *
 *   DATABASE_URL=... NODE_ENV=production node scripts/backfill-remote-flag.js          # SHADOW
 *   DATABASE_URL=... NODE_ENV=production APPLY=1 node scripts/backfill-remote-flag.js  # armed
 *
 * The crawl used to tag a job remote on the bare word anywhere in its text (extract.js), so a
 * nurse's posting that mentions "remote monitoring" or Sentara's boilerplate about "positions that
 * are available as remote work" sat in every remote search. On a 0.4% sample of live remote rows
 * on 2026-10-30, 510 of 1,145 on ATSes that send no work model were tagged that way, and First
 * Apply applied remote-only users to them: the verdict refuses only a mode the posting states.
 *
 * Why this cannot fix itself on the next crawl: jobs.js keeps the stored tag when a crawl has none
 * (a tag read later from a late-fetched description must survive), so a job the new reader leaves
 * untagged keeps its old "remote".
 *
 * Rewrites a row only when its text has the word and the reader no longer calls it remote, and only
 * on the ATSes whose adapter sends no work model of its own (NO_WORK_MODEL: workplace_type null, or
 * read from the title and location, which retag() reads too) — the audit's own population. On an
 * ATS that does send one (Ashby, Lever, Workable, SmartRecruiters, ...) the stored remote may be the
 * ATS's word, and the next crawl puts it back only if that ATS is still scheduled: a paused account
 * would lose a true tag for good. Feed rows (external_id not "<ats>_...") are skipped as well:
 * demand-crawl's upsert never rewrites their tag, so nothing would restore one cleared by mistake.
 * is_remote and remote_worldwide are re-derived the way the crawl derives them. The index trigger
 * queues each changed row, so this waits while the outbox holds MAX_OUTBOX rows.
 *
 * Walks the primary key, resumable from CKPT.
 * Env: BATCH (5000 ids per step) · MAX_OUTBOX (20000) · POLL_MS (20000) · CKPT · ATS (comma list,
 * overrides NO_WORK_MODEL)
 */
const fs = require('fs');
const { stripHtml } = require('../src/utils/html');
const { extractWorkplaceType } = require('../src/utils/extract');
const { classifyJob } = require('../src/utils/classify');

const REMOTE_WORD = /\bremote(?:ly)?\b|\bwork from (?:home|anywhere)\b|\bwfh\b/i;

// Adapters that set workplace_type to null, or only from the title/location (src/adapters/*.js).
// BambooHR and UKG send a work model on some rows, and both are crawled on schedule, so a tag the
// ATS itself states comes back on the next crawl; every other row of theirs is the old word reader.
const NO_WORK_MODEL = [
  'greenhouse', 'workday', 'successfactors', 'taleo', 'avature', 'brassring', 'personio',
  'reachmee', 'varbi', 'visma', 'adp', 'adp_workforcenow', 'manatal', 'silkroad', 'jazzhr', 'jobvite',
  'bamboohr', 'ukg',
];

// The title or location says the job is worked away from an office, so the tag is the employer's
// and not the old word reader's. The reader alone is not enough here: it lets a hybrid word anywhere
// in the text beat a location of "Remote" (illumin "Account Manager", location "Remote", stored
// remote, read hybrid), and it does not know "Virtual", "Home Based", "Telecommuter", "Home
// Location" or "OFFSITE". On the 2026-11-09 shadow sample those were a quarter of the rows it would
// have cleared. "Remote Sensing" and the reader's other things-not-work-models stay excluded.
const HEAD_REMOTE = /\bremote\b(?!\s+(?:sensing|monitoring|access|patient|pilot|operations?\s+cent(?:er|re)))|\btelecommut\w*|\bwork(?:ing)?\s+from\s+home\b|\bwfh\b|\bvirtual\b|\bhome[\s-]*(?:based|office|location)\b|\boffsite\b|\banywhere\b/i;
// The text says the job is remote in wordings the reader does not take: "#LI- Remote", "globally
// remote positions", "operates in a remote/virtual professional office environment", "Limassol (or
// remote within UTC-1 to UTC+4)". A row skipped here keeps its stored tag, the safe direction.
// Also "Location: Florida - Remote", "Remote candidates will be considered", "Remote positions
// located within communities that ... serves", "flexible and remote working", "remote-friendly".
const TEXT_REMOTE = new RegExp([
  '#li-\\s*remote\\b', '\\bglobally\\s+remote\\b', '\\bremote\\s*\\/\\s*virtual\\b', '\\bvirtual\\s*\\/\\s*remote\\b',
  '\\bremote(?:\\s+work(?:ing)?)?\\s+environment\\b', '\\(\\s*or\\s+remote\\b', '\\bor\\s+remote(?:ly)?\\s+(?:within|from|in|across)\\b',
  'location\\s*:\\s*[^.\\n•:]{0,40}?(?:[-–(,]|\\bor)\\s*remote\\b(?!\\s*type)', '\\bremote\\s+candidates?\\s+(?:will|are|may|can|welcome)\\b',
  '\\bremote\\s+positions?\\s+(?:located|based)\\b', '\\bflexible\\s+and\\s+remote\\s+working\\b', '\\bremote[\\s-]friendly\\b',
  // "Every Call Remote | Full-Time | Bilingual", "Type of environment: Remote", "What & Where: Remote &
  // Full Time", "Remote with flexible hours", "Logistics Remote. Anywhere within +/- 3h of CET".
  '\\bremote\\s*\\|\\s*(?:full|part)[\\s-]?time\\b',
  '\\b(?:environment|where|work(?:place)?\\s*(?:type|model|arrangement|mode|style|setting)|work\\s+location)\\s*:\\s*remote\\b',
  '\\bremote\\s+with\\s+flexible\\b', '\\bremote[.,]?\\s+anywhere\\b',
  // "Position is full-time and remote", "Full-Remote work", "primarily work from a remote home
  // environment", "Location: Washington, DC or Remote, U.S." (the or-form above).
  '\\b(?:position|role|job)\\s+is\\s+(?:(?:full|part)[\\s-]?time\\s+and\\s+)?remote\\b', '\\bfull[\\s-]remote\\b',
  '\\bprimarily\\s+(?:work\\s+)?(?:from\\s+)?(?:an?\\s+)?remote\\b', '\\bremote\\s+home\\b',
].join('|'), 'i');
// The posting's own header names it remote: "QA Engineer Lead Remote We are seeking ...".
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function headerSaysRemote(title, plain) {
  const t = String(title || '').trim();
  if (!t) return false;
  return new RegExp(`^\\s*${escapeRe(t)}\\s*[-–|(,]?\\s*\\(?remote\\b`, 'i').test(plain);
}

// Cleared only when EVERY mention of the word is explained; any other mention keeps the stored tag.
// Listing the ways a posting states remote never converged: four shadow samples on 2026-11-09 each
// turned up new ones ("The position location is full-time remote", "Location • Remote within the
// United States", "• Remote, up to 10% travel", "Remote work from South Africa"). The ways the word
// means something else are few and repeat across employers, so the test runs that way round.
// A thing, not a work model, right after the word: "remote sensing", "remote GP appointments",
// "remote “interviews,”" (a scam warning), "remote job sites", "remote communities".
const THING_AFTER = /^[\s\-“"']*(?:sensing|access|monitor\w*|patients?|telemetry|telehealth|tele-?medicine|support|connection|connectivity|desktop|control(?:s|led)?|i\/o\b|cctv|gp\b|appointments?|consultations?|visits?|interviews?|locations?|sites?|job\s+sites?|work\s?sites?\s+(?:across|in)\b|communit(?:y|ies)|areas?|regions?|villages?|camps?|towns?|islands?|terrain|rural|environments\b|diagnos\w*|troubleshoot\w*|repairs?|reparatur\w*|operations?\s+cent(?:er|re)s?|pilot\w*|teams?|management\s+tools?|tools?|assistance|learning|instruction|teaching|classes|courses|offices?|parts?\s+of|retention\s+allowance|allowance|services?|meetings?|collaboration|deposit|controlled|start|keyless|viewing|inspections?|surveillance|cameras?|sensors?|devices?|equipment|systems?|servers?|installations?|deployments?|updates?|workers?\s+(?:and|or)\b)/i;
// The text around the word denies or limits it: "This is not a remote position", "cannot be
// performed remotely", "Remote work is not available", "Remote Type: On-site", "an option to work
// remote on others", "Four weeks of Work From Anywhere annually", "occasional remote work".
const DENIES_OR_PARTIAL = new RegExp([
  '\\bnot\\s+(?:an?\\s+|be\\s+)?(?:\\w+\\s+)?(?:remote|performed\\s+remotely|work(?:ed)?\\s+remotely)', '\\bno\\s+remote', '\\bnon[\\s-]remote',
  '\\bcannot\\s+be\\s+(?:performed|done|worked)\\s+remotely', '\\bremote(?:\\s+work(?:ing)?)?\\s+(?:is\\s+|are\\s+)?not\\s+(?:available|possible|an\\s+option|offered|permitted)',
  '\\bnot\\s+able\\s+to\\s+consider\\s+remote', '\\bnot\\s+eligible\\s+for\\s+remote', '\\bremote[\\s-]only\\s+roles', '\\bremote\\s+type\\s*[:\\-]?\\s*(?:on-?site|office|no\\b|hybrid)',
  '\\boccasional(?:ly)?\\s+(?:\\w+\\s+)?(?:remote|work\\s+from\\s+home)', '\\bremote\\s+(?:work\\s+)?(?:is\\s+)?(?:available\\s+)?once\\s+a\\s+week', '\\bremote\\s+workdays?',
  '\\b\\d+\\s*(?:%|hours?|days?)\\s+(?:of\\s+)?remote', '\\bremote\\s+on\\s+(?:the\\s+)?others', '\\b(?:weeks?|days?)\\s+(?:of\\s+)?work\\s+from\\s+anywhere',
  '\\bwork\\s+from\\s+anywhere\\s+(?:program|days?|weeks?|policy|allowance)', '\\bsome\\s+remote', '\\bpartially\\s+remote', '\\bhybrid\\b', '\\bfor\\s+(?:fully\\s+)?remote\\s+positions\\b',
  '\\bremote\\s+(?:work\\s+)?(?:may\\s+be\\s+)?(?:possible|considered)\\s+(?:upon|with|on\\s+approval)', '\\bremote\\s+work\\s+as\\s+needed', '\\bpositions\\s+that\\s+are\\s+available\\s+as\\s+remote',
].join('|'), 'i');
const REMOTE_WORD_G = new RegExp(REMOTE_WORD.source, 'gi');
function everyMentionExplained(plain) {
  for (const m of plain.matchAll(REMOTE_WORD_G)) {
    const end = m.index + m[0].length;
    if (THING_AFTER.test(plain.slice(end, end + 60))) continue;
    if (DENIES_OR_PARTIAL.test(plain.slice(Math.max(0, m.index - 80), end + 60))) continue;
    return false;
  }
  return true;
}

/** Pure. The row's new tags, or null when it stays as stored. */
function retag(row) {
  const plain = stripHtml(row.description);
  if (!REMOTE_WORD.test(plain)) return null;
  if (HEAD_REMOTE.test(`${row.title || ''} ${row.location || ''}`) || TEXT_REMOTE.test(plain) || headerSaysRemote(row.title, plain)) return null;
  if (!everyMentionExplained(plain)) return null;
  const workplace = extractWorkplaceType(row.title, row.location, plain);
  if (workplace === 'remote') return null;
  const tags = classifyJob({ title: row.title, location: row.location, workplace_type: workplace, description: plain });
  if (tags.is_remote) return null;
  return { workplace, is_remote: false, remote_worldwide: false };
}

async function main() {
  const db = require('../src/db/connection');
  const longQuery = db.queryWithTimeout
    ? (sql, params) => db.queryWithTimeout(sql, params, 120000)
    : (sql, params) => db.query(sql, params);
  const APPLY = process.env.APPLY === '1';
  const BATCH = parseInt(process.env.BATCH || '5000', 10);
  const MAX_OUTBOX = parseInt(process.env.MAX_OUTBOX || '20000', 10);
  const POLL_MS = parseInt(process.env.POLL_MS || '20000', 10);
  const CKPT = process.env.CKPT || '/tmp/remote-flag-backfill.pos';
  const ATS = process.env.ATS ? process.env.ATS.split(',').map((a) => a.trim()).filter(Boolean) : NO_WORK_MODEL;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const run = async (sql, params = []) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await longQuery(sql, params);
      } catch (err) {
        if (attempt === 5) throw err;
        console.error(`\n  retry ${attempt + 1}: ${err.message}`);
        await sleep(2000 * (attempt + 1) ** 2);
      }
    }
  };

  console.log(`mode: ${APPLY ? 'APPLY' : 'SHADOW'} · ats: ${ATS.join(',')}`);
  const { rows: [b] } = await run('SELECT MIN(id) AS lo, MAX(id) AS hi FROM jobs');
  let from = Number(b.lo) - 1;
  const hi = Number(b.hi);
  if (APPLY && fs.existsSync(CKPT)) {
    const saved = parseInt(fs.readFileSync(CKPT, 'utf8').trim(), 10);
    if (Number.isFinite(saved) && saved > from) { from = saved; console.log(`resuming from ${from.toLocaleString()}`); }
  }
  let scanned = 0, cleared = 0, batches = 0;
  const byAts = {}, byTag = {};
  while (from < hi) {
    const to = Math.min(from + BATCH, hi);
    const { rows } = await run(
      `SELECT id, ats, title, location, description FROM jobs
        WHERE id > ${from} AND id <= ${to} AND removed_at IS NULL AND is_remote = true
          AND ats = ANY($1::text[]) AND left(external_id, length(ats) + 1) = ats || '_'
          AND description IS NOT NULL AND description <> 'N/A'`, [ATS]);
    scanned += rows.length;
    const ids = [], wts = [];
    for (const row of rows) {
      const t = retag(row);
      if (!t) continue;
      ids.push(row.id); wts.push(t.workplace);
      byAts[row.ats] = (byAts[row.ats] || 0) + 1;
      byTag[t.workplace] = (byTag[t.workplace] || 0) + 1;
    }
    if (APPLY && ids.length) {
      for (;;) {
        const { rows: [o] } = await run('SELECT COUNT(*)::int n FROM jobs WHERE index_dirty_at IS NOT NULL');
        if (o.n < MAX_OUTBOX) break;
        await sleep(POLL_MS);
      }
      const r = await run(
        `UPDATE jobs j SET workplace_type = v.wt, is_remote = false, remote_worldwide = false
           FROM unnest($1::bigint[], $2::text[]) AS v(id, wt)
          WHERE j.id = v.id AND j.is_remote = true`, [ids, wts]);
      cleared += r.rowCount || 0;
    } else {
      cleared += ids.length;
    }
    from = to;
    if (APPLY) fs.writeFileSync(CKPT, String(from));
    if (++batches % 20 === 0) {
      const pct = ((from - Number(b.lo)) / (hi - Number(b.lo)) * 100).toFixed(1);
      process.stdout.write(`\r  ${pct}% | remote rows ${scanned.toLocaleString()} | ${APPLY ? 'cleared' : 'would clear'} ${cleared.toLocaleString()}   `);
    }
  }
  console.log(`\nremote rows scanned ${scanned.toLocaleString()}, ${APPLY ? 'cleared' : 'would clear'} ${cleared.toLocaleString()}`);
  console.log('by ats', byAts);
  console.log('new tag', byTag);
  if (db.closeDb) await db.closeDb();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { retag };
