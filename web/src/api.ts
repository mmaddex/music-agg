import type {
  CollectionMatchView,
  ImportJobResult,
  ImportPlanEntry,
  JobView,
  MatchJobResult,
  SessionView,
  UploadSummary,
} from '../../src/shared/api.ts';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const msg = (body as { error?: string } | undefined)?.error ?? `Request failed (${res.status})`;
    throw new ApiError(msg, res.status);
  }
  return body as T;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  session: () => call<SessionView>('/api/session'),
  logout: () => call<{ ok: true }>('/auth/logout', { method: 'POST' }),

  upload(files: File[], importerId?: string) {
    const form = new FormData();
    for (const f of files) form.append('files', f, f.name);
    if (importerId) form.append('importerId', importerId);
    return call<UploadSummary>('/api/uploads', { method: 'POST', body: form });
  },
  getUpload: (id: string) =>
    call<{ summary: UploadSummary; matches: CollectionMatchView[] }>(`/api/uploads/${encodeURIComponent(id)}`),

  startMatch: (uploadId: string, collectionIds: string[]) =>
    call<JobView<MatchJobResult>>(`/api/uploads/${encodeURIComponent(uploadId)}/match`, json({ collectionIds })),
  startImport: (uploadId: string, plan: ImportPlanEntry[]) =>
    call<JobView<ImportJobResult>>(`/api/uploads/${encodeURIComponent(uploadId)}/import`, json({ plan })),

  job: <R>(id: string) => call<JobView<R>>(`/api/jobs/${encodeURIComponent(id)}`),
  cancelJob: (id: string) => call<JobView>(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
};

/** Poll a job until it finishes, reporting progress along the way. */
export async function waitForJob<R>(
  id: string,
  onUpdate: (job: JobView<R>) => void,
  signal?: AbortSignal,
): Promise<JobView<R>> {
  let delay = 500;
  for (;;) {
    const job = await api.job<R>(id);
    onUpdate(job);
    if (job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(1500, delay + 250);
    if (signal?.aborted) throw signal.reason;
  }
}
