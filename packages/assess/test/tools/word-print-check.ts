/**
 * Checks the printed Word files against Word itself.
 *
 * A file that Word will not open, or opens only after offering to repair it, is a test a person cannot print. This writes the
 * printed tests of OpenAssess as Word files, has a separate hidden Word open each and say what every paragraph holds, and
 * compares that with what the layout meant to put there: the typed number, a tab, the text. It also reports how many pages
 * Word made of each. It needs Windows with Microsoft Word installed and is not part of `npm test`. Run it with
 * `npm run check:word-print --workspace packages/assess`.
 */

import { unzipSync } from "../../src/container/zip.ts";
import { createQuestion } from "../../src/model/create.ts";
import { mediaPlaceholder, plainToRich, rich } from "../../src/model/richtext.ts";
import { wordImporter } from "../../src/import/word.ts";
import { docx, paragraph, run } from "../support/docx-writer.ts";
import { png } from "../support/images.ts";
import type { Question, QuestionBody, QuestionType } from "../../src/model/question.ts";
import { layoutTest, printOptions, writeDocx, type Block, type PrintOptions } from "../../src/print/index.ts";
import { longTest, questionSpans } from "../support/long-test.ts";
import { askWord, wordIsAvailable } from "./ask-word.ts";

const AT = "2026-01-01T00:00:00.000Z";
const opt = (id: string, text: string, correct = false) => ({ id, content: plainToRich(text), correct });
const make = (type: QuestionType, body: QuestionBody, stem: string, n: number): Question => createQuestion({ type, stem: plainToRich(stem), body, by: "t", at: AT, id: `q_${String(n).padStart(26, "0")}` });

const SET: Question[] = [
  make("multipleChoice", { shuffle: true, options: [opt("o1", "Berlin"), opt("o2", "Paris", true), opt("o3", "Rome")] }, "What is the capital of France?", 1),
  make("multipleResponse", { shuffle: true, partialCredit: true, options: [opt("o1", "Red", true), opt("o2", "Green"), opt("o3", "Blue", true)] }, "Which are primary colours?", 2),
  make("trueFalse", { correct: false }, "A light-year is a measure of time.", 3),
  make("fillInBlank", { caseSensitive: false, blanks: [{ id: "b1", accepted: ["Rome"] }] }, "The capital of Italy is ____.", 4),
  make("shortAnswer", { caseSensitive: false, accepted: ["Nile"] }, "Name the longest river in Egypt.", 5),
  make("matching", { shuffle: true, distractors: ["Oslo"], pairs: [{ id: "p1", left: plainToRich("France"), right: "Paris" }, { id: "p2", left: plainToRich("Italy"), right: "Rome" }] }, "Match each country to its capital.", 6),
  make("ordering", { items: ["Pond", "Lake", "Sea"].map((t, i) => ({ id: `i${i + 1}`, content: plainToRich(t), position: i + 1 })) }, "Put these in order.", 7),
  make("numeric", { mode: "exact", value: 10, units: "m" }, "What is 9.8 rounded?", 8),
  make("essay", { modelAnswer: plainToRich("Scattering.") }, "Explain why the sky is blue.", 9),
  make("shortAnswer", { caseSensitive: false, accepted: ["x"] }, "Is </w:t><w:p>& \"quotes\" <script> ]]> a problem? Café, 中文.", 10),
];

interface Case {
  name: string;
  options: PrintOptions;
  bytes: Uint8Array;
  expected: string[];
  paragraphs: number;
  /** The running header Word should show: empty when the test is not one of several versions. */
  header: string;
}

/** What Word should say each paragraph holds, from the layout: a picture is the one character Word shows for it in the text, a slash. */
const expectedOf = (blocks: Block[]): string[] =>
  blocks.flatMap((b: Block): string[] => {
    if (b.kind === "para") return [`${b.marker ? `${b.marker}\t` : ""}${b.runs.map((r) => r.text.replace(/\n/g, "\u000b")).join("")}`];
    if (b.kind === "lines") return Array.from({ length: b.count }, () => "\t");
    if (b.kind === "picture") return ["/"];
    return [""];
  });

