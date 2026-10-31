/**
 * Question numbers written Q1., Question 1:, (1) and 4.1, and options labelled (A) and A:. Four of the layouts that a
 * set of generated banks could not be read in began this way, and none of them was read at all. Each form is read where it is
 * safe to, and the places where it is not are tested as hard as the places where it is: a stem that begins with the word
 * "Question", a line that Word wrapped in the middle of an answer so that it begins "(2) the offer is ...", a decimal at the start of
 * a line, a true or false statement that begins "(T)". These tests use invented text.
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
const inWord = (lines: string[]): ImportResult =>
  wordImporter.parseBytes(docx({ body: lines.map((l) => paragraph(l === "" ? "" : run(l))).join("") }), { ...OPTIONS, file: "t.docx" });
const both = (lines: string[]): ImportResult[] => [text(lines), inWord(lines)];

const plain = (rich: Parameters<typeof richTextToPlain>[0]): string => richTextToPlain(rich).replace(/\s+/g, " ").trim();
const stems = (r: ImportResult): string[] => r.questions.map((q) => plain(q.stem));
const optionsOf = (q: Question): Array<{ words: string; correct: boolean }> =>
  ((q.body as Record<string, any>)["options"] as Array<{ content: Parameters<typeof plain>[0]; correct?: boolean }>).map((o) => ({
    words: plain(o.content),
    correct: o.correct === true,
  }));
const wordsOf = (q: Question): string[] => optionsOf(q).map((o) => o.words);
const rightOf = (q: Question): string[] => optionsOf(q).filter((o) => o.correct).map((o) => o.words);
const has = (q: Question, code: string): boolean => q.findings.some((f) => f.code === code);
const verdict = (q: Question): string => verdictFrom(q.findings);
const at = (r: ImportResult, n: number): Question => r.questions[n] as Question;

/** Three questions, each with options A to C and an Answer line, numbered by `number`. */
const bank = (number: (n: number) => string, option: (letter: string) => string = (l) => `${l}.`): string[] => [
  `${number(1)} Which animal lays eggs?`, `${option("A")} Dog`, `${option("B")} Hen`, `${option("C")} Cat`, "Answer: B", "",
  `${number(2)} What colour is the sky on a clear day?`, `${option("A")} Green`, `${option("B")} Red`, `${option("C")} Blue`, "Answer: C", "",
  `${number(3)} How many days are in a week?`, `${option("A")} Seven`, `${option("B")} Six`, `${option("C")} Eight`, "Answer: A",
];
const ANIMALS = ["Which animal lays eggs?", "What colour is the sky on a clear day?", "How many days are in a week?"];

describe("Q1. and Question 1:", () => {
  test("a number with a Q in front is a question number, and what follows it is the stem", () => {
    for (const form of [(n: number) => `Q${n}.`, (n: number) => `Q${n})`, (n: number) => `Q${n}:`, (n: number) => `Q ${n}.`, (n: number) => `q${n}.`]) {
      for (const result of both(bank(form))) {
        assert.deepEqual(stems(result), ANIMALS, form(1));
        assert.deepEqual(rightOf(at(result, 0)), ["Hen"]);
        assert.deepEqual(rightOf(at(result, 2)), ["Seven"]);
        assert.equal(result.orphans.length, 0);
      }
    }
  });

  test("the word Question and a number, with a colon, a full stop or a bracket", () => {
    for (const form of [(n: number) => `Question ${n}:`, (n: number) => `Question ${n}.`, (n: number) => `Question ${n})`, (n: number) => `QUESTION ${n}:`]) {
      for (const result of both(bank(form))) {
        assert.deepEqual(stems(result), ANIMALS, form(1));
        assert.equal(verdict(at(result, 1)), "parsed");
      }
    }
  });

  test("the stem can be on the line under the number", () => {
    const result = text(["Question 1:", "Which animal lays eggs?", "A. Dog", "B. Hen", "Answer: B"]);
    assert.deepEqual(stems(result), ["Which animal lays eggs?"]);
    assert.deepEqual(wordsOf(at(result, 0)), ["Dog", "Hen"]);
  });

  test("a stem that begins with the word Question is not a question number", () => {
    // "Question 1.1?" is a stem; the number is 1.1 on the line above it. And "Question 3 of the exam" has no mark after the 3.
    const result = text(["1.1", "Question 1.1?", "A. Yes", "B. No", "Answer: A", "", "1.2", "Question 1.2?", "A. Yes", "B. No", "Answer: B"]);
    assert.deepEqual(stems(result), ["Question 1.1?", "Question 1.2?"]);
    const sentence = text(["1. Which of these is true?", "Question 3 of the exam asked about eggs.", "A. Yes", "B. No", "Answer: A"]);
    assert.equal(sentence.questions.length, 1);
    assert.match(stems(sentence)[0] ?? "", /Question 3 of the exam asked about eggs\./);
    // A Q or a Question that runs straight into its number's text is not one either.
    assert.equal(text(["1. Is it so?", "Q2.5 is a value.", "A. Yes", "B. No", "Answer: A"]).questions.length, 1);
  });

  test("a number out of sequence under a stem is part of the stem, with a Q in front as without", () => {
    const result = text(["Q1. Which is right? The first part of it", "Q1. of the sentence goes on", "A. One", "B. Two", "Answer: A"]);
    assert.equal(result.questions.length, 1);
    assert.ok(has(at(result, 0), FindingCode.NumberOutOfSequence));
  });
});

