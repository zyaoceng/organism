/**
 * A minimal ZIP reader for xlsx files: walks the central directory and keeps each entry's packed
 * bytes, so a later rewrite can copy untouched entries as they are. Stored and deflated entries
 * only; no ZIP64 and no encryption (a password-protected xlsx is not a ZIP at all).
 */
import zlib from 'node:zlib';
import { crc32 } from '../vault/zip';

export type XlsxErrorCode = 'not-zip' | 'unsupported-zip' | 'corrupt' | 'missing-part' | 'bad-xml' | 'too-large';

/**
 * The largest part that is unpacked. A part is parsed into memory at many times its size, and a few
 * kilobytes of ZIP can claim gigabytes; a hand-made model's largest sheet is well under 1 MB.
 */
export const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

export class XlsxError extends Error {
  constructor(
    public readonly code: XlsxErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'XlsxError';
  }
}

export interface ZipEntry {
  name: string;
  /** 0 stored, 8 deflated. */
  method: number;
  flags: number;
  crc: number;
  dosTime: number;
  dosDate: number;
  size: number;
  /** The entry's bytes as they sit in the file. */
  packed: Buffer;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
// the first bytes of an OLE compound file: an encrypted xlsx or an old .xls
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);

export function readZip(buf: Buffer): ZipEntry[] {
  if (buf.length >= 4 && buf.subarray(0, 4).equals(OLE_MAGIC)) {
    throw new XlsxError('not-zip', 'The file is password-protected or in the old .xls format');
  }
  // the end record is the last 22 bytes plus a comment of up to 65535
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new XlsxError('not-zip', 'The file is not a ZIP archive');
  const count = buf.readUInt16LE(end + 10);
  const dirSize = buf.readUInt32LE(end + 12);
  const dirOffset = buf.readUInt32LE(end + 16);
  if (count === 0xffff || dirOffset === 0xffffffff) throw new XlsxError('unsupported-zip', 'ZIP64 archives are not supported');
  if (dirOffset + dirSize > end) throw new XlsxError('corrupt', 'The ZIP directory lies outside the file');

  const entries: ZipEntry[] = [];
  let p = dirOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL) throw new XlsxError('corrupt', 'The ZIP directory is damaged');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const packedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (flags & 1) throw new XlsxError('unsupported-zip', `Entry ${name} is encrypted`);
    if (method !== 0 && method !== 8) throw new XlsxError('unsupported-zip', `Entry ${name} uses compression method ${method}`);
    if (packedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new XlsxError('unsupported-zip', 'ZIP64 archives are not supported');
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL) throw new XlsxError('corrupt', `Entry ${name} has no local header`);
    // sizes come from the directory: the local header leaves them 0 when a data descriptor follows
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (dataStart + packedSize > buf.length) throw new XlsxError('corrupt', `Entry ${name} is cut short`);
    entries.push({
      name,
      method,
      flags,
      crc: buf.readUInt32LE(p + 16),
      dosTime: buf.readUInt16LE(p + 12),
      dosDate: buf.readUInt16LE(p + 14),
      size,
      packed: buf.subarray(dataStart, dataStart + packedSize),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** The entry's contents, checked against its CRC. */
export function entryData(entry: ZipEntry): Buffer {
  if (entry.size > MAX_ENTRY_BYTES) throw new XlsxError('too-large', `Entry ${entry.name} is larger than ${MAX_ENTRY_BYTES / 1024 / 1024} MB unpacked`);
  let data: Buffer;
  try {
    // never unpack past the size the directory states, whatever the packed bytes expand to
    data = entry.method === 0 ? entry.packed : zlib.inflateRawSync(entry.packed, { maxOutputLength: Math.max(1, entry.size) });
  } catch {
    throw new XlsxError('corrupt', `Entry ${entry.name} cannot be unpacked`);
  }
  if (data.length !== entry.size || crc32(data) !== entry.crc) throw new XlsxError('corrupt', `Entry ${entry.name} fails its checksum`);
  return data;
}
