import { beforeEach, describe, expect, it } from 'vitest';
import { clearVideoCache, enrichTracks, youtubeDataApiEnricher, youtubeOEmbedEnricher } from '../src/core/enrich/youtube.js';
import { parseVideoTitle } from '../src/core/enrich/video-title.js';
import type { SourceTrack } from '../src/core/model.js';

describe('parseVideoTitle', () => {
  it.each([
    ['Our House', 'Crosby, Stills, Nash & Young - Topic', 'Crosby, Stills, Nash & Young', 'Our House', false],
    ['Adele - Hello (Official Music Video)', 'AdeleVEVO', 'Adele', 'Hello', false],
    ['Clara Nunes - Feira de Mangaio (Forró Stream)', 'Forró Stream', 'Clara Nunes', 'Feira de Mangaio', false],
    ['Hello [Lyrics] #pop #music', 'Adele', 'Adele', 'Hello', true],
    ['Bill Belichick Declines Medal | Morning Joe | MSNBC', 'MS NOW', 'MS NOW', 'Bill Belichick Declines Medal', true],
    ['Day After Day (Remastered 2010)', 'Badfinger - Topic', 'Badfinger', 'Day After Day (Remastered 2010)', false],
  ])('%s / %s', (title, channel, artist, song, fromChannel) => {
    const p = parseVideoTitle(title, channel);
    expect(p.artist).toBe(artist);
    expect(p.title).toBe(song);
    expect(p.artistFromChannel).toBe(fromChannel);
  });
});

const ytTrack = (id: string): SourceTrack => ({
  artists: [],
  refs: [{ service: 'youtube', id }],
  quality: 'missing',
});

describe('YouTube enrichers', () => {
  beforeEach(() => clearVideoCache());

  it('oEmbed: fills metadata, deduplicates lookups, and records unavailable videos', async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string) => {
      const id = new URL(new URL(url).searchParams.get('url')!).searchParams.get('v')!;
      calls.push(id);
      if (id === 'gone') return new Response('Not Found', { status: 404 });
      if (id === 'private') return new Response('Forbidden', { status: 403 });
      return Response.json({ title: 'Kodachrome', author_name: 'Paul Simon - Topic' });
    }) as typeof fetch;
    const tracks = [ytTrack('a'), ytTrack('a'), ytTrack('gone'), ytTrack('private')];
    const progress: number[] = [];
    await enrichTracks(tracks, [youtubeOEmbedEnricher()], { fetch: fakeFetch, onProgress: (d) => progress.push(d) });
    expect(calls.sort()).toEqual(['a', 'gone', 'private']);
    expect(tracks[0]).toMatchObject({ title: 'Kodachrome', artists: ['Paul Simon'], quality: 'inferred' });
    expect(tracks[1]).toMatchObject({ title: 'Kodachrome', quality: 'inferred' });
    expect(tracks[2]).toMatchObject({ quality: 'missing', hints: { unavailable: 'Video no longer exists' } });
    expect(tracks[3]!.hints?.unavailable).toMatch(/private/);
    expect(progress.at(-1)).toBe(3);
  });

  it('Data API: batches ids and falls back to oEmbed for what it could not fetch', async () => {
    const dataCalls: string[] = [];
    const fakeFetch = (async (url: string) => {
      const u = new URL(url);
      if (u.hostname === 'www.googleapis.com') {
        dataCalls.push(u.searchParams.get('id')!);
        return new Response('quota', { status: 403 });
      }
      return Response.json({ title: 'Song', author_name: 'Band - Topic' });
    }) as typeof fetch;
    const tracks = [ytTrack('x'), ytTrack('y')];
    await enrichTracks(tracks, [youtubeDataApiEnricher('KEY'), youtubeOEmbedEnricher()], { fetch: fakeFetch });
    expect(dataCalls).toEqual(['x,y']);
    expect(tracks.every((t) => t.quality === 'inferred' && t.artists[0] === 'Band')).toBe(true);
  });

  it('Data API: uses duration and flags non-music categories', async () => {
    const fakeFetch = (async () =>
      Response.json({
        items: [
          { id: 'm', snippet: { title: 'Wilco - Jesus, Etc.', channelTitle: 'Wilco', categoryId: '10' }, contentDetails: { duration: 'PT3M51S' } },
          { id: 't', snippet: { title: 'A talk', channelTitle: 'TEDx Talks', categoryId: '27' }, contentDetails: { duration: 'PT12M' } },
        ],
      })) as unknown as typeof fetch;
    const tracks = [ytTrack('m'), ytTrack('t')];
    await enrichTracks(tracks, [youtubeDataApiEnricher('KEY')], { fetch: fakeFetch });
    expect(tracks[0]).toMatchObject({ title: 'Jesus, Etc.', artists: ['Wilco'], durationMs: 231000 });
    expect(tracks[1]!.hints?.nonMusic).toBe('1');
  });
});
