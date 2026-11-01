// End-to-end through the real Express app with a fake TIDAL + YouTube behind fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.TIDAL_CLIENT_ID = 'test-client';
process.env.PUBLIC_BASE_URL = 'http://app.test';
const { createApp } = await import('../src/server.js');

function fakeUpstream() {
  const log = [];
  const res = (body, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    log.push({ method: init.method || 'GET', url: u, body: init.body });
    if (u.href === 'https://auth.tidal.com/v1/oauth2/token') {
      return res({ access_token: 'AT', refresh_token: 'RT', expires_in: 86400, token_type: 'Bearer' });
    }
    if (u.hostname === 'www.youtube.com') {
      return res({ title: 'Some Artist - Mystery Song (Official Video)', author_name: 'SomeArtistVEVO' });
    }
    if (u.hostname === 'openapi.tidal.com') {
      if (u.pathname === '/v2/users/me') return res({ data: { id: 'u1', type: 'users', attributes: { username: 'matt', country: 'US' } } });
      if (u.pathname === '/v2/searchResults') {
        const q = u.searchParams.get('filter[query]');
        const title = q.includes('Angela') ? 'Angela' : q.includes('Quoted') ? 'Quoted, Title' : 'Mystery Song';
        const artist = q.includes('Angela') ? 'John Lennon' : q.includes('Quoted') ? 'Queens Of The Stone Age' : 'Some Artist';
        const id = `t-${title.length}`;
        return res({
          data: [{ id: 'x', type: 'searchResults', relationships: { tracks: { data: [{ id, type: 'tracks' }] } } }],
          included: [
            { id, type: 'tracks', attributes: { title, duration: 'PT3M' }, relationships: { artists: { data: [{ id: 'a', type: 'artists' }] } } },
            { id: 'a', type: 'artists', attributes: { name: artist } },
          ],
        });
      }
      if (u.pathname === '/v2/playlists') return res({ data: { id: 'PL', type: 'playlists', attributes: {} } }, 201);
      if (u.pathname.endsWith('/relationships/items')) return res({});
    }
    return res({ errors: [{ detail: `unexpected ${u.href}` }] }, 404);
  };
  return { fetchImpl, log };
}

async function startServer(fetchImpl) {
  const server = createApp({ fetchImpl }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (path, opts = {}) => {
    const r = await fetch(base + path, { redirect: 'manual', ...opts, headers: { ...(opts.headers || {}), cookie } });
    const set = r.headers.getSetCookie?.() || [];
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    return r;
  };
  return { server, call };
}

async function poll(call, jobId) {
  for (let i = 0; i < 200; i += 1) {
    const job = await (await call(`/api/jobs/${jobId}`)).json();
    if (job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('job did not finish');
}

test('full flow: login → upload → match → import', async (t) => {
  const { fetchImpl, log } = fakeUpstream();
  const { server, call } = await startServer(fetchImpl);
  t.after(() => server.close());

  // Not logged in yet.
  assert.equal((await (await call('/api/me')).json()).loggedIn, false);
  assert.equal((await call('/api/uploads', { method: 'POST' })).status, 401);

  // Login redirects to TIDAL with PKCE.
  const login = await call('/auth/login');
  assert.equal(login.status, 302);
  const authUrl = new URL(login.headers.get('location'));
  assert.equal(authUrl.origin, 'https://login.tidal.com');
  assert.equal(authUrl.searchParams.get('redirect_uri'), 'http://app.test/auth/callback');
  const state = authUrl.searchParams.get('state');

  // A forged state is rejected.
  const bad = await call(`/auth/callback?code=abc&state=nope`);
  assert.match(bad.headers.get('location'), /authError/);

  // Proper callback logs in. (State was consumed by the failed attempt, so log in again.)
  const login2 = await call('/auth/login');
  const state2 = new URL(login2.headers.get('location')).searchParams.get('state');
  assert.notEqual(state2, state);
  const cb = await call(`/auth/callback?code=abc&state=${state2}`);
  assert.equal(cb.headers.get('location'), '/');
  const tokenCall = log.find((l) => l.url.href === 'https://auth.tidal.com/v1/oauth2/token');
  assert.equal(new URLSearchParams(tokenCall.body).get('grant_type'), 'authorization_code');
  const me = await (await call('/api/me')).json();
  assert.equal(me.loggedIn, true);
  assert.equal(me.user.username, 'matt');

  // Upload the fixture.
  const form = new FormData();
  form.append('file', new Blob([await readFile(new URL('./fixtures/youtube-takeout.zip', import.meta.url))]), 'export.zip');
  const up = await (await call('/api/uploads', { method: 'POST', body: form })).json();
  assert.equal(up.format, 'youtube-music');
  assert.deepEqual(up.collections.map((c) => c.name), ['Library songs', 'Road Trip', 'Watch later']);

  // Match the library + Road Trip.
  const matchStart = await call(`/api/uploads/${up.uploadId}/match`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ collectionIds: ['library-songs', 'playlist-0'] }),
  });
  assert.equal(matchStart.status, 202);
  const match = await poll(call, (await matchStart.json()).id);
  assert.equal(match.status, 'done', match.error);
  assert.equal(match.result.stats.matched, 3, JSON.stringify(match.result.tracks, null, 1));
  assert.ok(log.some((l) => l.url.hostname === 'www.youtube.com' && l.url.searchParams.get('url').includes('CCCCCCCCCCC')));
  const searchCall = log.find((l) => l.url.pathname === '/v2/searchResults');
  assert.equal(searchCall.url.searchParams.get('countryCode'), 'US');

  // Import.
  const importStart = await call('/api/imports', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ matchJobId: match.id, collections: [{ id: 'library-songs' }, { id: 'playlist-0', name: 'Road Trip (from YT)' }] }),
  });
  const imp = await poll(call, (await importStart.json()).id);
  assert.equal(imp.status, 'done', imp.error);
  assert.deepEqual(imp.result.collections.map((c) => [c.name, c.added]), [
    ['Library songs', 2],
    ['Road Trip (from YT)', 2],
  ]);
  const writes = log.filter((l) => l.method === 'POST' && l.url.hostname === 'openapi.tidal.com');
  assert.deepEqual(writes.map((w) => w.url.pathname), [
    '/v2/userCollectionTracks/me/relationships/items',
    '/v2/playlists',
    '/v2/playlists/PL/relationships/items',
  ]);
  const created = JSON.parse(writes[1].body);
  assert.equal(created.data.attributes.name, 'Road Trip (from YT)');
});
