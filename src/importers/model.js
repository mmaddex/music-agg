// The format-neutral shape every export adapter produces. Everything downstream
// (enrichment, TIDAL matching, the UI) only ever sees these objects, so adding a new
// source format means writing one adapter and nothing else.
//
// Library {
//   format:      adapter id, e.g. "youtube-music"
//   formatLabel: human name, e.g. "YouTube Music (Google Takeout)"
//   collections: Collection[]
//   warnings:    string[]
// }
//
// Collection {
//   id:          stable id within this library
//   kind:        "playlist" (becomes a TIDAL playlist) | "favorites" (TIDAL My Collection tracks)
//   name, description
//   createdAt:   ISO date or null
//   suggested:   whether the UI should pre-select it (false for e.g. "Watch later")
//   tracks:      Track[]
// }
//
// Track {
//   key:        stable dedupe key (same song in two playlists → same key → matched once)
//   title, artists[], artistCredit (raw string), album, isrc, durationMs
//   addedAt:    ISO date or null
//   source:     { type, id, url }   e.g. { type: "youtube", id: "P8I1S7yORPI" }
//   needsLookup: true when we only have a source id and must fetch title/artist
//                (an enricher fills these in before matching)
// }

import { normalize, splitArtists } from '../util/text.js';

export function makeTrack({
  title = null,
  artists = null,
  artistCredit = null,
  album = null,
  isrc = null,
  durationMs = null,
  addedAt = null,
  source = null,
}) {
  const credit = artistCredit ?? (Array.isArray(artists) ? artists.join(', ') : null);
  const artistList = Array.isArray(artists) ? artists.filter(Boolean) : splitArtists(credit);
  const track = {
    key: '',
    title: title ? String(title).trim() : null,
    artists: artistList,
    artistCredit: credit ? String(credit).trim() : null,
    album: album ? String(album).trim() : null,
    isrc: isrc ? String(isrc).trim().toUpperCase().replace(/-/g, '') : null,
    durationMs: Number.isFinite(durationMs) ? durationMs : null,
    addedAt,
    source,
    needsLookup: !title,
  };
  track.key = trackKey(track);
  return track;
}

export function trackKey(track) {
  if (track.source?.type && track.source?.id) return `${track.source.type}:${track.source.id}`;
  if (track.isrc) return `isrc:${track.isrc}`;
  return `meta:${normalize(track.title)}|${normalize(track.artistCredit)}|${normalize(track.album)}`;
}

export function makeCollection({ id, kind = 'playlist', name, description = null, createdAt = null, suggested = true, tracks = [] }) {
  return { id, kind, name: name || 'Untitled', description, createdAt, suggested, tracks };
}

/** Summary sent to the browser after upload: no track bodies, just counts. */
export function summarizeLibrary(library) {
  return {
    format: library.format,
    formatLabel: library.formatLabel,
    warnings: library.warnings,
    collections: library.collections.map((c) => ({
      id: c.id,
      kind: c.kind,
      name: c.name,
      description: c.description,
      suggested: c.suggested,
      trackCount: c.tracks.length,
      needsLookupCount: c.tracks.filter((t) => t.needsLookup).length,
    })),
  };
}
