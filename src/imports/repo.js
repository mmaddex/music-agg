// Data access for imports and their checkpoints (import_tracks, import_targets).

import crypto from 'node:crypto';
import { tx } from '../db/pool.js';
import { normalize } from '../util/text.js';

export const ACTIVE_STATUSES = ['matching', 'loading'];

export async function createImport(pool, { accountId, filename, library }) {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO imports (id, account_id, filename, format, format_label, library, warnings, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'parsed')`,
    [id, accountId, filename, library.format, library.formatLabel, JSON.stringify({ collections: library.collections, notImportable: library.notImportable || [] }), JSON.stringify(library.warnings || [])],
  );
  return id;
}

/** Fetch an import; pass accountId to enforce ownership. */
export async function getImport(db, id, accountId = null) {
  const { rows } = await db.query(
    `SELECT * FROM imports WHERE id = $1 ${accountId ? 'AND account_id = $2' : ''}`,
    accountId ? [id, accountId] : [id],
  );
  return rows[0] || null;
}

export async function listImports(pool, accountId, limit = 10) {
  const { rows } = await pool.query(
    `SELECT id, filename, format_label, status, stage, error, stopped_reason, match_run_id, load_run_id, created_at, updated_at
       FROM imports WHERE account_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [accountId, limit],
  );
  return rows;
}

export async function setStatus(db, id, status, { stage, error = null, runField, runId } = {}) {
  const sets = ['status = $2', 'error = $3', 'updated_at = now()'];
  const args = [id, status, error];
  if (stage !== undefined) {
    args.push(stage);
    sets.push(`stage = $${args.length}`);
  }
  if (runField) {
    args.push(runId);
    sets.push(`${runField === 'load' ? 'load_run_id' : 'match_run_id'} = $${args.length}`);
  }
  await db.query(`UPDATE imports SET ${sets.join(', ')} WHERE id = $1`, args);
}

/**
 * Mark an active import as stopped because its workflow run ended without finishing it.
 * Only applies if the import is still in that status and still points at that run, so a run
 * that finished normally, or a newer dispatch, is never overwritten.
 * @returns true if the import was updated
 */
export async function markStopped(db, imp, { reason, error }) {
  const runCol = imp.status === 'loading' ? 'load_run_id' : 'match_run_id';
  const runId = imp.status === 'loading' ? imp.load_run_id : imp.match_run_id;
  const { rowCount } = await db.query(
    `UPDATE imports SET status = 'failed', stopped_reason = $3, error = $4, updated_at = now()
      WHERE id = $1 AND status = $2 AND ${runCol} = $5`,
    [imp.id, imp.status, reason, error, runId],
  );
  return rowCount > 0;
}

export async function bumpDispatchCount(pool, id) {
  const { rows } = await pool.query('UPDATE imports SET dispatch_count = dispatch_count + 1 WHERE id = $1 RETURNING dispatch_count', [id]);
  return rows[0].dispatch_count;
}

// ---- matching -------------------------------------------------------------------------

/**
 * Record which collections to match and create a pending checkpoint row per unique track.
 * Tracks already matched by an earlier run keep their result.
 */
export async function prepareMatch(pool, imp, collectionIds, countryCode) {
  const selected = imp.library.collections.filter((c) => collectionIds.includes(c.id));
  if (!selected.length) throw new Error('Choose at least one playlist or library to import.');
  const unique = new Map();
  for (const c of selected) for (const t of c.tracks) if (!unique.has(t.key)) unique.set(t.key, t);

  await tx(pool, async (db) => {
    await db.query(
      `UPDATE imports SET selected = $2, country_code = $3, status = 'matching', stage = 'match', error = NULL, updated_at = now() WHERE id = $1`,
      [imp.id, JSON.stringify(selected.map((c) => c.id)), countryCode],
    );
    const keys = [...unique.keys()];
    await db.query('DELETE FROM import_tracks WHERE import_id = $1 AND NOT (key = ANY($2::text[]))', [imp.id, keys]);
    // Errors from a previous run get another chance.
    await db.query(`UPDATE import_tracks SET status = 'pending', attempts = 0 WHERE import_id = $1 AND status = 'error'`, [imp.id]);
    const tracks = [...unique.values()];
    for (let i = 0; i < tracks.length; i += 500) {
      const slice = tracks.slice(i, i + 500);
      await db.query(
        `INSERT INTO import_tracks (import_id, key, track)
         SELECT $1, k, t FROM unnest($2::text[], $3::jsonb[]) AS u(k, t)
         ON CONFLICT (import_id, key) DO NOTHING`,
        [imp.id, slice.map((t) => t.key), slice.map((t) => JSON.stringify(t))],
      );
    }
  });
  return unique.size;
}

