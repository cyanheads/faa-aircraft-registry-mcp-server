/**
 * @fileoverview Minimal CSV reader for the FAA registry `.txt` files. The files
 * are comma-delimited with a header row and trailing commas; fields are
 * space-padded to fixed widths and (in practice) unquoted. The parser still
 * honors double-quote escaping defensively so a quoted field with an embedded
 * comma can't shift every downstream column. Header-keyed rows tolerate the
 * FAA's occasional column reordering better than fixed character positions.
 * @module services/registry/csv
 */

/** A header-keyed CSV row: normalized header name → raw cell value. */
export type CsvRow = Record<string, string>;

/**
 * Split one CSV line into fields, honoring double-quote escaping (`""` is a
 * literal quote inside a quoted field). FAA data is unquoted, so the fast path
 * is a plain split; the quote handling is a cheap safety net.
 */
function splitLine(line: string): string[] {
  if (!line.includes('"')) return line.split(',');

  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  let pendingQuote = false; // a `"` seen inside quotes — escaped quote or close
  for (const ch of line) {
    if (pendingQuote) {
      pendingQuote = false;
      if (ch === '"') {
        current += '"'; // doubled quote → literal
        continue;
      }
      inQuotes = false; // lone quote closed the field; fall through to handle ch
    }
    if (inQuotes) {
      if (ch === '"') pendingQuote = true;
      else current += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Strip a leading byte-order mark from the file content. The FAA ships every
 * `.txt` with a UTF-8 BOM (`EF BB BF`); decoded as latin1 (how the ingester reads
 * these files) that becomes the three characters `\xEF\xBB\xBF`, decoded as UTF-8
 * it's `﻿`. Either way it prefixes the very first header cell — so without
 * stripping it, the first column key becomes e.g. `﻿N-NUMBER` instead of
 * `N-NUMBER`, every `pick()` for that column misses, and the whole file silently
 * ingests zero rows.
 */
function stripBom(content: string): string {
  if (content.charCodeAt(0) === 0xfeff) return content.slice(1);
  if (
    content.charCodeAt(0) === 0xef &&
    content.charCodeAt(1) === 0xbb &&
    content.charCodeAt(2) === 0xbf
  ) {
    return content.slice(3);
  }
  return content;
}

/** Normalize a header cell to a stable lookup key: upper-case, collapsed spaces. */
export function normalizeHeader(header: string): string {
  return header.trim().toUpperCase().replace(/\s+/g, ' ');
}

/**
 * Parse FAA `.txt` content into header-keyed rows. Yields one {@link CsvRow} per
 * data line (the header row drives the keys). Blank trailing lines are skipped.
 * Generator-based so a multi-megabyte MASTER part streams without materializing
 * every row at once.
 */
export function* parseCsv(content: string): Generator<CsvRow> {
  const lines = stripBom(content).split(/\r?\n/);

  let headerLine: string | undefined;
  let cursor = 0;
  for (; cursor < lines.length; cursor++) {
    const candidate = lines[cursor];
    if (candidate !== undefined && candidate.trim() !== '') {
      headerLine = candidate;
      cursor++;
      break;
    }
  }
  if (headerLine === undefined) return;

  const headers = splitLine(headerLine).map(normalizeHeader);

  for (let i = cursor; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.trim() === '') continue;
    const cells = splitLine(line);
    const row: CsvRow = {};
    for (let c = 0; c < headers.length; c++) {
      const header = headers[c];
      if (header === undefined) continue;
      row[header] = cells[c] ?? '';
    }
    yield row;
  }
}
