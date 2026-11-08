/**
 * How much a zip may make, and how much work it may ask for.
 *
 * Found by readers of the zip reader: the limit was kept on the sizes an entry DECLARES, so entries that declared 0 were each given the
 * whole limit again; a first fix kept it on what the entries make, and a second reader showed that many names for one stretch of data
 * cost a great deal of work while making nothing, and that an empty entry after the one that reached the limit exactly was refused in
 * words for too much. The archives here are written by hand (`support/zip-craft.ts`), because `zipSync` writes only what the reader
 * accepts.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { crc32, unzipSync, zipSync } from "../src/container/zip.ts";
import { craft, craftOverlapping, deflated, emptyBlocks, stored } from "./support/zip-craft.ts";

const zeros = (n: number): Uint8Array => new Uint8Array(n);
const named = (i: number): string => `e${String(i).padStart(4, "0")}.bin`;

describe("a zip that lies about the size of its entries", () => {
  test("is stopped by what the entries really make, while the sixth is being unpacked and not after it has been made whole", () => {
    // Ten entries of 200 KB, each saying it is 0 bytes long, against a limit of 1 MB: the first five make exactly the limit.
    const bomb = craft(Array.from({ length: 10 }, (_, i) => deflated(named(i), zeros(200_000), 0)));
    assert.ok(bomb.length < 4000, `ten times 200 KB of zeros come to ${bomb.length} bytes`);
    assert.throws(() => unzipSync(bomb, { maxTotalBytes: 1_000_000 }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^"e0005\.bin" expands to more than/, "the entry that goes past the limit is the one that is stopped");
      return true;
    });
  });

  test("is stopped when the entries are stored and not compressed, which no inflate limit would catch", () => {
    const lying = craft(Array.from({ length: 10 }, (_, i) => stored(named(i), zeros(200_000), 0)));
    assert.throws(() => unzipSync(lying, { maxTotalBytes: 1_000_000 }), /This zip expands to more than/);
    assert.equal(unzipSync(lying, { maxTotalBytes: 2_000_000 }).size, 10, "and read when the limit allows what they make");
  });

  test("is read when what its entries really make is within the limit, so an honest total is not turned away", () => {
    const fine = craft(Array.from({ length: 4 }, (_, i) => deflated(named(i), zeros(200_000), 0)));
    const files = unzipSync(fine, { maxTotalBytes: 1_000_000 });
    assert.equal(files.size, 4);
    assert.ok([...files.values()].every((data) => data.length === 200_000));
  });

  test("an archive of honest entries that add up to more than the limit is stopped the same way", () => {
    const honest = zipSync(Array.from({ length: 6 }, (_, i) => ({ name: `part${i}.bin`, data: zeros(200_000) })));
    assert.throws(() => unzipSync(honest, { maxTotalBytes: 1_000_000 }), /expands to more than/);
    assert.equal(unzipSync(honest, { maxTotalBytes: 1_300_000 }).size, 6);
  });
});

describe("a zip with two names for one stretch of data", () => {
  test("is refused in words, for compressed and for stored entries, and not read name by name", () => {
    for (const first of [deflated("a.bin", zeros(1000)), stored("a.bin", zeros(1000))]) {
      const shared = craft([first, { ...first, name: "b.bin", shareWith: 0 }]);
      assert.throws(() => unzipSync(shared), /"b\.bin" is stored in the same place as another file of this zip/);
    }
  });

  // 10,000 names over one 1 MB stream that inflates to nothing took 20 seconds and made nothing, so the limit never grew.
  test("with ten thousand names over a stream that makes nothing is refused at once", () => {
    // Empty stored blocks: 00 00 00 ff ff, repeated, then a final empty block.
    const blocks = Buffer.concat([...Array.from({ length: 200_000 }, () => Buffer.from([0x00, 0x00, 0x00, 0xff, 0xff])), Buffer.from([0x03, 0x00])]);
    const first = { name: named(0), payload: blocks, method: 8 as const, crc: 0, usize: 0 };
    const entries = [first, ...Array.from({ length: 9_999 }, (_, i) => ({ ...first, name: named(i + 1), shareWith: 0 }))];
    const bomb = craft(entries);
    assert.ok(bomb.length > 1_000_000 && bomb.length < 1_600_000, `a zip of ${bomb.length} bytes`);
    const started = Date.now();
    assert.throws(() => unzipSync(bomb), /is stored in the same place as another file/);
    assert.ok(Date.now() - started < 5000, `it took ${Date.now() - started} ms`);
  });
});

describe("the end of the limit", () => {
  test("an empty entry that follows the entry that reached the limit exactly is read, and one byte more is not", () => {
    const empty = { name: "b.bin", payload: Buffer.from([0x03, 0x00]), method: 8 as const, crc: 0, usize: 0 };
    const exactly = craft([deflated("a.bin", zeros(100_000)), empty]);
    const files = unzipSync(exactly, { maxTotalBytes: 100_000 });
    assert.equal(files.get("a.bin")?.length, 100_000);
    assert.equal(files.get("b.bin")?.length, 0, "an entry with nothing in it is not turned away for holding too much");
    const past = craft([deflated("a.bin", zeros(100_000)), deflated("b.bin", new Uint8Array([7]))]);
    assert.throws(() => unzipSync(past, { maxTotalBytes: 100_000 }), /expands to more than/, "and a byte past the limit still is");
  });
});

describe("a zip with several names for one stretch of data, each name with a local header of its own", () => {
  // The check for two names with one local header looked at where the headers are. A header says by its own name length and extra length
  // where its data begins, so 4,000 headers 30 bytes apart, each padded to end at the same byte, were 4,000 different places and one
  // stream of a million empty blocks: 17 seconds from a 5 MB zip, and nothing made, so that what is made, which the limit is on, never grew.
  test("with 4,000 names over a stream that makes nothing is refused at once, in words", () => {
    const names = Array.from({ length: 4_000 }, (_, i) => named(i));
    const bomb = craftOverlapping(names, emptyBlocks(200_000));
    assert.ok(bomb.length > 1_000_000 && bomb.length < 1_400_000, `a zip of ${bomb.length} bytes`);
    const started = Date.now();
    assert.throws(() => unzipSync(bomb), /The entries of this zip claim more compressed data than the file holds, so they overlap and it is damaged\./);
    assert.ok(Date.now() - started < 3000, `it took ${Date.now() - started} ms`);
  });

  test("with a few names is refused as well: it is the sizes they claim that give them away, however few they are", () => {
    const bomb = craftOverlapping(["a.bin", "b.bin", "c.bin"], emptyBlocks(1000));
    assert.throws(() => unzipSync(bomb), /claim more compressed data than the file holds/);
  });

  // Two names of one letter each: the zip is the data and 176 bytes of headers, names and the end record. The two claim the data twice.
  // At 176 bytes of data they claim exactly what the file holds, and at 177 one byte more.
  test("is refused when what the entries claim is one byte more than the file holds, and not when it is exactly what it holds", () => {
    const overlapping = (stored: number): Uint8Array => {
      const data = Buffer.alloc(stored, 7);
      const payload = Buffer.concat([Buffer.from([0x00, stored & 255, stored >> 8, ~stored & 255, (~stored >> 8) & 255]), data, Buffer.from([0x03, 0x00])]);
      return craftOverlapping(["a", "b"], payload, 8, crc32(data), stored);
    };
    const exactly = overlapping(169);
    assert.equal(exactly.length, 352);
    assert.equal(unzipSync(exactly).size, 2, "claiming exactly what the file holds is not claiming more");
    const over = overlapping(170);
    assert.equal(over.length, 353);
    assert.throws(() => unzipSync(over), /claim more compressed data than the file holds/);
  });
});

describe("a zip that is honest is read", () => {
  /** Bytes that do not compress, the same each time. */
  const noise = (n: number, seed: number): Uint8Array => {
    const out = new Uint8Array(n);
    let a = seed;
    for (let i = 0; i < n; i++) {
      a = (Math.imul(a, 1103515245) + 12345) >>> 0;
      out[i] = a >>> 24;
    }
    return out;
  };

  test("when its entries are stored, so that what they claim is nearly the whole file", () => {
    const entries = [noise(100_000, 1), noise(50_000, 2), noise(70_000, 3)];
    const files = unzipSync(craft(entries.map((data, i) => stored(`part${i}.bin`, data))));
    assert.equal(files.size, 3);
    entries.forEach((data, i) => assert.deepEqual(files.get(`part${i}.bin`), data));
  });

  test("when its entries have their sizes in a record after the data, and when some are empty and some are not", () => {
    const text = new TextEncoder().encode("hello hello hello hello");
    const files = unzipSync(
      craft([
        { ...deflated("a.txt", text), descriptor: true },
        { ...stored("b.txt", text), descriptor: true },
        deflated("empty-deflated.txt", new Uint8Array(0)),
        stored("empty-stored.txt", new Uint8Array(0)),
        deflated("c.txt", noise(5_000, 4)),
      ]),
    );
    assert.deepEqual([...files.keys()], ["a.txt", "b.txt", "empty-deflated.txt", "empty-stored.txt", "c.txt"]);
    assert.deepEqual(files.get("a.txt"), text);
    assert.deepEqual(files.get("b.txt"), text);
    assert.equal(files.get("empty-deflated.txt")?.length, 0);
    assert.equal(files.get("empty-stored.txt")?.length, 0);
    assert.deepEqual(files.get("c.txt"), noise(5_000, 4));
  });

  test("when it has thousands of entries", () => {
    const entries = Array.from({ length: 3_000 }, (_, i) => ({ name: `folder/file${i}.txt`, data: new TextEncoder().encode(`file ${i}`) }));
    const files = unzipSync(zipSync(entries));
    assert.equal(files.size, 3_000);
    assert.equal(new TextDecoder().decode(files.get("folder/file2999.txt")), "file 2999");
  });

  test("when a directory entry stands in it, which holds nothing and is not counted", () => {
    const files = unzipSync(craft([stored("folder/", new Uint8Array(0)), stored("folder/a.txt", new TextEncoder().encode("a"))]));
    assert.deepEqual([...files.keys()], ["folder/a.txt"]);
  });

  // Written by Word and Excel and by the test writers of the other tools, which each choose their own way to lay a zip out.
  test("when it is any of the files of the fixtures: documents, workbooks and packages", () => {
    const root = fileURLToPath(new URL("../../../fixtures", import.meta.url));
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(docx|xlsx|zip|imscc|openassess)$/i.test(name)) found.push(path);
      }
    };
    walk(root);
    assert.ok(found.length >= 1, "there is at least one zip among the fixtures");
    for (const path of found) {
      const files = unzipSync(new Uint8Array(readFileSync(path)));
      assert.ok(files.size >= 1, `${path} has entries`);
    }
  });
});