export async function pendingTrackKeys(db, importId) {
  const { rows } = await db.query(`SELECT key FROM import_tracks WHERE import_id = $1 AND status = 'pending' ORDER BY key`, [importId]);
  return rows.map((r) => r.key);
}

export async function pendingTracks(db, importId, keys) {
  const { rows } = await db.query(
    `SELECT key, track, attempts FROM import_tracks WHERE import_id = $1 AND key = ANY($2::text[]) AND status = 'pending' ORDER BY key`,
    [importId, keys],
  );
  return rows;
}

export async function saveTrackResult(db, importId, key, { status, match = null, track, attempts }) {
  await db.query(
    `UPDATE import_tracks
        SET status = $3, match = $4, track = COALESCE($5, track), attempts = COALESCE($6, attempts), updated_at = now()
      WHERE import_id = $1 AND key = $2`,
    [importId, key, status, match ? JSON.stringify(match) : null, track ? JSON.stringify(track) : null, attempts ?? null],
  );
}

export async function trackCounts(db, importId) {
  const { rows } = await db.query('SELECT status, count(*)::int AS n FROM import_tracks WHERE import_id = $1 GROUP BY status', [importId]);
  const counts = { pending: 0, matched: 0, review: 0, not_found: 0, error: 0 };
  for (const r of rows) counts[r.status] = r.n;
  counts.total = Object.values(counts).reduce((a, b) => a + b, 0);
  return counts;
}

/** Everything the review screen needs. */
export async function matchResults(db, imp) {
  const { rows } = await db.query('SELECT key, track, status, match FROM import_tracks WHERE import_id = $1', [imp.id]);
  const tracks = {};
  for (const r of rows) {
    const t = r.track;
    tracks[r.key] = {
      title: t.title,
      artistCredit: t.artistCredit,
      artists: t.artists || [],
      album: t.album,
      source: t.source,
      videoTitle: t.videoTitle || null,
      match: r.match || { status: r.status, best: null, alternatives: [] },
    };
  }
  const selected = new Set(imp.selected);
  const collections = imp.library.collections
    .filter((c) => selected.has(c.id))
    .map((c) => ({
      id: c.id,
      kind: c.kind,
      name: c.name,
      description: c.description,
      createdAt: c.createdAt,
      items: c.tracks.map((t) => ({ key: t.key, addedAt: t.addedAt })),
    }));
  return { tracks, collections };
}

// ---- loading ----------------------------------------------------------------------------

/** Why a source track has no TIDAL track to write. */
function whyNotImported(t, key, decisions) {
  const m = t?.match;
  if (Object.hasOwn(decisions, key)) return { reason: 'excluded_by_you', detail: 'You chose not to import this track' };
  switch (m?.status) {
    case 'not_found':
      return { reason: 'not_found_on_tidal', detail: m.reason || 'No match on TIDAL' };
    case 'review':
      return { reason: 'match_not_accepted', detail: m.best ? `Possible match not accepted: ${m.best.title} by ${(m.best.artists || []).join(', ')}` : 'Needed review' };
    case 'error':
      return { reason: 'match_error', detail: m.reason || 'Matching failed' };
    default:
      return { reason: 'not_matched', detail: `Track was ${m?.status || 'never matched'}` };
  }
}

