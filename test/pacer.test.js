// The shared per-account TIDAL pace, against a real Postgres.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, testPool } from './helpers/db.js';

process.env.TOKEN_ENCRYPTION_KEY = 'test-key';
const { upsertAccount } = await import('../src/accounts.js');
const { dbPacer, PACE } = await import('../src/tidal/pacer.js');
const { TidalClient } = await import('../src/tidal/client.js');

const account = (pool) => upsertAccount(pool, { tidalUserId: `u-${Math.random()}`, username: 'm', country: 'US', tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 1e6 } });
const intervalOf = async (pool, id) => (await pool.query('SELECT interval_ms FROM tidal_pace WHERE account_id = $1', [id])).rows[0].interval_ms;

test('two runs for one account share one sequence of slots', { skip: !hasDb }, async (t) => {
  const db = await testPool();
  t.after(() => db.close());
  const { id } = await account(db.pool);
  const a = dbPacer(db.pool, id, { minIntervalMs: 100, startIntervalMs: 1000 });
  const b = dbPacer(db.pool, id, { minIntervalMs: 100, startIntervalMs: 1000 });
  const waits = [];
  for (const p of [a, b, a, b]) waits.push((await p.reserve()).waitMs);
  // Slots 1 s apart across both runs: ~0, ~1000, ~2000, ~3000 ms from now.
  waits.forEach((w, i) => assert.ok(Math.abs(w - i * 1000) < 150, `slot ${i}: ${waits}`));
});

test('a 429 pauses everyone until Retry-After and slows the pace once per pause', { skip: !hasDb }, async (t) => {
  const db = await testPool();
  t.after(() => db.close());
  const { id } = await account(db.pool);
  const a = dbPacer(db.pool, id, { minIntervalMs: 100, startIntervalMs: 400 });
  const b = dbPacer(db.pool, id, { minIntervalMs: 100, startIntervalMs: 400 });
  await a.reserve();
  assert.equal(await a.rateLimited(4000), true);
  assert.equal(await b.rateLimited(4000), true, 'a second 429 in the same pause…');
  assert.equal(await intervalOf(db.pool, id), Math.ceil(400 * PACE.growth), '…does not slow it again');
  const { waitMs } = await b.reserve();
  assert.ok(waitMs >= 3800 && waitMs <= 4300, `other run waits out the pause: ${waitMs}`);
});

test('runs of successes speed the pace back up, never below the floor', { skip: !hasDb }, async (t) => {
  const db = await testPool();
  t.after(() => db.close());
  const { id } = await account(db.pool);
  const p = dbPacer(db.pool, id, { minIntervalMs: 380, startIntervalMs: 400 });
  await p.reserve();
  for (let i = 0; i < PACE.successesToShrink - 1; i += 1) await p.succeeded();
  assert.equal(await intervalOf(db.pool, id), 400);
  await p.succeeded();
  assert.equal(await intervalOf(db.pool, id), 380, '400 × 0.95 = 380');
  for (let i = 0; i < PACE.successesToShrink; i += 1) await p.succeeded();
  assert.equal(await intervalOf(db.pool, id), 380, 'floor');
});

test('a pace unused for an hour starts over', { skip: !hasDb }, async (t) => {
  const db = await testPool();
  t.after(() => db.close());
  const { id } = await account(db.pool);
  const p = dbPacer(db.pool, id, { minIntervalMs: 100, startIntervalMs: 500 });
  await p.reserve();
  await db.pool.query(`UPDATE tidal_pace SET interval_ms = 9000, next_at = now() + interval '1 minute', updated_at = now() - interval '2 hours' WHERE account_id = $1`, [id]);
  assert.deepEqual(await p.reserve(), { waitMs: 0, intervalMs: 500 });
});

test('the client waits out a 429 through the shared pace instead of sleeping by itself', { skip: !hasDb }, async (t) => {
  const db = await testPool();
  t.after(() => db.close());
  const { id } = await account(db.pool);
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '1' } });
    return new Response(JSON.stringify({ data: { id: 'x' } }), { status: 200 });
  };
  const sleeps = [];
  const client = new TidalClient({ getAccessToken: async () => 'T', fetchImpl, sleepImpl: async (ms) => sleeps.push(ms), pacer: dbPacer(db.pool, id, { minIntervalMs: 0, startIntervalMs: 0 }) });
  const doc = await client.get('/x');
  assert.equal(doc.data.id, 'x');
  assert.equal(sleeps.length, 1, `one sleep, for the paced slot: ${sleeps}`);
  assert.ok(sleeps[0] >= 800 && sleeps[0] <= 1100, `slot after Retry-After: ${sleeps[0]}`);
  assert.equal(client.stats.rateLimited, 1);
});

test('if the database fails the request still goes out, locally spaced', async () => {
  const brokenPool = { query: async () => { throw new Error('db down'); } };
  const pacer = dbPacer(brokenPool, 'acct', { minIntervalMs: 0 });
  assert.equal(await pacer.reserve(), null);
  const client = new TidalClient({ getAccessToken: async () => 'T', minIntervalMs: 0, pacer, fetchImpl: async () => new Response('{"ok":1}', { status: 200 }) });
  assert.deepEqual(await client.get('/x'), { ok: 1 });
});
