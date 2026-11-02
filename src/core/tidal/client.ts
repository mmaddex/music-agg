import { createHash } from 'node:crypto';
import { chunk, createLimiter, sleep, type Limiter } from '../util/async.js';
import { isoDurationToMs } from '../util/duration.js';
import type { TokenManager } from './auth.js';

/**
 * Thin client for the TIDAL API v2 (JSON:API).
 * Reference: https://tidal-music.github.io/tidal-api-reference/
 *
 * Endpoints used:
 *   GET  /users/me
 *   GET  /searchResults?filter[query]=…&include=tracks
 *   GET  /tracks?filter[id]=…|filter[isrc]=…&include=artists,albums   (≤ 20 per call)
 *   POST /playlists
 *   POST /playlists/{id}/relationships/items                         (≤ 50 per call)
 *   POST /userCollectionTracks/me/relationships/items                (≤ 50 per call)
 */

const JSON_API = 'application/vnd.api+json';

interface Identifier {
  id: string;
  type: string;
  meta?: Record<string, unknown>;
}
interface Resource extends Identifier {
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: Identifier | Identifier[] | null }>;
}
interface Document {
  data?: Resource | Resource[] | null;
  included?: Resource[];
  links?: { next?: string };
}

export interface TidalUser {
  id: string;
  username?: string;
  country: string;
  email?: string;
  firstName?: string;
}

export interface TidalTrack {
  id: string;
  title: string;
  version?: string;
  artists: string[];
  album?: string;
  durationMs?: number;
  isrc?: string;
  explicit?: boolean;
  url: string;
}

export interface TidalPlaylist {
  id: string;
  name: string;
  url: string;
}

export interface CollectionItem {
  id: string;
  /** ISO 8601; kept from the source service when known. */
  addedAt?: string;
}

export interface WriteOptions {
  signal?: AbortSignal;
  onBatch?: (added: number) => void;
  /** Mixed into idempotency keys, e.g. a job id, so separate runs never collide. */
  keySalt?: string;
}

export class TidalApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export interface TidalClientOptions {
  baseUrl?: string;
  countryCode?: string;
  /** Max concurrent requests. TIDAL rate-limits per client; 429s are handled with backoff. */
  concurrency?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
}

export const trackUrl = (id: string) => `https://tidal.com/browse/track/${id}`;
export const playlistUrl = (id: string) => `https://tidal.com/browse/playlist/${id}`;

export class TidalClient {
  private readonly baseUrl: string;
  private readonly limit: Limiter;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  /** When TIDAL says slow down, every request waits until this time. */
  private pausedUntil = 0;
  private readonly trackCache = new Map<string, TidalTrack>();
  private nestedSearchInclude: boolean | undefined;
  countryCode: string;

