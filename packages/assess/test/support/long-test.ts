/**
 * A printed test long enough to run over several pages, with every kind of question in it and no two the same height, so that a
 * page break falls in a different place of a question each time. It is for checking that a question is never split across a page
 * (a question that began at the foot of one page with A and B, and went on with C and D on the next, was seen in a printed test).
 */

import { createQuestion } from "../../src/model/create.ts";
import { plainToRich } from "../../src/model/richtext.ts";
import type { Question, QuestionBody, QuestionType } from "../../src/model/question.ts";
import { NUMBER_INDENT, type Block } from "../../src/print/layout.ts";

const AT = "2026-01-01T00:00:00.000Z";
const opt = (id: string, text: string, correct = false) => ({ id, content: plainToRich(text), correct });
const make = (n: number, type: QuestionType, body: QuestionBody, stem: string): Question =>
  createQuestion({ type, stem: plainToRich(stem), body, by: "t", at: AT, id: `q_${String(n).padStart(26, "0")}` });

const WORDS = "the sample is left skewed with a tall peak and a flat tail around its mean and its spread across the participants".split(" ");
/** `n` words from the list above, starting at a place that changes with `from`, so that heights differ from one question to the next. */
const words = (n: number, from: number): string => Array.from({ length: n }, (_, i) => WORDS[(from + i) % WORDS.length]).join(" ");

export function longTest(count = 90): Question[] {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    // Four kinds of heights for the stem: one line, two, three, and a paragraph.
    const stem = `Item ${n}: ${words([6, 14, 28, 52][i % 4] as number, i)}?`;
    switch (i % 7) {
      case 0:
      case 1:
      case 4:
        return make(n, "multipleChoice", { shuffle: true, options: Array.from({ length: 3 + (i % 4) }, (_, k) => opt(`o${k}`, words(2 + ((i + k) % 9), i + k), k === 1)) }, stem);
      case 2:
        return make(n, "multipleResponse", { shuffle: true, partialCredit: true, options: Array.from({ length: 4 + (i % 3) }, (_, k) => opt(`o${k}`, words(3 + k, i + k), k % 2 === 0)) }, stem);
      case 3:
        return make(n, "trueFalse", { correct: i % 2 === 0 }, stem);
      case 5:
        return make(n, "matching", { shuffle: true, distractors: ["Spare"], pairs: Array.from({ length: 3 + (i % 3) }, (_, k) => ({ id: `p${k}`, left: plainToRich(words(3, i + k)), right: words(2, k) })) }, stem);
      default:
        return make(n, "ordering", { items: Array.from({ length: 4 + (i % 3) }, (_, k) => ({ id: `i${k}`, content: plainToRich(words(3, i + k)), position: k + 1 })) }, stem);
    }
  });
}

/** For each question of a laid-out test, the index of its first block and of the one after its last: a question starts at its numbered stem. */
export function questionSpans(blocks: readonly Block[]): Array<[number, number]> {
  const starts = blocks.flatMap((b, i) => (b.kind === "para" && b.indent === NUMBER_INDENT && /^\d+\.$/.test(b.marker ?? "") ? [i] : []));
  return starts.map((start, k) => [start, starts[k + 1] ?? blocks.length] as [number, number]);
}
