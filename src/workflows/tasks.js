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

export const matchChunk = task(TASK_OPTIONS.matchChunk, async function matchChunk(ctx, importId, keys) {
  return steps.matchChunk(await getDeps(), importId, keys);
});

export const matchImport = task(TASK_OPTIONS.matchImport, async function matchImport(ctx, importId) {
  return steps.matchImport(await getDeps(), importId, {
    runChunk: (keys) => ctx.run(matchChunk, importId, keys),
  });
});

export const writeCollection = task(TASK_OPTIONS.writeCollection, async function writeCollection(ctx, importId, collectionId) {
  return steps.writeCollection(await getDeps(), importId, collectionId);
});

export const loadToTidal = task(TASK_OPTIONS.loadToTidal, async function loadToTidal(ctx, importId) {
  return steps.loadToTidal(await getDeps(), importId, {
    runCollection: (collectionId) => ctx.run(writeCollection, importId, collectionId),
  });
});

export const TASKS = { matchChunk, matchImport, writeCollection, loadToTidal };
