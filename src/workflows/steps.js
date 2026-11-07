// The work done by each Render Workflow task, as plain functions with injected deps so they
// can be unit-tested and run in-process during local development.
//
// Durability model — every step is safe to run again from the top:
//   * matchChunk records each track's result as soon as it has it; a retry only processes
//     tracks still marked `pending`.
//   * writeCollection stores the created playlist id, then a batch cursor after every
//     50-track write; a retry resumes at the next batch. Each TIDAL write uses an
//     Idempotency-Key derived from (import, collection, batch), so a write that succeeded just
//     before a crash is replayed by TIDAL rather than applied twice.
//
// Root tasks (matchImport, loadToTidal) record failures on the import and return normally;
// their own retry policy only covers the root instance itself crashing mid-run.
//
// Error policy (the SDK retries any thrown error):
//   * transient (429/5xx/network/timeouts) → throw, so Render retries with backoff
//   * permanent (bad data, 4xx)            → record on the track/collection and carry on
//   * login expired                        → record on the import and stop; user re-logs-in + Retry

import { AuthExpiredError } from '../accounts.js';
import { deterministicKey } from '../crypto.js';
import { enrichYouTubeTracks } from '../enrich/youtube.js';
import { matchTrack } from '../tidal/matcher.js';
import { addAlbumsBatch, addFavoritesBatch, addPlaylistBatch, chunk, createPlaylist } from '../tidal/writer.js';
import { planAlbums } from '../tidal/albums.js';
import * as repo from '../imports/repo.js';
import { log as rootLog, since } from '../util/log.js';

export const MAX_TRACK_ATTEMPTS = 4;
const PROGRESS_EVERY = 25; // tracks
const PROGRESS_MS = 30_000;

export class TransientError extends Error {}

export function isAuthError(err) {
  return err instanceof AuthExpiredError || err?.status === 401;
}

export function isTransient(err) {
  if (err instanceof TransientError) return true;
  if (isAuthError(err)) return false;
  const s = err?.status;
  // No status → network error / timeout / database hiccup.
  return s === undefined || s === null || s === 408 || s === 409 || s === 429 || s >= 500;
}

/** Run fn over items with at most `limit` in flight; returns Promise.allSettled-style results. */
export async function settlePool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

const authMessage = (err) => (err instanceof AuthExpiredError ? err.message : new AuthExpiredError().message);

// ---- matching ---------------------------------------------------------------------------

/**
 * Root of the matching workflow. Splits pending tracks into chunks and runs each chunk as its
 * own task run (own instance, own retries).
 * @param deps { pool, chunkSize, parallelism }
 * @param runChunk (keys) => Promise<result>   — ctx.run(matchChunk, importId, keys)
 */
export async function matchImport(deps, importId, { runChunk }) {
  const { pool, chunkSize = 100, parallelism = 2 } = deps;
  const log = (deps.log || rootLog).child({ importId });
  const startedAt = performance.now();
  const imp = await repo.getImport(pool, importId);
  if (!imp) {
    log.warn('match.skipped', { reason: 'import not found' });
    return { skipped: 'import not found' };
  }
  if (imp.status !== 'matching') {
    log.info('match.skipped', { reason: `import is ${imp.status}` });
    return { skipped: `import is ${imp.status}` };
  }

  const keys = await repo.pendingTrackKeys(pool, importId);
  const chunks = chunk(keys, chunkSize);
  log.info('match.plan', { pendingTracks: keys.length, chunks: chunks.length, chunkSize, parallelism });
  let finished = 0;
  const results = await settlePool(chunks, parallelism, async (chunkKeys, i) => {
    const label = `${i + 1}/${chunks.length}`;
    const chunkStartedAt = performance.now();
    log.info('match.chunk.started', { chunk: label, tracks: chunkKeys.length, firstKey: chunkKeys[0] });
    try {
      const value = await runChunk(chunkKeys);
      finished += 1;
      log.info('match.chunk.finished', { chunk: label, ms: since(chunkStartedAt), done: `${finished}/${chunks.length}`, ...summarizeChunkResult(value) });
      return value;
    } catch (err) {
      finished += 1;
      log.error('match.chunk.failed', { chunk: label, ms: since(chunkStartedAt), done: `${finished}/${chunks.length}`, err });
      throw err;
    }
  });

  const authExpired = results.find((r) => r.status === 'fulfilled' && r.value?.authExpired);
  if (authExpired) {
    await repo.setStatus(pool, importId, 'failed', { error: authExpired.value.message });
    log.warn('match.failed', { reason: 'auth_expired', ms: since(startedAt) });
    return { failed: 'auth' };
  }
  const failures = results.filter((r) => r.status === 'rejected');
  const counts = await repo.trackCounts(pool, importId);
  if (failures.length || counts.pending) {
    const reason = failures[0]?.reason?.message || `${counts.pending} tracks still pending`;
    // Chunks already used their own retries. Record the failure and return normally: a root
    // retry would only re-run the same chunks immediately. The user's Retry resumes later.
    await repo.setStatus(pool, importId, 'failed', { error: `Matching stopped after repeated errors (${reason}). Press Retry to resume.` });
    log.error('match.failed', { reason, failedChunks: failures.length, ms: since(startedAt), ...counts });
    return { failed: reason, counts };
  }
  await repo.setStatus(pool, importId, 'matched');
  log.info('match.finished', { ms: since(startedAt), chunks: chunks.length, ...counts });
  return { counts };
}

