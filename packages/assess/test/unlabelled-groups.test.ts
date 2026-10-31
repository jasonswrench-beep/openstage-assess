/**
 * A bank that letters nothing and numbers nothing, or numbers only its stems: a stem, its options under it one to a line,
 * a blank line, the next stem, and the right option marked by bold or by a word. A set of generated banks in that layout
 * read no question at all, or read each stem with its options run into it. The importer now gives such a file the labels the
 * page does not show and reads it again, and keeps that reading only when it found keys the first one did not.
 *
 * Reading by layout alone is where a wrong question that looks right can come from, so most of these tests are about what
 * must not be read: a stem set apart from its options by a blank line, a title that shares the first question's run of lines,
 * a second paragraph of a stem, a tag such as MC on a line of its own. These tests use invented text.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { standardTextImporter } from "../src/import/standard-text.ts";
import { type ImportResult } from "../src/import/types.ts";
import { wordImporter } from "../src/import/word.ts";
import { FindingCode, verdictFrom } from "../src/model/findings.ts";
import type { Question } from "../src/model/question.ts";
import { richTextToPlain } from "../src/model/richtext.ts";
import { docx, paragraph, run } from "./support/docx-writer.ts";

const OPTIONS = { file: "t.txt", at: "2026-01-01T00:00:00.000Z", author: "test" };
const text = (lines: string[]): ImportResult => standardTextImporter.parse(lines.join("\n"), OPTIONS);
/** A line that starts with "**" is written in bold, which is how these banks mark the right option. */
const inWord = (lines: string[]): ImportResult =>
  wordImporter.parseBytes(
    docx({
      body: lines
        .map((l) => (l === "" ? paragraph("") : l.startsWith("**") ? paragraph(run(l.slice(2), "<w:b/>")) : paragraph(run(l))))
        .join(""),
    }),
    { ...OPTIONS, file: "t.docx" },
  );

const plain = (rich: Parameters<typeof richTextToPlain>[0]): string => richTextToPlain(rich).replace(/\s+/g, " ").trim();
const stemOf = (q: Question): string => plain(q.stem);
const optionsOf = (q: Question): Array<{ words: string; correct: boolean }> =>
  ((q.body as Record<string, any>)["options"] as Array<{ content: Parameters<typeof plain>[0]; correct?: boolean }>).map((o) => ({
    words: plain(o.content),
    correct: o.correct === true,
  }));
const rightOf = (q: Question): string[] => optionsOf(q).filter((o) => o.correct).map((o) => o.words);
const has = (q: Question, code: string): boolean => q.findings.some((f) => f.code === code);
const verdict = (q: Question): string => verdictFrom(q.findings);
const at = (r: ImportResult, n: number): Question => r.questions[n] as Question;
const said = (r: ImportResult): boolean => r.fileFindings.some((f) => f.code === FindingCode.UnlabelledGroups);

/** Five questions with four options each, the right one in bold, no numbers and no letters, a blank line between. */
const BANK: string[] = [
  "Which of these is a kind of fruit?", "Chair", "**Apple", "Desk", "Lamp", "",
  "Which planet is closest to the sun?", "**Mercury", "Venus", "Mars", "Jupiter", "",
  "What is the capital of France?", "Rome", "Madrid", "**Paris", "Berlin", "",
  "Which gas do plants take in from the air?", "Oxygen", "Helium", "**Carbon dioxide", "Neon", "",
  "Which of these animals is a mammal?", "Trout", "Eagle", "**Dolphin", "Gecko", "",
];
const RIGHT = ["Apple", "Mercury", "Paris", "Carbon dioxide", "Dolphin"];

describe("a bank with no numbers and no letters", () => {
  test("is read as questions, with the bold option as the key", () => {
    const result = inWord(BANK);
    assert.equal(result.questions.length, 5);
    assert.deepEqual(result.questions.map(stemOf), [
      "Which of these is a kind of fruit?", "Which planet is closest to the sun?", "What is the capital of France?",
      "Which gas do plants take in from the air?", "Which of these animals is a mammal?",
    ]);
    assert.deepEqual(result.questions.map((q) => rightOf(q)[0]), RIGHT);
    for (const q of result.questions) {
      assert.equal(optionsOf(q).length, 4);
      assert.equal(verdict(q), "parsed");
    }
    assert.equal(result.orphans.length, 0);
  });

  test("and the file says it was read by its layout", () => {
    const result = inWord(BANK);
    assert.ok(said(result));
    assert.match(result.fileFindings.find((f) => f.code === FindingCode.UnlabelledGroups)?.message ?? "", /5 groups of lines/);
  });

  test("a word after the option is a key too: (Correct)", () => {
    const lines = BANK.map((l) => (l.startsWith("**") ? `${l.slice(2)} (Correct)` : l));
    const result = text(lines);
    assert.equal(result.questions.length, 5);
    assert.deepEqual(result.questions.map((q) => rightOf(q)[0]), RIGHT);
    assert.ok(said(result));
  });

  test("with a title and instructions in the first run of lines, they are reported and the first question is read", () => {
    const result = inWord(["Science Quiz", "Instructions: Choose the best answer.", ...BANK]);
    assert.equal(result.questions.length, 5);
    assert.equal(stemOf(at(result, 0)), "Which of these is a kind of fruit?");
    assert.deepEqual(result.questions.map((q) => rightOf(q)[0]), RIGHT);
    assert.deepEqual(result.orphans.map((o) => o.text), ["Science Quiz", "Instructions: Choose the best answer."]);
    assert.match(result.fileFindings.find((f) => f.code === FindingCode.UnlabelledGroups)?.message ?? "", /first 2 lines/);
  });

  test("a title that is a run of its own, and a stem that stands alone with its answer line", () => {
    const lines = ["Science Quiz", "", ...BANK, "", "Ice is a solid form of water.", "Answer: True", "", "Name the largest ocean.", "Answer: Pacific"];
    const result = inWord(lines);
    assert.equal(result.questions.length, 7);
    assert.equal(at(result, 5).type, "trueFalse");
    assert.equal(at(result, 6).type, "essay", "a stem and an answer in words, with no blank, is not guessed to be anything but flagged");
    assert.deepEqual(result.orphans.map((o) => o.text), ["Science Quiz"]);
  });

  test("the stems that were numbered keep their numbers, and the options under them are lettered", () => {
    const lines = BANK.map((l, i) => {
      const n = BANK.slice(0, i).filter((x, k) => x !== "" && (k === 0 || BANK[k - 1] === "")).length + 1;
      return i === 0 || BANK[i - 1] === "" ? `Question ${n}: ${l}` : l;
    });
    const result = inWord(lines);
    assert.equal(result.questions.length, 5);
    assert.deepEqual(result.questions.map((q) => rightOf(q)[0]), RIGHT);
    assert.equal(stemOf(at(result, 2)), "What is the capital of France?");
    assert.match(result.fileFindings.find((f) => f.code === FindingCode.UnlabelledGroups)?.message ?? "", /question numbers but no option letters/);
  });
});

