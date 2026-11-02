import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { clearVideoCache } from '../src/core/enrich/youtube.js';
import { createApp } from '../src/server/app.js';
import type { ImportJobResult, JobView, MatchJobResult, SessionView, UploadSummary } from '../src/shared/api.js';
import { createFakeTidal } from './fake-tidal.js';
import { takeoutZip } from './helpers.js';

/**
 * End-to-end through the HTTP API: OAuth login -> upload Takeout zip -> match -> import,
 * with TIDAL and YouTube replaced by in-memory fakes.
 */
const fake = createFakeTidal(
  [
    { id: '100', title: "You Got A Killer Scene There, Man...", artist: 'Queens of the Stone Age', album: 'Lullabies to Paralyze' },
    { id: '101', title: '#9 Dream', artist: 'John Lennon', album: 'Walls and Bridges' },
    { id: '102', title: 'Aloha & the Three Johns', artist: 'Jenny Lewis', album: 'The Voyager' },
    { id: '103', title: 'Kodachrome', artist: 'Paul Simon', album: 'There Goes Rhymin’ Simon' },
  ],
  { nestedInclude: false },
);

const youtube: Record<string, { title: string; author_name: string }> = {
  vidUnknown1: { title: 'Kodachrome', author_name: 'Paul Simon - Topic' },
  vidUnknown2: { title: 'Kodachrome (Live)', author_name: 'Paul Simon - Topic' },
};

const routedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname === 'www.youtube.com') {
    const id = new URL(url.searchParams.get('url')!).searchParams.get('v')!;
    return youtube[id] ? Response.json(youtube[id]) : new Response('Not Found', { status: 404 });
  }
  return fake.fetch(input, init);
}) as typeof fetch;

let server: Server;
let base: string;
let cookie = '';

async function call<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T; res: Response }> {
  const res = await fetch(base + path, { redirect: 'manual', ...init, headers: { ...(init.headers ?? {}), cookie } });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0]!;
  const text = await res.text();
  return { status: res.status, body: (text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) as T, res };
}

