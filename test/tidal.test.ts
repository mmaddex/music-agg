import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TokenManager, buildAuthorizeUrl, createPkcePair, exchangeCode, type TidalOAuthConfig } from '../src/core/tidal/auth.js';
import { TidalApiError, TidalClient, parseRetryAfter } from '../src/core/tidal/client.js';
import { createFakeTidal, type FakeTrack } from './fake-tidal.js';
import { jsonResponse } from './helpers.js';

const oauth: TidalOAuthConfig = {
  clientId: 'client-abc',
  redirectUri: 'http://localhost:5173/auth/callback',
  scopes: ['user.read', 'playlists.write'],
  authorizeUrl: 'https://login.tidal.com/authorize',
  tokenUrl: 'https://auth.tidal.com/v1/oauth2/token',
};

const CATALOG: FakeTrack[] = [
  { id: '1', title: 'Our House', artist: 'Crosby, Stills, Nash & Young', album: 'Déjà Vu', isrc: 'USAT20000001' },
  { id: '2', title: 'Our House', artist: 'Madness', album: 'The Rise & Fall' },
  { id: '3', title: 'Kodachrome', artist: 'Paul Simon', album: 'There Goes Rhymin’ Simon', duration: 'PT3M32S' },
];

function client(fake: ReturnType<typeof createFakeTidal>, tokens = { accessToken: 'access-0', refreshToken: 'refresh-0', expiresAt: Date.now() + 3600_000 }) {
  const manager = new TokenManager(oauth, tokens, undefined, fake.fetch);
  return new TidalClient(manager, { fetch: fake.fetch, countryCode: 'NO', maxRetries: 3 });
}

describe('OAuth', () => {
  it('builds a PKCE S256 authorize URL', () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    const url = new URL(buildAuthorizeUrl(oauth, challenge, 'state-1'));
    expect(url.origin + url.pathname).toBe('https://login.tidal.com/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'client-abc',
      redirect_uri: oauth.redirectUri,
      scope: 'user.read playlists.write',
      code_challenge_method: 'S256',
      code_challenge: challenge,
      state: 'state-1',
    });
  });

  it('exchanges the code as a form post with the verifier', async () => {
    const fake = createFakeTidal([]);
    const tokens = await exchangeCode(oauth, 'the-code', 'the-verifier', fake.fetch);
    expect(tokens).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-1', userId: '123' });
    const req = fake.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.headers.get('content-type')).toMatch(/x-www-form-urlencoded/);
    expect(req.body).toEqual({
      client_id: 'client-abc',
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: oauth.redirectUri,
      code_verifier: 'the-verifier',
    });
  });

  it('refreshes an expiring token once for concurrent callers', async () => {
    const fake = createFakeTidal([]);
    const updates: string[] = [];
    const m = new TokenManager(oauth, { accessToken: 'old', refreshToken: 'r', expiresAt: Date.now() + 1000 }, (t) => updates.push(t.accessToken), fake.fetch);
    const [a, b] = await Promise.all([m.getAccessToken(), m.getAccessToken()]);
    expect(a).toBe('access-1');
    expect(b).toBe('access-1');
    expect(updates).toEqual(['access-1']);
    expect(fake.requests[0]!.body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'r' });
  });
});

