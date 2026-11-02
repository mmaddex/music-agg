import { randomUUID } from 'node:crypto';

export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface Job<R = unknown> {
  id: string;
  kind: 'match' | 'import';
  uploadId: string;
  status: JobStatus;
  phase: string;
  done: number;
  total: number;
  startedAt: number;
  /** When the current phase began (for ETA estimates). */
  phaseStartedAt: number;
  finishedAt?: number;
  error?: string;
  result?: R;
  abort: AbortController;
}

export interface JobHandle {
  readonly id: string;
  readonly signal: AbortSignal;
  setPhase(phase: string, total?: number): void;
  progress(done: number, total?: number): void;
  tick(n?: number): void;
}

/** Start a background job; the HTTP request returns immediately and the UI polls. */
export function startJob<R>(
  jobs: Map<string, Job>,
  kind: Job['kind'],
  uploadId: string,
  run: (h: JobHandle) => Promise<R>,
): Job<R> {
  const job: Job<R> = {
    id: randomUUID(),
    kind,
    uploadId,
    status: 'running',
    phase: 'Starting',
    done: 0,
    total: 0,
    startedAt: Date.now(),
    phaseStartedAt: Date.now(),
    abort: new AbortController(),
  };
  jobs.set(job.id, job as Job);
  const handle: JobHandle = {
    id: job.id,
    signal: job.abort.signal,
    setPhase(phase, total) {
      job.phase = phase;
      job.phaseStartedAt = Date.now();
      job.done = 0;
      if (total !== undefined) job.total = total;
    },
    progress(done, total) {
      job.done = done;
      if (total !== undefined) job.total = total;
    },
    tick(n = 1) {
      job.done += n;
    },
  };
  run(handle)
    .then((result) => {
      job.result = result;
      job.status = job.abort.signal.aborted ? 'cancelled' : 'done';
    })
    .catch((err: unknown) => {
      job.status = job.abort.signal.aborted ? 'cancelled' : 'failed';
      job.error = err instanceof Error ? err.message : String(err);
      if (job.status === 'failed') console.error(`[job ${job.id}] ${kind} failed:`, err);
    })
    .finally(() => {
      job.finishedAt = Date.now();
    });
  return job;
}

export function jobView(job: Job) {
  return {
    id: job.id,
    kind: job.kind,
    uploadId: job.uploadId,
    status: job.status,
    phase: job.phase,
    done: job.done,
    total: job.total,
    startedAt: job.startedAt,
    phaseStartedAt: job.phaseStartedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    result: job.status === 'done' ? job.result : undefined,
  };
}
