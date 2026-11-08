/**
 * How the PDFs that programs write are put together, held by tests that write them that way.
 *
 * A fourth reader of the PDF reader ran planted faults against its tests and found that a dozen of them got past every committed PDF test
 * while the file read wrongly. They were not obscure: the usual separator after the word `stream` is a carriage return and a line feed
 * (all five of the real banks use it and none uses a bare line feed, and nothing here ever wrote one), a file that was saved again in a
 * PDF program carries two revisions of an object and a pointer from the newer table to the older (`/Prev`), a file that came through a
 * mail program has bytes in front of `%PDF-`, and a hybrid file lists its packed objects in a stream of its own (`/XRefStm`). The reader
 * read the old revision of an object, or told the person the table was damaged when it was not, and the committed tests passed. These
 * are the files those faults needed, and each test says which wrong reading it holds.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";

import { PdfDocument } from "../src/import/pdf/document.ts";
import { PdfError, PdfStream } from "../src/import/pdf/objects.ts";
import { readPdfText } from "../src/import/pdf/reader.ts";
import { assemble, assembleWith, buffer, helloPieces, packed, streamObj, tableStreamPdf, type Piece } from "./support/hostile-pdf.ts";
import { at, buildPdf, type FontSpec, type PdfSpec } from "./support/pdf-builder.ts";
import { hybridPdf, prefixedPdf, savedAgain, savedOnceMore, say, withTableLost } from "./support/pdf-revisions.ts";

const HELLO = say("Hello");
const linesOf = (bytes: Uint8Array): string[][] => readPdfText(bytes).pages.map((p) => p.lines.map((l) => l.text));
const notesOf = (bytes: Uint8Array): string => readPdfText(bytes).notes.map((n) => n.message).join("\n");
const DAMAGED = /table of objects in this PDF was damaged/;

// ---------------------------------------------------------------------------
// The separator after the word stream
// ---------------------------------------------------------------------------

describe("the bytes of a stream, whatever separates them from the words round them", () => {
  const plain = buffer(HELLO);
  const flate = deflateSync(plain);
  // A stream is trimmed of one line feed and one carriage return before `endstream` when its length cannot be believed, so data that ends in
  // either would be cut short by the test and not by the reader.
  assert.ok(![10, 13].includes(flate[flate.length - 1] as number), "the compressed data of the test does not end in a line end");

  /** An object 4 written byte for byte: `open` follows the word stream, `close` comes before the word endstream. */
  const streamPiece = (open: string, close: string, data: Buffer, length: number | undefined, filter: string): Piece => ({
    num: 4,
    raw: Buffer.concat([buffer(`4 0 obj\n<< ${length === undefined ? "" : `/Length ${length} `}${filter}>>\nstream${open}`), data, buffer(`${close}endstream\nendobj\n`)]),
  });

  for (const [what, data, filter] of [
    ["plain", plain, ""],
    ["compressed", flate, "/Filter /FlateDecode "],
  ] as const) {
    for (const [name, open, close] of [
      ["a line feed", "\n", "\n"],
      ["a carriage return and a line feed", "\r\n", "\r\n"],
      ["a carriage return alone before the data and a line feed after it", "\r", "\n"],
      ["a carriage return and a line feed before the data and a carriage return alone after it", "\r\n", "\r"],
    ] as const) {
      for (const [lengthName, length] of [
        ["its length right", data.length],
        ["its length too long", 9999],
        ["its length too short", 3],
        ["no length", undefined],
      ] as const) {
        for (const tail of ["table", "trailer"] as const) {
          test(`${what} data after ${name} with ${lengthName} is those bytes and no others (${tail === "table" ? "through the table" : "found by searching"})`, () => {
            const pieces = helloPieces();
            pieces[3] = streamPiece(open, close, data, length, filter);
            const bytes = assemble(pieces, tail);
            const stream = new PdfDocument(bytes).get(4);
            assert.ok(stream instanceof PdfStream);
            // The data begins after the whole separator, and ends before the whole of the one in front of the word endstream.
            assert.deepEqual([...stream.raw], [...data]);
            assert.deepEqual(linesOf(bytes), [["Hello"]]);
            if (tail === "table") assert.doesNotMatch(notesOf(bytes), DAMAGED);
          });
        }
      }
    }
  }
});

