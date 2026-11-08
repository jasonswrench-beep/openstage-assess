/**
 * PDFs that are small and ask a great deal.
 *
 * Two readers who went looking for a loop whose count or step comes from the file found that a few kilobytes could hold the program
 * for minutes or fill its memory, in places no damaged-file run reaches because each needs one number or one repeated word to be
 * exactly wrong: a table of objects whose entries are 0 wide, a font whose widths are listed in thousands of ranges, a character map
 * that is never closed, an object stream whose objects all run to its end, runs that unpack to far more than they say, and a row
 * width that underflows to 0. Each file here is read in a process of its own with a time limit (`support/hostile-pdf.ts`), so that a
 * fault that returns fails its test in twenty seconds and does not freeze the rest.
 *
 * A third reader looked at the patterns and the recursion, and found the same of them: a number of 826 digits held the program for 10
 * seconds, a string of 200,000 spaces for 11, a line of 400,000 pieces for 44, `[` repeated 200,000 times ended in a RangeError's words,
 * a file of `N 0 obj [` repeated read each object to the end of the file, a table of one-byte entries made 670 MB, forty fonts that shared
 * one description made 700 MB, and a decoder that kept each byte it made as a number in an array made 895 MB. Where memory is the
 * point the child has a heap of 128 or 200 MB (`heapOf`), so that a fault that comes back ends the process whatever the machine.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

import type { TextRun } from "../src/import/pdf/content.ts";
import { PdfError, Lexer } from "../src/import/pdf/objects.ts";
import { ascii85, PdfDocument, runLength, WordFinder } from "../src/import/pdf/document.ts";
import { loadFont, type PdfFont } from "../src/import/pdf/fonts.ts";
import { layoutLines } from "../src/import/pdf/layout.ts";
import {
  ascii85Pdf,
  assemble,
  contentPdf,
  deepNestPdf,
  fontWidthsPdf,
  heapOf,
  helloPieces,
  inChild,
  longTablePdf,
  manyFontsPdf,
  objectStreamPdf,
  readTextInChild,
  tableBombPdf,
  toUnicodePdf,
  twoPagePdf,
  unendedStreamsPdf,
  unterminatedPdf,
  xrefStreamPdf,
  type Piece,
} from "./support/hostile-pdf.ts";
import { scanPdf } from "./support/pdf-scan.ts";

const TINY = `0.${"0".repeat(200)}1`;

describe("a cross-reference stream whose entries have no width", () => {
  for (const [what, w, index] of [
    ["a negative width and a count past counting", "[-1 0 0]", "[0 99999999999999999999]"],
    ["every width 0 and a count of a billion", "[0 0 0]", "[0 1000000000]"],
    ["widths that add up to 1 and are 1e12 and minus 1e12 apart", "[1000000000000 -999999999999 0]", "[0 1]"],
    ["widths that are not numbers", "[(a) (b) (c)]", "[0 1000000000]"],
  ] as const) {
    test(`with ${what} is refused as a table, and the objects are found by searching`, () => {
      const read = readTextInChild(xrefStreamPdf(w, index));
      assert.equal(read.timedOut, false, `still reading after ${read.ms} ms`);
      // A width of 0 took 5 seconds and 1.2 GB before it ended; refusing the table takes a few milliseconds, and a process starts in 150.
      assert.ok(read.ms < 3000, `read in ${read.ms} ms`);
      assert.deepEqual(read.lines, [["Hello"]], "the page is read all the same");
      assert.match((read.notes ?? []).join("\n"), /table of objects in this PDF was damaged/, "and the person is told how it was found");
    });
  }
});

describe("fonts and maps that ask for hours", () => {
  test("a font whose widths are 30,000 ranges of 70,000 codes is read in less than the time it takes to list them", () => {
    const read = readTextInChild(fontWidthsPdf(30_000));
    assert.equal(read.timedOut, false, `still reading after ${read.ms} ms`);
    assert.equal(read.lines?.length, 1);
  });

  test("a character map made of one word that is never closed, 2 MB of it, is read at once", () => {
    const read = readTextInChild(toUnicodePdf(2));
    assert.equal(read.timedOut, false, `still reading after ${read.ms} ms`);
    assert.equal(read.lines?.length, 1);
  });

  test("an object stream of 2000 objects that all run to the end of 50,000 numbers is read once, and not once for each", () => {
    const read = readTextInChild(objectStreamPdf(2000, 50_000));
    assert.equal(read.timedOut, false, `still reading after ${read.ms} ms`);
    assert.deepEqual(read.lines, [["Hello"]]);
  });

  // Each of 2000 objects begins at a place of its own and is an array that never closes, and the page tree asks for every one. Read to
  // the end of the data, each is 50,000 numbers and the whole is 50 million; read to where the next begins, it is 50,000 in all.
  test("an object stream whose objects all begin at different places and never close is read in the length of the stream, however many are asked for", () => {
    const read = readTextInChild(objectStreamPdf(2000, 25, true));
    assert.equal(read.timedOut, false, `still reading after ${read.ms} ms`);
    assert.deepEqual(read.lines, [["Hello"]]);
    assert.ok(read.ms < 5000, `read in ${read.ms} ms`);
  });
});

describe("a scanned sheet whose picture describes rows of no width", () => {
  for (const [what, parms] of [
    ["columns and colours that underflow to 0", `/DecodeParms << /Predictor 2 /Columns ${TINY} /Colors ${TINY} >>`],
    ["a width of 0 under the predictor that most scanners use", "/DecodeParms << /Predictor 12 /Columns 0 >>"],
  ] as const) {
    test(`with ${what} is refused for that page in the reader's own words, and does not hold the program`, () => {
      const image = { width: 20, height: 20, data: new Uint8Array(400).fill(255) };
      const bytes = scanPdf([{ picture: { image, encoding: "flate", extra: parms } }]);
      const run = inChild(
        bytes,
        `const { readPdfPictures } = await engine("sheets/pdf-page.ts"); const r = readPdfPictures(bytes); console.log(JSON.stringify(r.ok ? r.pages.map((p) => (p.result.ok ? "ok" : p.result.reason)) : r.reason));`,
      );
      assert.equal(run.timedOut, false, `still reading after ${run.ms} ms`);
      assert.equal(run.status, 0, run.stderr);
      // The words are the PDF reader's own (a PdfError's message), not the general "it could not be unpacked".
      assert.match(run.stdout, /cannot be right/);
    });
  }
});

describe("runs that unpack to more than they should", () => {
  test("a run-length stream is decoded right: literals, repeats, and an end mark that stops it", () => {
    const encoded = Uint8Array.from([2, 65, 66, 67, 254, 90, 0, 68, 128, 99, 99]);
    assert.deepEqual([...runLength(encoded)], [65, 66, 67, 90, 90, 90, 68]);
    assert.deepEqual([...runLength(Uint8Array.from([5, 1, 2]))], [1, 2], "a literal run cut short gives what is there");
    assert.equal(runLength(new Uint8Array(0)).length, 0);
  });

  // 2 KB of runs of 128 once made 2 GB, because every byte of output was a number in an array, and the limit was looked at after each
  // run; at 2.2 million runs it ended in "Invalid array length". The limit is looked at before a run is written now.
  test("a stream that would unpack past the limit is stopped at the limit, in the PDF reader's words, before it is made", () => {
    const pairs = 20_000;
    const encoded = new Uint8Array(pairs * 2);
    for (let i = 0; i < pairs; i++) {
      encoded[i * 2] = 129; // 128 copies of the next byte
      encoded[i * 2 + 1] = 32;
    }
    assert.equal(runLength(encoded, 3_000_000).length, 2_560_000, "within the limit it is all there");
    assert.equal(runLength(encoded, 2_560_000).length, 2_560_000, "and so it is at exactly the limit");
    assert.throws(() => runLength(encoded, 2_559_999), PdfError, "and one byte over is stopped before the last run is written, not after");
    assert.throws(() => runLength(encoded, 1_000_000), (error: unknown) => {
      assert.ok(error instanceof PdfError, "and the words are the reader's own, not a RangeError's");
      assert.match(error.message, /unpacks to more than a test bank could hold/);
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// A third reader: patterns, recursion, the objects of a file with no table, and memory
// ---------------------------------------------------------------------------

const HELLO = "BT /F1 12 Tf 72 700 Td (Hello) Tj ET";

describe("a number in a PDF", () => {
  // The pattern was `(\d+\.?\d*|\.\d+)`, and it is now `(?:\d+(?:\.\d*)?|\.\d+)`. They must say the same about every word.
  test("is told from a word exactly as it was, for every string of up to seven characters from 0 1 . + - and a letter", () => {
    const OLD_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;
    const alphabet = ["0", "1", ".", "+", "-", "a"];
    const wrong: string[] = [];
    let tried = 0;
    const visit = (word: string): void => {
      tried++;
      const token = new Lexer(Buffer.from(word, "latin1")).next();
      const expected = word === "" ? { t: "eof" } : OLD_NUMBER.test(word) ? { t: "num", v: Number(word), integer: /^[+-]?\d+$/.test(word) } : { t: "kw", v: word };
      if (!isDeepStrictEqual(token, expected)) wrong.push(`${JSON.stringify(word)}: ${JSON.stringify(token)} for ${JSON.stringify(expected)}`);
      if (word.length < 7) for (const c of alphabet) visit(word + c);
    };
    visit("");
    assert.equal(tried, 335_923, "every string of 0 to 7 characters over six was tried");
    assert.deepEqual(wrong.slice(0, 5), []);
  });

  test("reads the numbers a PDF writes: signs, points, a point at either end, a number that is one digit long and one that is long", () => {
    const read = (word: string): unknown => new Lexer(Buffer.from(word, "latin1")).next();
    assert.deepEqual(read("12"), { t: "num", v: 12, integer: true });
    assert.deepEqual(read("-12"), { t: "num", v: -12, integer: true });
    assert.deepEqual(read("+0"), { t: "num", v: 0, integer: true });
    assert.deepEqual(read("1."), { t: "num", v: 1, integer: false });
    assert.deepEqual(read(".5"), { t: "num", v: 0.5, integer: false });
    assert.deepEqual(read("-.5"), { t: "num", v: -0.5, integer: false });
    assert.deepEqual(read("3.25"), { t: "num", v: 3.25, integer: false });
    assert.deepEqual(read("1.2.3"), { t: "kw", v: "1.2.3" });
    assert.deepEqual(read("--1"), { t: "kw", v: "--1" });
    assert.deepEqual(read("."), { t: "kw", v: "." });
    assert.deepEqual(read("12a"), { t: "kw", v: "12a" });
  });

  test("a run of two million digits and then a letter is read at once, from a file of 2.5 KB", () => {
    const bytes = contentPdf("1".repeat(2_000_000) + `x\n${HELLO}`);
    assert.ok(bytes.length < 4000, `a file of ${bytes.length} bytes`);
    const read = readTextInChild(bytes);
    assert.equal(read.timedOut, false, `still reading after ${read.ms} ms`);
    assert.deepEqual(read.lines, [["Hello"]]);
    assert.ok(read.ms < 5000, `read in ${read.ms} ms`);
  });
});

describe("the reader of scanned sheets, which meets the same words", () => {
  // It reads the instructions of a page to find the picture the page draws, with the same lexer.
  test("reads a page whose instructions are a run of two million digits and a letter at once, and says the page has no picture", () => {
    const run = inChild(
      contentPdf("1".repeat(2_000_000) + "x\n0.5 g 10 10 200 200 re f"),
      `const { readPdfPictures } = await engine("sheets/pdf-page.ts"); const r = readPdfPictures(bytes); console.log(JSON.stringify(r.ok ? r.pages.map((p) => (p.result.ok ? "ok" : p.result.cause)) : r.reason));`,
    );
    assert.equal(run.timedOut, false, `still reading after ${run.ms} ms`);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), ["no-picture"]);
    assert.ok(run.ms < 5000, `read in ${run.ms} ms`);
  });

  test("refuses a file with 200,000 open brackets in its catalog in the reader's words", () => {
    const run = inChild(deepNestPdf("catalog", 200_000), `const { readPdfPictures } = await engine("sheets/pdf-page.ts"); const r = readPdfPictures(bytes); console.log(JSON.stringify(r.ok ? "read" : r.reason));`);
    assert.equal(run.timedOut, false, `still reading after ${run.ms} ms`);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /nested too deeply/);
  });
});

describe("a line with a great deal of white space in it", () => {
  test("a string of 400,000 spaces and a letter is read at once, from a file of about 1 KB", () => {
    // (Not the letter x: on its own, as the last thing on a line at the top of a page, it is a page number in Roman numerals.)
    const bytes = contentPdf(`BT /F1 12 Tf 72 700 Td (${" ".repeat(400_000)}Hello) Tj ET`);
    assert.ok(bytes.length < 2000, `a file of ${bytes.length} bytes`);
    const read = readTextInChild(bytes);
    assert.equal(read.timedOut, false, `still reading after ${read.ms} ms`);
    assert.equal(read.lines?.length, 1);
    assert.equal(read.lines?.[0]?.length, 1);
    assert.equal(read.lines?.[0]?.[0]?.trim(), "Hello", "the end is cut, and the text is all there");
    assert.equal(read.lines?.[0]?.[0]?.length, 400_005, "and the spaces in front of it are not touched");
    assert.ok(read.ms < 5000, `read in ${read.ms} ms`);
  });

  // The trailing white space is cut with trimEnd and not a pattern: they must cut the same characters, which are the ones `\s` is.
  test("is cut from the end of a line at the same characters a pattern for white space would cut", () => {
    const wrong: string[] = [];
    for (let unit = 0; unit < 0x10000; unit++) {
      const text = `a${String.fromCharCode(unit)}`;
      if (text.trimEnd() !== text.replace(/\s+$/, "")) wrong.push(unit.toString(16));
    }
    assert.deepEqual(wrong, []);
  });

  for (const [what, content, size] of [
    ["pieces side by side", `${"(ab) Tj ".repeat(300_000)}`, 600_000],
    ["pieces a tab apart", `[ ${"(ab) -4000 ".repeat(300_000)}] TJ`, 300_000 * 3 - 1],
  ] as const) {
    // Asking `/\s$/.test(text)` of a text that grows by each piece took 44 seconds for 400,000 pieces, and 2 for 100,000.
    test(`a line of 300,000 ${what} is laid out in time that grows with the pieces and not with their square`, () => {
      const run = inChild(
        contentPdf(`BT /F1 12 Tf 72 700 Td ${content} ET`),
        `const { readPdfText } = await engine("import/pdf/reader.ts"); const r = readPdfText(bytes); const lines = r.pages[0].lines; console.log(JSON.stringify({ lines: lines.length, length: lines[0].text.length, tabs: lines[0].text.split("\\t").length - 1 }));`,
      );
      assert.equal(run.timedOut, false, `still reading after ${run.ms} ms`);
      assert.equal(run.status, 0, run.stderr);
      const out = JSON.parse(run.stdout) as { lines: number; length: number; tabs: number };
      assert.equal(out.lines, 1);
      assert.equal(out.length, size);
      assert.equal(out.tabs, what === "pieces a tab apart" ? 299_999 : 0);
      assert.ok(run.ms < 10_000, `read in ${run.ms} ms`);
    });
  }

  // What the line ends with is kept as it is added to, and decides whether a gap is a space or a tab. These are the shapes where it
  // matters: a piece that ends in white space, one that begins with it, one that ends in a tab, and a gap that is not wide.
  test("a gap is a space, a tab, or nothing as before: after a piece that ends in white space, before one that begins with it, and after a tab", () => {
    const run = (text: string, x0: number): TextRun => ({ text, x0, x1: x0 + 12, y: 700, size: 12, bold: false, italic: false, font: "F", upright: true });
    // Letters 12 points high: a gap of 36 points or more is a tab, and one of more than 2.4 is a space.
    const line = (...pieces: Array<[string, number]>): string => {
      const made = layoutLines(pieces.map(([text, x]) => run(text, x)), 1).lines;
      assert.equal(made.length, 1);
      return (made[0] as { text: string }).text;
    };
    assert.equal(line(["ab", 0], ["cd", 60]), "ab\tcd", "a tab where the gap is wide");
    assert.equal(line(["ab", 0], ["cd", 24]), "ab cd", "a space where it is not so wide");
    assert.equal(line(["ab", 0], ["cd", 12]), "abcd", "nothing where the pieces touch");
    assert.equal(line(["ab ", 0], ["cd", 60]), "ab cd", "no tab after a piece that ends in a space: the space is the gap");
    assert.equal(line(["ab", 0], [" cd", 60]), "ab cd", "and none before a piece that begins with one");
    assert.equal(line(["ab\t", 0], ["cd", 60]), "ab\tcd", "nor a second after a piece that ends in a tab");
    assert.equal(line(["ab\t", 0], ["cd", 24]), "ab\tcd", "nor a space after it");
    assert.equal(line(["ab ", 0], ["cd", 60]), "ab cd", "a no-break space is white space too");
    assert.equal(line(["ab", 0], ["cd", 60], ["ef", 120]), "ab\tcd\tef", "each wide gap has its own tab");
    assert.equal(line(["ab", 0], ["cd", 60], ["ef", 84]), "ab\tcd ef", "and the one after a tab is a space, since the text before it ends in a letter");
    assert.equal(line(["ab", 0], ["\t", 60], ["cd", 120]), "ab\tcd", "a piece that is a tab by itself is the tab, and the gaps beside it add none");
    assert.equal(line(["ab", 0], ["cd  ", 24]), "ab cd", "white space at the end of the line is cut");
    assert.equal(line(["ab", 0], ["cd \t  ", 24]), "ab cd", "whatever kinds of it there are");
    assert.equal(line(["  ab", 0], ["cd", 24]), "  ab cd", "and only at the end: the text of a line keeps the space in front of it, as it always did");
  });
});

describe("a PDF that nests too deeply", () => {
  // `[` repeated 200,000 times was 200,000 calls deep, and the reader's words were those of the engine: "Maximum call stack size exceeded".
  for (const where of ["trailer", "catalog", "pages", "page"] as const) {
    test(`with 200,000 open brackets in its ${where} is refused in the reader's own words and not with a RangeError's`, () => {
      const read = readTextInChild(deepNestPdf(where, 200_000));
      assert.equal(read.timedOut, false, `still reading after ${read.ms} ms`);
      assert.equal(read.refusedBy, "PdfError", `refused by ${read.refusedBy}: ${read.refused}`);
      assert.match(read.refused ?? "", /nested too deeply/);
      assert.doesNotMatch(read.refused ?? "", /call stack/);
    });
  }

  // (A `>` with a space after it: two together are the end of a dictionary.)
  for (const stray of [")", "> "]) {
    test(`a content stream of 200,000 stray ${stray.trim()} is read through, and the text after them is there`, () => {
      const read = readTextInChild(contentPdf(`${stray.repeat(200_000)}\n${HELLO}`));
      assert.equal(read.timedOut, false, `still reading after ${read.ms} ms`);
      assert.deepEqual(read.lines, [["Hello"]]);
      assert.doesNotMatch((read.notes ?? []).join("\n"), /call stack/);
    });
  }

  for (const [what, open] of [
    ["open brackets", "[".repeat(200_000)],
    ["dictionaries each in the one before", "<< /A ".repeat(200_000)],
  ] as const) {
    test(`a page of 200,000 ${what} is lost in the reader's words, and the other page is kept`, () => {
      const read = readTextInChild(twoPagePdf(`${open}\n${HELLO}`));
      assert.equal(read.timedOut, false, `still reading after ${read.ms} ms`);
      assert.deepEqual(read.lines, [[], ["Hello"]]);
      const notes = (read.notes ?? []).join("\n");
      assert.match(notes, /nested too deeply/);
      assert.doesNotMatch(notes, /call stack/);
    });
  }

  test("nesting up to the depth that is allowed is read, and one level more is not", () => {
    const nested = (depth: number): string => `${"[".repeat(depth)}${"]".repeat(depth)}`;
    const doc = new PdfDocument(assemble([...helloPieces(), { num: 6, body: nested(65) }, { num: 7, body: nested(66) }, { num: 8, body: `<< /A ${"<< /A ".repeat(65)}${">> ".repeat(65)}>>` }]));
    let value = doc.get(6);
    for (let level = 1; level < 65; level++) value = (value as unknown[])[0] as never;
    assert.deepEqual(value, [], "65 arrays, one in the next, are read to the bottom");
    assert.throws(() => doc.get(7), /nested too deeply/, "and 66 are not");
    assert.throws(() => doc.get(8), /nested too deeply/, "and the same is true of dictionaries");
  });
});

describe("a PDF whose objects never close", () => {
  // 5,000 objects of `N 0 obj [` made 64 KB, and each was read to the end of the file: 17 seconds. 10,000 of them did not end in a minute.
  test("10,000 of them, after a page that reads, are read in no more time than the length of the file", () => {
    const bytes = unterminatedPdf("objects", 10_000);
    assert.ok(bytes.length < 140_000, `a file of ${bytes.length} bytes`);
    const read = readTextInChild(bytes);
    assert.equal(read.timedOut, false, `still reading after ${read.ms} ms`);
    assert.deepEqual(read.lines, [["Hello"]]);
    assert.ok(read.ms < 5000, `read in ${read.ms} ms`);
  });

  // `trailer << ` repeated 20,000 times: the search for the next trailer began 7 bytes on, and each reading ran to the end of the file.
  test("20,000 words trailer and an open dictionary each are read in no more time than the length of the file", () => {
    const read = readTextInChild(unterminatedPdf("trailers", 20_000));
    assert.equal(read.timedOut, false, `still reading after ${read.ms} ms`);
    assert.deepEqual(read.lines, [["Hello"]]);
    assert.ok(read.ms < 5000, `read in ${read.ms} ms`);
  });

  // 100,000 objects that say `stream` and have no `endstream` (2.5 MB): each looked for the end of its data to the end of the file, 37 seconds.
  for (const closed of [false, true]) {
    test(`100,000 objects that say stream and ${closed ? "are followed by one endstream at the very end" : "have no endstream"} are read in no more time than the length of the file`, () => {
      const read = readTextInChild(unendedStreamsPdf(100_000, closed));
      assert.equal(read.timedOut, false, `still reading after ${read.ms} ms`);
      assert.deepEqual(read.lines, [["Hello"]]);
      assert.ok(read.ms < 8000, `read in ${read.ms} ms`);
    });
  }

  // What is found last is remembered, and the places asked about after it are answered from it. It must say what a search says.
  test("the finder of a word after a place says what a search for it says, for places asked in any order", () => {
    let seed = 99;
    const random = (n: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed >>> 8) % n;
    };
    const wrong: string[] = [];
    for (let round = 0; round < 3_000; round++) {
      // Text of a few letters in which the word "cab" is common and overlaps itself in no way, so that its places are many and close.
      const text = Buffer.from(Array.from({ length: random(60) }, () => "cabxyz"[random(6)]).join(""), "latin1");
      const finder = new WordFinder(text, "cab");
      const asked: number[] = [];
      for (let ask = 0; ask < 12; ask++) {
        const start = random(text.length + 3);
        asked.push(start);
        const expected = Buffer.from(text).indexOf("cab", start);
        const got = finder.after(start);
        if (got !== expected) wrong.push(`${text.toString("latin1")} from ${asked.join(", ")}: ${got} for ${expected}`);
      }
    }
    assert.deepEqual(wrong.slice(0, 3), []);
  });

  test("an object that never closes ends where the next begins, so that it holds only its own words", () => {
    const doc = new PdfDocument(assemble([...helloPieces(), { raw: "100 0 obj [ 1 2\n" }, { raw: "101 0 obj [ 3\n" }, { num: 102, body: "<< /X 1 >>" }], "trailer"));
    assert.deepEqual(doc.get(100), [1, 2]);
    assert.deepEqual(doc.get(101), [3]);
    assert.equal(doc.dict(doc.get(102) as never)?.get("X"), 1, "and the one that does close is read whole");
  });

  test("the last object of a file that never closes is read to the end of it", () => {
    const doc = new PdfDocument(assemble([...helloPieces(), { raw: "100 0 obj [ 1 2 3\n" }], "none"));
    assert.deepEqual(doc.get(100), [1, 2, 3]);
  });

  test("the data of a stream is looked for in the whole file: it may hold the words of an object, and a length that is wrong", () => {
    const content = `${HELLO}\n% 9 0 obj junk\n`;
    const pieces = helloPieces();
    pieces[3] = { raw: `4 0 obj\n<< /Length 3 >>\nstream\n${content}\nendstream\nendobj\n` };
    const read = readTextInChild(assemble(pieces, "trailer"));
    assert.equal(read.timedOut, false);
    assert.deepEqual(read.lines, [["Hello"]]);
  });

  test("two trailers, one after the other and each closed, are both read, and the later one wins", () => {
    const pieces = helloPieces();
    pieces.push({ raw: "trailer\n<< /Size 6 /Root 9 0 R /Marker (first) >>\n" });
    const doc = new PdfDocument(assemble(pieces, "trailer"));
    assert.ok(doc.trailer.has("Marker"), "the first trailer is read");
    assert.equal((doc.trailer.get("Root") as { num: number }).num, 1, "and the last one's root is the root");
  });
});

describe("a character map and the ends of its blocks", () => {
  // The search for the end of a block began one character after the beginning when it was moved on, which, with a beginning before
  // every word and one end at the very end, read to the end from each of 100,000 places.
  test("with a begin before each of 100,000 words and one end at the very end is read at once", () => {
    const read = readTextInChild(toUnicodePdf(2, true));
    assert.equal(read.timedOut, false, `still reading after ${read.ms} ms`);
    assert.equal(read.lines?.length, 1);
    assert.ok(read.ms < 5000, `read in ${read.ms} ms`);
  });
});

describe("a paragraph that ends in a hyphen", () => {
  // `/\S+$/` and `/([A-Za-zÀ-ɏ]+)-$/` were tried from every letter of a word: 80,000 letters then a space and a hyphen took 2 seconds
  // in each, and 400,000 would take a minute.
  test("after a word of 400,000 letters and a space is made into paragraphs at once", () => {
    const content = `BT /F1 12 Tf 36 700 Td (${"x".repeat(400_000)} -) Tj ET BT /F1 12 Tf 36 686 Td (next) Tj ET`;
    const run = inChild(contentPdf(content), `const { pdfToBlocks } = await engine("import/pdf.ts"); const r = pdfToBlocks(bytes); console.log(JSON.stringify({ blocks: r.blocks.length }));`);
    assert.equal(run.timedOut, false, `still reading after ${run.ms} ms`);
    assert.equal(run.status, 0, run.stderr);
    assert.equal((JSON.parse(run.stdout) as { blocks: number }).blocks, 1);
    assert.ok(run.ms < 8000, `read in ${run.ms} ms`);
  });

  test("keeps a hyphen that belongs to the word, and takes it out of a word that is spelt whole elsewhere", () => {
    const run = (first: string, second: string, vocabulary: string): string => {
      const out = inChild(
        contentPdf(`BT /F1 12 Tf 36 700 Td (${first}) Tj ET BT /F1 12 Tf 36 686 Td (${second}) Tj ET BT /F1 12 Tf 36 400 Td (${vocabulary}) Tj ET`),
        `const { pdfToBlocks } = await engine("import/pdf.ts"); console.log(JSON.stringify(pdfToBlocks(bytes).blocks.map((b) => b.text)));`,
      );
      assert.equal(out.status, 0, out.stderr);
      return (JSON.parse(out.stdout) as string[])[0] as string;
    };
    assert.equal(run("a writ-", "ten answer", "elsewhere writing"), "a writ-ten answer", "a word the document never spells whole keeps its hyphen");
    assert.equal(run("a self-", "concept here", "written elsewhere self"), "a self-concept here");
    assert.equal(run("the con-", "tent here", "content elsewhere"), "the content here", "a word spelt whole elsewhere is mended");
  });
});

describe("a table of objects that has millions of entries", () => {
  // /W [1 0 0] and /Index [0 8000000] over 8 million bytes of 1: 660 bytes of file, a Map of 8 million objects (670 MB), and a table
  // believed, so that the objects were looked for where it said and not found, and the page was lost.
  test("of one byte each, in a file of 700 bytes, is not believed, and the page is found by searching for its objects", () => {
    const bytes = tableBombPdf(8_000_000);
    assert.ok(bytes.length < 1500, `a file of ${bytes.length} bytes`);
    const read = readTextInChild(bytes, 20_000, heapOf(200));
    assert.equal(read.timedOut, false, `still reading after ${read.ms} ms`);
    assert.equal(read.status, 0, `the child ended with ${read.status}: ${read.stderr.slice(0, 300)}`);
    assert.deepEqual(read.lines, [["Hello"]]);
    assert.match((read.notes ?? []).join("\n"), /table of objects in this PDF was damaged/, "and the person is told how it was found");
  });

  // Free entries cost nothing to keep, so the line is on the rows and not on what is stored: two million is as many as a table may have.
  test("of two million rows, the first seven right and the rest free, is a table, and one row more is not", () => {
    const whole = readTextInChild(longTablePdf(2_000_000));
    assert.equal(whole.status, 0, whole.stderr);
    assert.deepEqual(whole.lines, [["Hello"]]);
    assert.doesNotMatch((whole.notes ?? []).join("\n"), /damaged/, "two million rows are believed");
    const over = readTextInChild(longTablePdf(2_000_001));
    assert.equal(over.status, 0, over.stderr);
    assert.deepEqual(over.lines, [["Hello"]]);
    assert.match((over.notes ?? []).join("\n"), /table of objects in this PDF was damaged/, "and 2,000,001 are not");
  });

  test("of a few hundred rows that are right is believed, and says nothing", () => {
    const read = readTextInChild(longTablePdf(300));
    assert.deepEqual(read.lines, [["Hello"]]);
    assert.doesNotMatch((read.notes ?? []).join("\n"), /damaged/);
  });
});

describe("fonts that share one description", () => {
  // 40 Type0 fonts of 145 bytes each, naming one descendant whose /W sets 420,000 widths: each made a map of 400,000 of them (700 MB).
  test("are made from the widths once: a hundred fonts of one descendant are read in a heap of 200 MB", () => {
    const read = readTextInChild(manyFontsPdf(100, false), 20_000, heapOf(200));
    assert.equal(read.timedOut, false, `still reading after ${read.ms} ms`);
    assert.equal(read.status, 0, `the child ended with ${read.status}: ${read.stderr.slice(0, 300)}`);
    assert.equal(read.lines?.length, 1);
  });

  test("and a hundred fonts that each have a description of their own are kept to the widths one document may set", () => {
    const read = readTextInChild(manyFontsPdf(100, true), 20_000, heapOf(200));
    assert.equal(read.timedOut, false, `still reading after ${read.ms} ms`);
    assert.equal(read.status, 0, `the child ended with ${read.status}: ${read.stderr.slice(0, 300)}`);
    assert.equal(read.lines?.length, 1);
  });

  // A /W array that lists the same 70,000-entry array again and again: a hundred thousand times seventy thousand widths, if it were all set.
  test("a /W that lists one array of 70,000 widths a hundred thousand times sets no more than the document's share", () => {
    const pieces: Piece[] = [
      { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
      { num: 2, body: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
      { num: 3, body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Contents 4 0 R >>" },
      { num: 4, dict: "", data: Buffer.from("BT /F1 12 Tf 72 700 Td <0041> Tj ET", "latin1") },
      { num: 5, body: `[${"500 ".repeat(70_000)}]` },
      { num: 6, body: "<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [7 0 R] >>" },
      { num: 7, body: `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X /DW 1000 /W [${"0 5 0 R ".repeat(100_000)}] >>` },
    ];
    const read = readTextInChild(assemble(pieces), 20_000, heapOf(200));
    assert.equal(read.timedOut, false, `still reading after ${read.ms} ms`);
    assert.equal(read.status, 0, `the child ended with ${read.status}: ${read.stderr.slice(0, 300)}`);
    assert.equal(read.lines?.length, 1);
    assert.ok(read.ms < 10_000, `read in ${read.ms} ms`);
  });
});

describe("the widths of a font", () => {
  /** A document with fonts, each naming one of the descendants (by its place in the list), whose /W arrays are the text given. */
  function fonts(descendants: string[], named: number[]): PdfFont[] {
    const pieces: Piece[] = [
      { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
      { num: 2, body: "<< /Type /Pages /Kids [] /Count 0 >>" },
    ];
    descendants.forEach((w, i) => pieces.push({ num: 10 + i, body: `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X /DW 1000 /W [${w}] >>` }));
    named.forEach((d, i) => pieces.push({ num: 100 + i, body: `<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [${10 + d} 0 R] >>` }));
    const doc = new PdfDocument(assemble(pieces));
    return named.map((_, i) => loadFont(doc, doc.get(100 + i)));
  }
  const widthOf = (font: PdfFont, code: number): number => (font.decode(Uint8Array.of(code >> 8, code & 255))[0] as { width: number }).width;
  const FULL = Array.from({ length: 65_536 }, (_, i) => 100 + (i % 800));

  // A real font has at most 65,536 codes, and none of them may lose its width to a budget that is for the files that are not real.
  for (const [what, w] of [
    ["one array of 65,536 widths", `0 [${FULL.join(" ")}]`],
    ["65,536 ranges of one code each", FULL.map((width, i) => `${i} ${i} ${width}`).join(" ")],
    ["65,536 arrays of one width each", FULL.map((width, i) => `${i} [${width}]`).join(" ")],
  ] as const) {
    test(`keeps every one of ${what}`, () => {
      const [font] = fonts([w], [0]);
      const wrong: number[] = [];
      for (let code = 0; code < 65_536; code++) if (widthOf(font as PdfFont, code) !== FULL[code]) wrong.push(code);
      assert.deepEqual(wrong.slice(0, 5), []);
    });
  }

  test("keeps a range of 65,536 codes whole, and a range of more than 70,000 only so far", () => {
    const [whole, long] = fonts(["0 65535 321", "0 99999 321"], [0, 1]) as [PdfFont, PdfFont];
    assert.equal(widthOf(whole, 65_535), 321);
    assert.equal(widthOf(long, 65_535), 321, "the codes a font can have are all inside the first 70,000");
  });

  test("are made from a budget that is one for the whole document, which fifteen full fonts do not use up and a sixteenth does", () => {
    const own = Array.from({ length: 17 }, (_, i) => `0 65535 ${200 + i}`);
    const font = fonts(own, own.map((_, i) => i));
    for (let i = 0; i < 15; i++) assert.equal(widthOf(font[i] as PdfFont, 65_535), 200 + i, `font ${i + 1} of 15 has its widths`);
    // 15 x 65,536 = 983,040 of the 1,000,000: the sixteenth has room for 16,960 codes and no more, and the seventeenth for none.
    assert.equal(widthOf(font[15] as PdfFont, 16_959), 215, "the sixteenth has the widths there is room for");
    assert.equal(widthOf(font[15] as PdfFont, 16_960), 1000, "and the rest are the default width");
    assert.equal(widthOf(font[16] as PdfFont, 0), 1000, "the seventeenth is the default throughout");
  });

  test("do not run out in one document because another one used its budget", () => {
    const greedy = Array.from({ length: 16 }, () => "0 65535 500").join(" ");
    const [first, second] = fonts([greedy, "0 65535 321"], [0, 1]) as [PdfFont, PdfFont];
    assert.equal(widthOf(first, 65_535), 500);
    assert.equal(widthOf(second, 0), 1000, "in a document where the first font used it up, the second has the default");
    const [alone] = fonts([greedy, "0 65535 321"], [1]) as [PdfFont];
    assert.equal(widthOf(alone, 0), 321, "and in a document of its own it has its widths");
    assert.equal(widthOf(alone, 65_535), 321);
  });

  test("of a description that two fonts name are set once, and the budget is spent once", () => {
    // Ten full ranges is 655,360 widths. Made twice, it is 1,310,720 and the third font's own would find nothing left.
    const shared = Array.from({ length: 10 }, () => "0 65535 500").join(" ");
    const [a, b, c] = fonts([shared, "0 65535 321"], [0, 0, 1]) as [PdfFont, PdfFont, PdfFont];
    assert.equal(widthOf(a, 65_535), 500);
    assert.equal(widthOf(b, 65_535), 500);
    assert.equal(widthOf(c, 0), 321);
    assert.equal(widthOf(c, 65_535), 321);
  });

  test("of a description a font does not have are the default, and a font with no /W has none", () => {
    const [none] = fonts([""], [0]) as [PdfFont];
    assert.equal(widthOf(none, 65), 1000);
  });
});

