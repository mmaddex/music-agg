// Durability tests for the workflow steps against a real Postgres (TEST_DATABASE_URL).
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, testPool } from './helpers/db.js';

process.env.TOKEN_ENCRYPTION_KEY = 'test-key';
process.env.TIDAL_CLIENT_ID = 'cid';

const { upsertAccount } = await import('../src/accounts.js');
const repo = await import('../src/imports/repo.js');
const steps = await import('../src/workflows/steps.js');
const { buildDeps, setDeps } = await import('../src/workflows/deps.js');
const { createInlineDispatcher } = await import('../src/workflows/dispatch.js');
const { makeCollection, makeTrack } = await import('../src/importers/model.js');
const { deterministicKey, decryptJson, encryptJson } = await import('../src/crypto.js');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

/** Fake TIDAL + YouTube. `fail(url, init)` may return a Response to inject failures. */
function upstream({ fail } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method || 'GET', u, init });
    const injected = fail?.(u, init, calls);
    if (injected) return injected;
    if (u.hostname === 'auth.tidal.com') return json({ access_token: 'NEW', refresh_token: 'RT2', expires_in: 86400 });
    if (u.hostname === 'www.youtube.com') return json({ title: 'Video Artist - Video Song (Official Video)', author_name: 'VideoArtistVEVO' });
    if (u.pathname === '/v2/searchResults') {
      const q = u.searchParams.get('filter[query]');
      const [title, ...rest] = q.split(' ');
      const id = `T-${title}`;
      return json({
        data: [{ id: 's', type: 'searchResults', relationships: { tracks: { data: [{ id, type: 'tracks' }] } } }],
        included: [
          { id, type: 'tracks', attributes: { title, duration: 'PT3M' }, relationships: { artists: { data: [{ id: 'a', type: 'artists' }] } } },
          { id: 'a', type: 'artists', attributes: { name: rest.join(' ') || 'Someone' } },
        ],
      });
    }
    if (u.pathname === '/v2/playlists') return json({ data: { id: `PL-${calls.filter((c) => c.u.pathname === '/v2/playlists').length}`, type: 'playlists', attributes: {} } }, 201);
    if (u.pathname.endsWith('/relationships/items')) return json({ meta: { skipped: [] } });
    return json({ errors: [{ detail: `unexpected ${u}` }] }, 404);
  };
  return { fetchImpl, calls };
}

const fastClient = { maxRetries: 0, sleepImpl: async () => {} };

async function seed(pool, { tracks, tokens = { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 3_600_000 } } = {}) {
  const account = await upsertAccount(pool, { tidalUserId: `u-${Math.random()}`, username: 'matt', country: 'US', tokens });
  const library = {
    format: 'test',
    formatLabel: 'Test',
    warnings: [],
    collections: [makeCollection({ id: 'p', name: 'Road Trip', tracks }), makeCollection({ id: 'f', kind: 'favorites', name: 'Liked', tracks: tracks.slice(0, 1) })],
  };
  const id = await repo.createImport(pool, { accountId: account.id, filename: 'x.zip', library });
  const imp = await repo.getImport(pool, id);
  await repo.prepareMatch(pool, imp, ['p', 'f'], 'US');
  return { account, id };
}

const songs = (n) => Array.from({ length: n }, (_, i) => makeTrack({ title: `Song${i}`, artistCredit: 'Band' }));

