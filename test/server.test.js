// End-to-end through the real Express app + Postgres, with workflow tasks run inline and a
// fake TIDAL + YouTube behind fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { hasDb, testPool } from './helpers/db.js';

process.env.TIDAL_CLIENT_ID = 'test-client';
process.env.PUBLIC_BASE_URL = 'http://app.test';
process.env.TOKEN_ENCRYPTION_KEY = 'test-key';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://unused@localhost/unused';
const { createApp } = await import('../src/server.js');
const { buildDeps, setDeps } = await import('../src/workflows/deps.js');
const { createInlineDispatcher } = await import('../src/workflows/dispatch.js');

function fakeUpstream() {
  const log = [];
  const state = { writeOutage: false, searchGate: null };
  const res = (body, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    log.push({ method: init.method || 'GET', url: u, body: init.body, headers: init.headers });
    if (u.href === 'https://auth.tidal.com/v1/oauth2/token') return res({ access_token: 'AT', refresh_token: 'RT', expires_in: 86400 });
    if (u.hostname === 'www.youtube.com') return res({ title: 'Some Artist - Mystery Song (Official Video)', author_name: 'SomeArtistVEVO' });
    if (u.hostname === 'openapi.tidal.com') {
      if (u.pathname === '/v2/users/me') return res({ data: { id: 'u1', type: 'users', attributes: { username: 'matt', country: 'US' } } });
      if (u.pathname === '/v2/searchResults') {
        await state.searchGate;
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
      if (state.writeOutage && init.method === 'POST' && u.pathname.includes('/relationships/items')) return res({}, 503);
      if (u.pathname === '/v2/playlists') return res({ data: { id: 'PL', type: 'playlists', attributes: {} } }, 201);
      if (u.pathname.endsWith('/relationships/items')) return res({ meta: { skipped: [] } });
    }
    return res({ errors: [{ detail: `unexpected ${u.href}` }] }, 404);
  };
  return { fetchImpl, log, state };
}

async function startServer({ pool, dispatcher, fetchImpl }) {
  const server = createApp({ pool, dispatcher, fetchImpl }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (path, opts = {}) => {
    const headers = { ...(opts.headers || {}), cookie };
    if (opts.json) {
      headers['content-type'] = 'application/json';
      opts = { ...opts, method: 'POST', body: JSON.stringify(opts.json) };
    }
    const r = await fetch(base + path, { redirect: 'manual', ...opts, headers });
    const set = r.headers.getSetCookie?.() || [];
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    return r;
  };
  return { server, call };
}

test('full flow: login → upload → match workflow → review → load workflow → retry', { skip: !hasDb }, async (t) => {
  const db = await testPool();
  const up = fakeUpstream();
  setDeps(buildDeps({ pool: db.pool, fetchImpl: up.fetchImpl, settings: { chunkSize: 2, parallelism: 2, minIntervalMs: 0 }, clientOptions: { maxRetries: 0, sleepImpl: async () => {} } }));
  const dispatcher = createInlineDispatcher({ waitScale: 0, log: {} });
  const { server, call } = await startServer({ pool: db.pool, dispatcher, fetchImpl: up.fetchImpl });
  t.after(async () => {
    server.close();
    await dispatcher.idle();
    await db.close();
  });

  assert.equal((await (await call('/api/me')).json()).loggedIn, false);
  assert.equal((await call('/api/uploads', { method: 'POST' })).status, 401);

  // Login (PKCE) — a forged state is rejected, the real one logs in.
  await call('/auth/login');
  assert.match((await call('/auth/callback?code=abc&state=nope')).headers.get('location'), /authError/);
  const login = await call('/auth/login');
  const authUrl = new URL(login.headers.get('location'));
  assert.equal(authUrl.origin, 'https://login.tidal.com');
  assert.equal(authUrl.searchParams.get('redirect_uri'), 'http://app.test/auth/callback');
  const cb = await call(`/auth/callback?code=abc&state=${authUrl.searchParams.get('state')}`);
  assert.equal(cb.headers.get('location'), '/');
  const me = await (await call('/api/me')).json();
  assert.equal(me.loggedIn, true);
  assert.equal(me.user.username, 'matt');
  assert.equal(me.workflowMode, 'inline');
  const { rows } = await db.pool.query('SELECT tokens_enc FROM accounts');
  assert.ok(!rows[0].tokens_enc.includes('AT'), 'tokens are encrypted at rest');

  // Upload.
  const form = new FormData();
  form.append('file', new Blob([await readFile(new URL('./fixtures/youtube-takeout.zip', import.meta.url))]), 'export.zip');
  const up1 = await (await call('/api/uploads', { method: 'POST', body: form })).json();
  assert.equal(up1.status, 'parsed');
  assert.deepEqual(up1.collections.map((c) => c.name), ['Library songs', 'Road Trip', 'Watch later']);

  // Match workflow. Hold TIDAL search so the run is still in progress for the double-start check.
  let release;
  up.state.searchGate = new Promise((r) => (release = r));
  const started = await call(`/api/imports/${up1.id}/match`, { json: { collectionIds: ['library-songs', 'playlist-0'] } });
  assert.equal(started.status, 202);
  assert.equal((await call(`/api/imports/${up1.id}/match`, { json: { collectionIds: ['playlist-0'] } })).status, 409, 'no double start');
  const midway = await (await call(`/api/imports/${up1.id}`)).json();
  assert.equal(midway.status, 'matching');
  assert.equal(midway.progress.total, 3);
  release();
  await dispatcher.idle();
  const matched = await (await call(`/api/imports/${up1.id}?results=1`)).json();
  assert.equal(matched.status, 'matched', matched.error);
  assert.equal(matched.matchStats.matched, 3);
  assert.equal(Object.keys(matched.results.tracks).length, 3);
  assert.ok(up.log.some((l) => l.url.hostname === 'www.youtube.com' && l.url.searchParams.get('url').includes('CCCCCCCCCCC')));

  // The import shows up in the user's list (resume after closing the tab).
  const list = await (await call('/api/imports')).json();
  assert.equal(list.imports[0].id, up1.id);

  // Load workflow with a write outage that outlasts the task's retries → failed, resumable.
  up.state.writeOutage = true;
  const loadBody = { collections: [{ id: 'library-songs' }, { id: 'playlist-0', name: 'Road Trip (from YT)' }] };
  assert.equal((await call(`/api/imports/${up1.id}/load`, { json: loadBody })).status, 202);
  await dispatcher.idle();
  const failed = await (await call(`/api/imports/${up1.id}`)).json();
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /Retry/);

  // Re-matching after writes began is refused; Retry resumes instead.
  assert.equal((await call(`/api/imports/${up1.id}/match`, { json: { collectionIds: ['playlist-0'] } })).status, 409);
  up.state.writeOutage = false;
  assert.equal((await call(`/api/imports/${up1.id}/retry`, { json: {} })).status, 202);
  await dispatcher.idle();
  const done = await (await call(`/api/imports/${up1.id}`)).json();
  assert.equal(done.status, 'done', done.error);
  assert.deepEqual(done.targets.map((x) => [x.name, x.status, x.added]), [
    ['Library songs', 'done', 2],
    ['Road Trip (from YT)', 'done', 2],
  ]);
  assert.equal(done.targets[1].url, 'https://tidal.com/playlist/PL');
  const creates = up.log.filter((l) => l.method === 'POST' && l.url.pathname === '/v2/playlists');
  assert.equal(creates.length, 1, 'the playlist was created exactly once across the failure and retry');

  // The "not imported" record: everything was imported here, and the failed write's rows were
  // cleared by Retry.
  assert.equal(done.notImported, 0);
  const csv = await call(`/api/imports/${up1.id}/not-imported.csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /^text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /filename="export-not-imported\.csv"/);
  const bytes = Buffer.from(await csv.arrayBuffer());
  assert.equal(bytes.toString('utf8'), '\ufeffcollection,title,artist,album,reason,detail,source_url,audio_file\r\n', 'UTF-8 BOM so Excel opens it correctly');
  assert.deepEqual(await (await call('/api/missing')).json(), { records: [], tracks: [] }, 'nothing is missing once Retry added everything');
  const allCsv = await call('/api/missing.csv');
  assert.match(allCsv.headers.get('content-disposition'), /filename="missing-songs\.csv"/);
  assert.equal(Buffer.from(await allCsv.arrayBuffer()).toString('utf8'), '\ufefftitle,artist,album,whole_record,source,export,collection,reason,detail,source_url,audio_file\r\n');

  // A multi-part export (Apple's "Part 1 of 2" + "Part 2 of 2") is uploaded in one request.
  const multi = new FormData();
  multi.append('file', new Blob([await readFile(new URL('./fixtures/apple-part-1.zip', import.meta.url))]), 'Apple Media Services Information Part 1 of 2.zip');
  multi.append('file', new Blob([await readFile(new URL('./fixtures/apple-part-2.zip', import.meta.url))]), 'Apple Media Services Information Part 2 of 2.zip');
  const apple = await (await call('/api/uploads', { method: 'POST', body: multi })).json();
  assert.equal(apple.status, 'parsed', apple.error);
  assert.equal(apple.filename, 'Apple Media Services Information Part 1 of 2.zip + 1 more');
  assert.equal(apple.formatLabel, 'Apple Music (Apple privacy export)');
  assert.deepEqual(apple.collections.map((c) => [c.name, c.trackCount]), [
    ['Library songs', 3],
    ['Favorite Songs', 2],
    ['Road Trip', 3],
  ]);
  const tooMany = new FormData();
  for (let i = 0; i < 11; i += 1) tooMany.append('file', new Blob(['Title,Artist\nA,B\n']), `${i}.csv`);
  const rejected = await call('/api/uploads', { method: 'POST', body: tooMany });
  assert.equal(rejected.status, 413);
  assert.match((await rejected.json()).error, /at most 10 files/);
});
