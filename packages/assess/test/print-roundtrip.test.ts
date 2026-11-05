/**
 * What is printed is read back, and held to the rules of a printed test: the student copy shows every question and every answer to
 * choose from and shows nothing that gives one away, and the key shows the answers.
 *
 * Random questions, each with words of its own that make a leak easy to see (feedback for a right and a wrong answer, a note under
 * each option, the accepted answers of a short answer), are printed as a student copy and an answer key, in PDF and in Word, and
 * the files are read back with the project's own readers (the PDF reader and the Word reader), so that what is checked is what is on
 * the page and not what the layout meant to put there. 150 rounds of the PDF were run when this was written with no problem.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { docxToBlocks } from "../src/import/word.ts";
import { pdfToBlocks } from "../src/import/pdf.ts";
import { createQuestion } from "../src/model/create.ts";
import type { Question } from "../src/model/question.ts";
import { plainToRich } from "../src/model/richtext.ts";
import { printOptions, printTest } from "../src/print/index.ts";

function generator(seed: number): (n: number) => number {
  let state = seed >>> 0;
  return (n) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 4294967296) * n);
  };
}

interface Made {
  q: Question;
  stem: string;
  /** What a student must be able to read: every option, or every side of a matching question. */
  shown: string[];
  /** What must not be on the student copy. */
  secrets: string[];
  /** What must be on the key. */
  keyHas: string[];
}

let counter = 0;
function make(int: (n: number) => number): Made {
  counter++;
  const tag = `Q${counter}Z`;
  const stem = `Stem ${tag} about ${["rivers", "cells", "maths", "poems"][int(4)]}`;
  const feedback = { general: plainToRich(`FEEDBACK${tag}`) };
  switch (int(6)) {
    case 0:
    case 1: {
      const options = ["A", "B", "C"].map((l) => `Opt${tag}${l}`);
      const right = int(3);
      return {
        q: createQuestion({
          type: "multipleChoice",
          stem: plainToRich(stem),
          feedback: { ...feedback, correct: plainToRich(`CORRECT${tag}`), incorrect: plainToRich(`INCORRECT${tag}`) },
          body: { shuffle: false, options: options.map((t, i) => ({ id: `o${i}`, content: plainToRich(t), correct: i === right, feedback: plainToRich(`OPTNOTE${tag}${i}`) })) } as never,
        }),
        stem,
        shown: options,
        secrets: [`FEEDBACK${tag}`, `CORRECT${tag}`, `INCORRECT${tag}`, `OPTNOTE${tag}`],
        keyHas: [],
      };
    }
    case 2: {
      const options = ["A", "B", "C", "D"].map((l) => `Opt${tag}${l}`);
      return {
        q: createQuestion({ type: "multipleResponse", stem: plainToRich(stem), feedback, body: { shuffle: false, partialCredit: false, options: options.map((t, i) => ({ id: `o${i}`, content: plainToRich(t), correct: i < 2 })) } as never }),
        stem,
        shown: options,
        secrets: [`FEEDBACK${tag}`],
        keyHas: [],
      };
    }
    case 3:
      return { q: createQuestion({ type: "trueFalse", stem: plainToRich(stem), feedback, body: { correct: true } }), stem, shown: [], secrets: [`FEEDBACK${tag}`], keyHas: ["True"] };
    case 4: {
      const accepted = [`ACCEPT${tag}ONE`, `ACCEPT${tag}TWO`];
      return { q: createQuestion({ type: "shortAnswer", stem: plainToRich(stem), feedback, body: { caseSensitive: false, accepted } }), stem, shown: [], secrets: [`FEEDBACK${tag}`, ...accepted], keyHas: [accepted[0] as string] };
    }
    default: {
      const lefts = [1, 2, 3].map((i) => `Left${tag}${i}`);
      const rights = [1, 2, 3].map((i) => `Right${tag}${i}`);
      return {
        q: createQuestion({ type: "matching", stem: plainToRich(stem), feedback, body: { shuffle: true, distractors: [], pairs: lefts.map((l, i) => ({ id: `p${i}`, left: plainToRich(l), right: rights[i] as string })) } as never }),
        stem,
        shown: [...lefts, ...rights],
        secrets: [`FEEDBACK${tag}`],
        keyHas: [],
      };
    }
  }
}

const squash = (s: string): string => s.replace(/\s+/g, " ");
const pdfText = (bytes: Uint8Array): string => squash(pdfToBlocks(bytes).blocks.map((b) => b.text).join("\n"));
const docxText = (bytes: Uint8Array): string => squash(docxToBlocks(bytes).blocks.map((b) => b.text).join("\n"));

describe("a printed test, read back", () => {
  for (const [format, read] of [["pdf", pdfText], ["docx", docxText]] as const) {
    test(`as ${format === "pdf" ? "a PDF" : "a Word file"}: the student copy shows every question and answer to choose from and gives none away, and the key has the answers`, () => {
      const problems: string[] = [];
      for (let round = 0; round < 40; round++) {
        const int = generator(3000 + round);
        const made = Array.from({ length: 1 + int(6) }, () => make(int));
        for (const kind of ["student", "key"] as const) {
          const text = read(printTest(made.map((m) => m.q), printOptions({ title: "Fuzz test", kind }), format).file.bytes);
          for (const m of made) {
            if (!text.includes(squash(m.stem))) problems.push(`${kind}, round ${round}: a stem is missing: ${m.stem}`);
            if (kind === "student") {
              for (const secret of m.secrets) if (text.includes(secret)) problems.push(`student, round ${round}: ${secret} is printed (${m.q.type})`);
              for (const shown of m.shown) if (!text.includes(shown)) problems.push(`student, round ${round}: ${shown} is missing (${m.q.type})`);
            } else {
              for (const answer of m.keyHas) if (!text.includes(answer)) problems.push(`key, round ${round}: ${answer} is missing (${m.q.type})`);
            }
          }
        }
      }
      assert.deepEqual(problems.slice(0, 10), [], `${problems.length} problems`);
    });
  }

  test("a student copy of a matching question shows both sides and never in the order of the key", () => {
    const lefts = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"];
    const rights = ["One", "Two", "Three", "Four", "Five"];
    // A fixed id, so that the shuffle is the same on every run: it is made from the id, and a five-item shuffle is in the order of the
    // key once in 120, which a random id would make a test that fails now and then.
    const q = createQuestion({ id: "q_print_order_check", type: "matching", stem: plainToRich("Match each letter to its number"), body: { shuffle: true, distractors: [], pairs: lefts.map((l, i) => ({ id: `p${i}`, left: plainToRich(l), right: rights[i] as string })) } as never });
    const student = pdfText(printTest([q], printOptions({ title: "M", kind: "student" }), "pdf").file.bytes);
    for (const word of [...lefts, ...rights]) assert.ok(student.includes(word), `${word} is on the student copy`);
    const places = rights.map((w) => student.indexOf(w));
    assert.equal(places.every((place, i) => i === 0 || (places[i - 1] as number) < place), false, "the right-hand side is not in the order of the key");
    const again = pdfText(printTest([q], printOptions({ title: "M", kind: "student" }), "pdf").file.bytes);
    assert.equal(again, student, "and it is the same every time for the same question");
  });
});
