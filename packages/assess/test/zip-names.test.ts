/**
 * The names of files inside a zip.
 *
 * A .docx is untrusted input, and the Word importer is about to extract media from
 * it. A name such as `../../x` in a zip is a classic way to write a file outside
 * the folder it was meant for ("zip slip"), so a name is checked once, here, for
 * every reader and every writer.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { safeEntryName, unzipSync, zipSync } from "../src/container/zip.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

/** A zip whose entry names are rewritten after the fact, to make names zipSync would refuse. */
function withNames(names: string[], rewritten: string[]): Uint8Array {
  assert.ok(names.every((n, i) => n.length === (rewritten[i] as string).length), "names must keep their length");
  // The payload must not contain the name, or rewriting the name would corrupt it too.
  const buffer = Buffer.from(zipSync(names.map((name, i) => ({ name, data: bytes(`payload ${i}`), store: true }))));
  names.forEach((name, i) => {
    let at = buffer.indexOf(name);
    while (at !== -1) {
      buffer.write(rewritten[i] as string, at, "utf8");
      at = buffer.indexOf(name, at + 1);
    }
  });
  return new Uint8Array(buffer);
}

describe("safeEntryName", () => {
  test("leaves ordinary names alone", () => {
    for (const name of ["a.json", "questions/q_01.json", "word/document.xml", "[Content_Types].xml", "media/image 1.png"]) {
      assert.equal(safeEntryName(name), name);
    }
  });

  test("tidies backslashes and a leading or doubled dot-slash", () => {
    assert.equal(safeEntryName("word\\document.xml"), "word/document.xml");
    assert.equal(safeEntryName("./word//media/./a.png"), "word/media/a.png");
  });

  test("refuses a name that climbs out of its folder", () => {
    for (const name of ["../x", "a/../../x", "a/..", "..\\..\\x", ".."]) {
      assert.throws(() => safeEntryName(name), /climbs out of its folder/, name);
    }
  });

  test("refuses a name that starts at a root or a drive", () => {
    for (const name of ["/etc/passwd", "\\windows\\x", "C:\\Windows\\x", "c:/x", "D:x"]) {
      assert.throws(() => safeEntryName(name), /starts at a root or a drive/, name);
    }
  });

  test("refuses an empty name, a name that is only dots and slashes, and control characters", () => {
    assert.throws(() => safeEntryName(""), /has no name/);
    assert.throws(() => safeEntryName("./"), /not a file name/);
    assert.throws(() => safeEntryName("."), /not a file name/);
    assert.throws(() => safeEntryName("a\u0000b"), /control characters/);
    assert.throws(() => safeEntryName("a\nb"), /control characters/);
  });
});

describe("writing", () => {
  test("refuses a name the reader would refuse or change", () => {
    for (const name of ["../evil.json", "/abs.json", "a\\b.json", "./a.json", "a//b.json", "C:x.json"]) {
      assert.throws(() => zipSync([{ name, data: bytes("x") }]), /not a plain relative file name|climbs out|starts at a root/, name);
    }
  });

  test("still writes and reads ordinary names back unchanged", () => {
    const zip = zipSync([
      { name: "manifest.json", data: bytes("{}") },
      { name: "questions/q_1.json", data: bytes("{}") },
    ]);
    assert.deepEqual([...unzipSync(zip).keys()], ["manifest.json", "questions/q_1.json"]);
  });
});

describe("reading", () => {
  test("refuses a zip with a name that climbs out of its folder", () => {
    const zip = withNames(["xx/evil.json"], ["../evil.json"]);
    assert.throws(() => unzipSync(zip), /"..\/evil.json" inside this zip climbs out of its folder/);
  });

  test("refuses an absolute name", () => {
    const zip = withNames(["xxxxxxxx.json"], ["/etc/pass.json"].map((n) => n.padEnd(13, "x").slice(0, 13)));
    assert.throws(() => unzipSync(zip), /starts at a root or a drive/);
  });

  test("reads a backslash name as the slash name, which is how some generators write Word files", () => {
    const zip = withNames(["word/document.xml"], ["word\\document.xml"]);
    assert.deepEqual([...unzipSync(zip).keys()], ["word/document.xml"]);
  });

  test("still catches two names that become the same once tidied", () => {
    const zip = withNames(["a/b.xml", "a_b.xml"], ["a/b.xml", "a\\b.xml"]);
    assert.throws(() => unzipSync(zip), /appears twice/);
  });
});

