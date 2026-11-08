// The cross-import "missing songs" list: merged per song, and songs another import added are dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { hasDb, testPool } from './helpers/db.js';
import { groupMissingRecords, missingAcrossImports } from '../src/imports/repo.js';

const row = (key, title, artist, reason, extra = {}) => ({ key, title, artist, album: null, url: null, reason, detail: `${reason} detail`, ...extra });

test('missing songs are merged across imports and playlists', { skip: !hasDb }, async (t) => {
  const db = await testPool();
  t.after(() => db.close());
  const { pool } = db;
  const account = crypto.randomUUID();
  const other = crypto.randomUUID();
  await pool.query(`INSERT INTO accounts (id, tidal_user_id) VALUES ($1, 'u1'), ($2, 'u2')`, [account, other]);

  const addImport = async (accountId, { filename, label, createdAt, notImportable = [], stage = 'load' }) => {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO imports (id, account_id, filename, format, format_label, library, status, stage, created_at)
       VALUES ($1, $2, $3, 'x', $4, $5, 'done', $6, $7)`,
      [id, accountId, filename, label, JSON.stringify({ collections: [], notImportable }), stage, createdAt],
    );
    return id;
  };
  const addTarget = (importId, position, name, { status = 'done', items = [], unimported = [] }) =>
    pool.query(
      `INSERT INTO import_targets (import_id, collection_id, position, kind, name, items, status, unimported)
       VALUES ($1, $2, $3, 'playlist', $4, $5, $6, $7)`,
      [importId, `c${position}`, position, name, JSON.stringify(items), status, JSON.stringify(unimported)],
    );

  const yt = await addImport(account, { filename: 'takeout.zip', label: 'YouTube Music', createdAt: '2026-11-01' });
  await addTarget(yt, 0, 'Road Trip', { unimported: [row('yt:1', 'Angela', 'John Lennon', 'not_found_on_tidal'), row('yt:2', 'Fixed Later', 'Band', 'not_found_on_tidal')] });
  await addTarget(yt, 1, 'Chill', { unimported: [row('yt:1', 'Angela', 'John Lennon', 'not_found_on_tidal')] });

  const apple = await addImport(account, {
    filename: 'apple.zip',
    label: 'Apple Music',
    createdAt: '2026-11-05',
    notImportable: [{ path: 'Music/demo.mp3', title: 'Home Demo', artist: 'Me', album: null, reason: 'own_audio_file', linkedKey: null }],
  });
  await addTarget(apple, 0, 'Favourites', {
    items: [{ id: 't9', key: 'yt:2' }], // another import's song, added this time
    unimported: [row('apple:7', 'ANGELA', 'John  Lennon', 'match_not_accepted')],
  });
  // Not loaded yet: nothing from it is "missing".
  await addImport(account, { filename: 'pending.csv', label: 'CSV', createdAt: '2026-11-06', stage: 'match' });
  // Someone else's import is never included.
  const theirs = await addImport(other, { filename: 'theirs.zip', label: 'YouTube Music', createdAt: '2026-11-02' });
  await addTarget(theirs, 0, 'Theirs', { unimported: [row('yt:5', 'Secret', 'Someone', 'not_found_on_tidal')] });

  // A whole record: three tracks of one album, none on TIDAL. A second album also has three
  // missing tracks, but one of its tracks was added, so its tracks stay individual.
  await addTarget(yt, 2, 'Albums', {
    items: [{ id: 't1', key: 'yt:20' }],
    unimported: [
      row('yt:11', 'Song A', 'Obscure Band', 'not_found_on_tidal', { album: 'Lost Tapes' }),
      row('yt:12', 'Song B', 'Obscure Band', 'not_found_on_tidal', { album: 'Lost Tapes' }),
      row('yt:13', 'Song C', 'obscure band', 'match_not_accepted', { album: 'Lost  Tapes' }),
      row('yt:21', 'Half 1', 'Half Band', 'not_found_on_tidal', { album: 'Half There' }),
      row('yt:22', 'Half 2', 'Half Band', 'not_found_on_tidal', { album: 'Half There' }),
      row('yt:23', 'Half 3', 'Half Band', 'not_found_on_tidal', { album: 'Half There' }),
    ],
  });
  await pool.query(
    `INSERT INTO import_tracks (import_id, key, track) VALUES ($1, 'yt:20', $2)`,
    [yt, JSON.stringify({ title: 'Half 0', artistCredit: 'Half Band', album: 'Half There' })],
  );

  const { records, tracks: songs } = await missingAcrossImports(pool, account);
  assert.deepEqual(records.map((r) => [r.artist, r.album, r.tracks.map((s) => s.title)]), [['Obscure Band', 'Lost Tapes', ['Song A', 'Song B', 'Song C']]]);
  assert.deepEqual(records[0].reasons.sort(), ['match_not_accepted', 'not_found_on_tidal']);
  assert.deepEqual(songs.filter((s) => s.artist === 'Half Band').map((s) => s.title), ['Half 1', 'Half 2', 'Half 3']);
  songs.splice(0, songs.length, ...songs.filter((s) => s.artist !== 'Half Band'));
  // Spelling differences don't split a song; the newest import's spelling is shown.
  assert.deepEqual(songs.map((s) => [s.title, s.artist]), [
    ['ANGELA', 'John  Lennon'],
    ['Home Demo', 'Me'],
  ]);
  const angela = songs[0];
  assert.deepEqual(angela.reasons.sort(), ['match_not_accepted', 'not_found_on_tidal']);
  assert.deepEqual(angela.places.map((p) => [p.formatLabel, p.collection]), [
    ['Apple Music', 'Favourites'],
    ['YouTube Music', 'Road Trip'],
    ['YouTube Music', 'Chill'],
  ]);
  assert.equal(songs[1].places[0].collection, 'Your audio files');
  assert.equal(songs[1].places[0].audioFile, 'Music/demo.mp3');
  assert.deepEqual(await missingAcrossImports(pool, crypto.randomUUID()), { records: [], tracks: [] });
});

test('records need enough missing tracks with an album and artist', () => {
  const song = (title, artist, album) => ({ title, artist, album, reasons: ['not_found_on_tidal'], places: [] });
  const songs = [
    song('1', 'A', 'Full'), song('2', 'A', 'Full'), song('3', 'A', 'Full'),
    song('x', 'A', 'Pair'), song('y', 'A', 'Pair'),
    song('n1', null, 'No Artist'), song('n2', null, 'No Artist'), song('n3', null, 'No Artist'),
    song('loose', 'B', null),
  ];
  const { records, tracks } = groupMissingRecords(songs);
  assert.deepEqual(records.map((r) => [r.album, r.tracks.length]), [['Full', 3]]);
  assert.deepEqual(tracks.map((s) => s.title), ['x', 'y', 'n1', 'n2', 'n3', 'loose']);
  assert.deepEqual(groupMissingRecords(songs, new Set(['a|full'])).records, [], 'an album with a track on TIDAL is not missing whole');
  assert.equal(groupMissingRecords(songs, new Set(), 2).records.length, 2);
});