// ---------------------------------------------------------------------------
// ASCII85
// ---------------------------------------------------------------------------

/** The decoder as it was, when it made a string, took the white space out of it with a pattern, and kept the output as numbers in an array. */
function asciiEightyFiveAsItWas(data: Uint8Array): number[] {
  const text = Buffer.from(data).toString("latin1").replace(/\s+/g, "");
  const body = text.replace(/^<~/, "").replace(/~>.*$/s, "");
  const out: number[] = [];
  let group: number[] = [];
  for (const ch of body) {
    if (ch === "z" && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    group.push(ch.charCodeAt(0) - 33);
    if (group.length === 5) {
      let v = 0;
      for (const d of group) v = v * 85 + d;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      group = [];
    }
  }
  if (group.length > 1) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const d of group) v = v * 85 + d;
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...bytes.slice(0, n - 1));
  }
  return out;
}

describe("ASCII85", () => {
  /** A small deterministic generator, so that the same 100,000 inputs are tried each time. */
  function generator(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  test("gives what it gave on 100,000 inputs made of its digits, z, white space, the marks at either end, and bytes it does not know", () => {
    const random = generator(85);
    const below = (n: number): number => Math.floor(random() * n);
    const WHITE = [9, 10, 11, 12, 13, 32, 160];
    const ODD = [0, 1, 31, 32, 127, 128, 200, 255, 0x76, 0x77, 0x78, 0x79, 0x7b, 0x7c, 0x7d, 0x80];
    const byte = (): number => {
      const kind = below(12);
      if (kind < 6) return 33 + below(85); // a digit
      if (kind === 6) return 0x7a; // z
      if (kind === 7) return WHITE[below(WHITE.length)] as number;
      if (kind === 8) return [0x3c, 0x7e, 0x3e][below(3)] as number; // < ~ >
      return ODD[below(ODD.length)] as number;
    };
    const differences: string[] = [];
    for (let n = 0; n < 100_000; n++) {
      const bytes: number[] = [];
      if (random() < 0.3) bytes.push(...[0x3c, 0x7e].flatMap((c) => (random() < 0.15 ? [c, 32] : [c])));
      for (let i = below(41); i > 0; i--) bytes.push(byte());
      if (random() < 0.3) bytes.push(...[0x7e, 0x3e].flatMap((c) => (random() < 0.15 ? [32, c] : [c])), ...Array.from({ length: below(6) }, byte));
      const input = Uint8Array.from(bytes);
      const got = [...ascii85(input)];
      const want = asciiEightyFiveAsItWas(input);
      if (got.length !== want.length || got.some((v, i) => v !== want[i])) differences.push(`${JSON.stringify(Buffer.from(input).toString("latin1"))}: ${got} for ${want}`);
    }
    assert.deepEqual(differences.slice(0, 5), []);
  });

  test("decodes the text of a book and stops at the end mark", () => {
    const text = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, "latin1"));
    // "Man is distinguished" is the example the format is explained with.
    assert.equal(Buffer.from(ascii85(text("9jqo^BlbD-BleB1DJ+*+F(f,q"))).toString("latin1"), "Man is distinguished");
    assert.equal(Buffer.from(ascii85(text("<~9jqo^BlbD-BleB1DJ+*+F(f,q~>junk after the mark"))).toString("latin1"), "Man is distinguished");
    assert.equal(Buffer.from(ascii85(text("9jqo^ Blb D-Ble\nB1DJ+*\t+F(f,q"))).toString("latin1"), "Man is distinguished", "white space is nothing");
    assert.deepEqual([...ascii85(text("z"))], [0, 0, 0, 0], "z is four zero bytes");
    assert.deepEqual([...ascii85(text("!!z!!"))], [0, 9, 207, 209], "and is a digit, like any other, in the middle of a group");
    assert.deepEqual([...ascii85(text("<~ ~>"))], []);
    assert.deepEqual([...ascii85(text("< ~!!!!!~ >"))], [0, 0, 0, 0], "a mark with white space in the middle of it is a mark");
  });

  test("stops at the limit, in the reader's words, before a group that would pass it is written", () => {
    const zeros = Uint8Array.from(Buffer.from("!".repeat(500), "latin1")); // 100 groups: 400 bytes
    assert.equal(ascii85(zeros, 400).length, 400, "at the limit it is all there");
    assert.throws(() => ascii85(zeros, 399), (error: unknown) => error instanceof PdfError && /unpacks to more than a test bank could hold/.test(error.message));
    const z = Uint8Array.from(Buffer.from("z".repeat(100), "latin1"));
    assert.equal(ascii85(z, 400).length, 400);
    assert.throws(() => ascii85(z, 399), PdfError, "a z is four bytes and is counted as four");
    const partial = Uint8Array.from(Buffer.from("!!!", "latin1")); // two bytes
    assert.equal(ascii85(partial, 2).length, 2);
    assert.throws(() => ascii85(partial, 1), PdfError, "and so is the last group, which is not whole");
  });

  // The output grows by doubling. Grown by what is needed, a million z (four million zeros) was a million copies of an array of megabytes.
  test("a million z are four million zeros, in time that grows with the z and not with their square", () => {
    const run = inChild(
      Uint8Array.from(Buffer.alloc(1_000_000, 0x7a)),
      `const { ascii85 } = await engine("import/pdf/document.ts"); const t = performance.now(); const out = ascii85(bytes); console.log(JSON.stringify({ length: out.length, zeros: out.every((b) => b === 0), ms: Math.round(performance.now() - t) }));`,
    );
    assert.equal(run.timedOut, false, `still unpacking after ${run.ms} ms`);
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout) as { length: number; zeros: boolean; ms: number };
    assert.equal(out.length, 4_000_000);
    assert.ok(out.zeros);
    assert.ok(out.ms < 3000, `unpacked in ${out.ms} ms`);
  });

  // 800 bytes of file were 40 million bytes of zeros, each a number in an array: 895 MB, and with a heap of 256 MB the process was gone.
  test("a stream of 32 million bytes, in a file of 300 bytes, is unpacked in a heap of 128 MB", () => {
    const bytes = ascii85Pdf(40_000_000);
    assert.ok(bytes.length < 1000, `a file of ${bytes.length} bytes`);
    const read = readTextInChild(bytes, 20_000, heapOf(128));
    assert.equal(read.timedOut, false, `still reading after ${read.ms} ms`);
    assert.equal(read.status, 0, `the child ended with ${read.status}: ${read.stderr.slice(0, 300)}`);
    assert.deepEqual(read.lines, [["Hello"]]);
  });
});
