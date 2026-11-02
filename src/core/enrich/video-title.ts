/**
 * Turn a YouTube video title + channel name into a best-guess { artist, title }.
 *
 * Handles the common shapes:
 *   "Our House"                     by "Crosby, Stills, Nash & Young - Topic"  (auto-generated "Topic" channels)
 *   "Adele - Hello (Official Video)" by "AdeleVEVO"
 *   "Clara Nunes - Feira de Mangaio (Forró Stream)" by "Forró Stream"         (uploader is not the artist)
 *   "Hello"                         by "Adele"                                 (artist's own channel)
 */

export interface ParsedVideoTitle {
  title: string;
  artist?: string;
  /** True when the artist came from the channel name rather than the title/topic. */
  artistFromChannel: boolean;
}

const NOISE_WORDS =
  /\b(official|video|audio|lyrics?|lyric video|visuali[sz]er|music video|mv|m\/v|hd|hq|4k|explicit|clean|clip|videoclip|full song|with lyrics|letra|legendado)\b/i;

const DASH_SEPARATOR = /\s+[-–—~]\s+/;

function stripNoise(title: string, channel?: string): string {
  let t = title;
  // Bracketed segments that are noise or just repeat the channel name.
  t = t.replace(/\s*[([【「]([^)\]】」]*)[)\]】」]/g, (whole, inner: string) => {
    const s = inner.trim();
    if (NOISE_WORDS.test(s)) return '';
    if (channel && s.toLowerCase() === channel.toLowerCase()) return '';
    return whole;
  });
  // Trailing "| Channel | Show" segments.
  t = t.split(/\s+[|｜]\s+/)[0] ?? t;
  // Trailing hashtags.
  t = t.replace(/(\s+#[\p{L}\p{N}_]+)+\s*$/u, '');
  return t.replace(/\s{2,}/g, ' ').trim();
}

export function cleanChannelName(channel: string): { name: string; isTopic: boolean } {
  const topic = /\s+-\s+Topic$/i;
  if (topic.test(channel)) return { name: channel.replace(topic, '').trim(), isTopic: true };
  const name = channel
    .replace(/VEVO$/i, '')
    .replace(/\s*(Official|Oficial)(\s+(Channel|YouTube|Music))?$/i, '')
    .trim();
  return { name: name || channel, isTopic: false };
}

export function parseVideoTitle(rawTitle: string, rawChannel?: string): ParsedVideoTitle {
  const channel = rawChannel?.trim() || undefined;
  const ch = channel ? cleanChannelName(channel) : undefined;
  const title = stripNoise(rawTitle.trim(), channel);

  if (ch?.isTopic) {
    return { title, artist: ch.name, artistFromChannel: false };
  }

  const parts = title.split(DASH_SEPARATOR);
  if (parts.length >= 2 && parts[0] && parts[1]) {
    const [first, ...rest] = parts;
    return {
      artist: first.replace(/^["“]|["”]$/g, '').trim(),
      title: rest.join(' - ').replace(/^["“]|["”]$/g, '').trim(),
      artistFromChannel: false,
    };
  }

  return { title, artist: ch?.name, artistFromChannel: Boolean(ch) };
}
