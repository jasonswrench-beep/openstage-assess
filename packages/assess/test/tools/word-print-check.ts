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
import { plainToRich } from "../../src/model/richtext.ts";
import type { Question, QuestionBody, QuestionType } from "../../src/model/question.ts";
import { layoutTest, printOptions, writeDocx, type Block, type PrintOptions } from "../../src/print/index.ts";
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
}

const cases: Case[] = [];
for (const kind of ["student", "key"] as const) {
  for (const paper of ["letter", "a4"] as const) {
    const options = printOptions({ title: "Check test", kind, paper, instructions: "Use a pen." });
    const { document } = layoutTest(SET, options);
    const bytes = writeDocx(document);
    const expected = document.blocks.flatMap((b: Block): string[] => {
      if (b.kind === "para") return [`${b.marker ? `${b.marker}\t` : ""}${b.runs.map((r) => r.text.replace(/\n/g, "\u000b")).join("")}`];
      if (b.kind === "lines") return Array.from({ length: b.count }, () => "\t");
      return [""];
    });
    cases.push({ name: `${kind}-${paper}`, options, bytes, expected, paragraphs: expected.length });
  }
}

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
    for (const name of ["[Content_Types].xml", "word/document.xml", "word/styles.xml", "word/footer1.xml"]) {
      if (!parts.has(name)) {
        console.log(`${c.name}: the package has no ${name}`);
        disagreements++;
      }
    }
  }
  console.log(`${cases.length} documents, ${paragraphs} paragraphs, ${disagreements} disagreements with Word.`);
  if (disagreements > 0) process.exitCode = 1;
}

main();
