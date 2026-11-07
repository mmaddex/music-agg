// Render Workflow task definitions. Registered when this module is imported (by
// src/workflows/main.js in the Workflow service, or by the web service's inline dispatcher
// for local development). All task() calls must stay synchronous at module level.
//
//   matchImport(importId)                  root: fan out matching in chunks
//     └─ matchChunk(importId, keys[])      enrich + match ~100 tracks, checkpoint each
//   loadToTidal(importId)                  root: write each collection in order
//     └─ writeCollection(importId, colId)  create playlist / add favourites, checkpoint per batch
//
// Arguments are ids only: track data and TIDAL tokens are read from Postgres, never passed
// as task inputs (inputs are visible in the Render Dashboard and capped at 4 MB).

import { task } from '@renderinc/sdk/workflows';
import * as steps from './steps.js';
import { getDeps } from './deps.js';
import { log as rootLog, since } from '../util/log.js';

// Render Workflows flex compute plan for every task.
const PLAN = 'flex';

const MINUTE = 60;
const HOUR = 60 * MINUTE;

export const TASK_OPTIONS = {
  matchChunk: {
    name: 'matchChunk',
    // TIDAL / YouTube hiccups: back off 15s, 30s, 60s, 120s, 240s, 480s.
    retry: { maxRetries: 6, waitDurationMs: 15_000, backoffScaling: 2 },
    timeoutSeconds: 30 * MINUTE,
    plan: PLAN,
  },
  matchImport: {
    name: 'matchImport',
    retry: { maxRetries: 2, waitDurationMs: 30_000, backoffScaling: 2 },
    timeoutSeconds: 12 * HOUR,
    plan: PLAN,
  },
  writeCollection: {
    name: 'writeCollection',
    retry: { maxRetries: 6, waitDurationMs: 15_000, backoffScaling: 2 },
    timeoutSeconds: 30 * MINUTE,
    plan: PLAN,
  },
  loadToTidal: {
    name: 'loadToTidal',
    retry: { maxRetries: 2, waitDurationMs: 30_000, backoffScaling: 2 },
    timeoutSeconds: 12 * HOUR,
    plan: PLAN,
  },
};

/**
 * Log start / finish / failure of every task run with its Render run ids, and hand the step a
 * logger that carries them, so any log line can be traced back to a run in the dashboard.
 */
function instrumented(name, describeArgs, body) {
  return async function run(ctx, ...args) {
    const meta = ctx?.metadata || {};
    const log = rootLog.child({
      task: name,
      taskRunId: meta.taskRunId,
      rootTaskRunId: meta.rootTaskRunId && meta.rootTaskRunId !== meta.taskRunId ? meta.rootTaskRunId : undefined,
      parentTaskRunId: meta.parentTaskRunId,
    });
    const startedAt = performance.now();
    log.info('task.started', describeArgs(...args));
    try {
      const deps = { ...(await getDeps()), log };
      const result = await body(ctx, deps, ...args);
      log.info('task.finished', { ms: since(startedAt), ...describeArgs(...args), result });
      return result;
    } catch (err) {
      // Thrown errors are retried by Render (per the task's retry policy).
      log.warn('task.threw', { ms: since(startedAt), ...describeArgs(...args), willBeRetriedByRender: true, err });
      throw err;
    }
  };
}

export const matchChunk = task(
  TASK_OPTIONS.matchChunk,
  instrumented('matchChunk', (importId, keys) => ({ importId, keys: keys?.length }), (ctx, deps, importId, keys) => steps.matchChunk(deps, importId, keys)),
);

export const matchImport = task(
  TASK_OPTIONS.matchImport,
  instrumented('matchImport', (importId) => ({ importId }), (ctx, deps, importId) =>
    steps.matchImport(deps, importId, {
      runChunk: (keys) => ctx.run(matchChunk, importId, keys),
    }),
  ),
);

export const writeCollection = task(
  TASK_OPTIONS.writeCollection,
  instrumented('writeCollection', (importId, collectionId) => ({ importId, collectionId }), (ctx, deps, importId, collectionId) =>
    steps.writeCollection(deps, importId, collectionId),
  ),
);

export const loadToTidal = task(
  TASK_OPTIONS.loadToTidal,
  instrumented('loadToTidal', (importId) => ({ importId }), (ctx, deps, importId) =>
    steps.loadToTidal(deps, importId, {
      runCollection: (collectionId) => ctx.run(writeCollection, importId, collectionId),
    }),
  ),
);

export const TASKS = { matchChunk, matchImport, writeCollection, loadToTidal };
