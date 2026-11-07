// Finds the TIDAL track that best corresponds to a source Track.
//
// Strategy:
//   1. ISRC present → exact lookup (GET /tracks?filter[isrc]=...). Definitive.
//   2. Otherwise search "<title> <primary artist>", then fall back to looser queries.
//   3. Score every candidate on title / artist / album / duration / version markers.
//
// Outcome per track:
//   matched   — confident; imported by default
//   review    — plausible; user decides in the UI
//   not_found — nothing good enough (or no metadata to search with)

import { findTracksByIsrc, searchTracks } from './catalog.js';
import { bestPairSimilarity, normalize, similarity, stripDecorations, stripFeaturing } from '../util/text.js';

export const THRESHOLDS = {
  matched: 0.82,
  matchedFromVideoTitle: 0.88, // titles guessed from YouTube video names are noisier
  review: 0.6,
};

const VERSION_WORDS = ['live', 'remix', 'acoustic', 'instrumental', 'karaoke', 'demo', 'cover', 'tribute', 'cappella', 'slowed', 'sped up', 'reverb', '8d'];

function versionWords(text) {
  const n = ` ${normalize(text)} `;
  return new Set(VERSION_WORDS.filter((w) => n.includes(` ${w} `)));
}

export function scoreCandidate(track, cand) {
  const srcTitle = track.title || '';
  const srcTitles = [srcTitle, stripDecorations(srcTitle), stripFeaturing(stripDecorations(srcTitle))].filter(Boolean);
  const candTitles = [cand.title, stripFeaturing(cand.title), cand.version ? `${cand.title} (${cand.version})` : null].filter(Boolean);
  let titleScore = bestPairSimilarity(srcTitles, candTitles);

  const srcArtists = [...track.artists, track.artistCredit].filter(Boolean);
  const candArtists = cand.artists.length ? [...cand.artists, cand.artists.join(', ')] : [];
  let artistScore = srcArtists.length && candArtists.length ? bestPairSimilarity(srcArtists, candArtists) : null;

  // YouTube video titles often embed the artist ("Artist - Song") or the channel isn't the
  // artist at all; compare the whole video title against "<artist> <title>" too.
  if (track.fromVideoTitle && track.videoTitle && cand.artists.length) {
    const combined = similarity(stripDecorations(track.videoTitle), `${cand.artists[0]} ${cand.title}`);
    if (combined > (titleScore + (artistScore ?? titleScore)) / 2) {
      titleScore = Math.max(titleScore, combined);
      artistScore = Math.max(artistScore ?? 0, combined);
    }
  }

  let score = artistScore == null ? titleScore * 0.85 : titleScore * 0.6 + artistScore * 0.4;

  if (track.album && cand.albums.length && bestPairSimilarity([track.album], cand.albums) >= 0.85) score += 0.05;

  if (track.durationMs && cand.durationMs) {
    const diff = Math.abs(track.durationMs - cand.durationMs);
    if (diff <= 3000) score += 0.03;
    else if (diff > 30_000) score -= 0.15;
  }

  // Penalise live/remix/karaoke versions the source didn't ask for (and vice versa).
  const srcVersions = versionWords(`${track.videoTitle || srcTitle} ${track.album || ''}`);
  const candVersions = versionWords(`${cand.title} ${cand.version || ''} ${cand.albums.join(' ')}`);
  for (const w of candVersions) if (!srcVersions.has(w)) score -= 0.15;
  for (const w of srcVersions) if (!candVersions.has(w) && w !== 'live') score -= 0.1;

  return Math.max(0, Math.min(1, Number(score.toFixed(3))));
}

function buildQueries(track) {
  const title = stripFeaturing(stripDecorations(track.title));
  const artist = stripFeaturing(track.artists[0] || track.artistCredit || '');
  const queries = [];
  if (artist) queries.push(`${title} ${artist}`);
  queries.push(title);
  if (track.fromVideoTitle && track.videoTitle) queries.push(stripDecorations(track.videoTitle));
  return [...new Set(queries.map((q) => q.trim()).filter(Boolean))];
}

const summarize = (cand, score) => ({
  id: cand.id,
  title: cand.title,
  version: cand.version,
  artists: cand.artists,
  album: cand.albums[0] || null,
  albumId: cand.albumId ?? null,
  durationMs: cand.durationMs,
  score,
});

/**
 * @param {import('./client.js').TidalClient} client
 * @param {object} track  a model Track
 * @param {object} opts   { countryCode, cache?: Map }
 */
export async function matchTrack(client, track, { countryCode, cache } = {}) {
  if (track.isrc) {
    const hits = await findTracksByIsrc(client, track.isrc, { countryCode });
    if (hits.length) {
      return { status: 'matched', method: 'isrc', best: summarize(hits[0], 1), alternatives: [] };
    }
  }

  if (!track.title) {
    return { status: 'not_found', reason: track.lookupError || 'No title or artist available to search with', best: null, alternatives: [] };
  }

  const matchedAt = track.fromVideoTitle ? THRESHOLDS.matchedFromVideoTitle : THRESHOLDS.matched;
  const scored = new Map();

  for (const query of buildQueries(track)) {
    const cacheKey = `${countryCode}|${query}`;
    let candidates = cache?.get(cacheKey);
    if (!candidates) {
      candidates = await searchTracks(client, query, { countryCode });
      cache?.set(cacheKey, candidates);
    }
    candidates.forEach((cand, rank) => {
      // Slight preference for TIDAL's own ranking when scores tie.
      const s = scoreCandidate(track, cand) - rank * 0.002;
      if (!scored.has(cand.id) || scored.get(cand.id).score < s) scored.set(cand.id, summarize(cand, Number(s.toFixed(3))));
    });
    const top = Math.max(0, ...[...scored.values()].map((c) => c.score));
    if (top >= matchedAt) break;
  }

  const ranked = [...scored.values()].sort((a, b) => b.score - a.score);
  const best = ranked[0] || null;
  const alternatives = ranked.slice(1, 4);
  if (!best || best.score < THRESHOLDS.review) {
    return { status: 'not_found', reason: best ? 'No close match on TIDAL' : 'No results on TIDAL', best, alternatives };
  }
  return { status: best.score >= matchedAt ? 'matched' : 'review', method: 'search', best, alternatives };
}
