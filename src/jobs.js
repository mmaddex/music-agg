// Background job runner. Matching ~2,000 tracks takes minutes, so work runs outside the
// request and the browser polls GET /api/jobs/:id for progress.

import { newId } from './state.js';

export function startJob(state, type, run) {
  const job = {
    id: newId(),
    type,
    status: 'running',
    phase: 'starting',
    progress: { done: 0, total: 0 },
    result: null,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  state.jobs.set(job.id, job);

  const update = ({ phase, done, total }) => {
    if (phase) job.phase = phase;
    if (done != null) job.progress.done = done;
    if (total != null) job.progress.total = total;
  };

  Promise.resolve()
    .then(() => run(update))
    .then((result) => {
      job.result = result;
      job.status = 'done';
    })
    .catch((err) => {
      console.error(`[job ${job.id} ${type}]`, err);
      job.error = err.message || String(err);
      job.status = 'failed';
    })
    .finally(() => {
      job.finishedAt = new Date().toISOString();
    });

  return job;
}

export function publicJob(job, { includeResult = true } = {}) {
  const { id, type, status, phase, progress, error, startedAt, finishedAt } = job;
  return { id, type, status, phase, progress, error, startedAt, finishedAt, ...(includeResult ? { result: job.result } : {}) };
}
