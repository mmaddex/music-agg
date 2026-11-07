// Imports whose workflow run ended without finishing them are shown as cancelled / interrupted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDb, testPool } from './helpers/db.js';

process.env.TOKEN_ENCRYPTION_KEY = 'test-key';
process.env.TIDAL_CLIENT_ID = 'cid';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://unused@localhost/unused';

const { reconcileImport } = await import('../src/server.js');
const { renderState, createInlineDispatcher } = await import('../src/workflows/dispatch.js');
const { upsertAccount } = await import('../src/accounts.js');
const repo = await import('../src/imports/repo.js');
const { makeCollection, makeTrack } = await import('../src/importers/model.js');

test("Render's run statuses map to run states", () => {
  assert.deepEqual(['pending', 'running', 'paused', 'succeeded', 'completed', 'failed', 'canceled', 'weird'].map(renderState), ['active', 'active', 'active', 'succeeded', 'succeeded', 'failed', 'canceled', null]);
});

async function activeImport(pool, status = 'matching', runId = `trn-${Math.random()}`) {
  const account = await upsertAccount(pool, { tidalUserId: `u-${Math.random()}`, username: 'm', country: 'US', tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 1e6 } });
  const library = { format: 't', formatLabel: 'T', warnings: [], collections: [makeCollection({ id: 'p', name: 'P', tracks: [makeTrack({ title: 'x', artistCredit: 'y' })] })] };
  const id = await repo.createImport(pool, { accountId: account.id, filename: 'f.zip', library });
  await pool.query(`UPDATE imports SET status = $2, stage = $3, ${status === 'loading' ? 'load_run_id' : 'match_run_id'} = $4 WHERE id = $1`, [id, status, status === 'loading' ? 'load' : 'match', runId]);
  return repo.getImport(pool, id);
}

const dispatcherSaying = (state) => ({ calls: 0, async runState() { this.calls += 1; return state; } });

test('a cancelled run marks the import cancelled, with a Retry message', { skip: !hasDb }, async (t) => {
  const db = await testPool();
  t.after(() => db.close());
  const imp = await activeImport(db.pool, 'loading');
  const out = await reconcileImport(db.pool, dispatcherSaying('canceled'), imp);
  assert.equal(out.status, 'failed');
  assert.equal(out.stopped_reason, 'cancelled');
  const saved = await repo.getImport(db.pool, imp.id);
  assert.deepEqual([saved.status, saved.stopped_reason, saved.stage], ['failed', 'cancelled', 'load']);
  assert.match(saved.error, /^The import to TIDAL was cancelled before it finished\. Press Retry/);
});

test('a run that failed or ended while the import was still active marks it interrupted', { skip: !hasDb }, async (t) => {
  const db = await testPool();
  t.after(() => db.close());
  for (const state of ['failed', 'succeeded', 'lost']) {
    const imp = await activeImport(db.pool);
    await reconcileImport(db.pool, dispatcherSaying(state), imp);
    const saved = await repo.getImport(db.pool, imp.id);
    assert.deepEqual([saved.status, saved.stopped_reason], ['failed', 'interrupted'], state);
    assert.match(saved.error, new RegExp(`Matching stopped unexpectedly .*workflow run ${state}`));
  }
});

test('running runs, unknown states and imports without a run id are left alone', { skip: !hasDb }, async (t) => {
  const db = await testPool();
  t.after(() => db.close());
  for (const state of ['active', null]) {
    const imp = await activeImport(db.pool);
    await reconcileImport(db.pool, dispatcherSaying(state), imp);
    assert.equal((await repo.getImport(db.pool, imp.id)).status, 'matching', String(state));
  }
  const dispatching = await activeImport(db.pool, 'matching', null);
  const d = dispatcherSaying('canceled');
  await reconcileImport(db.pool, d, dispatching);
  assert.equal(d.calls, 0, 'no run id yet (being dispatched): not checked');
  assert.equal((await repo.getImport(db.pool, dispatching.id)).status, 'matching');
});

test('a run that ended after the import moved on does not overwrite it', { skip: !hasDb }, async (t) => {
  const db = await testPool();
  t.after(() => db.close());
  const stale = await activeImport(db.pool); // read while still matching…
  await repo.setStatus(db.pool, stale.id, 'matched'); // …then the run finished normally
  await reconcileImport(db.pool, dispatcherSaying('succeeded'), stale);
  assert.equal((await repo.getImport(db.pool, stale.id)).status, 'matched');
});

test('Render is asked at most every 30 seconds per import unless forced', { skip: !hasDb }, async (t) => {
  const db = await testPool();
  t.after(() => db.close());
  const imp = await activeImport(db.pool);
  const d = dispatcherSaying('active');
  await reconcileImport(db.pool, d, imp);
  await reconcileImport(db.pool, d, imp);
  assert.equal(d.calls, 1);
  await reconcileImport(db.pool, d, imp, { force: true });
  assert.equal(d.calls, 2);
});

test('the inline dispatcher reports runs it knows and treats others as lost', async () => {
  const d = createInlineDispatcher({ waitScale: 0, log: {} });
  assert.equal(await d.runState('inline-from-before-a-restart'), 'lost');
});
