/**
 * @fileoverview Minimal, dependency-free ZIP reader for the FAA Releasable
 * Aircraft Database archive. Reads the End-Of-Central-Directory record, walks the
 * central directory, and inflates each entry (stored or DEFLATE) with `node:zlib`.
 *
 * Scope is deliberately narrow — the FAA archive is a trusted, single-source ZIP
 * of plain `.txt` files with no encryption, no ZIP64, and no spanning. This is
 * not a general-purpose ZIP library; it covers exactly that shape so the ingester
 * needs neither an npm dependency nor a system `unzip` binary on the slim image.
 * @module services/registry/zip
 */

import { inflateRawSync } from 'node:zlib';

/** One extracted ZIP entry. */
export interface ZipEntry {
  /** Decompressed bytes. */
  data: Buffer;
  /** Entry path as stored in the archive (e.g. `MASTER-1.txt`). */
  name: string;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const COMPRESSION_STORED = 0;
const COMPRESSION_DEFLATE = 8;

/**
 * Locate the End-Of-Central-Directory record by scanning backwards from the end
 * of the buffer (the EOCD is within the last 64 KiB + comment). Returns the
 * central-directory offset and entry count.
 */
function findEndOfCentralDirectory(buf: Buffer): { offset: number; count: number } {
  const minEocdSize = 22;
  const maxScan = Math.min(buf.length, minEocdSize + 0xffff);
  for (let i = buf.length - minEocdSize; i >= buf.length - maxScan && i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) {
      const count = buf.readUInt16LE(i + 10);
      const offset = buf.readUInt32LE(i + 16);
      return { offset, count };
    }
  }
  throw new Error(
    'ZIP end-of-central-directory record not found — archive is corrupt or not a ZIP.',
  );
}

/**
 * Parse a ZIP archive buffer and return every entry, decompressed. Entries are
 * inflated eagerly; for the FAA archive (~13 text files) this is simpler and
 * fast enough, and the caller streams rows out of each entry afterward.
 */
export function readZipEntries(buf: Buffer): ZipEntry[] {
  const { offset, count } = findEndOfCentralDirectory(buf);
  const entries: ZipEntry[] = [];
  let cursor = offset;

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(cursor) !== CENTRAL_FILE_SIGNATURE) {
      throw new Error(`ZIP central-directory entry ${i} has an invalid signature.`);
    }
    const compressionMethod = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const fileNameLength = buf.readUInt16LE(cursor + 28);
    const extraFieldLength = buf.readUInt16LE(cursor + 30);
    const commentLength = buf.readUInt16LE(cursor + 32);
    const localHeaderOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.toString('utf8', cursor + 46, cursor + 46 + fileNameLength);

    // Resolve the local header to find where the compressed data actually starts
    // (the local header's own name/extra lengths can differ from the central one).
    if (buf.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_SIGNATURE) {
      throw new Error(`ZIP local file header for "${name}" has an invalid signature.`);
    }
    const localNameLength = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = buf.subarray(dataStart, dataStart + compressedSize);

    let data: Buffer;
    if (compressionMethod === COMPRESSION_STORED) {
      data = Buffer.from(compressed);
    } else if (compressionMethod === COMPRESSION_DEFLATE) {
      data = inflateRawSync(compressed);
    } else {
      throw new Error(
        `ZIP entry "${name}" uses unsupported compression method ${compressionMethod}.`,
      );
    }

    entries.push({ name, data });
    cursor += 46 + fileNameLength + extraFieldLength + commentLength;
  }

  return entries;
}
