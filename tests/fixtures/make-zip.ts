/**
 * @fileoverview Build a minimal ZIP archive buffer in-memory for tests — local
 * file headers + central directory + EOCD, DEFLATE or STORED per entry. Matches
 * exactly the narrow shape the production reader (`openZipArchive`) supports: no
 * ZIP64, no encryption, no data descriptors, no spanning. CRCs are written as
 * zero because the reader inflates without verifying them.
 * @module tests/fixtures/make-zip
 */

import { deflateRawSync } from 'node:zlib';

/** One entry to pack. `data` is the uncompressed content. */
export interface ZipInput {
  data: Buffer;
  /** Compression to apply — DEFLATE (default) or STORED (uncompressed). */
  method?: 'deflate' | 'store';
  name: string;
}

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;

/** Pack `entries` into a single ZIP archive buffer. */
export function makeZip(entries: ZipInput[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const method = entry.method ?? 'deflate';
    const compressionMethod = method === 'store' ? 0 : 8;
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const body = method === 'store' ? entry.data : deflateRawSync(entry.data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(compressionMethod, 8);
    local.writeUInt32LE(0, 14); // CRC — unverified by the reader
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);

    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(compressionMethod, 10);
    cd.writeUInt32LE(0, 16); // CRC
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(entry.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42); // local header offset
    nameBuf.copy(cd, 46);
    central.push(cd);

    parts.push(local, body);
    offset += local.length + body.length;
  }

  const centralDir = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16); // central-directory offset

  return Buffer.concat([...parts, centralDir, eocd]);
}
