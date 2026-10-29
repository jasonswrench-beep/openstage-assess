/**
 * Opening a .docx.
 *
 * The package reader is the first thing to see a file the user did not write, so
 * most of this is about the wrong kind of file, the damaged one and the hostile
 * one. Each must end in a message that says what is wrong and, where there is
 * one, what to do about it. None may hang, crash, or return a half-read document.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { textEntry, zipSync, type ZipEntry } from "../src/container/zip.ts";
import { DocxError, openDocx } from "../src/import/docx/package.ts";
import { docx, paragraph, run } from "./support/docx-writer.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const BODY = `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body><w:p><w:r><w:t>hello</w:t></w:r></w:p></w:body></w:document>`;
const RELS = (target: string) =>
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/></Relationships>`;

function package_(entries: ZipEntry[]): Uint8Array {
  return zipSync(entries);
}

const opensAs = (input: Uint8Array) => openDocx(input).mainDocument;

describe("a good file", () => {
  test("finds the document body and reads parts as XML", () => {
    const pkg = openDocx(docx({ body: paragraph(run("hello")) }));
    assert.equal(pkg.mainDocument, "word/document.xml");
    assert.ok(pkg.names.includes("[Content_Types].xml"));
    assert.equal(pkg.xml("word/document.xml")?.name, "w:document");
    assert.equal(pkg.xml("word/nothing.xml"), undefined);
    assert.equal(pkg.has("word/document.xml"), true);
  });

  test("part names are found whatever their case, as the format says", () => {
    const pkg = openDocx(docx({ body: paragraph() }));
    assert.equal(pkg.has("WORD/Document.XML"), true);
    assert.ok(pkg.bytes("Word/DOCUMENT.xml"));
  });

  test("follows the package's own pointer to the body, wherever it is", () => {
    const input = package_([textEntry("_rels/.rels", RELS("word/main.xml")), textEntry("word/main.xml", BODY)]);
    assert.equal(opensAs(input), "word/main.xml");
  });

  test("a pointer that starts with a slash is read from the root of the package", () => {
    const input = package_([textEntry("_rels/.rels", RELS("/word/main.xml")), textEntry("word/main.xml", BODY)]);
    assert.equal(opensAs(input), "word/main.xml");
  });

  test("without a pointer, the usual place is used", () => {
    assert.equal(opensAs(package_([textEntry("word/document.xml", BODY)])), "word/document.xml");
  });

  test("a pointer that climbs out of the package is not followed", () => {
    const input = package_([textEntry("_rels/.rels", RELS("../../elsewhere.xml")), textEntry("word/document.xml", BODY)]);
    assert.equal(opensAs(input), "word/document.xml");
  });

  test("a part in UTF-16 with a byte order mark is read", () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(BODY.replace('encoding="UTF-8"', 'encoding="UTF-16"'), "utf16le")]);
    const pkg = openDocx(package_([{ name: "word/document.xml", data: new Uint8Array(utf16) }]));
    assert.equal(pkg.xml("word/document.xml")?.name, "w:document");
  });

  test("a part that begins with a UTF-8 byte order mark is read", () => {
    const pkg = openDocx(package_([{ name: "word/document.xml", data: new Uint8Array(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(BODY)])) }]));
    assert.equal(pkg.xml("word/document.xml")?.name, "w:document");
  });
});

describe("the wrong kind of file says what it is and what to do", () => {
  const refuses = (input: Uint8Array, message: RegExp) =>
    assert.throws(() => openDocx(input), (error: unknown) => {
      assert.ok(error instanceof DocxError, "a readable DocxError");
      assert.match((error as Error).message, message);
      return true;
    });

  test("an empty file", () => refuses(new Uint8Array(0), /is empty/));

  test("an older .doc, or a password-protected Word file", () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    refuses(ole, /older Word file \(\.doc\), or a Word file protected by a password.*Save As.*\.docx/);
  });

  test("a Rich Text file", () => refuses(bytes("{\\rtf1\\ansi hello}"), /Rich Text file.*Save As/));

  test("a PDF", () => refuses(bytes("%PDF-1.7\n..."), /is a PDF/));

  test("plain text", () => refuses(bytes("1. A question\n*a. Yes\nb. No\n"), /could not be opened as a Word document.*not a zip/));

  test("a zip that is not a Word document", () => {
    refuses(package_([textEntry("readme.txt", "hi")]), /not a Word document: it has no main document part/);
  });
});

describe("a damaged or hostile file ends in a readable error", () => {
  const refuses = (input: Uint8Array, message: RegExp) =>
    assert.throws(() => openDocx(input), (error: unknown) => {
      assert.ok(error instanceof DocxError, `expected a DocxError, got ${(error as Error).name}: ${(error as Error).message}`);
      assert.match((error as Error).message, message);
      return true;
    });

  test("a zip cut short", () => {
    const whole = docx({ body: paragraph(run("hello")) });
    refuses(whole.subarray(0, Math.floor(whole.length / 2)), /could not be opened as a Word document/);
  });

  test("a zip with a name that climbs out of its folder", () => {
    const zip = Buffer.from(package_([textEntry("xx/evil.xml", "<a/>"), textEntry("word/document.xml", BODY)]));
    let at = zip.indexOf("xx/evil.xml");
    while (at !== -1) {
      zip.write("../evil.xml", at, "utf8");
      at = zip.indexOf("xx/evil.xml", at + 1);
    }
    refuses(new Uint8Array(zip), /climbs out of its folder/);
  });

  test("two parts whose names differ only in case", () => {
    refuses(package_([textEntry("word/document.xml", BODY), textEntry("Word/Document.xml", BODY)]), /same part under the format's rules/);
  });

  // A package opens without reading its body, so a bad part shows when it is read.
  const refusesPart = (parts: Record<string, string>, message: RegExp) =>
    assert.throws(() => openDocx(openable(parts)).xml("word/document.xml"), (error: unknown) => {
      assert.ok(error instanceof DocxError, `expected a DocxError, got ${(error as Error).name}: ${(error as Error).message}`);
      assert.match((error as Error).message, message);
      return true;
    });

  test("a part that is not valid XML names the part and the place", () => {
    refusesPart(
      { "word/document.xml": `<w:document ${W}><w:body><w:p></w:body></w:document>` },
      /part "word\/document\.xml" of this Word file is not valid XML.*does not match the start tag <w:p>.*line 1/,
    );
  });

  test("a part with a document type declaration is refused", () => {
    refusesPart(
      { "word/document.xml": `<!DOCTYPE d [<!ENTITY x "y">]><w:document ${W}><w:body/></w:document>` },
      /not valid XML.*document type/,
    );
  });

  test("a part in an encoding other than UTF-8 or UTF-16 is refused rather than misread", () => {
    refusesPart({ "word/document.xml": BODY.replace("UTF-8", "windows-1252") }, /says it is written in windows-1252/);
  });

  test("an entry that inflates far beyond what it declared is stopped, not expanded", () => {
    const bomb = package_([{ name: "word/document.xml", data: new Uint8Array(200_000) }]);
    assert.ok(bomb.length < 2000, "200 KB of zeros compresses to almost nothing");
    assert.throws(() => openDocx(bomb, { maxBytes: 1024 }), (error: unknown) => {
      assert.ok(error instanceof DocxError);
      assert.match((error as Error).message, /expands to more than|more than 1 KB/);
      return true;
    });
  });

  test("a document whose parts add up past the limit is refused", () => {
    const big = package_([textEntry("word/document.xml", BODY), { name: "word/media/a.bin", data: new Uint8Array(5000), store: true }]);
    assert.throws(() => openDocx(big, { maxBytes: 4000 }), /more than 4 KB|expands to more than/);
  });

  test("a deeply nested body is refused by the XML limits, not by a stack overflow", () => {
    const deep = `<w:document ${W}><w:body>${"<w:sdt><w:sdtContent>".repeat(300)}</w:body></w:document>`;
    const pkg = openDocx(openable({ "word/document.xml": deep }));
    assert.throws(() => pkg.xml("word/document.xml"), DocxError);
  });
});

/** A package made from the given parts, as text. */
function openable(parts: Record<string, string>): Uint8Array {
  return package_(Object.entries(parts).map(([name, text]) => textEntry(name, text)));
}
