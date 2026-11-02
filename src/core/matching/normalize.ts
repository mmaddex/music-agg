/**
 * String normalisation for fuzzy matching across services. Different services
 * format the same song differently:
 *   "Everybody Knows This Is Nowhere (2009 Remaster)"  vs  "Everybody Knows This Is Nowhere"
 *   "Hello (feat. X)"  vs  "Hello"   ·   "Polo & Pan"  vs  "Polo and Pan"   ·   "Forró"  vs  "Forro"
 */

/** Bracketed or dash-suffixed qualifiers that do not change which recording it is (for scoring). */
const VERSION_NOISE =
  /\b(remaster(ed)?|\d{4} remaster(ed)?|remaster(ed)? \d{4}|deluxe|bonus track|mono|stereo|single version|album version|radio edit|original mix|explicit|clean|edit)\b/i;

export function foldDiacritics(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}+/gu, '');
}

/** Lowercase, fold accents, unify "&"/"and", drop punctuation, collapse spaces. */
export function basicNormalize(s: string): string {
  return foldDiacritics(s)
    .toLowerCase()
    .replace(/[’'`´]/g, '')
    .replace(/\s*&\s*|\s+\+\s+/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Remove "feat. X" / "ft. X" / "with X" clauses (bracketed or trailing). */
export function stripFeaturing(s: string): string {
  return s
    .replace(/\s*[([]\s*(feat\.?|ft\.?|featuring|with)\s+[^)\]]*[)\]]/gi, '')
    .replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/i, '')
    .trim();
}

/**
 * Title used for scoring: drops featuring clauses and version qualifiers like
 * "(2009 Remaster)" or "- Remastered 2010", but keeps meaningful ones such as
 * "(Live)" or "(Acoustic)" in a separate list so they can still be compared.
 */
export function normalizeTitle(title: string): { core: string; qualifiers: string[] } {
  let t = stripFeaturing(title);
  const qualifiers: string[] = [];
  t = t.replace(/\s*[([]([^)\]]*)[)\]]/g, (_, inner: string) => {
    if (!VERSION_NOISE.test(inner)) qualifiers.push(basicNormalize(inner));
    return ' ';
  });
  // Trailing " - Remastered 2010" / " - Live at …"
  const dash = /\s+[-–—]\s+([^-–—]+)$/.exec(t);
  if (dash) {
    const tail = dash[1]!;
    if (VERSION_NOISE.test(tail)) t = t.slice(0, dash.index);
    else if (/\b(live|acoustic|demo|instrumental|remix|mix|version|session|unplugged)\b/i.test(tail)) {
      qualifiers.push(basicNormalize(tail));
      t = t.slice(0, dash.index);
    }
  }
  return { core: basicNormalize(t), qualifiers: qualifiers.filter(Boolean) };
}

const ARTIST_NOISE = /^(the)\s+/;

export function normalizeArtist(a: string): string {
  return basicNormalize(stripFeaturing(a)).replace(ARTIST_NOISE, '');
}

/**
 * Possible individual artists in a combined credit. YouTube joins artists with
 * ", " — but band names contain commas too ("Crosby, Stills, Nash & Young"), so
 * callers should compare both the whole string and the parts.
 */
export function splitArtists(a: string): string[] {
  return a
    .split(/\s*(?:,|;|\/|\bx\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|&|\band\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Text to send to TIDAL search: no brackets/featuring noise, keep words. */
export function searchText(s: string): string {
  return stripFeaturing(s)
    .replace(/\s*[([][^)\]]*[)\]]/g, ' ')
    .replace(/\s+[-–—]\s+(.*\b(remaster(ed)?|live|version|edit|mix)\b.*)$/i, ' ')
    .replace(/["“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
