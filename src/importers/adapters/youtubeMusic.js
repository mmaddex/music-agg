// YouTube / YouTube Music export from Google Takeout.
//
// Layout handled (the format in the sample export):
//   YouTube and YouTube Music/
//     music-library-songs/music-library-songs*.csv
//         Song URL,Song Title,Album Title,Artist Names
//     playlists/<Title>.csv
//         Playlist Id,Channel Id,Time Created,Time Updated,Title,Description,Visibility
//         <one metadata row>
//         <blank lines>
//         Video Id,Time Added
//         <one row per video>
//
// Also tolerated: newer Takeouts that split playlists into "<Title>-videos.csv" with just
// "Video ID,Playlist Video Creation Timestamp" columns (name taken from the filename).
//
// Playlist files carry only video ids. Ids that also appear in the library file get full
// metadata from it; the rest are marked needsLookup and filled in by the YouTube
// enricher before matching.

import path from 'node:path';
import { makeCollection, makeTrack } from '../model.js';
import { findColumn, firstLine, parseCsv } from '../csv.js';
import { toIsoDate } from '../../util/text.js';

const LIBRARY_HEADER = /^song url,song title,album title,artist names/i;
const PLAYLIST_META_HEADER = /^playlist id,/i;
const VIDEO_ID_COLUMNS = ['Video Id', 'Video ID'];
const ADDED_COLUMNS = ['Time Added', 'Playlist Video Creation Timestamp'];

// Auto-generated YouTube lists that usually aren't music; shown but not pre-selected.
const NOT_SUGGESTED = [/^watch later$/i, /^uploads from /i];

function videoIdFromUrl(url) {
  const m = /[?&]v=([\w-]{11})/.exec(url || '') || /youtu\.be\/([\w-]{11})/.exec(url || '');
  return m ? m[1] : null;
}

function isLibraryFile(file) {
  return /\.csv$/i.test(file.path) && LIBRARY_HEADER.test(firstLine(file.text));
}

function isPlaylistFile(file) {
  if (!/\.csv$/i.test(file.path) || !/(^|\/)playlists\//i.test(file.path)) return false;
  const head = firstLine(file.text);
  return PLAYLIST_META_HEADER.test(head) || /^video id,/i.test(head);
}

export const youtubeMusic = {
  id: 'youtube-music',
  label: 'YouTube Music (Google Takeout)',
  description: 'Takeout zip containing "YouTube and YouTube Music" playlists and music-library-songs CSVs.',

  detect(bundle) {
    const lib = bundle.files.some(isLibraryFile);
    const pls = bundle.files.some(isPlaylistFile);
    if (lib && pls) return 0.99;
    if (lib || pls) return 0.9;
    return 0;
  },

  parse(bundle) {
    const warnings = [];
    const library = new Map(); // videoId -> track

    for (const file of bundle.files.filter(isLibraryFile)) {
      for (const row of parseCsv(file.text)) {
        const id = videoIdFromUrl(row['Song URL']);
        if (!id || library.has(id)) continue; // Takeout often ships duplicate copies of this file
        library.set(
          id,
          makeTrack({
            title: row['Song Title'],
            artistCredit: row['Artist Names'],
            album: row['Album Title'],
            source: { type: 'youtube', id, url: row['Song URL'] },
          }),
        );
      }
    }

    const collections = [];
    if (library.size) {
      collections.push(
        makeCollection({
          id: 'library-songs',
          kind: 'favorites',
          name: 'Library songs',
          description: 'Songs saved to your YouTube Music library → added to your TIDAL collection (My Collection › Tracks).',
          tracks: [...library.values()],
        }),
      );
    }

    const playlistFiles = bundle.files.filter(isPlaylistFile).sort((a, b) => a.path.localeCompare(b.path));
    for (const [index, file] of playlistFiles.entries()) {
      try {
        collections.push(parsePlaylist(file, index, library));
      } catch (err) {
        warnings.push(`Skipped ${path.basename(file.path)}: ${err.message}`);
      }
    }

    if (!collections.length) warnings.push('No playlists or library songs were found in this export.');
    return { collections, warnings };
  },
};

function parsePlaylist(file, index, library) {
  // Split the metadata block from the video list: they are separated by blank lines.
  const text = file.text.replace(/^﻿/, '');
  let meta = null;
  let videosText = text;
  if (PLAYLIST_META_HEADER.test(firstLine(text))) {
    const sections = text.split(/\r?\n\s*\r?\n/).filter((s) => s.trim());
    meta = parseCsv(sections[0])[0] || null;
    videosText = sections.slice(1).join('\n');
  }

  const rows = videosText.trim() ? parseCsv(videosText) : [];
  const columns = rows.length ? Object.keys(rows[0]) : [];
  const idCol = findColumn(columns, VIDEO_ID_COLUMNS);
  const addedCol = findColumn(columns, ADDED_COLUMNS);
  if (rows.length && !idCol) throw new Error('no "Video Id" column');

  const fallbackName = path.basename(file.path, path.extname(file.path)).replace(/-videos$/i, '');
  const name = meta?.Title || fallbackName;

  const tracks = rows
    .map((row) => (row[idCol] || '').trim())
    .map((id, i) => ({ id, addedAt: addedCol ? toIsoDate(rows[i][addedCol]) : null }))
    .filter(({ id }) => /^[\w-]{11}$/.test(id))
    .map(({ id, addedAt }) => {
      const known = library.get(id);
      if (known) return { ...known, addedAt };
      return makeTrack({ addedAt, source: { type: 'youtube', id, url: `https://www.youtube.com/watch?v=${id}` } });
    });

  return makeCollection({
    id: `playlist-${index}`,
    kind: 'playlist',
    name,
    description: meta?.Description || null,
    createdAt: toIsoDate(meta?.['Time Created']),
    suggested: !NOT_SUGGESTED.some((re) => re.test(name)),
    tracks,
  });
}
