import type { BundleFile } from '../bundle/bundle.js';
import type { ParsedExport, SourceCollection, SourceTrack } from '../model.js';
import { csvHeader, headerKey, isCsv, readCsvRecords } from './csv.js';
import type { ExportImporter } from './types.js';

/**
 * Fallback for "a CSV with a title column and an artist column", whatever service
 * produced it. Column names are matched loosely (see COLUMN_ALIASES). Each CSV file
 * becomes one collection, unless it has a "playlist" column, in which case rows
 * are grouped by that column.
 *
 * Service-specific importers should score higher than this one in `detect`, so it
 * only wins when nothing more specific recognises the upload.
 */

const COLUMN_ALIASES = {
  title: ['title', 'songtitle', 'song', 'songname', 'track', 'trackname', 'tracktitle', 'name'],
  artist: ['artist', 'artists', 'artistname', 'artistnames', 'performer', 'albumartist'],
  album: ['album', 'albumtitle', 'albumname'],
  isrc: ['isrc'],
  duration: ['durationms', 'duration', 'length', 'time', 'durationseconds'],
  playlist: ['playlist', 'playlistname', 'playlisttitle'],
  addedAt: ['addedat', 'dateadded', 'timeadded', 'added'],
} as const;

type Field = keyof typeof COLUMN_ALIASES;
type ColumnMap = Partial<Record<Field, string>>;

export function mapColumns(header: string[]): ColumnMap {
  const map: ColumnMap = {};
  const keyed = header.map((h) => [headerKey(h), h] as const);
  for (const field of Object.keys(COLUMN_ALIASES) as Field[]) {
    for (const alias of COLUMN_ALIASES[field]) {
      const hit = keyed.find(([k]) => k === alias);
      if (hit) {
        map[field] = hit[1];
        break;
      }
    }
  }
  return map;
}

function usable(file: BundleFile): ColumnMap | null {
  if (!isCsv(file)) return null;
  const map = mapColumns(csvHeader(file));
  return map.title && (map.artist || map.isrc) ? map : null;
}

/** Accepts "215000" (ms), "215" (s), "3:35", "1:02:03". */
export function parseDurationMs(value: string | undefined, columnName = ''): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    const looksLikeMs = /ms|millis/i.test(columnName) || n > 10_000;
    return Math.round(looksLikeMs ? n : n * 1000);
  }
  const parts = v.split(':').map(Number);
  if (parts.length >= 2 && parts.length <= 3 && parts.every((p) => Number.isFinite(p))) {
    return parts.reduce((acc, p) => acc * 60 + p, 0) * 1000;
  }
  return undefined;
}

function toIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export const genericCsvImporter: ExportImporter = {
  id: 'generic-csv',
  label: 'Generic CSV',
  description:
    'Any CSV with a song title column and an artist column (album, ISRC, duration and playlist columns are used when present).',

  detect(bundle) {
    const files = bundle.files.filter((f) => usable(f));
    if (!files.length) return null;
    return {
      confidence: 0.4,
      reason: `${files.length} CSV file${files.length === 1 ? '' : 's'} with title and artist columns.`,
    };
  },

  parse(bundle): ParsedExport {
    const warnings: string[] = [];
    const collections: SourceCollection[] = [];
    bundle.files.forEach((file, fileIndex) => {
      const cols = usable(file);
      if (!cols) return;
      const { records } = readCsvRecords(file);
      const groups = new Map<string, SourceTrack[]>();
      const defaultName = file.name.replace(/\.(csv|tsv)$/i, '');
      for (const r of records) {
        const title = cols.title ? r[cols.title] : undefined;
        const artist = cols.artist ? r[cols.artist] : undefined;
        const isrc = cols.isrc ? r[cols.isrc]?.replace(/[^A-Za-z0-9]/g, '').toUpperCase() : undefined;
        if (!title && !isrc) continue;
        const track: SourceTrack = {
          title: title || undefined,
          artists: artist ? [artist] : [],
          album: (cols.album && r[cols.album]) || undefined,
          isrc: isrc || undefined,
          durationMs: cols.duration ? parseDurationMs(r[cols.duration], cols.duration) : undefined,
          addedAt: cols.addedAt ? toIso(r[cols.addedAt]) : undefined,
          refs: [],
          quality: title && artist ? 'export' : 'missing',
        };
        const group = (cols.playlist && r[cols.playlist]) || defaultName;
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group)!.push(track);
      }
      let g = 0;
      for (const [name, tracks] of groups) {
        collections.push({
          id: `csv-${fileIndex}-${g++}`,
          name,
          kind: 'playlist',
          tracks,
          suggestedTarget: 'playlist',
        });
      }
      if (!groups.size) warnings.push(`${file.name} has no usable rows.`);
    });
    return { importerId: this.id, importerLabel: this.label, collections, warnings };
  },
};
