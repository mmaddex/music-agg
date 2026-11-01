// String helpers shared by the export adapters and the TIDAL matcher.

/** Lowercase, strip accents and punctuation, collapse whitespace. */
export function normalize(value) {
  if (value == null) return '';
  return String(value)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// Words that mark a bracketed/dashed segment as decoration rather than part of the
// song's real name ("(Official Video)", "- Remastered 2011", "[Lyrics]").
const DECORATION =
  /\b(official|video|audio|lyrics?|lyric video|visuali[sz]er|music video|hd|hq|4k|remaster(ed)?|mono|stereo|explicit|clean|full album|audio only|topic)\b/i;
const FEATURING = /\b(feat|ft|featuring|with)\b\.?/i;

/**
 * Remove decorations from a track title so "Song (Official Video) [HD]" and
 * "Song - Remastered 2009" both compare equal to "Song".
 * Version markers that change the recording (live, remix, acoustic) are kept.
 */
export function stripDecorations(title) {
  if (!title) return '';
  let t = String(title);
  t = t.replace(/[([{]([^)\]}]*)[)\]}]/g, (whole, inner) =>
    DECORATION.test(inner) || FEATURING.test(inner) ? ' ' : whole,
  );
  t = t.replace(/\s[-–—|]\s([^-–—|]*)$/, (whole, tail) => (DECORATION.test(tail) ? '' : whole));
  return t.replace(/\s+/g, ' ').trim();
}

/** Drop a trailing "feat. X" clause from a title or artist string. */
export function stripFeaturing(value) {
  if (!value) return '';
  return String(value)
    .replace(/\s[([]?\s*(feat|ft|featuring)\b\.?.*$/i, '')
    .trim();
}

function bigrams(s) {
  const grams = new Map();
  const padded = ` ${s} `;
  for (let i = 0; i < padded.length - 1; i += 1) {
    const g = padded.slice(i, i + 2);
    grams.set(g, (grams.get(g) || 0) + 1);
  }
  return grams;
}

/** Sørensen–Dice similarity over character bigrams of normalized strings (0..1). */
export function similarity(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const gx = bigrams(x);
  const gy = bigrams(y);
  let overlap = 0;
  let total = 0;
  for (const [g, n] of gx) {
    total += n;
    overlap += Math.min(n, gy.get(g) || 0);
  }
  for (const n of gy.values()) total += n;
  return (2 * overlap) / total;
}

/** Best similarity between any pair from two lists. */
export function bestPairSimilarity(listA, listB) {
  let best = 0;
  for (const a of listA) {
    for (const b of listB) {
      best = Math.max(best, similarity(a, b));
      if (best === 1) return 1;
    }
  }
  return best;
}

/**
 * Split an artist credit string into names. Kept loose on purpose: callers should
 * also compare against the unsplit string because some artist names contain commas
 * or ampersands ("Crosby, Stills, Nash & Young").
 */
export function splitArtists(value) {
  if (!value) return [];
  return String(value)
    .split(/\s*(?:,|;|\s(?:feat|ft|featuring)\.?\s)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Parse an ISO-8601 duration like "PT3M5S" into milliseconds. */
export function isoDurationToMs(value) {
  if (!value) return null;
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value);
  if (!m) return null;
  const [, d = 0, h = 0, min = 0, s = 0] = m;
  return Math.round(((+d * 24 + +h) * 3600 + +min * 60 + +s) * 1000);
}

/** Parse "2019-01-17 00:44:24 UTC" (and other Date-parsable strings) to ISO-8601, or null. */
export function toIsoDate(value) {
  if (!value) return null;
  const cleaned = String(value).trim().replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/, '$1T$2Z');
  const date = new Date(cleaned);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().replace(/\.000Z$/, 'Z');
}
