/**
 * @fileoverview Mode S → N-number decoder coverage: both ends of each branch, a
 * round trip over every US address that encodes an N-number, and addresses the
 * FAA stores for real registrations.
 * @module tests/services/mode-s.test
 */
import { describe, expect, it } from 'vitest';
import { decodeModeSCode } from '@/services/registry/mode-s.js';
import { isValidNNumber } from '@/services/registry/normalize.js';

const LETTERS = [...'ABCDEFGHJKLMNPQRSTUVWXYZ'];
const DIGITS = [...'0123456789'];

/**
 * Every N-number in assignment order, written as the enumeration the mapping is
 * defined by rather than the decoder's arithmetic: a digit prefix, its letter
 * suffixes (A, AA–AZ, B, …), then each digit extension and everything after it.
 */
function* nNumbersInAddressOrder(prefix = ''): Generator<string> {
  if (prefix === '') {
    for (const first of DIGITS.slice(1)) yield* nNumbersInAddressOrder(first);
    return;
  }
  yield prefix;
  if (prefix.length === 5) return;
  for (const letter of LETTERS) {
    yield prefix + letter;
    if (prefix.length <= 3) for (const second of LETTERS) yield prefix + letter + second;
  }
  for (const digit of DIGITS) yield* nNumbersInAddressOrder(prefix + digit);
}

const hex = (address: number) => address.toString(16).toUpperCase().padStart(6, '0');

describe('decodeModeSCode', () => {
  it.each([
    ['A00001', '1'],
    ['ADF7C7', '99999'],
  ])('decodes %s, an end of the N-number range, to N%s', (code, nNumber) => {
    expect(decodeModeSCode(code)).toEqual({ kind: 'n_number', nNumber });
  });

  it.each(['A00000', 'ADF7C8', 'AFFFFF'])('reports %s as US but unmapped', (code) => {
    expect(decodeModeSCode(code)).toEqual({ kind: 'us_unmapped' });
  });

  it.each(['9FFFFF', 'B00000', '000000', 'FFFFFF'])('reports %s as outside the US', (code) => {
    expect(decodeModeSCode(code)).toEqual({ kind: 'non_us' });
  });

  /** Pairs stored in the FAA archive dated 2026-11-13: one per N-number shape. */
  it.each([
    ['A00002', '1A'],
    ['A0001A', '1AZ'],
    ['A0001C', '1BA'],
    ['AC6CCF', '9ZX'],
    ['A0025B', '10A'],
    ['ADD2A1', '99ZZ'],
    ['A004B4', '100A'],
    ['ADF669', '999ZZ'],
    ['A0072F', '1001'],
    ['A0070D', '1000A'],
    ['ADF731', '9995Z'],
    ['ADF7BB', '9999X'],
    ['A00725', '10000'],
    ['A061D9', '12345'],
    ['ADF75E', '99969'],
    ['ADF7BE', '99990'],
    ['ADF7C5', '99997'],
    ['A4A638', '399WM'],
  ])('decodes the stored address %s to N%s', (code, nNumber) => {
    expect(decodeModeSCode(code)).toEqual({ kind: 'n_number', nNumber });
  });

  it('round-trips every address from A00001 to ADF7C7 through its N-number', () => {
    let address = 0xa00001;
    const mismatches: string[] = [];
    for (const nNumber of nNumbersInAddressOrder()) {
      const decoded = decodeModeSCode(hex(address));
      if (
        decoded.kind !== 'n_number' ||
        decoded.nNumber !== nNumber ||
        !isValidNNumber(decoded.nNumber)
      ) {
        mismatches.push(`${hex(address)} → ${JSON.stringify(decoded)}, expected N${nNumber}`);
      }
      address++;
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
    expect(hex(address)).toBe('ADF7C8');
  });
});
