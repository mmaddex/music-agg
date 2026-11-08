// Fallback adapter: any CSV/TSV with recognisable title + artist columns.
//
// Each file becomes one playlist named after the file. Column names are matched
// loosely against common spellings used by Apple Music, Google Play Music, Spotify-style
// exporters and hand-made spreadsheets, so many future formats will "just work" here
// before they get a dedicated adapter.

import path from 'node:path';
import { makeCollection, makeTrack } from '../model.js';
import { findColumn, parseCsv } from '../csv.js';
import { toIsoDate } from '../../util/text.js';
import { fileHead } from '../bundle.js';

const COLUMNS = {
  title: ['Title', 'Song Title', 'Track Title', 'Track Name', 'Song', 'Song Name', 'Name', 'Track'],
  artist: ['Artist', 'Artists', 'Artist Name', 'Artist Names', 'Artist Name(s)', 'Album Artist', 'Performer'],
  album: ['Album', 'Album Title', 'Album Name', 'Release'],
  isrc: ['ISRC', 'Track ISRC', 'isrc'],
  duration: ['Duration (ms)', 'Duration ms', 'Duration', 'Length', 'Time', 'Track Duration (ms)'],
  added: ['Date Added', 'Added At', 'Time Added', 'Added'],
};

function columnsFor(file) {
  if (!/\.(csv|tsv|txt)$/i.test(file.path)) return null;
  let rows;
  try {
    const lines = fileHead(file).split(/\r?\n/);
    if (lines.length > 2) lines.pop(); // the head may end mid-line
    rows = parseCsv(lines.slice(0, 5).join('\n'));
  } catch {
    return null;
  }
  if (!rows.length) return null;
  const cols = Object.keys(rows[0]);
  const mapped = Object.fromEntries(Object.entries(COLUMNS).map(([k, aliases]) => [k, findColumn(cols, aliases)]));
  return mapped.title && (mapped.artist || mapped.isrc) ? mapped : null;
}

function parseDurationMs(value, columnName) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (/^\d+:\d{2}(:\d{2})?$/.test(s)) {
    return s.split(':').reduce((acc, part) => acc * 60 + Number(part), 0) * 1000;
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return /ms/i.test(columnName) || n > 10_000 ? Math.round(n) : Math.round(n * 1000);
}

export const genericCsv = {
  id: 'generic-csv',
  label: 'CSV (title / artist columns)',
  description: 'Any CSV with at least a title column and an artist or ISRC column. One playlist per file.',

  detect(bundle) {
    return bundle.files.some((f) => columnsFor(f)) ? 0.5 : 0;
  },

  parse(bundle) {
    const warnings = [];
    const collections = [];
    bundle.files.forEach((file, index) => {
      const cols = columnsFor(file);
      if (!cols) return;
      const rows = parseCsv(file.text);
      const tracks = rows
        .filter((r) => (r[cols.title] || '').trim())
        .map((r) =>
          makeTrack({
            title: r[cols.title],
            artistCredit: cols.artist ? r[cols.artist] : null,
            album: cols.album ? r[cols.album] : null,
            isrc: cols.isrc ? r[cols.isrc] : null,
            durationMs: cols.duration ? parseDurationMs(r[cols.duration], cols.duration) : null,
            addedAt: cols.added ? toIsoDate(r[cols.added]) : null,
          }),
        );
      collections.push(
        makeCollection({
          id: `csv-${index}`,
          kind: 'playlist',
          name: path.basename(file.path, path.extname(file.path)),
          tracks,
        }),
      );
    });
    if (!collections.length) warnings.push('No CSV with title and artist columns was found.');
    return { collections, warnings };
  },
};
