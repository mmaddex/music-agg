import type { SourceTrack } from '../model.js';
import { chunk, mapLimit, sleep } from '../util/async.js';
import { isoDurationToMs } from '../util/duration.js';
import type { EnrichContext, TrackEnricher } from './types.js';
import { parseVideoTitle } from './video-title.js';

/** Metadata about one YouTube video, from whichever lookup succeeded. */
export interface VideoInfo {
  title: string;
  channel?: string;
  durationMs?: number;
  /** YouTube category id; "10" is Music. Only available via the Data API. */
  categoryId?: string;
}

export type VideoLookupResult = { ok: true; info: VideoInfo } | { ok: false; reason: string };

function youtubeId(track: SourceTrack): string | undefined {
  return track.refs.find((r) => r.service === 'youtube')?.id;
}

/** Video metadata is public and never changes per user, so a process-wide cache is fine. */
const cache = new Map<string, VideoLookupResult>();
const CACHE_LIMIT = 50_000;
function remember(id: string, r: VideoLookupResult) {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(id, r);
}

export function applyVideoInfo(track: SourceTrack, raw: VideoInfo) {
  // YouTube mixes Unicode forms (e.g. decomposed "ó" in titles, precomposed in channel names).
  const info = { ...raw, title: raw.title.normalize('NFC'), channel: raw.channel?.normalize('NFC') };
  const parsed = parseVideoTitle(info.title, info.channel);
  track.title = parsed.title || info.title;
  track.artists = parsed.artist ? [parsed.artist] : [];
  track.durationMs ??= info.durationMs;
  track.quality = 'inferred';
  track.hints = {
    ...track.hints,
    videoTitle: info.title,
    ...(info.channel ? { channel: info.channel } : {}),
    ...(parsed.artistFromChannel ? { weakArtist: '1' } : {}),
    ...(info.categoryId && info.categoryId !== '10' ? { nonMusic: '1' } : {}),
  };
}

/**
 * Shared driver: group tracks needing lookup by video id, look each id up once,
 * apply the result to every track with that id.
 */
async function enrichByVideoId(
  tracks: SourceTrack[],
  ctx: EnrichContext,
  lookup: (ids: string[], ctx: EnrichContext) => AsyncIterable<[string, VideoLookupResult]>,
) {
  const byId = new Map<string, SourceTrack[]>();
  for (const t of tracks) {
    const id = youtubeId(t);
    if (!id || t.quality !== 'missing') continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id)!.push(t);
  }
  const apply = (id: string, r: VideoLookupResult) => {
    for (const t of byId.get(id) ?? []) {
      if (r.ok) applyVideoInfo(t, r.info);
      else t.hints = { ...t.hints, unavailable: r.reason };
    }
  };

  const ids = [...byId.keys()];
  const todo: string[] = [];
  let done = 0;
  for (const id of ids) {
    const hit = cache.get(id);
    if (hit) {
      apply(id, hit);
      done++;
    } else todo.push(id);
  }
  ctx.onProgress?.(done, ids.length);
  for await (const [id, r] of lookup(todo, ctx)) {
    if (r.ok || r.reason !== 'Lookup failed') remember(id, r);
    apply(id, r);
    ctx.onProgress?.(++done, ids.length);
  }
}

async function fetchWithRetry(
  url: string,
  ctx: EnrichContext,
  attempts = 4,
): Promise<Response> {
  const f = ctx.fetch ?? fetch;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await f(url, { signal: ctx.signal });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
      } else {
        return res;
      }
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      lastErr = err;
    }
    await sleep(500 * 2 ** i, ctx.signal);
  }
  throw lastErr;
}

/**
 * Keyless lookup through YouTube's public oEmbed endpoint. One request per video;
 * returns title + channel name (no duration).
 */
