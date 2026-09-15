/**
 * Xeruit board resolver — turns an aggregated posting URL into (ats, ats_slug, native job id).
 *
 * Xeruit is an aggregator: every job carries `externalJobLink`, which points at the employer's
 * real board rather than at Xeruit. That link is the only company identity the feed gives us
 * (`companyName` is free text — "NovoEd,  Inc." — and collides across employers), so the whole
 * import hangs on parsing it.
 *
 * Three things come out of a link, and they are independent:
 *
 *   ats        the platform. Best-effort: recognised even when the slug is not, because it is
 *              still worth knowing that a row is a Workable job we cannot crawl.
 *   slug       the tenant id, in the exact FORMAT our adapter expects — see the notes on each
 *              resolver. Only set when the URL states it unambiguously. Without a slug the
 *              company is stored unlinked (status='unlinked'), which keeps it out of the
 *              crawler's claim query (it requires ats_slug IS NOT NULL) and out of
 *              sync-jobs-to-postgres.
 *   nativeId   the id the PLATFORM'S OWN adapter would assign, e.g. `greenhouse_8165028`.
 *              This is what lets a Xeruit row and a natively-crawled row of the same posting
 *              collide on jobs(external_id, company_id) instead of duplicating. Set ONLY where
 *              the URL id is provably the same id the adapter reads from the platform's API;
 *              a wrong guess would merge two DIFFERENT jobs, so anything uncertain is left null
 *              and falls back to `xeruit_{mongoId}` (unique, just never merges).
 *
 * Adapters whose id space the URL does NOT expose are deliberately left nativeId-less:
 *   recruitee  URL carries /o/{title-slug}; the adapter keys on the numeric job.id.
 *   breezy     URL carries the friendly_id; the adapter prefers job.id when present.
 *   teamtailor the adapter keys on the RSS <guid>, which is not the path's numeric id.
 *   icims      the adapter keys on req_id, not the path id.
 */

const { isSupportedAts } = require('../src/utils/supported-ats');

const seg = (u) => u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
const sub = (host) => host.split('.')[0];

