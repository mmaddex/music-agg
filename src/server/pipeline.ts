import { randomUUID } from 'node:crypto';
import { buildBundle, type UploadedFile } from '../core/bundle/bundle.js';
import { defaultEnrichers, enrichTracks } from '../core/enrich/youtube.js';
import type { TrackEnricher } from '../core/enrich/types.js';
import { parseExport } from '../core/importers/registry.js';
import { Matcher, shouldPreselect, type CatalogSearch, type MatchResult, type ScoredCandidate } from '../core/matching/matcher.js';
import type { ParsedExport, SourceTrack } from '../core/model.js';
import type { CollectionItem, TidalClient } from '../core/tidal/client.js';
import { mapLimit } from '../core/util/async.js';
import type {
  CandidateView,
  CollectionMatchView,
  CollectionSummary,
  ImportJobResult,
  ImportPlanEntry,
  MatchJobResult,
  SourceTrackView,
  UploadSummary,
} from '../shared/api.js';
import type { JobHandle } from './jobs.js';

export interface UploadState {
  id: string;
  createdAt: number;
  sources: string[];
  parsed: ParsedExport;
  detected: UploadSummary['detected'];
  /** Latest finished match results, by collection id. */
  matches?: Map<string, CollectionMatchView>;
}

export function createUpload(files: UploadedFile[], importerId: string | undefined, maxTotalBytes: number): UploadState {
  const bundle = buildBundle(files, { maxTotalBytes, maxFiles: 20_000 });
  const { parsed, detected } = parseExport(bundle, importerId || undefined);
  return {
    id: randomUUID(),
    createdAt: Date.now(),
    sources: bundle.sources,
    parsed,
    detected: detected.map((d) => ({
      id: d.importer.id,
      label: d.importer.label,
      confidence: d.confidence,
      reason: d.reason,
    })),
  };
}

export function summarize(upload: UploadState): UploadSummary {
  const collections: CollectionSummary[] = upload.parsed.collections.map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    kind: c.kind,
    trackCount: c.tracks.length,
    needsLookup: c.tracks.filter((t) => t.quality === 'missing').length,
    suggestedTarget: c.suggestedTarget,
    note: c.note,
  }));
  return {
    uploadId: upload.id,
    sources: upload.sources,
    importer: { id: upload.parsed.importerId, label: upload.parsed.importerLabel },
    detected: upload.detected,
    collections,
    warnings: upload.parsed.warnings,
  };
}

function candidateView(c: ScoredCandidate): CandidateView {
  const t = c.track;
  return {
    id: t.id,
    title: t.title,
    version: t.version,
    artists: t.artists,
    album: t.album,
    durationMs: t.durationMs,
    url: t.url,
    score: c.score,
  };
}

function sourceView(t: SourceTrack): SourceTrackView {
  return {
    title: t.title,
    artists: t.artists,
    album: t.album,
    durationMs: t.durationMs,
    videoTitle: t.quality === 'inferred' ? t.hints?.videoTitle : undefined,
    sourceUrl: t.refs[0]?.url,
    guessed: t.quality !== 'export',
  };
}

export interface MatchDeps {
  catalog: CatalogSearch;
  enrichers?: TrackEnricher[];
  youtubeApiKey?: string;
  concurrency?: number;
  /** HTTP client for metadata lookups (overridable in tests). */
  fetch?: typeof fetch;
}

/** Fill in missing metadata, then find each track on TIDAL. */
export async function runMatch(
  upload: UploadState,
  collectionIds: string[],
  deps: MatchDeps,
  job: JobHandle,
): Promise<MatchJobResult> {
  const wanted = new Set(collectionIds);
  const collections = upload.parsed.collections.filter((c) => wanted.has(c.id));
  if (!collections.length) throw new Error('Select at least one playlist or library to match.');
  const allTracks = collections.flatMap((c) => c.tracks);

  const enrichers = deps.enrichers ?? defaultEnrichers(deps.youtubeApiKey);
  if (allTracks.some((t) => enrichers.some((e) => e.appliesTo(t)))) {
    job.setPhase('Looking up song details for video-only entries');
    await enrichTracks(allTracks, enrichers, {
      signal: job.signal,
      fetch: deps.fetch,
      onProgress: (done, total) => job.progress(done, total),
    });
  }

  const matcher = new Matcher(deps.catalog);
  job.setPhase('Searching TIDAL', allTracks.length);
  const flat = collections.flatMap((c) => c.tracks.map((t, index) => ({ c, t, index })));
  const results = await mapLimit(flat, deps.concurrency ?? 6, async ({ t }) => {
    let r: MatchResult;
    try {
      r = await matcher.match(t, job.signal);
    } catch (err) {
      if (job.signal.aborted) throw err;
      r = { status: 'unmatched', alternatives: [], reason: `Search failed: ${(err as Error).message}` };
    }
    job.tick();
    return r;
  });

  const views = new Map<string, CollectionMatchView>();
  flat.forEach(({ c, t, index }, i) => {
    let v = views.get(c.id);
    if (!v) {
      v = { id: c.id, name: c.name, items: [], counts: { matched: 0, review: 0, unmatched: 0 } };
      views.set(c.id, v);
    }
    const r = results[i]!;
    v.counts[r.status]++;
    v.items.push({
      index,
      source: sourceView(t),
      status: r.status,
      preselected: shouldPreselect(r),
      reason: r.reason,
      best: r.best ? candidateView(r.best) : undefined,
      alternatives: r.alternatives.map(candidateView),
    });
  });
  upload.matches = new Map([...(upload.matches ?? []), ...views]);
  return { collections: [...views.values()] };
}

