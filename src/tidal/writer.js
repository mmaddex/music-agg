// Write-side TIDAL calls. Endpoints per the TIDAL API reference:
//   POST /playlists                                       (playlists.write)
//        { data: { type: "playlists", attributes: { name, description, accessType, createdAt } } }
//   POST /playlists/{id}/relationships/items              (playlists.write)  ≤ 50 items per call
//        { data: [{ type: "tracks", id, meta: { addedAt } }], meta: { onDuplicates } }
//   POST /userCollectionTracks/me/relationships/items     (collection.write) ≤ 50 items per call
//        { data: [{ type: "tracks", id, meta: { addedAt } }] }
//   POST /userCollectionAlbums/me/relationships/items     (collection.write) ≤ 50 items per call
//        { data: [{ type: "albums", id }] }
//
// Each function performs ONE write so the caller (a workflow task) can checkpoint between
// writes. Callers pass a deterministic `idempotencyKey`: if a retried task re-sends a write
// that had actually succeeded, TIDAL replays the original response instead of applying it
// twice.

export const BATCH_SIZE = 50;

export function chunk(list, size = BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// createdAt / addedAt are optional niceties (they preserve the original dates). If TIDAL
// rejects them for this client, retry once without — under a different idempotency key,
// since the payload differs.
async function withDateFallback(send, withDates, withoutDates, idempotencyKey) {
  try {
    return await send(withDates, idempotencyKey);
  } catch (err) {
    if (err.status === 400 && withoutDates) return send(withoutDates, idempotencyKey && `${idempotencyKey.slice(0, -4)}0000`);
    throw err;
  }
}

function itemData(items, { withDates = true } = {}) {
  return items.map(({ id, addedAt }) => ({
    type: 'tracks',
    id: String(id),
    ...(withDates && addedAt ? { meta: { addedAt } } : {}),
  }));
}

const hasDates = (items) => items.some((i) => i.addedAt);

export async function createPlaylist(client, { name, description, createdAt, accessType = 'UNLISTED' }, { idempotencyKey } = {}) {
  const attributes = { name: String(name).slice(0, 250), accessType };
  if (description) attributes.description = String(description).slice(0, 500);
  const send = (attrs, key) => client.post('/playlists', { data: { type: 'playlists', attributes: attrs } }, { idempotencyKey: key });
  const doc = createdAt
    ? await withDateFallback(send, { ...attributes, createdAt }, attributes, idempotencyKey)
    : await send(attributes, idempotencyKey);
  return { id: doc.data.id, name: doc.data.attributes?.name || attributes.name };
}

// Responses list items TIDAL did not add in meta.skipped (reason ALREADY_PRESENT / NOT_FOUND).
// NOT_FOUND = not available to this account/country: those ids are returned so the caller can
// record them as not imported.
function outcome(doc, sent) {
  const list = Array.isArray(doc?.meta?.skipped) ? doc.meta.skipped : [];
  const notFound = list.filter((s) => s.reason === 'NOT_FOUND').map((s) => String(s.id));
  return { added: Math.max(0, sent - list.length), skipped: list.length, notFound };
}

/** Add up to BATCH_SIZE tracks to a playlist. items: [{ id, addedAt? }] → { added, skipped } */
export async function addPlaylistBatch(client, playlistId, items, { idempotencyKey } = {}) {
  const path = `/playlists/${encodeURIComponent(playlistId)}/relationships/items`;
  const send = (data, key) => client.post(path, { data, meta: { onDuplicates: 'ADD' } }, { idempotencyKey: key });
  const doc = await withDateFallback(send, itemData(items), hasDates(items) ? itemData(items, { withDates: false }) : null, idempotencyKey);
  return outcome(doc, items.length);
}

/** Add up to BATCH_SIZE tracks to My Collection › Tracks. Already-saved tracks are skipped by TIDAL. */
export async function addFavoritesBatch(client, items, { idempotencyKey } = {}) {
  const send = (data, key) => client.post('/userCollectionTracks/me/relationships/items', { data }, { idempotencyKey: key });
  const doc = await withDateFallback(send, itemData(items), hasDates(items) ? itemData(items, { withDates: false }) : null, idempotencyKey);
  return outcome(doc, items.length);
}

/** Save up to BATCH_SIZE albums to My Collection › Albums. albumIds: string[] */
export async function addAlbumsBatch(client, albumIds, { idempotencyKey } = {}) {
  const data = albumIds.map((id) => ({ type: 'albums', id: String(id) }));
  const doc = await client.post('/userCollectionAlbums/me/relationships/items', { data }, { idempotencyKey });
  return outcome(doc, albumIds.length);
}
