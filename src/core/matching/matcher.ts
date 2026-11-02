import type { SourceTrack } from '../model.js';
import type { TidalTrack } from '../tidal/client.js';
import { normalizeArtist, normalizeTitle, searchText, splitArtists, basicNormalize } from './normalize.js';
import { similarity } from './similarity.js';

/** What the matcher needs from TIDAL. `TidalClient` implements it; tests use a fake. */
export interface CatalogSearch {
  searchTracks(query: string, limit?: number, signal?: AbortSignal): Promise<TidalTrack[]>;
  getTracksByIsrc(isrcs: string[], signal?: AbortSignal): Promise<TidalTrack[]>;
}

export type MatchStatus = 'matched' | 'review' | 'unmatched';

export interface ScoredCandidate {
  track: TidalTrack;
  score: number;
  titleScore: number;
  artistScore?: number;
}

export interface MatchResult {
  status: MatchStatus;
  best?: ScoredCandidate;
  /** Next-best candidates (for the review UI). */
  alternatives: ScoredCandidate[];
  /** Why there is no confident match. */
  reason?: string;
}

export const THRESHOLDS = {
  /** Auto-accept at or above this score… */
  matched: 0.85,
  /** …offer for review at or above this one. */
  review: 0.6,
};

const SPECIAL_VERSIONS = ['live', 'acoustic', 'remix', 'instrumental', 'demo', 'karaoke', 'unplugged', 'cover'];
const IMPOSTOR = /\b(karaoke|tribute|made famous by|originally performed|in the style of|cover version|8 ?bit|lullaby renditions?)\b/i;

function specialTags(parts: string[]): Set<string> {
  const tags = new Set<string>();
  for (const p of parts) for (const v of SPECIAL_VERSIONS) if (p.includes(v)) tags.add(v);
  return tags;
}

/** Best similarity between the source credit and the candidate's artists. */
export function artistSimilarity(sourceArtists: string[], candidateArtists: string[]): number {
  if (!sourceArtists.length || !candidateArtists.length) return 0;
  const srcWhole = normalizeArtist(sourceArtists.join(', '));
  const candWhole = normalizeArtist(candidateArtists.join(', '));
  let best = similarity(srcWhole, candWhole);
  const srcParts = sourceArtists.flatMap((a) => [a, ...splitArtists(a)]).map(normalizeArtist).filter(Boolean);
  const candParts = candidateArtists.map(normalizeArtist).filter(Boolean);
  for (const s of srcParts) {
    for (const c of candParts) {
      // Split fragments ("Belle" from "Belle and Sebastian") are slightly less trustworthy.
      const weight = sourceArtists.some((a) => normalizeArtist(a) === s) ? 1 : 0.92;
      best = Math.max(best, similarity(s, c) * weight);
      if (best >= 1) return 1;
    }
  }
  return best;
}

export function scoreCandidate(source: SourceTrack, cand: TidalTrack): ScoredCandidate {
  if (source.isrc && cand.isrc && source.isrc.toUpperCase() === cand.isrc.toUpperCase()) {
    return { track: cand, score: 1, titleScore: 1, artistScore: 1 };
  }
  const src = normalizeTitle(source.title ?? '');
  const candTitle = normalizeTitle(cand.version ? `${cand.title} (${cand.version})` : cand.title);
  let titleScore = similarity(src.core, candTitle.core);

  const weakArtist = source.hints?.weakArtist === '1';
  const hasArtist = source.artists.length > 0;
  let artistScore = hasArtist ? artistSimilarity(source.artists, cand.artists) : undefined;

  // When the "artist" was guessed from an uploader's channel name it's often wrong
  // (e.g. a fan channel), so it can confirm a match but shouldn't veto one.
  const wTitle = 0.6;
  const wArtist = !hasArtist ? 0 : weakArtist ? 0.15 : 0.4;
  const effArtist = artistScore === undefined ? 0 : weakArtist ? Math.max(artistScore, 0.6) : artistScore;
  let score = (wTitle * titleScore + wArtist * effArtist) / (wTitle + wArtist);

  // Version mismatches: "Song (Live)" should not silently become the studio version, and vice versa.
  const srcTags = specialTags([...src.qualifiers, src.core]);
  const candTags = specialTags([...candTitle.qualifiers, candTitle.core]);
  const tagDiff = [...srcTags].filter((t) => !candTags.has(t)).length + [...candTags].filter((t) => !srcTags.has(t)).length;
  if (tagDiff) {
    score *= 0.88;
    titleScore *= 0.9;
  }

  // Karaoke/tribute versions that would otherwise look like perfect matches.
  const candText = `${cand.title} ${cand.version ?? ''} ${cand.artists.join(' ')} ${cand.album ?? ''}`;
  const srcText = `${source.title ?? ''} ${source.artists.join(' ')}`;
  if (IMPOSTOR.test(candText) && !IMPOSTOR.test(srcText)) score *= 0.5;

  if (source.album && cand.album) {
    const albumScore = similarity(normalizeTitle(source.album).core, normalizeTitle(cand.album).core);
    if (albumScore > 0.8) score += 0.04;
  }

  if (source.durationMs && cand.durationMs) {
    const diff = Math.abs(source.durationMs - cand.durationMs) / 1000;
    if (diff <= 3) score += 0.03;
    else if (diff > 45) score *= 0.85;
  }

  if (artistScore !== undefined) artistScore = Math.round(artistScore * 1000) / 1000;
  return {
    track: cand,
    score: Math.round(Math.min(1, score) * 1000) / 1000,
    titleScore: Math.round(titleScore * 1000) / 1000,
    artistScore,
  };
}

