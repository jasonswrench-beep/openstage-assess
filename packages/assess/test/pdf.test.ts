/**
 * Reading a PDF for its questions. The rules under test are the importer's usual ones (a key is read only where the page writes
 * one down, nothing is dropped without a word, a question that cannot be built is kept and fails) and the ones a page adds: what
 * a line is, what a paragraph is, what is on every page and is not part of the text, and what a PDF cannot say at all.
 *
 * The PDFs here are made by test/support/pdf-builder.ts, which is not a program that people use. The measure against files that
 * real programs wrote is `pdf-publisher.test.ts`, which runs when the private fixtures are on the machine.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import { importerForContent } from "../src/import/registry.ts";
import { looksLikePdf, pdfImporter, pdfToBlocks } from "../src/import/pdf.ts";
import { PdfDocument } from "../src/import/pdf/document.ts";
import { PdfError, PdfName, PdfRef, PdfStream, PdfString, type PdfObject } from "../src/import/pdf/objects.ts";
import { readPdfText } from "../src/import/pdf/reader.ts";
import { assembleParagraphs } from "../src/import/pdf/paragraphs.ts";
import { FindingCode, liveFindings, verdictFrom } from "../src/model/findings.ts";
import { richTextToPlain } from "../src/model/richtext.ts";
import { createQuestion } from "../src/model/create.ts";
import { plainToRich } from "../src/model/richtext.ts";
import { printOptions, printTest } from "../src/print/index.ts";
import type { Question, QuestionBody } from "../src/model/question.ts";
import { assemble, helloPieces, inChild, readTextInChild, tableStreamPdf, type Piece } from "./support/hostile-pdf.ts";
import { at, atCodes, buildPdf, type FontSpec, type PdfSpec } from "./support/pdf-builder.ts";

const WIDTHS = Array.from({ length: 224 }, () => 500);
const REGULAR: FontSpec = { kind: "simple", base: "Helvetica", widths: WIDTHS };
const BOLD: FontSpec = { kind: "simple", base: "Helvetica-Bold", widths: WIDTHS };
const FONTS = { F1: REGULAR, F2: BOLD };

const OPTIONS = { file: "bank.pdf", at: "2026-01-01T00:00:00.000Z", author: "test" };

/** One page of lines of text from the top down, 14 points apart; an empty string leaves room for a line. */
function page(lines: string[], top = 740, step = 14, x = 36): string {
  return lines.map((text, i) => (text === "" ? "" : at(x, top - i * step, 12, text))).join("");
}

const pdf = (spec: Partial<PdfSpec> & Pick<PdfSpec, "pages">): Uint8Array => buildPdf({ fonts: FONTS, ...spec });
const linesOf = (bytes: Uint8Array): string[][] => readPdfText(bytes).pages.map((p) => p.lines.map((l) => l.text));
const blocksOf = (bytes: Uint8Array): string[] => pdfToBlocks(bytes).blocks.map((b) => b.text);
const read = (pages: string[], extra: Partial<PdfSpec> = {}) => pdfImporter.parseBytes(pdf({ pages, ...extra }), OPTIONS);
const plain = (q: Question): string => richTextToPlain(q.stem);
const options = (q: Question): Array<[string, boolean]> =>
  ((q.body as unknown as { options: Array<{ content: unknown; correct: boolean }> }).options ?? []).map((o) => [richTextToPlain(o.content as never), o.correct]);
const verdict = (q: Question): string => verdictFrom(q.findings);
const has = (q: Question, code: string): boolean => liveFindings(q.findings).some((f) => f.code === code);
const notes = (bytes: Uint8Array): string => readPdfText(bytes).notes.map((n) => n.message).join("\n");
const fileNotes = (r: ReturnType<typeof read>): string => r.fileFindings.map((f) => f.message).join("\n");

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