/**
 * Found by reading how the limit is kept: it was kept per entry, from the sizes the file DECLARES. A central directory may list many
 * names for one stretch of compressed data, and each of them may declare 0 bytes, so each was given the whole limit again: a few
 * hundred bytes of zip could ask for the limit once per name.
 */
describe("a zip that lies about its sizes", () => {
  /** One compressed run of zeros listed under `count` different names, every one declaring that it is 0 bytes long. */
  function manyNamesOneStream(count: number, size: number, store = false): Uint8Array {
    const one = Buffer.from(zipSync([{ name: "e0000.bin", data: new Uint8Array(size), store }]));
    const eocd = one.length - 22;
    const centralAt = one.readUInt32LE(eocd + 16);
    const record = one.subarray(centralAt, eocd);
    assert.equal(record.length, 46 + "e0000.bin".length, "one central record, to copy");
    const records: Buffer[] = [];
    for (let i = 0; i < count; i++) {
      const copy = Buffer.from(record);
      copy.writeUInt32LE(0, 24); // the uncompressed size it declares
      copy.write(`e${String(i).padStart(4, "0")}.bin`, 46, "utf8");
      records.push(copy);
    }
    const end = Buffer.from(one.subarray(eocd));
    end.writeUInt16LE(count, 8);
    end.writeUInt16LE(count, 10);
    end.writeUInt32LE(records.length * record.length, 12);
    return new Uint8Array(Buffer.concat([one.subarray(0, centralAt), ...records, end]));
  }

  test("is stopped by what its entries really make, however many names share one stream and whatever each says it is", () => {
    const bomb = manyNamesOneStream(10, 200_000);
    assert.ok(bomb.length < 1500, `ten names for 2 MB of zeros come to ${bomb.length} bytes`);
    // It is stopped while the sixth name is being unpacked (the first five made exactly the limit), and not after that one has been
    // made whole: the room an entry is given is what is left, so the most that is ever held is the limit and not the limit again.
    assert.throws(() => unzipSync(bomb, { maxTotalBytes: 1_000_000 }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^"e0005\.bin" expands to more than/);
      return true;
    });
  });

  test("is stopped when the entries are stored and not compressed, which no inflate limit would catch", () => {
    const stored = manyNamesOneStream(10, 200_000, true);
    assert.ok(stored.length > 200_000 && stored.length < 201_500, "one stored copy and ten central records");
    assert.throws(() => unzipSync(stored, { maxTotalBytes: 1_000_000 }), /This zip expands to more than/);
    assert.equal(unzipSync(stored, { maxTotalBytes: 2_000_000 }).size, 10, "and read when the limit allows what they make");
  });

  test("is read when what its entries really make is within the limit, so an honest total is not turned away", () => {
    const fine = manyNamesOneStream(4, 200_000);
    const files = unzipSync(fine, { maxTotalBytes: 1_000_000 });
    assert.equal(files.size, 4);
    assert.ok([...files.values()].every((data) => data.length === 200_000));
  });

  test("an archive of honest entries that add up to more than the limit is stopped the same way", () => {
    const honest = zipSync(Array.from({ length: 6 }, (_, i) => ({ name: `part${i}.bin`, data: new Uint8Array(200_000) })));
    assert.throws(() => unzipSync(honest, { maxTotalBytes: 1_000_000 }), /expands to more than/);
    assert.equal(unzipSync(honest, { maxTotalBytes: 1_300_000 }).size, 6);
  });
});