/**
 * Match up to ~100 tracks. Each result is written immediately, so a retry continues where
 * this attempt stopped.
 * @param deps { pool, clientFor(accountId, { log }), fetchImpl, log }
 */
export async function matchChunk(deps, importId, keys) {
  const { pool, clientFor, fetchImpl = fetch } = deps;
  const log = (deps.log || rootLog).child({ importId });
  const startedAt = performance.now();
  const imp = await repo.getImport(pool, importId);
  if (!imp || imp.status !== 'matching') {
    log.info('match.chunk.skipped', { reason: imp ? `import is ${imp.status}` : 'import not found', tracks: keys.length });
    return { skipped: true };
  }

  const rows = await repo.pendingTracks(pool, importId, keys);
  const client = clientFor(imp.account_id, { log });
  const cache = new Map();
  let processed = 0;
  let transient = 0;
  let lastTransient = null;
  // Where the time goes, summed over the chunk (ms).
  const time = { youtube: 0, tidal: 0, db: 0 };
  const outcomes = { matched: 0, review: 0, not_found: 0, error: 0, retry_later: 0, gave_up: 0 };
  let lookups = 0;

  const summary = (extra = {}) => ({
    keys: keys.length,
    tracks: rows.length,
    alreadyDone: keys.length - rows.length,
    processed,
    ms: since(startedAt),
    msPerTrack: rows.length ? Math.round(since(startedAt) / rows.length) : 0,
    youtubeLookups: lookups,
    youtubeMs: time.youtube,
    tidalMs: time.tidal,
    dbMs: time.db,
    ...outcomes,
    tidal: { ...client.stats },
    ...extra,
  });

  log.info('match.chunk.begin', { keys: keys.length, tracks: rows.length, firstKey: keys[0], lastKey: keys[keys.length - 1] });

  // A progress line every PROGRESS_EVERY tracks or PROGRESS_MS, so successes show up between
  // the start and end of a chunk, not only warnings.
  let lastProgressAt = performance.now();
  const progress = (done) => {
    const elapsed = since(startedAt);
    log.info('match.chunk.progress', {
      done: `${done}/${rows.length}`,
      ms: elapsed,
      tracksPerMin: elapsed ? Math.round((done / elapsed) * 60_000) : 0,
      ...outcomes,
      tidal: { requests: client.stats.requests, rateLimited: client.stats.rateLimited, retries: client.stats.retries, paceIntervalMs: client.stats.paceIntervalMs },
    });
    lastProgressAt = performance.now();
  };

  for (const [index, row] of rows.entries()) {
    if (index > 0 && (index % PROGRESS_EVERY === 0 || performance.now() - lastProgressAt >= PROGRESS_MS)) progress(index);
    const track = row.track;
    const t = { youtube: 0, tidal: 0, db: 0 };
    const requestsBefore = client.stats.requests;
    let phase = 'youtube';
    let phaseStart = performance.now();
    const endPhase = (next) => {
      const ms = since(phaseStart);
      t[phase] += ms;
      time[phase] += ms;
      phase = next;
      phaseStart = performance.now();
    };
    try {
      if (track.needsLookup && track.source?.type === 'youtube') {
        lookups += 1;
        await enrichYouTubeTracks([track], { fetchImpl, concurrency: 1, log });
        if (track.needsLookup && track.lookupTransient) throw new TransientError(track.lookupError);
      }
      endPhase('tidal');
      const match = await matchTrack(client, track, { countryCode: imp.country_code || 'US', cache });
      endPhase('db');
      await repo.saveTrackResult(pool, importId, row.key, { status: match.status, match, track });
      endPhase(null);
      processed += 1;
      outcomes[match.status] = (outcomes[match.status] || 0) + 1;
      log.debug('match.track', { key: row.key, status: match.status, method: match.method, score: match.best?.score, requests: client.stats.requests - requestsBefore, youtubeMs: t.youtube, tidalMs: t.tidal, dbMs: t.db });
    } catch (err) {
      const failedIn = phase;
      if (phase) endPhase(null);
      if (isAuthError(err)) {
        log.warn('match.chunk.auth_expired', summary({ key: row.key }));
        return { authExpired: true, message: authMessage(err), processed };
      }
      if (isTransient(err)) {
        const attempts = row.attempts + 1;
        if (attempts >= MAX_TRACK_ATTEMPTS) {
          // This one track keeps failing; give up on it rather than blocking the import.
          const match = { status: 'error', reason: `Gave up after ${attempts} attempts: ${err.message}`, best: null, alternatives: [] };
          await repo.saveTrackResult(pool, importId, row.key, { status: 'error', match, track, attempts });
          outcomes.gave_up += 1;
          log.warn('match.track.gave_up', { key: row.key, attempts, phase: failedIn, err });
        } else {
          await repo.saveTrackResult(pool, importId, row.key, { status: 'pending', track, attempts });
          transient += 1;
          lastTransient = err;
          outcomes.retry_later += 1;
          log.warn('match.track.transient_error', { key: row.key, attempts, maxAttempts: MAX_TRACK_ATTEMPTS, phase: failedIn, err });
        }
      } else {
        const match = { status: 'error', reason: err.message, best: null, alternatives: [] };
        await repo.saveTrackResult(pool, importId, row.key, { status: 'error', match, track });
        outcomes.error += 1;
        log.error('match.track.error', { key: row.key, phase: failedIn, err });
      }
    }
  }

  if (transient) {
    log.warn('match.chunk.will_retry', summary());
    // Throwing makes Render retry this chunk with backoff; finished tracks are skipped next time.
    throw new TransientError(`${transient} track(s) hit temporary errors (last: ${lastTransient?.message}); will retry`);
  }
  log.info('match.chunk.done', summary());
  return { processed };
}