  constructor(
    private readonly tokens: Pick<TokenManager, 'getAccessToken' | 'forceRefresh'>,
    opts: TidalClientOptions = {},
  ) {
    this.baseUrl = (opts.baseUrl ?? 'https://openapi.tidal.com/v2').replace(/\/$/, '');
    this.countryCode = opts.countryCode ?? 'US';
    this.limit = createLimiter(opts.concurrency ?? 4);
    this.maxRetries = opts.maxRetries ?? 6;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  // ---------------------------------------------------------------- transport

  private buildUrl(path: string, query?: Record<string, string | string[] | undefined>) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined) continue;
      for (const item of Array.isArray(v) ? v : [v]) qs.append(k, item);
    }
    const s = qs.toString();
    return `${this.baseUrl}${path}${s ? `?${s}` : ''}`;
  }

  async request<T = Document>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    opts: {
      query?: Record<string, string | string[] | undefined>;
      body?: unknown;
      idempotencyKey?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<T | undefined> {
    const url = this.buildUrl(path, opts.query);
    // Writes are only retried when they carry an idempotency key.
    const retryable = method === 'GET' || Boolean(opts.idempotencyKey);
    return this.limit(async () => {
      let refreshed = false;
      for (let attempt = 0; ; attempt++) {
        const wait = this.pausedUntil - Date.now();
        if (wait > 0) await sleep(wait, opts.signal);
        const token = await this.tokens.getAccessToken();
        let res: Response;
        try {
          res = await this.fetchImpl(url, {
            method,
            signal: opts.signal,
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: JSON_API,
              ...(opts.body !== undefined ? { 'Content-Type': JSON_API } : {}),
              ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
            },
            body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          });
        } catch (err) {
          if (opts.signal?.aborted || !retryable || attempt >= this.maxRetries) throw err;
          await sleep(backoff(attempt), opts.signal);
          continue;
        }

        if (res.status === 401 && !refreshed) {
          refreshed = true;
          await this.tokens.forceRefresh();
          continue;
        }
        if ((res.status === 429 || res.status >= 500) && retryable && attempt < this.maxRetries) {
          const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
          const delay = retryAfter ?? backoff(attempt);
          if (res.status === 429) this.pausedUntil = Math.max(this.pausedUntil, Date.now() + delay);
          await res.body?.cancel();
          await sleep(delay, opts.signal);
          continue;
        }

        const text = await res.text();
        const json = text ? safeJson(text) : undefined;
        if (!res.ok) {
          const errors = (json as { errors?: { detail?: string; code?: string }[] } | undefined)?.errors;
          const detail = errors?.map((e) => e.detail || e.code).filter(Boolean).join('; ') || text.slice(0, 200);
          throw new TidalApiError(`TIDAL API ${method} ${path} failed (${res.status}): ${detail}`, res.status, json);
        }
        return json as T | undefined;
      }
    });
  }

  // ---------------------------------------------------------------- users

  async getMe(): Promise<TidalUser> {
    const doc = await this.request<Document>('GET', '/users/me');
    const r = single(doc);
    if (!r) throw new TidalApiError('TIDAL returned no user', 500);
    const a = r.attributes ?? {};
    return {
      id: r.id,
      username: str(a.username),
      country: str(a.country) ?? 'US',
      email: str(a.email),
      firstName: str(a.firstName),
    };
  }

  // ---------------------------------------------------------------- catalog

  /** Track resources (with artist + album names) by id, ≤ 20 per request, cached. */
  async getTracks(ids: string[], signal?: AbortSignal): Promise<Map<string, TidalTrack>> {
    const out = new Map<string, TidalTrack>();
    const missing = [...new Set(ids)].filter((id) => {
      const hit = this.trackCache.get(id);
      if (hit) out.set(id, hit);
      return !hit;
    });
    await Promise.all(
      chunk(missing, 20).map(async (batch) => {
        const doc = await this.request<Document>('GET', '/tracks', {
          query: { countryCode: this.countryCode, 'filter[id]': batch, include: ['artists', 'albums'] },
          signal,
        });
        for (const t of parseTracks(doc)) {
          this.trackCache.set(t.id, t);
          out.set(t.id, t);
        }
      }),
    );
    return out;
  }

  /** Tracks by ISRC, ≤ 20 ISRCs per request (one track per ISRC when several are given). */
  async getTracksByIsrc(isrcs: string[], signal?: AbortSignal): Promise<TidalTrack[]> {
    const results = await Promise.all(
      chunk([...new Set(isrcs)], 20).map(async (batch) => {
        const doc = await this.request<Document>('GET', '/tracks', {
          query: { countryCode: this.countryCode, 'filter[isrc]': batch, include: ['artists', 'albums'] },
          signal,
        });
        const tracks = parseTracks(doc);
        tracks.forEach((t) => this.trackCache.set(t.id, t));
        return tracks;
      }),
    );
    return results.flat();
  }

  /** Search the catalog; returns up to `limit` tracks in TIDAL's relevance order. */
  async searchTracks(query: string, limit = 8, signal?: AbortSignal): Promise<TidalTrack[]> {
    const q = query.slice(0, 256);
    let doc: Document | undefined;
    // Try to get artists/albums in the same response (JSON:API nested include). If the
    // server rejects that, fall back to plain `include=tracks` + a /tracks lookup.
    if (this.nestedSearchInclude !== false) {
      try {
        doc = await this.request<Document>('GET', '/searchResults', {
          query: {
            'filter[query]': q,
            countryCode: this.countryCode,
            explicitFilter: 'INCLUDE',
            include: ['tracks', 'tracks.artists', 'tracks.albums'],
          },
          signal,
        });
      } catch (err) {
        if (!(err instanceof TidalApiError && err.status === 400)) throw err;
        this.nestedSearchInclude = false;
      }
    }
    doc ??= await this.request<Document>('GET', '/searchResults', {
      query: { 'filter[query]': q, countryCode: this.countryCode, explicitFilter: 'INCLUDE', include: ['tracks'] },
      signal,
    });

    const result = single(doc);
    const rel = result?.relationships?.tracks?.data;
    const ids = (Array.isArray(rel) ? rel : []).map((i) => i.id).slice(0, limit);
    if (!ids.length) return [];

    // Use what the search response already contains; hydrate the rest.
    const fromSearch = new Map(parseTracks({ data: [], included: doc?.included }).map((t) => [t.id, t]));
    const complete = (t: TidalTrack | undefined) => t && t.artists.length > 0;
    if (this.nestedSearchInclude === undefined) this.nestedSearchInclude = ids.some((id) => complete(fromSearch.get(id)));
    for (const t of fromSearch.values()) if (complete(t)) this.trackCache.set(t.id, t);
    const hydrated = await this.getTracks(ids.filter((id) => !complete(fromSearch.get(id))), signal);
    return ids.map((id) => (complete(fromSearch.get(id)) ? fromSearch.get(id) : hydrated.get(id))).filter(
      (t): t is TidalTrack => Boolean(t),
    );
  }

  // ---------------------------------------------------------------- writes

  async createPlaylist(input: { name: string; description?: string; accessType?: 'PUBLIC' | 'UNLISTED' }, key?: string) {
    const doc = await this.request<Document>('POST', '/playlists', {
      body: {
        data: {
          type: 'playlists',
          attributes: {
            name: input.name.slice(0, 250),
            ...(input.description ? { description: input.description.slice(0, 500) } : {}),
            accessType: input.accessType ?? 'UNLISTED',
          },
        },
      },
      idempotencyKey: key,
    });
    const r = single(doc);
    if (!r) throw new TidalApiError('TIDAL did not return the created playlist', 500, doc);
    return { id: r.id, name: str(r.attributes?.name) ?? input.name, url: playlistUrl(r.id) } satisfies TidalPlaylist;
  }

  /**
   * Append tracks to a playlist in order, 50 per request. Each batch has a
   * deterministic idempotency key, so a retried batch is never added twice.
   */
  async addPlaylistItems(
    playlistId: string,
    items: CollectionItem[],
    opts: WriteOptions = {},
  ) {
    let i = 0;
    for (const batch of chunk(items, 50)) {
      const key = idempotencyKey('playlist-items', opts.keySalt ?? '', playlistId, String(i++), ...batch.map((b) => b.id));
      await this.writeWithMetaFallback(`/playlists/${encodeURIComponent(playlistId)}/relationships/items`, batch, key, opts.signal);
      opts.onBatch?.(batch.length);
    }
  }

  /** Add tracks to the user's favourites ("My Collection"), 50 per request. */
  async addFavoriteTracks(items: CollectionItem[], opts: WriteOptions = {}) {
    for (const batch of chunk(items, 50)) {
      const key = idempotencyKey('favorites', opts.keySalt ?? '', ...batch.map((b) => b.id));
      await this.writeWithMetaFallback('/userCollectionTracks/me/relationships/items', batch, key, opts.signal);
      opts.onBatch?.(batch.length);
    }
  }

  /**
   * Items may carry `meta.addedAt` (the date it was added in the source service).
   * If TIDAL rejects that metadata, retry the batch without it.
   */
  private async writeWithMetaFallback(path: string, batch: CollectionItem[], key: string, signal?: AbortSignal) {
    const body = (withMeta: boolean) => ({
      data: batch.map((b) => ({
        id: b.id,
        type: 'tracks',
        ...(withMeta && b.addedAt ? { meta: { addedAt: b.addedAt } } : {}),
      })),
    });
    const hasMeta = batch.some((b) => b.addedAt);
    try {
      await this.request('POST', path, { body: body(hasMeta), idempotencyKey: key, signal });
    } catch (err) {
      if (hasMeta && err instanceof TidalApiError && (err.status === 400 || err.status === 422)) {
        await this.request('POST', path, { body: body(false), idempotencyKey: `${key}-nometa`, signal });
      } else throw err;
    }
  }
}

