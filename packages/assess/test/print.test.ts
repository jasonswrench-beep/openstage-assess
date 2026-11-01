/**
 * Printing: the layout that decides what a printed test says, and the Word and PDF files that draw it. The rules under test
 * are the ones that matter on paper: the student copy never shows an answer, the key shows only what the bank records and
 * says so when it records none, a matching or ordering question is shown shuffled and the key says how it was matched, and
 * what cannot be printed is said. The PDF is read back by taking it apart, since a file that cannot be read is no test. The
 * text is invented.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

import { Bank } from "../src/bank/store.ts";
import { unzipSync } from "../src/container/zip.ts";
import { parseXml, allText, elements, first, type XmlElement } from "../src/import/docx/xml.ts";
import { wordImporter } from "../src/import/word.ts";
import { createQuestion } from "../src/model/create.ts";
import { plainToRich, rich } from "../src/model/richtext.ts";
import type { Question, QuestionBody, QuestionType } from "../src/model/question.ts";
import { layoutTest, paragraphsOf, printOptions, printTest, shuffledFor, writeDocx, writePdf, type Block, type Para, type PrintDocument } from "../src/print/index.ts";
import { PAPERS } from "../src/print/layout.ts";

const AT = "2026-01-01T00:00:00.000Z";
const opt = (id: string, text: string, correct = false) => ({ id, content: plainToRich(text), correct });
let made = 0;
/** A question with an id of the form the bank takes, in the order they are made. */
const make = (type: QuestionType, body: QuestionBody, stem: string, extra: Partial<Parameters<typeof createQuestion>[0]> = {}): Question =>
  createQuestion({ type, stem: typeof stem === "string" && stem.startsWith("<") ? rich(stem) : plainToRich(stem), body, by: "t", at: AT, id: `q_${String(++made).padStart(26, "0")}`, ...extra });

const MC = make("multipleChoice", { shuffle: true, options: [opt("o1", "Berlin"), opt("o2", "Paris", true), opt("o3", "Rome")] }, "What is the capital of France?");
const MR = make("multipleResponse", { shuffle: true, partialCredit: true, options: [opt("o1", "Red", true), opt("o2", "Green"), opt("o3", "Blue", true)] }, "Which are primary colours?");
const TF = make("trueFalse", { correct: false }, "A light-year is a measure of time.");
const TF_NONE = make("trueFalse", {}, "The Moon is made of cheese.");
const FILL = make("fillInBlank", { caseSensitive: false, blanks: [{ id: "b1", accepted: ["Rome", "Roma"] }] }, "The capital of Italy is ____.");
const FILL_NO_BLANK = make("fillInBlank", { caseSensitive: false, blanks: [{ id: "b1", accepted: ["Rome"] }] }, "Name the capital of Italy.");
const SHORT = make("shortAnswer", { caseSensitive: false, accepted: ["Nile", "the Nile"] }, "Name the longest river in Egypt.");
const MATCH = make(
  "matching",
  { shuffle: true, distractors: ["Oslo"], pairs: [{ id: "p1", left: plainToRich("France"), right: "Paris" }, { id: "p2", left: plainToRich("Italy"), right: "Rome" }, { id: "p3", left: plainToRich("Spain"), right: "Madrid" }] },
  "Match each country to its capital.",
);
const ORDER = make("ordering", { items: ["Pond", "Lake", "Sea", "Ocean"].map((t, i) => ({ id: `i${i + 1}`, content: plainToRich(t), position: i + 1 })) }, "Put these in order from smallest to largest.");
const NUMERIC = make("numeric", { mode: "tolerance", value: 9.8, tolerance: 0.1, units: "m/s2" }, "What is g near the Earth?");
const ESSAY = make("essay", { modelAnswer: plainToRich("Short wavelengths scatter more.") }, "Explain why the sky is blue.");
const ESSAY_NO_MODEL = make("essay", {}, "Describe your day.");
const HOTSPOT = make("hotspot", { mediaRef: "m1", regions: [{ id: "r1", shape: "rect", coords: [0, 0, 1, 1], correct: true }], alternative: plainToRich("The heart.") }, "Click the heart.");

const ALL = [MC, MR, TF, FILL, SHORT, MATCH, ORDER, NUMERIC, ESSAY];

const opts = (kind: "student" | "key", more: Record<string, unknown> = {}) => printOptions({ title: "Quiz", kind, ...more });

/** What a block says, as one line of text, with its marker in front. */
const lineOf = (block: Block): string => (block.kind === "para" ? `${block.marker ? `${block.marker} ` : ""}${block.runs.map((r) => r.text).join("")}` : block.kind === "lines" ? `[${block.count} lines]` : "[page break]");
const linesOf = (doc: PrintDocument): string[] => doc.blocks.map(lineOf);
const printed = (questions: Question[], kind: "student" | "key", more: Record<string, unknown> = {}): string => linesOf(layoutTest(questions, opts(kind, more)).document).join("\n");