describe("(1) as a question number", () => {
  test("is read in a file that numbers its questions that way", () => {
    for (const result of both(bank((n) => `(${n})`))) {
      assert.deepEqual(stems(result), ANIMALS);
      assert.deepEqual(rightOf(at(result, 1)), ["Blue"]);
    }
  });

  test("is not read in a file that does not do it three times", () => {
    const two = text(["(1) Which animal lays eggs?", "A. Dog", "B. Hen", "Answer: B", "", "(2) What colour is the sky?", "A. Red", "B. Blue", "Answer: B"]);
    assert.equal(two.questions.length, 0, "two are not a habit");
  });

  test("is not read when it is not the number that comes next, as in an answer that Word wrapped", () => {
    // Typed numbers, and a long answer that wraps so that a line begins "(2) the offer ...". It is the end of the answer.
    const wrapped = text([
      "1. Which animal lays eggs?", "A. Dog", "B. Hen", "Answer: B", "",
      "2. Describe the offer process.", "The offer process has three parts: (1) the first offer; ", "(2) the counter offer is made; and (3) the deal is closed.", "",
      "3. What colour is the sky?", "A. Red", "B. Blue", "Answer: B",
    ]);
    assert.equal(wrapped.questions.length, 3);
    assert.match(stems(wrapped)[1] ?? "", /counter offer/);
    // And in a file that does number with brackets, a bracketed number that is not the next one is still not a start.
    const ten = Array.from({ length: 10 }, (_, i) => [`(${i + 1}) Question number ${i + 1}?`, "A. Yes", "B. No", "Answer: A", ""]).flat();
    ten.splice(16, 0, "(9) the counter offer was made");
    ten.splice(26, 0, "(2) and the deal was closed");
    const habit = text(ten);
    assert.equal(habit.questions.length, 10);
    assert.match(stems(habit)[3] ?? "", /Question number 4\?/);
  });

  test("a skipped number, or a repeated one, does not stop the rest being read", () => {
    // Two of the slips a tired author leaves in a numbered bank: (7) missing, and (3) written twice.
    const numbers = [1, 2, 3, 3, 4, 5, 6, 8, 9, 10, 11, 12];
    const lines = numbers.flatMap((n) => [`(${n}) Question about number ${n}?`, "A. Yes", "B. No", "Answer: A", ""]);
    const result = text(lines);
    assert.equal(result.questions.length, 12);
    assert.match(stems(result)[7] ?? "", /^Question about number 8\?$/);
    // A jump of more than three is not the next question: a wrapped line "(9) ..." in an answer to question 2 is not question 9.
    const jump = text([...lines.slice(0, 15), "The offer has parts: ", "(9) the counter offer is made", "", ...lines.slice(15)]);
    assert.equal(jump.questions.length, 12);
  });

  test("a bracketed number before the first question is a question only if it is 1", () => {
    // An instruction such as "(5) minutes are allowed" ahead of the bank is not question 5, whatever the habit.
    const ten = Array.from({ length: 10 }, (_, i) => [`(${i + 1}) Question number ${i + 1}?`, "A. Yes", "B. No", "Answer: A", ""]).flat();
    const result = text(["Read each question.", "(5) minutes are allowed for this test.", "", ...ten]);
    assert.equal(result.questions.length, 10);
    assert.match(stems(result)[0] ?? "", /^Question number 1\?$/);
  });

  test("a few that do not go on do not stop a long bank being read, and too many do", () => {
    // Ten bracketed questions and two strays: a habit. Three and three: not, which is said by reading none, loudly.
    const three = text([...bank((n) => `(${n})`), "", "(7) the counter offer is made", "(9) the deal is closed", "(10) the last term"]);
    assert.equal(three.questions.length, 0);
    assert.ok(three.fileFindings.some((f) => f.code === FindingCode.UnparsedBlock && f.severity === "error"));
  });

  test("the first, or the next, and a number that starts again after a question ends, are starts", () => {
    const again = text([...bank((n) => `(${n})`), "", "(1) Which is a bird?", "A. Hen", "B. Cow", "Answer: A"]);
    assert.equal(again.questions.length, 4);
    // Several sections, each numbered from (1): the restarts do not stop it being the file's habit.
    const sections = [1, 2, 3].flatMap(() => [...bank((n) => `(${n})`), ""]);
    assert.equal(text(sections).questions.length, 9);
  });

  test("a true or false statement that begins (T) or (F) is not an option or a question", () => {
    const result = text(["1. Choose each statement that is right.", "(T) Ice floats on water.", "(F) Fire is cold.", "(T) Birds have wings.", "", "2. Which animal lays eggs?", "A. Dog", "B. Hen", "Answer: B"]);
    assert.equal(result.questions.length, 2);
    assert.match(stems(result)[0] ?? "", /\(T\) Ice floats on water\./);
  });
});

