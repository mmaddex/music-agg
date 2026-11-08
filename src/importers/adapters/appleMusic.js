// Apple Music, from Apple's privacy export (privacy.apple.com → "Apple Media Services
// Information"). The export arrives as one or more "Apple Media Services Information Part N of
// M.zip" files; the bundle loader opens all of them and their nested zips:
//
//   Apple Media Services Information Part 1 of 2/Apple_Media_Services.zip/
//     Apple_Media_Services/Apple Music Activity/
//       Apple Music Library Tracks.json.zip/Apple Music Library Tracks.json
//       Apple Music Library Playlists.json.zip/Apple Music Library Playlists.json
//       … play history, albums, artists, and plenty of non-music data (ignored)
//
// Apple Music Library Tracks.json — JSON array, one object per library track:
//   "Track Identifier" (library id; playlists refer to tracks by it), "Title", "Artist",
//   "Album", "Track Duration" (ms), "Date Added To Library", "Content Type" (Song | Music Video),
//   "Playlist Only Track" (added via a playlist, hidden from the library), "Track Like Rating"
//   (liked | disliked | none), and catalog ids: "Apple Music Track Identifier", "Purchased Track
//   Identifier", "Audio Matched Track Identifier", "Tag Matched Track Identifier". No ISRCs.
//
// Apple Music Library Playlists.json — JSON array, one object per container:
//   "Container Type" (Playlist | Favorites Playlist | Subscribed Playlist | folders…),
//   "Container Identifier", "Title", "Description", "Playlist Item Identifiers" (ordered
//   library track ids), "Added Date". Subscribed playlists list no tracks.
//
// Key spelling drifts from Apple's file guides ("Favorite Status-Track" vs "Favorite Status -
// Track"), so keys are compared case-, space- and punctuation-insensitively.
//
// Library songs → favourites (complete albums among them are saved whole downstream); every
// playlist with tracks → a TIDAL playlist. Play history, the Albums/Artists files (no track
// links) and favourited artists are not imported.

import path from 'node:path';
import { makeCollection, makeTrack } from '../model.js';
import { toIsoDate } from '../../util/text.js';

const TRACKS_FILE = 'apple music library tracks.json';
const PLAYLISTS_FILE = 'apple music library playlists.json';
const CATALOG_ID_KEYS = ['applemusictrackidentifier', 'purchasedtrackidentifier', 'audiomatchedtrackidentifier', 'tagmatchedtrackidentifier'];
// Containers that never hold an importable track list.
const SKIPPED_CONTAINER = /folder|library|subscribed/i;

const canon = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const baseName = (file) => path.posix.basename(file.path).toLowerCase();
const isTracksFile = (file) => baseName(file) === TRACKS_FILE;
const isPlaylistsFile = (file) => baseName(file) === PLAYLISTS_FILE;

/** Re-key a record by canonical key names: { "Track Identifier": 1 } → { trackidentifier: 1 }. */
function canonRecord(record) {
  const out = {};
  for (const [k, v] of Object.entries(record || {})) out[canon(k)] = v;
  return out;
}

function readJsonArray(file, warnings) {
  try {
    const data = JSON.parse(file.text.replace(/^﻿/, ''));
    if (Array.isArray(data)) return data.map(canonRecord);
    warnings.push(`Skipped ${path.posix.basename(file.path)}: expected a list of records.`);
  } catch (err) {
    warnings.push(`Skipped ${path.posix.basename(file.path)}: ${err.message}`);
  }
  return [];
}

const idString = (v) => (v === null || v === undefined || v === '' || v === 0 ? null : String(v).trim() || null);
const text = (v) => (typeof v === 'string' ? v.trim() || null : null);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function toTrack(r) {
  const catalogId = CATALOG_ID_KEYS.map((k) => idString(r[k])).find(Boolean);
  const source = catalogId
    ? { type: 'apple-music', id: catalogId, url: `https://music.apple.com/song/${catalogId}` }
    : { type: 'apple-library', id: idString(r.trackidentifier), url: null };
  const duration = Number(r.trackduration);
  return makeTrack({
    title: text(r.title),
    artistCredit: text(r.artist) || text(r.albumartist),
    album: text(r.album),
    durationMs: Number.isFinite(duration) && duration > 0 ? duration : null,
    addedAt: toIsoDate(r.dateaddedtolibrary || r.dateaddedtoicloudmusiclibrary),
    source,
  });
}

