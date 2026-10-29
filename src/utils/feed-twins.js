/**
 * Feed twins: a row a job FEED stored for a posting the board also crawls from the ATS itself.
 *
 * The feeds (simplify, liftmycv, jobhose, resumly, wonsulting) key their rows by their own job
 * id, so the posting they point at is stored a second time beside the row the ATS crawl wrote
 * (`<ats>_<posting id>`). The two disagree, and the feed is the one that is wrong:
 *
 *   - Propertyse "Marketing Project Coordinator": the Workable row says employment_type
 *     Contract, the liftmycv twin says nothing. FastApply searches with employment_type=
 *     full-time&include_unlabeled=true, so the labelled row was filtered out and the unlabeled
 *     twin was served — a Contract job applied to for a full-time-only candidate (2026-10-28).
 *   - AppLovin "Business Operations Analyst": the liftmycv row for Greenhouse posting
 *     4723320006 said "Palo Alto, CA, Toronto" (the feed merged two postings' offices); the
 *     Greenhouse row says "Palo Alto, CA". A Toronto search found the twin, and a candidate
 *     who wants Ottawa / Ontario / Toronto was applied to the Palo Alto posting.
 *
 * Measured 2026-10-29 on the live board: 125,622 live twin pairs on the same board, 8,758 where
 * the twin has no employment type and the ATS row has one, 12,291 where both have one and they
 * differ, 10,380 where the remote flag differs.
 *
 * The ATS row is authoritative and carries everything the twin does, so the twin is dropped:
 * from the search index by the Meili sync, at ingest by the demand crawler, and from Postgres by
 * scripts/retire-feed-twins.js for the rows already stored.
 *
 * Only ATSs whose posting URL carries the id the ATS crawl keys on are recognised; anything
 * else is never a twin. Both rows must also be on the same board (account / slug), so a
 * per-board id (BambooHR) cannot match another employer's posting.
 */

/** ats -> parse(URL) -> { board, id } | null. Ids are exactly what the adapter keys on. */
const PARSERS = {
  greenhouse(u) {
    if (!/(^|\.)greenhouse\.io$/.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/);
    const id = u.searchParams.get('gh_jid') || (m && m[2]);
    return m && id ? { board: m[1], id } : null;
  },
  workable(u) {
    if (u.hostname !== 'apply.workable.com') return null;
    const m = u.pathname.match(/^\/([^/]+)\/j\/([0-9A-Za-z]+)/);
    return m ? { board: m[1], id: m[2] } : null;
  },
  lever(u) {
    if (!/^jobs\.(eu\.)?lever\.co$/.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/([^/]+)\/([0-9a-f-]{36})/i);
    return m ? { board: m[1], id: m[2] } : null;
  },
  ashby(u) {
    if (u.hostname !== 'jobs.ashbyhq.com') return null;
    const m = u.pathname.match(/^\/([^/]+)\/([0-9a-f-]{36})/i);
    return m ? { board: m[1], id: m[2] } : null;
  },
  smartrecruiters(u) {
    if (!/(^|\.)smartrecruiters\.com$/.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/([^/]+)\/(\d{6,})/);
    return m ? { board: m[1], id: m[2] } : null;
  },
  rippling(u) {
    if (u.hostname !== 'ats.rippling.com') return null;
    const m = u.pathname.match(/^\/([^/]+)\/jobs\/([0-9a-f-]{36})/i);
    return m ? { board: m[1], id: m[2] } : null;
  },
  bamboohr(u) {
    const sub = u.hostname.match(/^([^.]+)\.bamboohr\.com$/);
    const m = u.pathname.match(/\/careers\/(\d+)/);
    return sub && m ? { board: sub[1], id: m[1] } : null;
  },
};

/** The ATS posting a URL points at: { externalId, board } (board lower-cased), or null. */
function atsPostingKey(ats, url) {
  const parse = PARSERS[String(ats || '').toLowerCase()];
  if (!parse || !url) return null;
  let u;
  try { u = new URL(String(url).trim()); } catch { return null; }
  const hit = parse(u);
  if (!hit) return null;
  return { externalId: `${String(ats).toLowerCase()}_${hit.id}`, board: hit.board.toLowerCase() };
}

/** A row the ATS crawl itself wrote: its external_id is `<ats>_<posting id>`. */
function isAtsRow(row) {
  const ats = String(row.ats || '').toLowerCase();
  return !!ats && String(row.external_id || '').startsWith(`${ats}_`);
}

/**
 * Of `rows` (needing id, ats, external_id, url), the ones that are feed twins of a LIVE ATS row
 * on the same board. Returns Map(twin row id -> ATS row id). One indexed lookup on external_id
 * per call (jobs has UNIQUE(external_id, company_id)).
 */
async function findFeedTwins(rows, query) {
  const want = new Map(); // externalId -> [{ row, board }]
  for (const row of rows || []) {
    if (isAtsRow(row)) continue;
    const key = atsPostingKey(row.ats, row.url);
    if (!key) continue;
    if (!want.has(key.externalId)) want.set(key.externalId, []);
    want.get(key.externalId).push({ row, board: key.board });
  }
  const twins = new Map();
  if (!want.size) return twins;
  const { rows: direct } = await query(
    `SELECT id, ats, external_id, url FROM jobs
      WHERE external_id = ANY($1::text[]) AND removed_at IS NULL`,
    [[...want.keys()]]
  );
  for (const d of direct) {
    const dKey = atsPostingKey(d.ats, d.url);
    for (const { row, board } of want.get(d.external_id) || []) {
      if (row.id === d.id || String(row.ats).toLowerCase() !== String(d.ats).toLowerCase()) continue;
      if (!dKey || dKey.board !== board) continue;
      twins.set(row.id, d.id);
    }
  }
  return twins;
}

module.exports = { atsPostingKey, isAtsRow, findFeedTwins, PARSERS };