/** The parts of a matchChunk result worth repeating in the root's log line. */
function summarizeChunkResult(value) {
  if (!value) return {};
  if (value.skipped) return { skipped: true };
  if (value.authExpired) return { authExpired: true, processed: value.processed };
  return { processed: value.processed };
}

// ---- loading ----------------------------------------------------------------------------

/**
 * Root of the load workflow: writes each collection as its own task run, one at a time
 * (writes for one user share TIDAL's rate limit, and this keeps playlist creation ordered).
 * @param runCollection (collectionId) => Promise<result> — ctx.run(writeCollection, importId, id)
 */
export async function loadToTidal(deps, importId, { runCollection }) {
  const { pool } = deps;
  const log = (deps.log || rootLog).child({ importId });
  const startedAt = performance.now();
  const imp = await repo.getImport(pool, importId);
  if (!imp) {
    log.warn('load.skipped', { reason: 'import not found' });
    return { skipped: 'import not found' };
  }
  if (imp.status !== 'loading') {
    log.info('load.skipped', { reason: `import is ${imp.status}` });
    return { skipped: `import is ${imp.status}` };
  }

  const all = await repo.getTargets(pool, importId);
  const targets = all.filter((t) => t.status !== 'done');
  log.info('load.plan', { collections: all.length, remaining: targets.length, tracks: targets.reduce((n, t) => n + t.items.length, 0) });
  let gaveUp = null;
  for (const [i, t] of targets.entries()) {
    const fields = { collection: `${i + 1}/${targets.length}`, collectionId: t.collection_id, kind: t.kind, tracks: t.items.length };
    const collectionStartedAt = performance.now();
    log.info('load.collection.started', fields);
    try {
      const result = await runCollection(t.collection_id);
      if (result?.authExpired) {
        await repo.setStatus(pool, importId, 'failed', { error: result.message });
        log.warn('load.failed', { ...fields, reason: 'auth_expired', ms: since(startedAt) });
        return { failed: 'auth' };
      }
      log.info('load.collection.finished', { ...fields, ms: since(collectionStartedAt), ...result });
    } catch (err) {
      // writeCollection exhausted its retries. Note it and continue with the others.
      gaveUp ??= err;
      log.error('load.collection.gave_up', { ...fields, ms: since(collectionStartedAt), err });
      await repo.updateTarget(pool, importId, t.collection_id, { error: `Stopped after repeated errors: ${err.message}. Press Retry to resume.` });
    }
  }
  if (gaveUp) {
    await repo.setStatus(pool, importId, 'failed', { error: 'Some collections could not be finished. Press Retry to resume where they stopped.' });
    log.error('load.failed', { reason: gaveUp.message, ms: since(startedAt) });
    return { failed: gaveUp.message };
  }
  await repo.setStatus(pool, importId, 'done');
  log.info('load.finished', { collections: targets.length, ms: since(startedAt) });
  return { done: true };
}

