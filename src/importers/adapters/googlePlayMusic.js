// Google Play Music, from Google Takeout (the service closed in 2020; old Takeouts remain).
//
// Layout handled (one CSV per track; uploaded MP3s sit alongside and are never read):
//   …/Google Play Music/
//     Tracks/<Title>.csv                     the library: one track per file
//         Title,Album,Artist,Duration (ms),Rating,Play Count,Removed
//     Playlists/<Name>/Metadata.csv          Title,Owner,Description,Shared,Deleted
//     Playlists/<Name>/Tracks/<Title>.csv    Title,Album,Artist,Duration (ms),Rating,Play Count,Removed,Playlist Index
//     Playlists/Thumbs Up/<Title>.csv        auto playlist: track files directly in the folder, no metadata
//     Radio Stations/…                       ignored
//
// Values are HTML-escaped ("I&#39;m"), so they are decoded. "Removed: Yes" marks a track that
// was deleted from the library or playlist; those are skipped. Rating 5 is thumbs up, 1 is
// thumbs down (thumbs-down songs aren't added to favourites). There are no ids or ISRCs, so
// tracks are keyed and matched by title / artist / album.
//
// Library tracks → favourites (complete albums are saved whole downstream); every playlist,
// including Thumbs Up → a TIDAL playlist. The same export uploaded twice is de-duplicated.

import path from 'node:path';
import { makeCollection, makeTrack } from '../model.js';
import { parseCsv, firstLine } from '../csv.js';
import { fileHead } from '../bundle.js';
import { decodeHtmlEntities } from '../../util/text.js';

// Path relative to the "Google Play Music/" folder, wherever that sits in the upload.
const ROOT = /(?:^|\/)Google Play Music\/(.+)$/i;
const TRACK_HEADER = /^"?title"?,"?album"?,"?artist"?,"?duration \(ms\)"?/i;
const METADATA_HEADER = /^"?title"?,"?owner"?,/i;
const THUMBS_DOWN = '1';

const isYes = (v) => /^(yes|true)$/i.test(String(v ?? '').trim());
const clean = (v) => decodeHtmlEntities(String(v ?? '').trim()) || null;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Classify a bundle file: { kind: 'library'|'playlist-track'|'playlist-meta', rel, playlist? } or null. */
function classify(file) {
  if (!/\.csv$/i.test(file.path)) return null;
  const m = ROOT.exec(file.path);
  if (!m) return null;
  const rel = m[1];
  const parts = rel.split('/');
  const head = () => firstLine(fileHead(file));
  if (parts[0].toLowerCase() === 'tracks' && parts.length === 2) {
    return TRACK_HEADER.test(head()) ? { kind: 'library', rel } : null;
  }
  if (parts[0].toLowerCase() === 'playlists' && parts.length >= 3) {
    const playlist = parts[1];
    if (parts.length === 3 && /^metadata\.csv$/i.test(parts[2])) {
      return METADATA_HEADER.test(head()) ? { kind: 'playlist-meta', rel, playlist } : null;
    }
    const inTracks = parts.length === 4 && parts[2].toLowerCase() === 'tracks';
    if ((parts.length === 3 || inTracks) && TRACK_HEADER.test(head())) return { kind: 'playlist-track', rel, playlist };
  }
  return null;
}

function trackFrom(row) {
  const duration = Number(row['Duration (ms)']);
  return makeTrack({
    title: clean(row.Title),
    artistCredit: clean(row.Artist),
    album: clean(row.Album),
    durationMs: Number.isFinite(duration) && duration > 0 ? duration : null,
  });
}

function rowsOf(file, warnings) {
  try {
    return parseCsv(file.text);
  } catch (err) {
    warnings.push(`Skipped ${path.posix.basename(file.path)}: ${err.message}`);
    return [];
  }
}

