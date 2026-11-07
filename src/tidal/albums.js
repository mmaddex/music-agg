// Decide which albums to save whole instead of as loose favourite tracks.
//
// An album is saved when EVERY track TIDAL lists on it (all volumes; videos ignored) is among
// the tracks being added, and it isn't a SINGLE. Those tracks are then not added one by one, so
// My Collection › Tracks doesn't fill up with pieces of albums that are saved anyway.
//
// "Every track" is judged by TIDAL track id, so it only counts tracks the matcher resolved to
// that same release. If some songs matched a different release (a deluxe edition, a
// compilation, a single), the album isn't complete and its tracks are added individually.

import { albumIdsForTracks, getAlbumWithTracks } from './catalog.js';

/**
 * @param items [{ id, albumId?, ... }] favourite tracks about to be written
 * @returns { albums: [{ id, title, artists, trackCount, items }], items: remaining items, checked }
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
    if (!byAlbum.has(item.albumId)) byAlbum.set(item.albumId, new Set());
    byAlbum.get(item.albumId).add(String(item.id));
  }

  const albums = [];
  const covered = new Set();
  let checked = 0;
  for (const [albumId, present] of byAlbum) {
    if (present.size < 2) continue; // one track can't be a whole album worth saving
    checked += 1;
    const album = await getAlbumWithTracks(client, albumId, { countryCode });
    const missingTracks = album.trackIds.filter((id) => !present.has(id));
    const complete = album.albumType !== 'SINGLE' && album.trackIds.length >= 2 && missingTracks.length === 0;
    log?.debug('load.album.checked', { albumId, title: album.title, albumType: album.albumType, tracks: album.trackIds.length, present: present.size, missing: missingTracks.length, complete });
    if (!complete) continue;
    const onAlbum = new Set(album.trackIds);
    albums.push({ id: album.id, title: album.title, artists: album.artists, trackCount: album.trackIds.length, items: items.filter((i) => onAlbum.has(String(i.id))) });
    for (const id of album.trackIds) covered.add(id);
  }

  return { albums, items: items.filter((i) => !covered.has(String(i.id))), checked };
}
