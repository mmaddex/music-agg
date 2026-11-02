import type { JobView } from '../../../src/shared/api.ts';

export function JobProgress({ job, title, onCancel }: { job: JobView; title: string; onCancel: () => void }) {
  const pct = job.total > 0 ? Math.min(100, Math.round((job.done / job.total) * 100)) : null;
  const elapsed = Math.round((Date.now() - job.startedAt) / 1000);
  return (
    <section className="card">
      <h2>{title}</h2>
      <p>
        {job.phase}
        {job.total > 0 && (
          <span className="muted">
            {' '}
            — {job.done} of {job.total}
          </span>
        )}
      </p>
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
        <div className={pct === null ? 'bar indeterminate' : 'bar'} style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
      <div className="row">
        <span className="muted small">{elapsed}s elapsed. You can leave this tab open in the background.</span>
        <div className="spacer" />
        <button className="secondary" onClick={onCancel} disabled={job.status !== 'running'}>
          Cancel
        </button>
      </div>
    </section>
  );
}