// ---------------------------------------------------------------------------
// The layout
// ---------------------------------------------------------------------------

describe("the student copy", () => {
  const text = printed(ALL, "student");

  test("has a title, a name and a date to fill in, the number of questions and the points", () => {
    assert.match(text, /^Quiz\n/);
    assert.match(text, /Name: _+\s+Date: _+/);
    assert.match(text, /9 questions, 9 points in all\./);
  });

  test("numbers the questions from 1, with their points", () => {
    assert.match(text, /^1\. What is the capital of France\?  \(1 point\)$/m);
    assert.match(text, /^9\. Explain why the sky is blue\.  \(1 point\)$/m);
  });

  test("shows the choices, and marks none of them", () => {
    assert.match(text, /^A\. Berlin$/m);
    assert.match(text, /^B\. Paris$/m);
    assert.doesNotMatch(text, /\(correct\)/);
    assert.match(text, /Select all that apply\./);
  });

  test("shows no answer anywhere: not a true or false, not the accepted answers, not the model answer, not a number", () => {
    assert.match(text, /\(   \) True        \(   \) False/);
    for (const secret of ["Roma", "the Nile", "Short wavelengths", "9.8", "Accepted", "Model answer", "Answer: True", "Answer: False"]) {
      assert.ok(!text.includes(secret), `${secret} is not on the student copy`);
    }
  });

  test("gives a place to write for each kind of answer", () => {
    assert.match(text, /Answer: _+ ?m\/s2/, "a number, with its units");
    assert.match(text, /\[1 lines\]/, "a short answer has a line");
    assert.match(text, /\[8 lines\]/, "an essay has several");
    assert.match(text, /Number the items 1 to 4 in the right order\./);
    assert.match(text, /Write the letter of the match on the line\./);
  });

  test("adds a line to answer on for a blank only when the text has none to fill", () => {
    const withBlank = printed([FILL], "student");
    assert.doesNotMatch(withBlank, /Answer: _{10}/, "the blank in the text is the place to write");
    assert.match(printed([FILL_NO_BLANK], "student"), /Answer: _{10}/);
  });

  test("can leave out the name, the date, the points and the instructions, or add instructions", () => {
    const plain = printed([MC], "student", { nameLine: false, dateLine: false, showPoints: false });
    assert.doesNotMatch(plain, /Name:|Date:|points? in all|\(1 point\)/);
    assert.match(printed([MC], "student", { instructions: "Use a pen.\n\nNo talking." }), /Use a pen\.\nNo talking\./);
  });

  test("sets the lines for short answers and essays from the options", () => {
    const text2 = printed([SHORT, ESSAY], "student", { shortAnswerLines: 3, essayLines: 12 });
    assert.match(text2, /\[3 lines\]/);
    assert.match(text2, /\[12 lines\]/);
  });
});

describe("the answer key", () => {
  const text = printed(ALL, "key");

  test("says it is the key", () => {
    assert.match(text, /^Quiz {2}·\s+Answer key\n/);
    assert.doesNotMatch(text, /Name:|Date:/);
  });

  test("marks the right choices, in words and in bold, and only those", () => {
    const doc = layoutTest([MC], opts("key")).document;
    const options = doc.blocks.filter((b): b is Para => b.kind === "para" && b.marker !== undefined && /^[A-Z]\.$/.test(b.marker));
    assert.deepEqual(options.map((o) => o.runs.map((r) => r.text).join("")), ["Berlin", "Paris  (correct)", "Rome"]);
    assert.ok(options[1]?.runs.every((r) => r.bold));
    assert.ok(options[0]?.runs.every((r) => !r.bold));
    assert.match(text, /^A\. Red {2}\(correct\)$/m);
    assert.match(text, /^C\. Blue {2}\(correct\)$/m);
  });

  test("gives the answer of every kind of question from what the bank holds", () => {
    assert.match(text, /^Answer: False$/m);
    assert.match(text, /^Accepted: Rome {2}\| {2}Roma$/m);
    assert.match(text, /^Accepted answers: Nile {2}\| {2}the Nile$/m);
    assert.match(text, /^Answer: 9\.8 \(give or take 0\.1\) m\/s2$/m);
    assert.match(text, /^Model answer: Short wavelengths scatter more\.$/m);
    assert.match(text, /^1\. Pond\n2\. Lake\n3\. Sea\n4\. Ocean$/m);
  });

  test("says that a question with no answer has none, and does not give one", () => {
    const withNone = layoutTest([MC, TF_NONE], opts("key"));
    const lines = linesOf(withNone.document).join("\n");
    assert.match(lines, /No answer is recorded for this question\./);
    assert.doesNotMatch(lines, /Answer: (True|False)/);
    assert.ok(withNone.report.items[1]?.notes.some((n) => /no usable answer key.*Nothing was guessed/.test(n)));
    const noKeyMc = make("multipleChoice", { shuffle: true, options: [opt("o1", "A"), opt("o2", "B")] }, "No key here.");
    const mc = printed([noKeyMc], "key");
    assert.doesNotMatch(mc, /\(correct\)/);
    assert.match(mc, /No answer is recorded/);
  });

  test("says that an essay with no model answer is marked by a person", () => {
    assert.match(printed([ESSAY_NO_MODEL], "key"), /Marked by a person; no model answer is recorded\./);
  });

  test("prints a question's feedback only when asked, and says when it did not", () => {
    const withFeedback = make("trueFalse", { correct: true }, "Water is wet.", { feedback: { general: plainToRich("It is."), correct: plainToRich("Yes."), incorrect: plainToRich("No.") } });
    const without = layoutTest([withFeedback], opts("key"));
    assert.ok(without.report.items[0]?.notes.some((n) => /feedback is not printed on the key/.test(n)));
    const included = printed([withFeedback], "key", { includeFeedback: true });
    assert.match(included, /Feedback: It is\./);
    assert.match(included, /If right: Yes\./);
    assert.match(included, /If wrong: No\./);
    assert.doesNotMatch(printed([withFeedback], "student", { includeFeedback: true }), /Feedback:/, "the student copy never prints feedback");
  });
});