describe("a PDF written with a carriage return and a line feed round its streams, as programs write them", () => {
  const WIDTHS = Array.from({ length: 224 }, () => 500);
  const FONTS: Record<string, FontSpec> = { F1: { kind: "simple", base: "Helvetica", widths: WIDTHS } };
  const page = at(36, 740, 12, "1. What is 2+2?") + at(36, 726, 12, "A. Three") + at(36, 712, 12, "B. Four") + at(36, 698, 12, "Answer: B");
  const expected = [["1. What is 2+2?", "A. Three", "B. Four", "Answer: B"]];

  for (const [what, spec] of [
    ["plain", {}],
    ["compressed", { compress: true }],
    ["packed in an object stream, with its table a stream, compressed", { modern: true, compress: true }],
    ["compressed, with a length that is wrong", { compress: true, wrongLength: true }],
  ] as Array<[string, Partial<PdfSpec>]>) {
    test(`${what} is read as the same lines as with a bare line feed, and is not called damaged`, () => {
      const crlf = buildPdf({ fonts: FONTS, pages: [page], ...spec, crlf: true });
      assert.ok(Buffer.from(crlf).includes(Buffer.from("stream\r\n", "latin1")), "the file does have a carriage return after the word stream");
      assert.ok(Buffer.from(crlf).includes(Buffer.from("\r\nendstream", "latin1")), "and before the word endstream");
      assert.deepEqual(linesOf(crlf), expected);
      assert.deepEqual(linesOf(buildPdf({ fonts: FONTS, pages: [page], ...spec })), expected, "the same file with a bare line feed is the same lines");
      assert.doesNotMatch(notesOf(crlf), /damaged|could not be/);
    });
  }
});

// ---------------------------------------------------------------------------
// A file that was saved again, and a table that is wrong
// ---------------------------------------------------------------------------

