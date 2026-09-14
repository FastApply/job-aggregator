/**
 * One normaliser for every place-name comparison, at index time and at query time.
 *
 * Folds diacritics so "München", "Muenchen"-style ASCII and "munchen" meet in the middle, and
 * maps the handful of letters NFKD does not decompose (ß ø æ œ ł đ ð þ ı). Lowercases and
 * collapses whitespace. Punctuation is left alone — callers that tokenise strip it themselves.
 *
 * WHY. location-countries.js used to lowercase only, and then scrub `[^a-z0-9' ]`. That deleted
 * every accented letter, so "München" was indexed as "m nchen" and "nchen", "España" carried no
 * country code, and a query for any accented place returned zero. Measured on the live board
 * 2026-09-14: Düsseldorf 0 / Dusseldorf 8, São Paulo 0 / Sao Paulo 241, Montréal 0 / Montreal
 * 988 — every accented entry in the FastApply dashboard's own location catalog was a dead end.
 */
const FOLD = {
  ß: 'ss', ø: 'o', Ø: 'o', æ: 'ae', Æ: 'ae', œ: 'oe', Œ: 'oe',
  ł: 'l', Ł: 'l', đ: 'd', Đ: 'd', ð: 'd', Ð: 'd', þ: 'th', Þ: 'th', ı: 'i',
};
const FOLD_RE = /[ßøØæÆœŒłŁđĐðÐþÞı]/g;

function norm(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(FOLD_RE, (c) => FOLD[c])
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

module.exports = { norm };
