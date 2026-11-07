// Read-side TIDAL calls used for matching. Endpoints per the TIDAL API reference:
//   GET /users/me                                         (user.read)
//   GET /tracks?filter[isrc]=...&include=artists,albums
//   GET /searchResults?filter[query]=...&include=tracks.artists,tracks.albums   (search.read)
//   GET /tracks?filter[id]=...&include=albums              (≤ 20 ids per call)
//   GET /albums/{id}?include=items                         album + first page of its tracks
//   GET /albums/{id}/relationships/items?page[cursor]=…    further pages (links.next)

import { indexIncluded } from './client.js';
import { isoDurationToMs } from '../util/text.js';

export async function getMe(client) {
  const doc = await client.get('/users/me');
  const data = Array.isArray(doc.data) ? doc.data[0] : doc.data;
  return {
    id: data.id,
    username: data.attributes?.username || null,
    country: data.attributes?.country || null,
  };
}

/** Flatten a JSON:API track resource (+ included artists/albums) into a candidate. */
export function toCandidate(resource, included) {
  const rel = resource.relationships || {};
  const names = (key, attr) =>
    (rel[key]?.data || []).map((ref) => included.get(`${ref.type}:${ref.id}`)?.attributes?.[attr]).filter(Boolean);
  const a = resource.attributes || {};
  return {
    id: resource.id,
    title: a.title,
    version: a.version || null,
    isrc: a.isrc || null,
    durationMs: isoDurationToMs(a.duration),
    explicit: !!a.explicit,
    artists: names('artists', 'name'),
    albums: names('albums', 'title'),
    albumId: rel.albums?.data?.[0]?.id ?? null,
  };
}

export async function findTracksByIsrc(client, isrc, { countryCode } = {}) {
  const doc = await client.get('/tracks', { 'filter[isrc]': isrc, countryCode, include: 'artists,albums' });
  const included = indexIncluded(doc);
  return (doc.data || []).map((r) => toCandidate(r, included));
}

export async function searchTracks(client, query, { countryCode, limit = 10 } = {}) {
  const doc = await client.get('/searchResults', {
    'filter[query]': query,
    countryCode,
    explicitFilter: 'INCLUDE',
    include: 'tracks.artists,tracks.albums',
  });
  const result = Array.isArray(doc.data) ? doc.data[0] : doc.data;
  const included = indexIncluded(doc);
  const refs = result?.relationships?.tracks?.data || [];
  return refs
    .slice(0, limit)
    .map((ref) => included.get(`${ref.type}:${ref.id}`))
    .filter(Boolean)
    .map((r) => toCandidate(r, included));
}

/** TIDAL album id for each track id: Map(trackId → albumId | null). Batches of 20. */
export async function albumIdsForTracks(client, trackIds, { countryCode } = {}) {
  const out = new Map();
  for (let i = 0; i < trackIds.length; i += 20) {
    const ids = trackIds.slice(i, i + 20);
    const doc = await client.get('/tracks', { 'filter[id]': ids, countryCode, include: 'albums' });
    for (const r of doc.data || []) out.set(String(r.id), r.relationships?.albums?.data?.[0]?.id ?? null);
  }
  return out;
}

/** next links are relative to the API root and may or may not repeat the /v2 prefix. */
const relativeLink = (next) => next.replace(/^https?:\/\/[^/]+/, '').replace(/^\/v2(?=\/)/, '');

/**
 * An album and the ids of every track on it (all volumes, all pages; videos left out).
 * @returns { id, title, albumType, numberOfItems, artists[], trackIds[] }
 */
export async function getAlbumWithTracks(client, albumId, { countryCode } = {}) {
  const doc = await client.get(`/albums/${encodeURIComponent(albumId)}`, { countryCode, include: 'items,artists' });
  const data = Array.isArray(doc.data) ? doc.data[0] : doc.data;
  const included = indexIncluded(doc);
  const a = data?.attributes || {};
  const items = data?.relationships?.items || {};
  const refs = [...(items.data || [])];
  let next = items.links?.next;
  for (let page = 0; next && page < 50; page += 1) {
    const more = await client.get(relativeLink(next));
    refs.push(...(more.data || []));
    next = more.links?.next;
  }
  return {
    id: String(data?.id ?? albumId),
    title: a.title || null,
    albumType: a.albumType || null,
    numberOfItems: a.numberOfItems ?? null,
    artists: (data?.relationships?.artists?.data || []).map((ref) => included.get(`${ref.type}:${ref.id}`)?.attributes?.name).filter(Boolean),
    trackIds: refs.filter((r) => r.type === 'tracks').map((r) => String(r.id)),
  };
}
