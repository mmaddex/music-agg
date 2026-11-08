import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadBundle, loadBundles, BundleError, LIMITS, decodeText, fileHead } from '../src/importers/bundle.js';
import { parseBundle, parseExport, UnknownFormatError } from '../src/importers/registry.js';
import { summarizeLibrary } from '../src/importers/model.js';
import { decodeHtmlEntities } from '../src/util/text.js';
import { describeAudioFile } from '../src/importers/audioFiles.js';
import { decodeEntryName } from '../src/importers/bundle.js';
import { notImportableRecord, audioFilesByKey } from '../src/imports/repo.js';

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

// ---- Apple Music (Apple privacy export) -------------------------------------------------

const applePart1 = new URL('./fixtures/apple-part-1.zip', import.meta.url);
const applePart2 = new URL('./fixtures/apple-part-2.zip', import.meta.url);
const appleUploads = async () => [
  { filename: 'Apple Media Services Information Part 1 of 2.zip', buffer: await readFile(applePart1) },
  { filename: 'Apple Media Services Information Part 2 of 2.zip', buffer: await readFile(applePart2) },
];

test('nested zips are opened and several uploads merge into one bundle', async () => {
  const bundle = await loadBundles(await appleUploads());
  const paths = bundle.files.map((f) => f.path);
  assert.ok(
    paths.includes(
      'Apple Media Services Information Part 1 of 2/Apple_Media_Services.zip/Apple_Media_Services/Apple Music Activity/Apple Music Library Tracks.json.zip/Apple Music Library Tracks.json',
    ),
    'three levels deep, prefixed with each archive path',
  );
  assert.ok(paths.includes('Game Center/Game Center Data.json'), 'second upload is included');
  assert.ok(!paths.some((p) => p.endsWith('.zip')), 'archives themselves are not bundle files');
  assert.ok(!paths.some((p) => p.includes('__MACOSX')));
  assert.deepEqual(bundle.skipped, []);
  assert.equal(bundle.name, 'Apple Media Services Information Part 1 of 2.zip, Apple Media Services Information Part 2 of 2.zip');
});

test('files over the size limit are skipped, not fatal', async () => {
  const saved = LIMITS.maxFileBytes;
  LIMITS.maxFileBytes = 20_000; // the fixture's play-activity CSV is ~56 KB
  try {
    const lib = await parseExport({ files: await appleUploads() });
    assert.equal(lib.format, 'apple-music');
    assert.deepEqual(
      lib.skippedFiles.map((s) => [s.path.split('/').pop(), s.reason]),
      [['Apple Music Play Activity.csv', 'too large']],
    );
    assert.equal(lib.collections[0].tracks.length, 3, 'the music data still loads');
  } finally {
    LIMITS.maxFileBytes = saved;
  }
});

test('bundle text is decoded lazily and fileHead reads only the start', async () => {
  const bundle = await loadBundle({ filename: 'x.csv', buffer: Buffer.from(`a,b\n${'1,2\n'.repeat(5000)}`) });
  const [file] = bundle.files;
  assert.equal(Object.getOwnPropertyDescriptor(file, 'text').get !== undefined, true);
  assert.ok(fileHead(file).length < file.text.length);
  assert.ok(fileHead(file).startsWith('a,b\n1,2'));
  assert.equal(fileHead({ path: 'y.csv', text: 'h\n1\n' }), 'h\n1\n', 'hand-built bundles work too');
});

