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
import { addFavoritesBatch, addPlaylistBatch, chunk, createPlaylist } from '../tidal/writer.js';
import * as repo from '../imports/repo.js';

export const MAX_TRACK_ATTEMPTS = 4;

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
  const imp = await repo.getImport(pool, importId);
  if (!imp) return { skipped: 'import not found' };
  if (imp.status !== 'matching') return { skipped: `import is ${imp.status}` };

  const keys = await repo.pendingTrackKeys(pool, importId);
  const results = await settlePool(chunk(keys, chunkSize), parallelism, (chunkKeys) => runChunk(chunkKeys));

  const authExpired = results.find((r) => r.status === 'fulfilled' && r.value?.authExpired);
  if (authExpired) {
    await repo.setStatus(pool, importId, 'failed', { error: authExpired.value.message });
    return { failed: 'auth' };
  }
  const failures = results.filter((r) => r.status === 'rejected');
  const counts = await repo.trackCounts(pool, importId);
  if (failures.length || counts.pending) {
    const reason = failures[0]?.reason?.message || `${counts.pending} tracks still pending`;
    // Chunks already used their own retries. Record the failure and return normally: a root
    // retry would only re-run the same chunks immediately. The user's Retry resumes later.
    await repo.setStatus(pool, importId, 'failed', { error: `Matching stopped after repeated errors (${reason}). Press Retry to resume.` });
    return { failed: reason, counts };
  }
  await repo.setStatus(pool, importId, 'matched');
  return { counts };
}

/**
 * Match up to ~100 tracks. Each result is written immediately, so a retry continues where
 * this attempt stopped.
 * @param deps { pool, clientFor(accountId), fetchImpl }
 */
export async function matchChunk(deps, importId, keys) {
  const { pool, clientFor, fetchImpl = fetch } = deps;
  const imp = await repo.getImport(pool, importId);
  if (!imp || imp.status !== 'matching') return { skipped: true };

  const rows = await repo.pendingTracks(pool, importId, keys);
  const client = clientFor(imp.account_id);
  const cache = new Map();
  let processed = 0;
  let transient = 0;
  let lastTransient = null;

  for (const row of rows) {
    const track = row.track;
    try {
      if (track.needsLookup && track.source?.type === 'youtube') {
        await enrichYouTubeTracks([track], { fetchImpl, concurrency: 1 });
        if (track.needsLookup && track.lookupTransient) throw new TransientError(track.lookupError);
      }
      const match = await matchTrack(client, track, { countryCode: imp.country_code || 'US', cache });
      await repo.saveTrackResult(pool, importId, row.key, { status: match.status, match, track });
      processed += 1;
    } catch (err) {
      if (isAuthError(err)) return { authExpired: true, message: authMessage(err), processed };
      if (isTransient(err)) {
        const attempts = row.attempts + 1;
        if (attempts >= MAX_TRACK_ATTEMPTS) {
          // This one track keeps failing; give up on it rather than blocking the import.
          const match = { status: 'error', reason: `Gave up after ${attempts} attempts: ${err.message}`, best: null, alternatives: [] };
          await repo.saveTrackResult(pool, importId, row.key, { status: 'error', match, track, attempts });
        } else {
          await repo.saveTrackResult(pool, importId, row.key, { status: 'pending', track, attempts });
          transient += 1;
          lastTransient = err;
        }
      } else {
        const match = { status: 'error', reason: err.message, best: null, alternatives: [] };
        await repo.saveTrackResult(pool, importId, row.key, { status: 'error', match, track });
      }
    }
  }

  if (transient) {
    // Throwing makes Render retry this chunk with backoff; finished tracks are skipped next time.
    throw new TransientError(`${transient} track(s) hit temporary errors (last: ${lastTransient?.message}); will retry`);
  }
  return { processed };
}

// ---- loading ----------------------------------------------------------------------------

/**
 * Root of the load workflow: writes each collection as its own task run, one at a time
 * (writes for one user share TIDAL's rate limit, and this keeps playlist creation ordered).
 * @param runCollection (collectionId) => Promise<result> — ctx.run(writeCollection, importId, id)
 */
export async function loadToTidal(deps, importId, { runCollection }) {
  const { pool } = deps;
  const imp = await repo.getImport(pool, importId);
  if (!imp) return { skipped: 'import not found' };
  if (imp.status !== 'loading') return { skipped: `import is ${imp.status}` };

  const targets = (await repo.getTargets(pool, importId)).filter((t) => t.status !== 'done');
  let gaveUp = null;
  for (const t of targets) {
    try {
      const result = await runCollection(t.collection_id);
      if (result?.authExpired) {
        await repo.setStatus(pool, importId, 'failed', { error: result.message });
        return { failed: 'auth' };
      }
    } catch (err) {
      // writeCollection exhausted its retries. Note it and continue with the others.
      gaveUp ??= err;
      await repo.updateTarget(pool, importId, t.collection_id, { error: `Stopped after repeated errors: ${err.message}. Press Retry to resume.` });
    }
  }
  if (gaveUp) {
    await repo.setStatus(pool, importId, 'failed', { error: 'Some collections could not be finished. Press Retry to resume where they stopped.' });
    return { failed: gaveUp.message };
  }
  await repo.setStatus(pool, importId, 'done');
  return { done: true };
}

/** Create one playlist (or fill favourites), checkpointing after every batch. */
export async function writeCollection(deps, importId, collectionId) {
  const { pool, clientFor } = deps;
  const imp = await repo.getImport(pool, importId);
  if (!imp || imp.status !== 'loading') return { skipped: true };
  let t = await repo.getTarget(pool, importId, collectionId);
  if (!t || t.status === 'done') return { skipped: true };

  const client = clientFor(imp.account_id);
  const key = (...parts) => deterministicKey(importId, collectionId, ...parts);

  try {
    if (t.kind === 'playlist' && !t.tidal_playlist_id) {
      const pl = await createPlaylist(
        client,
        { name: t.name, description: t.description, createdAt: t.created_at_source },
        { idempotencyKey: key('create') },
      );
      await repo.updateTarget(pool, importId, collectionId, { tidal_playlist_id: pl.id });
      t = { ...t, tidal_playlist_id: pl.id };
    }

    const batches = chunk(t.items);
    let added = t.added;
    let skipped = t.skipped;
    for (let i = t.batches_done; i < batches.length; i += 1) {
      const idempotencyKey = key('batch', i, t.tidal_playlist_id || 'favorites');
      const res =
        t.kind === 'favorites'
          ? await addFavoritesBatch(client, batches[i], { idempotencyKey })
          : await addPlaylistBatch(client, t.tidal_playlist_id, batches[i], { idempotencyKey });
      added += res.added;
      skipped += res.skipped;
      await repo.updateTarget(pool, importId, collectionId, { batches_done: i + 1, added, skipped });
    }
    await repo.updateTarget(pool, importId, collectionId, { status: 'done', error: null });
    return { added, skipped };
  } catch (err) {
    if (isAuthError(err)) return { authExpired: true, message: authMessage(err) };
    if (isTransient(err)) throw err; // Render retries; we resume from the saved batch
    await repo.updateTarget(pool, importId, collectionId, { status: 'failed', error: err.message });
    return { failed: err.message };
  }
}
