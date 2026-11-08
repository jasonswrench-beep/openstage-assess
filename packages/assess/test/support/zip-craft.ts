/**
 * Zip files written by hand, with whatever lie a test needs: a size the entry does not have, two names for one stretch of data, a
 * deflated entry with nothing in it. `zipSync` will not write these (it writes what the reader gets back), and the reader has to be
 * tried on what other programs, and people who mean harm, can write. This is not a zip writer for anything else.
 */

import { deflateRawSync } from "node:zlib";

import { crc32 } from "../../src/container/zip.ts";

export interface CraftEntry {
  name: string;
  /** The bytes as stored: compressed for method 8, the data itself for method 0. */
  payload: Buffer;
  method: 0 | 8;
  crc: number;
  /** The uncompressed size the entry SAYS it has. */
  usize: number;
  /** Use the local header of the entry at this index, and write no data of its own (two names for one stretch of data). */
  shareWith?: number;
  /** Write the sizes and the checksum after the data, in a record of their own, as a program that writes to a stream does (flag bit 3). */
  descriptor?: boolean;
}

export function craft(entries: CraftEntry[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  const places: number[] = [];
  let offset = 0;
  entries.forEach((entry, i) => {
    const name = Buffer.from(entry.name, "utf8");
    let at: number;
    if (entry.shareWith !== undefined) at = places[entry.shareWith] as number;
    else {
      at = offset;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(entry.descriptor ? 0x0808 : 0x0800, 6);
      local.writeUInt16LE(entry.method, 8);
      // With a descriptor the local header says nothing of the checksum or the sizes: they come after the data.
      if (!entry.descriptor) {
        local.writeUInt32LE(entry.crc >>> 0, 14);
        local.writeUInt32LE(entry.payload.length, 18);
        local.writeUInt32LE(entry.usize, 22);
      }
      local.writeUInt16LE(name.length, 26);
      const after = Buffer.alloc(entry.descriptor ? 16 : 0);
      if (entry.descriptor) {
        after.writeUInt32LE(0x08074b50, 0);
        after.writeUInt32LE(entry.crc >>> 0, 4);
        after.writeUInt32LE(entry.payload.length, 8);
        after.writeUInt32LE(entry.usize, 12);
      }
      const whole = Buffer.concat([local, name, entry.payload, after]);
      locals.push(whole);
      offset += whole.length;
    }
    places.push(at);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.descriptor ? 0x0808 : 0x0800, 8);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt32LE(entry.crc >>> 0, 16);
    central.writeUInt32LE(entry.payload.length, 20);
    central.writeUInt32LE(entry.usize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(at, 42);
    centrals.push(central, name);
    void i;
  });
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

/**
 * Several names for one stretch of data, each with a local header of its own. The headers are packed one after the other, 30 bytes
 * apart, with no name in them, and each says by its extra-length field that its data begins where the last one's ends, so that every
 * header is a different place and all of them lead to the same bytes. (A table of places that are all the same is the other shape,
 * `shareWith`; a check on where the headers are does not see this one.) At most about 4,300 names fit, for the length of an extra field.
 */
export function craftOverlapping(names: string[], payload: Buffer, method: 0 | 8 = 8, crc = 0, usize = 0): Uint8Array {
  const HEADER = 30;
  const dataAt = names.length * HEADER;
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  names.forEach((entryName, i) => {
    const gap = dataAt - (i * HEADER + HEADER); // what must lie between the end of this header and the data
    const nameField = Math.min(gap, 0xffff);
    const local = Buffer.alloc(HEADER);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(usize, 22);
    local.writeUInt16LE(nameField, 26);
    local.writeUInt16LE(gap - nameField, 28);
    locals.push(local);
    const name = Buffer.from(entryName, "utf8");
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(usize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(i * HEADER, 42);
    centrals.push(central, name);
  });
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(dataAt + payload.length, 16);
  return new Uint8Array(Buffer.concat([...locals, payload, directory, end]));
}

/** A raw deflate stream of `blocks` empty stored blocks and then a final empty one: a million of them make 5 MB and nothing. */
export function emptyBlocks(blocks: number): Buffer {
  return Buffer.concat([...Array.from({ length: blocks }, () => Buffer.from([0x00, 0x00, 0x00, 0xff, 0xff])), Buffer.from([0x03, 0x00])]);
}

/** An entry whose data is compressed, with the size it declares (by default the true one). */
export function deflated(name: string, data: Uint8Array, declared?: number): CraftEntry {
  const raw = Buffer.from(data);
  return { name, payload: deflateRawSync(raw), method: 8, crc: crc32(raw), usize: declared ?? raw.length };
}

/** An entry whose data is stored as it is, with the size it declares (by default the true one). */
export function stored(name: string, data: Uint8Array, declared?: number): CraftEntry {
  const raw = Buffer.from(data);
  return { name, payload: raw, method: 0, crc: crc32(raw), usize: declared ?? raw.length };
}