test('Apple Music export: library songs become favourites, playlists keep their order', async () => {
  const lib = await parseExport({ files: await appleUploads() });
  assert.equal(lib.format, 'apple-music');
  const [songs, favoriteSongs, roadTrip, ...rest] = lib.collections;
  assert.equal(rest.length, 0, 'subscribed, empty and folder containers are not collections');

  assert.equal(songs.kind, 'favorites');
  assert.equal(songs.id, 'library-songs');
  assert.deepEqual(
    songs.tracks.map((t) => t.title),
    ['So What', 'Home Recording', 'Pott County Call Return'],
    'playlist-only, disliked, music-video and duplicate rows are left out',
  );
  const [soWhat, home] = songs.tracks;
  assert.deepEqual(soWhat.source, { type: 'apple-music', id: '1001', url: 'https://music.apple.com/song/1001' });
  assert.equal(soWhat.album, 'Kind of Blue');
  assert.equal(soWhat.durationMs, 200000);
  assert.equal(soWhat.addedAt, '2021-09-05T23:12:49Z');
  assert.equal(soWhat.needsLookup, false);
  assert.deepEqual(home.source, { type: 'apple-library', id: '5', url: null }, 'no catalog id → library id');

  assert.equal(favoriteSongs.kind, 'playlist');
  assert.equal(favoriteSongs.name, 'Favorite Songs');
  assert.equal(favoriteSongs.suggested, true);
  assert.deepEqual(favoriteSongs.tracks.map((t) => t.title), ['Pott County Call Return', 'So What']);

  assert.equal(roadTrip.id, 'playlist-300');
  assert.equal(roadTrip.description, 'Car songs');
  assert.equal(roadTrip.createdAt, '2025-01-17T17:25:05Z');
  assert.deepEqual(
    roadTrip.tracks.map((t) => t.title),
    ['Blue in Green', 'So What', 'Nookie'],
    'playlist-only and disliked songs still count in playlists; the video and unknown id are dropped',
  );
  assert.equal(roadTrip.tracks[1].key, soWhat.key, 'same song → same dedupe key across collections');

  assert.deepEqual(lib.warnings, [
    '1 music video was skipped (only songs are imported).',
    "1 subscribed playlist was skipped: Apple's export doesn't list their songs.",
    'Skipped empty playlists: "Nothing Yet".',
    'Skipped 1 playlist entry pointing at songs missing from the library export.',
  ]);
});

test('Apple Music export: uploading the same part twice does not duplicate anything', async () => {
  const [part1] = await appleUploads();
  const lib = await parseExport({ files: [part1, { ...part1, filename: 'copy.zip' }] });
  assert.deepEqual(lib.collections.map((c) => [c.name, c.tracks.length]), [
    ['Library songs', 3],
    ['Favorite Songs', 2],
    ['Road Trip', 3],
  ]);
});

test('Apple Music adapter tolerates key spelling drift and wins over generic CSV', () => {
  const tracks = [{ 'track identifier': 7, title: 'Song', ARTIST: 'Artist', 'Apple Music Track Identifier': 77 }];
  const lib = parseBundle({
    files: [
      { path: 'x/Apple Music Library Tracks.json', text: JSON.stringify(tracks) },
      { path: 'x/Apple Music - Track Play History.csv', text: 'Track Name,Artist Name\nSong,Artist\n' },
    ],
  });
  assert.equal(lib.format, 'apple-music');
  assert.equal(lib.collections[0].tracks[0].artistCredit, 'Artist');
  assert.equal(lib.collections[0].tracks[0].source.id, '77');
});

test('Apple Music adapter reports unreadable JSON instead of failing', () => {
  const lib = parseBundle({ files: [{ path: 'Apple Music Library Tracks.json', text: '{not json' }] });
  assert.equal(lib.collections.length, 0);
  assert.match(lib.warnings[0], /^Skipped Apple Music Library Tracks\.json:/);
});

// ---- Google Play Music (Google Takeout) --------------------------------------------------

const gpmFixture = new URL('./fixtures/google-play-music-takeout.zip', import.meta.url);

