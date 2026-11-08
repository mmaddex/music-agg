// The cross-import "missing songs" list: merged per song, and songs another import added are dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { hasDb, testPool } from './helpers/db.js';
import { missingAcrossImports } from '../src/imports/repo.js';

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

  const songs = await missingAcrossImports(pool, account);
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
  assert.deepEqual(await missingAcrossImports(pool, crypto.randomUUID()), []);
});
