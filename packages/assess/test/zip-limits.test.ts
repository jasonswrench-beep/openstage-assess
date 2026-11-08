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

import { unzipSync, zipSync } from "../src/container/zip.ts";
import { craft, deflated, stored } from "./support/zip-craft.ts";

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