test('zips are read straight from disk, skipping audio without decompressing it', async () => {
  const bundle = await loadBundle({ filename: 'takeout.zip', path: fileURLToPath(gpmFixture) });
  const paths = bundle.files.map((f) => f.path);
  assert.ok(paths.includes('Takeout/Google Play Music/Tracks/So What.csv'));
  assert.ok(!paths.some((p) => /\.(mp3|mega|html)$/.test(p) || p.includes('__MACOSX')));
  // Same result whether the upload is on disk or in memory.
  const inMemory = await loadBundle({ filename: 'takeout.zip', buffer: await readFile(gpmFixture) });
  assert.deepEqual(inMemory.files.map((f) => f.path), paths);
});

test('a multi-part Apple export also loads from disk', async () => {
  const lib = await parseExport({
    files: [
      { filename: 'Part 1 of 2.zip', path: fileURLToPath(applePart1) },
      { filename: 'Part 2 of 2.zip', path: fileURLToPath(applePart2) },
    ],
  });
  assert.equal(lib.format, 'apple-music');
  assert.equal(lib.collections[0].tracks.length, 3);
});

test('Google Play Music Takeout: library → favourites, playlists in Playlist Index order', async () => {
  const lib = await parseExport({ filename: 'takeout.zip', buffer: await readFile(gpmFixture) });
  assert.equal(lib.format, 'google-play-music');
  const [songs, roadTrip, thumbsUp, ...rest] = lib.collections;
  assert.equal(rest.length, 0, 'deleted and empty playlists, and radio stations, are not collections');

  assert.equal(songs.kind, 'favorites');
  assert.deepEqual(
    songs.tracks.map((t) => t.title),
    ["I'm Down", 'Kodachrome', 'So What'],
    'HTML entities decoded; removed, thumbs-down and duplicate tracks left out',
  );
  const soWhat = songs.tracks[2];
  assert.equal(soWhat.album, 'Kind of Blue');
  assert.deepEqual(soWhat.artists, ['Miles Davis']);
  assert.equal(soWhat.durationMs, 200000);
  assert.equal(soWhat.needsLookup, false);

  assert.equal(roadTrip.name, 'Road Trip');
  assert.equal(roadTrip.description, 'Car songs & more');
  assert.deepEqual(roadTrip.tracks.map((t) => t.title), ['So What', 'Kodachrome', 'Nookie'], 'index order; removed entry dropped');
  assert.equal(roadTrip.tracks[0].key, soWhat.key, 'same song → same dedupe key across collections');

  assert.equal(thumbsUp.name, 'Thumbs Up', 'auto playlist without Metadata.csv is named after its folder');
  assert.deepEqual(thumbsUp.tracks.map((t) => t.title), ['Kodachrome']);

  assert.deepEqual(lib.warnings, [
    '1 thumbs-down song was left out of your favourites.',
    'Skipped 2 playlist entries marked as removed.',
    'Skipped deleted playlists: "Old Stuff".',
    'Skipped empty playlists: "Spring".',
    '2 audio files in this export can\'t be imported: TIDAL only adds songs from its own catalogue and can\'t store your own audio. They\'re listed in the import\'s "not imported" record.',
  ]);
});

test('Google Play Music Takeout uploaded twice is not duplicated', async () => {
  const buffer = await readFile(gpmFixture);
  const lib = await parseExport({ files: [{ filename: 'a.zip', buffer }, { filename: 'b.zip', buffer }] });
  assert.deepEqual(lib.collections.map((c) => [c.name, c.tracks.length]), [
    ['Library songs', 3],
    ['Road Trip', 3],
    ['Thumbs Up', 1],
  ]);
  assert.equal(lib.warnings[1], 'Skipped 2 playlist entries marked as removed.');
});

test('decodeHtmlEntities handles numeric, hex and named references', () => {
  assert.equal(decodeHtmlEntities('I&#39;m &amp; you&#x2019;re &quot;ok&quot; &bogus;'), 'I\'m & you’re "ok" &bogus;');
  assert.equal(decodeHtmlEntities(null), null);
});

// ---- the export's own audio files ------------------------------------------------------

