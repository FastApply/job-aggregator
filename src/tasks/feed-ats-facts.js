/**
 * Feed rows take their job type and publish date from the posting's own ATS
 * (utils/ats-posting-facts.js explains why). ats_facts_at marks a row read, and syncForCompany
 * keeps those two columns on a row marked so, so a feed re-sync cannot put its values back.
 *
 * Two modes:
 *   - recent (the worker, every few minutes): feed rows first seen in the last `sinceHours`,
 *     newest first, so every feed ingest is corrected within minutes whichever script loaded it
 *     (load/promote Simplify, fetch-wonsulting, fetch/import-liftmycv, fetch-jobloo).
 *   - backfill (scripts/backfill-feed-ats-facts.js): every live feed row, by id cursor.
 *
 * A row the ATS does not answer for keeps the feed's values; it is marked as tried all the same
 * (see the miss below), so the next cycle moves on.
 */
const { query } = require('../db/connection');
const logger = require('../logger');
const { FEEDS, ATS_WITH_FACTS, fetchAtsFacts } = require('../utils/ats-posting-facts');

const DAY_MS = 24 * 60 * 60 * 1000;
/** FastApply's First Apply posting-age window, for the report only. */
const OLD_DAYS = 180;

const feedClause = `(${FEEDS.map(() => "external_id LIKE ? ESCAPE '\\'").join(' OR ')})`;
const feedParams = FEEDS.map((f) => `${f}\\_%`);
const atsClause = `ats IN (${ATS_WITH_FACTS.map(() => '?').join(', ')})`;

/** The SELECT for one batch. Exported for the spec. */
function selectBatch({ sinceHours = null, afterId = null, limit }) {
  const where = ['removed_at IS NULL', 'ats_facts_at IS NULL', atsClause, feedClause];
  const params = [...ATS_WITH_FACTS, ...feedParams];
  let order = 'first_seen_at DESC';
  if (sinceHours != null) {
    where.push('first_seen_at >= ?');
    params.push(new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString());
  }
  if (afterId != null) {
    where.push('id > ?');
    params.push(afterId);
    order = 'id';
  }
  params.push(limit);
  return {
    sql: `SELECT id, external_id, ats, url, employment_type, posted_at FROM jobs WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`,
    params,
  };
}

async function eachLimited(items, concurrency, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) { const item = items[i++]; await fn(item); }
  }));
}

/** What a reading changes on one row: { type, date, nowOld } (booleans), for the report. */
function changesOf(row, facts, now = Date.now()) {
  const was = row.posted_at ? Date.parse(new Date(row.posted_at).toISOString()) : null;
  const is = facts.posted_at ? Date.parse(facts.posted_at) : null;
  return {
    type: !!facts.employment_type && facts.employment_type !== row.employment_type,
    date: is != null && is !== was,
    nowOld: is != null && now - is > OLD_DAYS * DAY_MS && (was == null || now - was <= OLD_DAYS * DAY_MS),
  };
}

/**
 * An Internship label is kept over an ATS type of Full-time or Part-time: those are the hours
 * (Workday's timeType says "Full time" for 6 of the 7 interns the feeds labelled Internship among
 * the rows FastApply applied to), and the label is what an internship search finds.
 */
function keepInternship(row, facts) {
  if (!facts || !/^internship$/i.test(String(row.employment_type || ''))) return facts;
  if (!/^(full|part)-time$/i.test(String(facts.employment_type || ''))) return facts;
  return { ...facts, employment_type: null };
}

/**
 * One batch. Returns { scanned, read, typeChanged, dateChanged, nowOld, lastId, samples }.
 * apply=false reads the ATS but writes nothing.
 */
async function refreshFeedAtsFacts({ apply = true, sinceHours = null, afterId = null, limit = 200, concurrency = 4, fetchImpl, db = { query } } = {}) {
  const { sql, params } = selectBatch({ sinceHours, afterId, limit });
  const { rows } = await db.query(sql, params);
  const stats = { scanned: rows.length, read: 0, missed: 0, typeChanged: 0, dateChanged: 0, nowOld: 0, lastId: rows.length ? Math.max(...rows.map((r) => Number(r.id))) : afterId, samples: [] };
  await eachLimited(rows, concurrency, async (row) => {
    const facts = keepInternship(row, await fetchAtsFacts(row.ats, row.url, { fetchImpl }));
    if (!facts) {
      // Marked as tried even so: the recent mode reads newest first, and a batch of postings
      // that never answer would otherwise be selected again every cycle and starve the rest.
      // The row keeps the feed's values.
      stats.missed++;
      if (apply) await db.query(`UPDATE jobs SET ats_facts_at = datetime('now') WHERE id = ?`, [row.id]);
      return;
    }
    stats.read++;
    const c = changesOf(row, facts);
    if (c.type) stats.typeChanged++;
    if (c.date) stats.dateChanged++;
    if (c.nowOld) stats.nowOld++;
    if ((c.type || c.nowOld) && stats.samples.length < 20) {
      stats.samples.push({ id: row.id, ats: row.ats, url: row.url, type: [row.employment_type, facts.employment_type], posted: [row.posted_at, facts.posted_at] });
    }
    if (!apply) return;
    await db.query(
      `UPDATE jobs SET employment_type = COALESCE(?, employment_type), posted_at = COALESCE(?, posted_at), ats_facts_at = datetime('now') WHERE id = ?`,
      [facts.employment_type, facts.posted_at, row.id]
    );
  });
  if (stats.scanned) logger.info({ ...stats, samples: undefined, apply }, 'Feed ATS facts: batch');
  return stats;
}

module.exports = { refreshFeedAtsFacts, selectBatch, changesOf, keepInternship };
