import type { BundleFile, ExportBundle } from '../bundle/bundle.js';
import type { ParsedExport, SourceCollection, SourceTrack } from '../model.js';
import { csvHeader, headerKey, isBlankRow, isCsv, readCsvRecords, readCsvRows, recordFrom } from './csv.js';
import type { ExportImporter } from './types.js';

/**
 * Google Takeout export of "YouTube and YouTube Music".
 *
 * Files used:
 *  - music-library-songs/music-library-songs*.csv
 *      Song URL,Song Title,Album Title,Artist Names
 *  - playlists/<name>.csv — two CSV tables in one file separated by blank lines:
 *      Playlist Id,Channel Id,Time Created,Time Updated,Title,Description,Visibility
 *      <one row of playlist metadata>
 *
 *      Video Id,Time Added
 *      <one row per entry>
 *
 * Playlist entries only carry a video id. Where the same video appears in the
 * library file we copy its title/artist/album; the rest are marked
 * `quality: "missing"` and resolved later by the YouTube enricher.
 *
 * Detection relies on CSV headers rather than folder names, because Takeout
 * localises folder names ("YouTube und YouTube Music", ...).
 */

const LIBRARY_HEADER = ['songurl', 'songtitle', 'albumtitle', 'artistnames'];
const PLAYLIST_META_KEYS = ['playlistid', 'title'];

function isLibraryFile(f: BundleFile): boolean {
  if (!isCsv(f)) return false;
  const h = csvHeader(f).map(headerKey);
  return LIBRARY_HEADER.every((k) => h.includes(k));
}

function isPlaylistFile(f: BundleFile): boolean {
  if (!isCsv(f)) return false;
  const h = csvHeader(f).map(headerKey);
  return PLAYLIST_META_KEYS.every((k) => h.includes(k));
}

export function videoIdFromUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    const v = u.searchParams.get('v');
    if (v) return v;
    if (u.hostname === 'youtu.be') return u.pathname.slice(1) || undefined;
  } catch {
    // fall through
  }
  return undefined;
}

export function youtubeRef(videoId: string) {
  return { service: 'youtube', id: videoId, url: `https://music.youtube.com/watch?v=${videoId}` };
}

/** "2017-01-02 02:39:57 UTC" -> "2017-01-02T02:39:57Z" */
export function takeoutTimeToIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*(?:UTC|Z)?$/.exec(value.trim());
  if (!m) return undefined;
  return `${m[1]}T${m[2]}Z`;
}

interface PlaylistFileData {
  meta: Record<string, string>;
  entries: { videoId: string; addedAt?: string }[];
}

export function parsePlaylistFile(file: BundleFile): PlaylistFileData {
  const rows = readCsvRows(file);
  let i = 0;
  const skipBlank = () => {
    while (i < rows.length && isBlankRow(rows[i]!)) i++;
  };
  skipBlank();
  const metaHeader = (rows[i++] ?? []).map((h) => h.trim());
  skipBlank();
  // Metadata row is directly after the header (may be absent for empty exports).
  let meta: Record<string, string> = Object.create(null);
  if (i < rows.length && headerKey(rows[i]![0] ?? '') !== 'videoid') {
    meta = recordFrom(metaHeader.map(headerKey), rows[i++]!);
  }
  skipBlank();
  const entries: PlaylistFileData['entries'] = [];
  const entryHeader = (rows[i] ?? []).map(headerKey);
  if (entryHeader.includes('videoid')) {
    i++;
    const idCol = entryHeader.indexOf('videoid');
    const timeCol = entryHeader.indexOf('timeadded');
    for (; i < rows.length; i++) {
      const row = rows[i]!;
      if (isBlankRow(row)) continue;
      const videoId = (row[idCol] ?? '').trim();
      if (!videoId) continue;
      entries.push({ videoId, addedAt: timeCol >= 0 ? takeoutTimeToIso(row[timeCol]) : undefined });
    }
  }
  return { meta, entries };
}

function stripCsvExt(name: string): string {
  return name.replace(/\.(csv|tsv)$/i, '');
}

