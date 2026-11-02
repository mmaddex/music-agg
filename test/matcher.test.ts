import { describe, expect, it } from 'vitest';
import { Matcher, artistSimilarity, buildQueries, classify, identifyingNumbers, scoreCandidate, shouldPreselect, type CatalogSearch } from '../src/core/matching/matcher.js';
import { normalizeTitle } from '../src/core/matching/normalize.js';
import type { SourceTrack } from '../src/core/model.js';
import type { TidalTrack } from '../src/core/tidal/client.js';
import { track } from './helpers.js';

const src = (title: string, artist: string, extra: Partial<SourceTrack> = {}): SourceTrack => ({
  title,
  artists: artist ? [artist] : [],
  refs: [],
  quality: 'export',
  ...extra,
});

describe('normalisation', () => {
  it('drops remaster/featuring noise but keeps meaningful versions', () => {
    expect(normalizeTitle('Everybody Knows This Is Nowhere (2009 Remaster)').core).toBe('everybody knows this is nowhere');
    expect(normalizeTitle('Dearly Departed (feat. Esmé Patterson)').core).toBe('dearly departed');
    expect(normalizeTitle('Day After Day - Remastered 2010').core).toBe('day after day');
    expect(normalizeTitle('Harvest Moon (Live)').qualifiers).toEqual(['live']);
    expect(normalizeTitle('Forró de Tamanco').core).toBe('forro de tamanco');
  });

  it('compares multi-artist credits sensibly', () => {
    expect(artistSimilarity(['Crosby, Stills, Nash & Young'], ['Crosby, Stills, Nash & Young'])).toBe(1);
    expect(artistSimilarity(['John Lennon, Yoko Ono'], ['John Lennon', 'Yoko Ono'])).toBe(1);
    expect(artistSimilarity(['Polo & Pan'], ['Polo and Pan'])).toBe(1);
    expect(artistSimilarity(['Fred Dantas, Ailton Reiner'], ['Fred Dantas'])).toBeGreaterThan(0.9);
    expect(artistSimilarity(['The National'], ['Taylor Swift'])).toBeLessThan(0.4);
  });
});

describe('scoring', () => {
  it('accepts an exact match and a remaster of the same song', () => {
    const s = src('Our House', 'Crosby, Stills, Nash & Young');
    const best = scoreCandidate(s, track('1', 'Our House', ['Crosby, Stills, Nash & Young'], { version: '2005 Remaster' }));
    expect(classify(s, best)).toBe('matched');
  });

  it('flags live vs studio and karaoke versions', () => {
    const s = src('Harvest Moon', 'Neil Young');
    const live = scoreCandidate(s, track('2', 'Harvest Moon', ['Neil Young'], { version: 'Live' }));
    const studio = scoreCandidate(s, track('3', 'Harvest Moon', ['Neil Young']));
    const karaoke = scoreCandidate(s, track('4', 'Harvest Moon (Karaoke Version)', ['Karaoke Hits Band']));
    expect(studio.score).toBeGreaterThan(live.score);
    expect(classify(s, karaoke)).toBe('unmatched');
  });

  it('rejects a same-title song by another artist', () => {
    const s = src('Runaway', 'The National');
    const other = scoreCandidate(s, track('5', 'Runaway', ['Kanye West']));
    expect(classify(s, other)).not.toBe('matched');
  });

  it('ISRC equality is decisive', () => {
    const s = src('X', 'Y', { isrc: 'USABC1234567' });
    expect(scoreCandidate(s, track('6', 'Totally different', ['Z'], { isrc: 'usabc1234567' })).score).toBe(1);
  });

  it('guessed metadata needs a near-perfect score to auto-match', () => {
    const s = src('Kodachrome', 'Paul Simon', { quality: 'inferred' });
    expect(classify(s, scoreCandidate(s, track('7', 'Kodachrome', ['Paul Simon'])))).toBe('matched');
    expect(classify(s, scoreCandidate(s, track('8', 'Kodachrome (Demo)', ['Paul Simon'])))).toBe('review');
  });

  it('a channel-name artist does not veto a title match', () => {
    const s = src('Feira de Mangaio', 'Forró Stream', { quality: 'inferred', hints: { weakArtist: '1' } });
    const c = scoreCandidate(s, track('9', 'Feira de Mangaio', ['Clara Nunes']));
    expect(c.score).toBeGreaterThan(0.85);
  });
});

describe('queries', () => {
  it('searches with artist + title first, then fallbacks', () => {
    expect(buildQueries(src('Dearly Departed (feat. Esmé Patterson)', 'Shakey Graves'))).toEqual(['Shakey Graves Dearly Departed']);
    expect(buildQueries(src('Our House', 'Crosby, Stills, Nash & Young'))).toEqual([
      'Crosby Stills Nash & Young Our House',
      'Crosby Our House',
    ]);
    expect(buildQueries(src('Hello', 'Some Channel', { hints: { weakArtist: '1' } }))).toEqual(['Some Channel Hello', 'Hello']);
  });
});

