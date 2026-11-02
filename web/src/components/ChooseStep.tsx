import type { UploadSummary } from '../../../src/shared/api.ts';

export interface Choice {
  include: boolean;
  target: 'playlist' | 'favorites';
  /** TIDAL playlist name. */
  name: string;
}

const KIND_LABEL = { library: 'Library', liked: 'Likes', playlist: 'Playlist' } as const;

export function ChooseStep(props: {
  summary: UploadSummary;
  choices: Record<string, Choice>;
  onChange: (c: Record<string, Choice>) => void;
  onMatch: () => void;
  onBack: () => void;
  youtubeApiKey: boolean;
}) {
  const { summary, choices } = props;
  const set = (id: string, patch: Partial<Choice>) =>
    props.onChange({ ...choices, [id]: { ...choices[id]!, ...patch } });
  const selected = summary.collections.filter((c) => choices[c.id]?.include);
  const tracks = selected.reduce((n, c) => n + c.trackCount, 0);
  const lookups = selected.reduce((n, c) => n + c.needsLookup, 0);
  const allOn = selected.length === summary.collections.length;

  return (
    <section className="card">
      <div className="card-head">
        <h2>Choose what to import</h2>
        <button className="secondary" onClick={props.onBack}>
          Upload a different file
        </button>
      </div>
      <p className="muted">
        Detected <strong>{summary.importer.label}</strong> in {summary.sources.join(', ')}.
      </p>

      {summary.warnings.length > 0 && (
        <ul className="alert warn">
          {summary.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      <table className="collections">
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                aria-label="Select all"
                checked={allOn}
                onChange={() =>
                  props.onChange(
                    Object.fromEntries(summary.collections.map((c) => [c.id, { ...choices[c.id]!, include: !allOn }])),
                  )
                }
              />
            </th>
            <th>From your export</th>
            <th className="num">Songs</th>
            <th>Add to TIDAL as</th>
          </tr>
        </thead>
        <tbody>
          {summary.collections.map((c) => {
            const ch = choices[c.id]!;
            return (
              <tr key={c.id} className={ch.include ? '' : 'off'}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Include ${c.name}`}
                    checked={ch.include}
                    onChange={(e) => set(c.id, { include: e.target.checked })}
                  />
                </td>
                <td>
                  <div className="name">
                    {c.name} <span className="tag">{KIND_LABEL[c.kind]}</span>
                  </div>
                  {c.note && <div className="muted small">{c.note}</div>}
                </td>
                <td className="num">
                  {c.trackCount}
                  {c.needsLookup > 0 && (
                    <div className="muted small" title="These entries only have a YouTube video id; titles are looked up first.">
                      {c.needsLookup} to look up
                    </div>
                  )}
                </td>
                <td>
                  <div className="target">
                    <select
                      value={ch.target}
                      disabled={!ch.include}
                      onChange={(e) => set(c.id, { target: e.target.value as Choice['target'] })}
                    >
                      <option value="playlist">New playlist</option>
                      <option value="favorites">My Collection (favorite tracks)</option>
                    </select>
                    {ch.target === 'playlist' && (
                      <input
                        type="text"
                        value={ch.name}
                        maxLength={250}
                        disabled={!ch.include}
                        aria-label="Playlist name"
                        onChange={(e) => set(c.id, { name: e.target.value })}
                      />
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="row">
        <p className="muted small">
          {lookups > 0 &&
            `${lookups} entries only have a YouTube video id and will be looked up on YouTube first${
              props.youtubeApiKey ? '' : ' (about 1–2 minutes per 500)'
            }. `}
          TIDAL limits how fast apps can search (roughly 2 songs a second), so large libraries take a while — about{' '}
          {Math.max(1, Math.round(tracks / 110))} min here. Nothing is written to TIDAL until you review the matches.
        </p>
        <div className="spacer" />
        <button className="primary" disabled={!selected.length} onClick={props.onMatch}>
          Find {tracks} songs on TIDAL
        </button>
      </div>
    </section>
  );
}
