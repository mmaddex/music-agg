// How the web service starts workflow runs.
//
//   render: Render Workflows via the SDK (RENDER_API_KEY + WORKFLOW_SLUG). Production.
//   inline: run the same task functions in this process, emulating ctx.run and the retry
//           policy. For local development and tests only — no durability across restarts.

import crypto from 'node:crypto';
import { Render } from '@renderinc/sdk';
import { TASKS, TASK_OPTIONS } from './tasks.js';

export function createRenderDispatcher({ workflowSlug, token = process.env.RENDER_API_KEY, render = new Render({ token }) }) {
  return {
    mode: 'render',
    async start(taskName, args, { idempotencyKey } = {}) {
      const run = await render.workflows.startTask(`${workflowSlug}/${taskName}`, args, { idempotencyKey });
      return run.taskRunId;
    },
  };
}

export function createInlineDispatcher({ waitScale = 1, log = console } = {}) {
  const running = new Set();
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
      const p = runWithRetries(def, args)
        .catch((err) => log.error?.(`[inline ${taskName}] failed:`, err))
        .finally(() => running.delete(p));
      running.add(p);
      return id;
    },
    /** Resolve when all inline runs have finished (tests). */
    async idle() {
      while (running.size) await Promise.allSettled([...running]);
    },
  };
}