const cases: Case[] = [];
// A test of one version, and a version of a test of several: the second has a running header and a line about the answer sheet,
// and on the key a strip of letters, and Word has to open it without offering to repair it and show the header.
for (const [label, more] of [["", {}], ["-version-B", { versionLabel: "B", answerOnSheet: true, keyStrip: true }]] as const) {
  for (const kind of ["student", "key"] as const) {
    for (const paper of ["letter", "a4"] as const) {
      const options = printOptions({ title: "Check test", kind, paper, instructions: "Use a pen.", ...more });
      const { document } = layoutTest(SET, options);
      const bytes = writeDocx(document);
      const expected = expectedOf(document.blocks);
      cases.push({ name: `${kind}-${paper}${label}`, options, bytes, expected, paragraphs: expected.length, header: document.header ?? "" });
    }
  }
}

// A test with pictures: Word has to open it without offering to repair it, keep the picture where it was put, draw it at the size it
// was printed and carry its description. The pictures are real PNGs (one with half-clear pixels), so Word can read them.
const PICTURE_A = png(60, 40);
const PICTURE_B = png(300, 200, { colorType: 6, alpha: 128 });
const pictureQuestions: Question[] = [
  createQuestion({
    type: "multipleChoice",
    stem: rich(`<p>What colour is this?</p><p>${mediaPlaceholder("m1")}</p>`),
    body: { shuffle: false, options: [opt("o1", "Blue", true), opt("o2", "Red")] },
    media: [{ id: "m1", file: "media/p-1111111111111111.png", mime: "image/png", alt: "A blue box" }],
    by: "t",
    at: AT,
    id: "q_picture_1",
  }),
  createQuestion({
    type: "multipleChoice",
    stem: plainToRich("Which is larger?"),
    body: { shuffle: false, options: [{ id: "o1", content: rich(`<p>The left ${mediaPlaceholder("m1")}</p>`), correct: true }, opt("o2", "The right")] },
    media: [{ id: "m1", file: "media/p-2222222222222222.png", mime: "image/png", alt: "Two bars, the left one taller" }],
    by: "t",
    at: AT,
    id: "q_picture_2",
  }),
];
const pictureOptions = printOptions({
  title: "Pictures",
  kind: "student",
  media: new Map([
    ["media/p-1111111111111111.png", PICTURE_A],
    ["media/p-2222222222222222.png", PICTURE_B],
  ]),
});
const pictureLayout = layoutTest(pictureQuestions, { ...pictureOptions, format: "docx" });
const pictureExpected = expectedOf(pictureLayout.document.blocks);
const pictureCase: Case = { name: "pictures", options: pictureOptions, bytes: writeDocx(pictureLayout.document), expected: pictureExpected, paragraphs: pictureExpected.length, header: "" };
cases.push(pictureCase);

// A test with equations that came from a Word file, so that the copy of Word's own XML is the one a real import keeps. The equations
// are a fraction in a stem, a superscript in an option and a root in a stem.
const math = (inner: string): string => `<m:oMath>${inner}</m:oMath>`;
const mr = (t: string): string => `<m:r><m:t>${t}</m:t></m:r>`;
const equationFile = docx({
  body: [
    paragraph(run("1. Solve ") + math(`<m:f><m:fPr><m:ctrlPr/></m:fPr><m:num>${mr("x")}</m:num><m:den>${mr("2")}</m:den></m:f>${mr("=3")}`) + run(" for x.")),
    paragraph(run("a) ") + math(`<m:sSup><m:sSupPr><m:ctrlPr/></m:sSupPr><m:e>${mr("x")}</m:e><m:sup>${mr("2")}</m:sup></m:sSup>`)),
    paragraph(run("b) none")),
    paragraph(run("Answer: a")),
    paragraph(run("2. What is ") + math(`<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${mr("16")}</m:e></m:rad>`) + run("?")),
    paragraph(run("a) 4")),
    paragraph(run("b) 8")),
    paragraph(run("Answer: a")),
  ].join(""),
});
const equationQuestions = wordImporter.parseBytes(equationFile, { file: "equations.docx", at: AT, author: "t" }).questions;
const equationOptions = printOptions({ title: "Equations", kind: "student" });
const equationLayout = layoutTest(equationQuestions, { ...equationOptions, format: "docx" });
const equationExpected = expectedOf(equationLayout.document.blocks);
const equationCase: Case = { name: "equations", options: equationOptions, bytes: writeDocx(equationLayout.document), expected: equationExpected, paragraphs: equationExpected.length, header: "" };