export function youtubeOEmbedEnricher(opts: { concurrency?: number } = {}): TrackEnricher {
  const concurrency = opts.concurrency ?? 6;
  return {
    id: 'youtube-oembed',
    appliesTo: (t) => t.quality === 'missing' && Boolean(youtubeId(t)),
    enrich(tracks, ctx) {
      return enrichByVideoId(tracks, ctx, async function* (ids, ctx) {
        // Yield results as they complete, while keeping `concurrency` requests in flight.
        const results: [string, VideoLookupResult][] = [];
        let notify: (() => void) | undefined;
        let finished = false;
        const run = mapLimit(ids, concurrency, async (id) => {
          let r: VideoLookupResult;
          try {
            const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(
              `https://www.youtube.com/watch?v=${id}`,
            )}`;
            const res = await fetchWithRetry(url, ctx);
            if (res.ok) {
              const body = (await res.json()) as { title?: string; author_name?: string };
              r = body.title
                ? { ok: true, info: { title: body.title, channel: body.author_name } }
                : { ok: false, reason: 'No title returned' };
            } else if (res.status === 401 || res.status === 403) {
              r = { ok: false, reason: 'Video is private or restricted' };
            } else if (res.status === 404 || res.status === 400) {
              r = { ok: false, reason: 'Video no longer exists' };
            } else {
              r = { ok: false, reason: 'Lookup failed' };
            }
          } catch (err) {
            if (ctx.signal?.aborted) throw err;
            r = { ok: false, reason: 'Lookup failed' };
          }
          results.push([id, r]);
          notify?.();
        }).finally(() => {
          finished = true;
          notify?.();
        });
        run.catch(() => {}); // rethrown by `await run` below; avoid an unhandled-rejection crash meanwhile
        while (!finished || results.length) {
          if (!results.length) await new Promise<void>((res) => (notify = res));
          notify = undefined;
          while (results.length) yield results.shift()!;
        }
        await run;
      });
    },
  };
}

/**
 * Lookup through the YouTube Data API v3 (needs YOUTUBE_API_KEY). 50 ids per
 * request, and also returns duration + category, which improves matching.
 */
export function youtubeDataApiEnricher(apiKey: string): TrackEnricher {
  return {
    id: 'youtube-data-api',
    appliesTo: (t) => t.quality === 'missing' && Boolean(youtubeId(t)),
    enrich(tracks, ctx) {
      return enrichByVideoId(tracks, ctx, async function* (ids, ctx) {
        for (const batch of chunk(ids, 50)) {
          const url =
            'https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&maxResults=50' +
            `&id=${batch.map(encodeURIComponent).join(',')}&key=${encodeURIComponent(apiKey)}`;
          let found = new Map<string, VideoInfo>();
          let failed = false;
          try {
            const res = await fetchWithRetry(url, ctx);
            if (!res.ok) failed = true;
            else {
              const body = (await res.json()) as {
                items?: {
                  id: string;
                  snippet?: { title?: string; channelTitle?: string; categoryId?: string };
                  contentDetails?: { duration?: string };
                }[];
              };
              found = new Map(
                (body.items ?? [])
                  .filter((it) => it.snippet?.title)
                  .map((it) => [
                    it.id,
                    {
                      title: it.snippet!.title!,
                      channel: it.snippet!.channelTitle,
                      categoryId: it.snippet!.categoryId,
                      durationMs: isoDurationToMs(it.contentDetails?.duration),
                    },
                  ]),
              );
            }
          } catch (err) {
            if (ctx.signal?.aborted) throw err;
            failed = true;
          }
          for (const id of batch) {
            const info = found.get(id);
            yield [
              id,
              info
                ? { ok: true, info }
                : { ok: false, reason: failed ? 'Lookup failed' : 'Video is private or no longer exists' },
            ];
          }
        }
      });
    },
  };
}

/** Run the configured enrichers in order over all tracks. */
export async function enrichTracks(tracks: SourceTrack[], enrichers: TrackEnricher[], ctx: EnrichContext) {
  for (const e of enrichers) {
    const relevant = tracks.filter((t) => e.appliesTo(t));
    if (relevant.length) await e.enrich(relevant, ctx);
  }
}

export function defaultEnrichers(youtubeApiKey?: string): TrackEnricher[] {
  // With a key, try the Data API first; anything it couldn't fetch falls through to oEmbed.
  return youtubeApiKey ? [youtubeDataApiEnricher(youtubeApiKey), youtubeOEmbedEnricher()] : [youtubeOEmbedEnricher()];
}

/** For tests. */
export function clearVideoCache() {
  cache.clear();
}
