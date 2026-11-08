#!/usr/bin/env node
// Parse an export locally and print what the app would import (no TIDAL calls).
// Usage: npm run inspect-export -- path/to/export.zip [more.zip …] [--tracks]
// Multi-part exports (e.g. Apple's "Part 1 of 2.zip" + "Part 2 of 2.zip") are passed together.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseExport } from '../src/importers/registry.js';

const args = process.argv.slice(2);
const showTracks = args.includes('--tracks');
const paths = args.filter((a) => a !== '--tracks');
if (!paths.length) {
  console.error('Usage: npm run inspect-export -- <export.zip|file.csv> [more files…] [--tracks]');
  process.exit(1);
}
const files = await Promise.all(paths.map(async (p) => ({ filename: path.basename(p), buffer: await readFile(p) })));
const library = await parseExport({ files });
console.log(`Format: ${library.formatLabel} (${library.format})`);
for (const w of library.warnings) console.log(`Warning: ${w}`);
for (const s of library.skippedFiles) console.log(`Skipped file: ${s.path} (${s.reason}${s.size ? `, ${Math.round(s.size / 1024 / 1024)} MB` : ''})`);
for (const c of library.collections) {
  const lookups = c.tracks.filter((t) => t.needsLookup).length;
  console.log(`${c.suggested ? '[x]' : '[ ]'} ${c.kind.padEnd(9)} ${c.name.padEnd(32)} ${String(c.tracks.length).padStart(5)} tracks  ${lookups} need lookup`);
  if (showTracks) {
    for (const t of c.tracks.slice(0, 5)) console.log(`      - ${t.title ?? `(${t.source?.type} ${t.source?.id})`} — ${t.artistCredit ?? ''}${t.addedAt ? `  @${t.addedAt}` : ''}`);
  }
}
