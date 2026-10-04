// Decode HTML entities in text scraped from careers pages. Varbi writes Swedish letters as named
// entities ("&Ouml;rnsk&ouml;ldsvik"), which stored raw broke 1,256 job locations and the town a
// Sweden search tokenises on (2026-10-04).
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  aring: 'å', Aring: 'Å', auml: 'ä', Auml: 'Ä', ouml: 'ö', Ouml: 'Ö', uuml: 'ü', Uuml: 'Ü',
  aelig: 'æ', AElig: 'Æ', oslash: 'ø', Oslash: 'Ø', eacute: 'é', Eacute: 'É', egrave: 'è', Egrave: 'È',
  aacute: 'á', Aacute: 'Á', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', ccedil: 'ç', szlig: 'ß',
  ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', euro: '€',
};
function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, n) => (n in NAMED ? NAMED[n] : m));
}
module.exports = { decodeEntities };
