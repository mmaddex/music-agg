// How the web service starts workflow runs.
//
//   render: Render Workflows via the SDK (RENDER_API_KEY + WORKFLOW_SLUG). Production.
//   inline: run the same task functions in this process, emulating ctx.run and the retry
//           policy. For local development and tests only — no durability across restarts.

import crypto from 'node:crypto';
import { Render } from '@renderinc/sdk';
import { TASKS, TASK_OPTIONS } from './tasks.js';
import { log as rootLog } from '../util/log.js';

const inlineLog = {
  warn: (msg) => rootLog.warn('workflow.inline.retry', { detail: msg }),
  error: (msg, err) => rootLog.error('workflow.inline.failed', { detail: msg, err }),
};

/** Render's TaskRunStatus → active | succeeded | failed | canceled | null */
export function renderState(status) {
  switch (status) {
    case 'pending':
    case 'running':
    case 'paused':
      return 'active';
    case 'succeeded':
    case 'completed':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'canceled';
    default:
      return null;
  }
}

export function createRenderDispatcher({ workflowSlug, token = process.env.RENDER_API_KEY, render = new Render({ token }) }) {
  return {
    mode: 'render',
    async start(taskName, args, { idempotencyKey } = {}) {
      const run = await render.workflows.startTask(`${workflowSlug}/${taskName}`, args, { idempotencyKey });
      rootLog.info('workflow.run.started', { task: taskName, taskRunId: run.taskRunId, idempotencyKey, mode: 'render' });
      return run.taskRunId;
    },
    /**
     * State of a run: active | succeeded | failed | canceled, or null if it can't be told
     * (API error, unknown status) — callers then leave the import alone.
     */
    async runState(taskRunId) {
      try {
        const run = await render.workflows.getTaskRun(taskRunId);
        return renderState(run?.status);
      } catch (err) {
        rootLog.warn('workflow.run.status_failed', { taskRunId, err });
        return null;
      }
    },
  };
}

export function createInlineDispatcher({ waitScale = 1, log = inlineLog } = {}) {
  const running = new Set();
  const states = new Map(); // run id → active | succeeded | failed (lost on restart → 'lost')
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms * waitScale));

  async function runWithRetries(def, args) {
    const { retry } = TASK_OPTIONS[def.name];
    const ctx = {
      metadata: { taskRunId: `inline-${crypto.randomUUID()}` },
      run: (child, ...childArgs) => runWithRetries(child, childArgs),
    };
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await def.func(ctx, ...args);
      } catch (err) {
        if (attempt >= retry.maxRetries) throw err;
        log.warn?.(`[inline ${def.name}] attempt ${attempt + 1} failed: ${err.message}; retrying`);
        await sleep(retry.waitDurationMs * (retry.backoffScaling ?? 2) ** attempt);
      }
    }
  }

  return {
    mode: 'inline',
    async start(taskName, args) {
      const def = TASKS[taskName];
      if (!def) throw new Error(`Unknown task ${taskName}`);
      const id = `inline-${crypto.randomUUID()}`;
      states.set(id, 'active');
      const p = runWithRetries(def, args)
        .then(() => states.set(id, 'succeeded'))
        .catch((err) => {
          states.set(id, 'failed');
          log.error?.(`[inline ${taskName}] failed:`, err);
        })
        .finally(() => running.delete(p));
      running.add(p);
      return id;
    },
    /** Runs from before a restart of this process are gone: report them as lost. */
    async runState(taskRunId) {
      return states.get(taskRunId) || 'lost';
    },
    /** Resolve when all inline runs have finished (tests). */
    async idle() {
      while (running.size) await Promise.allSettled([...running]);
    },
  };
}