describe("the lines of a page", () => {
  test("come out from the top down whatever order they were drawn in", () => {
    const content = at(36, 700, 12, "third") + at(36, 740, 12, "first") + at(36, 720, 12, "second");
    assert.deepEqual(linesOf(pdf({ pages: [content] }))[0], ["first", "second", "third"]);
  });

  test("pieces of one line are one line, with a space only where there is a gap", () => {
    // Each character is half the size wide here, 6 points at 12, so "Hel" ends at 54 and "lo" starts there: no gap. "world" starts
    // 12 points after "lo" ends: a gap of two characters, which is a space.
    const content = at(36, 700, 12, "Hel") + at(54, 700, 12, "lo") + at(78, 700, 12, "world");
    assert.deepEqual(linesOf(pdf({ pages: [content] }))[0], ["Hello world"]);
  });

  test("a number inside a TJ array is kerning when it is small and a space when it is large", () => {
    const small = "BT /F1 12 Tf 36 700 Td [(Hel) -30 (lo)] TJ ET\n";
    const large = "BT /F1 12 Tf 36 700 Td [(Hel) -600 (lo)] TJ ET\n";
    assert.deepEqual(linesOf(pdf({ pages: [small] }))[0], ["Hello"]);
    assert.deepEqual(linesOf(pdf({ pages: [large] }))[0], ["Hel lo"]);
  });

  test("a gap of several letters is a tab, as the space after a label or between columns is", () => {
    const content = at(36, 700, 12, "479") + at(100, 700, 12, "Instructor's Manual");
    assert.deepEqual(linesOf(pdf({ pages: [content] }))[0], ["479\tInstructor's Manual"]);
  });

  test("a subscript stays on its line, and a heading does not join the line below it", () => {
    // The subscript is six points under the baseline and seven points high: far enough that two ordinary lines would be two.
    const content = at(36, 700, 12, "H") + at(42, 694, 7, "0") + at(46, 700, 12, ": mu = 1") + at(36, 660, 16, "A heading");
    assert.deepEqual(linesOf(pdf({ pages: [content] }))[0], ["H0: mu = 1", "A heading"]);
  });

  test("text that is turned is not read, and the file says so", () => {
    const content = at(36, 700, 12, "upright") + "BT /F1 12 Tf 0 1 -1 0 300 300 Tm (sideways) Tj ET\n";
    const bytes = pdf({ pages: [content] });
    assert.deepEqual(linesOf(bytes)[0], ["upright"]);
    assert.match(notes(bytes), /turned or upside down on page 1/);
  });

  test("a font with a map of its codes is read through it, with its own widths", () => {
    const composite: FontSpec = { kind: "composite", base: "Test", codes: [[1, "O"], [2, "K"], [3, " "], [4, "?"]], width: 500 };
    const content = atCodes(36, 700, 12, [1, 2, 3, 4], "F3");
    assert.deepEqual(linesOf(pdf({ pages: [content], fonts: { ...FONTS, F3: composite } }))[0], ["OK ?"]);
  });

  test("the width a font gives for its codes decides what is a gap: 'OK' ends at 48, so a piece at 54 is a space after it", () => {
    const composite: FontSpec = { kind: "composite", base: "Test", codes: [[1, "O"], [2, "K"]], width: 500 };
    // If the font's widths were ignored for the default of a full em, "OK" would end at 60 and the piece at 54 would run into it.
    const content = atCodes(36, 700, 12, [1, 2], "F3") + at(54, 700, 12, "x");
    assert.deepEqual(linesOf(pdf({ pages: [content], fonts: { ...FONTS, F3: composite } }))[0], ["OK x"]);
  });

  test("a simple font's own map of its codes wins over its encoding", () => {
    const font: FontSpec = { kind: "simple", base: "Times", widths: WIDTHS, simpleMap: [[65, "Z"], [66, "Y"]] };
    assert.deepEqual(linesOf(pdf({ pages: [at(36, 700, 12, "ABC", "F4")], fonts: { ...FONTS, F4: font } }))[0], ["ZYC"]);
  });

  test("codes the file never says the meaning of are counted, not passed off as text", () => {
    const composite: FontSpec = { kind: "composite", base: "Test", codes: [[1, "O"]], width: 500 };
    const bytes = pdf({ pages: [atCodes(36, 700, 12, [1, 9], "F3")], fonts: { ...FONTS, F3: composite } });
    assert.match(notes(bytes), /could not be read, because the file does not say what its font's characters are/);
  });

  test("an encoding's list of changes is applied", () => {
    const font: FontSpec = { kind: "simple", base: "Times", widths: WIDTHS, differences: [[65, "bullet"], [66, "endash"]] };
    const bytes = pdf({ pages: [at(36, 700, 12, "AB!", "F4")], fonts: { ...FONTS, F4: font } });
    assert.deepEqual(linesOf(bytes)[0], ["•–!"]);
  });

  test("a PDF written in the modern way (packed objects, a stream for the table, compressed) reads the same as the old way", () => {
    const content = page(["1. Which?", "a. One", "b. Two"]);
    const old = linesOf(pdf({ pages: [content] }));
    assert.deepEqual(linesOf(pdf({ pages: [content], modern: true, compress: true })), old);
    assert.deepEqual(old[0], ["1. Which?", "a. One", "b. Two"]);
  });

  test("several pages are read in order", () => {
    const bytes = pdf({ pages: [page(["page one"]), page(["page two"])] });
    assert.deepEqual(linesOf(bytes), [["page one"], ["page two"]]);
  });
});

// ---------------------------------------------------------------------------
// A file that cannot be read the usual way
// ---------------------------------------------------------------------------

describe("a PDF that is not in order", () => {
  test("whose table of objects is wrong is read by finding its objects, and says it was", () => {
    const bytes = pdf({ pages: [page(["still here"])], damagedTable: true });
    assert.deepEqual(linesOf(bytes)[0], ["still here"]);
    assert.match(notes(bytes), /table of objects in this PDF was damaged/);
  });

  test("that is protected is refused, with what to do, and nothing is read", () => {
    assert.throws(() => readPdfText(pdf({ pages: [page(["secret"])], encrypted: true })), (e: unknown) => e instanceof PdfError && /protected/.test(e.message) && /unprotected|not protected/.test(e.message));
  });

  test("that is not a PDF is refused", () => {
    assert.throws(() => new PdfDocument(new TextEncoder().encode("hello, this is text")), (e: unknown) => e instanceof PdfError && /not a PDF/.test(e.message));
    assert.throws(() => new PdfDocument(new Uint8Array(0)), (e: unknown) => e instanceof PdfError && /empty/.test(e.message));
  });

  test("with no text in it (a scan) is refused with the reason and the way round, and is not read as an empty bank", () => {
    const bytes = pdf({ pages: ["0.5 g 100 100 200 200 re f\n"] });
    assert.throws(() => readPdfText(bytes), (e: unknown) => e instanceof PdfError && /probably a scan/.test(e.message) && /original document/.test(e.message));
  });

  test("whose content was cut short still gives the text before the cut", () => {
    // A page of forty lines, compressed, with the last eight bytes of its content gone: what was written before the cut is there.
    const many = Array.from({ length: 40 }, (_, i) => `line number ${i + 1} of the page`);
    const bytes = pdf({ pages: [page(many, 760, 15)], compress: true, truncateContent: 8 });
    const lines = readPdfText(bytes).pages[0]?.lines.map((l) => l.text) ?? [];
    assert.ok(lines.length >= 30, `only ${lines.length} lines survived the cut`);
    assert.equal(lines[0], "line number 1 of the page");
  });

  test("whose streams declare a length that is wrong is read to where the stream really ends", () => {
    const bytes = pdf({ pages: [page(["still all here", "and here"])], wrongLength: true });
    assert.deepEqual(linesOf(bytes)[0], ["still all here", "and here"]);
  });

  test("that holds an earlier copy of the word its end is found by is read from the last, and not as damaged", () => {
    const bytes = pdf({ pages: [page(["read from the end"])], staleStartxref: true });
    assert.deepEqual(linesOf(bytes)[0], ["read from the end"]);
    assert.doesNotMatch(notes(bytes), /damaged/);
  });

  test("one of whose pages cannot be unpacked loses that page, says which, and keeps the others", () => {
    const bytes = pdf({ pages: [page(["page one is fine"]), page(["page two is not"]), page(["page three is fine"])], compress: true, badPage: 1 });
    const result = readPdfText(bytes);
    assert.deepEqual(result.pages.map((p) => p.lines.length), [1, 0, 1]);
    assert.match(result.notes.map((n) => n.message).join("\n"), /A page could not be read[^.]*page 2/);
  });

  // Found by reading the loop's bound: a row of no bytes never moved the loop on, and a PDF of 509 bytes held the program for as long
  // as it was left. It is tried in a process of its own with a time limit, so that a return of the fault fails this test and does not
  // freeze every test after it.
  for (const parms of [
    "<< /Predictor 2 /Columns 0 >>",
    "<< /Predictor 2 /Columns -3 >>",
    "<< /Predictor 2 /Colors 0 /Columns 4 >>",
    "<< /Predictor 2 /Columns 4 /BitsPerComponent 0 >>",
    "<< /Predictor 12 /Columns 0 >>",
    "<< /Predictor 15 /Columns -1 >>",
    // Found by a second reader: each number is above 0 and their product is not. Both are written as a decimal with 200 zeros.
    `<< /Predictor 2 /Columns 0.${"0".repeat(200)}1 /Colors 0.${"0".repeat(200)}1 >>`,
    // And values that passed the first check and lost the page without a word: not whole, too wide for a page, a depth there is not.
    "<< /Predictor 2 /Columns 3.7 >>",
    "<< /Predictor 12 /Columns 2147483648 >>",
    `<< /Predictor 12 /Columns 1${"0".repeat(308)} >>`,
    "<< /Predictor 12 /Columns 4 /BitsPerComponent 3 >>",
    "<< /Predictor 15 /Columns 0.5 >>",
  ]) {
    test(`a stream whose rows have no width (${parms.length > 60 ? `${parms.slice(0, 45)}…` : parms}) is refused for that page in words, and does not hold the program`, () => {
      const bytes = pdf({ pages: [page(["page one is fine"]), page(["page two is not"]), page(["page three is fine"])], compress: true, parmsPage: 1, decodeParms: parms });
      const dir = mkdtempSync(join(tmpdir(), "openassess-pdf-"));
      try {
        const file = join(dir, "rows.pdf");
        writeFileSync(file, bytes);
        const reader = new URL("../src/import/pdf/reader.ts", import.meta.url).href;
        const script = `import { readFileSync } from "node:fs"; import { readPdfText } from ${JSON.stringify(reader)}; const r = readPdfText(new Uint8Array(readFileSync(process.argv[1]))); console.log(JSON.stringify({ lines: r.pages.map((p) => p.lines.length), notes: r.notes.map((n) => n.message) }));`;
        const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script, file], { encoding: "utf8", timeout: 20_000 });
        assert.equal(run.error, undefined, `it did not finish: ${run.error?.message}`);
        assert.equal(run.status, 0, run.stderr);
        const out = JSON.parse(run.stdout) as { lines: number[]; notes: string[] };
        assert.deepEqual(out.lines, [1, 0, 1], "the page with the bad rows is lost and the others are kept");
        assert.match(out.notes.join("\n"), /A page could not be read[^.]*page 2[^]*cannot be right/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test("a stream that uses no predictor is left alone whatever its other parameters say, since they mean nothing to it", () => {
    for (const parms of ["<< /Predictor 1 /Columns 0 /Colors 0 /BitsPerComponent 3 >>", "<< /Columns 0 >>", "<< /Predictor 3 /Columns -2 >>"]) {
      const bytes = pdf({ pages: [page(["page one is fine"]), page(["page two is fine too"])], compress: true, parmsPage: 1, decodeParms: parms });
      assert.deepEqual(linesOf(bytes), [["page one is fine"], ["page two is fine too"]], parms);
      assert.doesNotMatch(notes(bytes), /cannot be right/, parms);
    }
  });
});

// ---------------------------------------------------------------------------
// What is on every page and is not the text
// ---------------------------------------------------------------------------

describe("the furniture of a page", () => {
  const body = (n: number): string => at(36, 700, 12, `${n}. A question that has an answer?`) + at(36, 686, 12, "a. one") + at(36, 672, 12, "b. two");

  test("a page number alone, and a running title that repeats, are left out, and the file says how many and quotes one", () => {
    const pages = [1, 2, 3].map((n) => body(n) + at(297, 27, 12, String(470 + n)) + at(36, 44, 12, `Chapter ${n} Instructor's Manual`));
    const bytes = pdf({ pages });
    const result = readPdfText(bytes);
    assert.deepEqual(result.pages.map((p) => p.lines.length), [3, 3, 3]);
    const note = result.notes.map((n) => n.message).join("\n");
    assert.match(note, /6 lines at the top or bottom of the pages/);
    assert.match(note, /Instructor's Manual/);
  });

  test("the last option of two pages that read the same is not a running title", () => {
    const pages = [1, 2].map((n) => at(36, 700, 12, `${n}. Which?`) + at(36, 686, 12, "a. yes") + at(36, 40, 12, "d. none of the above"));
    assert.deepEqual(linesOf(pdf({ pages })).map((l) => l[l.length - 1]), ["d. none of the above", "d. none of the above"]);
  });

  // A real book (a true or false quiz that went across a page): "8. AI IN EVERYDAY LIFE | 531" at the top of the odd pages began like a
  // question, was never taken for a running title, was read as question 8, and took the answer of the question before it.
  test("a running title that begins with a number, the same on every page but for the page number, is left out", () => {
    const pages = [1, 2, 3, 4].map((n) => body(n) + at(36, 770, 12, `8. AI IN EVERYDAY LIFE  |  ${530 + n}`));
    const result = readPdfText(pdf({ pages }));
    assert.deepEqual(result.pages.map((p) => p.lines.length), [3, 3, 3, 3]);
    assert.deepEqual(result.pages.map((p) => p.lines[0]?.text), ["1. A question that has an answer?", "2. A question that has an answer?", "3. A question that has an answer?", "4. A question that has an answer?"]);
    const note = result.notes.map((n) => n.message).join("\n");
    assert.match(note, /4 lines at the top or bottom of the pages/);
    assert.match(note, /AI IN EVERYDAY LIFE/);
  });

  test("a numbered line is not a running title when it is on fewer than three pages, is the same words with the same page, or has another question's number", () => {
    const top = (n: number, text: string) => body(n) + at(36, 770, 12, text);
    const kept = (pages: string[]) => linesOf(pdf({ pages })).map((l) => l[0]);
    assert.deepEqual(kept([top(1, "8. AI IN EVERYDAY LIFE  |  531"), top(2, "8. AI IN EVERYDAY LIFE  |  533")]), ["8. AI IN EVERYDAY LIFE  |  531", "8. AI IN EVERYDAY LIFE  |  533"], "two pages are not enough");
    assert.deepEqual(kept([1, 2, 3].map((n) => top(n, "8. Which of these is 5?"))), ["8. Which of these is 5?", "8. Which of these is 5?", "8. Which of these is 5?"], "the same text each time has no page number in it");
    assert.deepEqual(kept([top(1, "12. Simplify 3 + 4"), top(2, "13. Simplify 5 + 6"), top(3, "14. Simplify 7 + 8")]), ["12. Simplify 3 + 4", "13. Simplify 5 + 6", "14. Simplify 7 + 8"], "different question numbers are different questions");
  });

  test("a page number is left out even on a PDF of one page", () => {
    const bytes = pdf({ pages: [body(1) + at(297, 27, 12, "42")] });
    assert.deepEqual(linesOf(bytes)[0]?.length, 3);
  });
});

describe("a page set in columns", () => {
  test("is said to be, because its lines were read across: long text on both sides of a wide gap, several times over", () => {
    const rows = [0, 1, 2, 3].map((i) => at(36, 700 - i * 14, 12, "the left column has a whole line here") + at(320, 700 - i * 14, 12, "and the right column has one too"));
    assert.match(notes(pdf({ pages: [rows.join("")] })), /Page 1 looks as if set in columns/);
  });

  test("is not said of a table, whose cells are short, nor of one line with a gap in it", () => {
    const table = [0, 1, 2, 3].map((i) => at(36, 700 - i * 14, 12, "Agree") + at(200, 700 - i * 14, 12, "Neutral") + at(360, 700 - i * 14, 12, "Disagree"));
    assert.doesNotMatch(notes(pdf({ pages: [table.join("")] })), /columns/);
    const one = at(36, 700, 12, "the left column has a whole line here") + at(320, 700, 12, "and the right column has one too");
    assert.doesNotMatch(notes(pdf({ pages: [one] })), /columns/);
  });
});

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

describe("a picture on a page", () => {
  test("is marked where it was drawn, set apart from the text round it, and counted in the notes", () => {
    const content = at(36, 740, 12, "1. Look at the figure.") + "q 200 0 0 100 50 500 cm /Im0 Do Q\n" + at(36, 400, 12, "2. And then?");
    const bytes = pdf({ pages: [content], image: true });
    // A blank line on each side: the picture is no part of the stem above it, and no start of the question below.
    assert.deepEqual(blocksOf(bytes), ["1. Look at the figure.", "", "[Picture]", "", "2. And then?"]);
    assert.match(notes(bytes), /A picture on page 1 cannot be read as text/);
  });

  test("never joins a line of text that it stands beside", () => {
    // The marker is set a line's height under the picture's top: here at y = 600, level with a line of text there.
    const content = at(36, 600, 12, "text level with the picture's top") + "q 100 0 0 100 400 512 cm /Im0 Do Q\n";
    assert.deepEqual(blocksOf(pdf({ pages: [content], image: true })).filter((t) => t !== ""), ["text level with the picture's top", "[Picture]"]);
  });

  test("that is only a speck is not one", () => {
    const content = at(36, 740, 12, "text") + "q 4 0 0 4 50 500 cm /Im0 Do Q\n";
    assert.deepEqual(blocksOf(pdf({ pages: [content], image: true })).filter((t) => t !== ""), ["text"]);
  });

  test("never ends up inside an option", () => {
    const content = page(["1. Which?", "a. one", "b. two"]) + "q 200 0 0 100 50 600 cm /Im0 Do Q\n";
    const r = pdfImporter.parseBytes(pdf({ pages: [content], image: true }), OPTIONS);
    for (const q of r.questions) for (const [text] of options(q)) assert.equal(text.includes("[Picture]"), false);
  });
});

// ---------------------------------------------------------------------------
// Paragraphs
// ---------------------------------------------------------------------------

describe("paragraphs", () => {
  const long = "x".repeat(70);

  test("a line that wraps goes on from the line above, and a label starts a new one", () => {
    const bytes = pdf({ pages: [page(["1. A stem that runs on", "to a second line?", "a. one", "b. two"])] });
    assert.deepEqual(blocksOf(bytes), ["1. A stem that runs on to a second line?", "a. one", "b. two"]);
  });

  test("a blank line goes before a new question, and not before the options under its stem", () => {
    // 28 points above the question, 14 between options, and 21 between the stem and its first option: a page's own rhythm, in
    // which 14 is the usual step.
    const question = (n: number, top: number): string =>
      at(36, top, 12, `${n}. Question?`) + at(36, top - 21, 12, "a. one") + at(36, top - 35, 12, "b. two") + at(36, top - 49, 12, "c. three") + at(36, top - 63, 12, "d. four");
    const content = question(1, 740) + question(2, 740 - 63 - 28);
    const out = blocksOf(pdf({ pages: [content] }));
    assert.deepEqual(out, ["1. Question?", "a. one", "b. two", "c. three", "d. four", "", "2. Question?", "a. one", "b. two", "c. three", "d. four"]);
  });

  test("a line that begins like a field only when it has a capital and a colon is one: a wrapped 'reference:' is not", () => {
    const bytes = pdf({ pages: [page(["Answer: b. Two. (Textbook", "reference: Section 4)", "2. Next?"])] });
    assert.deepEqual(blocksOf(bytes), ["Answer: b. Two. (Textbook reference: Section 4)", "2. Next?"].slice(0, 1).concat(["2. Next?"]));
  });

  test("a list spaced wide that fills its lines goes on after the full line, and a short line ends its paragraph", () => {
    const content =
      at(36, 740, 12, `a. ${long}${long}`) + at(36, 722, 12, "second part of a") + // 18 points below a full line: the same paragraph
      at(36, 704, 12, "b. short") + at(36, 686, 12, "stray text") + // 18 points below a short line: a new paragraph
      at(36, 668, 12, "c. last");
    const out = blocksOf(pdf({ pages: [content] })).filter((t) => t !== "");
    assert.equal(out.length, 4);
    assert.ok((out[0] as string).endsWith("second part of a"));
    assert.equal(out[2], "stray text");
  });

  test("a word broken at the end of a line keeps its hyphen, with no space, unless the document spells it whole elsewhere", () => {
    const kept = blocksOf(pdf({ pages: [page(["1. Every self-", "concept test is writ-", "ten down."])] }));
    assert.deepEqual(kept, ["1. Every self-concept test is writ-ten down."]);
    const mended = blocksOf(pdf({ pages: [page(["1. Every self-", "concept test is writ-", "ten down.", "2. It was written.", "3. Self-concept counts."])] }));
    assert.equal(mended[0], "1. Every self-concept test is written down.");
  });

  test("the paragraphs of two pages join where a paragraph runs over", () => {
    const bytes = pdf({ pages: [page(["1. A stem that runs"], 120, 14), page(["on to the next page?", "a. one", "b. two"], 750)] });
    assert.deepEqual(blocksOf(bytes), ["1. A stem that runs on to the next page?", "a. one", "b. two"]);
  });

  test("assembleParagraphs, given no lines, gives none", () => {
    assert.deepEqual(assembleParagraphs([{ number: 1, lines: [] }]).paragraphs, []);
  });
});

// ---------------------------------------------------------------------------
// Questions from a PDF
// ---------------------------------------------------------------------------

describe("questions in a PDF", () => {
  const bank = [
    "Chapter 3 Test Items",
    "",
    "1. Which planet is closest to the Sun?",
    "a. Venus",
    "*b. Mercury",
    "c. Earth",
    "d. Mars",
    "",
    "2. What force holds the planets in orbit?",
    "a. Friction",
    "b. Gravity *",
    "c. Static",
  ];
  // 28 points between questions and 14 between lines: the page's own rhythm.
  const tall = (lines: string[]): string => lines.map((t, i) => (t === "" ? "" : at(36, 740 - i * 14 - (lines.slice(0, i).filter((x) => x === "").length * 0), 12, t))).join("");

  test("a numbered question with lettered options and an asterisk reads, with its key, as it does from Word", () => {
    const r = read([tall(bank)]);
    assert.equal(r.questions.length, 2);
    assert.deepEqual(options(r.questions[0] as Question), [["Venus", false], ["Mercury", true], ["Earth", false], ["Mars", false]]);
    assert.equal(plain(r.questions[0] as Question), "Which planet is closest to the Sun?");
    assert.equal(r.profile, "pdf");
  });

  test("an Answer line that gives the letter and the option's own words is a key", () => {
    const r = read([page(["1. Which planet is closest?", "a. Venus", "b. Mercury", "c. Earth", "Answer: b. Mercury. (Textbook reference: Section 1)"])]);
    assert.deepEqual(options(r.questions[0] as Question).map((o) => o[1]), [false, true, false]);
    assert.equal(verdict(r.questions[0] as Question), "parsed");
  });

  test("an Answer line whose letter and words name different options is no key, and says both", () => {
    const r = read([page(["1. Which planet is closest?", "a. Venus", "b. Mercury", "c. Earth", "Answer: a. Mercury."])]);
    const q = r.questions[0] as Question;
    assert.deepEqual(options(q).map((o) => o[1]), [false, false, false]);
    assert.ok(has(q, FindingCode.KeysDisagree));
    assert.match(liveFindings(q.findings).find((f) => f.code === FindingCode.KeysDisagree)?.message ?? "", /Mercury/);
    assert.equal(verdict(q), "failed");
  });

  test("an Answer line of prose is not mined for letters: the article 'a' is not option A", () => {
    const r = read([page(["1. What holds the planets in orbit?", "a. Magic", "b. Gravity", "c. Luck", "Answer: c. Gravity holds a planet in its orbit around a star."])]);
    const q = r.questions[0] as Question;
    assert.deepEqual(options(q).map((o) => o[1]), [false, false, false], "no key is made up from the word a");
    assert.equal(verdict(q), "failed");
  });

  test("a bold option is not a key: formatting is never read from a PDF", () => {
    const content = at(36, 740, 12, "1. Which?") + at(36, 726, 12, "a. one") + at(36, 712, 12, "b. two", "F2") + at(36, 698, 12, "c. three");
    const r = read([content]);
    assert.deepEqual(options(r.questions[0] as Question).map((o) => o[1]), [false, false, false]);
    assert.equal(verdict(r.questions[0] as Question), "failed");
  });

  test("a heading of True and False gives the questions under it their type", () => {
    // As a publisher sets it: the options are the two words, and the key is an Answer line. Without the heading this is a choice
    // question with two options; with it, a true or false question.
    const r = read([page(["True and False", "", "1. The Sun is a star.", "a. True", "b. False", "Answer: a. True. (Textbook reference: Section 1)"])]);
    assert.equal(r.questions[0]?.type, "trueFalse");
    assert.equal((r.questions[0]?.body as unknown as { correct?: boolean }).correct, true);
  });

  test("a question number with a doubled full stop is the number", () => {
    // No room between them: the number is what tells the second question from the end of the first one's options.
    const r = read([page(["12. First?", "*a. yes", "b. no", "13.. Second?", "a. yes", "*b. no"])]);
    assert.equal(r.questions.length, 2);
    assert.equal(plain(r.questions[1] as Question), "Second?");
  });

  test("the file always says it was read from a page, and what that costs", () => {
    const r = read([page(["1. Which?", "*a. one", "b. two"])]);
    assert.equal(r.fileFindings[0]?.severity, "warn");
    assert.match(fileNotes(r), /read from the words on the pages alone/);
    assert.match(fileNotes(r), /Check each question against the PDF, and the answers most of all/);
  });

  test("the source lines say the page, and a question's source points at its paragraph", () => {
    const r = read([page(["1. Which?", "*a. one", "b. two"]), page(["2. Again?", "a. one", "*b. two"])]);
    assert.ok(r.sourceLines?.[0]?.startsWith("[p1] "));
    assert.ok(r.sourceLines?.some((l) => l.startsWith("[p2] 2. Again?")));
  });

  test("a key mark asked for is not applied to a PDF, whatever the caller said", () => {
    const content = at(36, 740, 12, "1. Which?") + at(36, 726, 12, "a. one") + at(36, 712, 12, "b. two", "F2");
    const r = pdfImporter.parseBytes(pdf({ pages: [content] }), { ...OPTIONS, keyMark: "bold" });
    assert.deepEqual(options(r.questions[0] as Question).map((o) => o[1]), [false, false]);
  });
});

// ---------------------------------------------------------------------------
// Choosing the importer
// ---------------------------------------------------------------------------

describe("choosing the importer for a PDF", () => {
  const bytes = pdf({ pages: [page(["1. Which?", "*a. one", "b. two"])] });

  test("a .pdf is a PDF, and so is a file that begins like one whatever it is called", () => {
    assert.equal(importerForContent("bank.pdf", bytes).id, "pdf");
    assert.equal(importerForContent("bank.txt", bytes).id, "pdf");
    assert.equal(importerForContent("bank", bytes).id, "pdf");
  });

  test("looksLikePdf looks at the start, and a PDF may have a few bytes before its header", () => {
    assert.equal(looksLikePdf(bytes), true);
    assert.equal(looksLikePdf(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes])), true);
    assert.equal(looksLikePdf(new TextEncoder().encode("1. Which?\na. one")), false);
  });

  test("the importer is told its file, and a text string is not accepted", () => {
    assert.throws(() => pdfImporter.parse("1. Which?\na. one"), /reads a \.pdf file as bytes/);
  });
});

// ---------------------------------------------------------------------------
// A PDF that another part of this project wrote
// ---------------------------------------------------------------------------

describe("the student copy this project prints as a PDF", () => {
  const opt = (id: string, text: string, correct = false) => ({ id, content: plainToRich(text), correct });
  const make = (n: number, body: QuestionBody, stem: string): Question =>
    createQuestion({ type: "multipleChoice", stem: plainToRich(stem), body, by: "t", at: OPTIONS.at, id: `q_${String(n).padStart(26, "0")}` });
  const bank = [
    make(1, { shuffle: false, options: [opt("o1", "Venus"), opt("o2", "Mercury", true), opt("o3", "Earth")] }, "Which planet is closest to the Sun?"),
    make(2, { shuffle: false, options: [opt("o1", "Friction"), opt("o2", "Gravity", true), opt("o3", "Static")] }, "What force holds the planets in orbit around the Sun, so that they do not leave it and drift away into space?"),
  ];

  test("reads back as the same questions and options, with no key, because a student copy has none", () => {
    const { file } = printTest(bank, printOptions({ title: "Planets", kind: "student", nameLine: false, dateLine: false }), "pdf");
    const r = pdfImporter.parseBytes(file.bytes, OPTIONS);
    assert.equal(r.questions.length, 2);
    assert.equal(plain(r.questions[1] as Question), "What force holds the planets in orbit around the Sun, so that they do not leave it and drift away into space? (1 point)", "the printed copy says what a question is worth, and a long stem wrapped over two lines is one paragraph");
    assert.deepEqual(options(r.questions[0] as Question), [["Venus", false], ["Mercury", false], ["Earth", false]]);
    for (const q of r.questions) assert.equal(verdict(q), "failed", "no answer was printed, and none is invented");
  });
});

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

describe("the command-line review of a PDF and of a table", () => {
  test("shows the lines the importer read, with their pages and rows, and not the bytes of the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "openassess-cli-"));
    try {
      const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
      writeFileSync(join(dir, "bank.pdf"), pdf({ pages: [page(["1. Which planet is closest?", "a. Venus", "*b. Mercury"])] }));
      writeFileSync(join(dir, "bank.csv"), ["Question,A,B,Correct", "Which planet is closest?,Venus,Mercury,B", ""].join("\n"));
      for (const [file, needle] of [["bank.pdf", "[p1] 1. Which planet is closest?"], ["bank.csv", "Row 2: Question: Which planet is closest?"]] as const) {
        const out = join(dir, `${file}.html`);
        const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, "review", join(dir, file), "--out", out], { encoding: "utf8" });
        assert.equal(run.status, 0, run.stderr);
        assert.ok(readFileSync(out, "utf8").includes(needle), `${file}: the page shows "${needle}"`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// A table of objects that is lost, an object stream, and a predictor
// ---------------------------------------------------------------------------

/** An object as plain data, so that two documents can be compared object by object. */
function show(o: PdfObject | undefined): unknown {
  if (o instanceof PdfName) return `/${o.name}`;
  if (o instanceof PdfRef) return `${o.num} ${o.gen} R`;
  if (o instanceof PdfString) return `(${Buffer.from(o.bytes).toString("latin1")})`;
  if (o instanceof PdfStream) return { stream: show(o.dict), length: o.raw.length };
  if (o instanceof Map) return Object.fromEntries([...o].map(([k, v]) => [k, show(v)]));
  if (Array.isArray(o)) return o.map(show);
  return o;
}

const DAMAGED = /table of objects in this PDF was damaged/;

describe("a PDF written in the modern way whose table of objects is lost", () => {
  const body = page(["1. Which of these is a question?", "a. One", "b. Two", "c. Three"]);
  for (const compress of [false, true]) {
    test(`is read all the same${compress ? " with its pages compressed" : ""}, with the objects that were inside its object stream found`, () => {
      const whole = pdf({ pages: [body, page(["second page"])], modern: true, compress });
      const broken = pdf({ pages: [body, page(["second page"])], modern: true, compress, brokenStartxref: true });
      assert.deepEqual(linesOf(broken), linesOf(whole));
      assert.match(notes(broken), DAMAGED, "and the person is told how it was found");
      assert.doesNotMatch(notes(whole), DAMAGED);

      // Every object, those inside the object stream and those outside it, is the same object when it is found by searching.
      const a = new PdfDocument(whole);
      const b = new PdfDocument(broken);
      const wrong: number[] = [];
      let inside = 0;
      for (let n = 1; n <= 14; n++) {
        const one = show(a.get(n));
        if (JSON.stringify(one) !== JSON.stringify(show(b.get(n)))) wrong.push(n);
        if (one !== null && !(typeof one === "object" && "stream" in (one as object))) inside++;
      }
      assert.deepEqual(wrong, [], "objects that differ");
      assert.ok(inside >= 5, `${inside} objects that are not streams were found`);
    });
  }

  test("and one of the old way with its start-of-table pointing at nothing is read the same", () => {
    const whole = pdf({ pages: [body] });
    assert.deepEqual(linesOf(pdf({ pages: [body], brokenStartxref: true })), linesOf(whole));
    assert.match(notes(pdf({ pages: [body], brokenStartxref: true })), DAMAGED);
  });

  test("when the object stream lists its objects in the order of the last first, or in a shuffled order, is read whole, with or without its table", () => {
    const whole = pdf({ pages: [body, page(["second page"])], modern: true });
    for (const order of ["descending", "shuffled"] as const) {
      for (const brokenStartxref of [false, true]) {
        const read = pdf({ pages: [body, page(["second page"])], modern: true, objectStreamOrder: order, brokenStartxref });
        assert.deepEqual(linesOf(read), linesOf(whole), `${order}${brokenStartxref ? ", table lost" : ""}`);
        const a = new PdfDocument(whole);
        const b = new PdfDocument(read);
        for (let n = 1; n <= 14; n++) assert.deepEqual(show(b.get(n)), show(a.get(n)), `object ${n}, ${order}`);
      }
    }
  });

  test("keeps an object that is also in the object stream as the plain object, which is the one the searching found first", () => {
    // Object 3, the page, is in the file twice: plain, saying Hello, and in an object stream, pointing at another content that says Goodbye.
    // The object stream comes first in the file, so that it is opened before the plain page has been read and cached: if its copy took the
    // place of the plain one in the table, the page that was read would be its copy.
    const inner = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 8 0 R >>";
    const head = "3 0 ";
    const pieces: Piece[] = [
      { num: 7, dict: `/Type /ObjStm /N 1 /First ${head.length}`, data: Buffer.from(head + inner, "latin1") },
      { num: 8, dict: "", data: Buffer.from("BT /F1 12 Tf 72 700 Td (Goodbye) Tj ET", "latin1") },
      ...helloPieces(),
    ];
    assert.deepEqual(linesOf(assemble(pieces, "trailer")), [["Hello"]]);
  });
});

describe("an object stream", () => {
  /** The objects of an object stream given as [number, offset] and a body, in a file with no table, so that they are found by searching. */
  function opened(header: Array<[number, number]>, body: string, extra = ""): PdfDocument {
    const head = `${header.map(([id, offset]) => `${id} ${offset}`).join(" ")}\n`;
    const pieces: Piece[] = [...helloPieces(), { num: 7, dict: `/Type /ObjStm /N ${header.length} /First ${head.length} ${extra}`, data: Buffer.from(head + body, "latin1") }];
    return new PdfDocument(assemble(pieces, "trailer"));
  }
  // Three arrays that never close, side by side: each ends where the next begins, and no later.
  const BODY = "[ 1 2 [ 3 4 [ 5 6";

  test("gives each object its own words, up to where the next begins and not the one after it", () => {
    const doc = opened([[20, 0], [21, 6], [22, 12]], BODY);
    assert.deepEqual(doc.get(20), [1, 2]);
    assert.deepEqual(doc.get(21), [3, 4]);
    assert.deepEqual(doc.get(22), [5, 6]);
  });

  for (const [what, header] of [
    ["the last first", [[22, 12], [21, 6], [20, 0]]],
    ["shuffled", [[22, 12], [20, 0], [21, 6]]],
    ["with the middle one first", [[21, 6], [22, 12], [20, 0]]],
  ] as Array<[string, Array<[number, number]>]>) {
    test(`lists its objects ${what}, and each is still read from where it begins to where the next one by place begins`, () => {
      const doc = opened(header, BODY);
      assert.deepEqual(doc.get(20), [1, 2]);
      assert.deepEqual(doc.get(21), [3, 4]);
      assert.deepEqual(doc.get(22), [5, 6]);
    });
  }

  test("drops an object whose offset is negative or not whole, and keeps the others", () => {
    const doc = opened([[20, -5], [21, 0.5], [22, 0]], "[ 9 9 ]");
    assert.equal(doc.get(20), null, "a negative offset is no place");
    assert.equal(doc.get(21), null, "and nor is a fraction of a byte");
    assert.deepEqual(doc.get(22), [9, 9]);
  });

  test("gives the first of two numbers listed twice, and the same object for two numbers at one place", () => {
    const doc = opened([[20, 0], [20, 6], [21, 6], [22, 6]], "[ 1 ] [ 2 ]");
    assert.deepEqual(doc.get(20), [1], "the first offset listed is the one");
    assert.deepEqual(doc.get(21), [2]);
    assert.deepEqual(doc.get(22), [2]);
  });
});

describe("the numbers that describe a table of objects that is a stream", () => {
  const readFile = (bytes: Buffer): { lines?: string[][]; notes: string } => {
    const r = readTextInChild(bytes);
    assert.equal(r.timedOut, false, `still reading after ${r.ms} ms`);
    assert.equal(r.status, 0, r.stderr);
    return { ...(r.lines ? { lines: r.lines } : {}), notes: (r.notes ?? []).join("\n") };
  };

  // Every file here has a table that is right about every object. It is believed unless a number that describes it is not one that is
  // accepted, and then it is refused and the objects are looked for: the same page is read, and the person is told.
  test("that are right are believed, and nothing is said", () => {
    // (The last has a count of entries that no file has, and 28 bytes of them: it is the bytes that decide how many rows there are.)
    for (const bytes of [tableStreamPdf("[1 2 1]", "[0 7]"), tableStreamPdf("[1 2 1 7]", "[0 7]"), tableStreamPdf("[1 2 1]", "[0 3 3 4]"), tableStreamPdf("[1 2 1]", "[0 100000000]")]) {
      const r = readFile(bytes);
      assert.deepEqual(r.lines, [["Hello"]]);
      assert.doesNotMatch(r.notes, DAMAGED);
    }
  });

  for (const [what, w, index, widths, dummy] of [
    ["a number of entries that is not whole", "[1 2 1]", "[0 7.5]", [1, 2, 1], 0],
    ["a first number that is below 0, with the rows to match", "[1 2 1]", "[-1 8]", [1, 2, 1], 1],
    ["a width that is not whole, in the first field", "[0.5 2 1]", "[0 7]", [1, 2, 1], 0],
    ["a width that is not whole, in the last", "[1 2 0.5]", "[0 7]", [1, 2, 1], 0],
    ["a width of 9, which no writer uses", "[1 9 1]", "[0 7]", [1, 9, 1], 0],
  ] as Array<[string, string, string, [number, number, number], number]>) {
    test(`with ${what} is not believed, and the page is found by searching, with the person told`, () => {
      const r = readFile(tableStreamPdf(w, index, widths, dummy));
      assert.deepEqual(r.lines, [["Hello"]]);
      assert.match(r.notes, DAMAGED);
    });
  }

  test("with a width of 8, the widest, is believed", () => {
    const r = readFile(tableStreamPdf("[1 8 1]", "[0 7]", [1, 8, 1]));
    assert.deepEqual(r.lines, [["Hello"]]);
    assert.doesNotMatch(r.notes, DAMAGED);
  });
});

describe("a run-length stream", () => {
  test("of 100,000 runs is unpacked in time that grows with the runs, and not with their square", () => {
    const pairs = 100_000;
    const encoded = new Uint8Array(pairs * 2);
    for (let i = 0; i < pairs; i++) {
      encoded[i * 2] = 129; // 128 copies of the next byte
      encoded[i * 2 + 1] = 32;
    }
    const run = inChild(encoded, `const { runLength } = await engine("import/pdf/document.ts"); const t = performance.now(); const out = runLength(bytes); console.log(JSON.stringify({ length: out.length, ms: Math.round(performance.now() - t) }));`);
    assert.equal(run.timedOut, false, `still unpacking after ${run.ms} ms`);
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout) as { length: number; ms: number };
    assert.equal(out.length, 12_800_000);
    assert.ok(out.ms < 3000, `unpacked in ${out.ms} ms`);
  });
});

// ---------------------------------------------------------------------------
// Predictors
// ---------------------------------------------------------------------------

describe("a predictor", () => {
  /** A file of two pages: the first has the given content stream, packed and with the given parameters, the second says Hello. */
  function twoPages(data: Buffer, parms: string): Uint8Array {
    const pieces: Piece[] = [
      { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
      { num: 2, body: "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>" },
      { num: 3, body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>" },
      { num: 4, dict: `/Filter /FlateDecode /DecodeParms ${parms}`, data },
      { num: 5, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
      { num: 6, body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>" },
      { num: 7, dict: "", data: Buffer.from("BT /F1 12 Tf 72 700 Td (Hello) Tj ET", "latin1") },
    ];
    return assemble(pieces);
  }

  const CONTENT = "BT /F1 12 Tf 72 600 Td (the first page) Tj ET";

  /** The content cut into rows of `rowBytes` (spaces make up the last), each begun with a byte for how it is predicted: 1 is the byte to the left. */
  function pngRows(content: string, rowBytes: number, bytesPerPixel: number): Buffer {
    const padded = Buffer.from(content.padEnd(Math.ceil(content.length / rowBytes) * rowBytes, " "), "latin1");
    const out: number[] = [];
    for (let r = 0; r < padded.length; r += rowBytes) {
      out.push(1);
      for (let i = 0; i < rowBytes; i++) out.push(((padded[r + i] as number) - (i >= bytesPerPixel ? (padded[r + i - bytesPerPixel] as number) : 0)) & 255);
    }
    return Buffer.from(out);
  }

  /** The same, the way the format with a predictor of 2 does it: no byte in front, and the difference from the byte one pixel to the left. */
  function tiffRows(content: string, rowBytes: number, bytesPerPixel: number): Buffer {
    const padded = Buffer.from(content.padEnd(Math.ceil(content.length / rowBytes) * rowBytes, " "), "latin1");
    const out = Buffer.from(padded);
    for (let r = 0; r < padded.length; r += rowBytes) for (let i = bytesPerPixel; i < rowBytes; i++) out[r + i] = ((padded[r + i] as number) - (padded[r + i - bytesPerPixel] as number)) & 255;
    return out;
  }

  // Predictors, columns, colours and depths that real files have, and that the check on them must not turn away. A real scan has 8 or
  // 16 bits and 1 or 3 colours with a predictor of 15, a bi-level one has 1, and a width of more than 5 columns is anything but a toy.
  for (const [predictor, columns, colors, bits] of [
    [15, 5, 1, 8],
    [15, 12, 1, 8],
    [12, 7, 3, 8],
    [11, 9, 1, 8],
    [15, 3, 1, 16],
    [15, 2, 3, 16],
    [15, 16, 1, 1],
    [15, 8, 1, 4],
    [15, 4, 1, 2],
    [15, 2, 3, 8],
    [10, 4, 4, 8],
    [2, 6, 1, 8],
    [2, 2, 3, 8],
  ] as const) {
    test(`/Predictor ${predictor} with ${columns} columns of ${colors} colour${colors === 1 ? "" : "s"} at ${bits} bits is a width the reader knows, and the page is read through it`, () => {
      const rowBytes = Math.ceil((columns * colors * bits) / 8);
      const bytesPerPixel = Math.max(1, Math.ceil((colors * bits) / 8));
      const rows = predictor === 2 ? tiffRows(CONTENT, rowBytes, bytesPerPixel) : pngRows(CONTENT, rowBytes, bytesPerPixel);
      const bytes = twoPages(deflateSync(rows), `<< /Predictor ${predictor} /Columns ${columns} /Colors ${colors} /BitsPerComponent ${bits} >>`);
      const result = readPdfText(bytes);
      assert.deepEqual(result.pages.map((p) => p.lines.map((l) => l.text.trim())), [["the first page"], ["Hello"]]);
      assert.doesNotMatch(result.notes.map((n) => n.message).join("\n"), /cannot be right/);
    });
  }

  test("/Predictor 2 at a depth other than 8 is not unpacked, and not refused: the data is the data", () => {
    const bytes = twoPages(deflateSync(Buffer.from(CONTENT, "latin1")), "<< /Predictor 2 /Columns 4 /BitsPerComponent 16 >>");
    assert.deepEqual(linesOf(bytes), [["the first page"], ["Hello"]]);
  });

  // The ones that cannot be right, and are refused for that page alone, in words.
  for (const [what, parms] of [
    ["colours that are not whole", "<< /Predictor 15 /Columns 5 /Colors 1.5 >>"],
    ["columns that are not whole", "<< /Predictor 15 /Columns 5.5 >>"],
    ["a depth of 3", "<< /Predictor 15 /Columns 5 /BitsPerComponent 3 >>"],
    ["a depth of 32", "<< /Predictor 15 /Columns 5 /BitsPerComponent 32 >>"],
    ["a row of one byte more than 16 MiB", "<< /Predictor 15 /Columns 16777217 >>"],
    ["a row of one byte more than 16 MiB made of colours", "<< /Predictor 15 /Columns 1 /Colors 8388609 /BitsPerComponent 16 >>"],
  ] as const) {
    test(`with ${what} is refused for that page in the reader's words, and the other page is kept`, () => {
      const result = readPdfText(twoPages(deflateSync(pngRows(CONTENT, 5, 1)), parms));
      assert.deepEqual(result.pages.map((p) => p.lines.length), [0, 1]);
      assert.match(result.notes.map((n) => n.message).join("\n"), /A page could not be read[^]*cannot be right/);
    });
  }

  test("with a row of exactly 16 MiB is not refused: the row is as wide as a row may be", () => {
    const result = readPdfText(twoPages(deflateSync(pngRows(CONTENT, 5, 1)), "<< /Predictor 15 /Columns 16777216 >>"));
    assert.doesNotMatch(result.notes.map((n) => n.message).join("\n"), /cannot be right/, "no row is whole in so little data, and the page has nothing, but it was not refused");
  });
});