describe("4.1 with the question's words on the same line", () => {
  const dotted = (chapter: number, n: number): string => `${chapter}.${n}`;

  test("is read in a file that numbers its questions that way", () => {
    const lines = bank((n) => dotted(4, n), (l) => `${l})`);
    for (const result of both(lines)) {
      assert.deepEqual(stems(result), ANIMALS);
      assert.deepEqual(rightOf(at(result, 1)), ["Blue"]);
    }
  });

  test("chapters are the first number, and a later chapter starts again", () => {
    const lines = [...bank((n) => dotted(4, n)), "", "5.1 Which is a bird?", "A. Hen", "B. Cow", "Answer: A"];
    assert.equal(text(lines).questions.length, 4);
  });

  test("is not read in a file with fewer than three, or where a decimal does not go on", () => {
    const two = text(["4.1 Which animal lays eggs?", "A. Dog", "B. Hen", "Answer: B", "", "4.2 What colour is the sky?", "A. Red", "B. Blue", "Answer: B"]);
    assert.equal(two.questions.length, 0);
    // Typed numbers, and decimals at the start of lines that are the words of a stem.
    const decimals = text([
      "1. A solution holds salt.", "3.5 grams of salt are in it.", "2.5 grams more are added.", "1.5 grams are then removed.", "How many grams are there now?", "A. 4.5", "B. 5.5", "Answer: A", "",
      "2. Which is a bird?", "A. Hen", "B. Cow", "Answer: A",
    ]);
    assert.equal(decimals.questions.length, 2);
  });

  test("lines that begin with a decimal and mostly do not go on are not a habit, even with three that do", () => {
    const decimals = ["1.5 grams more were added.", "2.5 grams were taken out.", "0.5 grams were left.", "3.5 grams were spilled.", "1.5 grams were found.", "2.5 grams remained."];
    const result = text([...bank((n) => dotted(4, n)), "", "A solution holds salt.", ...decimals]);
    assert.equal(result.questions.length, 0);
    assert.ok(result.fileFindings.some((f) => f.code === FindingCode.UnparsedBlock && f.severity === "error"));
  });

  test("a question that follows the options of the one before, with no answer line or blank between, is the next number", () => {
    const lines = [`4.1 ${ANIMALS[0]}`, "A. Dog", "B. Hen", `4.2 ${ANIMALS[1]}`, "A. Red", "B. Blue", `4.3 ${ANIMALS[2]}`, "A. Seven", "B. Six"];
    assert.deepEqual(stems(text(lines)), ANIMALS);
    // A number that skips one is a question too, as a bank that lost a question leaves it.
    assert.equal(text(lines.map((l) => l.replace("4.3 ", "4.5 "))).questions.length, 3);
  });

  test("inside a question it has to be the next number, so a decimal under a stem is part of the stem", () => {
    const lines = bank((n) => dotted(4, n));
    lines.splice(1, 0, "4.1 grams of salt were weighed first.");
    const result = text(lines);
    assert.equal(result.questions.length, 3);
    assert.match(stems(result)[0] ?? "", /^Which animal lays eggs\? 4\.1 grams of salt were weighed first\.$/);
  });

  test("a bank that numbers each section from 4.1 again is still a habit", () => {
    const section = (name: string): string[] => [name, ...bank((n) => dotted(4, n)), ""];
    assert.equal(text([...section("Section A"), ...section("Section B")]).questions.length, 6);
  });
});

