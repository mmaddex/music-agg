import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadBundle, BundleError, decodeText } from '../src/importers/bundle.js';
import { parseBundle, parseExport, UnknownFormatError } from '../src/importers/registry.js';
import { summarizeLibrary } from '../src/importers/model.js';

const fixture = new URL('./fixtures/youtube-takeout.zip', import.meta.url);

test('zip loader keeps text files and drops macOS junk and html', async () => {
  const bundle = await loadBundle({ filename: 'export.zip', buffer: await readFile(fixture) });
  const paths = bundle.files.map((f) => f.path);
  assert.equal(paths.length, 4);
  assert.ok(paths.every((p) => p.endsWith('.csv')));
  assert.ok(!paths.some((p) => p.includes('__MACOSX')));
});

test('YouTube Music Takeout is detected and parsed', async () => {
  const lib = await parseExport({ filename: 'export.zip', buffer: await readFile(fixture) });
  assert.equal(lib.format, 'youtube-music');

  const [songs, roadTrip, watchLater] = lib.collections;
  assert.equal(songs.kind, 'favorites');
  assert.equal(songs.tracks.length, 2, 'duplicate library file is de-duplicated');
  assert.equal(songs.tracks[0].title, '"Quoted, Title"');
  assert.deepEqual(songs.tracks[1].artists, ['John Lennon', 'Yoko Ono']);

  assert.equal(roadTrip.name, 'Road Trip', 'name comes from metadata, not the "Road Trip_" filename');
  assert.equal(roadTrip.description, 'Songs for the car');
  assert.equal(roadTrip.createdAt, '2019-01-17T00:44:23Z');
  assert.equal(roadTrip.tracks.length, 2, 'invalid video ids are dropped');
  assert.equal(roadTrip.tracks[0].title, 'Angela', 'known video id is filled from the library');
  assert.equal(roadTrip.tracks[0].addedAt, '2019-01-17T00:44:24Z');
  assert.equal(roadTrip.tracks[1].needsLookup, true);
  assert.equal(roadTrip.tracks[1].source.id, 'CCCCCCCCCCC');
  assert.equal(roadTrip.tracks[0].key, songs.tracks[1].key, 'same video → same dedupe key');

  assert.equal(watchLater.suggested, false);
  const summary = summarizeLibrary(lib);
  assert.equal(summary.collections[1].needsLookupCount, 1);
});

test('newer Takeout "<name>-videos.csv" playlists without a metadata block', () => {
  const lib = parseBundle({
    files: [
      {
        path: 'Takeout/YouTube and YouTube Music/playlists/Chill-videos.csv',
        text: 'Video ID,Playlist Video Creation Timestamp\nEEEEEEEEEEE,2023-05-01T10:00:00+00:00\n',
      },
    ],
  });
  assert.equal(lib.format, 'youtube-music');
  assert.equal(lib.collections[0].name, 'Chill');
  assert.equal(lib.collections[0].tracks[0].addedAt, '2023-05-01T10:00:00Z');
});

test('generic CSV adapter maps common column names', async () => {
  const csv = 'Track Name,Artist Name(s),Album Name,ISRC,Duration (ms)\nSo What,Miles Davis,Kind of Blue,usSm15900113,562000\n';
  const lib = await parseExport({ filename: 'Jazz Favs.csv', buffer: Buffer.from(csv) });
  assert.equal(lib.format, 'generic-csv');
  assert.equal(lib.collections[0].name, 'Jazz Favs');
  const t = lib.collections[0].tracks[0];
  assert.equal(t.title, 'So What');
  assert.equal(t.isrc, 'USSM15900113');
  assert.equal(t.durationMs, 562000);
});

test('generic CSV handles mm:ss durations and TSV', async () => {
  const tsv = 'Title\tArtist\tTime\nBlue in Green\tMiles Davis\t5:37\n';
  const lib = await parseExport({ filename: 'x.tsv', buffer: Buffer.from(tsv) });
  assert.equal(lib.collections[0].tracks[0].durationMs, 337000);
});

test('unknown content is rejected with a helpful error', async () => {
  await assert.rejects(parseExport({ filename: 'x.csv', buffer: Buffer.from('foo,bar\n1,2\n') }), UnknownFormatError);
  await assert.rejects(parseExport({ filename: 'x.pdf', buffer: Buffer.from('%PDF') }), BundleError);
});

test('UTF-16 text (iTunes-style) is decoded', () => {
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Name\tArtist\n', 'utf16le')]);
  assert.equal(decodeText(buf), 'Name\tArtist\n');
});
