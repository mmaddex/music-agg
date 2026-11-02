import { parse } from 'csv-parse/sync';
import { fileText, firstLine, type BundleFile } from '../bundle/bundle.js';

/** Parse a CSV file into raw rows (arrays of strings). Blank lines are kept as `[""]`. */
export function readCsvRows(file: BundleFile): string[][] {
  const delimiter = sniffDelimiter(firstLine(file));
  return parse(fileText(file), {
    delimiter,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: false,
    bom: true,
  }) as string[][];
}

/** Parse a CSV file with a header row into records keyed by header name. */
export function readCsvRecords(file: BundleFile): { header: string[]; records: Record<string, string>[] } {
  const rows = readCsvRows(file).filter((r) => !isBlankRow(r));
  const header = (rows[0] ?? []).map((h) => h.trim());
  const records = rows.slice(1).map((row) => recordFrom(header, row));
  return { header, records };
}

export function recordFrom(header: string[], row: string[]): Record<string, string> {
  // Null-prototype object so a header like "__proto__" can't do anything surprising.
  const rec: Record<string, string> = Object.create(null);
  header.forEach((h, i) => {
    if (h) rec[h] = (row[i] ?? '').trim();
  });
  return rec;
}

export function isBlankRow(row: string[]): boolean {
  return row.every((c) => c.trim() === '');
}

/** Header cells of a CSV file (first line only). */
export function csvHeader(file: BundleFile): string[] {
  const line = firstLine(file);
  if (!line) return [];
  try {
    const rows = parse(line, { delimiter: sniffDelimiter(line), relax_quotes: true, relax_column_count: true }) as string[][];
    return (rows[0] ?? []).map((h) => h.trim());
  } catch {
    return [];
  }
}

export function isCsv(file: BundleFile): boolean {
  return /\.(csv|tsv)$/i.test(file.name);
}

function sniffDelimiter(line: string): string {
  const counts = [',', ';', '\t'].map((d) => [d, line.split(d).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ',';
}

/** Case/punctuation-insensitive header lookup: "Artist Name(s)" matches "artistnames". */
export function headerKey(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}
