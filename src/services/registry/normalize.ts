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
 * The US registration N-number grammar, on the canonical form produced by
 * {@link normalizeNNumber} (uppercase, no leading `N`, no whitespace): a leading
 * digit 1–9, then more digits, optionally ending in one or two letters — `I` and
 * `O` are never used and a real number never starts with `0`. Overall length is
 * 1–5. Validated against every `n_number` in the active/deregistered/reserved
 * corpus (zero rejections), so it rejects only genuinely malformed input.
 */
const N_NUMBER_SHAPE = /^[1-9]\d{0,4}$|^[1-9]\d{0,3}[A-HJ-NP-Z]$|^[1-9]\d{0,2}[A-HJ-NP-Z]{2}$/;

/**
 * Whether `normalized` is a structurally valid N-number. Pass the output of
 * {@link normalizeNNumber}; a malformed identifier is rejected before a lookup
 * turns it into a misleading `not_found`/`unknown` answer.
 */
export function isValidNNumber(normalized: string): boolean {
  return N_NUMBER_SHAPE.test(normalized);
}

/**
 * The manufacturer/model/series code grammar: 6–7 uppercase alphanumeric
 * characters, no positional sub-structure. Validated against every
 * `aircraft_ref.code` in the corpus (zero rejections). Length 6 is rare but real
 * (an amateur-built reference row), so a strict length-7 rule would 404 a genuine
 * aircraft; leading `0` and the letters `I`/`O` are all legitimate here, unlike
 * N-numbers.
 */
const AIRCRAFT_CODE_SHAPE = /^[0-9A-Z]{6,7}$/;

/**
 * Whether `code` is a structurally valid aircraft reference code. Pass the
 * trimmed, uppercased form (as `getAircraftType` builds it before querying).
 */
export function isValidAircraftCode(code: string): boolean {
  return AIRCRAFT_CODE_SHAPE.test(code);
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
 * Build a column-scoped FTS5 `MATCH` expression from user-supplied free text.
 * Escaping and scoping are deliberately co-located — a caller cannot obtain an
 * unscoped match expression, so a search term can never reach an FTS column the
 * caller did not name.
 *
 * Each token is stripped of `"` and re-wrapped in double quotes, making it an
 * FTS5 string literal; that neutralizes every operator (`-`, `*`, `:`, `^`, `{`,
 * `}`, `NEAR`, `AND`, …) so free text cannot break out of the expression.
 *
 * The parentheses around the AND-joined tokens are load-bearing, not cosmetic:
 * `:` binds tighter than `AND`, so `{make model} : "A" AND "B"` parses as
 * `({make model} : "A") AND "B"` and the second term silently matches every
 * indexed column. `{make model} : ("A" AND "B")` scopes the whole expression.
 *
 * Returns `undefined` when the input yields no usable tokens — emitting
 * `{cols} : ()` is an FTS5 syntax error, so the caller decides what an
 * unmatchable filter means rather than this helper widening it away.
 *
 * @param input - Raw user text.
 * @param columns - The FTS5 columns the match is confined to.
 */
export function toFtsMatch(input: string, columns: readonly string[]): string | undefined {
  const tokens = input
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '').trim())
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"`);
  if (tokens.length === 0) return;
  return `{${columns.join(' ')}} : (${tokens.join(' AND ')})`;
}
