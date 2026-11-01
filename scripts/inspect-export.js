#!/usr/bin/env node
// Parse an export file locally and print what the app would import (no TIDAL calls).
// Usage: npm run inspect-export -- path/to/export.zip [--tracks]
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseExport } from '../src/importers/registry.js';

const [file, flag] = process.argv.slice(2);
if (!file) {
  console.error('Usage: npm run inspect-export -- <export.zip|file.csv> [--tracks]');
  process.exit(1);
}
const library = await parseExport({ filename: path.basename(file), buffer: await readFile(file) });
console.log(`Format: ${library.formatLabel} (${library.format})`);
for (const w of library.warnings) console.log(`Warning: ${w}`);
for (const c of library.collections) {
  const lookups = c.tracks.filter((t) => t.needsLookup).length;
  console.log(`${c.suggested ? '[x]' : '[ ]'} ${c.kind.padEnd(9)} ${c.name.padEnd(32)} ${String(c.tracks.length).padStart(5)} tracks  ${lookups} need lookup`);
  if (flag === '--tracks') {
    for (const t of c.tracks.slice(0, 5)) console.log(`      - ${t.title ?? `(${t.source?.type} ${t.source?.id})`} — ${t.artistCredit ?? ''}${t.addedAt ? `  @${t.addedAt}` : ''}`);
  }
}