describe("matching and ordering", () => {
  const rightsShown = (kind: "student" | "key" = "student"): string[] => {
    const doc = layoutTest([MATCH], opts(kind)).document;
    return doc.blocks.filter((b): b is Para => b.kind === "para" && /^[A-Z]\.$/.test(b.marker ?? "")).map((b) => b.runs.map((r) => r.text).join(""));
  };

  test("show the student the answers in an order that is the same every time", () => {
    assert.deepEqual(rightsShown(), rightsShown());
    assert.deepEqual([...rightsShown()].sort(), ["Madrid", "Oslo", "Paris", "Rome"].sort(), "the right answers and the spare one, and nothing else");
    assert.notDeepEqual(rightsShown(), ["Paris", "Rome", "Madrid", "Oslo"], "not the order of the key");
  });

  test("have a key whose letters are the letters the student sees", () => {
    const shown = rightsShown();
    const key = linesOf(layoutTest([MATCH], opts("key")).document).filter((l) => /^\d\. (France|Italy|Spain)/.test(l));
    assert.equal(key.length, 3);
    for (const [i, right] of ["Paris", "Rome", "Madrid"].entries()) {
      const letter = String.fromCharCode(65 + shown.indexOf(right));
      assert.match(key[i] as string, new RegExp(`${letter}\\. ${right}$`));
    }
  });

  test("shuffle an ordering question so that it is never in the order of the key", () => {
    const doc = layoutTest([ORDER], opts("student")).document;
    const shown = doc.blocks.filter((b): b is Para => b.kind === "para" && b.marker === "____").map((b) => b.runs.map((r) => r.text).join(""));
    assert.deepEqual([...shown].sort(), ["Lake", "Ocean", "Pond", "Sea"]);
    assert.notDeepEqual(shown, ["Pond", "Lake", "Sea", "Ocean"]);
  });

  test("never come out as they went in, for any number of items, whatever the question", () => {
    for (let n = 2; n <= 12; n++) {
      const items = Array.from({ length: n }, (_, i) => `item ${i}`);
      for (let k = 0; k < 40; k++) {
        const out = shuffledFor(items, `q_${k}`);
        assert.deepEqual([...out].sort(), [...items].sort());
        assert.notDeepEqual(out, items, `n=${n} id ${k}`);
        assert.deepEqual(shuffledFor(items, `q_${k}`), out, "and the same each time");
      }
    }
    assert.deepEqual(shuffledFor(["only"], "x"), ["only"]);
    assert.deepEqual(shuffledFor([], "x"), []);
  });
});