export const youtubeMusicImporter: ExportImporter = {
  id: 'youtube-music-takeout',
  label: 'YouTube Music (Google Takeout)',
  description:
    'Google Takeout "YouTube and YouTube Music" export: music-library-songs.csv and the playlists/*.csv files. Upload the .zip as-is.',

  detect(bundle) {
    const lib = bundle.files.filter(isLibraryFile).length;
    const pl = bundle.files.filter(isPlaylistFile).length;
    if (!lib && !pl) return null;
    const parts = [];
    if (lib) parts.push('music library songs');
    if (pl) parts.push(`${pl} playlist file${pl === 1 ? '' : 's'}`);
    return { confidence: lib && pl ? 0.98 : 0.9, reason: `Found YouTube Music ${parts.join(' and ')}.` };
  },

  parse(bundle) {
    const warnings: string[] = [];
    const collections: SourceCollection[] = [];

    // --- Library songs (may be split across, or duplicated in, several files) ---
    const library = new Map<string, SourceTrack>();
    for (const file of bundle.files.filter(isLibraryFile)) {
      const { records } = readCsvRecords(file);
      for (const r of records) {
        const get = (k: string) => {
          const key = Object.keys(r).find((h) => headerKey(h) === k);
          return key ? r[key] : undefined;
        };
        const url = get('songurl') ?? '';
        const title = get('songtitle');
        const videoId = videoIdFromUrl(url);
        if (!title && !videoId) continue;
        const key = videoId ?? `${title}|${get('artistnames')}`;
        if (library.has(key)) continue;
        const artist = get('artistnames');
        library.set(key, {
          title: title || undefined,
          artists: artist ? [artist] : [],
          album: get('albumtitle') || undefined,
          refs: videoId ? [youtubeRef(videoId)] : [],
          quality: title && artist ? 'export' : 'missing',
        });
      }
    }
    if (library.size) {
      collections.push({
        id: 'yt-library',
        name: 'YouTube Music library',
        kind: 'library',
        tracks: [...library.values()],
        suggestedTarget: 'favorites',
        note: 'Songs saved to your YouTube Music library.',
      });
    }

    // --- Playlists ---
    const seenPlaylistIds = new Set<string>();
    bundle.files.filter(isPlaylistFile).forEach((file, index) => {
      let data: PlaylistFileData;
      try {
        data = parsePlaylistFile(file);
      } catch (err) {
        warnings.push(`Could not read ${file.name}: ${(err as Error).message}`);
        return;
      }
      const playlistId = data.meta.playlistid || `file-${index}`;
      if (seenPlaylistIds.has(playlistId)) return; // duplicate copy of the same playlist
      seenPlaylistIds.add(playlistId);

      const name = data.meta.title?.trim() || stripCsvExt(file.name);
      if (!data.entries.length) {
        warnings.push(`Playlist "${name}" is empty and was skipped.`);
        return;
      }

      const tracks: SourceTrack[] = data.entries.map(({ videoId, addedAt }) => {
        const known = library.get(videoId);
        if (known) return { ...known, refs: [youtubeRef(videoId)], addedAt };
        return { artists: [], refs: [youtubeRef(videoId)], addedAt, quality: 'missing' };
      });

      const lowerName = name.toLowerCase();
      let kind: SourceCollection['kind'] = 'playlist';
      let suggestedTarget: SourceCollection['suggestedTarget'] = 'playlist';
      let note: string | undefined;
      if (playlistId.startsWith('LL') || lowerName === 'liked videos' || lowerName === 'liked music') {
        kind = 'liked';
        note = 'Everything you liked on YouTube — may include non-music videos.';
      } else if (playlistId.startsWith('UU') || lowerName.startsWith('uploads from')) {
        suggestedTarget = 'skip';
        note = 'Videos you uploaded yourself — unlikely to be on TIDAL.';
      } else if (playlistId === 'WL' || lowerName === 'watch later') {
        suggestedTarget = 'skip';
        note = 'Usually non-music videos.';
      }

      collections.push({
        id: `yt-pl-${playlistId}`,
        name,
        description: data.meta.description || undefined,
        kind,
        tracks,
        suggestedTarget,
        note,
      });
    });

    return { importerId: this.id, importerLabel: this.label, collections, warnings };
  },
};
