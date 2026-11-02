import { useCallback, useEffect, useState } from 'react';
import type {
  CollectionMatchView,
  ImportJobResult,
  ImportPlanEntry,
  JobView,
  MatchJobResult,
  SessionView,
  UploadSummary,
} from '../../src/shared/api.ts';
import { api, ApiError, waitForJob } from './api.ts';
import { ChooseStep, type Choice } from './components/ChooseStep.tsx';
import { DoneStep } from './components/DoneStep.tsx';
import { JobProgress } from './components/JobProgress.tsx';
import { ReviewStep, defaultSelections, type Selections } from './components/ReviewStep.tsx';
import { UploadStep } from './components/UploadStep.tsx';

type Stage = 'upload' | 'choose' | 'matching' | 'review' | 'importing' | 'done';

const STORAGE_KEY = 'music-agg:upload';

export function App() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>('upload');
  const [summary, setSummary] = useState<UploadSummary | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [matches, setMatches] = useState<CollectionMatchView[]>([]);
  const [selections, setSelections] = useState<Selections>({});
  const [job, setJob] = useState<JobView | null>(null);
  const [result, setResult] = useState<ImportJobResult | null>(null);

  // Session + OAuth error from the callback redirect.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const authError = params.get('authError');
    if (authError) {
      setError(`TIDAL login failed: ${authError}`);
      history.replaceState(null, '', location.pathname);
    }
    api
      .session()
      .then(setSession)
      .catch((e: Error) => setError(e.message));
  }, []);

  // Restore an in-progress upload after a page reload.
  useEffect(() => {
    if (!session?.user) return;
    const id = sessionStorage.getItem(STORAGE_KEY);
    if (!id) return;
    api
      .getUpload(id)
      .then(({ summary, matches }) => {
        loadSummary(summary);
        if (matches.length) {
          setMatches(matches);
          setSelections(defaultSelections(matches));
          setStage('review');
        }
      })
      .catch(() => sessionStorage.removeItem(STORAGE_KEY));
  }, [session?.user]);

  const fail = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 401) {
      setSession((s) => (s ? { ...s, user: null } : s));
    }
    setError(e instanceof Error ? e.message : String(e));
  }, []);

  function loadSummary(s: UploadSummary) {
    sessionStorage.setItem(STORAGE_KEY, s.uploadId);
    setSummary(s);
    setChoices(
      Object.fromEntries(
        s.collections.map((c) => [
          c.id,
          {
            include: c.suggestedTarget !== 'skip',
            target: c.suggestedTarget === 'favorites' ? 'favorites' : 'playlist',
            name: c.name,
          } satisfies Choice,
        ]),
      ),
    );
    setStage('choose');
  }

  async function startMatch() {
    if (!summary) return;
    setError(null);
    const ids = summary.collections.filter((c) => choices[c.id]?.include).map((c) => c.id);
    try {
      const started = await api.startMatch(summary.uploadId, ids);
      setJob(started);
      setStage('matching');
      const done = await waitForJob<MatchJobResult>(started.id, setJob);
      if (done.status === 'done' && done.result) {
        setMatches(done.result.collections);
        setSelections(defaultSelections(done.result.collections));
        setStage('review');
      } else {
        if (done.status === 'failed') setError(done.error ?? 'Matching failed.');
        setStage('choose');
      }
    } catch (e) {
      fail(e);
      setStage('choose');
    }
  }

  async function startImport() {
    if (!summary) return;
    setError(null);
    const plan: ImportPlanEntry[] = matches
      .filter((m) => choices[m.id]?.include)
      .map((m) => {
        const choice = choices[m.id]!;
        const sel = selections[m.id] ?? {};
        return {
          collectionId: m.id,
          target: choice.target,
          name: choice.target === 'playlist' ? choice.name : undefined,
          items: m.items
            .filter((it) => sel[it.index])
            .map((it) => ({ index: it.index, trackId: sel[it.index]! })),
        };
      })
      .filter((p) => p.items.length > 0);
    if (!plan.length) {
      setError('No tracks selected.');
      return;
    }
    try {
      const started = await api.startImport(summary.uploadId, plan);
      setJob(started);
      setStage('importing');
      const done = await waitForJob<ImportJobResult>(started.id, setJob);
      if (done.status === 'done' && done.result) {
        setResult(done.result);
        setStage('done');
      } else {
        if (done.status === 'failed') setError(done.error ?? 'Import failed.');
        setStage('review');
      }
    } catch (e) {
      fail(e);
      setStage('review');
    }
  }

  function restart() {
    sessionStorage.removeItem(STORAGE_KEY);
    setSummary(null);
    setMatches([]);
    setSelections({});
    setResult(null);
    setJob(null);
    setError(null);
    setStage('upload');
  }

  async function logout() {
    await api.logout().catch(() => {});
    sessionStorage.removeItem(STORAGE_KEY);
    location.href = '/';
  }

  const user = session?.user;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            ♪
          </span>
          Music Import <span className="muted">for TIDAL</span>
        </div>
        {user && (
          <div className="account">
            <span>
              Signed in as <strong>{user.firstName || user.username || `user ${user.id}`}</strong>{' '}
              <span className="muted">({user.country})</span>
            </span>
            <button className="link" onClick={logout}>
              Log out
            </button>
          </div>
        )}
      </header>

      <main>
        {error && (
          <div className="alert error" role="alert">
            <span>{error}</span>
            <button className="link" onClick={() => setError(null)} aria-label="Dismiss">
              ✕
            </button>
          </div>
        )}

        {!session ? (
          <p className="muted">Loading…</p>
        ) : !user ? (
          <section className="card hero">
            <h1>Move your music library to TIDAL</h1>
            <p>
              Upload an export from YouTube Music (Google Takeout) — or a CSV from another service — and this app
              will find each song on TIDAL, let you review the matches, then create the playlists and add your
              library to your TIDAL collection.
            </p>
            <ol className="steps">
              <li>Log in with your TIDAL account so we know where to put the music.</li>
              <li>Upload your export (.zip or .csv).</li>
              <li>Review matches and import.</li>
            </ol>
            <a className="button primary" href="/auth/login">
              Log in with TIDAL
            </a>
            <p className="fine">
              You sign in on tidal.com — this app never sees your password. Your tokens and export are kept in
              memory only and discarded when you log out.
            </p>
          </section>
        ) : (
          <>
            <Stepper stage={stage} />
            {stage === 'upload' && <UploadStep importers={session.importers} onUploaded={loadSummary} onError={fail} />}
            {stage === 'choose' && summary && (
              <ChooseStep
                summary={summary}
                choices={choices}
                onChange={setChoices}
                onMatch={startMatch}
                onBack={restart}
                youtubeApiKey={session.youtubeApiKey}
              />
            )}
            {(stage === 'matching' || stage === 'importing') && job && (
              <JobProgress
                job={job}
                title={stage === 'matching' ? 'Finding your songs on TIDAL' : 'Adding to your TIDAL account'}
                onCancel={() => api.cancelJob(job.id).catch(fail)}
              />
            )}
            {stage === 'review' && (
              <ReviewStep
                matches={matches}
                choices={choices}
                onChoicesChange={setChoices}
                selections={selections}
                onSelectionsChange={setSelections}
                onImport={startImport}
                onBack={() => setStage('choose')}
              />
            )}
            {stage === 'done' && result && <DoneStep result={result} onRestart={restart} />}
          </>
        )}
      </main>

      <footer className="footer">
        Uses the{' '}
        <a href="https://developer.tidal.com" target="_blank" rel="noreferrer">
          TIDAL API
        </a>
        . Listen on{' '}
        <a href="https://tidal.com" target="_blank" rel="noreferrer">
          TIDAL
        </a>
        . Not affiliated with or endorsed by TIDAL.
      </footer>
    </div>
  );
}

const STEPS: { stage: Stage[]; label: string }[] = [
  { stage: ['upload'], label: 'Upload' },
  { stage: ['choose', 'matching'], label: 'Choose' },
  { stage: ['review', 'importing'], label: 'Review' },
  { stage: ['done'], label: 'Done' },
];

function Stepper({ stage }: { stage: Stage }) {
  const current = STEPS.findIndex((s) => s.stage.includes(stage));
  return (
    <ol className="stepper">
      {STEPS.map((s, i) => (
        <li key={s.label} className={i === current ? 'current' : i < current ? 'past' : ''}>
          <span className="num">{i + 1}</span> {s.label}
        </li>
      ))}
    </ol>
  );
}
