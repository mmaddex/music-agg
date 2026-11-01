import { parse } from 'csv-parse/sync';

/** Parse CSV/TSV text into an array of plain objects keyed by header. */
export function parseCsv(text, { delimiter } = {}) {
  const sample = text.slice(0, 2000);
  const delim = delimiter || (sample.split('\t').length > sample.split(',').length ? '\t' : ',');
  return parse(text, {
    columns: (header) => header.map((h) => String(h).trim()),
    delimiter: delim,
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
    trim: true,
  });
}

/** First header line of a text file (BOM-stripped). */
export function firstLine(text) {
  return text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] || '';
}

const canon = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Find which of a record's columns matches one of the given aliases (case/space/
 * punctuation-insensitive). Returns the real column name or null.
 */
export function findColumn(columns, aliases) {
  const byCanon = new Map(columns.map((c) => [canon(c), c]));
  for (const alias of aliases) {
    const hit = byCanon.get(canon(alias));
    if (hit) return hit;
  }
  return null;
}