describe("what is not read, because reading it would make a question that is wrong and looks right", () => {
  test("a second paragraph of the stem that ends in a question mark belongs to the stem", () => {
    const lines = [...BANK];
    lines.splice(7, 0, "The sun is at the center of it. Which one is nearest?");
    const result = inWord(lines);
    assert.equal(result.questions.length, 5);
    assert.equal(stemOf(at(result, 1)), "Which planet is closest to the sun? The sun is at the center of it. Which one is nearest?");
    assert.equal(optionsOf(at(result, 1)).length, 4, "and the second paragraph is not a fifth option");
    assert.deepEqual(result.questions.map((q) => rightOf(q)[0]), RIGHT);
    assert.equal(verdict(at(result, 1)), "parsed");
  });

  test("a line far longer than the options is flagged, because it may be more of the stem", () => {
    const lines = [...BANK];
    lines.splice(7, 0, "Maintaining good health requires attention to sleep, food, exercise and the people around you every day.");
    const result = inWord(lines);
    assert.equal(result.questions.length, 5);
    const q = at(result, 1);
    assert.equal(verdict(q), "needsReview");
    assert.ok(has(q, FindingCode.UnlabelledGroups));
    for (const other of result.questions.filter((x) => x !== q)) assert.equal(verdict(other), "parsed");
  });

  test("a stem that ends in a colon, with a full sentence under it, is flagged", () => {
    const lines = [...BANK];
    lines[6] = "Consider the following statement about the sun:";
    lines.splice(7, 0, "The sun is a star at the center of our system.");
    const result = inWord(lines);
    assert.equal(verdict(at(result, 1)), "needsReview");
    assert.equal(verdict(at(result, 0)), "parsed");
  });

  test("a first question with a long stem makes the first run longer than the rest, and is read and flagged", () => {
    const lines = [...BANK];
    lines.splice(1, 0, "They want a snack that keeps them full. Which one is best?");
    const result = inWord(lines);
    assert.equal(result.questions.length, 5);
    assert.equal(stemOf(at(result, 0)), "Which of these is a kind of fruit? They want a snack that keeps them full. Which one is best?");
    assert.equal(optionsOf(at(result, 0)).length, 4);
    assert.equal(verdict(at(result, 0)), "needsReview");
  });

  test("a stem set apart from its options by a blank line is not read, since its first option would be the stem", () => {
    const lines = BANK.flatMap((l, i) => (i > 0 && BANK[i - 1] === "" ? [l, ""] : [l]));
    const result = inWord(lines);
    for (const q of result.questions) assert.notEqual(verdict(q), "parsed", "never a stem that is an option, marked parsed");
    assert.ok(!said(result));
  });

  test("a word or two on a line is not a stem: a type tag, and the lines under it are not its options", () => {
    const lines = BANK.flatMap((l, i) => (i === 0 || BANK[i - 1] === "" ? ["MC", l] : [l]));
    const result = inWord(lines);
    assert.ok(!result.questions.some((q) => stemOf(q) === "MC"));
  });


  test("two groups are not a habit", () => {
    const result = inWord(BANK.slice(0, 12));
    assert.equal(result.questions.length, 0);
    assert.ok(!said(result));
  });

  test("a few unlabelled groups in a file whose questions are numbered and lettered are not read", () => {
    const labelled = Array.from({ length: 8 }, (_, i) => [`${i + 1}. Which is number ${i + 1}?`, "A. One", "*B. Two", "C. Three", ""]).flat();
    const result = inWord([...labelled, ...BANK.slice(0, 18)]);
    assert.equal(result.questions.length, 8);
    assert.ok(!said(result));
  });

  test("no key anywhere: the groups are not read, since a layout alone is too little", () => {
    const lines = BANK.map((l) => (l.startsWith("**") ? l.slice(2) : l));
    const result = inWord(lines);
    assert.equal(result.questions.length, 0);
    assert.ok(!said(result));
  });

  test("a file that is read as it is, with letters, is never read again", () => {
    const lettered = Array.from({ length: 4 }, (_, i) => [`${i + 1}. Which is number ${i + 1}?`, "A. One", "*B. Two", "C. Three", ""]).flat();
    const result = text(lettered);
    assert.equal(result.questions.length, 4);
    assert.ok(!said(result));
  });
});