test('token encryption round-trips and keys are deterministic', () => {
  const enc = encryptJson({ a: 1 }, 'k');
  assert.deepEqual(decryptJson(enc, 'k'), { a: 1 });
  assert.throws(() => decryptJson(enc, 'other'));
  assert.equal(deterministicKey('a', 'b'), deterministicKey('a', 'b'));
  assert.notEqual(deterministicKey('a', 'b'), deterministicKey('a', 'c'));
  assert.match(deterministicKey('x'), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('matchChunk checkpoints each track and a retry resumes where it stopped', { skip: !hasDb }, async (t) => {
  const db = await testPool();
  t.after(() => db.close());
  const { id } = await seed(db.pool, { tracks: songs(4) });
  let outage = true;
  const up = upstream({ fail: (u) => (outage && u.searchParams.get('filter[query]')?.startsWith('Song2') ? json({}, 503) : null) });
  const deps = buildDeps({ pool: db.pool, fetchImpl: up.fetchImpl, settings: { chunkSize: 10, parallelism: 1, minIntervalMs: 0 }, clientOptions: fastClient });
  const keys = await repo.pendingTrackKeys(db.pool, id);

  await assert.rejects(steps.matchChunk(deps, id, keys), steps.TransientError);
  let counts = await repo.trackCounts(db.pool, id);
  assert.equal(counts.matched, 3);
  assert.equal(counts.pending, 1);

  const searchesBefore = up.calls.filter((c) => c.u.pathname === '/v2/searchResults').length;
  outage = false;
  await steps.matchChunk(deps, id, keys);
  counts = await repo.trackCounts(db.pool, id);
  assert.equal(counts.matched, 4);
  const retried = up.calls.filter((c) => c.u.pathname === '/v2/searchResults').slice(searchesBefore);
  assert.ok(retried.every((c) => c.u.searchParams.get('filter[query]').startsWith('Song2')), 'only the unfinished track is searched again');
});

test('a track that keeps failing is given up on instead of blocking the import', { skip: !hasDb }, async (t) => {
  const db = await testPool();
  t.after(() => db.close());
  const { id } = await seed(db.pool, { tracks: songs(2) });
  const up = upstream({ fail: (u) => (u.searchParams.get('filter[query]')?.startsWith('Song1') ? json({}, 503) : null) });
  const deps = buildDeps({ pool: db.pool, fetchImpl: up.fetchImpl, settings: { chunkSize: 10, parallelism: 1, minIntervalMs: 0 }, clientOptions: fastClient });
  const keys = await repo.pendingTrackKeys(db.pool, id);
  for (let i = 1; i < steps.MAX_TRACK_ATTEMPTS; i += 1) await assert.rejects(steps.matchChunk(deps, id, keys));
  await steps.matchChunk(deps, id, keys); // last attempt records the error and succeeds
  const counts = await repo.trackCounts(db.pool, id);
  assert.deepEqual([counts.matched, counts.error, counts.pending], [1, 1, 0]);
});

test('matchImport fans out chunks and survives transient failures via task retries', { skip: !hasDb }, async (t) => {
  const db = await testPool();
  t.after(() => db.close());
  const { id } = await seed(db.pool, { tracks: songs(7) });
  let failures = 3;
  const up = upstream({ fail: (u) => (u.pathname === '/v2/searchResults' && failures-- > 0 ? json({}, 500) : null) });
  setDeps(buildDeps({ pool: db.pool, fetchImpl: up.fetchImpl, settings: { chunkSize: 3, parallelism: 2, minIntervalMs: 0 }, clientOptions: fastClient }));
  const dispatcher = createInlineDispatcher({ waitScale: 0, log: {} });
  await dispatcher.start('matchImport', [id]);
  await dispatcher.idle();
  const imp = await repo.getImport(db.pool, id);
  assert.equal(imp.status, 'matched', imp.error);
  assert.equal((await repo.trackCounts(db.pool, id)).matched, 7);
});

test('an expired TIDAL login stops the import with a clear message (no endless retries)', { skip: !hasDb }, async (t) => {
  const db = await testPool();
  t.after(() => db.close());
  const { id } = await seed(db.pool, { tracks: songs(2), tokens: { accessToken: 'OLD', refreshToken: 'RT', expiresAt: Date.now() - 1000 } });
  const up = upstream({ fail: (u) => (u.hostname === 'auth.tidal.com' ? json({ error: 'invalid_grant' }, 400) : null) });
  setDeps(buildDeps({ pool: db.pool, fetchImpl: up.fetchImpl, settings: { chunkSize: 10, parallelism: 1, minIntervalMs: 0 }, clientOptions: fastClient }));
  const dispatcher = createInlineDispatcher({ waitScale: 0, log: {} });
  await dispatcher.start('matchImport', [id]);
  await dispatcher.idle();
  const imp = await repo.getImport(db.pool, id);
  assert.equal(imp.status, 'failed');
  assert.match(imp.error, /log in again/i);
  assert.equal(up.calls.filter((c) => c.u.hostname === 'auth.tidal.com').length, 1, 'refresh attempted once, not retried');
});

test('token refresh is persisted and shared', { skip: !hasDb }, async (t) => {
  const db = await testPool();
  t.after(() => db.close());
  const { id, account } = await seed(db.pool, { tracks: songs(1), tokens: { accessToken: 'OLD', refreshToken: 'RT', expiresAt: Date.now() - 1000 } });
  const up = upstream();
  const deps = buildDeps({ pool: db.pool, fetchImpl: up.fetchImpl, settings: { chunkSize: 10, parallelism: 1, minIntervalMs: 0 }, clientOptions: fastClient });
  await steps.matchChunk(deps, id, await repo.pendingTrackKeys(db.pool, id));
  const search = up.calls.find((c) => c.u.pathname === '/v2/searchResults');
  assert.equal(search.init.headers.authorization, 'Bearer NEW');
  const { rows } = await db.pool.query('SELECT tokens_enc FROM accounts WHERE id = $1', [account.id]);
  assert.equal(decryptJson(rows[0].tokens_enc).refreshToken, 'RT2');
});

async function readyToLoad(pool, n) {
  const { id } = await seed(pool, { tracks: songs(n) });
  await pool.query(`UPDATE import_tracks SET status = 'matched', match = jsonb_build_object('status','matched','best', jsonb_build_object('id', 'T-' || (track->>'title'))) WHERE import_id = $1`, [id]);
  await repo.setStatus(pool, id, 'matched');
  const imp = await repo.getImport(pool, id);
  await repo.prepareLoad(pool, imp, [{ id: 'p', name: 'Road Trip (TIDAL)' }, { id: 'f' }], {});
  return id;
}

test('writeCollection resumes after a failure without re-creating the playlist or re-sending batches', { skip: !hasDb }, async (t) => {
  const db = await testPool();
  t.after(() => db.close());
  const id = await readyToLoad(db.pool, 120);
  let itemPosts = 0;
  let outage = true;
  const up = upstream({
    fail: (u, init) => {
      if (init.method === 'POST' && u.pathname.endsWith('/relationships/items')) {
        itemPosts += 1;
        if (outage && itemPosts === 3) return json({}, 503);
      }
      return null;
    },
  });
  const deps = buildDeps({ pool: db.pool, fetchImpl: up.fetchImpl, settings: { minIntervalMs: 0 }, clientOptions: fastClient });

  await assert.rejects(steps.writeCollection(deps, id, 'p'));
  let target = await repo.getTarget(db.pool, id, 'p');
  assert.equal(target.batches_done, 2);
  assert.equal(target.tidal_playlist_id, 'PL-1');

  outage = false;
  const res = await steps.writeCollection(deps, id, 'p');
  assert.deepEqual(res, { added: 120, skipped: 0 });
  target = await repo.getTarget(db.pool, id, 'p');
  assert.equal(target.status, 'done');
  assert.equal(up.calls.filter((c) => c.u.pathname === '/v2/playlists').length, 1, 'playlist created once');

  const posts = up.calls.filter((c) => c.method === 'POST' && c.u.pathname === '/v2/playlists/PL-1/relationships/items');
  assert.equal(posts.length, 4, '2 ok + 1 failed + 1 retried');
  const keys = posts.map((c) => c.init.headers['idempotency-key']);
  assert.equal(keys[2], keys[3], 'the retried batch reuses its idempotency key');
  assert.equal(new Set(keys).size, 3);
});

test('loadToTidal writes every collection and finishes the import', { skip: !hasDb }, async (t) => {
  const db = await testPool();
  t.after(() => db.close());
  const id = await readyToLoad(db.pool, 3);
  const up = upstream();
  setDeps(buildDeps({ pool: db.pool, fetchImpl: up.fetchImpl, settings: { minIntervalMs: 0 }, clientOptions: fastClient }));
  const dispatcher = createInlineDispatcher({ waitScale: 0, log: {} });
  await dispatcher.start('loadToTidal', [id]);
  await dispatcher.idle();
  assert.equal((await repo.getImport(db.pool, id)).status, 'done');
  const targets = await repo.getTargets(db.pool, id);
  assert.deepEqual(targets.map((x) => [x.name, x.status, x.added]), [['Road Trip (TIDAL)', 'done', 3], ['Liked', 'done', 1]]);
  const created = up.calls.find((c) => c.u.pathname === '/v2/playlists');
  assert.equal(JSON.parse(created.init.body).data.attributes.name, 'Road Trip (TIDAL)');
});

test('the Workflow entry point registers all tasks with their retry options', async () => {
  const { TaskRegistry } = await import('@renderinc/sdk/workflows');
  await import('../src/workflows/main.js');
  const tasks = TaskRegistry.getInstance().getAllTasks();
  const byName = Object.fromEntries(tasks.map((t) => [t.name, t.options]));
  assert.deepEqual(Object.keys(byName).sort(), ['loadToTidal', 'matchChunk', 'matchImport', 'writeCollection']);
  // This is the wire format the SDK sends to Render when registering.
  assert.deepEqual(byName.matchChunk.retry, { max_retries: 6, wait_duration_ms: 15000, factor: 2 });
  assert.equal(byName.matchImport.timeout_seconds, 12 * 3600);
  for (const t of tasks) assert.equal(t.options.plan, 'flex', t.name);
});
