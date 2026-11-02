/**
 * Source-agnostic data model.
 *
 * Every importer (YouTube Music, Google Play Music, Apple Music, generic CSV, ...)
 * converts its export into these shapes. Everything downstream — metadata
 * enrichment, TIDAL matching and writing — only ever sees this model, so adding a
 * new export format never requires touching the TIDAL side.
 */

/** A reference to the track in the service it was exported from. */
export interface SourceRef {
  /** e.g. "youtube", "apple-music", "google-play-music" */
  service: string;
  /** The id in that service (a YouTube video id, an Apple Music catalog id, ...). */
  id: string;
  url?: string;
}

/**
 * How trustworthy the title/artist fields are:
 *  - "export":   taken verbatim from structured export columns (best).
 *  - "inferred": derived from something unstructured, e.g. a YouTube video title.
 *  - "missing":  not known yet — an enricher must fill it in before matching.
 */
export type MetadataQuality = 'export' | 'inferred' | 'missing';

export interface SourceTrack {
  title?: string;
  /** Individual artist names when known. May be a single combined string. */
  artists: string[];
  album?: string;
  durationMs?: number;
  isrc?: string;
  /** When the track was added to the playlist/library in the source service (ISO 8601). */
  addedAt?: string;
  refs: SourceRef[];
  quality: MetadataQuality;
  /** Free-form hints for enrichers/matchers, e.g. { channel: "Wilco - Topic" }. */
  hints?: Record<string, string>;
}

export type CollectionKind = 'playlist' | 'library' | 'liked';

/** Where a collection should end up in TIDAL. */
export type ImportTarget = 'playlist' | 'favorites' | 'skip';

export interface SourceCollection {
  /** Stable id within one parsed export. */
  id: string;
  name: string;
  description?: string;
  kind: CollectionKind;
  tracks: SourceTrack[];
  /** What the UI should pre-select. Importers know their format best. */
  suggestedTarget: ImportTarget;
  /** Optional explanation shown next to the suggestion, e.g. "Usually non-music videos". */
  note?: string;
}

export interface ParsedExport {
  importerId: string;
  importerLabel: string;
  collections: SourceCollection[];
  warnings: string[];
}