/**
 * Create one playlist (or fill favourites), checkpointing after every write.
 *
 * Favourites: first works out which albums are present in full (planAlbums) and saves the plan,
 * then saves those albums, then adds the remaining tracks. Tracks of a saved album aren't also
 * added one by one.
 *
 * Tracks TIDAL reports as NOT_FOUND, and tracks left unwritten when a collection fails for
 * good, are appended to the collection's "not imported" record.
 */
export async function writeCollection(deps, importId, collectionId) {
  const { pool, clientFor } = deps;
  const log = (deps.log || rootLog).child({ importId, collectionId });
  const startedAt = performance.now();
  const imp = await repo.getImport(pool, importId);
  if (!imp || imp.status !== 'loading') {
    log.info('load.write.skipped', { reason: imp ? `import is ${imp.status}` : 'import not found' });
    return { skipped: true };
  }
  let t = await repo.getTarget(pool, importId, collectionId);
  if (!t || t.status === 'done') {
    log.info('load.write.skipped', { reason: t ? 'already done' : 'target not found' });
    return { skipped: true };
  }

  const client = clientFor(imp.account_id, { log });
  const key = (...parts) => deterministicKey(importId, collectionId, ...parts);
  const countryCode = imp.country_code || 'US';
  let batchesDone = t.batches_done;

  // Describe tracks (by TIDAL id, from this collection's items) for the "not imported" record.
  const describe = async (ids, reason, detail) => {
    const wanted = new Set(ids.map(String));
    const items = t.items.filter((i) => wanted.has(String(i.id)));
    const src = await repo.sourceTracks(pool, importId, items.map((i) => i.key).filter(Boolean));
    return items.map((i) => {
      const tr = src.get(i.key);
      return repo.notImported(tr, i.key || null, { reason, detail: detail || `TIDAL track ${i.id}` });
    });
  };

  try {
    if (t.kind === 'playlist' && !t.tidal_playlist_id) {
      const pl = await createPlaylist(
        client,
        { name: t.name, description: t.description, createdAt: t.created_at_source },
        { idempotencyKey: key('create') },
      );
      await repo.updateTarget(pool, importId, collectionId, { tidal_playlist_id: pl.id });
      t = { ...t, tidal_playlist_id: pl.id };
      log.info('load.playlist.created', { playlistId: pl.id });
    }

    // ---- favourites: whole albums ----
    if (t.kind === 'favorites' && t.albums === null && t.batches_done === 0) {
      const planStartedAt = performance.now();
      let plan;
      try {
        plan = await planAlbums(client, t.items, { countryCode, log });
      } catch (err) {
        if (isAuthError(err) || isTransient(err)) throw err;
        // Album lookups failing for good must not block favourites: add every track instead.
        log.warn('load.albums.plan_failed', { err, action: 'adding all tracks individually' });
        plan = { albums: [], items: t.items, checked: 0 };
      }
      // Saved in one statement: the album list and the reduced track list replace each other.
      await repo.updateTarget(pool, importId, collectionId, { albums: JSON.stringify(plan.albums), items: JSON.stringify(plan.items) });
      log.info('load.albums.planned', { albumsChecked: plan.checked, wholeAlbums: plan.albums.length, expandedEditions: plan.albums.filter((a) => a.rule === 'edition').length, tracksInAlbums: t.items.length - plan.items.length, looseTracks: plan.items.length, ms: since(planStartedAt) });
      t = { ...t, albums: plan.albums, items: plan.items };
    }
    let albumsAdded = t.albums_added;
    if (t.kind === 'favorites' && t.albums?.length) {
      const albumBatches = chunk(t.albums.map((a) => a.id));
      for (let i = t.albums_done; i < albumBatches.length; i += 1) {
        const res = await addAlbumsBatch(client, albumBatches[i], { idempotencyKey: key('albums', i) });
        albumsAdded += res.added;
        await repo.updateTarget(pool, importId, collectionId, { albums_done: i + 1, albums_added: albumsAdded });
        log.info('load.albums.saved', { batch: `${i + 1}/${albumBatches.length}`, albums: albumBatches[i].length, added: res.added, alreadySaved: res.skipped - res.notFound.length, unavailable: res.notFound.length });
        if (res.notFound.length) {
          // Rare (album withdrawn between planning and saving): add its tracks individually
          // instead. Safe to change the track list here: no track batch has been written yet.
          const gone = new Set(res.notFound);
          const lost = t.albums.filter((a) => gone.has(String(a.id)));
          const fallback = lost.flatMap((a) => a.items || []);
          t = { ...t, items: [...t.items, ...fallback] };
          await repo.updateTarget(pool, importId, collectionId, { items: JSON.stringify(t.items) });
          log.warn('load.albums.unavailable', { albumIds: res.notFound.join(','), titles: lost.map((a) => a.title).join(' | '), tracksAddedInstead: fallback.length });
        }
      }
    }

    // ---- tracks ----
    const batches = chunk(t.items);
    let added = t.added;
    let skipped = t.skipped;
    log.info('load.write.begin', { kind: t.kind, playlistId: t.tidal_playlist_id, tracks: t.items.length, albums: t.albums?.length ?? 0, batches: batches.length, resumeAtBatch: t.batches_done });
    for (let i = t.batches_done; i < batches.length; i += 1) {
      const batchStartedAt = performance.now();
      const idempotencyKey = key('batch', i, t.tidal_playlist_id || 'favorites');
      const res =
        t.kind === 'favorites'
          ? await addFavoritesBatch(client, batches[i], { idempotencyKey })
          : await addPlaylistBatch(client, t.tidal_playlist_id, batches[i], { idempotencyKey });
      added += res.added;
      skipped += res.skipped;
      const unavailable = res.notFound.length ? await describe(res.notFound, 'unavailable_on_tidal', 'TIDAL refused this track (not available for your account or country)') : [];
      await repo.updateTargetAndRecord(pool, importId, collectionId, { batches_done: i + 1, added, skipped }, unavailable);
      batchesDone = i + 1;
      if (unavailable.length) log.warn('load.tracks.unavailable', { batch: `${i + 1}/${batches.length}`, count: unavailable.length, trackIds: res.notFound.join(',') });
      log.debug('load.batch', { batch: `${i + 1}/${batches.length}`, items: batches[i].length, added: res.added, skipped: res.skipped, ms: since(batchStartedAt) });
    }
    await repo.updateTarget(pool, importId, collectionId, { status: 'done', error: null });
    log.info('load.write.done', { added, skipped, albumsAdded, ms: since(startedAt), tidal: { ...client.stats } });
    return t.kind === 'favorites' ? { added, skipped, albumsAdded } : { added, skipped };
  } catch (err) {
    const fields = { ms: since(startedAt), playlistId: t.tidal_playlist_id, batchesDone, tidal: { ...client.stats }, err };
    if (isAuthError(err)) {
      log.warn('load.write.auth_expired', fields);
      return { authExpired: true, message: authMessage(err) };
    }
    if (isTransient(err)) {
      log.warn('load.write.will_retry', fields);
      throw err; // Render retries; we resume from the saved batch
    }
    log.error('load.write.failed', fields);
    // Everything not yet written goes on the record (Retry clears these rows and resumes).
    const left = t.items.slice(batchesDone * 50).map((i) => i.id);
    const unwritten = await describe(left, 'write_failed', err.message);
    await repo.updateTargetAndRecord(pool, importId, collectionId, { status: 'failed', error: err.message }, unwritten);
    return { failed: err.message };
  }
}
