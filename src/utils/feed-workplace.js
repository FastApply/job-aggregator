'use strict';
/**
 * A third-party feed's "remote", checked against the posting's own words.
 *
 * Feeds state a work setting of their own, and Wonsulting's says "remote" for postings their
 * employer lists on-site: Micron's "Program Manager, SIG" (Workday: on-site, San Jose), Creation
 * Technologies' Everett "Program Manager 2" and the University of Mississippi's "Program Manager-
 * Grove Scholars" came in as workplace_type "remote" while the board's own reader left is_remote
 * false, and FastApply's backend read the work-mode field and sent all three to a candidate in
 * Houston who will not relocate (pref-match, 2026-11-24). On a 2026-11-24 sample of live rows with
 * that split, 307 of 331 Wonsulting rows had text the reader does not call remote.
 *
 * So a feed's "remote" is kept only when the posting's title, location or text says remote too
 * (classifyRemote, read without the feed's word). Otherwise the work mode is unknown (null), which
 * is what the posting states; with no text to read (under MIN_TEXT characters) it is unknown too.
 * Either way workplace_type and is_remote agree. Hybrid and on-site are left as the feed says.
 */
const { classifyRemote, classifyRemoteWorldwide } = require('./classify');
const { stripHtml } = require('./html');

const MIN_TEXT = 200;

/** The feed's work setting folded to remote / hybrid / onsite, or null. */
function feedWorkplace(value) {
  const w = String(value || '').toLowerCase();
  if (/remote/.test(w)) return 'remote';
  if (/hybrid/.test(w)) return 'hybrid';
  if (/site|onsite|in[\s-]?person|office/.test(w)) return 'onsite';
  return null;
}

/**
 * The tags a row the feed calls remote gets: { workplace_type, is_remote, remote_worldwide }.
 * Pure; reads title, location and description.
 */
function feedRemoteTags(row) {
  const text = stripHtml(row.description || '');
  const confirmed =
    text.trim().length >= MIN_TEXT && classifyRemote(row.title, row.location, '', text);
  if (!confirmed) return { workplace_type: null, is_remote: false, remote_worldwide: false };
  return {
    workplace_type: 'remote',
    is_remote: true,
    remote_worldwide: classifyRemoteWorldwide(row.title, row.location, text, true),
  };
}

/** A feed row's work mode: the feed's own, with its "remote" checked against the text. */
function checkedFeedWorkplace(value, row) {
  const w = feedWorkplace(value);
  return w === 'remote' ? feedRemoteTags(row).workplace_type : w;
}

module.exports = { feedWorkplace, feedRemoteTags, checkedFeedWorkplace, MIN_TEXT };
