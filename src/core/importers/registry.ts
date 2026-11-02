import type { ExportBundle } from '../bundle/bundle.js';
import type { ParsedExport } from '../model.js';
import { genericCsvImporter } from './generic-csv.js';
import type { Detection, ExportImporter } from './types.js';
import { youtubeMusicImporter } from './youtube-music.js';

/**
 * All known export formats. To add one (e.g. Apple Music, Google Play Music):
 *   1. create `src/core/importers/<service>.ts` implementing `ExportImporter`
 *   2. add it to this list
 *   3. add a fixture + test under `test/`
 * Nothing else in the app needs to change.
 */
export const IMPORTERS: ExportImporter[] = [youtubeMusicImporter, genericCsvImporter];

export interface DetectedImporter extends Detection {
  importer: ExportImporter;
}

export function detectImporters(bundle: ExportBundle, importers = IMPORTERS): DetectedImporter[] {
  return importers
    .map((importer) => {
      const d = importer.detect(bundle);
      return d ? { ...d, importer } : null;
    })
    .filter((d): d is DetectedImporter => d !== null && d.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence);
}

export class UnsupportedExportError extends Error {}

/** Parse with the requested importer, or the best-detected one. */
export function parseExport(
  bundle: ExportBundle,
  importerId?: string,
  importers = IMPORTERS,
): { parsed: ParsedExport; detected: DetectedImporter[] } {
  const detected = detectImporters(bundle, importers);
  let importer: ExportImporter | undefined;
  if (importerId) {
    importer = importers.find((i) => i.id === importerId);
    if (!importer) throw new UnsupportedExportError(`Unknown format "${importerId}".`);
  } else {
    importer = detected[0]?.importer;
  }
  if (!importer) {
    const names = bundle.files.slice(0, 5).map((f) => f.path).join(', ');
    throw new UnsupportedExportError(
      `Couldn't recognise this export (${bundle.files.length} file(s): ${names}${bundle.files.length > 5 ? ', …' : ''}). ` +
        'Supported: ' + importers.map((i) => i.label).join(', ') + '.',
    );
  }
  const parsed = importer.parse(bundle);
  if (!parsed.collections.length) {
    throw new UnsupportedExportError(`No playlists or songs found using the ${importer.label} format.`);
  }
  return { parsed, detected };
}