function main(): void {
  if (!wordIsAvailable()) {
    console.log("This check needs Windows with Microsoft Word installed. Nothing was run.");
    return;
  }
  const answers = askWord(new Map(cases.map((c) => [c.name, c.bytes])), "text");
  let disagreements = 0;
  let paragraphs = 0;
  for (const c of cases) {
    const theirs = answers[c.name] ?? [];
    if (theirs[0]?.startsWith("ERROR")) {
      console.log(`${c.name}: Word could not open it. ${theirs[0]}`);
      disagreements++;
      continue;
    }
    const pages = theirs.at(-1)?.startsWith("PAGES:") ? Number(theirs.pop()?.slice(6)) : 0;
    const header = theirs.at(-1)?.startsWith("HEADER:") ? (theirs.pop() as string).slice(7) : "";
    if (header !== c.header) {
      console.log(`${c.name}: Word shows the header ${JSON.stringify(header)}, the layout meant ${JSON.stringify(c.header)}`);
      disagreements++;
    }
    // Word counts a paragraph that is only a tab as one, as the layout does. Anything else is a difference worth saying.
    if (theirs.length !== c.expected.length) {
      console.log(`${c.name}: Word reads ${theirs.length} paragraphs, the layout has ${c.expected.length}`);
      disagreements++;
      continue;
    }
    c.expected.forEach((want, i) => {
      paragraphs++;
      if (theirs[i] !== want) {
        console.log(`${c.name}[${i}]: Word has ${JSON.stringify(theirs[i])}, the layout meant ${JSON.stringify(want)}`);
        disagreements++;
      }
    });
    console.log(`${c.name}: ${theirs.length} paragraphs, ${pages} page${pages === 1 ? "" : "s"} in Word`);
  }
  // The package itself is checked too: Word opens the file, and every part it should have is in it.
  for (const c of cases) {
    const parts = unzipSync(c.bytes);
    for (const name of ["[Content_Types].xml", "word/document.xml", "word/styles.xml", "word/footer1.xml", ...(c.header !== "" ? ["word/header1.xml"] : [])]) {
      if (!parts.has(name)) {
        console.log(`${c.name}: the package has no ${name}`);
        disagreements++;
      }
    }
  }
  console.log(`${cases.length} documents, ${paragraphs} paragraphs, ${disagreements} disagreements with Word.`);
  if (disagreements > 0) process.exitCode = 1;

  // The pictures themselves: Word is asked for each picture's size in points, its description and its type, in the order of the text.
  const seen = askWord(new Map([["pictures", pictureCase.bytes]]), "pictures")["pictures"] ?? [];
  const drawn = pictureLayout.document.blocks.flatMap((b: Block) => (b.kind === "picture" ? [b] : []));
  const floating = seen.at(-1)?.startsWith("SHAPES:") ? Number((seen.pop() as string).slice(7)) : -1;
  let pictureProblems = 0;
  if (seen.length !== drawn.length) {
    console.log(`pictures: Word shows ${seen.length} pictures, the layout has ${drawn.length}${seen[0]?.startsWith("ERROR") ? `. ${seen[0]}` : ""}`);
    pictureProblems++;
  } else {
    drawn.forEach((b, i) => {
      const [w, h, alt, type] = (seen[i] as string).split("|");
      const sized = Math.abs(Number(w) - b.w) < 0.6 && Math.abs(Number(h) - b.h) < 0.6;
      // Type 3 is wdInlineShapePicture: a picture held in the file, not a linked one and not an object Word could not read.
      if (!sized || alt !== b.picture.alt || type !== "3") {
        console.log(`picture ${i + 1}: Word has ${w} by ${h} points, description ${JSON.stringify(alt)}, type ${type}; the layout meant ${b.w.toFixed(1)} by ${b.h.toFixed(1)}, ${JSON.stringify(b.picture.alt)}, type 3`);
        pictureProblems++;
      }
    });
  }
  if (floating !== 0) {
    console.log(`pictures: Word reports ${floating} floating shapes, and there should be none`);
    pictureProblems++;
  }
  console.log(`${drawn.length} pictures, ${pictureProblems} disagreements with Word.`);
  if (pictureProblems > 0) process.exitCode = 1;

  // The equations: a printed test with three equations from a Word file, which Word has to open without offering to repair it and show
  // as three equations (inline, in the order of the text), of the kinds the file had: a fraction, a superscript and a root.
  const seenEquations = askWord(new Map([["equations", equationCase.bytes]]), "equations")["equations"] ?? [];
  let equationProblems = 0;
  if (seenEquations.length !== 3 || seenEquations[0]?.startsWith("ERROR")) {
    console.log(`equations: Word shows ${seenEquations.length} equations, the layout has 3${seenEquations[0]?.startsWith("ERROR") ? `. ${seenEquations[0]}` : ""}`);
    equationProblems++;
  } else {
    seenEquations.forEach((line, i) => {
      const [type, , first] = line.split("|");
      const want = [7, 19, 16][i];
      console.log(`  equation ${i + 1}: ${line}`);
      if (type !== "1" || Number(first) !== want) {
        console.log(`equation ${i + 1}: Word has an equation of type ${type} whose first function is ${first}; the layout meant an inline one with function ${want}`);
        equationProblems++;
      }
    });
  }
  console.log(`3 equations, ${equationProblems} disagreements with Word.`);
  if (equationProblems > 0) process.exitCode = 1;

  // Where Word breaks the pages: a question that begins on one page and goes on over the next is a question a student has to turn
  // the page in the middle of. Word is asked what page each paragraph starts and ends on, in a long test, student copy and key.
  const long = longTest();
  const documents = new Map<string, Uint8Array>();
  const spans = new Map<string, Array<[number, number]>>();
  const paragraphsOf = new Map<string, number[]>();
  for (const kind of ["student", "key"] as const) {
    const { document } = layoutTest(long, printOptions({ title: "Long test", kind, paper: "letter" }));
    documents.set(kind, writeDocx(document));
    spans.set(kind, questionSpans(document.blocks));
    // How many paragraphs each block is in the Word file: a block of writing lines is one for each line.
    let at = 0;
    paragraphsOf.set(kind, document.blocks.map((b: Block) => { const first = at; at += b.kind === "lines" ? b.count : 1; return first; }).concat(at));
  }
  const pageAnswers = askWord(documents, "pages");
  let split = 0;
  let questions = 0;
  let pageCount = 0;
  for (const kind of ["student", "key"] as const) {
    const theirs = pageAnswers[kind] ?? [];
    const firstOf = paragraphsOf.get(kind) as number[];
    for (const [start, end] of spans.get(kind) as Array<[number, number]>) {
      questions++;
      const pages = theirs.slice(firstOf[start], firstOf[end]).flatMap((p) => p.split(":").map(Number));
      pageCount = Math.max(pageCount, ...pages);
      const first = Math.min(...pages);
      const last = Math.max(...pages);
      if (first !== last) {
        split++;
        console.log(`${kind}: question ${questions % long.length || long.length} runs from page ${first} to page ${last} in Word`);
      }
    }
  }
  console.log(`${questions} questions in ${documents.size} long documents, up to ${pageCount} pages, ${split} split across a page by Word.`);
  if (split > 0) process.exitCode = 1;
}

main();
