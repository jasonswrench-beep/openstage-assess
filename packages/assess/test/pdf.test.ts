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

import { importerForContent } from "../src/import/registry.ts";
import { looksLikePdf, pdfImporter, pdfToBlocks } from "../src/import/pdf.ts";
import { PdfDocument } from "../src/import/pdf/document.ts";
import { PdfError } from "../src/import/pdf/objects.ts";
import { readPdfText } from "../src/import/pdf/reader.ts";
import { assembleParagraphs } from "../src/import/pdf/paragraphs.ts";
import { FindingCode, liveFindings, verdictFrom } from "../src/model/findings.ts";
import { richTextToPlain } from "../src/model/richtext.ts";
import { createQuestion } from "../src/model/create.ts";
import { plainToRich } from "../src/model/richtext.ts";
import { printOptions, printTest } from "../src/print/index.ts";
import type { Question, QuestionBody } from "../src/model/question.ts";
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
