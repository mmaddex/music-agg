import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeAlbum } from '../src/tidal/albums.js';

/** Album with tracks t1..tN on disc 1 (plus optional disc 2 / named tracks). */
function album(title, specs, albumType = 'ALBUM') {
  const tracks = specs.map((s, i) => ({ id: s.id || `t${i + 1}`, title: s.title || `Song ${i + 1}`, version: s.version || null, trackNumber: s.n || i + 1, volumeNumber: s.disc || 1 }));
  return { title, albumType, tracks, trackIds: tracks.map((t) => t.id) };
}
const plain = (n) => Array.from({ length: n }, () => ({}));
const ids = (...list) => new Set(list);
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => `t${a + i}`);

test('exact: every track present', () => {
  assert.deepEqual(judgeAlbum(album('Album', plain(10)), new Set(range(1, 10))), { complete: true, rule: 'exact', extras: 0 });
});

test('singles are never saved as albums', () => {
  assert.equal(judgeAlbum(album('Song', plain(2), 'SINGLE'), ids('t1', 't2')).complete, false);
});

test('a plain album with tracks missing is not saved', () => {
  const v = judgeAlbum(album('Album', plain(12)), new Set(range(1, 10)));
  assert.equal(v.complete, false);
  assert.match(v.reason, /not an expanded edition/);
});

test('edition: original 10 tracks, TIDAL only has a deluxe with 4 bonus tracks at the end', () => {
  const v = judgeAlbum(album('Album (Deluxe Edition)', plain(14)), new Set(range(1, 10)), ['Album']);
  assert.deepEqual(v, { complete: true, rule: 'edition', extras: 4 });
});

test('edition: whole bonus disc missing', () => {
  const specs = [...plain(9), ...Array.from({ length: 8 }, (_, i) => ({ id: `d2-${i}`, disc: 2, n: i + 1 }))];
  assert.equal(judgeAlbum(album('Album (Expanded Edition)', specs), new Set(range(1, 9))).rule, 'edition');
});

test('edition: missing demos/live versions inside the tracklist are extras', () => {
  const specs = [{}, {}, { title: 'Song 3', version: 'Demo' }, {}, {}, { title: 'Song 6 (Live at Wembley)' }, {}, {}];
  const v = judgeAlbum(album('Album - 20th Anniversary Edition', specs), ids('t1', 't2', 't4', 't5', 't7', 't8'));
  assert.equal(v.complete, true);
  assert.equal(v.extras, 2);
});

test('edition: a missing regular song from the core of the album is not ok', () => {
  const v = judgeAlbum(album('Album (Deluxe)', plain(14)), ids(...range(1, 4), ...range(6, 10)));
  assert.equal(v.complete, false);
  assert.match(v.reason, /Song 5/);
});

test('edition: the first few songs of a long deluxe are not the whole album', () => {
  const v = judgeAlbum(album('Album (Super Deluxe Edition)', plain(20)), new Set(range(1, 4)));
  assert.equal(v.complete, false);
  assert.match(v.reason, /only 4 of 20/);
});

test('edition: needs at least 3 tracks present', () => {
  assert.equal(judgeAlbum(album('EP (Deluxe)', plain(4)), ids('t1', 't2')).complete, false);
});

test("edition: the source's album name must match TIDAL's title without the edition suffix", () => {
  const a = album('Rumours [2004 Remaster]', plain(13));
  assert.equal(judgeAlbum(a, new Set(range(1, 11)), ['Rumours']).complete, true);
  assert.equal(judgeAlbum(a, new Set(range(1, 11)), ['Greatest Hits']).complete, false);
  assert.equal(judgeAlbum(a, new Set(range(1, 11)), [null, undefined]).complete, true, 'no album names in the source: not checked');
});
