import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { BundleError, buildBundle } from '../src/core/bundle/bundle.js';
import { takeoutZip } from './helpers.js';

describe('buildBundle', () => {
  it('flattens a zip and drops macOS junk', () => {
    const b = buildBundle([{ name: 'takeout.zip', data: takeoutZip() }]);
    const paths = b.files.map((f) => f.path);
    expect(paths.some((p) => p.includes('__MACOSX') || p.split('/').pop()!.startsWith('._'))).toBe(false);
    expect(paths).toContain('takeout/youtube_music/YouTube and YouTube Music/playlists/Road trip.csv');
    expect(b.sources).toEqual(['takeout.zip']);
  });

  it('passes a plain CSV through', () => {
    const b = buildBundle([{ name: 'songs.csv', data: strToU8('Title,Artist\nA,B') }]);
    expect(b.files).toHaveLength(1);
    expect(b.files[0]!.name).toBe('songs.csv');
  });

  it('expands nested zips and merges several uploads', () => {
    const inner = zipSync({ 'a.csv': strToU8('x') });
    const outer = zipSync({ 'part1/inner.zip': inner });
    const b = buildBundle([
      { name: 'outer.zip', data: outer },
      { name: 'b.csv', data: strToU8('y') },
    ]);
    expect(b.files.map((f) => f.path).sort()).toEqual(['b.csv', 'outer/part1/inner/a.csv']);
  });

  it('rejects archives that expand beyond the limit', () => {
    const big = zipSync({ 'big.csv': new Uint8Array(2_000_000) });
    expect(() => buildBundle([{ name: 'big.zip', data: big }], { maxTotalBytes: 1_000_000, maxFiles: 10 })).toThrow(
      BundleError,
    );
  });
});
