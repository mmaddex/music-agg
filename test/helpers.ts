import { strToU8, zipSync } from 'fflate';
import type { TidalTrack } from '../src/core/tidal/client.js';

export const LIBRARY_CSV = [
  'Song URL,Song Title,Album Title,Artist Names',
  'https://music.youtube.com/watch?v=lib00000001,"""You Got A Killer Scene There, Man...""",Lullabies To Paralyze,Queens Of The Stone Age',
  'https://music.youtube.com/watch?v=lib00000002,#9 Dream,Walls And Bridges,John Lennon',
  'https://music.youtube.com/watch?v=lib00000003,Aloha & the Three Johns,The Voyager,Jenny Lewis',
  'https://music.youtube.com/watch?v=lib00000004,Something Biblical,,Andrew Bird',
].join('\n');

export function playlistCsv(opts: { id: string; title: string; videos: [string, string][]; description?: string }) {
  return [
    'Playlist Id,Channel Id,Time Created,Time Updated,Title,Description,Visibility',
    `${opts.id},UCchannel,2018-02-21 19:51:13 UTC,2020-12-10 11:01:38 UTC,"${opts.title}",${opts.description ?? ''},Private`,
    '',
    '',
    'Video Id,Time Added',
    ...opts.videos.map(([v, t]) => `${v},${t}`),
    '',
  ].join('\n');
}

/** A miniature Google Takeout zip, including the macOS junk real zips often carry. */
export function takeoutZip(): Uint8Array {
  const root = 'youtube_music/YouTube and YouTube Music';
  return zipSync({
    [`${root}/music-library-songs/music-library-songs.csv`]: strToU8(LIBRARY_CSV),
    [`${root}/music-library-songs/music-library-songs (1).csv`]: strToU8(LIBRARY_CSV),
    [`${root}/playlists/Road trip.csv`]: strToU8(
      playlistCsv({
        id: 'PLroadtrip',
        title: 'Road trip, 2016',
        videos: [
          ['lib00000002', '2017-01-02 02:39:57 UTC'],
          ['vidUnknown1', '2017-01-02 02:40:00 UTC'],
        ],
      }),
    ),
    [`${root}/playlists/Liked videos.csv`]: strToU8(
      playlistCsv({ id: 'LLchannel', title: 'Liked videos', videos: [['vidUnknown2', '2019-05-05 10:00:00 UTC']] }),
    ),
    [`${root}/playlists/Watch later.csv`]: strToU8(
      playlistCsv({ id: 'PLwatch', title: 'Watch later', videos: [['vidTalk0001', '2019-05-05 10:00:00 UTC']] }),
    ),
    [`${root}/playlists/Empty.csv`]: strToU8(playlistCsv({ id: 'PLempty', title: 'Empty', videos: [] })),
    'youtube_music/archive_browser.html': strToU8('<html></html>'),
    '__MACOSX/youtube_music/._archive_browser.html': strToU8('junk'),
    [`__MACOSX/${root}/playlists/._Road trip.csv`]: strToU8('junk'),
  });
}

export function track(id: string, title: string, artists: string[], extra: Partial<TidalTrack> = {}): TidalTrack {
  return { id, title, artists, url: `https://tidal.com/browse/track/${id}`, ...extra };
}

/** Build a Response like fetch would return. */
export function jsonResponse(status: number, body?: unknown, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/vnd.api+json', ...headers },
  });
}
