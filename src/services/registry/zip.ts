/**
 * @fileoverview Minimal, dependency-free ZIP reader for the FAA Releasable
 * Aircraft Database archive. Reads the End-Of-Central-Directory record and walks
 * the central directory up front (metadata only), then inflates a single entry
 * on demand (stored or DEFLATE) with `node:zlib`.
 *
 * Inflation is deferred deliberately: the archive holds ~500 MB of decompressed
 * text across its files, so decompressing everything eagerly makes peak memory
 * scale with the *sum* of all files. Reading one entry at a time — and dropping
 * each buffer once the caller has consumed it — makes peak scale with the
 * *largest single* file instead, which is what keeps the rebuild inside a bounded
 * memory budget as the dataset grows.
 *
 * Scope is deliberately narrow — the FAA archive is a trusted, single-source ZIP
 * of plain `.txt` files with no encryption, no ZIP64, and no spanning. This is
 * not a general-purpose ZIP library; it covers exactly that shape so the ingester
 * needs neither an npm dependency nor a system `unzip` binary on the slim image.
 * @module services/registry/zip
 */

import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const COMPRESSION_STORED = 0;
const COMPRESSION_DEFLATE = 8;
/** `node:zlib`'s default output chunk size — below this an entry never doubles. */
const DEFAULT_INFLATE_CHUNK = 16 * 1024;

/** A parsed central-directory record — enough to inflate the entry on demand. */
interface CentralEntry {
  compressedSize: number;
  compressionMethod: number;
  localHeaderOffset: number;
  name: string;
  uncompressedSize: number;
}

/**
 * A ZIP archive opened for on-demand reading. The central directory is parsed
 * once; each entry is inflated only when {@link ZipArchive.readEntry} is called,
 * so at most one decompressed entry is resident at a time.
 */
export interface ZipArchive {
  /** Stored entry names, in central-directory order (diagnostics/tests). */
  readonly entryNames: readonly string[];
  /**
   * Inflate the entry whose base name case-insensitively equals `baseName` and
   * return its decompressed bytes, or `undefined` if no such entry exists. Each
   * call inflates fresh and holds no reference to the result, so the returned
   * buffer is freed as soon as the caller drops it.
   */
  readEntry(baseName: string): Buffer | undefined;
}

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

/** Inflate one central-directory entry from its local header. */
function inflateEntry(buf: Buffer, entry: CentralEntry): Buffer {
  // The local header's own name/extra lengths can differ from the central one,
  // so resolve them here to find where the compressed data actually starts.
  if (buf.readUInt32LE(entry.localHeaderOffset) !== LOCAL_FILE_SIGNATURE) {
    throw new Error(`ZIP local file header for "${entry.name}" has an invalid signature.`);
  }
  const localNameLength = buf.readUInt16LE(entry.localHeaderOffset + 26);
  const localExtraLength = buf.readUInt16LE(entry.localHeaderOffset + 28);
  const dataStart = entry.localHeaderOffset + 30 + localNameLength + localExtraLength;
  const compressed = buf.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.compressionMethod === COMPRESSION_STORED) return Buffer.from(compressed);
  if (entry.compressionMethod === COMPRESSION_DEFLATE) {
    // Size zlib's output chunk to the known uncompressed length for large entries
    // so it inflates in a single allocation. Its default chunked growth holds the
    // old and new buffers across each doubling — transiently ~2× the final size
    // for a big entry, the single biggest RSS spike in the rebuild. Entries that
    // fit the default chunk never double, so leave them on the default path.
    const presize = entry.uncompressedSize > DEFAULT_INFLATE_CHUNK;
    return inflateRawSync(compressed, presize ? { chunkSize: entry.uncompressedSize } : undefined);
  }
  throw new Error(
    `ZIP entry "${entry.name}" uses unsupported compression method ${entry.compressionMethod}.`,
  );
}

/**
 * Parse a ZIP archive buffer's central directory and return a handle that
 * inflates entries lazily. The buffer is retained (compressed — a fraction of
 * the decompressed size) for the archive's lifetime; individual entries are
 * decompressed only when read.
 */
export function openZipArchive(buf: Buffer): ZipArchive {
  const { offset, count } = findEndOfCentralDirectory(buf);
  const directory: CentralEntry[] = [];
  let cursor = offset;

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(cursor) !== CENTRAL_FILE_SIGNATURE) {
      throw new Error(`ZIP central-directory entry ${i} has an invalid signature.`);
    }
    const compressionMethod = buf.readUInt16LE(cursor + 10);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const uncompressedSize = buf.readUInt32LE(cursor + 24);
    const fileNameLength = buf.readUInt16LE(cursor + 28);
    const extraFieldLength = buf.readUInt16LE(cursor + 30);
    const commentLength = buf.readUInt16LE(cursor + 32);
    const localHeaderOffset = buf.readUInt32LE(cursor + 42);
    const name = buf.toString('utf8', cursor + 46, cursor + 46 + fileNameLength);

    directory.push({
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    cursor += 46 + fileNameLength + extraFieldLength + commentLength;
  }

  return {
    entryNames: directory.map((e) => e.name),
    readEntry(baseName: string): Buffer | undefined {
      const target = baseName.toLowerCase();
      const entry = directory.find(
        (e) => (e.name.split('/').pop()?.toLowerCase() ?? '') === target,
      );
      return entry ? inflateEntry(buf, entry) : undefined;
    },
  };
}
