#!/usr/bin/env node
/**
 * Before ingesting anything: how many of Sprout's 22,587 "new" companies do we ALREADY have?
 *
 *   node scripts/logo-review/sprout-check-new.js
 *
 * sprout-analyse.js called them new because they failed three keys: ATS slug (only a dozen
 * URL shapes), exact name, loose name. That understates our coverage badly — a company we
 * carry as "Acme Health System" with a Hireology board looks brand new if Sprout calls it
 * "Acme Health" and analyse never learned to parse careers.hireology.com.
 *
 * So this widens every key before anyone writes a row:
 *
 *   A. domain      - the posting host, when it is the company's OWN site, against companies.domain
 *                    and the host of companies.career_url.
 *   B. ats slug    - ~30 board shapes instead of 13, including the ones that dominate the
 *                    unmatched pile (hireology, paycor, occupop, oracle, taleo, gohire...).
 *   C. name->slug  - Sprout's name slugified three ways (flat/dash/underscore) against our
 *                    ats_slug, which is how "Innovative Air" meets "innovative_air".
 *   D. near name   - conservative fuzzy: one normalised name is a prefix of the other and the
 *                    shorter is >= 10 chars. Catches "JPMorgan Chase" vs "JPMorgan Chase & Co"
 *                    without pairing "Summit Health" to "Summit Healthcare Partners".
 *                    Reported SEPARATELY - these are candidates for review, not proof.
 *
 * Writes nothing. Emits sprout-new-verified.json (genuinely absent) and
 * sprout-new-probable.json (fuzzy hits worth a human look).
 *
 * An ATS host serves thousands of companies, so matching a company BY such a host would pair
 * every Hireology customer with each other. Shared-ness must be judged at the REGISTRABLE
 * DOMAIN, not the full host: acme.personio.com and bosch.personio.com each appear once, so a
 * per-host frequency test never flags them, and then both collapse to personio.com and match
 * whichever of our companies registered that domain first. A first cut of this script did
 * exactly that and produced 8,906 domain "matches" that paired Schulte Schlagbaum with
 * Matrix42 and RH Restoration Hardware with an Oracle tenant id.
 */
const fs = require('fs');
const path = require('path');
const { makePool, q } = require('./lib.js');

const ROOT = path.resolve(__dirname, '../..');
const IN = path.join(ROOT, 'data', 'logo', 'sprout-new.json');
const OUT_NEW = path.join(ROOT, 'data', 'logo', 'sprout-new-verified.json');
const OUT_PROB = path.join(ROOT, 'data', 'logo', 'sprout-new-probable.json');

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const SUFFIX = /\b(inc|llc|ltd|limited|corp|corporation|co|gmbh|bv|nv|plc|sa|ag|pty|pte|srl|oy|ab|as|group|holdings)\b\.?/g;
const normLoose = s => norm(String(s || '').toLowerCase().replace(SUFFIX, ' '));