describe('Matcher', () => {
  function fakeCatalog(results: Record<string, TidalTrack[]>, isrc: TidalTrack[] = []) {
    const queries: string[] = [];
    const catalog: CatalogSearch = {
      async searchTracks(q) {
        queries.push(q);
        return results[q] ?? [];
      },
      async getTracksByIsrc() {
        return isrc;
      },
    };
    return { catalog, queries };
  }

  it('stops after the first confident query and caches identical songs', async () => {
    const { catalog, queries } = fakeCatalog({
      'Crosby Stills Nash & Young Our House': [track('1', 'Our House', ['Crosby, Stills, Nash & Young'])],
    });
    const m = new Matcher(catalog);
    const s = src('Our House', 'Crosby, Stills, Nash & Young');
    const [a, b] = await Promise.all([m.match(s), m.match({ ...s })]);
    expect(a.status).toBe('matched');
    expect(b.best?.track.id).toBe('1');
    expect(queries).toEqual(['Crosby Stills Nash & Young Our House']);
  });

  it('tries fallback queries and reports alternatives', async () => {
    const { catalog, queries } = fakeCatalog({
      'Crosby Our House': [track('2', 'Our House', ['Madness']), track('1', 'Our House', ['Crosby, Stills, Nash & Young'])],
    });
    const r = await new Matcher(catalog).match(src('Our House', 'Crosby, Stills, Nash & Young'));
    expect(queries).toHaveLength(2);
    expect(r.best?.track.id).toBe('1');
    expect(r.alternatives.map((a) => a.track.id)).toEqual(['2']);
  });

  it('uses ISRC lookups before searching', async () => {
    const { catalog, queries } = fakeCatalog({}, [track('9', 'Hey Jude', ['The Beatles'], { isrc: 'GBAYE0601690' })]);
    const r = await new Matcher(catalog).match(src('Hey Jude', 'The Beatles', { isrc: 'GBAYE0601690' }));
    expect(r.status).toBe('matched');
    expect(queries).toEqual([]);
  });

  it('explains unresolvable tracks without searching', async () => {
    const { catalog, queries } = fakeCatalog({});
    const r = await new Matcher(catalog).match({ artists: [], refs: [], quality: 'missing', hints: { unavailable: 'Video no longer exists' } });
    expect(r).toMatchObject({ status: 'unmatched', reason: 'Video no longer exists' });
    expect(queries).toEqual([]);
  });
});

describe('preselection', () => {
  it('does not pre-tick a different song by the same artist', () => {
    const s = src('Sweetheart', 'M. Ward', { quality: 'inferred' });
    const best = scoreCandidate(s, track('1', 'Sweethearts on Parade', ['M. Ward']));
    const status = classify(s, best);
    expect(status).not.toBe('matched');
    expect(shouldPreselect({ status, best })).toBe(false);
  });

  it('pre-ticks a studio version of a live video', () => {
    const s = src('Bloodbuzz Ohio (Live on The Current)', 'The National', { quality: 'inferred' });
    const best = scoreCandidate(s, track('2', 'Bloodbuzz Ohio', ['The National']));
    const status = classify(s, best);
    expect(status).toBe('review');
    expect(shouldPreselect({ status, best })).toBe(true);
  });
});

describe('regressions from a live run against the TIDAL catalog', () => {
  it('an album named "Karaoke Angel" is not a karaoke cover', () => {
    const s = src('Almost Free', 'Molly Sarlé', { album: 'Karaoke Angel' });
    const best = scoreCandidate(s, track('1', 'Almost Free', ['Molly Sarlé'], { album: 'Karaoke Angel' }));
    expect(classify(s, best)).toBe('matched');
  });

  it('fully bracketed titles still produce a search', () => {
    expect(buildQueries(src('[More Rain]', 'M. Ward'))[0]).toBe('M. Ward More Rain');
    expect(normalizeTitle('[More Rain]').core).toBe('more rain');
  });

  it('keeps meaningful parentheticals in the first query', () => {
    const qs = buildQueries(src('Wilco (The Song)', 'Wilco'));
    expect(qs.slice(0, 2)).toEqual(['Wilco Wilco The Song', 'Wilco Wilco']);
    expect(buildQueries(src('Day After Day (Remastered 2010)', 'Badfinger'))[0]).toBe('Badfinger Day After Day');
  });

  it('adds a shortened query for very long titles', () => {
    const qs = buildQueries(src('The Sixth Extinction Crept Up Slowly, Like The Sunlight Through The Shutters', 'Red Sparowes'));
    expect(qs).toContain('Red Sparowes The Sixth Extinction Crept Up Slowly,');
  });
});

describe('classical works', () => {
  const work = 'Divertimento in F Major, K. 138, "Salzburg Symphony No. 3"';
  it('does not match a different movement of the same work', () => {
    const s = src(`${work}: I. Allegro`, 'Budapest Franz Liszt Chamber Orchestra');
    const other = scoreCandidate(s, track('1', `${work}: II. Andante`, ['Franz Liszt Chamber Orchestra']));
    const same = scoreCandidate(s, track('2', `${work}: I. Allegro`, ['Franz Liszt Chamber Orchestra']));
    expect(classify(s, other)).not.toBe('matched');
    expect(same.score).toBeGreaterThan(other.score);
  });

  it('tolerates punctuation differences and extra catalogue numbers on the TIDAL side', () => {
    const s = src('Gallimathias musicum, K. 32: No. 11. Largo. No. 12. Molto Allegro', 'Budapest Franz Liszt Chamber Orchestra');
    const c = scoreCandidate(s, track('3', 'Gallimathias musicum, K. 32: No. 11,  Largo.  No. 12, Molto Allegro', ['Budapest Franz Liszt Chamber Orchestra', 'János Rolla']));
    expect(classify(s, c)).toBe('matched');
  });

  it('ignores years inside remaster notes and the word "I"', () => {
    expect(identifyingNumbers('Day After Day (Remastered 2010)'.replace(/\s*\(Remastered 2010\)/, ''))).toEqual(new Set());
    expect(identifyingNumbers('I Will Follow')).toEqual(new Set());
    expect(identifyingNumbers('Symphony No. 9: IV. Presto')).toEqual(new Set(['9', 'mvt:iv']));
    const s = src('Day After Day (Remastered 2010)', 'Badfinger');
    expect(classify(s, scoreCandidate(s, track('4', 'Day After Day', ['Badfinger'])))).toBe('matched');
  });
});