/** One row of the "not imported" record. */
export function notImported(t, key, { reason, detail }) {
  return {
    key,
    title: t?.title || t?.videoTitle || null,
    artist: t?.artistCredit || (t?.artists || []).join(', ') || null,
    album: t?.album || null,
    url: t?.source?.url || null,
    reason,
    detail: detail || null,
  };
}

export const AUDIO_FILES_COLLECTION = 'Your audio files';

/**
 * Rows of the "not imported" record for things TIDAL can't take at all (the export's own audio
 * files), shaped like notImported(). `targets` (from getTargets) say whether the same song,
 * when it is also in the export's song lists, reached TIDAL from the catalogue.
 */
export function notImportableRecord(imp, targets = []) {
  const items = imp.library?.notImportable || [];
  if (!items.length) return [];
  const failed = new Set(targets.flatMap((t) => t.unimported.map((u) => u.key)));
  const written = new Set(targets.flatMap((t) => t.items.map((i) => i.key)).filter((k) => !failed.has(k)));
  const loaded = targets.length > 0;
  return items.map((f) => {
    let detail = "TIDAL can't store your own audio files";
    if (!f.linkedKey) detail += ", and this song isn't in the export's song lists, so it wasn't matched";
    else if (written.has(f.linkedKey)) detail += ". This song was added from TIDAL's catalogue instead";
    else if (failed.has(f.linkedKey)) detail += ", and this song wasn't found on TIDAL either";
    else detail += loaded ? ". The same song is in your song lists but wasn't part of this import" : '. The same song is in your song lists and is matched separately';
    return {
      key: f.linkedKey || null,
      title: f.title,
      artist: f.artist,
      album: f.album,
      url: null,
      reason: f.reason || 'own_audio_file',
      detail: `${detail}.`,
      audioFile: f.path,
    };
  });
}

/** Track key → path of the export's audio file for that song (see notImportable). */
export function audioFilesByKey(imp) {
  const map = new Map();
  for (const f of imp.library?.notImportable || []) if (f.linkedKey && !map.has(f.linkedKey)) map.set(f.linkedKey, f.path);
  return map;
}

/** Source details for tracks (by key), to describe tracks that fail at write time. */
export async function sourceTracks(db, importId, keys) {
  if (!keys.length) return new Map();
  const { rows } = await db.query('SELECT key, track FROM import_tracks WHERE import_id = $1 AND key = ANY($2::text[])', [importId, keys]);
  return new Map(rows.map((r) => [r.key, r.track]));
}

/** Update checkpoint fields and append rows to the collection's "not imported" record, atomically. */
export async function updateTargetAndRecord(db, importId, collectionId, fields, unimported = []) {
  const cols = Object.keys(fields);
  const sets = cols.map((c, i) => `${c} = $${i + 4}`);
  await db.query(
    `UPDATE import_targets SET ${[...sets, 'unimported = unimported || $3::jsonb'].join(', ')}, updated_at = now()
      WHERE import_id = $1 AND collection_id = $2`,
    [importId, collectionId, JSON.stringify(unimported), ...cols.map((c) => fields[c])],
  );
}

/**
 * Turn the user's review decisions into one checkpoint row per collection to write.
 * decisions: { trackKey: tidalTrackId | null } overriding the default (matched → best).
 */