describe("what cannot be printed", () => {
  test("a hotspot question is left out with the reason, and the numbering has no gap", () => {
    const layout = layoutTest([MC, HOTSPOT, TF], opts("student"));
    assert.equal(layout.report.leftOut, 1);
    assert.match(layout.report.items[1]?.notes[0] ?? "", /hotspot question cannot be printed: it needs a screen/);
    const text = linesOf(layout.document).join("\n");
    assert.match(text, /^1\. What is the capital/m);
    assert.match(text, /^2\. A light-year/m);
    assert.doesNotMatch(text, /heart/);
  });

  test("a picture, an equation and a table in the text are printed as words, and each is said", () => {
    const q = createQuestion({
      type: "essay",
      stem: rich('<p>Look at <oa-media ref="m1"></oa-media> and <oa-math ref="e1"></oa-math>.</p><table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>'),
      body: {},
      media: [{ id: "m1", file: "media/m1.png", mime: "image/png", alt: "A chart", decorative: false }],
      math: [{ id: "e1", latex: "x^2", mathml: "<math/>" }],
      by: "t",
      at: AT,
    });
    const layout = layoutTest([q], opts("student"));
    const text = linesOf(layout.document).join("\n");
    assert.match(text, /Look at \[Picture: A chart\] and \[Equation: x\^2\]\./);
    assert.match(text, /a \| b/);
    assert.match(text, /c \| d/);
    const notes = layout.report.items[0]?.notes.join("\n") ?? "";
    assert.match(notes, /1 picture cannot be printed/);
    assert.match(notes, /1 equation printed as/);
    assert.match(notes, /1 table printed as lines of text/);
    assert.equal(layout.report.items[0]?.outcome, "exportedWithLosses");
  });

  test("bold, italics, underline, lists and line breaks are kept, and entities are decoded", () => {
    const runs = paragraphsOf(rich("<p>One <strong>bold</strong> and <em>italic</em> and <u>under</u> &amp; &lt;tag&gt;<br>next line</p><ul><li>apple</li><li>pear</li></ul><ol><li>first</li></ol>"), MC, { pictures: 0, equations: 0, tables: 0 });
    assert.equal(runs.length, 4);
    const first = runs[0] ?? [];
    assert.deepEqual(first.filter((r) => r.bold).map((r) => r.text), ["bold"]);
    assert.deepEqual(first.filter((r) => r.italic).map((r) => r.text), ["italic"]);
    assert.deepEqual(first.filter((r) => r.underline).map((r) => r.text), ["under"]);
    assert.equal(first.map((r) => r.text).join(""), "One bold and italic and under & <tag>\nnext line");
    assert.deepEqual(runs.slice(1).map((p) => p.map((r) => r.text).join("")), ["• apple", "• pear", "1. first"]);
  });

  test("a question with no text is left out, and a bank with nothing to print writes no file", () => {
    const result = printTest([HOTSPOT], opts("student"), "pdf");
    assert.equal(result.file.bytes.length, 0);
    assert.deepEqual(result.report.files, []);
  });
});

// ---------------------------------------------------------------------------
// Word
// ---------------------------------------------------------------------------

