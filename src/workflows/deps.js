// Dependencies for workflow tasks, created lazily on first use so that importing the task
// definitions (which Render does to register them) never touches the network or database.

import { createPool, migrate } from '../db/pool.js';
import { clientForAccount } from '../accounts.js';

let depsPromise = null;

export function workflowSettings(env = process.env) {
  return {
    chunkSize: Number(env.MATCH_CHUNK_SIZE) || 100,
    parallelism: Number(env.MATCH_PARALLELISM) || 2,
    minIntervalMs: Number(env.TIDAL_MIN_INTERVAL_MS ?? 200),
  };
}

export function buildDeps({ pool, fetchImpl = fetch, settings = workflowSettings(), clientId = process.env.TIDAL_CLIENT_ID, clientOptions }) {
  return {
    pool,
    fetchImpl,
    ...settings,
    clientFor: (accountId) => clientForAccount(pool, accountId, { clientId, fetchImpl, minIntervalMs: settings.minIntervalMs, clientOptions }),
  };
}

/** Use these deps instead of building from env (web service in inline mode, tests). */
export function setDeps(deps) {
  depsPromise = Promise.resolve(deps);
}

export function getDeps() {
  depsPromise ??= (async () => {
    const pool = createPool(process.env.DATABASE_URL, { max: 3 });
    await migrate(pool);
    return buildDeps({ pool });
  })().catch((err) => {
    depsPromise = null; // let the next attempt (a Render retry) try again
    throw err;
  });
  return depsPromise;
}