export async function prepareLoad(pool, imp, targets, decisions = {}) {
  const { tracks, collections } = await matchResults(pool, imp);
  const byId = new Map(collections.map((c) => [c.id, c]));
  const resolve = (key) => {
    if (Object.hasOwn(decisions, key)) return decisions[key] ? String(decisions[key]) : null;
    const m = tracks[key]?.match;
    return m?.status === 'matched' ? String(m.best.id) : null;
  };
  // The album of the chosen TIDAL track, when the matcher recorded it.
  const albumOf = (key, id) => {
    const m = tracks[key]?.match;
    return [m?.best, ...(m?.alternatives || [])].find((c) => c && String(c.id) === id)?.albumId ?? null;
  };

  const rows = [];
  targets.forEach((target, position) => {
    const c = byId.get(String(target.id));
    if (!c) return;
    const seen = new Set();
    const items = [];
    const unimported = [];
    for (const item of c.items) {
      const id = resolve(item.key);
      if (!id) {
        unimported.push(notImported(tracks[item.key], item.key, whyNotImported(tracks[item.key], item.key, decisions)));
        continue;
      }
      if (seen.has(id)) continue; // two source tracks that map to one TIDAL track: added once
      seen.add(id);
      items.push({ id, addedAt: item.addedAt || null, key: item.key, albumId: albumOf(item.key, id), sourceAlbum: tracks[item.key]?.album || null });
    }
    const name = String(target.name || c.name).trim().slice(0, 250) || c.name;
    rows.push({ c, position, name, items, unimported, skipped: c.items.length - items.length });
  });
  if (!rows.length) throw new Error('Nothing selected to import.');

  await tx(pool, async (db) => {
    await db.query('DELETE FROM import_targets WHERE import_id = $1', [imp.id]);
    for (const r of rows) {
      await db.query(
        `INSERT INTO import_targets (import_id, collection_id, position, kind, name, description, created_at_source, items, skipped, unimported)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [imp.id, r.c.id, r.position, r.c.kind, r.name, r.c.description, r.c.createdAt, JSON.stringify(r.items), r.skipped, JSON.stringify(r.unimported)],
      );
    }
    await db.query(`UPDATE imports SET status = 'loading', stage = 'load', error = NULL, updated_at = now() WHERE id = $1`, [imp.id]);
  });
  return rows.length;
}

export async function getTargets(db, importId) {
  const { rows } = await db.query('SELECT * FROM import_targets WHERE import_id = $1 ORDER BY position', [importId]);
  return rows;
}

export async function getTarget(db, importId, collectionId) {
  const { rows } = await db.query('SELECT * FROM import_targets WHERE import_id = $1 AND collection_id = $2', [importId, collectionId]);
  return rows[0] || null;
}

export async function updateTarget(db, importId, collectionId, fields) {
  const cols = Object.keys(fields);
  const sets = cols.map((c, i) => `${c} = $${i + 3}`);
  await db.query(
    `UPDATE import_targets SET ${sets.join(', ')}, updated_at = now() WHERE import_id = $1 AND collection_id = $2`,
    [importId, collectionId, ...cols.map((c) => fields[c])],
  );
}

/** Retention: drop imports (and their checkpoints) older than `days`. */
export async function deleteOldImports(pool, days = 30) {
  const { rowCount } = await pool.query(
    `DELETE FROM imports WHERE updated_at < now() - make_interval(days => $1) AND status NOT IN ('matching', 'loading')`,
    [days],
  );
  return rowCount;
}

// ---- missing songs across imports ---------------------------------------------------------

/** Albums need this many missing tracks (and none on TIDAL) to be shown as a whole record. */
export const MIN_RECORD_TRACKS = 3;

const albumKey = (artist, album) => `${normalize(artist)}|${normalize(album)}`;

/**
 * Split missing songs into whole records and the rest. A record is an album (same artist +
 * album name) with at least MIN_RECORD_TRACKS missing songs, none of whose tracks from any
 * import reached TIDAL (`onTidal`: album keys with a track on TIDAL).
 * @returns {{ records: [{ artist, album, reasons, tracks }], tracks: songs }}
 */
export function groupMissingRecords(songs, onTidal = new Set(), minTracks = MIN_RECORD_TRACKS) {
  const albums = new Map();
  for (const s of songs) {
    if (!s.album || !s.artist) continue;
    const k = albumKey(s.artist, s.album);
    if (!albums.has(k)) albums.set(k, []);
    albums.get(k).push(s);
  }
  const records = [];
  const inRecord = new Set();
  for (const [k, list] of albums) {
    if (list.length < minTracks || onTidal.has(k)) continue;
    for (const s of list) inRecord.add(s);
    records.push({
      artist: list[0].artist,
      album: list[0].album,
      reasons: [...new Set(list.flatMap((s) => s.reasons))],
      tracks: [...list].sort((a, b) => cmpText(a.title, b.title)),
    });
  }
  records.sort((a, b) => cmpText(a.artist, b.artist) || cmpText(a.album, b.album));
  return { records, tracks: songs.filter((s) => !inRecord.has(s)) };
}

function cmpText(a, b) {
  return String(a || '\uffff').localeCompare(String(b || '\uffff'), undefined, { sensitivity: 'base' });
}

/**
 * Every song in any of the account's imports that did not reach TIDAL, merged into one list.
 * The same song (same title + artist, or the same source id) missing from several playlists or
 * several exports is one entry that lists each place it is missing from. A song that a later (or
 * any other) import did add to TIDAL is left out: it is no longer missing. Albums missing whole
 * are returned as records (see groupMissingRecords), the remaining songs as tracks.
 * @returns {{ records, tracks }} where a song is { title, artist, album, reasons, places: [{
 *          importId, filename, formatLabel, createdAt, collection, reason, detail, url, audioFile }] }
 */
export async function missingAcrossImports(db, accountId) {
  const { rows: imports } = await db.query(
    `SELECT id, filename, format_label, created_at, library->'notImportable' AS not_importable
       FROM imports WHERE account_id = $1 AND stage = 'load' ORDER BY created_at DESC`,
    [accountId],
  );
  if (!imports.length) return { records: [], tracks: [] };
  const { rows: targets } = await db.query(
    'SELECT import_id, name, status, items, unimported FROM import_targets WHERE import_id = ANY($1::uuid[]) ORDER BY position',
    [imports.map((i) => i.id)],
  );
  const byImport = new Map(imports.map((i) => [i.id, []]));
  for (const t of targets) byImport.get(t.import_id).push(t);

  // Source keys that some finished collection wrote to TIDAL.
  const written = new Set();
  for (const t of targets) {
    if (t.status !== 'done') continue;
    const failed = new Set(t.unimported.map((u) => u.key));
    for (const i of t.items) if (i.key && !failed.has(i.key)) written.add(i.key);
  }

  const songs = new Map();
  const add = (imp, collection, u) => {
    if (u.key && written.has(u.key)) return;
    const id = u.title ? `${normalize(u.title)}|${normalize(u.artist)}` : `key:${u.key || u.url || u.audioFile}`;
    let song = songs.get(id);
    if (!song) {
      song = { title: u.title || null, artist: u.artist || null, album: u.album || null, reasons: [], places: [] };
      songs.set(id, song);
    }
    song.album ||= u.album || null;
    if (!song.reasons.includes(u.reason)) song.reasons.push(u.reason);
    song.places.push({
      importId: imp.id,
      filename: imp.filename,
      formatLabel: imp.format_label,
      createdAt: imp.created_at,
      collection,
      reason: u.reason,
      detail: u.detail || null,
      url: u.url || null,
      audioFile: u.audioFile || null,
    });
  };
  for (const imp of imports) {
    const its = byImport.get(imp.id);
    for (const t of its) for (const u of t.unimported) add(imp, t.name, u);
    for (const u of notImportableRecord({ library: { notImportable: imp.not_importable || [] } }, its)) add(imp, AUDIO_FILES_COLLECTION, u);
  }
  const out = [...songs.values()];
  out.sort((a, b) => cmpText(a.artist, b.artist) || cmpText(a.title, b.title));

  // Albums with a track on TIDAL are not missing whole.
  const { rows: onTidalRows } = written.size
    ? await db.query(
        `SELECT track->>'album' AS album, track->>'artistCredit' AS credit, track->'artists' AS artists
           FROM import_tracks WHERE import_id = ANY($1::uuid[]) AND key = ANY($2::text[]) AND track->>'album' IS NOT NULL`,
        [imports.map((i) => i.id), [...written]],
      )
    : { rows: [] };
  const onTidal = new Set(onTidalRows.map((r) => albumKey(r.credit || (r.artists || []).join(', '), r.album)));
  return groupMissingRecords(out, onTidal);
}