describe("a numbered list inside a stem, in a file whose questions are numbered another way", () => {
  // The steps are typed 1. 2. 3., which is also how a plain bank numbers its questions. In a file whose questions are 2.5,
  // (2) or Q2. they are the stem's own. Read as questions, they cut the stem in two and the question came out fine and wrong.
  const STEPS = ["1. Write the augmented matrix", "2. Reduce it to row echelon form", "3. Back-substitute to find the unknowns"];
  const withSteps = (number: (n: number) => string): string[] => {
    const lines = bank(number);
    lines.splice(1, 0, ...STEPS);
    return lines;
  };
  const whole = new RegExp(`^Which animal lays eggs\\? 1\\. Write the augmented matrix 2\\. Reduce it to row echelon form 3\\. Back-substitute to find the unknowns$`);

  test("is the stem's own, with 4.1, (1), Q1. and Question 1: numbering", () => {
    for (const [name, number] of [
      ["4.1", (n: number) => `4.${n}`],
      ["(1)", (n: number) => `(${n})`],
      ["Q1.", (n: number) => `Q${n}.`],
      ["Question 1:", (n: number) => `Question ${n}:`],
    ] as const) {
      const result = text(withSteps(number));
      assert.equal(result.questions.length, 3, name);
      assert.match(stems(result)[0] ?? "", whole, name);
      assert.deepEqual(rightOf(at(result, 0)), ["Hen"], name);
    }
  });

  test("and the next question, numbered the file's way, still starts", () => {
    const result = text(withSteps((n) => `Q${n}.`));
    assert.deepEqual(stems(result).slice(1), ANIMALS.slice(1));
  });

  test("a file that numbers its questions 1. keeps doing so, even with one stray Q1: line in it", () => {
    const result = text(bank((n) => `${n}.`));
    assert.deepEqual(stems(result), ANIMALS);
    const stray = bank((n) => `${n}.`);
    stray.splice(1, 0, "Q1: revenue was up this year.");
    assert.equal(text(stray).questions.length, 3, "one line is not a habit, so a plain 2. is still a question");
  });
});

describe("options labelled (A) and A:", () => {
  test("(A) and A: are options, in order from A", () => {
    for (const option of [(l: string) => `(${l})`, (l: string) => `${l}:`]) {
      for (const result of both(bank((n) => `${n}.`, option))) {
        const q = at(result, 0);
        assert.deepEqual(wordsOf(q), ["Dog", "Hen", "Cat"], option("A"));
        assert.deepEqual(rightOf(q), ["Hen"]);
        assert.equal(verdict(q), "parsed");
      }
    }
  });

  test("a lower case letter in brackets is an option too, and a star in front is the key", () => {
    const q = at(text(["1. Which animal lays eggs?", "(a) Dog", "*(b) Hen", "(c) Cat"]), 0);
    assert.deepEqual(wordsOf(q), ["Dog", "Hen", "Cat"]);
    assert.deepEqual(rightOf(q), ["Hen"]);
  });

  test("a label that is not the next letter is not an option", () => {
    // B first, and a second A, are not options: the question is waiting for A, then B.
    const first = at(text(["1. Which is right?", "(B) Hen", "(C) Cat", "Answer: B"]), 0);
    assert.equal(first.type, "essay", "no option began the list, so there are none");
    // C is not the next letter after A, so it is not an option: it is reported as stray text, and the question, with one
    // option, is refused and not read as complete.
    const skipped = text(["1. Which is right?", "A: Dog", "C: Cat", "Answer: A"]);
    const skip = at(skipped, 0);
    assert.equal(wordsOf(skip)[0], "Dog");
    assert.ok(has(skip, FindingCode.TooFewOptions));
    assert.equal(verdict(skip), "failed");
    assert.deepEqual(skipped.orphans.map((o) => o.text), ["C: Cat"]);
  });

  test("a question and its answer on two lines is a question with one option, refused, and a card with no number is nothing", () => {
    // "A: Paris" is the first option of a question that has a number. "Q:" and "A:" with no number are not a question.
    const card = at(text(["1. What is the capital of France?", "A: Paris"]), 0);
    assert.equal(wordsOf(card)[0], "Paris");
    assert.equal(verdict(card), "failed");
    const none = text(["Q: What is the capital of France?", "A: Paris"]);
    assert.equal(none.questions.length, 0, "a Q: with no number is not a question number");
    assert.equal(none.orphans.length, 2, "and both lines are reported");
  });
});
