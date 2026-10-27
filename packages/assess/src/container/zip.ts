/**
 * A minimal ZIP reader and writer built on node:zlib.
 *
 * A bank is a zip, and so is a .docx and so is a QTI package, so this one file
 * serves the container, the Word importer and the QTI exporters. It is
 * deliberately small: store and deflate only, no encryption, no zip64, no
 * streaming. A bank is a few megabytes, which is well inside those limits, and
 * the limits are enforced with a readable error rather than a corrupt file.
 *
 * Reading goes through the central directory rather than walking local
 * headers, because entries written with a data descriptor (bit 3 of the flags)
 * carry zero sizes in the local header. Word writes those.
 */

import { deflateRawSync, inflateRawSync } from "node:zlib";

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50;

const MAX_ENTRIES = 0xffff;
const MAX_SIZE = 0xffffffff;

export interface ZipEntry {
  name: string;
  data: Uint8Array;
  /** Skip compression. Right for already-compressed media such as png or jpg. */
  store?: boolean;
  /** Modification time; defaults to now. */
  date?: Date;
}

// ---------------------------------------------------------------------------
// CRC32
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** A byte count a person can read, for the messages the reader gives. */
function describeLimit(bytes: number): string {
  if (bytes >= 1048576) return `${Math.round(bytes / 1048576)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = (CRC_TABLE[(c ^ (data[i] as number)) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// MS-DOS date and time
// ---------------------------------------------------------------------------

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export function zipSync(entries: readonly ZipEntry[]): Uint8Array {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(
      `A zip here may hold at most ${MAX_ENTRIES} files and this one has ${entries.length}. ` +
        `If a bank ever needs more, the container needs zip64 support.`,
    );
  }

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const raw = Buffer.from(entry.data);
    const compressed = entry.store ? raw : deflateRawSync(raw, { level: 6 });
    // Deflate can grow incompressible input; store it instead.
    const useStore = entry.store || compressed.length >= raw.length;
    const payload = useStore ? raw : compressed;
    const method = useStore ? 0 : 8;

    if (raw.length > MAX_SIZE || payload.length > MAX_SIZE) {
      throw new Error(`"${entry.name}" is larger than this container supports (4 GB).`);
    }

    const sum = crc32(raw);
    const { time, date } = dosDateTime(entry.date ?? new Date());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    localParts.push(local, nameBytes, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);

    centralParts.push(central, nameBytes);
    offset += local.length + nameBytes.length + payload.length;
  }

  const centralBuffer = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return new Uint8Array(Buffer.concat([...localParts, centralBuffer, eocd]));
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

function findEocd(buf: Buffer): number {
  const minimum = 22;
  const start = Math.max(0, buf.length - (minimum + 0xffff));
  for (let i = buf.length - minimum; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

export interface UnzipOptions {
  /** Guards against a zip bomb when reading files the user did not author. */
  maxTotalBytes?: number;
}

export function unzipSync(input: Uint8Array, opts: UnzipOptions = {}): Map<string, Uint8Array> {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const eocdAt = findEocd(buf);
  if (eocdAt === -1) {
    throw new Error("This file is not a zip: no end-of-central-directory record was found.");
  }

  if (eocdAt >= 20 && buf.readUInt32LE(eocdAt - 20) === ZIP64_EOCD_LOCATOR_SIG) {
    throw new Error("This zip uses the zip64 extension, which this container does not read.");
  }

  const entryCount = buf.readUInt16LE(eocdAt + 10);
  let p = buf.readUInt32LE(eocdAt + 16);
  const limit = opts.maxTotalBytes ?? 512 * 1024 * 1024;
  let total = 0;

  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < entryCount; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) {
      throw new Error(`The zip central directory is damaged at entry ${i + 1}.`);
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLength);
    p += 46 + nameLength + extraLength + commentLength;

    if (flags & 0x0001) throw new Error(`"${name}" is encrypted, which this container does not read.`);
    if (name.endsWith("/")) continue; // directory entry

    // The offset comes out of the file, so it is checked before it is used as
    // one. Unguarded it produced a raw Buffer RangeError instead of any of the
    // readable messages this reader is careful to give everywhere else.
    if (localOffset < 0 || localOffset + 30 > buf.length) {
      throw new Error(`The entry "${name}" points outside the file, so it is damaged.`);
    }
    if (buf.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new Error(`The local header for "${name}" is damaged.`);
    }
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const dataAt = localOffset + 30 + localNameLength + localExtraLength;

    // subarray clamps rather than failing, so an overstated size silently
    // returned the payload with whatever followed it appended as content.
    if (dataAt + compressedSize > buf.length) {
      throw new Error(`The entry "${name}" claims more data than the file holds, so it is damaged.`);
    }
    const payload = buf.subarray(dataAt, dataAt + compressedSize);

    total += uncompressedSize;
    if (total > limit) {
      throw new Error(`This zip expands to more than ${describeLimit(limit)}, so it was not read.`);
    }

    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(payload);
    } else if (method === 8) {
      // maxOutputLength is the guard that actually holds. The running total
      // above trusts sizes declared by the file, so an entry that lies about
      // its uncompressed size walked straight past it: a 204 KB entry
      // declaring 10 bytes inflated to 200 MB against a 1 KB limit.
      const room = Math.max(0, limit - (total - uncompressedSize));
      try {
        data = inflateRawSync(payload, { maxOutputLength: room });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/maxOutputLength|buffer|size/i.test(message)) {
          throw new Error(
            `"${name}" expands to more than the ${describeLimit(limit)} this container reads, so it was not read.`,
          );
        }
        throw new Error(`"${name}" is compressed in a way this container could not read: ${message}`);
      }
    } else {
      throw new Error(`"${name}" uses compression method ${method}, which this container does not read.`);
    }

    // The checksum is written on every entry and was never looked at, so a
    // flipped byte came back as content with no error at all. Checking it is
    // the whole reason it is there.
    if (crc !== 0 && crc32(data) !== crc) {
      throw new Error(`"${name}" did not survive storage intact; the file is damaged.`);
    }

    if (out.has(name)) {
      throw new Error(`"${name}" appears twice in this file, so which copy is real cannot be known.`);
    }
    out.set(name, new Uint8Array(data));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Small helpers used throughout the engine
// ---------------------------------------------------------------------------

export function textEntry(name: string, text: string): ZipEntry {
  return { name, data: new Uint8Array(Buffer.from(text, "utf8")) };
}

export function jsonEntry(name: string, value: unknown): ZipEntry {
  return textEntry(name, JSON.stringify(value, null, 2) + "\n");
}

export function readText(files: Map<string, Uint8Array>, name: string): string | undefined {
  const bytes = files.get(name);
  return bytes ? Buffer.from(bytes).toString("utf8") : undefined;
}

export function readJson<T>(files: Map<string, Uint8Array>, name: string): T | undefined {
  const text = readText(files, name);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`"${name}" inside this file is not valid JSON: ${(err as Error).message}`);
  }
}
