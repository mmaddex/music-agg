// Fills in title/artist for tracks that only have a YouTube video id, using YouTube's
// public oEmbed endpoint (no API key needed). Results are best-effort: oEmbed returns the
// *video* title and channel name, so we clean them up into a likely song/artist pair.

import { stripDecorations } from '../util/text.js';

const OEMBED = 'https://www.youtube.com/oembed';

/**
 * Turn a YouTube video title + channel name into { title, artist }.
 *   "Artist - Song (Official Video)", "ArtistVEVO"     -> { artist: "Artist", title: "Song" }
 *   "Song", "Artist - Topic"                            -> { artist: "Artist", title: "Song" }
 */
export function parseVideoTitle(videoTitle, channel) {
  const raw = String(videoTitle || '').trim();
  let artist = String(channel || '')
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/VEVO$/i, '')
    .replace(/\s*(official|music|channel|records)\s*$/gi, '')
    .trim();
  const isTopic = /-\s*Topic$/i.test(channel || '');
  let title = raw;

  // "Artist - Title" / "Artist – Title" / "Artist | Title". Skip on auto-generated
  // "- Topic" channels where the title is already just the song name.
  const dash = /^(.+?)\s+[-–—|]\s+(.+)$/.exec(raw);
  if (dash && !isTopic) {
    artist = dash[1].trim();
    title = dash[2].trim();
  }
  // Quoted song name: Artist "Song" (Live at ...)
  const quoted = /^(.+?)\s+["“](.+?)["”]/.exec(title);
  if (!dash && quoted) {
    artist = quoted[1].trim();
    title = quoted[2].trim();
  }
  return { title, artist: artist || null };
}

/**
 * Enrich tracks in place. `fetchImpl` is injectable for tests.
 * Returns { enriched, failed } counts.
 */
export async function enrichYouTubeTracks(tracks, { fetchImpl = fetch, concurrency = 4, onProgress } = {}) {
  const pending = tracks.filter((t) => t.needsLookup && t.source?.type === 'youtube');
  let enriched = 0;
  let failed = 0;
  let next = 0;

  async function worker() {
    while (next < pending.length) {
      const track = pending[next];
      next += 1;
      try {
        const url = `${OEMBED}?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${track.source.id}`)}`;
        const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) {
          // 401/403/404: private, deleted or embed-disabled video.
          track.lookupError = res.status === 404 || res.status === 401 || res.status === 403 ? 'Video is private or no longer available on YouTube' : `YouTube lookup failed (${res.status})`;
          failed += 1;
        } else {
          const data = await res.json();
          const { title, artist } = parseVideoTitle(data.title, data.author_name);
          track.title = stripDecorations(title) || title || null;
          track.artistCredit = artist;
          track.artists = artist ? [artist] : [];
          track.videoTitle = data.title;
          track.channel = data.author_name;
          track.needsLookup = !track.title;
          track.fromVideoTitle = true; // lower confidence: matcher will be stricter
          enriched += 1;
        }
      } catch (err) {
        track.lookupError = `YouTube lookup failed (${err.name === 'TimeoutError' ? 'timeout' : err.message})`;
        failed += 1;
      }
      onProgress?.(enriched + failed, pending.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
  return { enriched, failed };
}