async function waitJob<R>(id: string): Promise<JobView<R>> {
  for (let i = 0; i < 200; i++) {
    const { body } = await call<JobView<R>>(`/api/jobs/${id}`);
    if (body.status !== 'running') return body;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('job timed out');
}

beforeAll(async () => {
  clearVideoCache();
  const config = loadConfig({
    TIDAL_CLIENT_ID: 'client-abc',
    TIDAL_REDIRECT_URI: 'http://localhost:5173/auth/callback',
  } as NodeJS.ProcessEnv);
  const { app } = createApp({ config, fetch: routedFetch, tidalClient: { initialIntervalMs: 0, minIntervalMs: 0 } });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server?.close());

describe('HTTP API', () => {
  let upload: UploadSummary;

  it('rejects uploads before login', async () => {
    const { status, body } = await call<{ error: string }>('/api/uploads', { method: 'POST' });
    expect(status).toBe(401);
    expect(body.error).toMatch(/log in/i);
  });

  it('rejects a callback with a forged state', async () => {
    await call('/auth/login');
    const { status, res } = await call('/auth/callback?code=abc&state=forged');
    expect(status).toBe(302);
    expect(res.headers.get('location')).toMatch(/authError=/);
  });

  it('logs in with TIDAL (authorization code + PKCE)', async () => {
    const login = await call('/auth/login');
    expect(login.status).toBe(302);
    const authorize = new URL(login.res.headers.get('location')!);
    expect(authorize.host).toBe('login.tidal.com');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    const state = authorize.searchParams.get('state')!;

    const cb = await call(`/auth/callback?code=the-code&state=${state}`);
    expect(cb.status).toBe(302);
    expect(cb.res.headers.get('location')).toBe('http://localhost:5173/');
    const tokenReq = fake.requests.find((r) => r.url.hostname === 'auth.tidal.com' && r.body?.code === 'the-code')!;
    expect(tokenReq.body.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const { body } = await call<SessionView>('/api/session');
    expect(body.user).toMatchObject({ id: '123', username: 'matt', country: 'NO' });
    expect(body.importers.map((i) => i.id)).toEqual(['youtube-music-takeout', 'generic-csv']);
  });

  it('accepts a Takeout zip', async () => {
    const form = new FormData();
    form.append('files', new Blob([takeoutZip() as BlobPart]), 'youtube_music.zip');
    const { status, body } = await call<UploadSummary>('/api/uploads', { method: 'POST', body: form });
    expect(status).toBe(200);
    upload = body;
    expect(body.importer.id).toBe('youtube-music-takeout');
    expect(body.collections.map((c) => [c.name, c.trackCount, c.needsLookup, c.suggestedTarget])).toEqual([
      ['YouTube Music library', 4, 0, 'favorites'],
      ['Road trip, 2016', 2, 1, 'playlist'],
      ['Liked videos', 1, 1, 'playlist'],
      ['Watch later', 1, 1, 'skip'],
    ]);
  });

  it('reports unrecognised uploads clearly', async () => {
    const form = new FormData();
    form.append('files', new Blob(['just text']), 'notes.txt');
    const { status, body } = await call<{ error: string }>('/api/uploads', { method: 'POST', body: form });
    expect(status).toBe(422);
    expect(body.error).toMatch(/Couldn't recognise/);
  });

  it('matches against TIDAL', async () => {
    // The failed upload above replaced nothing; re-upload to be explicit about state.
    const form = new FormData();
    form.append('files', new Blob([takeoutZip() as BlobPart]), 'youtube_music.zip');
    upload = (await call<UploadSummary>('/api/uploads', { method: 'POST', body: form })).body;

    const ids = upload.collections.filter((c) => c.suggestedTarget !== 'skip').map((c) => c.id);
    const started = await call<JobView>(`/api/uploads/${upload.uploadId}/match`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ collectionIds: ids }),
    });
    expect(started.status).toBe(202);
    const job = await waitJob<MatchJobResult>(started.body.id);
    expect(job.status).toBe('done');
    const [lib, road, liked] = job.result!.collections;

    expect(lib!.counts).toEqual({ matched: 3, review: 0, unmatched: 1 });
    expect(lib!.items[0]).toMatchObject({ status: 'matched', best: { id: '100' } });
    expect(lib!.items[3]).toMatchObject({ status: 'unmatched', reason: 'Not found on TIDAL' });

    expect(road!.items.map((i) => [i.status, i.best?.id])).toEqual([
      ['matched', '101'],
      ['matched', '103'],
    ]);
    expect(road!.items[1]!.source).toMatchObject({ title: 'Kodachrome', artists: ['Paul Simon'], videoTitle: 'Kodachrome', guessed: true });

    // A live recording shouldn't silently match the studio version.
    expect(liked!.items[0]).toMatchObject({ status: 'review', best: { id: '103' } });
  });

  it('validates import plans', async () => {
    const { status } = await call(`/api/uploads/${upload.uploadId}/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan: [{ collectionId: 'nope', target: 'playlist', items: [] }] }),
    });
    expect(status).toBe(400);
  });

  it('imports playlists and favourites', async () => {
    const plan = [
      { collectionId: 'yt-library', target: 'favorites', items: [0, 1, 2].map((i) => ({ index: i, trackId: String(100 + i) })) },
      {
        collectionId: 'yt-pl-PLroadtrip',
        target: 'playlist',
        name: 'Road trip (from YouTube)',
        items: [
          { index: 0, trackId: '101' },
          { index: 1, trackId: '103' },
        ],
      },
      // Same track as the library: should not be added to favourites twice.
      { collectionId: 'yt-pl-LLchannel', target: 'favorites', items: [{ index: 0, trackId: '101' }] },
    ];
    const started = await call<JobView>(`/api/uploads/${upload.uploadId}/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan }),
    });
    expect(started.status).toBe(202);
    const job = await waitJob<ImportJobResult>(started.body.id);
    expect(job.status).toBe('done');
    expect(job.result).toEqual({
      playlists: [{ collectionId: 'yt-pl-PLroadtrip', name: 'Road trip (from YouTube)', url: 'https://tidal.com/browse/playlist/pl-1', added: 2 }],
      favoritesAdded: 3,
      failures: [],
    });
    expect(fake.favorites).toEqual(['100', '101', '102']);
    expect(fake.playlists.get('pl-1')).toEqual({ name: 'Road trip (from YouTube)', items: ['101', '103'] });
    const itemsPost = fake.requests.find((r) => r.url.pathname === '/v2/playlists/pl-1/relationships/items')!;
    expect(itemsPost.body.data[0]).toEqual({ id: '101', type: 'tracks', meta: { addedAt: '2017-01-02T02:39:57Z' } });
  });

  it('logs out and forgets everything', async () => {
    await call('/auth/logout', { method: 'POST' });
    const { body } = await call<SessionView>('/api/session');
    expect(body.user).toBeNull();
    const { status } = await call(`/api/uploads/${upload.uploadId}`);
    expect(status).toBe(401);
  });
});
