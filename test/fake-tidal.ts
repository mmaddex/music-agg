import { jsonResponse } from './helpers.js';

/**
 * In-memory stand-in for auth.tidal.com + openapi.tidal.com/v2 that returns
 * JSON:API documents shaped like the real API (per the published OpenAPI spec).
 */
export interface FakeTrack {
  id: string;
  title: string;
  artist: string;
  album?: string;
  isrc?: string;
  duration?: string;
}

export interface Recorded {
  method: string;
  url: URL;
  headers: Headers;
  body?: any;
}

export function createFakeTidal(catalog: FakeTrack[], opts: { nestedInclude?: boolean } = {}) {
  const requests: Recorded[] = [];
  const playlists = new Map<string, { name: string; items: string[] }>();
  const favorites: string[] = [];
  const failures: { match: (r: Recorded) => boolean; response: () => Response; times: number }[] = [];
  let tokenCounter = 0;

  const artistId = (name: string) => `a-${name.toLowerCase().replace(/\W+/g, '-')}`;
  const albumId = (name: string) => `al-${name.toLowerCase().replace(/\W+/g, '-')}`;
  const trackResource = (t: FakeTrack) => ({
    id: t.id,
    type: 'tracks',
    attributes: { title: t.title, isrc: t.isrc ?? null, duration: t.duration ?? 'PT3M', explicit: false, popularity: 0.5, key: 'C', keyScale: 'MAJOR', mediaTags: [] },
    relationships: {
      artists: { data: [{ id: artistId(t.artist), type: 'artists' }] },
      albums: { data: t.album ? [{ id: albumId(t.album), type: 'albums' }] : [] },
    },
  });
  const related = (tracks: FakeTrack[]) => [
    ...tracks.map((t) => ({ id: artistId(t.artist), type: 'artists', attributes: { name: t.artist, popularity: 0.5 } })),
    ...tracks.filter((t) => t.album).map((t) => ({ id: albumId(t.album!), type: 'albums', attributes: { title: t.album } })),
  ];

  async function handle(req: Recorded): Promise<Response> {
    const { url, method } = req;
    for (const f of failures) {
      if (f.times > 0 && f.match(req)) {
        f.times--;
        return f.response();
      }
    }
    if (url.hostname === 'auth.tidal.com') {
      tokenCounter++;
      return jsonResponse(200, {
        access_token: `access-${tokenCounter}`,
        refresh_token: 'refresh-1',
        expires_in: 86400,
        token_type: 'Bearer',
        user_id: 123,
      });
    }
    if (!req.headers.get('authorization')?.startsWith('Bearer ')) return jsonResponse(401, { errors: [{ status: '401' }] });
    const path = url.pathname.replace(/^\/v2/, '');

    if (method === 'GET' && path === '/users/me') {
      return jsonResponse(200, { data: { id: '123', type: 'users', attributes: { username: 'matt', country: 'NO', developerAccessTier: 'THIRD_PARTY' } } });
    }
    if (method === 'GET' && path === '/searchResults') {
      const include = url.searchParams.getAll('include');
      if (include.some((i) => i.includes('.')) && !opts.nestedInclude) {
        return jsonResponse(400, { errors: [{ status: '400', detail: 'Invalid include' }] });
      }
      const q = (url.searchParams.get('filter[query]') ?? '').toLowerCase();
      const words = q.split(/\s+/).filter(Boolean);
      const hits = catalog.filter((t) => {
        const hay = `${t.artist} ${t.title}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
      const nested = include.some((i) => i.includes('.'));
      return jsonResponse(200, {
        data: [
          {
            id: 'search-1',
            type: 'searchResults',
            attributes: { query: q, trackingId: 'x' },
            relationships: { tracks: { data: hits.map((t) => ({ id: t.id, type: 'tracks' })) } },
          },
        ],
        included: [...hits.map(trackResource), ...(nested ? related(hits) : [])],
        links: { self: '/searchResults' },
      });
    }
    if (method === 'GET' && path === '/tracks') {
      const ids = url.searchParams.getAll('filter[id]');
      const isrcs = url.searchParams.getAll('filter[isrc]');
      const tracks = catalog.filter((t) => ids.includes(t.id) || (t.isrc && isrcs.includes(t.isrc)));
      return jsonResponse(200, { data: tracks.map(trackResource), included: related(tracks), links: { self: '/tracks' } });
    }
    if (method === 'POST' && path === '/playlists') {
      const id = `pl-${playlists.size + 1}`;
      playlists.set(id, { name: req.body.data.attributes.name, items: [] });
      return jsonResponse(201, { data: { id, type: 'playlists', attributes: { name: req.body.data.attributes.name } } });
    }
    const m = /^\/playlists\/([^/]+)\/relationships\/items$/.exec(path);
    if (method === 'POST' && m) {
      const pl = playlists.get(m[1]!);
      if (!pl) return jsonResponse(404, { errors: [{ status: '404' }] });
      if (req.body.data.length > 50) return jsonResponse(400, { errors: [{ detail: 'too many' }] });
      pl.items.push(...req.body.data.map((d: { id: string }) => d.id));
      return new Response(null, { status: 200 });
    }
    if (method === 'POST' && path === '/userCollectionTracks/me/relationships/items') {
      if (req.body.data.length > 50) return jsonResponse(400, { errors: [{ detail: 'too many' }] });
      favorites.push(...req.body.data.map((d: { id: string }) => d.id));
      return new Response(null, { status: 200 });
    }
    return jsonResponse(404, { errors: [{ status: '404', detail: `No fake route for ${method} ${path}` }] });
  }

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    let body: any;
    if (typeof init?.body === 'string') {
      body = headers.get('content-type')?.includes('json') ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body));
    }
    const rec = { method, url, headers, body };
    requests.push(rec);
    return handle(rec);
  }) as typeof fetch;

  return {
    fetch: fetchImpl,
    requests,
    playlists,
    favorites,
    /** Make the next `times` matching requests return `response`. */
    failNext(match: (r: Recorded) => boolean, response: () => Response, times = 1) {
      failures.push({ match, response, times });
    },
  };
}