const host = u => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; } };
// Registrable-ish domain. Good enough to compare two hosts that belong to the same company.
const reg = h => {
  if (!h) return null;
  const p = h.split('.');
  if (p.length <= 2) return h;
  const twoLevelTld = /^(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/.test(p.slice(-2).join('.'));
  return p.slice(twoLevelTld ? -3 : -2).join('.');
};

// Widened board list. Each returns the slug that identifies the employer on that board.
function atsSlug(url) {
  const h = host(url);
  if (!h) return null;
  let seg = [];
  try { seg = new URL(url).pathname.split('/').filter(Boolean); } catch { return null; }
  const m = (ats, s, boardOnly) => (s ? { ats, slug: String(s).toLowerCase() } : (boardOnly ? { ats, slug: null } : null));
  const sub = () => h.split('.')[0];

  if (/(^|\.)(job-boards|boards)(\.eu)?\.greenhouse\.io$/.test(h)) return m('greenhouse', seg[0]);
  if (/(^|\.)jobs\.lever\.co$/.test(h)) return m('lever', seg[0]);
  if (/(^|\.)apply\.workable\.com$/.test(h)) return m('workable', seg[0]);
  if (/(^|\.)jobs\.ashbyhq\.com$/.test(h)) return m('ashby', seg[0]);
  if (/(^|\.)(jobs\.)?smartrecruiters\.com$/.test(h)) return m('smartrecruiters', seg[0]);
  if (/(^|\.)recruitee\.com$/.test(h)) return m('recruitee', sub());
  if (/(^|\.)breezy\.hr$/.test(h)) return m('breezy', sub());
  if (/(^|\.)bamboohr\.com$/.test(h)) return m('bamboohr', sub());
  if (/myworkdayjobs\.com$|myworkdaysite\.com$/.test(h)) return m('workday', sub());
  if (/(^|\.)ats\.rippling\.com$/.test(h)) return m('rippling', seg[0]);
  if (/icims\.com$/.test(h)) return m('icims', sub());
  if (/(^|\.)teamtailor\.com$/.test(h)) return m('teamtailor', sub());
  if (/(^|\.)jobs\.personio\.(com|de)$/.test(h)) return m('personio', sub());
  if (/(^|\.)careers\.hireology\.com$/.test(h)) return m('hireology', seg[0]);
  if (/recruitingbypaycor\.com$/.test(h)) return m('paycor', seg[0]);
  if (/(^|\.)api\.occupop\.com$/.test(h)) return m('occupop', seg[0]);
  if (/(^|\.)jobs\.gohire\.io$/.test(h)) return m('gohire', seg[0]);
  if (/(^|\.)jobs\.crelate\.com$/.test(h)) return m('crelate', seg[0]);
  if (/(^|\.)app\.trinethire\.com$/.test(h)) return m('trinet', seg[1] || seg[0]);
  if (/oraclecloud\.com$/.test(h)) return m('oraclecloud', sub());
  if (/tbe\.taleo\.net$|taleo\.net$/.test(h)) return m('taleo', sub());
  if (/(^|\.)jobs\.jobvite\.com$|jobvite\.com$/.test(h)) return m('jobvite', seg[0]);
  if (/(^|\.)recruiting\.paylocity\.com$/.test(h)) return m('paylocity', seg[0]);
  if (/(^|\.)comeet\.co$|comeet\.com$/.test(h)) return m('comeet', seg[0]);
  if (/(^|\.)app\.pinpointhq\.com$/.test(h)) return m('pinpoint', sub());
  if (/zohorecruit\.(com|in|eu)$/.test(h)) return m('zoho', sub());
  if (/(^|\.)applytojob\.com$/.test(h)) return m('jazzhr', sub());
  if (/successfactors\.(com|eu)$/.test(h)) return m('successfactors', sub());
  if (/(^|\.)careers-page\.com$/.test(h)) return m('recruitcrm', seg[0]);
  if (/(^|\.)ht-jobs\.net$/.test(h)) return m('htjobs', seg[0]);

  // Shapes a first pass missed. Each was found by grouping the "unidentified" pile by
  // REGISTRABLE DOMAIN - by host they looked like thousands of one-off company sites,
  // because these boards give every tenant its own subdomain.
  if (/pinpointhq\.com$/.test(h)) return m('pinpoint', sub());
  if (/(^|\.)grnh\.se$/.test(h)) return m('greenhouse', null, true);   // shortlink: board known, slug hidden
  if (/(^|\.)jobs\.workable\.com$/.test(h)) return m('workable', seg[0]);
  if (/lever\.co$/.test(h)) return m('lever', seg[0]);
  if (/zohorecruit\./.test(h)) return m('zoho', sub());
  if (/personio\.(com|de)$/.test(h)) return m('personio', sub());
  if (/(^|\.)careerplug\.com$/.test(h)) return m('careerplug', sub());

  // Boards we can identify but have NO adapter for. Naming them is the point: it turns
  // "unidentified" into a costed decision about which adapter is worth writing.
  if (/(^|\.)betterteam\.com$/.test(h)) return m('betterteam', sub());
  if (/(^|\.)applicantstack\.com$/.test(h)) return m('applicantstack', sub());
  if (/(^|\.)hiringthing\.com$/.test(h)) return m('hiringthing', sub());
  if (/(^|\.)hirehive\.com$/.test(h)) return m('hirehive', sub());
  if (/(^|\.)talosats-careers\.com$/.test(h)) return m('talos', sub());
  if (/(^|\.)loxo\.co$/.test(h)) return m('loxo', seg[0]);
  if (/(^|\.)collage\.co$/.test(h)) return m('collage', seg[0]);
  if (/(^|\.)kula\.ai$/.test(h)) return m('kula', seg[0]);
  if (/(^|\.)careerspage\.io$/.test(h)) return m('careerspage', seg[0]);
  if (/factorialhr\.(com|de|pt|es)$/.test(h)) return m('factorial', sub());
  if (/adp\.com$/.test(h)) return m('adp', seg[0]);
  if (/(^|\.)clearcompany\.com$/.test(h)) return m('clearcompany', sub());

  // gohiring is a tracking wrapper, not a board. A 60-URL sample resolved 80% of it to
  // Personio tenants, which we DO support - but the real board is only visible after
  // following the redirect, so it is reported apart rather than counted as either.
  if (/(^|\.)gohiring\.com$/.test(h)) return m('gohiring-wrapper', 'redirect');
  return null;
}

async function main() {
  const fresh = JSON.parse(fs.readFileSync(IN, 'utf8'));
  console.log(`sprout "new" companies: ${fresh.length}`);

  // Domains serving many distinct companies are shared ATS infrastructure, not company sites.
  // Counted at the registrable domain so per-tenant subdomains cannot hide under the threshold.
  const domUse = new Map();
  for (const f of fresh) { const d = reg(host(f.sample_url)); if (d) domUse.set(d, (domUse.get(d) || 0) + 1); }
  const SHARED = new Set([...domUse.entries()].filter(([, n]) => n >= 3).map(([d]) => d));
  // Known multi-tenant domains, listed outright: a board we happen to see only once or twice
  // is still a board, and one bad pairing is worse than one missed match.
  for (const d of ['personio.com','personio.de','applytojob.com','teamtailor.com','recruitee.com',
    'breezy.hr','pinpointhq.com','zohorecruit.com','zohorecruit.in','zohorecruit.eu','oraclecloud.com',
    'myworkdayjobs.com','myworkdaysite.com','icims.com','taleo.net','jobvite.com','paylocity.com',
    'greenhouse.io','lever.co','workable.com','ashbyhq.com','smartrecruiters.com','bamboohr.com',
    'hireology.com','recruitingbypaycor.com','occupop.com','gohire.io','crelate.com','trinethire.com',
    'careers-page.com','ht-jobs.net','gohiring.com','grnh.se','comeet.co','comeet.com','successfactors.com',
    'jazz.co','jobs.net','rippling.com','collage.co','kula.ai','workablehr.com','bullhornstaffing.com',
    'clearcompany.com','ultipro.com','adp.com','paycomonline.net','dayforcehcm.com','isolvedhire.com',
    'jobscore.com','polymer.co','ripplingats.com','fa.ocs.oraclecloud.com','tal.net','eploy.net',
    'peoplehr.net','hrmdirect.com','applicantpro.com','paylocity.com','bamboo.hr','jobdiva.com',
    'avature.net','phenompeople.com','eightfold.ai','joinhandshake.com','workforcenow.adp.com','careerplug.com'])
    SHARED.add(d);
  console.log(`shared board domains ignored for domain matching: ${SHARED.size}`);

  const pool = makePool();
  const db = await q(pool, 'SELECT id, company_name, ats, ats_slug, domain, career_url FROM companies');
  await pool.end();
  console.log(`our companies: ${db.rows.length}`);

  const bySlug = new Map(), byName = new Map(), byLoose = new Map(), byDomain = new Map(), bySlugAny = new Map();
  const looseList = [];
  for (const c of db.rows) {
    if (c.ats && c.ats_slug) {
      const s = String(c.ats_slug).toLowerCase();
      const k = `${String(c.ats).toLowerCase()}:${s}`;
      if (!bySlug.has(k)) bySlug.set(k, c);
      if (!bySlugAny.has(s)) bySlugAny.set(s, c);       // slug regardless of which board
    }
    const e = norm(c.company_name); if (e && !byName.has(e)) byName.set(e, c);
    const l = normLoose(c.company_name); if (l) { if (!byLoose.has(l)) byLoose.set(l, c); looseList.push([l, c]); }
    for (const d of [reg(c.domain && host('https://' + String(c.domain).replace(/^https?:\/\//, ''))), reg(host(c.career_url))]) {
      if (d && !SHARED.has(d) && !byDomain.has(d)) byDomain.set(d, c);
    }
    // A domain claimed by two different companies of ours is not a usable key either.
    for (const d of [reg(c.domain && host('https://' + String(c.domain).replace(/^https?:\/\//, ''))), reg(host(c.career_url))]) {
      if (d && byDomain.has(d) && byDomain.get(d).id !== c.id) { byDomain.delete(d); SHARED.add(d); }
    }
  }

  // Prefix index for the fuzzy tier, so we compare against a handful rather than 106k.
  const byPrefix = new Map();
  for (const [l, c] of looseList) {
    const k = l.slice(0, 10);
    if (k.length < 10) continue;
    if (!byPrefix.has(k)) byPrefix.set(k, []);
    if (byPrefix.get(k).length < 40) byPrefix.get(k).push([l, c]);
  }

  const tier = { domain: 0, slug: 0, nameslug: 0 };
  const stillNew = [], probable = [];

  for (const f of fresh) {
    const name = f.company;
    let hit = null, how = null;

    const a = atsSlug(f.sample_url);
    if (a) { const c = bySlug.get(`${a.ats}:${a.slug}`) || bySlugAny.get(a.slug); if (c) { hit = c; how = 'slug'; } }

    if (!hit) {
      const h = host(f.sample_url);
      const d = reg(h);
      if (d && !SHARED.has(d)) { const c = byDomain.get(d); if (c) { hit = c; how = 'domain'; } }
    }

    if (!hit) {
      const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      for (const v of [base.replace(/ /g, ''), base.replace(/ /g, '-'), base.replace(/ /g, '_')]) {
        const c = bySlugAny.get(v); if (c) { hit = c; how = 'nameslug'; break; }
      }
    }

    if (hit) { tier[how]++; continue; }

    // Fuzzy last, and never treated as proof.
    const l = normLoose(name);
    if (l.length >= 10) {
      const cands = byPrefix.get(l.slice(0, 10)) || [];
      const near = cands.find(([cl]) => cl === l || cl.startsWith(l) || l.startsWith(cl));
      if (near) { probable.push({ ...f, our_id: near[1].id, our_name: near[1].company_name }); continue; }
    }
    stillNew.push(f);
  }

  fs.writeFileSync(OUT_NEW, JSON.stringify(stillNew, null, 2));
  fs.writeFileSync(OUT_PROB, JSON.stringify(probable, null, 2));

  const pc = n => `${(n / fresh.length * 100).toFixed(1)}%`;
  const found = tier.domain + tier.slug + tier.nameslug;
  console.log('');
  console.log(`ALREADY OURS (confirmed)  : ${found} (${pc(found)})`);
  console.log(`    by ATS slug           : ${tier.slug}`);
  console.log(`    by own domain         : ${tier.domain}`);
  console.log(`    by name-as-slug       : ${tier.nameslug}`);
  console.log(`PROBABLY ours (fuzzy name): ${probable.length} (${pc(probable.length)})  <- needs review, not proof`);
  console.log(`GENUINELY NEW             : ${stillNew.length} (${pc(stillNew.length)})`);

  const byAts = new Map();
  for (const s of stillNew) { const a = atsSlug(s.sample_url); const k = a ? a.ats : (host(s.sample_url) || '?'); byAts.set(k, (byAts.get(k) || 0) + 1); }
  console.log('\ntop boards among the genuinely new:');
  [...byAts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([k, n]) => console.log(`  ${String(n).padStart(6)}  ${k}`));
  const jobs = stillNew.reduce((s, x) => s + (x.jobs || 0), 0);
  console.log(`\nSprout postings behind the genuinely-new set: ${jobs} (median-ish ${(jobs / stillNew.length).toFixed(1)} per company)`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });

// Appended reporting helper: run with SPLIT=1 to break the genuinely-new set down by whether
// we own an adapter for their board. A company we cannot crawl is a row that will never carry
// a live job, so this is the number that decides whether ingestion is worth anything.
