import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildAuthorizeUrl, createPkcePair, exchangeCode, refreshTokens, SCOPES } from '../src/auth/tidalAuth.js';
import { TidalClient } from '../src/tidal/client.js';
import { matchTrack, scoreCandidate } from '../src/tidal/matcher.js';
import { addAlbumsBatch, addFavoritesBatch, addPlaylistBatch, chunk, createPlaylist } from '../src/tidal/writer.js';
import { makeTrack } from '../src/importers/model.js';

const noSleep = async () => {};
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/vnd.api+json', ...headers } });

// ---- auth -----------------------------------------------------------------------

test('PKCE pair is RFC 7636 S256', () => {
  const { verifier, challenge } = createPkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
  assert.equal(challenge, expected);
});

test('authorize URL matches TIDAL docs', () => {
  const url = new URL(buildAuthorizeUrl({ clientId: 'cid', redirectUri: 'https://x/cb', challenge: 'ch', state: 'st' }));
  assert.equal(url.origin + url.pathname, 'https://login.tidal.com/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'cid');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://x/cb');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), 'ch');
  assert.equal(url.searchParams.get('state'), 'st');
  assert.equal(url.searchParams.get('scope'), SCOPES.join(' '));
});

test('code exchange and refresh post the documented form fields', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, form: Object.fromEntries(new URLSearchParams(init.body)) });
    return new Response(JSON.stringify({ access_token: `at${calls.length}`, refresh_token: calls.length === 1 ? 'rt' : undefined, expires_in: 86400 }));
  };
  const tokens = await exchangeCode({ clientId: 'cid', code: 'c', redirectUri: 'https://x/cb', verifier: 'v', fetchImpl });
  assert.equal(calls[0].url, 'https://auth.tidal.com/v1/oauth2/token');
  assert.deepEqual(calls[0].form, { grant_type: 'authorization_code', client_id: 'cid', code: 'c', redirect_uri: 'https://x/cb', code_verifier: 'v' });
  assert.equal(tokens.refreshToken, 'rt');

  const next = await refreshTokens({ clientId: 'cid', tokens, fetchImpl });
  assert.equal(calls[1].form.grant_type, 'refresh_token');
  assert.equal(calls[1].form.refresh_token, 'rt');
  assert.equal(next.accessToken, 'at2');
  assert.equal(next.refreshToken, 'rt', 'keeps the old refresh token when none is returned');
});

test('token errors surface TIDAL error_description', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Code expired' }), { status: 400 });
  await assert.rejects(exchangeCode({ clientId: 'c', code: 'x', redirectUri: 'r', verifier: 'v', fetchImpl }), /Code expired/);
});

// ---- client ---------------------------------------------------------------------

test('client retries 429 using Retry-After and reuses the idempotency key', async () => {
  const seen = [];
  const sleeps = [];
  let n = 0;
  const client = new TidalClient({
    getAccessToken: async () => 'tok',
    minIntervalMs: 0,
    sleepImpl: async (ms) => sleeps.push(ms),
    fetchImpl: async (url, init) => {
      seen.push(init.headers);
      n += 1;
      return n === 1 ? json({ errors: [] }, 429, { 'retry-after': '2' }) : json({ data: { id: 'p1', type: 'playlists' } }, 201);
    },
  });
  const doc = await client.post('/playlists', { data: {} });
  assert.equal(doc.data.id, 'p1');
  assert.ok(sleeps.includes(2000));
  assert.equal(seen[0]['idempotency-key'], seen[1]['idempotency-key']);
  assert.equal(seen[0].authorization, 'Bearer tok');
  assert.equal(seen[0]['content-type'], 'application/vnd.api+json');
});

test('client refreshes the token once on 401', async () => {
  let token = 'old';
  const client = new TidalClient({
    getAccessToken: async () => token,
    forceRefresh: async () => (token = 'new'),
    minIntervalMs: 0,
    sleepImpl: noSleep,
    fetchImpl: async (url, init) => (init.headers.authorization === 'Bearer new' ? json({ data: [] }) : json({}, 401)),
  });
  assert.deepEqual(await client.get('/tracks'), { data: [] });
});

test('client raises JSON:API error details', async () => {
  const client = new TidalClient({
    getAccessToken: async () => 't',
    minIntervalMs: 0,
    sleepImpl: noSleep,
    fetchImpl: async () => json({ errors: [{ detail: 'Bad filter' }] }, 400),
  });
  await assert.rejects(client.get('/tracks'), (err) => err.status === 400 && /Bad filter/.test(err.message));
});

// ---- matcher --------------------------------------------------------------------