export const appleMusic = {
  id: 'apple-music',
  label: 'Apple Music (Apple privacy export)',
  description:
    'One or more "Apple Media Services Information" zips from privacy.apple.com. Library songs and playlists are imported; everything else in the export is ignored.',

  detect(bundle) {
    if (bundle.files.some(isTracksFile)) return 0.99;
    if (bundle.files.some(isPlaylistsFile)) return 0.9;
    return 0;
  },

  parse(bundle) {
    const warnings = [];

    // Library tracks, by library id. The same part may be uploaded twice; first copy wins.
    const byId = new Map(); // Track Identifier → { track, inLibrary }
    const skippedIds = new Set(); // non-songs (music videos etc.)
    const skippedTypes = new Map();
    let untitled = 0;
    for (const file of bundle.files.filter(isTracksFile)) {
      for (const r of readJsonArray(file, warnings)) {
        const libraryId = idString(r.trackidentifier);
        if (!libraryId || byId.has(libraryId) || skippedIds.has(libraryId)) continue;
        const type = text(r.contenttype);
        if (type && !/^song$/i.test(type)) {
          skippedIds.add(libraryId);
          skippedTypes.set(type, (skippedTypes.get(type) || 0) + 1);
          continue;
        }
        if (!text(r.title)) {
          untitled += 1;
          skippedIds.add(libraryId);
          continue;
        }
        const disliked = /^disliked$/i.test(text(r.tracklikerating) || '');
        byId.set(libraryId, { track: toTrack(r), inLibrary: r.playlistonlytrack !== true && !disliked });
      }
    }
    for (const [type, n] of skippedTypes) warnings.push(`${plural(n, `${type.toLowerCase()} was`, `${type.toLowerCase()}s were`)} skipped (only songs are imported).`);
    if (untitled) warnings.push(`${plural(untitled, 'library track')} without a title ${untitled === 1 ? 'was' : 'were'} skipped.`);

    const collections = [];
    const librarySongs = [...byId.values()].filter((e) => e.inLibrary).map((e) => e.track);
    if (librarySongs.length) {
      collections.push(
        makeCollection({
          id: 'library-songs',
          kind: 'favorites',
          name: 'Library songs',
          description: 'Songs in your Apple Music library → added to your TIDAL collection (My Collection › Tracks).',
          tracks: librarySongs,
        }),
      );
    }

    // Playlists. Folders, the library container and subscribed playlists carry no track list.
    const seen = new Set();
    let subscribed = 0;
    let unresolved = 0;
    const empty = [];
    for (const file of bundle.files.filter(isPlaylistsFile)) {
      for (const r of readJsonArray(file, warnings)) {
        const containerId = idString(r.containeridentifier);
        if (containerId && seen.has(containerId)) continue;
        if (containerId) seen.add(containerId);
        const type = text(r.containertype) || 'Playlist';
        if (/subscribed/i.test(type)) {
          subscribed += 1;
          continue;
        }
        if (SKIPPED_CONTAINER.test(type)) continue;

        const name = text(r.title) || `Apple Music playlist ${containerId ?? collections.length}`;
        const items = Array.isArray(r.playlistitemidentifiers) ? r.playlistitemidentifiers : [];
        const tracks = [];
        for (const item of items) {
          const id = idString(item);
          const hit = id && byId.get(id);
          if (hit) tracks.push(hit.track);
          else if (!id || !skippedIds.has(id)) unresolved += 1;
        }
        if (!tracks.length) {
          empty.push(name);
          continue;
        }
        collections.push(
          makeCollection({
            id: `playlist-${containerId ?? collections.length}`,
            kind: 'playlist',
            name,
            description: text(r.description),
            createdAt: toIsoDate(r.addeddate),
            tracks,
          }),
        );
      }
    }
    if (subscribed) {
      warnings.push(`${plural(subscribed, 'subscribed playlist was', 'subscribed playlists were')} skipped: Apple's export doesn't list their songs.`);
    }
    if (empty.length) warnings.push(`Skipped empty playlists: ${empty.map((n) => `"${n}"`).join(', ')}.`);
    if (unresolved) warnings.push(`Skipped ${plural(unresolved, 'playlist entry', 'playlist entries')} pointing at songs missing from the library export.`);

    if (!collections.length) warnings.push('No Apple Music library songs or playlists were found in this export.');
    return { collections, warnings };
  },
};
