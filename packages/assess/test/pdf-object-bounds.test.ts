/**
 * Where the words of an object end, in a file whose table is right and in one whose table is lost.
 *
 * An object that never closes (`7 0 obj << /A 1` and nothing after it) used to be read to the end of the FILE, and 5,000 of them took
 * 17 seconds. A first fix ended each object where the next one begins, and only for the objects found by searching: a file with a table
 * that is RIGHT, listing 5,000 such objects, took 51 seconds, and the table says where each one begins. A second reader found that the
 * place found by searching is text that looks like `N G obj`, which a string or a comment inside an object holds as well, and the first
 * fix cut such an object there. So: the table's own places bound the objects it lists; an object that ran into its bound is read again from
 * the whole file, from a budget for the file; and when the budget is gone the bound stands. These tests hold each of the three, and the
 * files that need them are read in a process of their own under a time limit.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { PdfDocument } from "../src/import/pdf/document.ts";
import { readPdfText } from "../src/import/pdf/reader.ts";
import { assemble, assembleWith, buffer, helloPieces, openObjectsWithTablePdf, readTextInChild, unterminatedPdf, type Piece } from "./support/hostile-pdf.ts";

const DAMAGED = /table of objects in this PDF was damaged/;
const notesOf = (bytes: Uint8Array): string => readPdfText(bytes).notes.map((n) => n.message).join("\n");

describe("a table of objects that is right, listing objects that never close", () => {
  // 5,000 of them in a page tree: each is read to the end of the file when it is not bounded, 51 seconds from 240 KB.
  for (const kind of ["dictionary", "string", "hex", "array"] as const) {
    test(`5,000 objects that are an open ${kind} are read in no more time than the length of the file, and the page is read`, () => {
      const bytes = openObjectsWithTablePdf(kind, 5_000);
      assert.ok(bytes.length < 400_000, `a file of ${bytes.length} bytes`);
      const read = readTextInChild(bytes);
      assert.equal(read.timedOut, false, `still reading after ${read.ms} ms`);
      assert.equal(read.status, 0, read.stderr);
      assert.deepEqual(read.lines?.[0], ["Hello"]);
      assert.doesNotMatch((read.notes ?? []).join("\n"), DAMAGED, "the table is right and is believed");
      assert.ok(read.ms < 5000, `read in ${read.ms} ms`);
    });
  }

  // The same objects found by searching: the open string, hex string and dictionary were not in the first fix's tests.
  for (const kind of ["strings", "hexstrings", "dictionaries"] as const) {
    test(`and 10,000 open ${kind} with no table are read in no more time than the length of the file`, () => {
      const read = readTextInChild(unterminatedPdf(kind, 10_000));
      assert.equal(read.timedOut, false, `still reading after ${read.ms} ms`);
      assert.deepEqual(read.lines, [["Hello"]]);
      assert.ok(read.ms < 5000, `read in ${read.ms} ms`);
    });
  }

  test("each object is bounded by the next one the table lists, in whatever order the objects stand in the file", () => {
    // The table lists 100 first and 101 second, and the file has 101 before 100: the bound of each is the next place, not the next number.
    const pieces: Piece[] = [...helloPieces(), { raw: "101 0 obj [ 3\n", num: 101 }, { raw: "100 0 obj [ 1 2\n", num: 100 }, { num: 102, body: "<< /X 1 >>" }];
    const doc = new PdfDocument(assemble(pieces));
    // Each reads to where the next begins and then, having run into it, to the end of the file; what matters is that none is lost.
    assert.deepEqual((doc.get(100) as unknown[]).slice(0, 2), [1, 2]);
    assert.deepEqual((doc.get(101) as unknown[])[0], 3);
    assert.equal(doc.dict(doc.get(102) as never)?.get("X"), 1);
  });

  test("two objects the table sends to one place both read the object that is there", () => {
    const pieces = helloPieces();
    pieces[2] = { num: 3, body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>" };
    const bytes = assembleWith(pieces, (offsets, size) => {
      const row = (at: number): string => `${String(at).padStart(10, "0")} 00000 n \n`;
      // Object 6 is listed where object 4, the content, is.
      return `xref\n0 7\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((n) => row(offsets.get(n) as number)).join("")}${row(offsets.get(4) as number)}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`;
    });
    const doc = new PdfDocument(bytes);
    const page = doc.pages()[0];
    assert.ok(page);
    assert.match(Buffer.from(doc.pageContent(page)).toString("latin1"), /Hello/);
    assert.doesNotMatch(notesOf(bytes), DAMAGED);
  });

  test("an entry that points past the end of the file, one that points at 0, and one that is free are not objects, and the others are read", () => {
    const bytes = assembleWith(helloPieces(), (offsets, size) => {
      const row = (at: number): string => `${String(at).padStart(10, "0")} 00000 n \n`;
      return `xref\n0 9\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((n) => row(offsets.get(n) as number)).join("")}${row(9_999_999)}${row(0)}0000000003 00001 f \ntrailer\n<< /Size 9 /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`;
    });
    assert.deepEqual(readPdfText(bytes).pages.map((p) => p.lines.map((l) => l.text)), [["Hello"]]);
    assert.doesNotMatch(notesOf(bytes), DAMAGED);
    const doc = new PdfDocument(bytes);
    assert.equal(doc.get(7), null, "an entry at 0 is no object");
    assert.equal(doc.get(8), null, "nor a free one");
    assert.throws(() => doc.get(6), /Expected an object at byte/, "and one past the end is asked for in words, and is no object either");
  });
});

describe("an object that runs into the place where the next one is said to begin", () => {
  // The table says an unused object 6 is in the middle of the page's dictionary, so that the page is cut where the dictionary has not
  // ended. It is read again from the whole file, and the page has its contents.
  test("is read whole when the table is wrong about where the next object is", () => {
    const pieces: Piece[] = [...helloPieces(), { num: 6, body: "<< /Unused true >>" }];
    const bytes = assembleWith(pieces, (offsets, size) => {
      const row = (at: number): string => `${String(at).padStart(10, "0")} 00000 n \n`;
      const inside = (offsets.get(3) as number) + 60;
      return `xref\n0 7\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((n) => row(offsets.get(n) as number)).join("")}${row(inside)}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`;
    });
    assert.deepEqual(readPdfText(bytes).pages.map((p) => p.lines.map((l) => l.text)), [["Hello"]]);
    assert.doesNotMatch(notesOf(bytes), DAMAGED);
  });

  // The place falls inside the object's own number and the word obj that begin it, so that the object cannot be told from one that is not
  // there until it has been read again (found by moving one entry of a right table a few bytes: 37 of 3,000 files were refused).
  test("is read whole when the table puts the next place inside the number and the word obj that begin it", () => {
    const pieces: Piece[] = [...helloPieces(), { num: 6, body: "<< /Unused true >>" }];
    const bytes = assembleWith(pieces, (offsets, size) => {
      const row = (at: number): string => `${String(at).padStart(10, "0")} 00000 n \n`;
      const inside = (offsets.get(2) as number) + 3;
      return `xref\n0 7\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((n) => row(offsets.get(n) as number)).join("")}${row(inside)}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`;
    });
    assert.deepEqual(readPdfText(bytes).pages.map((p) => p.lines.map((l) => l.text)), [["Hello"]]);
    assert.doesNotMatch(notesOf(bytes), DAMAGED);
    assert.throws(() => new PdfDocument(bytes).get(6), /Expected an object at byte/, "and the entry that is not at an object is still not one");
  });

  test("is read whole when a string of it holds the start of an object, in a file with no table", () => {
    const pieces = helloPieces();
    pieces[2] = { num: 3, body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Title (see 9 0 obj here) /Contents 4 0 R >>" };
    assert.deepEqual(readPdfText(assemble(pieces, "trailer")).pages.map((p) => p.lines.map((l) => l.text)), [["Hello"]]);
  });

  // The fuzz found it: the bound was looked at after the dictionary and not after the word that says a stream follows.
  test("is read whole when the start is in a comment between its dictionary and the word stream", () => {
    const pieces = helloPieces();
    pieces[3] = { raw: "4 0 obj\n<< /Length 36 >>\n% 6 1 obj\n\nstream\nBT /F1 12 Tf 72 700 Td (Hello) Tj ET\nendstream\nendobj\n" };
    assert.deepEqual(readPdfText(assemble(pieces, "trailer")).pages.map((p) => p.lines.map((l) => l.text)), [["Hello"]]);
  });

  test("is read whole in a stream's dictionary that holds the start in a string after its filter and before its length", () => {
    const pieces = helloPieces();
    pieces[3] = { raw: "4 0 obj\n<< /Subject (a 9 0 obj b) /Length 36 >>\nstream\nBT /F1 12 Tf 72 700 Td (Hello) Tj ET\nendstream\nendobj\n" };
    assert.deepEqual(readPdfText(assemble(pieces, "trailer")).pages.map((p) => p.lines.map((l) => l.text)), [["Hello"]]);
  });

  test("is read whole in each of 2,000 pages, so that the budget for a file is not spent by objects that are cut at a string", () => {
    const count = 2_000;
    const pieces: Piece[] = [
      { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
      { num: 2, body: `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, i) => `${100 + i} 0 R`).join(" ")}] /Count ${count} >>` },
      { num: 4, dict: "", data: buffer("BT /F1 12 Tf 72 700 Td (Hello) Tj ET") },
      { num: 5, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
    ];
    for (let i = 0; i < count; i++) {
      pieces.push({ num: 100 + i, body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Title (see 9 0 obj here) /Contents 4 0 R >>" });
    }
    const doc = new PdfDocument(assemble(pieces, "trailer"));
    const pages = doc.pages();
    assert.equal(pages.length, count);
    assert.ok(pages.every((p) => Buffer.from(doc.pageContent(p)).toString("latin1").includes("Hello")), "every page has its contents");
  });
});

describe("the budget for reading objects again", () => {
  const unclosed = (count: number): Buffer => assemble([...helloPieces(), ...Array.from({ length: count }, (_, i) => ({ raw: `${100 + i} 0 obj [ 1 2\n` }) as Piece)], "trailer");

  test("lets an object that never closes be read as far as it goes, as it was read before there was a bound, while there is budget", () => {
    const doc = new PdfDocument(assemble([...helloPieces(), { raw: "100 0 obj [ 1 2\n" }, { raw: "101 0 obj [ 3\n" }, { num: 102, body: "<< /X 1 >>" }], "trailer"));
    const first = doc.get(100) as unknown[];
    assert.deepEqual(first.slice(0, 4), [1, 2, 101, 0], "it runs on into the words of the next object");
    assert.ok(first.length > 4);
    assert.deepEqual((doc.get(101) as unknown[])[0], 3);
  });

  test("keeps the object's own words when the second reading cannot be made, as when more than 64 objects that never close follow it", () => {
    const doc = new PdfDocument(unclosed(100));
    assert.deepEqual(doc.get(100), [1, 2], "the second reading nests too deeply, and the first stands");
    assert.deepEqual(doc.get(120), [1, 2], "so does the one twenty on, which has eighty after it");
    assert.equal((doc.get(150) as unknown[]).length, 6, "and the one fifty on, with fifty after it, is read as far as it goes");
  });

  test("is spent, for a file, by objects that run on, and the objects after that are bounded where the next begins", () => {
    // 20,000 objects of 15 bytes that never close; each second reading goes about 65 objects on before it nests too deeply, a kilobyte,
    // and the budget of a file of 300 KB is 5.8 MB. The first objects are read on, and a late one is read to the next and no further.
    const doc = new PdfDocument(unclosed(20_000));
    assert.deepEqual(doc.get(100), [1, 2], "the first nests too deeply and keeps its words");
    assert.deepEqual(doc.get(100 + 19_998), [1, 2], "and the second last, which with budget would run on into the last, is read to where the last begins");
  });

  test("is spent by an object that is a string that runs to the end of the file, and the rest are bounded", () => {
    // 10,000 open strings of 20 bytes: a second reading of one goes to the end of the file, the budget of a file of 200 KB is 4.2 MB, and
    // after about twenty the strings are read as far as the next object begins.
    const bytes = unterminatedPdf("strings", 10_000);
    const doc = new PdfDocument(bytes);
    const long = (doc.get(100) as { bytes: Uint8Array }).bytes;
    assert.ok(long.length > 100_000, `the first is read to the end of the file: ${long.length} bytes`);
    const late = (doc.get(100 + 9_990) as { bytes: Uint8Array }).bytes;
    assert.ok(late.length < 40, `a late one is its own words: ${late.length} bytes`);
  });
});