/** Fake TIDAL search: returns the given track resources for any query, JSON:API-shaped. */
function fakeSearchClient(tracks, { isrcHits = [] } = {}) {
  const calls = [];
  const resource = (t) => ({
    type: 'tracks',
    id: t.id,
    attributes: { title: t.title, version: t.version || null, isrc: t.isrc || null, duration: t.duration || 'PT3M0S' },
    relationships: {
      artists: { data: t.artists.map((_, i) => ({ type: 'artists', id: `${t.id}-a${i}` })) },
      albums: { data: [{ type: 'albums', id: `${t.id}-al` }] },
    },
  });
  const included = (list) =>
    list.flatMap((t) => [
      resource(t),
      ...t.artists.map((name, i) => ({ type: 'artists', id: `${t.id}-a${i}`, attributes: { name } })),
      { type: 'albums', id: `${t.id}-al`, attributes: { title: t.album || 'Album' } },
    ]);
  return {
    calls,
    async get(path, query) {
      calls.push({ path, query });
      if (path === '/tracks') return { data: isrcHits.map(resource), included: included(isrcHits).filter((r) => r.type !== 'tracks') };
      return {
        data: [{ type: 'searchResults', id: 'q', relationships: { tracks: { data: tracks.map((t) => ({ type: 'tracks', id: t.id })) } } }],
        included: included(tracks),
      };
    },
  };
}

test('ISRC lookups are definitive', async () => {
  const client = fakeSearchClient([], { isrcHits: [{ id: '42', title: 'So What', artists: ['Miles Davis'] }] });
  const r = await matchTrack(client, makeTrack({ title: 'So What', artistCredit: 'Miles Davis', isrc: 'USSM15900113' }), { countryCode: 'US' });
  assert.equal(r.status, 'matched');
  assert.equal(r.method, 'isrc');
  assert.equal(client.calls[0].query['filter[isrc]'], 'USSM15900113');
});

test('search match picks the studio version over karaoke/live', async () => {
  const client = fakeSearchClient([
    { id: '1', title: 'Karma Police (Karaoke Version)', artists: ['Sing Kings'] },
    { id: '2', title: 'Karma Police', artists: ['Radiohead'], album: 'OK Computer' },
    { id: '3', title: 'Karma Police - Live', artists: ['Radiohead'] },
  ]);
  const r = await matchTrack(client, makeTrack({ title: 'Karma Police', artistCredit: 'Radiohead', album: 'OK Computer' }), { countryCode: 'US' });
  assert.equal(r.status, 'matched');
  assert.equal(r.best.id, '2');
  assert.equal(client.calls[0].path, '/searchResults');
  assert.equal(client.calls[0].query['filter[query]'], 'Karma Police Radiohead');
  assert.equal(client.calls[0].query.include, 'tracks.artists,tracks.albums');
});

test('weak candidates go to review or not_found', async () => {
  const track = makeTrack({ title: 'Asa Branca', artistCredit: 'Luiz Gonzaga' });
  const review = await matchTrack(fakeSearchClient([{ id: '9', title: 'Asa Branca', artists: ['Some Cover Band'] }]), track, {});
  assert.equal(review.status, 'review');
  const none = await matchTrack(fakeSearchClient([{ id: '8', title: 'Completely Different', artists: ['Nobody'] }]), track, {});
  assert.equal(none.status, 'not_found');
});

test('tracks with no metadata are not searched', async () => {
  const client = fakeSearchClient([]);
  const t = makeTrack({ source: { type: 'youtube', id: 'x' } });
  t.lookupError = 'Video is private';
  const r = await matchTrack(client, t, {});
  assert.equal(r.status, 'not_found');
  assert.equal(r.reason, 'Video is private');
  assert.equal(client.calls.length, 0);
});

test('video-title matches use the combined artist+title comparison', () => {
  const t = makeTrack({ title: 'Karma Police (Official Video)', artistCredit: 'Radiohead' });
  t.fromVideoTitle = true;
  t.videoTitle = 'Radiohead - Karma Police (Official Video)';
  const s = scoreCandidate(t, { title: 'Karma Police', artists: ['Radiohead'], albums: [], durationMs: null });
  assert.ok(s >= 0.9, `score ${s}`);
});

// ---- writer / import -------------------------------------------------------------

