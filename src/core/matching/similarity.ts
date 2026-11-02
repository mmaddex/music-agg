/** Sørensen–Dice coefficient over character bigrams (0..1). Robust to small typos and word order. */
export function dice(a: string, b: string): number {
  if (a === b) return a.length ? 1 : 0;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      grams.set(g, n - 1);
      overlap++;
    }
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

/** Share of the shorter string's tokens found in the longer one (0..1). */
export function tokenContainment(a: string, b: string): number {
  const ta = new Set(a.split(' ').filter(Boolean));
  const tb = new Set(b.split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  let hit = 0;
  for (const t of small) if (big.has(t)) hit++;
  return hit / small.size;
}

/** Combined fuzzy similarity of two already-normalised strings. */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const d = dice(a, b);
  // Containment helps "hey jude" vs "hey jude remastered 2015", but is discounted
  // so that a short string contained in a long one doesn't score as a perfect match.
  const lenRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
  const c = tokenContainment(a, b) * (0.75 + 0.2 * lenRatio);
  return Math.max(d, c);
}
