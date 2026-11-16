/**
 * @fileoverview Decode a Mode S code (ICAO 24-bit aircraft address) to the US
 * N-number it encodes. The US allocation is A00000–AFFFFF; A00001–ADF7C7 map one
 * to one onto N1–N99999 by listing every valid N-number depth first: a digit
 * prefix, then its letter suffixes (A, AA–AZ, B, BA–BZ, …), then each of its ten
 * digit extensions in turn. Pure arithmetic, no I/O.
 * @module services/registry/mode-s
 */

/** The letters an N-number can carry: A–Z without I and O. */
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const US_ALLOCATION_START = 0xa00000;
const US_ALLOCATION_END = 0xafffff;
/** One letter, or one letter followed by a second: 24 + 24 × 24. */
const LETTER_SUFFIXES = LETTERS.length * (LETTERS.length + 1);
/** Addresses a one-digit prefix and every N-number extending it occupy. */
const ONE_DIGIT_SPAN = 101_711;
/** The same span for a two-, three- and four-digit prefix. */
const LONGER_PREFIX_SPANS = [10_111, 951, 35] as const;

/** What a Mode S code says about US registration numbers. */
export type ModeSDecode =
  | {
      kind: 'n_number';
      /** Normalized, without the leading "N". */
      nNumber: string;
    }
  | { kind: 'us_unmapped' }
  | { kind: 'non_us' };

/**
 * Decode a normalized Mode S code: six uppercase hexadecimal characters, as the
 * `modeSCode` search filter accepts them. `us_unmapped` covers A00000 and
 * ADF7C8–AFFFFF, which lie in the US allocation but encode no N-number.
 */
export function decodeModeSCode(hex: string): ModeSDecode {
  const address = Number.parseInt(hex, 16);
  if (address < US_ALLOCATION_START || address > US_ALLOCATION_END) return { kind: 'non_us' };
  let offset = address - US_ALLOCATION_START - 1;
  if (offset < 0 || offset >= 9 * ONE_DIGIT_SPAN) return { kind: 'us_unmapped' };

  let nNumber = String(Math.trunc(offset / ONE_DIGIT_SPAN) + 1);
  offset %= ONE_DIGIT_SPAN;
  for (const span of LONGER_PREFIX_SPANS) {
    if (offset === 0) return { kind: 'n_number', nNumber };
    offset -= 1;
    if (offset < LETTER_SUFFIXES) {
      const second = offset % (LETTERS.length + 1);
      nNumber += LETTERS.charAt(Math.trunc(offset / (LETTERS.length + 1)));
      if (second > 0) nNumber += LETTERS.charAt(second - 1);
      return { kind: 'n_number', nNumber };
    }
    offset -= LETTER_SUFFIXES;
    nNumber += Math.trunc(offset / span);
    offset %= span;
  }
  // Four digits leave room for one more character: a letter or a digit.
  if (offset > 0) {
    nNumber +=
      offset <= LETTERS.length ? LETTERS.charAt(offset - 1) : String(offset - 1 - LETTERS.length);
  }
  return { kind: 'n_number', nNumber };
}
