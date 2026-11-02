/**
 * Types shared by the API server and the web client (type-only; no runtime code).
 */

export type ImportTarget = 'playlist' | 'favorites' | 'skip';
export type MatchStatus = 'matched' | 'review' | 'unmatched';

export interface UserView {
  id: string;
  username?: string;
  firstName?: string;
  country: string;
}

export interface ImporterInfo {
  id: string;
  label: string;
  description: string;
}

export interface SessionView {
  user: UserView | null;
  importers: ImporterInfo[];
  youtubeApiKey: boolean;
}

export interface CollectionSummary {
  id: string;
  name: string;
  description?: string;
  kind: 'playlist' | 'library' | 'liked';
  trackCount: number;
  /** Entries with only an id (e.g. a YouTube video id) that need an online lookup first. */
  needsLookup: number;
  suggestedTarget: ImportTarget;
  note?: string;
}

export interface UploadSummary {
  uploadId: string;
  sources: string[];
  importer: { id: string; label: string };
  detected: { id: string; label: string; confidence: number; reason: string }[];
  collections: CollectionSummary[];
  warnings: string[];
}

export interface CandidateView {
  id: string;
  title: string;
  version?: string;
  artists: string[];
  album?: string;
  durationMs?: number;
  url: string;
  score: number;
}

export interface SourceTrackView {
  title?: string;
  artists: string[];
  album?: string;
  durationMs?: number;
  /** Raw YouTube video title when the title/artist were guessed from it. */
  videoTitle?: string;
  sourceUrl?: string;
  guessed: boolean;
}

export interface MatchItemView {
  index: number;
  source: SourceTrackView;
  status: MatchStatus;
  /** Whether the UI should tick this row by default (confident, or a strong suggestion). */
  preselected: boolean;
  reason?: string;
  best?: CandidateView;
  alternatives: CandidateView[];
}

export interface CollectionMatchView {
  id: string;
  name: string;
  items: MatchItemView[];
  counts: Record<MatchStatus, number>;
}

export interface MatchJobResult {
  collections: CollectionMatchView[];
}

export interface ImportPlanEntry {
  collectionId: string;
  target: 'playlist' | 'favorites';
  /** Playlist name (target "playlist" only). */
  name?: string;
  /** Source positions and the TIDAL track chosen for each, in playlist order. */
  items: { index: number; trackId: string }[];
}

export interface ImportJobResult {
  playlists: { collectionId: string; name: string; url: string; added: number }[];
  favoritesAdded: number;
  failures: { collectionId: string; name: string; error: string }[];
}

export interface JobView<R = unknown> {
  id: string;
  kind: 'match' | 'import';
  uploadId: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  phase: string;
  done: number;
  total: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  result?: R;
}
