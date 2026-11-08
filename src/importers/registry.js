// Export-format registry.
//
// An adapter is { id, label, description, detect(bundle) -> 0..1, parse(bundle) -> { collections, warnings } }.
// To support another service: write an adapter in ./adapters and add it to ADAPTERS.
// Nothing else in the app needs to change.

import { loadBundles } from './bundle.js';
import { appleMusic } from './adapters/appleMusic.js';
import { youtubeMusic } from './adapters/youtubeMusic.js';
import { genericCsv } from './adapters/genericCsv.js';

export const ADAPTERS = [youtubeMusic, appleMusic, genericCsv];

export class UnknownFormatError extends Error {}

export function listFormats() {
  return ADAPTERS.map(({ id, label, description }) => ({ id, label, description }));
}

export function detectAdapter(bundle, adapters = ADAPTERS) {
  let best = null;
  let bestScore = 0;
  for (const adapter of adapters) {
    const score = adapter.detect(bundle);
    if (score > bestScore) {
      best = adapter;
      bestScore = score;
    }
  }
  return best;
}

/** Parse an already-loaded bundle into a Library. `formatId` forces a specific adapter. */
export function parseBundle(bundle, { formatId } = {}) {
  const adapter = formatId ? ADAPTERS.find((a) => a.id === formatId) : detectAdapter(bundle);
  if (!adapter) {
    throw new UnknownFormatError(
      `Could not recognise this export. Supported formats: ${ADAPTERS.map((a) => a.label).join('; ')}.`,
    );
  }
  const { collections, warnings = [] } = adapter.parse(bundle);
  return { format: adapter.id, formatLabel: adapter.label, collections, warnings, skippedFiles: bundle.skipped || [] };
}

/**
 * Upload → Library in one step. Pass `files: [{ filename, buffer }]` for a multi-file export
 * (e.g. Apple's "Part 1 of 2" / "Part 2 of 2"), or a single `filename` + `buffer`.
 */
export async function parseExport({ files, filename, buffer, formatId }) {
  const bundle = await loadBundles(files ?? [{ filename, buffer }]);
  return parseBundle(bundle, { formatId });
}
