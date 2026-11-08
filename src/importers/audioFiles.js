// Audio files inside an export (songs a user uploaded to Google Play Music, for example) can't
// be imported: TIDAL only adds tracks from its own catalogue and has no way to upload your own
// audio. They are listed with the import so they show up in its "not imported" record.
//
// File names are the only description we have. Google Play Music writes them as
//   "Artist - Album - Title.mp3"           ("Trio Mossoró -  - Hoje não, saudade.mp3")
//   "Artist - Album(NNN)Title.mp3"         (title cut short: "… - Dream Dictionary(002)The Past .mp3")
// and Takeout often ships a second copy with " (1)" added. Anything else is kept as a title.
//
// When an audio file's song is also in the export's song lists (same artist, same or truncated
// title), it is linked by track key, so the record can say whether that song still reached
// TIDAL from the catalogue, and the song's full title/album are used.
//
// NotImportable { path, title, artist, album, reason: 'own_audio_file', linkedKey }

import path from 'node:path';
import { normalize } from '../util/text.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Artist - Album - Title.mp3" → { artist, album, title } (fields may be null). */
export function describeAudioFile(filePath) {
  let name = path.posix.basename(filePath).replace(/\.[^.]+$/, '');
  name = name.replace(/\s*\(\d+\)$/, '').trim(); // Takeout duplicate copies: "Song (1)"
  const clean = (v) => (v && v.trim()) || null;
  let m = /^(.+?) - (.*?) - (.+)$/.exec(name);
  if (m) return { artist: clean(m[1]), album: clean(m[2]), title: clean(m[3]), truncated: false };
  m = /^(.+?) - (.*?)\(\d{3}\)(.+)$/.exec(name);
  if (m) return { artist: clean(m[1]), album: clean(m[2]), title: clean(m[3]), truncated: true };
  m = /^(.+?) - (.+)$/.exec(name);
  if (m) return { artist: clean(m[1]), album: null, title: clean(m[2]), truncated: false };
  return { artist: null, album: null, title: clean(name), truncated: false };
}

/**
 * bundle.media → { items: NotImportable[], warning|null }. Duplicate copies (same song and size,
 * or the same path from a repeated upload) are listed once.
 */
export function audioFilesNotImportable(media = [], collections = []) {
  // Every source track, by normalised artist, for linking.
  const byArtist = new Map();
  for (const c of collections) {
    for (const t of c.tracks) {
      const artist = normalize(t.artistCredit);
      if (!artist || !t.title) continue;
      if (!byArtist.has(artist)) byArtist.set(artist, []);
      byArtist.get(artist).push({ title: normalize(t.title), track: t });
    }
  }
  const link = ({ artist, title, truncated }) => {
    const candidates = byArtist.get(normalize(artist)) || [];
    const want = normalize(title);
    if (!want) return null;
    const hit =
      candidates.find((c) => c.title === want) ||
      (truncated && want.length >= 4 ? candidates.find((c) => c.title.startsWith(want)) : null);
    return hit?.track || null;
  };

  const seen = new Set();
  const items = [];
  // Originals before their " (1)" copies, so the record points at the plain file name.
  const copyNo = (p) => Number(/\((\d+)\)\.[^./]+$/.exec(p)?.[1] || 0);
  const ordered = [...media].sort((a, b) => copyNo(a.path) - copyNo(b.path) || a.path.localeCompare(b.path));
  for (const file of ordered) {
    const d = describeAudioFile(file.path);
    const id = `${normalize(d.artist)}|${normalize(d.album)}|${normalize(d.title)}|${file.size}`;
    if (seen.has(file.path) || seen.has(id)) continue;
    seen.add(file.path);
    seen.add(id);
    // A linked song's own title/album are complete; file names are often cut short.
    const t = link(d);
    items.push({
      path: file.path,
      title: t?.title ?? d.title,
      artist: t?.artistCredit ?? d.artist,
      album: t ? t.album : d.album,
      reason: 'own_audio_file',
      linkedKey: t?.key ?? null,
    });
  }
  const warning = items.length
    ? `${plural(items.length, 'audio file')} in this export can't be imported: TIDAL only adds songs from its own catalogue and can't store your own audio. ${items.length === 1 ? "It's" : "They're"} listed in the import's "not imported" record.`
    : null;
  return { items, warning };
}