describe("the Word file", () => {
  const layout = layoutTest(ALL, opts("student"));
  const bytes = writeDocx(layout.document, new Date("2026-02-03T04:05:06Z"));
  const parts = unzipSync(bytes);
  const text = (name: string): string => Buffer.from(parts.get(name) ?? new Uint8Array()).toString("utf8");

  test("holds the parts Word needs, and every one is well formed", () => {
    for (const name of ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/_rels/document.xml.rels", "word/styles.xml", "word/footer1.xml", "docProps/core.xml", "docProps/app.xml"]) {
      assert.ok(parts.has(name), name);
      assert.doesNotThrow(() => parseXml(text(name)), name);
    }
    assert.equal([...parts.keys()][0], "[Content_Types].xml", "the content types come first");
  });

  test("says what it is, who made it and when, in its properties", () => {
    const core = text("docProps/core.xml");
    assert.match(core, /<dc:title>Quiz<\/dc:title>/);
    assert.match(core, /<dc:creator>OpenAssess<\/dc:creator>/);
    assert.match(core, /2026-02-03T04:05:06Z/);
  });

  test("types the numbers and the letters, with a tab and a hanging indent", () => {
    const root = parseXml(text("word/document.xml"));
    const paragraphs = elements(first(root, "w:body") as XmlElement, "w:p");
    const stem = paragraphs.find((p) => allText(p).includes("What is the capital of France?")) as XmlElement;
    assert.match(allText(stem), /^1\.What is the capital of France\?/);
    const ind = first(first(stem, "w:pPr") as XmlElement, "w:ind") as XmlElement;
    assert.equal(ind.attrs["w:left"], "560");
    assert.equal(ind.attrs["w:hanging"], "560");
    assert.ok(first(first(stem, "w:pPr") as XmlElement, "w:keepNext"), "a question stays with its first answer");
  });

  test("draws a line to write on as a tab with a leader, not a border that Word would merge", () => {
    const xml = text("word/document.xml");
    assert.equal(xml.match(/w:leader="underscore"/g)?.length, 1 + 8, "one line for the short answer and eight for the essay");
    assert.doesNotMatch(xml, /<w:pBdr><w:bottom[^>]*\/><\/w:pBdr><\/w:pPr><w:r><w:tab\/>/);
  });

  test("puts the page number in the footer as a field, and the title beside it", () => {
    const footer = text("word/footer1.xml");
    assert.match(footer, /<w:instrText xml:space="preserve"> PAGE <\/w:instrText>/, "the number of this page");
    assert.match(footer, /<w:instrText xml:space="preserve"> NUMPAGES <\/w:instrText>/, "and how many there are");
    assert.match(footer, /<w:t xml:space="preserve">Quiz<\/w:t>/);
    assert.match(text("word/document.xml"), /<w:footerReference w:type="default" r:id="rId2"\/>/);
  });

  test("sets the page size and the margins from the paper", () => {
    const letter = text("word/document.xml");
    assert.match(letter, /<w:pgSz w:w="12240" w:h="15840"\/>/);
    assert.match(letter, /w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/);
    const a4 = unzipSync(writeDocx(layoutTest([MC], opts("student", { paper: "a4" })).document));
    assert.match(Buffer.from(a4.get("word/document.xml") ?? new Uint8Array()).toString("utf8"), /<w:pgSz w:w="11906" w:h="16838"\/>/);
  });

  test("keeps hostile text as text, and the file well formed", () => {
    const q = make("shortAnswer", { caseSensitive: false, accepted: ["x"] }, "Is </w:t><w:p>& \"quotes\" <script> ]]> \u0001 a problem?");
    const xml = Buffer.from(unzipSync(writeDocx(layoutTest([q], opts("student", { title: "T <&> \"q\"" })).document)).get("word/document.xml") ?? new Uint8Array()).toString("utf8");
    assert.doesNotThrow(() => parseXml(xml));
    assert.match(allText(parseXml(xml)), /Is <\/w:t><w:p>& "quotes" <script> \]\]> {2}a problem\?|Is <\/w:t><w:p>& "quotes" <script> \]\]>  a problem\?/);
  });

  test("is read back by the importer: the key copy as questions with their answers, the student copy as questions with none", () => {
    const set = [MC, MR, TF, make("multipleChoice", { shuffle: true, options: [opt("o1", "Mercury", true), opt("o2", "Venus"), opt("o3", "Earth"), opt("o4", "Mars")] }, "Which planet is closest to the Sun?")];
    const key = wordImporter.parseBytes(writeDocx(layoutTest(set, opts("key", { showPoints: false })).document), { file: "key.docx", at: AT, author: "t" });
    const keyed = key.questions.map((q) => [q.type, (q.body as { options?: Array<{ correct: boolean }>; correct?: boolean }).options?.map((o) => o.correct) ?? (q.body as { correct?: boolean }).correct]);
    // A single answer and a true or false come back with their answers. A multiple response comes back with the same two
    // options marked, but nothing in the file says it is a multiple response, so it is read as a single answer with two
    // marked and fails: the importer refusing to guess, not a wrong key.
    assert.deepEqual(keyed[0], ["multipleChoice", [false, true, false]]);
    assert.deepEqual(keyed[2], ["trueFalse", false]);
    assert.deepEqual(keyed[3], ["multipleChoice", [true, false, false, false]]);
    assert.deepEqual(keyed[1]?.[1], [true, false, true]);
    const second = key.questions[1] as Question;
    assert.ok(second.type === "multipleResponse" || second.findings.some((f) => f.severity === "error"), "never passed as a finished single answer");

    const student = wordImporter.parseBytes(writeDocx(layoutTest([MC, MR, TF], opts("student", { showPoints: false })).document), { file: "student.docx", at: AT, author: "t" });
    // With no answer shown, nothing says a question has several right ones, so both are read as single answers, with none marked.
    assert.deepEqual(student.questions.map((q) => q.type).slice(0, 2), ["multipleChoice", "multipleChoice"]);
    for (const q of student.questions.slice(0, 2)) assert.ok((q.body as { options: Array<{ correct: boolean }> }).options.every((o) => !o.correct), "no answer is invented for a copy that shows none");
  });
});

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/** A PDF taken apart: its objects by number, its pages' content, and what is drawn. */
function readPdf(bytes: Uint8Array): { text: string; objects: Map<number, string>; pages: string[][]; streams: string[]; offsetsRight: boolean; root: string } {
  const raw = Buffer.from(bytes);
  const text = raw.toString("latin1");
  assert.ok(text.startsWith("%PDF-1.4\n"));
  assert.ok(text.trimEnd().endsWith("%%EOF"));
  const start = Number(/startxref\n(\d+)\n%%EOF/.exec(text)?.[1]);
  assert.equal(text.slice(start, start + 4), "xref");
  const size = Number(/\/Size (\d+)/.exec(text)?.[1]);
  const table = text.slice(start).split("\n").slice(2, 2 + size); // the first line after the header is the free entry
  let right = true;
  const objects = new Map<number, string>();
  for (let id = 1; id < size; id++) {
    const offset = Number((table[id] ?? "").slice(0, 10));
    const head = new RegExp(`^${id} 0 obj\\n`);
    if (!head.test(text.slice(offset, offset + 20))) right = false;
    const end = text.indexOf("\nendobj", offset);
    objects.set(id, text.slice(offset, end));
  }
  const pagesObject = objects.get(2) ?? "";
  const kids = [...(/\/Kids \[([^\]]*)\]/.exec(pagesObject)?.[1] ?? "").matchAll(/(\d+) 0 R/g)].map((m) => Number(m[1]));
  // A string in a PDF is read as a reader reads it: a backslash gives the next character its plain meaning, so that one that
  // is not itself escaped is lost, and a reader shows "backslash" for "back\slash".
  const named: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
  const unescape = (s: string): string =>
    s.replace(/\\([nrtbf]|[0-7]{1,3}|[\s\S])/g, (_m, c: string) => (/^[0-7]+$/.test(c) ? String.fromCharCode(Number.parseInt(c, 8)) : (named[c] ?? c)));
  const streams: string[] = [];
  const pages = kids.map((id) => {
    const contentId = Number(/\/Contents (\d+) 0 R/.exec(objects.get(id) ?? "")?.[1]);
    const body = objects.get(contentId) ?? "";
    const length = Number(/\/Length (\d+)/.exec(body)?.[1]);
    const from = raw.indexOf("stream\n", raw.indexOf(`${contentId} 0 obj`)) + 7;
    const stream = inflateSync(raw.subarray(from, from + length)).toString("latin1");
    streams.push(stream);
    // Each string drawn, with its place, in the order it was drawn.
    return [...stream.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm \(((?:\\.|[^\\)])*)\) Tj/g)].map((m) => unescape(m[3] as string));
  });
  return { text, objects, pages, streams, offsetsRight: right, root: objects.get(1) ?? "" };
}

