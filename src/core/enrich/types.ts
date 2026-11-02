import type { SourceTrack } from '../model.js';

export interface EnrichContext {
  signal?: AbortSignal;
  /** Called as unique lookups complete. */
  onProgress?: (done: number, total: number) => void;
  fetch?: typeof fetch;
}

/**
 * Fills in missing metadata (title/artist/duration) on tracks before matching.
 * Enrichers mutate tracks in place and should be idempotent. Tracks they cannot
 * resolve keep `quality: "missing"` and get `hints.unavailable` explaining why.
 *
 * Examples: YouTube video-id lookups today; an Apple Music catalog-id lookup or a
 * MusicBrainz ISRC lookup could be added the same way.
 */
export interface TrackEnricher {
  id: string;
  appliesTo(track: SourceTrack): boolean;
  enrich(tracks: SourceTrack[], ctx: EnrichContext): Promise<void>;
}