describe('TidalClient', () => {
  it('reads the current user', async () => {
    const fake = createFakeTidal([]);
    await expect(client(fake).getMe()).resolves.toMatchObject({ id: '123', username: 'matt', country: 'NO' });
    const req = fake.requests[0]!;
    expect(req.headers.get('authorization')).toBe('Bearer access-0');
    expect(req.headers.get('accept')).toBe('application/vnd.api+json');
  });

  it('searches and hydrates artists/albums when nested includes are not supported', async () => {
    const fake = createFakeTidal(CATALOG, { nestedInclude: false });
    const c = client(fake);
    const results = await c.searchTracks('our house');
    expect(results.map((t) => [t.id, t.artists[0], t.album])).toEqual([
      ['1', 'Crosby, Stills, Nash & Young', 'Déjà Vu'],
      ['2', 'Madness', 'The Rise & Fall'],
    ]);
    const paths = fake.requests.map((r) => `${r.url.pathname}?${r.url.searchParams.getAll('include').join(',')}`);
    expect(paths).toEqual([
      '/v2/searchResults?tracks,tracks.artists,tracks.albums',
      '/v2/searchResults?tracks',
      '/v2/tracks?artists,albums',
    ]);
    expect(fake.requests[2]!.url.searchParams.getAll('filter[id]')).toEqual(['1', '2']);
    expect(fake.requests[0]!.url.searchParams.get('countryCode')).toBe('NO');

    // Remembers the fallback; cached tracks need no hydration.
    fake.requests.length = 0;
    await c.searchTracks('our house');
    expect(fake.requests.map((r) => r.url.pathname)).toEqual(['/v2/searchResults']);
  });

  it('uses nested includes in one request when supported', async () => {
    const fake = createFakeTidal(CATALOG, { nestedInclude: true });
    const results = await client(fake).searchTracks('kodachrome');
    expect(results[0]).toMatchObject({ id: '3', artists: ['Paul Simon'], durationMs: 212000 });
    expect(fake.requests).toHaveLength(1);
  });

  it('looks up by ISRC', async () => {
    const fake = createFakeTidal(CATALOG);
    const r = await client(fake).getTracksByIsrc(['USAT20000001']);
    expect(r.map((t) => t.id)).toEqual(['1']);
  });

  it('backs off on 429 using Retry-After, then succeeds', async () => {
    const fake = createFakeTidal(CATALOG, { nestedInclude: true });
    fake.failNext((r) => r.url.pathname.endsWith('/searchResults'), () => jsonResponse(429, { errors: [{ status: '429' }] }, { 'retry-after': '0' }), 2);
    const r = await client(fake).searchTracks('kodachrome');
    expect(r).toHaveLength(1);
    expect(fake.requests).toHaveLength(3);
  });

  it('refreshes the token once on 401', async () => {
    const fake = createFakeTidal([]);
    fake.failNext((r) => r.url.pathname.endsWith('/users/me'), () => jsonResponse(401, { errors: [{ status: '401' }] }));
    await client(fake).getMe();
    expect(fake.requests.map((r) => r.url.hostname)).toEqual(['openapi.tidal.com', 'auth.tidal.com', 'openapi.tidal.com']);
    expect(fake.requests[2]!.headers.get('authorization')).toBe('Bearer access-1');
  });

  it('surfaces API errors with details', async () => {
    const fake = createFakeTidal([]);
    fake.failNext(() => true, () => jsonResponse(403, { errors: [{ status: '403', detail: 'Missing scope playlists.write' }] }));
    await expect(client(fake).createPlaylist({ name: 'x' })).rejects.toThrow(/Missing scope playlists.write/);
    await expect(client(fake).createPlaylist({ name: 'x' })).resolves.toMatchObject({ id: 'pl-1', url: 'https://tidal.com/browse/playlist/pl-1' });
  });

  it('creates playlists and adds items in batches of 50 with idempotency keys', async () => {
    const fake = createFakeTidal([]);
    const c = client(fake);
    const pl = await c.createPlaylist({ name: 'Road trip', description: 'Imported' });
    const items = Array.from({ length: 120 }, (_, i) => ({ id: String(1000 + i), addedAt: '2017-01-02T02:39:57Z' }));
    let reported = 0;
    await c.addPlaylistItems(pl.id, items, { onBatch: (n) => (reported += n), keySalt: 'job-1' });
    expect(fake.playlists.get(pl.id)!.items).toEqual(items.map((i) => i.id));
    expect(reported).toBe(120);
    const posts = fake.requests.filter((r) => r.url.pathname.endsWith('/relationships/items'));
    expect(posts.map((p) => p.body.data.length)).toEqual([50, 50, 20]);
    expect(posts[0]!.body.data[0]).toEqual({ id: '1000', type: 'tracks', meta: { addedAt: '2017-01-02T02:39:57Z' } });
    expect(new Set(posts.map((p) => p.headers.get('idempotency-key'))).size).toBe(3);
    expect(posts[0]!.headers.get('content-type')).toBe('application/vnd.api+json');
    const create = fake.requests.find((r) => r.url.pathname === '/v2/playlists')!;
    expect(create.body).toEqual({ data: { type: 'playlists', attributes: { name: 'Road trip', description: 'Imported', accessType: 'UNLISTED' } } });
  });

  it('retries a batch without addedAt metadata if TIDAL rejects it', async () => {
    const fake = createFakeTidal([]);
    fake.failNext((r) => r.url.pathname.includes('userCollectionTracks') && Boolean(r.body?.data?.[0]?.meta), () => jsonResponse(400, { errors: [{ detail: 'meta not allowed' }] }));
    await client(fake).addFavoriteTracks([{ id: '1', addedAt: '2020-01-01T00:00:00Z' }, { id: '2' }]);
    expect(fake.favorites).toEqual(['1', '2']);
  });

  it('does not retry non-idempotent writes', async () => {
    const fake = createFakeTidal([]);
    fake.failNext(() => true, () => jsonResponse(503, {}), 5);
    await expect(client(fake).createPlaylist({ name: 'x' })).rejects.toBeInstanceOf(TidalApiError);
    expect(fake.requests).toHaveLength(1);
  });

  it('parses Retry-After in seconds and HTTP-date form', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter(new Date(Date.now() + 5000).toUTCString())).toBeGreaterThan(3000);
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});