describe("the PDF", () => {
  const layout = layoutTest(ALL, opts("student"));
  const made = writePdf(layout.document, new Date("2026-02-03T04:05:06Z"));
  const pdf = readPdf(made.bytes);

  test("is a PDF whose table of objects points at every object", () => {
    assert.equal(pdf.offsetsRight, true);
    assert.match(pdf.root, /\/Type \/Catalog/);
    assert.match(pdf.root, /\/Lang \(en-US\)/);
    assert.ok(pdf.pages.length >= 1);
    assert.equal(pdf.pages.length, made.pages);
    assert.match(pdf.objects.get(2) ?? "", new RegExp(`/Count ${made.pages}`));
  });

  test("says its title and who made it in its properties", () => {
    const info = [...pdf.objects.values()].find((o) => /\/Producer \(OpenAssess\)/.test(o)) ?? "";
    const hex = /\/Title <([0-9A-F]+)>/.exec(info)?.[1] ?? "";
    assert.equal(Buffer.from(hex, "hex").subarray(2).swap16().toString("utf16le"), "Quiz");
    assert.match(info, /\/CreationDate \(D:20260203040506Z\)/);
  });

  test("uses the fonts every reader has, and embeds none", () => {
    const fonts = [...pdf.objects.values()].filter((o) => /\/Type \/Font/.test(o));
    assert.deepEqual(fonts.map((f) => /\/BaseFont \/([\w-]+)/.exec(f)?.[1]).sort(), ["Courier", "Helvetica", "Helvetica-Bold", "Helvetica-BoldOblique", "Helvetica-Oblique"]);
    assert.ok(fonts.every((f) => /\/WinAnsiEncoding/.test(f)));
    assert.doesNotMatch(pdf.text, /\/FontFile/);
  });

  test("draws the words of the test, in order, with a footer with the page number on every page", () => {
    const all = pdf.pages.flat().join("\n");
    assert.match(all, /What is the capital of France\?/);
    assert.match(all, /Berlin/);
    assert.ok(all.indexOf("What is the capital of France?") < all.indexOf("Explain why the sky is blue."));
    pdf.pages.forEach((page, i) => {
      assert.ok(page.includes(`Page ${i + 1} of ${pdf.pages.length}`), `the footer of page ${i + 1}`);
      assert.ok(page.includes("Quiz"));
    });
  });

  test("gives a one page test a one page footer, and a long test as many pages as it needs", () => {
    const one = readPdf(writePdf(layoutTest([MC], opts("student")).document).bytes);
    assert.equal(one.pages.length, 1);
    assert.ok(one.pages[0]?.includes("Page 1 of 1"));
    const many = readPdf(writePdf(layoutTest(Array.from({ length: 60 }, (_, i) => make("multipleChoice", { shuffle: true, options: [opt("o1", "One", true), opt("o2", "Two")] }, `Question number ${i + 1} is which?`)), opts("student")).document).bytes);
    assert.ok(many.pages.length >= 4);
    assert.ok(many.pages.at(-1)?.includes(`Page ${many.pages.length} of ${many.pages.length}`));
  });

  test("keeps a question with its first answer on one page, wherever the page ends", () => {
    const filler = (n: number): Block[] => Array.from({ length: n }, (_, i) => ({ kind: "para" as const, runs: [{ text: `Filler line ${i}` }], size: 11, indent: 0, before: 0, after: 0 }));
    for (let n = 0; n < 70; n++) {
      const blocks: Block[] = [
        ...filler(n),
        { kind: "para", runs: [{ text: "STEMTEXT" }], marker: "1.", size: 11, indent: 28, before: 10, after: 3, keepNext: true },
        { kind: "para", runs: [{ text: "OPTIONTEXT" }], marker: "A.", size: 11, indent: 58, before: 0, after: 3 },
      ];
      const result = readPdf(writePdf({ ...layout.document, blocks }).bytes);
      const stemPage = result.pages.findIndex((p) => p.includes("STEMTEXT"));
      const optionPage = result.pages.findIndex((p) => p.includes("OPTIONTEXT"));
      assert.equal(stemPage, optionPage, `with ${n} lines before it`);
    }
  });

  test("breaks long lines at the margin, and never lets a word run past it", () => {
    const long = Array.from({ length: 60 }, () => "wording").join(" ");
    const doc: PrintDocument = { ...layout.document, blocks: [{ kind: "para", runs: [{ text: long }], size: 11, indent: 28, before: 0, after: 0 }, { kind: "para", runs: [{ text: "x".repeat(300) }], size: 11, indent: 0, before: 0, after: 0 }] };
    const raw = Buffer.from(writePdf(doc).bytes);
    const result = readPdf(raw);
    assert.ok((result.pages[0] ?? []).filter((s) => s.startsWith("wording")).length >= 6, "the long paragraph took several lines");
    const stream = [...result.objects.entries()].filter(([, o]) => /\/Filter \/FlateDecode/.test(o));
    assert.ok(stream.length >= 1);
    const lineLengths = (result.pages[0] ?? []).filter((s) => s.startsWith("wording")).map((s) => s.length);
    assert.ok(Math.max(...lineLengths) <= 79, "no line is longer than the width allows: ten words and their spaces");
  });

  test("writes the characters of Windows Latin-1 as they are and counts the ones it cannot draw", () => {
    // Written straight into the layout: the model turns smart quotes into plain ones on the way in, so no question holds them.
    const text = "Café “quotes” – dash • €5 Ω 中文 (parens) back\\slash";
    const doc: PrintDocument = { ...layout.document, blocks: [{ kind: "para", runs: [{ text }], size: 11, indent: 0, before: 0, after: 0 }] };
    const written = writePdf(doc);
    const line = readPdf(written.bytes).pages.flat().find((s) => s.includes("quotes")) as string;
    assert.ok(line.includes("Café"), "an accented letter is one byte, as the font wants it");
    assert.ok(line.includes("\u0093quotes\u0094"), "curly quotes are their Windows Latin-1 codes");
    assert.ok(line.includes("\u0096 dash \u0095 \u0080"), "dash, bullet and euro too");
    assert.ok(line.includes("(parens) back\\slash"), "parentheses and a backslash are escaped in the file and read back whole");
    assert.ok(line.includes("? ??"), "a Greek letter and two Chinese characters became question marks");
    assert.deepEqual(written.replaced.map((r) => r.char).sort(), ["Ω", "中", "文"].sort());

    const q = make("shortAnswer", { caseSensitive: false, accepted: ["x"] }, "Greek Ω and 中文.");
    const result = printTest([q], opts("student"), "pdf");
    assert.match(result.report.general.join("\n"), /3 characters cannot be drawn in a PDF's built-in fonts and were printed as \?/);
    assert.match(result.report.general.join("\n"), /The Word file can hold any text/);
    assert.doesNotMatch(printTest([q], opts("student"), "docx").report.general.join("\n"), /cannot be drawn/, "and the Word file has no such limit");
  });

  test("says that it is not tagged for screen readers", () => {
    assert.ok(printTest([MC], opts("student"), "pdf").report.general.some((g) => /not tagged for screen readers/.test(g)));
    assert.ok(!printTest([MC], opts("student"), "docx").report.general.some((g) => /not tagged/.test(g)));
  });

  test("underlines what is underlined, and bolds a heading by font, not by drawing twice", () => {
    const doc: PrintDocument = { ...layout.document, blocks: [{ kind: "para", runs: [{ text: "plain " }, { text: "underlined", underline: true }], size: 11, indent: 0, before: 0, after: 0 }] };
    const read = readPdf(writePdf(doc).bytes);
    assert.equal(read.pages[0]?.some((s) => s === "underlined"), true, "the word is drawn");
    const strokes = (read.streams[0] ?? "").match(/0\.5 w [\d.]+ [\d.]+ m [\d.]+ [\d.]+ l S/g) ?? [];
    assert.equal(strokes.length, 1, "and a line is drawn under it, and only under it");
    const none = readPdf(writePdf({ ...doc, blocks: [{ kind: "para", runs: [{ text: "nothing underlined" }], size: 11, indent: 0, before: 0, after: 0 }] }).bytes);
    assert.doesNotMatch(none.streams[0] ?? "", /0\.5 w [\d.]+ [\d.]+ m [\d.]+ [\d.]+ l S/);
  });

  test("uses a page of the size of the paper", () => {
    const a4 = readPdf(writePdf(layoutTest([MC], opts("student", { paper: "a4" })).document).bytes);
    assert.match([...a4.objects.values()].find((o) => /\/Type \/Page /.test(o)) ?? "", /\/MediaBox \[0 0 595\.28 841\.89\]/);
    const letter = readPdf(writePdf(layoutTest([MC], opts("student")).document).bytes);
    assert.match([...letter.objects.values()].find((o) => /\/Type \/Page /.test(o)) ?? "", /\/MediaBox \[0 0 612 792\]/);
    assert.equal(PAPERS.letter.margin, 72);
  });
});

describe("the print command", () => {
  const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
  const run = (args: string[]): { out: string; status: number } => {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, "print", ...args], { encoding: "utf8" });
    return { out: `${result.stdout}${result.stderr}`, status: result.status ?? -1 };
  };
  const withBank = async (fn: (path: string, dir: string) => void): Promise<void> => {
    const dir = mkdtempSync(join(tmpdir(), "openassess-print-"));
    try {
      const bank = Bank.createEmpty("Capitals", { at: AT });
      bank.add(MC);
      bank.add(TF_NONE);
      const path = join(dir, "Capitals.openassess");
      await bank.save(path);
      fn(path, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("says what each copy holds, and writes the files asked for", async () => {
    await withBank((path, dir) => {
      const said = run([path, "--kind", "both", "--format", "pdf", "--out", join(dir, "out")]);
      assert.equal(said.status, 0, said.out);
      assert.match(said.out, /Student copy: 2 question\(s\), 2 print as written, 0 with a note/);
      assert.match(said.out, /Answer key: 2 question\(s\), 1 print as written, 1 with a note/);
      assert.match(said.out, /Nothing was guessed/);
      assert.deepEqual(readdirSync(join(dir, "out")).sort(), ["Capitals - Answer key.pdf", "Capitals - Student copy.pdf"]);
      assert.equal(readFileSync(join(dir, "out", "Capitals - Student copy.pdf")).subarray(0, 5).toString("latin1"), "%PDF-");
    });
  });

  test("writes nothing without --out, and says so", async () => {
    await withBank((path) => {
      const said = run([path]);
      assert.equal(said.status, 0);
      assert.match(said.out, /Nothing was written\. Add --out/);
    });
  });

  test("refuses a kind, a format or a paper it does not know", async () => {
    await withBank((path) => {
      for (const [flag, value] of [["--kind", "teacher"], ["--format", "rtf"], ["--paper", "legal"]] as const) {
        const said = run([path, flag, value]);
        assert.equal(said.status, 2, flag);
        assert.match(said.out, /Unknown/, flag);
      }
    });
  });
});

describe("printing a test", () => {
  test("names the files for the title and the kind, and says how many pages", () => {
    const student = printTest([MC, TF], opts("student", { title: "Unit 3: Capitals?" }), "pdf");
    assert.equal(student.file.name, "Unit 3- Capitals- - Student copy.pdf");
    assert.ok((student.file.pages ?? 0) >= 1);
    const key = printTest([MC, TF], opts("key", { title: "Unit 3" }), "docx");
    assert.equal(key.file.name, "Unit 3 - Answer key.docx");
    assert.deepEqual(key.report.files, ["Unit 3 - Answer key.docx"]);
  });

  test("keeps the font size and the number of lines within what a page can hold", () => {
    const wild = printOptions({ title: "T", fontSize: 400, shortAnswerLines: -3, essayLines: 4000 });
    assert.equal(wild.fontSize, 14);
    assert.equal(wild.shortAnswerLines, 0);
    assert.equal(wild.essayLines, 40);
    assert.equal(printOptions({ title: "T", fontSize: 2 }).fontSize, 9);
  });

  test("is the same file for the same questions: nothing changes from one printing to the next", () => {
    const at = new Date("2026-01-01T00:00:00Z");
    const a = printTest(ALL, opts("student"), "pdf", at);
    const b = printTest(ALL, opts("student"), "pdf", at);
    assert.deepEqual(a.file.bytes, b.file.bytes);
    assert.deepEqual(printTest(ALL, opts("key"), "docx", at).file.bytes, printTest(ALL, opts("key"), "docx", at).file.bytes);
  });
});
