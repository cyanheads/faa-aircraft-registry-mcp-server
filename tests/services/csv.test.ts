/**
 * @fileoverview Tests for the FAA `.txt` CSV reader — header keying, quote
 * handling, latin1 decoding, CRLF handling, and (critically) byte-order-mark
 * stripping. The parser now consumes the raw entry `Buffer` and decodes one line
 * at a time as latin1 (never a whole-file `.toString()` + `.split`), so these
 * feed it the same bytes the ingester does. The real FAA files ship with a UTF-8
 * BOM on every file; read as latin1 that BOM prefixes the first header cell, so
 * without stripping it the first column key is wrong and the whole file silently
 * parses to zero usable rows. The synthetic fixture DB inserts rows directly and
 * never exercises this path, so these tests are the unit-level guard for that
 * real-ingest failure mode.
 * @module tests/services/csv.test
 */

import { describe, expect, it } from 'vitest';
import { parseCsv } from '@/services/registry/csv.js';

/** Encode text as the latin1 bytes the ingester reads from an inflated entry. */
const b = (s: string): Buffer => Buffer.from(s, 'latin1');
/** The three raw bytes of a UTF-8 BOM, as every FAA `.txt` ships. */
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

describe('parseCsv — BOM stripping', () => {
  it('strips a leading UTF-8 BOM so the first column key is clean', () => {
    const content = Buffer.concat([BOM, b('N-NUMBER,SERIAL NUMBER,MAKE\n100,5334,PIPER\n')]);
    const rows = [...parseCsv(content)];
    expect(rows).toHaveLength(1);
    // The first column must key as N-NUMBER, not a BOM-prefixed variant.
    expect(rows[0]?.['N-NUMBER']).toBe('100');
    expect(Object.keys(rows[0] ?? {})).toContain('N-NUMBER');
    expect(Object.keys(rows[0] ?? {}).some((k) => k.charCodeAt(0) > 0x7f)).toBe(false);
  });

  it('parses content with no BOM unchanged', () => {
    const rows = [...parseCsv(b('CODE,MFR\n00000,NONE\n'))];
    expect(rows[0]?.CODE).toBe('00000');
    expect(rows[0]?.MFR).toBe('NONE');
  });
});

describe('parseCsv — header keying and rows', () => {
  it('normalizes header whitespace/case and keys rows by header', () => {
    const rows = [...parseCsv(b('N-Number, Status Code \n100,V\n'))];
    expect(rows[0]?.['N-NUMBER']).toBe('100');
    expect(rows[0]?.['STATUS CODE']).toBe('V');
  });

  it('skips blank lines and the trailing newline', () => {
    const rows = [...parseCsv(b('CODE\n\nA\n\nB\n'))];
    expect(rows.map((r) => r.CODE)).toEqual(['A', 'B']);
  });

  it('honors double-quote escaping so an embedded comma does not shift columns', () => {
    const rows = [...parseCsv(b('NAME,CITY\n"DOE, JOHN",SEATTLE\n'))];
    expect(rows[0]?.NAME).toBe('DOE, JOHN');
    expect(rows[0]?.CITY).toBe('SEATTLE');
  });

  it('yields every row when streaming a many-line buffer', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `${i},M${i}`).join('\n');
    const rows = [...parseCsv(b(`CODE,MFR\n${lines}\n`))];
    expect(rows).toHaveLength(1000);
    expect(rows[999]).toEqual({ CODE: '999', MFR: 'M999' });
  });
});

describe('parseCsv — line decoding', () => {
  it('decodes high latin1 bytes (not UTF-8)', () => {
    // 0xD1 is Ñ in latin1; a UTF-8 decode would mangle it.
    const rows = [...parseCsv(b('CODE,NAME\n1,SEÑOR\n'))];
    expect(rows[0]?.NAME).toBe('SEÑOR');
    expect(rows[0]?.NAME?.charCodeAt(2)).toBe(0xd1);
  });

  it('treats CRLF as a line break (drops the \\r) but keeps a lone \\r in a field', () => {
    const crlf = [...parseCsv(b('CODE\r\nA\r\nB\r\n'))];
    expect(crlf.map((r) => r.CODE)).toEqual(['A', 'B']);

    const loneCr = [...parseCsv(b('CODE,X\nA,B\rC\n'))];
    expect(loneCr[0]).toEqual({ CODE: 'A', X: 'B\rC' });
  });
});
