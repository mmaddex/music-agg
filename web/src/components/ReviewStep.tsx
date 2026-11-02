import { useMemo, useState } from 'react';
import type { CandidateView, CollectionMatchView, MatchItemView, MatchStatus } from '../../../src/shared/api.ts';
import type { Choice } from './ChooseStep.tsx';

/** collectionId -> source index -> chosen TIDAL track id (null = don't import). */
export type Selections = Record<string, Record<number, string | null>>;

/** Tick confident matches and strong suggestions (decided server-side). */
export function defaultSelections(matches: CollectionMatchView[]): Selections {
  return Object.fromEntries(
    matches.map((m) => [
      m.id,
      Object.fromEntries(
        m.items.map((it) => [it.index, it.preselected && it.best ? it.best.id : null]),
      ),
    ]),
  );
}

const STATUS_LABEL: Record<MatchStatus, string> = { matched: 'Matched', review: 'Check', unmatched: 'Not found' };
const PAGE = 100;

export function ReviewStep(props: {
  matches: CollectionMatchView[];
  choices: Record<string, Choice>;
  onChoicesChange: (c: Record<string, Choice>) => void;
  selections: Selections;
  onSelectionsChange: (s: Selections) => void;
  onImport: () => void;
  onBack: () => void;
}) {
  const { matches, selections } = props;
  const [openId, setOpenId] = useState<string | null>(matches.find((m) => m.counts.review > 0)?.id ?? matches[0]?.id ?? null);

  const totals = useMemo(() => {
    let selected = 0;
    let all = 0;
    for (const m of matches) {
      all += m.items.length;
      selected += Object.values(selections[m.id] ?? {}).filter(Boolean).length;
    }
    return { selected, all };
  }, [matches, selections]);

  const setItem = (cid: string, index: number, trackId: string | null) =>
    props.onSelectionsChange({ ...selections, [cid]: { ...selections[cid], [index]: trackId } });

  const bulk = (m: CollectionMatchView, status: MatchStatus, accept: boolean) => {
    const next = { ...selections[m.id] };
    for (const it of m.items) if (it.status === status && it.best) next[it.index] = accept ? it.best.id : null;
    props.onSelectionsChange({ ...selections, [m.id]: next });
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>Review matches</h2>
        <button className="secondary" onClick={props.onBack}>
          Back
        </button>
      </div>
      <p className="muted">
        Confident matches are ticked. Rows marked <span className="pill review">Check</span> are close but not certain —
        tick the ones that are right, or pick another candidate from the list.
      </p>

      <div className="accordion">
        {matches.map((m) => {
          const sel = selections[m.id] ?? {};
          const chosen = Object.values(sel).filter(Boolean).length;
          const choice = props.choices[m.id];
          const open = openId === m.id;
          return (
            <div key={m.id} className={`panel${open ? ' open' : ''}`}>
              <button className="panel-head" onClick={() => setOpenId(open ? null : m.id)} aria-expanded={open}>
                <span className="caret" aria-hidden>
                  {open ? '▾' : '▸'}
                </span>
                <span className="name">{m.name}</span>
                <span className="muted small">→ {choice?.target === 'favorites' ? 'My Collection' : `playlist “${choice?.name ?? m.name}”`}</span>
                <span className="spacer" />
                <span className="pill matched">{m.counts.matched}</span>
                <span className="pill review">{m.counts.review}</span>
                <span className="pill unmatched">{m.counts.unmatched}</span>
                <span className="small">
                  <strong>{chosen}</strong>/{m.items.length} selected
                </span>
              </button>
              {open && <CollectionReview m={m} sel={sel} onPick={(i, id) => setItem(m.id, i, id)} onBulk={bulk} />}
            </div>
          );
        })}
      </div>

      <div className="row sticky-actions">
        <button className="secondary" onClick={() => downloadUnmatched(matches, selections)}>
          Download skipped songs (CSV)
        </button>
        <div className="spacer" />
        <button className="primary" disabled={!totals.selected} onClick={props.onImport}>
          Import {totals.selected} of {totals.all} songs into TIDAL
        </button>
      </div>
    </section>
  );
}

