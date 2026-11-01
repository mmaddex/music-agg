// The two long-running steps of an import:
//   runMatch  — enrich source tracks and find each one on TIDAL (read-only)
//   runImport — create playlists / add favourites on TIDAL using the user's decisions

import { enrichYouTubeTracks } from './enrich/youtube.js';
import { matchTrack } from './tidal/matcher.js';
import { addFavoriteTracks, addPlaylistItems, createPlaylist } from './tidal/writer.js';

const MATCH_CONCURRENCY = 3;

export async function runMatch({ library, collectionIds, client, countryCode, update, fetchImpl }) {
  const selected = library.collections.filter((c) => collectionIds.includes(c.id));
  if (!selected.length) throw new Error('Choose at least one playlist or library to import.');

  // Same song in several playlists → look it up once.
  const unique = new Map();
  for (const c of selected) for (const t of c.tracks) if (!unique.has(t.key)) unique.set(t.key, t);
  const tracks = [...unique.values()];

  const needLookup = tracks.filter((t) => t.needsLookup);
  if (needLookup.length) {
    update({ phase: 'Looking up YouTube video titles', done: 0, total: needLookup.length });
    await enrichYouTubeTracks(needLookup, {
      fetchImpl,
      onProgress: (done, total) => update({ done, total }),
    });
  }

  update({ phase: 'Searching TIDAL', done: 0, total: tracks.length });
  const results = new Map();
  const cache = new Map();
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < tracks.length) {
      const track = tracks[next];
      next += 1;
      try {
        results.set(track.key, await matchTrack(client, track, { countryCode, cache }));
      } catch (err) {
        if (err.status === 401 || err.status === 403) throw err; // auth problems affect everything
        results.set(track.key, { status: 'error', reason: err.message, best: null, alternatives: [] });
      }
      done += 1;
      update({ done });
    }
  }
  await Promise.all(Array.from({ length: Math.min(MATCH_CONCURRENCY, tracks.length) }, worker));

  const stats = { matched: 0, review: 0, not_found: 0, error: 0 };
  const trackOut = {};
  for (const t of tracks) {
    const match = results.get(t.key);
    stats[match.status] += 1;
    trackOut[t.key] = {
      title: t.title,
      artistCredit: t.artistCredit,
      album: t.album,
      source: t.source,
      videoTitle: t.videoTitle || null,
      match,
    };
  }

  return {
    countryCode,
    stats,
    tracks: trackOut,
    collections: selected.map((c) => ({
      id: c.id,
      kind: c.kind,
      name: c.name,
      description: c.description,
      createdAt: c.createdAt,
      items: c.tracks.map((t) => ({ key: t.key, addedAt: t.addedAt })),
    })),
  };
}

/**
 * @param {object} matchResult  result of runMatch
 * @param {Array<{id, name?}>} targets  collections to write, with optional renamed playlist names
 * @param {Record<string, string|null>} decisions  per-track overrides: key → TIDAL track id, or null to skip.
 *        Tracks without a decision use the match if its status is "matched".
 */
export async function runImport({ matchResult, targets, decisions = {}, client, update }) {
  const byId = new Map(matchResult.collections.map((c) => [c.id, c]));
  const plan = targets
    .map((t) => ({ target: t, collection: byId.get(t.id) }))
    .filter((p) => p.collection);
  if (!plan.length) throw new Error('Nothing selected to import.');

  const resolve = (key) => {
    if (Object.hasOwn(decisions, key)) return decisions[key] || null;
    const m = matchResult.tracks[key]?.match;
    return m?.status === 'matched' ? m.best.id : null;
  };

  const work = plan.map(({ target, collection }) => {
    const seen = new Set();
    const items = [];
    for (const item of collection.items) {
      const id = resolve(item.key);
      if (!id || seen.has(id)) continue; // also collapses two videos that map to one TIDAL track
      seen.add(id);
      items.push({ id, addedAt: item.addedAt });
    }
    return { target, collection, items, skipped: collection.items.length - items.length };
  });

  const total = work.reduce((n, w) => n + w.items.length, 0);
  let written = 0;
  const report = [];

  for (const { target, collection, items, skipped } of work) {
    const name = (target.name || collection.name).trim() || collection.name;
    update({ phase: `Importing “${name}”`, done: written, total });
    const entry = { id: collection.id, kind: collection.kind, name, added: 0, skipped, playlistId: null, url: null, error: null };
    try {
      if (collection.kind === 'favorites') {
        entry.added = await addFavoriteTracks(client, items, { onProgress: (n) => update({ done: written + n }) });
        entry.url = 'https://tidal.com/my-collection/tracks';
      } else {
        const pl = await createPlaylist(client, { name, description: collection.description, createdAt: collection.createdAt });
        entry.playlistId = pl.id;
        entry.url = `https://tidal.com/playlist/${pl.id}`;
        entry.added = items.length ? await addPlaylistItems(client, pl.id, items, { onProgress: (n) => update({ done: written + n }) }) : 0;
      }
    } catch (err) {
      if (err.status === 401) throw err;
      entry.error = err.message;
    }
    written += items.length;
    update({ done: written });
    report.push(entry);
  }
  return { collections: report };
}
