// Decide which albums to save whole instead of as loose favourite tracks.
//
// An album is saved when the source has all of it, judged two ways:
//
//   exact    every track TIDAL lists on the album (all volumes; videos ignored) is among the
//            tracks being added, and it isn't a SINGLE.
//
//   edition  TIDAL's release is an expanded edition (Deluxe, Expanded, Anniversary, Remastered…)
//            with songs the source never had, because TIDAL has no plain edition to match. Saved
//            when, in album order, every track up to the last one present is present or is an
//            obvious extra (Demo, Live, Remix, Bonus…); everything after it is the bonus tail
//            (incl. extra discs); at least half the edition's tracks and at least 3 are present;
//            and, where the source has album names, they match TIDAL's title without the
//            edition suffix.
//
// Tracks of a saved album aren't also added one by one, so My Collection › Tracks doesn't fill
// up with pieces of albums that are saved anyway.
//
// Presence is judged by TIDAL track id, so it only counts songs the matcher resolved to that
// same release. Songs matched to a different release (a compilation, a single) make the album
// look incomplete, and its tracks are added individually.

import { albumIdsForTracks, getAlbumWithTracks } from './catalog.js';
import { normalize, similarity } from '../util/text.js';

const EDITION_WORDS = String.raw`deluxe|super deluxe|expanded|special|anniversary|bonus|collector'?s|legacy|platinum|tour|extended|remaster(?:ed)?|reissue|complete|edition|version`;
const EDITION = new RegExp(String.raw`\b(?:${EDITION_WORDS})\b`, 'i');
// "(Deluxe Edition)", "[2011 Remaster]", " - 25th Anniversary Edition"
const EDITION_SUFFIX = new RegExp(String.raw`\s*(?:[(\[][^)\]]*\b(?:${EDITION_WORDS})\b[^)\]]*[)\]]|[-–:]\s*[^-–:]*\b(?:${EDITION_WORDS})\b.*$)`, 'gi');
const EXTRA = /\b(?:bonus|demo|live|remix|mix|acoustic|instrumental|alternate|alt|edit|outtake|session|commentary|b-side|rehearsal|take|unplugged|stripped|radio|karaoke|a cappella|version)\b/i;

export const MIN_EDITION_TRACKS = 3;
export const MIN_EDITION_SHARE = 0.5;

/** "Album (Deluxe Edition)" → "album" (normalized) */
export function baseAlbumTitle(title) {
  return normalize(String(title || '').replace(EDITION_SUFFIX, '')) || normalize(title);
}

const isExtra = (t) => EXTRA.test(`${t.title || ''} ${t.version || ''}`);

/**
 * Is `album` (from getAlbumWithTracks) present in full? present: Set of TIDAL track ids being
 * added; sourceAlbums: album names the source gave those tracks.
 * @returns { complete, rule?, extras?, reason? }
 */
export function judgeAlbum(album, present, sourceAlbums = []) {
  if (album.albumType === 'SINGLE') return { complete: false, reason: 'single' };
  const tracks = album.tracks || album.trackIds.map((id) => ({ id }));
  if (tracks.length < 2) return { complete: false, reason: 'too short' };
  const missing = tracks.filter((t) => !present.has(t.id));
  if (!missing.length) return { complete: true, rule: 'exact', extras: 0 };

  if (!EDITION.test(album.title || '')) return { complete: false, reason: `missing ${missing.length}, not an expanded edition` };
  const have = tracks.length - missing.length;
  if (have < MIN_EDITION_TRACKS || have < Math.ceil(tracks.length * MIN_EDITION_SHARE)) {
    return { complete: false, reason: `only ${have} of ${tracks.length} tracks present` };
  }
  const last = tracks.reduce((idx, t, i) => (present.has(t.id) ? i : idx), -1);
  const gap = tracks.slice(0, last + 1).find((t) => !present.has(t.id) && !isExtra(t));
  if (gap) return { complete: false, reason: `missing "${gap.title || gap.id}" from the core of the album` };
  const names = [...new Set(sourceAlbums.filter(Boolean).map(baseAlbumTitle))];
  if (names.length && !names.some((n) => similarity(n, baseAlbumTitle(album.title)) >= 0.8)) {
    return { complete: false, reason: `source album "${names[0]}" doesn't match "${album.title}"` };
  }
  return { complete: true, rule: 'edition', extras: missing.length };
}

/**
 * @param items [{ id, albumId?, sourceAlbum?, ... }] favourite tracks about to be written
 * @returns { albums: [{ id, title, artists, trackCount, rule, extras, items }], items: remaining items, checked }
 *          each album keeps its tracks' items so they can still be added if saving it fails
 */
export async function planAlbums(client, items, { countryCode = 'US', log } = {}) {
  if (items.length < 2) return { albums: [], items, checked: 0 };
  // Matches made before album ids were recorded don't have one: look them up (20 per call).
  const missing = items.filter((i) => !i.albumId).map((i) => i.id);
  if (missing.length) {
    const found = await albumIdsForTracks(client, missing, { countryCode });
    items = items.map((i) => (i.albumId ? i : { ...i, albumId: found.get(String(i.id)) ?? null }));
  }

  const byAlbum = new Map();
  for (const item of items) {
    if (!item.albumId) continue;
    if (!byAlbum.has(item.albumId)) byAlbum.set(item.albumId, []);
    byAlbum.get(item.albumId).push(item);
  }

  const albums = [];
  const covered = new Set();
  let checked = 0;
  for (const [albumId, group] of byAlbum) {
    const present = new Set(group.map((i) => String(i.id)));
    if (present.size < 2) continue; // one track can't be a whole album worth saving
    checked += 1;
    const album = await getAlbumWithTracks(client, albumId, { countryCode });
    const verdict = judgeAlbum(album, present, group.map((i) => i.sourceAlbum));
    log?.debug('load.album.checked', { albumId, title: album.title, albumType: album.albumType, tracks: album.trackIds.length, present: present.size, ...verdict });
    if (!verdict.complete) continue;
    const onAlbum = new Set(album.trackIds);
    albums.push({ id: album.id, title: album.title, artists: album.artists, trackCount: album.trackIds.length, rule: verdict.rule, extras: verdict.extras, items: group.filter((i) => onAlbum.has(String(i.id))) });
    for (const id of album.trackIds) covered.add(id);
  }

  return { albums, items: items.filter((i) => !covered.has(String(i.id))), checked };
}
