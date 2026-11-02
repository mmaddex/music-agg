import type { ExportBundle } from '../bundle/bundle.js';
import type { ParsedExport } from '../model.js';

export interface Detection {
  /** 0..1 — how sure the importer is that it understands this bundle. */
  confidence: number;
  /** Short human-readable reason, shown in the UI. */
  reason: string;
}

/**
 * One export format. Implementations live next to this file; register them in
 * `registry.ts`.
 *
 * Contract:
 *  - `detect` must be cheap (look at paths and CSV header lines, not whole files)
 *    and return null when the bundle is clearly not this format.
 *  - `parse` converts the bundle into the source-agnostic `ParsedExport`. It must
 *    not call the network; tracks whose metadata is incomplete (e.g. YouTube
 *    playlist entries that only have a video id) are marked `quality: "missing"`
 *    and filled in later by an enricher (see ../enrich).
 */
export interface ExportImporter {
  id: string;
  label: string;
  /** One sentence describing what files the importer reads. */
  description: string;
  detect(bundle: ExportBundle): Detection | null;
  parse(bundle: ExportBundle): ParsedExport;
}
