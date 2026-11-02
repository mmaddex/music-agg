import type { ImportJobResult } from '../../../src/shared/api.ts';

export function DoneStep({ result, onRestart }: { result: ImportJobResult; onRestart: () => void }) {
  return (
    <section className="card">
      <h2>Done 🎉</h2>
      {result.favoritesAdded > 0 && (
        <p>
          Added <strong>{result.favoritesAdded}</strong> tracks to{' '}
          <a href="https://tidal.com/my-collection/tracks" target="_blank" rel="noreferrer">
            My Collection
          </a>
          .
        </p>
      )}
      {result.playlists.length > 0 && (
        <>
          <p>Created {result.playlists.length} playlist{result.playlists.length === 1 ? '' : 's'} (unlisted):</p>
          <ul className="results">
            {result.playlists.map((p) => (
              <li key={p.collectionId}>
                <a href={p.url} target="_blank" rel="noreferrer">
                  {p.name}
                </a>{' '}
                <span className="muted">— {p.added} tracks</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {result.failures.length > 0 && (
        <div className="alert error">
          <p>Some items could not be imported:</p>
          <ul>
            {result.failures.map((f) => (
              <li key={f.collectionId}>
                <strong>{f.name}</strong>: {f.error}
              </li>
            ))}
          </ul>
        </div>
      )}
      <button className="primary" onClick={onRestart}>
        Import another export
      </button>
    </section>
  );
}
