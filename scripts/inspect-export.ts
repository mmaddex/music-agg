/**
 * Parse an export locally and print what the app would import — no TIDAL login needed.
 *
 *   npm run inspect-export -- path/to/youtube_music.zip [--lookup] [--format=<importer-id>]
 *
 * --lookup  also resolves video-only playlist entries via YouTube (network).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildBundle } from '../src/core/bundle/bundle.js';
import { defaultEnrichers, enrichTracks } from '../src/core/enrich/youtube.js';
import { parseExport } from '../src/core/importers/registry.js';

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--'));
const lookup = args.includes('--lookup');
const format = args.find((a) => a.startsWith('--format='))?.split('=')[1];

if (!files.length) {
  console.error('usage: npm run inspect-export -- <export.zip|file.csv> [...more files] [--lookup] [--format=<id>]');
  process.exit(1);
}

const bundle = buildBundle(files.map((f) => ({ name: path.basename(f), data: new Uint8Array(readFileSync(f)) })));
const { parsed, detected } = parseExport(bundle, format);

console.log(`Files in bundle: ${bundle.files.length}`);
console.log('Detected formats:');
for (const d of detected) console.log(`  ${d.importer.id.padEnd(24)} ${d.confidence.toFixed(2)}  ${d.reason}`);
console.log(`\nUsing: ${parsed.importerLabel}\n`);

for (const c of parsed.collections) {
  const missing = c.tracks.filter((t) => t.quality === 'missing').length;
  console.log(
    `${c.name.padEnd(34)} ${String(c.tracks.length).padStart(5)} tracks  ${String(missing).padStart(4)} need lookup  → ${c.suggestedTarget}${c.note ? `  (${c.note})` : ''}`,
  );
}
for (const w of parsed.warnings) console.log(`warning: ${w}`);

if (lookup) {
  const tracks = parsed.collections.flatMap((c) => c.tracks);
  console.log('\nLooking up video-only entries…');
  await enrichTracks(tracks, defaultEnrichers(process.env.YOUTUBE_API_KEY), {
    onProgress: (d, t) => process.stdout.write(`\r  ${d}/${t}`),
  });
  console.log('\n');
  for (const c of parsed.collections) {
    if (c.kind === 'library') continue;
    console.log(`== ${c.name}`);
    for (const t of c.tracks.slice(0, 15)) {
      const what = t.title ? `${t.artists.join(', ') || '?'} — ${t.title}` : `(unavailable: ${t.hints?.unavailable ?? 'unknown'})`;
      console.log(`  [${t.quality}] ${what}${t.hints?.videoTitle ? `   ⟵ "${t.hints.videoTitle}" / ${t.hints.channel}` : ''}`);
    }
    if (c.tracks.length > 15) console.log(`  … ${c.tracks.length - 15} more`);
  }
}
