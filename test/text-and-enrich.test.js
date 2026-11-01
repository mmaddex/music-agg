import test from 'node:test';
import assert from 'node:assert/strict';
import { isoDurationToMs, normalize, similarity, splitArtists, stripDecorations, toIsoDate } from '../src/util/text.js';
import { enrichYouTubeTracks, parseVideoTitle } from '../src/enrich/youtube.js';
import { makeTrack } from '../src/importers/model.js';

test('normalize strips accents, punctuation and case', () => {
  assert.equal(normalize('Agüenta Seu Fulgêncio!'), 'aguenta seu fulgencio');
  assert.equal(normalize("Don't Stop"), 'dont stop');
});

test('stripDecorations removes video noise but keeps real versions', () => {
  assert.equal(stripDecorations('Song (Official Music Video) [HD]'), 'Song');
  assert.equal(stripDecorations('Song - Remastered 2011'), 'Song');
  assert.equal(stripDecorations('Song (feat. Someone)'), 'Song');
  assert.equal(stripDecorations('Song (Live at Wembley)'), 'Song (Live at Wembley)');
  assert.equal(stripDecorations('Song (Remix)'), 'Song (Remix)');
});

test('similarity is 1 for equal and low for unrelated', () => {
  assert.equal(similarity('Hello', 'hello!'), 1);
  assert.ok(similarity('Paranoid Android', 'Karma Police') < 0.4);
});

test('splitArtists keeps "&" names together', () => {
  assert.deepEqual(splitArtists('Simon & Garfunkel'), ['Simon & Garfunkel']);
  assert.deepEqual(splitArtists('John Lennon, Yoko Ono'), ['John Lennon', 'Yoko Ono']);
});

test('date and duration helpers', () => {
  assert.equal(isoDurationToMs('PT3M5S'), 185000);
  assert.equal(isoDurationToMs('PT1H'), 3600000);
  assert.equal(toIsoDate('2019-01-17 00:44:24 UTC'), '2019-01-17T00:44:24Z');
  assert.equal(toIsoDate('garbage'), null);
});

test('parseVideoTitle handles common YouTube naming', () => {
  assert.deepEqual(parseVideoTitle('Radiohead - Karma Police (Official Video)', 'RadioheadVEVO'), {
    artist: 'Radiohead',
    title: 'Karma Police (Official Video)',
  });
  assert.deepEqual(parseVideoTitle('Karma Police', 'Radiohead - Topic'), { artist: 'Radiohead', title: 'Karma Police' });
  assert.deepEqual(parseVideoTitle('Luiz Gonzaga "Asa Branca" ao vivo', 'Some Channel'), { artist: 'Luiz Gonzaga', title: 'Asa Branca' });
});

test('enrichYouTubeTracks fills metadata and records failures', async () => {
  const tracks = [
    makeTrack({ source: { type: 'youtube', id: 'AAAAAAAAAAA' } }),
    makeTrack({ source: { type: 'youtube', id: 'BBBBBBBBBBB' } }),
  ];
  const fetchImpl = async (url) => {
    if (url.includes('AAAAAAAAAAA')) {
      return new Response(JSON.stringify({ title: 'Artist X - Song Y (Lyrics)', author_name: 'Whatever' }), { status: 200 });
    }
    return new Response('Not Found', { status: 404 });
  };
  const result = await enrichYouTubeTracks(tracks, { fetchImpl });
  assert.deepEqual(result, { enriched: 1, failed: 1 });
  assert.equal(tracks[0].title, 'Song Y', 'video decorations are stripped');
  assert.deepEqual(tracks[0].artists, ['Artist X']);
  assert.equal(tracks[0].fromVideoTitle, true);
  assert.equal(tracks[1].needsLookup, true);
  assert.match(tracks[1].lookupError, /private or no longer available/);
});
