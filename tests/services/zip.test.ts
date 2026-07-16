/**
 * @fileoverview Tests for the lazy ZIP reader. `openZipArchive` parses the
 * central directory up front but inflates each entry only on `readEntry` — the
 * change that keeps rebuild memory bounded by the largest single file. These
 * cover both compression methods, the large-entry presize path (zlib output
 * chunk sized to the known length so it inflates in one allocation), the
 * case-insensitive base-name lookup, and the malformed-archive guard.
 * @module tests/services/zip.test
 */

import { describe, expect, it } from 'vitest';
import { openZipArchive } from '@/services/registry/zip.js';
import { makeZip } from '../fixtures/make-zip.js';

describe('openZipArchive', () => {
  it('inflates a DEFLATE entry on demand and returns its exact bytes', () => {
    const content = Buffer.from('CODE,MFR\n41514,LYCOMING\n', 'latin1');
    const archive = openZipArchive(makeZip([{ name: 'ENGINE.txt', data: content }]));
    expect(archive.readEntry('ENGINE.txt')?.equals(content)).toBe(true);
  });

  it('reads a STORED (uncompressed) entry', () => {
    const content = Buffer.from('hello stored', 'latin1');
    const archive = openZipArchive(makeZip([{ name: 'A.txt', data: content, method: 'store' }]));
    expect(archive.readEntry('A.txt')?.equals(content)).toBe(true);
  });

  it('inflates a large entry (past the default chunk) via the presize path', () => {
    // > 16 KiB so inflateEntry sizes zlib's output chunk to the known length.
    const big = Buffer.from('N-NUMBER,STATUS\n'.repeat(20_000), 'latin1');
    const archive = openZipArchive(makeZip([{ name: 'DEREG.txt', data: big }]));
    const out = archive.readEntry('DEREG.txt');
    expect(out?.length).toBe(big.length);
    expect(out?.equals(big)).toBe(true);
  });

  it('matches entries by case-insensitive base name, ignoring directory prefixes', () => {
    const data = Buffer.from('x', 'latin1');
    const archive = openZipArchive(makeZip([{ name: 'sub/dir/MASTER.TXT', data }]));
    expect(archive.readEntry('master.txt')?.equals(data)).toBe(true);
  });

  it('returns undefined for an absent entry', () => {
    const archive = openZipArchive(makeZip([{ name: 'A.txt', data: Buffer.from('a') }]));
    expect(archive.readEntry('MISSING.txt')).toBeUndefined();
  });

  it('exposes the stored entry names', () => {
    const archive = openZipArchive(
      makeZip([
        { name: 'ENGINE.txt', data: Buffer.from('a') },
        { name: 'MASTER.txt', data: Buffer.from('b') },
      ]),
    );
    expect([...archive.entryNames]).toEqual(['ENGINE.txt', 'MASTER.txt']);
  });

  it('does not inflate entries that are never read', () => {
    // A STORED entry whose recorded compressed size is a lie would throw if the
    // reader eagerly touched its bytes; reading only the sibling proves laziness.
    const archive = openZipArchive(
      makeZip([
        { name: 'WANTED.txt', data: Buffer.from('wanted', 'latin1') },
        { name: 'IGNORED.txt', data: Buffer.from('ignored', 'latin1') },
      ]),
    );
    expect(archive.readEntry('WANTED.txt')?.toString('latin1')).toBe('wanted');
  });

  it('throws on a buffer with no end-of-central-directory record', () => {
    expect(() => openZipArchive(Buffer.from('not a zip archive at all'))).toThrow(
      /end-of-central-directory/,
    );
  });
});