function CollectionReview(props: {
  m: CollectionMatchView;
  sel: Record<number, string | null>;
  onPick: (index: number, trackId: string | null) => void;
  onBulk: (m: CollectionMatchView, status: MatchStatus, accept: boolean) => void;
}) {
  const { m, sel } = props;
  const [filter, setFilter] = useState<MatchStatus | 'all'>(m.counts.review ? 'review' : 'all');
  const [limit, setLimit] = useState(PAGE);
  const items = filter === 'all' ? m.items : m.items.filter((i) => i.status === filter);

  return (
    <div className="panel-body">
      <div className="row tabs">
        {(['all', 'matched', 'review', 'unmatched'] as const).map((f) => (
          <button
            key={f}
            className={filter === f ? 'tab active' : 'tab'}
            onClick={() => {
              setFilter(f);
              setLimit(PAGE);
            }}
          >
            {f === 'all' ? `All ${m.items.length}` : `${STATUS_LABEL[f]} ${m.counts[f]}`}
          </button>
        ))}
        <div className="spacer" />
        {filter === 'review' && m.counts.review > 0 && (
          <>
            <button className="link" onClick={() => props.onBulk(m, 'review', true)}>
              Accept all suggestions
            </button>
            <button className="link" onClick={() => props.onBulk(m, 'review', false)}>
              Clear all
            </button>
          </>
        )}
      </div>

      {items.length === 0 ? (
        <p className="muted">Nothing here.</p>
      ) : (
        <table className="matches">
          <thead>
            <tr>
              <th />
              <th>In your export</th>
              <th>On TIDAL</th>
              <th className="num">Score</th>
            </tr>
          </thead>
          <tbody>
            {items.slice(0, limit).map((it) => (
              <MatchRow key={it.index} item={it} selected={sel[it.index] ?? null} onPick={(id) => props.onPick(it.index, id)} />
            ))}
          </tbody>
        </table>
      )}
      {items.length > limit && (
        <button className="secondary more" onClick={() => setLimit(limit + PAGE * 3)}>
          Show more ({items.length - limit} remaining)
        </button>
      )}
    </div>
  );
}

function trackLabel(c: CandidateView) {
  const v = c.version ? ` (${c.version})` : '';
  return `${c.artists.join(', ') || 'Unknown artist'} — ${c.title}${v}${c.album ? ` · ${c.album}` : ''}`;
}

function MatchRow({ item, selected, onPick }: { item: MatchItemView; selected: string | null; onPick: (id: string | null) => void }) {
  const candidates = [item.best, ...item.alternatives].filter((c): c is CandidateView => Boolean(c));
  const current = candidates.find((c) => c.id === selected) ?? item.best;
  const s = item.source;
  return (
    <tr className={`status-${item.status}${selected ? '' : ' off'}`}>
      <td>
        <input
          type="checkbox"
          disabled={!candidates.length}
          checked={Boolean(selected)}
          aria-label="Import this song"
          onChange={(e) => onPick(e.target.checked ? (current?.id ?? null) : null)}
        />
      </td>
      <td>
        <div>
          {s.title ? (
            <>
              <strong>{s.title}</strong>
              <span className="muted"> — {s.artists.join(', ') || 'unknown artist'}</span>
            </>
          ) : (
            <span className="muted">Unknown video</span>
          )}
        </div>
        <div className="muted small">
          {s.album}
          {s.videoTitle && (
            <span title="Title and artist were guessed from the YouTube video">
              {s.album ? ' · ' : ''}from video “{s.videoTitle}”
            </span>
          )}
          {s.sourceUrl && (
            <>
              {' '}
              <a href={s.sourceUrl} target="_blank" rel="noreferrer">
                open
              </a>
            </>
          )}
        </div>
      </td>
      <td>
        {candidates.length === 0 ? (
          <span className="muted">{item.reason ?? 'Not found'}</span>
        ) : candidates.length === 1 ? (
          <a href={current!.url} target="_blank" rel="noreferrer">
            {trackLabel(current!)}
          </a>
        ) : (
          <div className="cand">
            <select
              value={current?.id}
              onChange={(e) => onPick(e.target.value)}
              aria-label="Choose TIDAL track"
            >
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {trackLabel(c)} ({Math.round(c.score * 100)}%)
                </option>
              ))}
            </select>
            {current && (
              <a href={current.url} target="_blank" rel="noreferrer" title="Open on TIDAL">
                ↗
              </a>
            )}
          </div>
        )}
        {item.status === 'unmatched' && candidates.length > 0 && <div className="muted small">{item.reason}</div>}
      </td>
      <td className="num">
        <span className={`pill ${item.status}`}>{current ? `${Math.round(current.score * 100)}%` : STATUS_LABEL[item.status]}</span>
      </td>
    </tr>
  );
}

function csvCell(v: string | undefined) {
  const s = v ?? '';
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadUnmatched(matches: CollectionMatchView[], selections: Selections) {
  const rows = [['Collection', 'Title', 'Artists', 'Album', 'Status', 'Reason', 'Best TIDAL suggestion', 'Source URL']];
  for (const m of matches) {
    for (const it of m.items) {
      if (selections[m.id]?.[it.index]) continue;
      rows.push([
        m.name,
        it.source.title ?? it.source.videoTitle ?? '',
        it.source.artists.join(', '),
        it.source.album ?? '',
        it.status,
        it.reason ?? '',
        it.best ? `${trackLabel(it.best)} ${it.best.url}` : '',
        it.source.sourceUrl ?? '',
      ]);
    }
  }
  const blob = new Blob([rows.map((r) => r.map(csvCell).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'not-imported.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
