/**
 * @fileoverview Field-level normalization helpers shared by the ingester and the
 * query layer — N-number canonicalization, FAA row-field cleaning, integer/date
 * coercion, and FTS5 query escaping. Pure functions, no I/O.
 * @module services/registry/normalize
 */

/**
 * Canonicalize an N-number to the registry's storage form: uppercase, no leading
 * `N`, no internal whitespace. Accepts `N12345`, `n12345`, or `12345`. The FAA
 * stores numbers without the leading N; lookups normalize before hitting the
 * index.
 */
export function normalizeNNumber(input: string): string {
  const trimmed = input.trim().toUpperCase().replace(/\s+/g, '');
  return trimmed.startsWith('N') ? trimmed.slice(1) : trimmed;
}

/** Render the conventional display form with the leading `N`. */
export function displayNNumber(normalized: string): string {
  return `N${normalized}`;
}

/**
 * Clean a raw FAA field: trim surrounding whitespace and return `undefined` for
 * empty values. Permissible fields are legitimately blank on many records, so an
 * empty field is absence (unknown), never a fabricated value.
 */
export function cleanField(value: string | undefined): string | undefined {
  if (value === undefined) return;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Parse an integer FAA field; `undefined` when blank or non-numeric. */
export function parseIntField(value: string | undefined): number | undefined {
  const cleaned = cleanField(value);
  if (cleaned === undefined) return;
  const n = Number.parseInt(cleaned, 10);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * Parse an FAA date field (`YYYYMMDD`) to an ISO `YYYY-MM-DD` string. The FAA
 * ships dates as 8-digit strings; `undefined` for blank or malformed.
 */
export function parseFaaDate(value: string | undefined): string | undefined {
  const cleaned = cleanField(value);
  if (cleaned === undefined) return;
  if (!/^\d{8}$/.test(cleaned)) return;
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4, 6)}-${cleaned.slice(6, 8)}`;
}

/**
 * Escape a user string for use as an FTS5 `MATCH` term. Wrapping each token in
 * double quotes neutralizes FTS5 operators (`-`, `*`, `:`, `NEAR`, `AND`, etc.)
 * so an owner name or make/model with punctuation can't break the query or be
 * abused for FTS injection. Tokens are AND-combined.
 */
export function toFtsMatch(input: string): string {
  const tokens = input
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '').trim())
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"`);
  return tokens.join(' AND ');
}
