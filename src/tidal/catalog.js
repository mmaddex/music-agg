// Read-side TIDAL calls used for matching. Endpoints per the TIDAL API reference:
//   GET /users/me                                         (user.read)
//   GET /tracks?filter[isrc]=...&include=artists,albums
//   GET /searchResults?filter[query]=...&include=tracks.artists,tracks.albums   (search.read)

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