// ---------------------------------------------------------------- helpers

function backoff(attempt: number) {
  return Math.min(30_000, 1000 * 2 ** attempt) * (0.8 + Math.random() * 0.2);
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function idempotencyKey(...parts: string[]) {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 64);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function single(doc: Document | undefined): Resource | undefined {
  const d = doc?.data;
  return Array.isArray(d) ? d[0] : (d ?? undefined);
}

function ids(rel: { data?: Identifier | Identifier[] | null } | undefined): string[] {
  const d = rel?.data;
  if (!d) return [];
  return (Array.isArray(d) ? d : [d]).map((i) => i.id);
}

/** Extract tracks from a document's primary data and included resources. */
export function parseTracks(doc: Document | undefined): TidalTrack[] {
  if (!doc) return [];
  const all: Resource[] = [...(Array.isArray(doc.data) ? doc.data : doc.data ? [doc.data] : []), ...(doc.included ?? [])];
  const byKey = new Map(all.map((r) => [`${r.type}:${r.id}`, r]));
  const name = (type: string, id: string, attr: string) => str(byKey.get(`${type}:${id}`)?.attributes?.[attr]);
  const seen = new Set<string>();
  const tracks: TidalTrack[] = [];
  for (const r of all) {
    if (r.type !== 'tracks' || seen.has(r.id)) continue;
    seen.add(r.id);
    const a = r.attributes ?? {};
    const title = str(a.title);
    if (!title) continue;
    const artistIds = ids(r.relationships?.artists);
    const albumIds = ids(r.relationships?.albums);
    tracks.push({
      id: r.id,
      title,
      version: str(a.version),
      artists: artistIds.map((id) => name('artists', id, 'name')).filter((n): n is string => Boolean(n)),
      album: albumIds.map((id) => name('albums', id, 'title')).find(Boolean),
      durationMs: isoDurationToMs(str(a.duration)),
      isrc: str(a.isrc),
      explicit: typeof a.explicit === 'boolean' ? a.explicit : undefined,
      url: trackUrl(r.id),
    });
  }
  return tracks;
}