export const googlePlayMusic = {
  id: 'google-play-music',
  label: 'Google Play Music (Google Takeout)',
  description: 'Takeout zip containing a "Google Play Music" folder with Tracks and Playlists. Uploaded MP3s in it are ignored.',

  detect(bundle) {
    const kinds = new Set();
    for (const file of bundle.files) {
      const c = classify(file);
      if (c) kinds.add(c.kind);
      if (kinds.has('library') && kinds.has('playlist-track')) break;
    }
    if (kinds.has('library') && kinds.has('playlist-track')) return 0.99;
    return kinds.size ? 0.9 : 0;
  },

  parse(bundle) {
    const warnings = [];
    // Relative path → file. Uploading the same export twice yields identical relative paths.
    const seen = new Set();
    const library = [];
    const playlists = new Map(); // folder name → { meta, tracks: [{ rel, row }] }
    const playlistFor = (name) => {
      if (!playlists.has(name)) playlists.set(name, { meta: null, tracks: [] });
      return playlists.get(name);
    };

    const classified = bundle.files
      .map((file) => ({ file, c: classify(file) }))
      .filter(({ c }) => c)
      .sort((a, b) => a.c.rel.localeCompare(b.c.rel));
    for (const { file, c } of classified) {
      if (seen.has(c.rel)) continue;
      seen.add(c.rel);
      const rows = rowsOf(file, warnings);
      if (c.kind === 'library') library.push(...rows);
      else if (c.kind === 'playlist-meta') playlistFor(c.playlist).meta = rows[0] || null;
      else playlistFor(c.playlist).tracks.push(...rows.map((row) => ({ rel: c.rel, row })));
    }

    const collections = [];

    // Library → favourites. Same song twice (duplicate uploads in GPM) → added once.
    let thumbsDown = 0;
    const favourites = new Map();
    for (const row of library) {
      if (isYes(row.Removed) || !clean(row.Title)) continue;
      if (String(row.Rating ?? '').trim() === THUMBS_DOWN) {
        thumbsDown += 1;
        continue;
      }
      const track = trackFrom(row);
      if (!favourites.has(track.key)) favourites.set(track.key, track);
    }
    if (favourites.size) {
      collections.push(
        makeCollection({
          id: 'library-songs',
          kind: 'favorites',
          name: 'Library songs',
          description: 'Songs in your Google Play Music library → added to your TIDAL collection (My Collection › Tracks).',
          tracks: [...favourites.values()],
        }),
      );
    }
    if (thumbsDown) warnings.push(`${plural(thumbsDown, 'thumbs-down song was', 'thumbs-down songs were')} left out of your favourites.`);

    // Playlists, in Playlist Index order.
    let removed = 0;
    const deleted = [];
    const empty = [];
    const names = [...playlists.keys()].sort((a, b) => a.localeCompare(b));
    for (const [index, folder] of names.entries()) {
      const { meta, tracks } = playlists.get(folder);
      const name = clean(meta?.Title) || folder.trim() || 'Untitled playlist';
      if (isYes(meta?.Deleted)) {
        deleted.push(name);
        continue;
      }
      const live = tracks.filter(({ row }) => {
        if (isYes(row.Removed)) {
          removed += 1;
          return false;
        }
        return clean(row.Title);
      });
      const position = (r) => {
        const n = Number.parseInt(r.row['Playlist Index'], 10);
        return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
      };
      live.sort((a, b) => position(a) - position(b) || a.rel.localeCompare(b.rel));
      if (!live.length) {
        empty.push(name);
        continue;
      }
      collections.push(
        makeCollection({
          id: `playlist-${index}`,
          kind: 'playlist',
          name,
          description: clean(meta?.Description),
          tracks: live.map(({ row }) => trackFrom(row)),
        }),
      );
    }
    if (removed) warnings.push(`Skipped ${plural(removed, 'playlist entry', 'playlist entries')} marked as removed.`);
    if (deleted.length) warnings.push(`Skipped deleted playlists: ${deleted.map((n) => `"${n}"`).join(', ')}.`);
    if (empty.length) warnings.push(`Skipped empty playlists: ${empty.map((n) => `"${n}"`).join(', ')}.`);

    if (!collections.length) warnings.push('No Google Play Music library songs or playlists were found in this export.');
    return { collections, warnings };
  },
};
