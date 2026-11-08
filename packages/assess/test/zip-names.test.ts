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
