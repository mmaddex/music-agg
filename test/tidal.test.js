import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildAuthorizeUrl, createPkcePair, exchangeCode, refreshTokens, SCOPES } from '../src/auth/tidalAuth.js';
import { TidalClient } from '../src/tidal/client.js';
import { matchTrack, scoreCandidate } from '../src/tidal/matcher.js';
import { addPlaylistItems, createPlaylist } from '../src/tidal/writer.js';
import { runImport } from '../src/importService.js';
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

function recordingClient({ failFirstWithDates = false } = {}) {
  const posts = [];
  let failed = false;
  return {
    posts,
    async post(path, body) {
      posts.push({ path, body });
      const hasDates = JSON.stringify(body).includes('addedAt') || JSON.stringify(body).includes('createdAt');
      if (failFirstWithDates && hasDates && !failed) {
        failed = true;
        throw Object.assign(new Error('bad'), { status: 400 });
      }
      if (path === '/playlists') return { data: { id: 'pl-1', type: 'playlists', attributes: { name: body.data.attributes.name } } };
      return {};
    },
  };
}

test('playlist items are sent in batches of 50 with documented body', async () => {
  const client = recordingClient();
  const items = Array.from({ length: 120 }, (_, i) => ({ id: String(i), addedAt: '2020-01-01T00:00:00Z' }));
  await addPlaylistItems(client, 'pl-1', items);
  assert.equal(client.posts.length, 3);
  assert.equal(client.posts[0].path, '/playlists/pl-1/relationships/items');
  assert.equal(client.posts[0].body.data.length, 50);
  assert.deepEqual(client.posts[0].body.data[0], { type: 'tracks', id: '0', meta: { addedAt: '2020-01-01T00:00:00Z' } });
  assert.equal(client.posts[2].body.data.length, 20);
});

test('dates are dropped and retried if TIDAL rejects them', async () => {
  const client = recordingClient({ failFirstWithDates: true });
  await createPlaylist(client, { name: 'X', createdAt: '2019-01-01T00:00:00Z' });
  assert.equal(client.posts.length, 2);
  assert.equal(client.posts[1].body.data.attributes.createdAt, undefined);
  assert.equal(client.posts[1].body.data.attributes.accessType, 'UNLISTED');
});

test('runImport applies decisions, de-duplicates, and writes playlists + favourites', async () => {
  const matchResult = {
    tracks: {
      a: { match: { status: 'matched', best: { id: 'T1' } } },
      b: { match: { status: 'review', best: { id: 'T2' } } },
      c: { match: { status: 'not_found', best: null } },
      d: { match: { status: 'matched', best: { id: 'T1' } } }, // different video, same TIDAL track
    },
    collections: [
      { id: 'p', kind: 'playlist', name: 'Road Trip', items: [{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'd' }] },
      { id: 'f', kind: 'favorites', name: 'Library songs', items: [{ key: 'a' }] },
    ],
  };
  const client = recordingClient();
  const result = await runImport({
    matchResult,
    targets: [{ id: 'p', name: 'Road Trip 2' }, { id: 'f' }],
    decisions: { b: 'T2' },
    client,
    update: () => {},
  });
  assert.equal(client.posts[0].path, '/playlists');
  assert.equal(client.posts[0].body.data.attributes.name, 'Road Trip 2');
  assert.deepEqual(client.posts[1].body.data.map((d) => d.id), ['T1', 'T2']);
  assert.equal(client.posts[2].path, '/userCollectionTracks/me/relationships/items');
  assert.deepEqual(result.collections.map((c) => [c.name, c.added, c.skipped]), [
    ['Road Trip 2', 2, 2],
    ['Library songs', 1, 0],
  ]);
  assert.equal(result.collections[0].url, 'https://tidal.com/playlist/pl-1');
});