describe("a file saved again in a PDF program, with the new object after the old and a pointer from the new table to the old", () => {
  // (Two revisions: a whole file whose content says OLD, and a new object 4 saying NEW with a table that lists it alone and points back.)
  const saved = savedAgain;
  const brokenStartxref = withTableLost;

  test("is read as the new revision of the object, through the tables, and is not called damaged", () => {
    const bytes = saved("OLD", "NEW");
    assert.deepEqual(linesOf(bytes), [["NEW"]]);
    // The older table is followed for the objects the newer one does not list; if it were not, the page could not be found by the table.
    assert.doesNotMatch(notesOf(bytes), DAMAGED);
  });

  test("is read as the new revision when the table is lost and the objects are found by searching, where the object is twice in the file and the last is the one", () => {
    const bytes = brokenStartxref(saved("OLD", "NEW"));
    assert.deepEqual(linesOf(bytes), [["NEW"]]);
    assert.match(notesOf(bytes), DAMAGED, "and the person is told how it was found");
  });

  test("with three revisions is the newest of the three, through the tables and by searching", () => {
    const third = savedOnceMore(saved("ONE", "TWO"), "THREE");
    assert.deepEqual(linesOf(third), [["THREE"]]);
    assert.doesNotMatch(notesOf(third), DAMAGED);
    assert.deepEqual(linesOf(brokenStartxref(third)), [["THREE"]]);
  });

  test("whose page object is the one saved again is read with the content the new page names", () => {
    const pieces = helloPieces(buffer(say("OLD")));
    pieces.push({ num: 3, body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>" });
    pieces.push({ num: 6, dict: "", data: buffer(say("NEW")) });
    assert.deepEqual(linesOf(assemble(pieces, "trailer")), [["NEW"]], "found by searching, the later page is the page");
  });
});

describe("a file that has an object number twice and no table", () => {
  test("is read with the later of the two, the one written last", () => {
    const bytes = assemble([...helloPieces(buffer(say("OLD"))), { num: 4, dict: "", data: buffer(say("NEW")) }], "trailer");
    assert.deepEqual(linesOf(bytes), [["NEW"]]);
    assert.match(notesOf(bytes), DAMAGED);
  });

  test("is read with the later of the two whichever is longer", () => {
    const longer = say("OLD OLD OLD OLD OLD OLD");
    assert.deepEqual(linesOf(assemble([...helloPieces(buffer(longer)), { num: 4, dict: "", data: buffer(say("NEW")) }], "trailer")), [["NEW"]]);
    assert.deepEqual(linesOf(assemble([...helloPieces(buffer(say("OLD"))), { num: 4, dict: "", data: buffer(say("NEW NEW NEW NEW")) }], "trailer")), [["NEW NEW NEW NEW"]]);
  });
});

describe("a table that sends an object to something that is not what it should be", () => {
  // The catalog is object 1, and the table says it is where object 6 is, an array. The table is believed as far as the first look at the
  // catalog, which finds an array, and the file is then read by searching; the array must not still be what object 1 is.
  test("is read by searching for the objects, and the first wrong reading is forgotten", () => {
    const pieces: Piece[] = [...helloPieces(), { num: 6, body: "[ 1 2 3 ]" }];
    const bytes = assembleWith(pieces, (offsets, size) => {
      const row = (n: number): string => `${String(n === 1 ? offsets.get(6) : offsets.get(n)).padStart(10, "0")} 00000 n \n`;
      return `xref\n0 7\n0000000000 65535 f \n${[1, 2, 3, 4, 5, 6].map(row).join("")}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`;
    });
    assert.deepEqual(linesOf(bytes), [["Hello"]]);
    assert.match(notesOf(bytes), DAMAGED);
  });

  // The table says the catalog is the first object stream and the pages and the page are in it. It is a decoy that holds none of them; the
  // real stream with the same number comes later in the file. Reading by searching must open the real one, not the one it already opened.
  test("is read by searching, and an object stream it opened by mistake is opened again", () => {
    const bodies = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    ];
    const starts = [0, bodies[0]!.length + 1, bodies[0]!.length + bodies[1]!.length + 2];
    const header = `1 ${starts[0]} 2 ${starts[1]} 3 ${starts[2]} `;
    const real = buffer(header + bodies.join(" "));
    const decoyHeader = "9 0 ";
    const decoy = buffer(`${decoyHeader}<< /Decoy true >>`);
    const pieces: Piece[] = [
      { num: 7, dict: `/Type /ObjStm /N 1 /First ${decoyHeader.length}`, data: decoy },
      { num: 4, dict: "", data: buffer(HELLO) },
      { num: 5, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
    ];
    const decoyAt = "%PDF-1.5\n".length;
    pieces.push({ raw: streamObj(7, `/Type /ObjStm /N 3 /First ${header.length}`, real) });
    const bytes = assembleWith(pieces, (offsets, size) => {
      const rows: Array<[number, number, number]> = [[0, 0, 255], [2, 7, 0], [2, 7, 1], [2, 7, 2], [1, offsets.get(4)!, 0], [1, offsets.get(5)!, 0], [0, 0, 0], [1, decoyAt, 0], [1, size, 0]];
      return Buffer.concat([streamObj(8, "/Type /XRef /Size 9 /W [1 4 1] /Root 1 0 R", packed(rows, [1, 4, 1])), buffer(`startxref\n${size}\n%%EOF\n`)]);
    });
    assert.deepEqual(linesOf(bytes), [["Hello"]]);
    assert.match(notesOf(bytes), DAMAGED);
  });

  test("by a dictionary that holds the word Encrypt and no root is a protected file all the same, and is refused as one", () => {
    const bytes = assemble([...helloPieces(), { num: 6, body: "<< /Size 7 /Encrypt << /Filter /Standard /V 1 >> >>" }], "trailer");
    assert.throws(() => readPdfText(bytes), (error: unknown) => error instanceof PdfError && /protected/.test(error.message));
  });
});

// ---------------------------------------------------------------------------
// The shapes of tables that real files have
// ---------------------------------------------------------------------------

describe("the table of a file that has bytes in front of its header", () => {
  test("counts its offsets from the header, as the format says, and is read by the table and not by searching", () => {
    const bytes = prefixedPdf();
    assert.ok(bytes.length > assemble(helloPieces()).length);
    assert.deepEqual(linesOf(bytes), [["Hello"]]);
    assert.doesNotMatch(notesOf(bytes), DAMAGED);
  });
});

describe("a hybrid file, whose table lists the packed objects in a stream of its own", () => {
  test("is read through both tables, and not called damaged", () => {
    const bytes = hybridPdf();
    assert.deepEqual(linesOf(bytes), [["Hello"]]);
    assert.doesNotMatch(notesOf(bytes), DAMAGED);
  });
});

describe("an entry of the old table that says the object is free", () => {
  // A free entry holds the number of the next free object where an offset would be, and that is a small number, not a place in the file.
  test("is not an object, though it has a number where the offset goes", () => {
    const pieces = helloPieces().filter((p) => (p as { num: number }).num !== 5);
    const bytes = assembleWith(pieces, (offsets, size) => {
      const row = (n: number): string => `${String(offsets.get(n)).padStart(10, "0")} 00000 n \n`;
      // Object 5, the font, is gone: its entry is free and holds the next free number, and entry 0 holds 5.
      return `xref\n0 6\n0000000005 65535 f \n${row(1)}${row(2)}${row(3)}${row(4)}0000000002 00001 f \ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`;
    });
    assert.deepEqual(linesOf(bytes), [["Hello"]], "the font that is not there is the default, and the page is read");
    assert.doesNotMatch(notesOf(bytes), DAMAGED);
  });
});

describe("a table that is a stream", () => {
  test("with no field for the generation (/W [1 3 0]) is a table, and is believed, and nothing is said", () => {
    const bytes = tableStreamPdf("[1 3 0]", "[0 7]", [1, 3, 0]);
    assert.deepEqual(linesOf(bytes), [["Hello"]]);
    assert.doesNotMatch(notesOf(bytes), DAMAGED);
  });

  test("with no field for the type (/W [0 3 1]), where every entry is in the file, is a table, and is believed", () => {
    const bytes = tableStreamPdf("[0 3 1]", "[0 7]", [0, 3, 1]);
    assert.deepEqual(linesOf(bytes), [["Hello"]]);
    assert.doesNotMatch(notesOf(bytes), DAMAGED);
  });

  // Only the rows the table declares are counted, however much data follows them, so that a table of eight rows is eight rows. Counting
  // where the second range begins as rows too, 2,000,000 and one, called a table of eight rows a table of two million and refused it.
  test("that declares eight rows is eight rows, whatever place the second range begins at and however much data follows", () => {
    const bytes = assembleWith(helloPieces(), (offsets, size) => {
      const real: Array<[number, number, number]> = [[0, 0, 255], ...[1, 2, 3, 4, 5].map((n) => [1, offsets.get(n)!, 0] as [number, number, number]), [1, size, 0]];
      // The seven right rows, one more for object 2,000,000, and zeros to 2,000,100 rows: more than a table may declare, and not declared.
      const data = Buffer.concat([packed([...real, [0, 0, 0]], [1, 2, 1]), Buffer.alloc((2_000_100 - 8) * 4)]);
      const twice = deflateSync(deflateSync(data, { level: 9 }), { level: 9 });
      return Buffer.concat([streamObj(6, "/Type /XRef /Size 7 /W [1 2 1] /Index [0 7 2000000 1] /Root 1 0 R /Filter [/FlateDecode /FlateDecode]", twice), buffer(`startxref\n${size}\n%%EOF\n`)]);
    });
    assert.deepEqual(linesOf(bytes), [["Hello"]]);
    assert.doesNotMatch(notesOf(bytes), DAMAGED, "it is believed");
  });
});

// ---------------------------------------------------------------------------
// The edge of nesting
// ---------------------------------------------------------------------------

describe("nesting at the edge of what is read", () => {
  const arrays = (depth: number): string => `${"[".repeat(depth)} 7 ${"]".repeat(depth)}`;
  const dictionaries = (depth: number): string => `${"<< /A ".repeat(depth)}7${" >>".repeat(depth)}`;
  const doc = new PdfDocument(assemble([...helloPieces(), { num: 6, body: arrays(64) }, { num: 7, body: arrays(65) }, { num: 8, body: dictionaries(64) }, { num: 9, body: dictionaries(65) }]));

  test("a number in the 64th array is read, and a number in the 65th is not: a number is one level deeper than the brackets that hold it", () => {
    let value = doc.get(6);
    for (let level = 1; level < 64; level++) value = (value as unknown[])[0] as never;
    assert.deepEqual(value, [7]);
    assert.throws(() => doc.get(7), /nested too deeply/);
  });

  test("and the same of a number in the 64th dictionary and in the 65th", () => {
    let value = doc.get(8);
    for (let level = 1; level < 64; level++) value = (value as Map<string, never>).get("A") as never;
    assert.equal((value as Map<string, unknown>).get("A"), 7);
    assert.throws(() => doc.get(9), /nested too deeply/);
  });
});