test('audio files are listed (not decompressed), de-duplicated and linked to their songs', async () => {
  const lib = await parseExport({ filename: 'takeout.zip', path: fileURLToPath(gpmFixture) });
  const songs = lib.collections[0];
  const soWhat = songs.tracks.find((t) => t.title === 'So What');
  assert.deepEqual(lib.notImportable, [
    {
      path: 'Takeout/Google Play Music/Tracks/Garage Band - Demos(003)Basement Ja.mp3',
      title: 'Basement Ja',
      artist: 'Garage Band',
      album: 'Demos',
      reason: 'own_audio_file',
      linkedKey: null,
    },
    {
      path: 'Takeout/Google Play Music/Tracks/Miles Davis - Kind of Blue - So What.mp3',
      title: 'So What',
      artist: 'Miles Davis',
      album: 'Kind of Blue',
      reason: 'own_audio_file',
      linkedKey: soWhat.key,
    },
  ], 'the "(1)" copy is listed once');
  assert.ok(!lib.collections.some((c) => c.tracks.some((t) => /mp3/i.test(t.title))), 'audio files never become tracks');
});

test('audio file names: Google Play Music patterns, truncated titles, duplicate copies', () => {
  assert.deepEqual(describeAudioFile('x/Trio Mossoró -  - Hoje não, saudade (1).mp3'), { artist: 'Trio Mossoró', album: null, title: 'Hoje não, saudade', truncated: false });
  assert.deepEqual(describeAudioFile('Jim Campilongo - Dream Dictionary(002)The Past .mp3'), { artist: 'Jim Campilongo', album: 'Dream Dictionary', title: 'The Past', truncated: true });
  assert.deepEqual(describeAudioFile('Artist - Song.m4a'), { artist: 'Artist', album: null, title: 'Song', truncated: false });
  assert.deepEqual(describeAudioFile('track01.flac'), { artist: null, album: null, title: 'track01', truncated: false });
});

test('the not-imported record marks audio files and says whether the song reached TIDAL', async () => {
  const lib = await parseExport({ filename: 'takeout.zip', path: fileURLToPath(gpmFixture) });
  const imp = { library: { collections: lib.collections, notImportable: lib.notImportable } };
  const soWhatKey = lib.notImportable[1].linkedKey;
  const target = (items, unimported = []) => ({ items: items.map((key) => ({ key })), unimported: unimported.map((key) => ({ key })) });

  const before = notImportableRecord(imp, []);
  assert.deepEqual(before.map((r) => [r.reason, r.audioFile.split('/').pop()]), [
    ['own_audio_file', 'Garage Band - Demos(003)Basement Ja.mp3'],
    ['own_audio_file', 'Miles Davis - Kind of Blue - So What.mp3'],
  ]);
  assert.match(before[0].detail, /isn't in the export's song lists/);
  assert.match(before[1].detail, /matched separately/);

  assert.match(notImportableRecord(imp, [target([soWhatKey])])[1].detail, /added from TIDAL's catalogue instead/);
  assert.match(notImportableRecord(imp, [target([], [soWhatKey])])[1].detail, /wasn't found on TIDAL either/);
  assert.match(notImportableRecord(imp, [target(['other'])])[1].detail, /wasn't part of this import/);

  assert.equal(audioFilesByKey(imp).get(soWhatKey), lib.notImportable[1].path, 'other rows for this song can point at its audio file');
});

test('zip entry names: UTF-8 bytes without the UTF-8 flag are decoded as UTF-8, else CP437', () => {
  assert.equal(decodeEntryName(Buffer.from('Trio Mossoró.mp3'.normalize('NFD'), 'utf8')), 'Trio Mossoró.mp3', 'and NFC-normalised');
  assert.equal(decodeEntryName(Buffer.from([0x43, 0x61, 0x66, 0x82])), 'Café', 'CP437 0x82 → é');
  assert.equal(decodeEntryName('already a string'), 'already a string');
});
