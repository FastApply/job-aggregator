#!/usr/bin/env node
/**
 * Fill company logos from the logos the aggregators already handed us.
 *
 *   node scripts/logo-review/agg-logos.js            # dry run: counts + data/logo/agg-logos.csv
 *   APPLY=1 node scripts/logo-review/agg-logos.js    # write prod companies.logo_url
 *
 * The pulls (pull-aggregators-local.js) store each source's job payload whole in staging agg_raw,
 * and several carry the employer's logo next to the posting URL. The posting URL names the board
 * (greenhouse/acme, acme.wd5.myworkdayjobs.com, ...), and so does every company row we crawl. So
 * the join is BOARD to BOARD, never name to name: that is what lets this skip the human review
 * step the scrape pipeline needs. Name matching is how "Fox Pest Control" got Fox the broadcaster.
 *
 * What is refused, before anything is written:
 *   - vendor art and favicons (lib.js isVendor), plus Google favicon services, which jobloo and
 *     jobhose send for most rows instead of a logo;
 *   - signed URLs that expire within days (lib.js isExpiring);
 *   - any image offered for more than MAX_SHARE distinct boards: one picture on many boards is a
 *     placeholder or a parent brand, not each company's own mark;
 *   - URLs that do not answer 200 with an image-sized body today.
 *
 * Only companies with no logo, or a known-junk one (Google favicon, SmartRecruiters default,
 * Clearbit, which shut down), are touched; the UPDATE re-checks that, so a logo saved by someone
 * else in the meantime is never overwritten.
 *
 * Env: APPLY, SOURCES (default all with logos, simplify included), MAX_SHARE (3), CONC (16), LOCAL_URL.
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { makePool, isVendor, isExpiring } = require('./lib.js');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'data', 'logo', 'agg-logos.csv');
const APPLY = process.env.APPLY === '1';
const MAX_SHARE = parseInt(process.env.MAX_SHARE || '3', 10);
const CONC = parseInt(process.env.CONC || '16', 10);
const LOCAL_URL = process.env.LOCAL_URL || 'postgres://codev@localhost:5432/jobs_local';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

// source -> [posting url, logo url, priority]. Lower priority wins when two sources disagree.
const LOGO_SOURCES = {
  sprout:   ["payload->>'postingUrl'", "payload->>'companyLogo'", 1],
  liftmycv: ["payload->>'jobUrl'", "payload->>'logoUrl'", 2],
  resumly:  ["payload->>'url'", "payload->>'organization_logo'", 4],   // simplify is 3, joined separately below
  jobloo:   ["coalesce(payload->>'applyUrl', payload->>'hostedUrl')", "payload->>'companyLogo'", 4],
  jobhose:  ["payload->>'url'", "payload->>'organizationLogo'", 5],
};
const SOURCE_LIST = (process.env.SOURCES || [...Object.keys(LOGO_SOURCES), 'simplify'].join(',')).split(',').map((s) => s.trim());
const SOURCES = SOURCE_LIST.filter((s) => LOGO_SOURCES[s]);
const USE_SIMPLIFY = SOURCE_LIST.includes('simplify');

// Same board rules as map-aggregators-local.js, restricted to the boards a company row can be
// keyed on (no 'direct': a shared host there is not one employer).
const BOARD_SQL = `
  WITH r AS (%ROWS%),
  b AS (SELECT r.*, lower(split_part(regexp_replace(url,'^https?://(www\\.)?','','i'),'/',1)) AS host,
               regexp_replace(split_part(split_part(url,'?',1),'#',1),'^https?://(www\\.)?','','i') AS bare
          FROM r WHERE url ~ '^https?://' AND logo ~ '^https?://'),
  a AS (SELECT b.*, CASE
      WHEN host ~ '\\.myworkdayjobs\\.com$' THEN 'workday'
      WHEN host ~ '(^|\\.)greenhouse\\.io$' THEN 'greenhouse'
      WHEN host = 'jobs.lever.co' THEN 'lever'
      WHEN host = 'jobs.ashbyhq.com' THEN 'ashby'
      WHEN host = 'apply.workable.com' THEN 'workable'
      WHEN host ~ 'smartrecruiters\\.com$' THEN 'smartrecruiters'
      WHEN host ~ '\\.icims\\.com$' THEN 'icims'
      WHEN host ~ '\\.fa\\.[a-z0-9]+\\.oraclecloud\\.com$' AND bare ~ '/sites/[^/?#]+' THEN 'oracle'
      WHEN host ~ '\\.taleo\\.net$' AND host !~ '\\.tbe\\.taleo\\.net$' THEN 'taleo'
      WHEN host ~ '\\.applytojob\\.com$' THEN 'jazzhr'
      WHEN host ~ '\\.bamboohr\\.com$' THEN 'bamboohr'
      WHEN host ~ '\\.breezy\\.hr$' THEN 'breezy'
      WHEN host ~ '\\.recruitee\\.com$' THEN 'recruitee'
      WHEN host ~ '\\.pinpointhq\\.com$' THEN 'pinpoint'
      WHEN host ~ '\\.teamtailor\\.com$' AND split_part(host,'.',1) <> 'teamtailor' THEN 'teamtailor'
      WHEN host = 'ats.rippling.com' THEN 'rippling'
      WHEN host ~ '\\.jobs\\.personio\\.(de|com)$' THEN 'personio'
      WHEN host ~ '\\.zohorecruit\\.' THEN 'zoho'
      WHEN host = 'jobs.jobvite.com' THEN 'jobvite'
      END AS ats FROM b),
  s AS (SELECT a.*, CASE
      WHEN ats = 'greenhouse' THEN lower(CASE WHEN split_part(bare,'/',2)='embed' THEN substring(url from 'for=([^&#]+)') ELSE split_part(bare,'/',2) END)
      WHEN ats IN ('lever','ashby','workable','rippling','jobvite','smartrecruiters') THEN lower(split_part(bare,'/',2))
      WHEN ats = 'oracle' THEN lower(split_part(host,'.fa.',1) || '.' || split_part(split_part(host,'.fa.',2),'.',1) || '.' || substring(bare from '/sites/([^/?#]+)'))
      ELSE lower(split_part(host,'.',1)) END AS slug FROM a WHERE ats IS NOT NULL)
  SELECT ats, slug, logo, source, prio, count(*) AS n FROM s
   WHERE slug IS NOT NULL AND slug <> '' AND slug NOT IN ('jobs','careers','search','apply','job','embed','en-us','recruiting','www')
   GROUP BY 1, 2, 3, 4, 5`;

const JUNK_LOGO = /google\.com\/s2\/favicons|googleusercontent\.com|gstatic\.com|sr-company-logo-prod|logo\.clearbit\.com|\/favicon\b|viewCareerImage\.do\?type=meta(?![^"]*logo)/i; // Zoho og:image is often a banner unless named *logo*
// What counts as "no real logo" on our side.
const NEEDS_LOGO_SQL = `(logo_url IS NULL OR logo_url = '' OR logo_url ~ 'clearbit\\.com|gstatic\\.com/faviconV2|google\\.com/s2/favicons|sr-company-logo-prod')`;

async function alive(url) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12000), redirect: 'follow' });
    if (!res.ok) return false;
    const type = res.headers.get('content-type') || '';
    if (type && !/image|octet-stream|svg/i.test(type)) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 200;
  } catch { return false; }
}

(async () => {
  const local = new Pool({ connectionString: LOCAL_URL, max: 2, statement_timeout: 0 });
  const prod = makePool();

  // 1. Candidates from staging: (board, logo) pairs with how often each source said so.
  const rows = SOURCES.map((s) => {
    const [u, l, p] = LOGO_SOURCES[s];
    return `SELECT ${u} AS url, ${l} AS logo, '${s}'::text AS source, ${p} AS prio FROM agg_raw WHERE source = '${s}'`;
  }).join(' UNION ALL ');
  console.log(`reading logos from staging: ${SOURCES.join(', ')}`);
  const cand = SOURCES.length ? (await local.query(BOARD_SQL.replace('%ROWS%', rows))).rows : [];
  // Simplify's postings link to simplify.jobs, not to a board, but simplify_employer_platform
  // (simplify-map-employers.js) already resolved each Simplify employer to its real board, so the
  // join is still board to board — through Simplify's own employer id rather than a URL.
  if (USE_SIMPLIFY) {
    const { rows: simp } = await local.query(`
      SELECT p.ats, lower(p.slug) AS slug, r.payload->>'company_logo' AS logo, 'simplify'::text AS source, 3 AS prio, count(*) AS n
        FROM agg_raw r JOIN simplify_employer_platform p ON p.company_id = r.payload->>'company_id'
       WHERE r.source = 'simplify' AND p.crawlable AND p.ats IS NOT NULL AND p.slug IS NOT NULL
         AND r.payload->>'company_logo' ~ '^https?://'
       GROUP BY 1, 2, 3`);
    cand.push(...simp);
    console.log(`  + ${simp.length.toLocaleString()} from simplify (via simplify_employer_platform)`);
  }
  console.log(`  ${cand.length.toLocaleString()} (board, logo) pairs`);

  // 2. Refuse junk, then placeholders (one image on many boards).
  const clean = cand.filter((c) => !JUNK_LOGO.test(c.logo) && !isVendor(c.logo) && !isExpiring(c.logo));
  const boardsPerLogo = new Map();
  for (const c of clean) {
    const set = boardsPerLogo.get(c.logo) || new Set();
    set.add(`${c.ats}|${c.slug}`);
    boardsPerLogo.set(c.logo, set);
  }
  const unshared = clean.filter((c) => boardsPerLogo.get(c.logo).size <= MAX_SHARE);
  console.log(`  after junk filter: ${clean.length.toLocaleString()}; after placeholder filter (> ${MAX_SHARE} boards): ${unshared.length.toLocaleString()}`);

  // Best logo per board: best-priority source, then the logo that source gave most often.
  const best = new Map();
  for (const c of unshared) {
    const k = `${c.ats}|${c.slug}`;
    const cur = best.get(k);
    if (!cur || c.prio < cur.prio || (c.prio === cur.prio && Number(c.n) > Number(cur.n))) best.set(k, c);
  }
  console.log(`  boards with a candidate logo: ${best.size.toLocaleString()}`);

  // 3. Which of our companies need one. Read from prod in pages: the table is large and the
  //    tunnel's statement_timeout is short.
  const need = new Map();   // "ats|slug" -> [company ids]
  let lastId = 0;
  for (;;) {
    const { rows: page } = await prod.query(
      `SELECT id, ats, lower(ats_slug) AS slug FROM companies
        WHERE id > $1 AND status = 'active' AND ats IS NOT NULL AND ats_slug IS NOT NULL AND ${NEEDS_LOGO_SQL}
        ORDER BY id LIMIT 20000`, [lastId]);
    if (!page.length) break;
    for (const r of page) {
      const k = `${r.ats}|${r.slug}`;
      if (best.has(k)) (need.get(k) || need.set(k, []).get(k)).push(r.id);
    }
    lastId = page[page.length - 1].id;
  }
  const ids = [...need.values()].reduce((a, v) => a + v.length, 0);
  console.log(`  our active companies without a real logo that a candidate can fill: ${ids.toLocaleString()} (${need.size.toLocaleString()} boards)`);

  // 4. Liveness, once per distinct URL.
  const urls = [...new Set([...need.keys()].map((k) => best.get(k).logo))];
  const ok = new Set();
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (i < urls.length) {
      const u = urls[i++];
      if (await alive(u)) ok.add(u);
      if (++done % 2000 === 0) process.stdout.write(`\r  checked ${done.toLocaleString()}/${urls.length.toLocaleString()} logo URLs, ${ok.size.toLocaleString()} load   `);
    }
  }));
  console.log(`\r  checked ${urls.length.toLocaleString()} logo URLs, ${ok.size.toLocaleString()} load             `);

  const plan = [];
  for (const [k, cids] of need) {
    const c = best.get(k);
    if (!ok.has(c.logo)) continue;
    for (const id of cids) plan.push({ id, ats: c.ats, slug: c.slug, logo_url: c.logo, source: c.source });
  }
  const bySource = plan.reduce((m, p) => ((m[p.source] = (m[p.source] || 0) + 1), m), {});
  const byAts = plan.reduce((m, p) => ((m[p.ats] = (m[p.ats] || 0) + 1), m), {});
  console.log(`\nwould set ${plan.length.toLocaleString()} logos`);
  console.log(`  by source: ${JSON.stringify(bySource)}`);
  console.log(`  by ats:    ${JSON.stringify(byAts)}`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, 'id,ats,slug,logo_url,source\n' + plan.map((p) => [p.id, p.ats, `"${p.slug}"`, `"${p.logo_url}"`, p.source].join(',')).join('\n') + '\n');
  console.log(`  plan written to ${OUT}`);

  if (!APPLY) { console.log('\nDRY RUN: nothing written. APPLY=1 to save.'); await local.end(); await prod.end(); return; }

  let saved = 0;
  for (let j = 0; j < plan.length; j += 2000) {
    const chunk = plan.slice(j, j + 2000);
    const r = await prod.query(
      `UPDATE companies c SET logo_url = v.logo_url, updated_at = NOW()
         FROM jsonb_to_recordset($1::jsonb) AS v(id bigint, logo_url text)
        WHERE c.id = v.id AND ${NEEDS_LOGO_SQL.replace(/logo_url/g, 'c.logo_url')}`,
      [JSON.stringify(chunk.map((p) => ({ id: p.id, logo_url: p.logo_url })))]);
    saved += r.rowCount;
    process.stdout.write(`\r  saved ${saved.toLocaleString()} / ${plan.length.toLocaleString()}   `);
  }
  console.log(`\nsaved ${saved.toLocaleString()} logos.`);
  await local.end(); await prod.end();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
