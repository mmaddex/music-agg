import { strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildBundle } from '../src/core/bundle/bundle.js';
import { parseDurationMs } from '../src/core/importers/generic-csv.js';
import { detectImporters, parseExport, UnsupportedExportError } from '../src/core/importers/registry.js';
import { takeoutTimeToIso } from '../src/core/importers/youtube-music.js';
import { takeoutZip } from './helpers.js';

describe('YouTube Music Takeout importer', () => {
  const bundle = buildBundle([{ name: 'takeout.zip', data: takeoutZip() }]);

  it('is detected ahead of the generic CSV importer', () => {
    const detected = detectImporters(bundle);
    expect(detected[0]!.importer.id).toBe('youtube-music-takeout');
    expect(detected.map((d) => d.importer.id)).toContain('generic-csv');
  });

  it('parses library songs (deduplicating the duplicate file)', () => {
    const { parsed } = parseExport(bundle);
    const lib = parsed.collections.find((c) => c.kind === 'library')!;
    expect(lib.tracks).toHaveLength(4);
    expect(lib.suggestedTarget).toBe('favorites');
    expect(lib.tracks[0]).toMatchObject({
      title: '"You Got A Killer Scene There, Man..."',
      artists: ['Queens Of The Stone Age'],
      album: 'Lullabies To Paralyze',
      quality: 'export',
      refs: [{ service: 'youtube', id: 'lib00000001' }],
    });
    expect(lib.tracks[3]!.album).toBeUndefined();
  });

  it('parses playlists, cross-referencing the library for video-only entries', () => {
    const { parsed } = parseExport(bundle);
    const road = parsed.collections.find((c) => c.name === 'Road trip, 2016')!;
    expect(road.kind).toBe('playlist');
    expect(road.tracks).toHaveLength(2);
    expect(road.tracks[0]).toMatchObject({ title: '#9 Dream', quality: 'export', addedAt: '2017-01-02T02:39:57Z' });
    expect(road.tracks[1]).toMatchObject({ quality: 'missing', refs: [{ id: 'vidUnknown1' }] });
  });

  it('classifies special playlists and skips empty ones', () => {
    const { parsed } = parseExport(bundle);
    const liked = parsed.collections.find((c) => c.name === 'Liked videos')!;
    expect(liked.kind).toBe('liked');
    expect(parsed.collections.find((c) => c.name === 'Watch later')!.suggestedTarget).toBe('skip');
    expect(parsed.collections.find((c) => c.name === 'Empty')).toBeUndefined();
    expect(parsed.warnings.join()).toMatch(/Empty/);
  });

  it('converts Takeout timestamps', () => {
    expect(takeoutTimeToIso('2016-10-06 05:47:44 UTC')).toBe('2016-10-06T05:47:44Z');
    expect(takeoutTimeToIso('garbage')).toBeUndefined();
  });
});

describe('generic CSV importer', () => {
  it('maps loosely named columns and groups by a playlist column', () => {
    const csv = [
      'Track Name,Artist Name(s),Album Name,ISRC,Duration (ms),Playlist',
      'Hey Jude,The Beatles,Hey Jude,GBAYE0601690,431000,Classics',
      'Our House,"Crosby, Stills, Nash & Young",Déjà Vu,,182000,Classics',
      'Mr. Blue Sky,Electric Light Orchestra,Out of the Blue,,303000,Pop',
    ].join('\n');
    const bundle = buildBundle([{ name: 'export.csv', data: strToU8(csv) }]);
    const { parsed } = parseExport(bundle);
    expect(parsed.importerId).toBe('generic-csv');
    expect(parsed.collections.map((c) => [c.name, c.tracks.length])).toEqual([
      ['Classics', 2],
      ['Pop', 1],
    ]);
    expect(parsed.collections[0]!.tracks[0]).toMatchObject({
      title: 'Hey Jude',
      artists: ['The Beatles'],
      isrc: 'GBAYE0601690',
      durationMs: 431000,
    });
    expect(parsed.collections[0]!.tracks[1]!.artists).toEqual(['Crosby, Stills, Nash & Young']);
  });

  it('handles semicolon-delimited files and names the collection after the file', () => {
    const bundle = buildBundle([{ name: 'Favourites.csv', data: strToU8('Title;Artist\nSong A;Band A\n') }]);
    const { parsed } = parseExport(bundle);
    expect(parsed.collections[0]).toMatchObject({ name: 'Favourites', tracks: [{ title: 'Song A', artists: ['Band A'] }] });
  });

  it('parses durations in several formats', () => {
    expect(parseDurationMs('3:35')).toBe(215000);
    expect(parseDurationMs('215')).toBe(215000);
    expect(parseDurationMs('215000', 'Duration (ms)')).toBe(215000);
    expect(parseDurationMs('1:02:03')).toBe(3723000);
  });
});

describe('format detection', () => {
  it('explains unsupported uploads', () => {
    const bundle = buildBundle([{ name: 'notes.txt', data: strToU8('hello') }]);
    expect(() => parseExport(bundle)).toThrow(UnsupportedExportError);
  });

  it('honours an explicitly chosen importer', () => {
    const bundle = buildBundle([{ name: 'takeout.zip', data: takeoutZip() }]);
    const { parsed } = parseExport(bundle, 'generic-csv');
    expect(parsed.importerId).toBe('generic-csv');
  });
});
