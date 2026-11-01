// Write-side TIDAL calls. Endpoints per the TIDAL API reference:
//   POST /playlists                                       (playlists.write)
//        { data: { type: "playlists", attributes: { name, description, accessType, createdAt } } }
//   POST /playlists/{id}/relationships/items              (playlists.write)  ≤ 50 items per call
//        { data: [{ type: "tracks", id, meta: { addedAt } }], meta: { onDuplicates } }
//   POST /userCollectionTracks/me/relationships/items     (collection.write) ≤ 50 items per call
//        { data: [{ type: "tracks", id, meta: { addedAt } }] }

export const BATCH_SIZE = 50;

// createdAt / addedAt are optional niceties (they preserve the original dates). If TIDAL
// rejects them for this client, retry without rather than failing the import.
async function withDateFallback(send, payloadWithDates, payloadWithout) {
  try {
    return await send(payloadWithDates);
  } catch (err) {
    if (err.status === 400 && payloadWithout) return send(payloadWithout);
    throw err;
  }
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function itemData(items, { withDates = true } = {}) {
  return items.map(({ id, addedAt }) => ({
    type: 'tracks',
    id: String(id),
    ...(withDates && addedAt ? { meta: { addedAt } } : {}),
  }));
}

const hasDates = (items) => items.some((i) => i.addedAt);

export async function createPlaylist(client, { name, description, createdAt, accessType = 'UNLISTED' }) {
  const attributes = { name: String(name).slice(0, 250), accessType };
  if (description) attributes.description = String(description).slice(0, 500);
  const send = (attrs) => client.post('/playlists', { data: { type: 'playlists', attributes: attrs } });
  const doc = createdAt
    ? await withDateFallback(send, { ...attributes, createdAt }, attributes)
    : await send(attributes);
  return { id: doc.data.id, name: doc.data.attributes?.name || attributes.name };
}

/** items: [{ id, addedAt? }] in playlist order. */
export async function addPlaylistItems(client, playlistId, items, { onProgress } = {}) {
  let added = 0;
  for (const batch of chunk(items, BATCH_SIZE)) {
    const path = `/playlists/${encodeURIComponent(playlistId)}/relationships/items`;
    const send = (data) => client.post(path, { data, meta: { onDuplicates: 'ADD' } });
    await withDateFallback(send, itemData(batch), hasDates(batch) ? itemData(batch, { withDates: false }) : null);
    added += batch.length;
    onProgress?.(added, items.length);
  }
  return added;
}

/** items: [{ id, addedAt? }]. Adds to the user's My Collection › Tracks. */
export async function addFavoriteTracks(client, items, { onProgress } = {}) {
  let added = 0;
  for (const batch of chunk(items, BATCH_SIZE)) {
    const send = (data) => client.post('/userCollectionTracks/me/relationships/items', { data });
    await withDateFallback(send, itemData(batch), hasDates(batch) ? itemData(batch, { withDates: false }) : null);
    added += batch.length;
    onProgress?.(added, items.length);
  }
  return added;
}
