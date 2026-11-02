import { useRef, useState, type DragEvent } from 'react';
import type { ImporterInfo, UploadSummary } from '../../../src/shared/api.ts';
import { api } from '../api.ts';

export function UploadStep(props: {
  importers: ImporterInfo[];
  onUploaded: (s: UploadSummary) => void;
  onError: (e: unknown) => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [format, setFormat] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  function add(list: FileList | null) {
    if (!list?.length) return;
    setFiles((prev) => {
      const names = new Set(prev.map((f) => f.name + f.size));
      return [...prev, ...[...list].filter((f) => !names.has(f.name + f.size))];
    });
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    add(e.dataTransfer.files);
  }

  async function submit() {
    setBusy(true);
    try {
      props.onUploaded(await api.upload(files, format || undefined));
    } catch (e) {
      props.onError(e);
    } finally {
      setBusy(false);
    }
  }

  const totalMb = files.reduce((n, f) => n + f.size, 0) / 1024 / 1024;

  return (
    <section className="card">
      <h2>Upload your export</h2>
      <p className="muted">
        Drop the <code>.zip</code> from Google Takeout as-is (no need to unzip), or one or more <code>.csv</code>{' '}
        files.
      </p>

      <div
        className={`dropzone${dragging ? ' dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => input.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
      >
        <input
          ref={input}
          type="file"
          multiple
          accept=".zip,.csv,.tsv,application/zip,text/csv"
          hidden
          onChange={(e) => {
            add(e.target.files);
            e.target.value = '';
          }}
        />
        <strong>Drag files here</strong> or click to choose
      </div>

      {files.length > 0 && (
        <ul className="filelist">
          {files.map((f) => (
            <li key={f.name + f.size}>
              <span>{f.name}</span>
              <span className="muted">{(f.size / 1024 / 1024).toFixed(1)} MB</span>
              <button className="link" onClick={() => setFiles(files.filter((x) => x !== f))} aria-label={`Remove ${f.name}`}>
                remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="row">
        <label className="field">
          <span>Format</span>
          <select value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="">Detect automatically</option>
            {props.importers.map((i) => (
              <option key={i.id} value={i.id} title={i.description}>
                {i.label}
              </option>
            ))}
          </select>
        </label>
        <div className="spacer" />
        <button className="primary" disabled={!files.length || busy} onClick={submit}>
          {busy ? 'Reading export…' : `Continue${files.length ? ` (${totalMb.toFixed(1)} MB)` : ''}`}
        </button>
      </div>

      <details className="help">
        <summary>How do I get my YouTube Music export?</summary>
        <ol>
          <li>
            Go to{' '}
            <a href="https://takeout.google.com" target="_blank" rel="noreferrer">
              takeout.google.com
            </a>{' '}
            and click <em>Deselect all</em>.
          </li>
          <li>
            Tick <em>YouTube and YouTube Music</em>. Under <em>All YouTube data included</em>, keep{' '}
            <em>music-library-songs</em> and <em>playlists</em>.
          </li>
          <li>Create the export, download the .zip when Google emails you, and upload it here.</li>
        </ol>
      </details>
    </section>
  );
}
