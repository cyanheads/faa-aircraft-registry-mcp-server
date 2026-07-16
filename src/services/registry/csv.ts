/**
 * @fileoverview Minimal CSV reader for the FAA registry `.txt` files. The files
 * are comma-delimited with a header row and trailing commas; fields are
 * space-padded to fixed widths and (in practice) unquoted. The parser still
 * honors double-quote escaping defensively so a quoted field with an embedded
 * comma can't shift every downstream column. Header-keyed rows tolerate the
 * FAA's occasional column reordering better than fixed character positions.
 *
 * Reads the raw entry `Buffer` directly, decoding one line at a time as latin1 —
 * never a whole-file `.toString()` + `.split(/\r?\n/)`. For the multi-hundred-MB
 * files (`DEREG.txt`, `MASTER.txt`) that keeps the per-file transient a single
 * line wide instead of ~2–3× the file's bytes (a UTF-16 string plus a full line
 * array), which is a primary lever on the ingest's peak memory.
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

/** Normalize a header cell to a stable lookup key: upper-case, collapsed spaces. */
export function normalizeHeader(header: string): string {
  return header.trim().toUpperCase().replace(/\s+/g, ' ');
}

/**
 * Yield the latin1-decoded lines of a raw FAA entry buffer one at a time,
 * matching `String.prototype.split(/\r?\n/)` semantics: `\n` terminates a line,
 * a `\r` is consumed only when it immediately precedes `\n`, and a lone `\r`
 * stays in the line. A leading UTF-8 BOM (`EF BB BF`) — which every FAA `.txt`
 * ships and which, decoded as latin1, would otherwise corrupt the first header
 * cell — is stripped once at the start. Streaming so a large file never
 * materializes as a single decoded string or a full array of lines.
 */
function* latin1Lines(buf: Buffer): Generator<string> {
  let start = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0;
  const len = buf.length;
  for (let i = start; i <= len; i++) {
    if (i === len || buf[i] === 0x0a /* \n */) {
      let end = i;
      if (end > start && buf[end - 1] === 0x0d /* \r */) end--; // drop the \r of a \r\n
      yield buf.toString('latin1', start, end);
      start = i + 1;
    }
  }
}

/**
 * Parse FAA `.txt` bytes into header-keyed rows. Yields one {@link CsvRow} per
 * data line (the header row drives the keys). Blank lines are skipped. Consumes
 * the entry buffer as a stream (see {@link latin1Lines}) so a multi-megabyte
 * file never materializes every row — or the whole decoded file — at once.
 */
export function* parseCsv(content: Buffer): Generator<CsvRow> {
  let headers: string[] | undefined;
  for (const line of latin1Lines(content)) {
    if (line.trim() === '') continue;
    if (headers === undefined) {
      headers = splitLine(line).map(normalizeHeader);
      continue;
    }
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
