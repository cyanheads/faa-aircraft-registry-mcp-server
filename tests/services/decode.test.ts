/**
 * @fileoverview FAA dictionary decoder coverage.
 * @module tests/services/decode.test
 */
import { describe, expect, it } from 'vitest';
import { decodeStatusCode, decodeWeightClass } from '@/services/registry/decode.js';

describe('status decoder compatibility', () => {
  it.each([
    ['1', 'Triennial Aircraft Registration form returned by the Post Office as undeliverable'],
    ['2', 'N-Number assigned but not yet registered'],
    ['3', 'N-Number assigned as a Non Type Certificated aircraft but not yet registered'],
    ['4', 'N-Number assigned as import but not yet registered'],
    ['5', 'Reserved N-Number'],
    ['6', 'Administratively canceled'],
    ['7', 'Sale reported'],
    [
      '8',
      'Second attempt mailing a Triennial Aircraft Registration form to the owner with no response',
    ],
    ['9', 'Certificate of Registration revoked'],
    ['10', 'N-Number assigned, not registered, pending cancellation'],
    [
      '11',
      'N-Number assigned as Non Type Certificated (Amateur), not registered, pending cancellation',
    ],
    ['12', 'N-Number assigned as import, not registered, pending cancellation'],
    ['13', 'Registration Expired'],
    ['14', 'First Notice for Re-Registration/Renewal'],
    ['15', 'Second Notice for Re-Registration/Renewal'],
    ['16', 'Registration Expired – Pending Cancellation'],
    ['17', 'Sale Reported – Pending Cancellation'],
    ['18', 'Sale Reported – Canceled'],
    ['19', 'Registration Pending – Pending Cancellation'],
    ['20', 'Registration Pending – Canceled'],
    ['21', 'Revoked – Pending Cancellation'],
    ['22', 'Revoked – Canceled'],
    ['23', 'Expired Dealer (Pending Cancellation)'],
    ['24', 'Third Notice for Re-Registration/Renewal'],
    ['25', 'First Notice for Registration Renewal'],
    ['26', 'Second Notice for Registration Renewal'],
    ['27', 'Registration Expired'],
    ['28', 'Third Notice for Registration Renewal'],
    ['29', 'Registration Expired – Pending Cancellation'],
  ])('decodes FAA numeric status %s', (code, label) => {
    expect(decodeStatusCode(` ${code} `)).toBe(label);
  });
  it('normalizes letter codes and preserves unknown and absent labels', () => {
    expect(decodeStatusCode(' v ')).toBe('Valid registration');
    for (const code of ['', ' ', 'B', 'C', '30', null, undefined]) {
      expect(decodeStatusCode(code)).toBeUndefined();
    }
  });
});

describe('weight decoder', () => {
  it.each([
    ['CLASS 1', 'Maximum gross takeoff weight up to 12,499 lb'],
    ['CLASS 2', 'Maximum gross takeoff weight 12,500–19,999 lb'],
    ['CLASS 3', 'Maximum gross takeoff weight 20,000 lb and over'],
    ['CLASS 4', 'Maximum gross takeoff weight: UAV up to 55 lb'],
  ])('decodes %s after normalization', (code, label) => {
    expect(decodeWeightClass(` ${code.toLowerCase()} `)).toBe(label);
  });

  it('omits labels for unknown, blank and absent classes', () => {
    for (const value of ['CLASS 5', 'ODD CLASS', '', ' ', null, undefined]) {
      expect(decodeWeightClass(value)).toBeUndefined();
    }
  });
});
