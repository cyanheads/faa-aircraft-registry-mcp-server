/**
 * @fileoverview Tests for the FAA `.txt` CSV reader — header keying, quote
 * handling, and (critically) byte-order-mark stripping. The real FAA files ship
 * with a UTF-8 BOM on every file; read as latin1 (how the ingester reads them)
 * that BOM prefixes the first header cell, so without stripping it the first
 * column key is wrong and the whole file silently parses to zero usable rows.
 * The synthetic fixture DB inserts rows directly and never exercises this path,
 * so these tests are the unit-level guard for that real-ingest failure mode.
 * @module tests/services/csv.test
 */

import { describe, expect, it } from 'vitest';
import { parseCsv } from '@/services/registry/csv.js';

/** The three bytes of a UTF-8 BOM, decoded as latin1 (how the ingester reads files). */
const BOM_LATIN1 = 'ï»¿';

describe('parseCsv — BOM stripping', () => {
  it('strips a latin1-decoded UTF-8 BOM so the first column key is clean', () => {
    const content = `${BOM_LATIN1}N-NUMBER,SERIAL NUMBER,MAKE\n100,5334,PIPER\n`;
    const rows = [...parseCsv(content)];
    expect(rows).toHaveLength(1);
    // The first column must key as N-NUMBER, not ﻿N-NUMBER — this is the bug.
    expect(rows[0]?.['N-NUMBER']).toBe('100');
    expect(Object.keys(rows[0] ?? {})).toContain('N-NUMBER');
    expect(Object.keys(rows[0] ?? {}).some((k) => k.includes('ï'))).toBe(false);
  });

  it('strips a U+FEFF BOM (UTF-8-decoded form) from the first header cell', () => {
    const content = `﻿CODE,MFR,MODEL\n2072714,CESSNA,172S\n`;
    const rows = [...parseCsv(content)];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.CODE).toBe('2072714');
    expect(Object.keys(rows[0] ?? {})).toContain('CODE');
  });

  it('parses content with no BOM unchanged', () => {
    const rows = [...parseCsv('CODE,MFR\n00000,NONE\n')];
    expect(rows[0]?.CODE).toBe('00000');
    expect(rows[0]?.MFR).toBe('NONE');
  });
});

describe('parseCsv — header keying and rows', () => {
  it('normalizes header whitespace/case and keys rows by header', () => {
    const rows = [...parseCsv('N-Number, Status Code \n100,V\n')];
    expect(rows[0]?.['N-NUMBER']).toBe('100');
    expect(rows[0]?.['STATUS CODE']).toBe('V');
  });

  it('skips blank lines and the trailing newline', () => {
    const rows = [...parseCsv('CODE\n\nA\n\nB\n')];
    expect(rows.map((r) => r.CODE)).toEqual(['A', 'B']);
  });

  it('honors double-quote escaping so an embedded comma does not shift columns', () => {
    const rows = [...parseCsv('NAME,CITY\n"DOE, JOHN",SEATTLE\n')];
    expect(rows[0]?.NAME).toBe('DOE, JOHN');
    expect(rows[0]?.CITY).toBe('SEATTLE');
  });
});