const TRACK_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function validatePlan(upload: UploadState, plan: unknown): ImportPlanEntry[] {
  if (!Array.isArray(plan) || !plan.length) throw new Error('Nothing selected to import.');
  const byId = new Map(upload.parsed.collections.map((c) => [c.id, c]));
  return plan.map((raw: Partial<ImportPlanEntry>) => {
    const c = raw && typeof raw.collectionId === 'string' ? byId.get(raw.collectionId) : undefined;
    if (!c) throw new Error('Unknown collection in import plan.');
    if (raw.target !== 'playlist' && raw.target !== 'favorites') throw new Error(`Invalid destination for "${c.name}".`);
    if (!Array.isArray(raw.items)) throw new Error(`No tracks given for "${c.name}".`);
    const items = raw.items.map((it) => {
      if (!it || !Number.isInteger(it.index) || it.index < 0 || it.index >= c.tracks.length || !TRACK_ID.test(String(it.trackId))) {
        throw new Error(`Invalid track in "${c.name}".`);
      }
      return { index: it.index, trackId: String(it.trackId) };
    });
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 250) : c.name;
    return { collectionId: c.id, target: raw.target, name, items };
  });
}

/** Create playlists / add favourites in TIDAL. Continues past per-collection failures. */
export async function runImport(
  upload: UploadState,
  plan: ImportPlanEntry[],
  tidal: Pick<TidalClient, 'createPlaylist' | 'addPlaylistItems' | 'addFavoriteTracks'>,
  job: JobHandle,
): Promise<ImportJobResult> {
  const byId = new Map(upload.parsed.collections.map((c) => [c.id, c]));
  const result: ImportJobResult = { playlists: [], favoritesAdded: 0, failures: [] };
  const total = plan.reduce((n, p) => n + p.items.length, 0);
  job.setPhase('Writing to TIDAL', total);

  const toItems = (entry: ImportPlanEntry, seen: Set<string>): CollectionItem[] => {
    const tracks = byId.get(entry.collectionId)!.tracks;
    const out: CollectionItem[] = [];
    for (const it of entry.items) {
      if (seen.has(it.trackId)) continue; // same song twice in one playlist / across favourites
      seen.add(it.trackId);
      out.push({ id: it.trackId, addedAt: tracks[it.index]?.addedAt });
    }
    return out;
  };

  const source = upload.parsed.importerLabel.replace(/\s*\(.*\)$/, '');
  const favoritesSeen = new Set<string>();
  for (const entry of plan) {
    if (job.signal.aborted) break;
    const name = entry.name ?? byId.get(entry.collectionId)!.name;
    try {
      if (entry.target === 'playlist') {
        const items = toItems(entry, new Set());
        const playlist = await tidal.createPlaylist(
          { name, description: `Imported from ${source}.`, accessType: 'UNLISTED' },
          `${job.id}:${entry.collectionId}`,
        );
        let added = 0;
        await tidal.addPlaylistItems(playlist.id, items, {
          signal: job.signal,
          keySalt: job.id,
          onBatch: (n) => {
            added += n;
            job.tick(n);
          },
        });
        job.tick(entry.items.length - items.length);
        result.playlists.push({ collectionId: entry.collectionId, name, url: playlist.url, added });
      } else {
        const items = toItems(entry, favoritesSeen);
        await tidal.addFavoriteTracks(items, {
          signal: job.signal,
          keySalt: job.id,
          onBatch: (n) => {
            result.favoritesAdded += n;
            job.tick(n);
          },
        });
        job.tick(entry.items.length - items.length);
      }
    } catch (err) {
      if (job.signal.aborted) throw err;
      result.failures.push({ collectionId: entry.collectionId, name, error: (err as Error).message });
    }
  }
  return result;
}