function recordingClient({ failFirstWithDates = false, skipped = [] } = {}) {
  const posts = [];
  let failed = false;
  return {
    posts,
    async post(path, body, opts = {}) {
      posts.push({ path, body, idempotencyKey: opts.idempotencyKey });
      const hasDates = JSON.stringify(body).includes('addedAt') || JSON.stringify(body).includes('createdAt');
      if (failFirstWithDates && hasDates && !failed) {
        failed = true;
        throw Object.assign(new Error('bad'), { status: 400 });
      }
      if (path === '/playlists') return { data: { id: 'pl-1', type: 'playlists', attributes: { name: body.data.attributes.name } } };
      return { meta: { skipped } };
    },
  };
}

test("playlist batch uses the documented body and the caller's idempotency key", async () => {
  const client = recordingClient();
  const items = Array.from({ length: 120 }, (_, i) => ({ id: String(i), addedAt: '2020-01-01T00:00:00Z' }));
  const batches = chunk(items);
  assert.deepEqual(batches.map((b) => b.length), [50, 50, 20]);
  const res = await addPlaylistBatch(client, 'pl-1', batches[0], { idempotencyKey: 'k-1' });
  assert.deepEqual(res, { added: 50, skipped: 0, notFound: [] });
  assert.equal(client.posts[0].path, '/playlists/pl-1/relationships/items');
  assert.equal(client.posts[0].idempotencyKey, 'k-1');
  assert.deepEqual(client.posts[0].body.data[0], { type: 'tracks', id: '0', meta: { addedAt: '2020-01-01T00:00:00Z' } });
  assert.deepEqual(client.posts[0].body.meta, { onDuplicates: 'ADD' });
});

test('favourites batch counts tracks TIDAL reports as already present', async () => {
  const client = recordingClient({ skipped: [{ id: '1', type: 'tracks', reason: 'ALREADY_PRESENT' }] });
  const res = await addFavoritesBatch(client, [{ id: '1' }, { id: '2' }], { idempotencyKey: 'k' });
  assert.deepEqual(res, { added: 1, skipped: 1, notFound: [] });
  assert.equal(client.posts[0].path, '/userCollectionTracks/me/relationships/items');
});

test('tracks TIDAL reports as NOT_FOUND are returned so they can be recorded', async () => {
  const client = recordingClient({ skipped: [{ id: '2', type: 'tracks', reason: 'NOT_FOUND' }, { id: '3', type: 'tracks', reason: 'ALREADY_PRESENT' }] });
  const res = await addFavoritesBatch(client, [{ id: '1' }, { id: '2' }, { id: '3' }], { idempotencyKey: 'k' });
  assert.deepEqual(res, { added: 1, skipped: 2, notFound: ['2'] });
});

test('albums are saved with the documented body', async () => {
  const client = recordingClient();
  const res = await addAlbumsBatch(client, ['10', 11], { idempotencyKey: 'a-0' });
  assert.deepEqual(res, { added: 2, skipped: 0, notFound: [] });
  assert.equal(client.posts[0].path, '/userCollectionAlbums/me/relationships/items');
  assert.deepEqual(client.posts[0].body, { data: [{ type: 'albums', id: '10' }, { type: 'albums', id: '11' }] });
  assert.equal(client.posts[0].idempotencyKey, 'a-0');
});

test('array query parameters repeat the key, as the TIDAL spec expects', () => {
  const c = new TidalClient({ getAccessToken: async () => 'x' });
  assert.equal(c.url('/tracks', { 'filter[id]': ['1', '2'], include: 'albums' }), 'https://openapi.tidal.com/v2/tracks?filter%5Bid%5D=1&filter%5Bid%5D=2&include=albums');
});

test('dates are dropped and retried (with a different key) if TIDAL rejects them', async () => {
  const client = recordingClient({ failFirstWithDates: true });
  await createPlaylist(client, { name: 'X', createdAt: '2019-01-01T00:00:00Z' }, { idempotencyKey: '11111111-2222-4333-a444-555555555555' });
  assert.equal(client.posts.length, 2);
  assert.equal(client.posts[1].body.data.attributes.createdAt, undefined);
  assert.equal(client.posts[1].body.data.attributes.accessType, 'UNLISTED');
  assert.notEqual(client.posts[0].idempotencyKey, client.posts[1].idempotencyKey);
});

test('client sends a caller-supplied idempotency key and retries 409 (still processing)', async () => {
  const seen = [];
  let n = 0;
  const client = new TidalClient({
    getAccessToken: async () => 't',
    minIntervalMs: 0,
    sleepImpl: noSleep,
    fetchImpl: async (url, init) => {
      seen.push(init.headers['idempotency-key']);
      n += 1;
      return n === 1 ? json({ errors: [] }, 409) : json({});
    },
  });
  await client.post('/playlists', { data: {} }, { idempotencyKey: 'fixed' });
  assert.deepEqual(seen, ['fixed', 'fixed']);
});