// Ordered: first match wins. `fn` returns null when the host matches but the path does not
// carry what we need, which downgrades the row to "platform known, tenant unknown".
const RESOLVERS = [
  // --- platforms we have an adapter for -------------------------------------------------
  {
    // job-boards.greenhouse.io/{slug}/jobs/{id} · boards.greenhouse.io/... · the .eu variant.
    host: /(^|\.)greenhouse\.io$/,
    fn: (u) => { const p = seg(u); return { ats: 'greenhouse', slug: p[0] || null, nativeId: p[1] === 'jobs' && p[2] ? `greenhouse_${p[2]}` : null }; },
  },
  {
    // jobs.lever.co/{slug}/{uuid} — the uuid IS lever's job.id.
    host: /(^|\.)lever\.co$/,
    fn: (u) => { const p = seg(u); return { ats: 'lever', slug: p[0] || null, nativeId: p[1] ? `lever_${p[1]}` : null }; },
  },
  {
    // jobs.ashbyhq.com/{slug}/{uuid} — the uuid IS ashby's job.id.
    host: /(^|\.)ashbyhq\.com$/,
    fn: (u) => { const p = seg(u); return { ats: 'ashby', slug: p[0] || null, nativeId: p[1] ? `ashby_${p[1]}` : null }; },
  },
  {
    // Two shapes, only one of which names the tenant:
    //   apply.workable.com/{slug}/j/{shortcode}/   <- adapter's own format
    //   jobs.workable.com/view/{token}/{title}     <- Workable's job-board aggregator; the
    //                                                 token is not the shortcode and no slug
    //                                                 appears anywhere, so these stay unlinked.
    host: /(^|\.)workable\.com$/,
    fn: (u) => {
      const p = seg(u);
      if (u.hostname.startsWith('apply.') && p[1] === 'j' && p[2]) return { ats: 'workable', slug: p[0], nativeId: `workable_${p[2]}` };
      return { ats: 'workable', slug: null, nativeId: null };
    },
  },
  {
    // jobs.smartrecruiters.com/{Company}/{numericId}-{title} · careers.smartrecruiters.com/{Company}
    // The leading numeric run of the second segment is SmartRecruiters' job id.
    host: /(^|\.)smartrecruiters\.com$/,
    fn: (u) => { const p = seg(u); const m = /^(\d+)/.exec(p[1] || ''); return { ats: 'smartrecruiters', slug: p[0] || null, nativeId: m ? `smartrecruiters_${m[1]}` : null }; },
  },
  {
    // {slug}.applytojob.com/apply/{jobId}/{title} — JazzHR. Slug is the subdomain.
    host: /(^|\.)applytojob\.com$/,
    fn: (u) => { const p = seg(u); return { ats: 'jazzhr', slug: sub(u.hostname), nativeId: p[0] === 'apply' && p[1] ? `jazzhr_${p[1]}` : null }; },
  },
  {
    // ats.rippling.com/{slug}/jobs/{uuid} — the uuid IS rippling's job.uuid.
    host: /(^|\.)rippling\.com$/,
    fn: (u) => { const p = seg(u); return { ats: 'rippling', slug: p[0] || null, nativeId: p[1] === 'jobs' && p[2] ? `rippling_${p[2]}` : null }; },
  },
  {
    // {tenant}.wd{N}.myworkdayjobs.com/{site}/job/{location}/{Title}_{REQID}
    // ats_slug is the bare tenant (import-ats-slugs.js splits the site off the same way), and
    // the adapter keys on the requisition id trailing the last path segment.
    host: /\.myworkdayjobs\.com$/,
    fn: (u) => {
      const p = seg(u);
      const m = /_([A-Za-z0-9-]+)$/.exec(p[p.length - 1] || '');
      return { ats: 'workday', slug: sub(u.hostname), nativeId: m ? `workday_${m[1]}` : null };
    },
  },
  {
    // jobs.jobvite.com/{slug}/job/{id} — the id IS the adapter's listing id.
    host: /(^|\.)jobvite\.com$/,
    fn: (u) => { const p = seg(u); return { ats: 'jobvite', slug: p[0] || null, nativeId: p[1] === 'job' && p[2] ? `jobvite_${p[2]}` : null }; },
  },
  {
    // {slug}.jobs.personio.{de,com}/job/{id} — the id IS personio's job id.
    host: /\.jobs\.personio\.[a-z.]+$/,
    fn: (u) => { const p = seg(u); return { ats: 'personio', slug: sub(u.hostname), nativeId: p[0] === 'job' && p[1] ? `personio_${p[1]}` : null }; },
  },
  {
    // {slug}.bamboohr.com/careers/{id}
    host: /(^|\.)bamboohr\.com$/,
    fn: (u) => { const p = seg(u); return { ats: 'bamboohr', slug: sub(u.hostname), nativeId: p[0] === 'careers' && p[1] ? `bamboohr_${p[1]}` : null }; },
  },
  {
    // recruiting.paylocity.com/Recruiting/Jobs/Details/{id} — the id IS paylocity's jobId, but
    // the tenant GUID the adapter needs appears nowhere in the URL, so these stay unlinked.
    host: /(^|\.)paylocity\.com$/,
    fn: (u) => { const p = seg(u); const id = p[p.length - 1]; return { ats: 'paylocity', slug: null, nativeId: /^\d+$/.test(id || '') ? `paylocity_${id}` : null }; },
  },
  {
    // Oracle Fusion: {pod}.fa.{region}.oraclecloud.com/hcmUI/CandidateExperience/{lang}/sites/{site}/job/{id}
    // ats_slug is "{pod}.{region}.{site}", the format src/adapters/oracle.js parseSlug() reads.
    // nativeId is left null: the path id is "{requisition}_{siteNo}" and the adapter keys on
    // the bare requisition id, so splitting it is a guess we do not need to make.
    host: /(^|\.)oraclecloud\.com$/,
    fn: (u) => {
      const parts = u.hostname.split('.');
      const region = parts[parts.indexOf('oraclecloud') - 1] || null;
      const p = seg(u);
      const site = p[p.indexOf('sites') + 1];
      if (!region || !site) return { ats: 'oracle', slug: null, nativeId: null };
      return { ats: 'oracle', slug: `${parts[0]}.${region}.${site}`, nativeId: null };
    },
  },
  { host: /(^|\.)recruitee\.com$/,    fn: (u) => ({ ats: 'recruitee',  slug: sub(u.hostname), nativeId: null }) },
  { host: /(^|\.)breezy\.hr$/,        fn: (u) => ({ ats: 'breezy',     slug: sub(u.hostname), nativeId: null }) },
  { host: /(^|\.)teamtailor\.com$/,   fn: (u) => ({ ats: 'teamtailor', slug: sub(u.hostname), nativeId: null }) },
  { host: /(^|\.)icims\.com$/,        fn: (u) => ({ ats: 'icims',      slug: u.hostname.replace(/\.icims\.com$/, ''), nativeId: null }) },
  { host: /(^|\.)zohorecruit\.[a-z.]+$/, fn: (u) => ({ ats: 'zoho',    slug: sub(u.hostname), nativeId: null }) },
  { host: /(^|\.)pinpointhq\.com$/,   fn: (u) => ({ ats: 'pinpoint',   slug: sub(u.hostname), nativeId: null }) },
  { host: /(^|\.)comeet\.co(m)?$/,    fn: () => ({ ats: 'comeet',      slug: null, nativeId: null }) },
  { host: /(^|\.)taleo\.net$/,        fn: (u) => ({ ats: 'taleo',      slug: sub(u.hostname), nativeId: null }) },

  // --- platforms with no adapter ---------------------------------------------------------
  // Labelled so the corpus stays queryable by platform, but never marked crawlable. The slug
  // is still extracted where the URL gives one, because it is the only stable company key on
  // a shared host (jobs.dayforcehcm.com hosts hundreds of employers).
  { host: /(^|\.)join\.com$/,         fn: (u) => { const p = seg(u); return { ats: 'join', slug: p[0] === 'companies' ? p[1] : null, nativeId: null }; } },
  { host: /(^|\.)careers-page\.com$/, fn: (u) => ({ ats: 'recruitcrm', slug: seg(u)[0] || null, nativeId: null }) },
  { host: /(^|\.)dover\.com$/,        fn: (u) => { const p = seg(u); return { ats: 'dover', slug: p[0] === 'apply' ? p[1] : null, nativeId: null }; } },
  { host: /(^|\.)gem\.com$/,          fn: (u) => ({ ats: 'gem',        slug: seg(u)[0] || null, nativeId: null }) },
  { host: /(^|\.)kula\.ai$/,          fn: (u) => ({ ats: 'kula',       slug: seg(u)[0] || null, nativeId: null }) },
  { host: /(^|\.)dayforcehcm\.com$/,  fn: (u) => { const p = seg(u); return { ats: 'dayforce', slug: p[1] || null, nativeId: null }; } },
  { host: /(^|\.)ultipro\.com$/,      fn: (u) => ({ ats: 'ultipro',    slug: seg(u)[0] || null, nativeId: null }) },
  // ADP names the tenant in ?cid=, not in the path.
  { host: /(^|\.)adp\.com$/,          fn: (u) => ({ ats: 'adp',        slug: u.searchParams.get('cid') || null, nativeId: null }) },
  { host: /(^|\.)jibeapply\.com$/,    fn: (u) => ({ ats: 'jibe',       slug: sub(u.hostname), nativeId: null }) },
  { host: /(^|\.)trinethire\.com$/,   fn: (u) => { const p = seg(u); return { ats: 'trinet', slug: p[0] === 'companies' ? p[1] : null, nativeId: null }; } },
  { host: /(^|\.)paycomonline\.net$/, fn: () => ({ ats: 'paycom',      slug: null, nativeId: null }) },
  { host: /(^|\.)silkroad\.com$/,     fn: () => ({ ats: 'silkroad',    slug: null, nativeId: null }) },
  { host: /(^|\.)careerpuck\.com$/,   fn: (u) => ({ ats: 'careerpuck', slug: seg(u)[1] || null, nativeId: null }) },
  { host: /(^|\.)eightfold\.ai$/,     fn: (u) => ({ ats: 'eightfold',  slug: seg(u)[1] || null, nativeId: null }) },
  { host: /(^|\.)phenompeople\.com$/, fn: () => ({ ats: 'phenom',      slug: null, nativeId: null }) },
  { host: /(^|\.)avature\.net$/,      fn: (u) => ({ ats: 'avature',    slug: sub(u.hostname), nativeId: null }) },
];

/**
 * @param {string} link  externalJobLink
 * @returns {{ats:string, slug:string|null, nativeId:string|null, host:string|null, crawlable:boolean}}
 *   ats 'direct' means the posting sits on an employer's own careers site — one company per
 *   host, so the host itself is the company key.
 */
function resolveBoard(link) {
  let u;
  try { u = new URL(link); } catch { return { ats: 'unknown', slug: null, nativeId: null, host: null, crawlable: false }; }
  const host = u.hostname.toLowerCase();

  for (const r of RESOLVERS) {
    if (!r.host.test(host)) continue;
    const out = r.fn(u) || {};
    const slug = out.slug || null;
    return {
      ats: out.ats,
      slug,
      nativeId: out.nativeId || null,
      host,
      // Crawlable means "the fleet could sync this company": we know the platform, we have an
      // adapter for it, and we have the tenant id in the format that adapter expects.
      crawlable: !!slug && isSupportedAts(out.ats),
    };
  }

  return { ats: 'direct', slug: null, nativeId: null, host, crawlable: false };
}

module.exports = { resolveBoard, RESOLVERS };