export function classify(source: SourceTrack, best: ScoredCandidate | undefined): MatchStatus {
  if (!best) return 'unmatched';
  const strongArtist = source.artists.length > 0 && source.hints?.weakArtist !== '1';
  if (
    best.score >= THRESHOLDS.matched &&
    best.titleScore >= 0.75 &&
    (!strongArtist || (best.artistScore ?? 0) >= 0.7) &&
    // Guessed metadata (from a video title) is always worth a glance unless it's near-perfect.
    (source.quality === 'export' || best.score >= 0.93)
  ) {
    return 'matched';
  }
  return best.score >= THRESHOLDS.review ? 'review' : 'unmatched';
}

/**
 * Should a result be ticked by default in the review UI? Confident matches yes;
 * "review" results only when the title itself is a close match — a perfect
 * artist match must not drag a different song ("Sweetheart" vs "Sweethearts
 * on Parade") over the line.
 */
export function shouldPreselect(result: Pick<MatchResult, 'status' | 'best'>): boolean {
  if (!result.best) return false;
  if (result.status === 'matched') return true;
  return result.status === 'review' && result.best.score >= 0.8 && result.best.titleScore >= 0.85;
}

/** Search queries to try, most specific first. */
export function buildQueries(source: SourceTrack): string[] {
  const title = searchText(source.title ?? '');
  if (!title) return [];
  const artist = source.artists[0] ? searchText(source.artists[0]).replace(/,/g, ' ') : '';
  const firstArtist = source.artists[0] ? splitArtists(source.artists[0])[0] ?? '' : '';
  const qs = [
    artist && `${artist} ${title}`,
    firstArtist && firstArtist !== artist && `${firstArtist} ${title}`,
    (!artist || source.hints?.weakArtist === '1') && title,
    source.album && !artist && `${title} ${searchText(source.album)}`,
  ];
  return [...new Set(qs.filter((q): q is string => Boolean(q)).map((q) => q.replace(/\s+/g, ' ').trim()))];
}

function cacheKey(t: SourceTrack): string {
  return [t.isrc ?? '', basicNormalize(t.title ?? ''), basicNormalize(t.artists.join(',')), basicNormalize(t.album ?? ''), t.hints?.weakArtist ?? ''].join('|');
}

export class Matcher {
  private readonly cache = new Map<string, Promise<MatchResult>>();

  constructor(
    private readonly catalog: CatalogSearch,
    private readonly opts: { candidatesPerQuery?: number } = {},
  ) {}

  match(source: SourceTrack, signal?: AbortSignal): Promise<MatchResult> {
    if (source.quality === 'missing' || !source.title) {
      return Promise.resolve({
        status: 'unmatched',
        alternatives: [],
        reason: source.hints?.unavailable ?? 'No song title in the export',
      });
    }
    const key = cacheKey(source);
    let p = this.cache.get(key);
    if (!p) {
      p = this.doMatch(source, signal);
      this.cache.set(key, p);
      p.catch(() => this.cache.delete(key));
    }
    return p;
  }

  private async doMatch(source: SourceTrack, signal?: AbortSignal): Promise<MatchResult> {
    const seen = new Map<string, ScoredCandidate>();
    const consider = (tracks: TidalTrack[]) => {
      for (const t of tracks) if (!seen.has(t.id)) seen.set(t.id, scoreCandidate(source, t));
    };
    const best = () => [...seen.values()].sort((a, b) => b.score - a.score)[0];

    if (source.isrc) {
      consider(await this.catalog.getTracksByIsrc([source.isrc], signal));
      const b = best();
      if (b && b.score >= 1) return { status: 'matched', best: b, alternatives: [] };
    }

    for (const q of buildQueries(source)) {
      consider(await this.catalog.searchTracks(q, this.opts.candidatesPerQuery ?? 8, signal));
      const b = best();
      if (b && classify(source, b) === 'matched') break;
    }

    const ranked = [...seen.values()].sort((a, b) => b.score - a.score);
    const top = ranked[0];
    const status = classify(source, top);
    return {
      status,
      best: top,
      alternatives: ranked.slice(1, 4),
      reason: !top ? 'Not found on TIDAL' : status === 'unmatched' ? 'No close match on TIDAL' : undefined,
    };
  }
}
