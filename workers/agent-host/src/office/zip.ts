/**
 * Office 文書（docx / xlsx）の入れ物を読み書きする最小の zip。
 *
 * **触っていない部品は、圧縮されたバイト列のまま写す。**中身を解いて詰め直すと、
 * 見た目が同じでも別のファイルになり、何を変えたかが追えなくなる。
 * zip64・暗号化・分割は扱わない（Office が普通に保存したファイルには出てこない）。
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly flags: number;
  readonly time: number;
  readonly date: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly externalAttributes: number;
  readonly versionMadeBy: number;
  /** 圧縮されたままのバイト列。 */
  readonly raw: Buffer;
}

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipFormatError';
  }
}

const MAX_ENTRIES = 5000;
const MAX_UNCOMPRESSED = 200 * 1024 * 1024;

export function readZip(buffer: Buffer): ZipEntry[] {
  const end = findEndOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(end + 10);
  const directorySize = buffer.readUInt32LE(end + 12);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff)
    throw new ZipFormatError('zip64 is not supported');
  if (count > MAX_ENTRIES) throw new ZipFormatError('too many entries');
  if (directoryOffset + directorySize > end) throw new ZipFormatError('bad central directory');

  const entries: ZipEntry[] = [];
  let at = directoryOffset;
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new ZipFormatError('bad central header');
    const versionMadeBy = buffer.readUInt16LE(at + 4);
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const time = buffer.readUInt16LE(at + 12);
    const date = buffer.readUInt16LE(at + 14);
    const crc = buffer.readUInt32LE(at + 16);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const externalAttributes = buffer.readUInt32LE(at + 38);
    const localOffset = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    if (flags & 0x1) throw new ZipFormatError('encrypted entries are not supported');
    if (method !== 0 && method !== 8) throw new ZipFormatError(`unsupported method ${method}`);
    if (name.includes('..') || name.startsWith('/')) throw new ZipFormatError('unsafe entry name');

    if (buffer.readUInt32LE(localOffset) !== 0x04034b50)
      throw new ZipFormatError('bad local header');
    const localName = buffer.readUInt16LE(localOffset + 26);
    const localExtra = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localName + localExtra;
    if (dataStart + compressedSize > buffer.length) throw new ZipFormatError('truncated entry');

    entries.push({
      name,
      method,
      flags,
      time,
      date,
      crc,
      compressedSize,
      size,
      externalAttributes,
      versionMadeBy,
      raw: buffer.subarray(dataStart, dataStart + compressedSize),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  if (entries.reduce((sum, entry) => sum + entry.size, 0) > MAX_UNCOMPRESSED)
    throw new ZipFormatError('too large when uncompressed');
  return entries;
}

export function entryData(entry: ZipEntry): Buffer {
  const data = entry.method === 0 ? entry.raw : inflateRawSync(entry.raw);
  if (data.length !== entry.size || crc32(data) !== entry.crc)
    throw new ZipFormatError(`corrupt entry ${entry.name}`);
  return data;
}

/** 新しい中身を持つ部品。圧縮して crc を付け直す。 */
export function replacedEntry(entry: ZipEntry, data: Buffer): ZipEntry {
  const raw = deflateRawSync(data);
  return {
    ...entry,
    method: 8,
    crc: crc32(data),
    size: data.length,
    compressedSize: raw.length,
    raw,
  };
}

export function writeZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    // 大きさを先頭に書くので、データ記述子（bit 3）は使わない。名前は UTF-8（bit 11）。
    const flags = (entry.flags & ~0x8) | 0x800;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt16LE(entry.time, 10);
    local.writeUInt16LE(entry.date, 12);
    local.writeUInt32LE(entry.crc, 14);
    local.writeUInt32LE(entry.compressedSize, 18);
    local.writeUInt32LE(entry.size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, entry.raw);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.versionMadeBy, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt16LE(entry.time, 12);
    central.writeUInt16LE(entry.date, 14);
    central.writeUInt32LE(entry.crc, 16);
    central.writeUInt32LE(entry.compressedSize, 20);
    central.writeUInt32LE(entry.size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.externalAttributes, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + entry.raw.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const lowest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let at = buffer.length - 22; at >= lowest; at--)
    if (buffer.readUInt32LE(at) === 0x06054b50) return at;
  throw new ZipFormatError('not a zip file');
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
