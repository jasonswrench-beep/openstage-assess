/**
 * Marks at the end of an option, and an answer line that says only "Correct:". Three layouts of a set of generated
 * banks marked the right option with "(Correct)" at the end of its line, or with a star at the end, or gave the answer on a line
 * "Correct: C", and the importer read none of them as a key. The places where a mark at the end must not count are tested as
 * hard as the places where it must: an option that is only "(Correct)", a line that holds several options, a star in a
 * file where it is decoration. These tests use invented text.
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
const fileNote = (r: ImportResult) => r.fileFindings.find((f) => f.code === FindingCode.MarkAtEndOfOption);

/** Four questions with options A to C and the right one given by `mark`. */
const BANK = (mark: (words: string) => string, right = [1, 2, 0, 1]): string[] =>
  [
    ["Which animal lays eggs?", "Dog", "Hen", "Cat"],
    ["What colour is the sky on a clear day?", "Green", "Red", "Blue"],
    ["Which is a fruit?", "Apple", "Chair", "Stone"],
    ["How many days are in a week?", "Six", "Seven", "Eight"],
  ].flatMap(([stem, ...words], q) => [
    `${q + 1}. ${stem}`,
    ...(words as string[]).map((w, i) => `${"ABC"[i]}. ${i === right[q] ? mark(w as string) : w}`),
    "",
  ]);

describe("(Correct) or a check mark at the end of an option", () => {
  test("is the right answer, and is not part of the words", () => {
    for (const result of both(BANK((w) => `${w} (Correct)`))) {
      assert.equal(result.questions.length, 4);
      assert.deepEqual(rightOf(at(result, 0)), ["Hen"]);
      assert.deepEqual(rightOf(at(result, 1)), ["Blue"]);
      assert.deepEqual(wordsOf(at(result, 2)), ["Apple", "Chair", "Stone"], "the mark is taken out");
      for (const q of result.questions) assert.equal(verdict(q), "parsed");
      assert.match(fileNote(result)?.message ?? "", /^4 options were taken as the right answer because/);
      assert.equal(fileNote(result)?.severity, "info");
    }
  });

  test("in any case and with any spacing, and as a check mark", () => {
    for (const mark of ["(correct)", "( Correct )", "(CORRECT)", "  (Correct)", "✓", "✔", " ✓"]) {
      const q = at(text(["1. Which animal lays eggs?", "A. Dog", `B. Hen ${mark}`, "C. Cat"]), 0);
      assert.deepEqual(rightOf(q), ["Hen"], JSON.stringify(mark));
      assert.deepEqual(wordsOf(q), ["Dog", "Hen", "Cat"], JSON.stringify(mark));
    }
  });

  test("on the last line of an option that runs over two lines", () => {
    const q = at(text(["1. Which animal lays eggs?", "A. Dog", "B. A bird that is kept on a farm", "and gives eggs (Correct)", "C. Cat"]), 0);
    assert.deepEqual(rightOf(q), ["A bird that is kept on a farm and gives eggs"]);
  });

  test("is not a mark when it is the whole of an option, or is not at the end", () => {
    const whole = at(text(["1. Which word means right?", "A. Wrong", "B. (Correct)", "C. Unsure", "Answer: B"]), 0);
    assert.deepEqual(wordsOf(whole), ["Wrong", "(Correct)", "Unsure"]);
    assert.deepEqual(rightOf(whole), ["(Correct)"], "the Answer line gave the key, and the words are kept");
    const middle = at(text(["1. Which is best?", "A. A (Correct) answer is given", "B. Another", "Answer: B"]), 0);
    assert.deepEqual(wordsOf(middle), ["A (Correct) answer is given", "Another"]);
  });

  test("on a line that holds several options is not applied to any of them", () => {
    const q = at(text(["1. What does 'perro' mean?", "A. cat   B. dog (Correct)   C. bird"]), 0);
    assert.deepEqual(wordsOf(q), ["cat", "dog (Correct)", "bird"]);
    assert.deepEqual(rightOf(q), [], "it could be the last option's or the line's, so it is no key");
    assert.equal(verdict(q), "failed");
  });

  test("two options marked are what two stars are: a multiple response, flagged, or an error when the type is single answer", () => {
    const untyped = at(text(["1. Which animals lay eggs?", "A. Dog", "B. Hen (Correct)", "C. Duck (Correct)"]), 0);
    assert.equal(untyped.type, "multipleResponse");
    assert.ok(has(untyped, FindingCode.TypeInferred));
    assert.deepEqual(rightOf(untyped), ["Hen", "Duck"]);
    const stated = at(text(["Type: MC", "1. Which animals lay eggs?", "A. Dog", "B. Hen (Correct)", "C. Duck (Correct)"]), 0);
    assert.ok(has(stated, FindingCode.MultipleKeysOnSingleAnswer));
    assert.equal(verdict(stated), "failed");
  });
});

describe("a star at the end of an option", () => {
  test("is the right answer in a file that marks its answers that way, and is not part of the words", () => {
    for (const result of both(BANK((w) => `${w} *`))) {
      assert.deepEqual(rightOf(at(result, 0)), ["Hen"]);
      assert.deepEqual(wordsOf(at(result, 3)), ["Six", "Seven", "Eight"]);
      assert.equal(verdict(at(result, 3)), "parsed");
      assert.match(fileNote(result)?.message ?? "", /^4 options were taken as the right answer/);
    }
    assert.deepEqual(rightOf(at(text(BANK((w) => `${w}*`)), 1)), ["Blue"], "with no space before it");
  });

  test("is not a mark where fewer than three options end that way", () => {
    const lines = BANK((w) => `${w} *`, [1, 2, -1, -1]);
    const result = text(lines);
    assert.deepEqual(wordsOf(at(result, 0)), ["Dog", "Hen *", "Cat"], "two are not a habit, so the star stays in the words");
    assert.equal(verdict(at(result, 0)), "failed", "and with no key marked, the question is refused");
  });

  test("is not a mark where it is on most of the options, which is decoration", () => {
    const lines = BANK((w) => `${w} *`).map((l) => (/^[ABC]\. /.test(l) && !l.endsWith("*") ? `${l} *` : l));
    const q = at(text(lines), 0);
    assert.deepEqual(wordsOf(q), ["Dog *", "Hen *", "Cat *"]);
  });

  test("exactly half of the options ending in a star is still a mark, and more than half is not", () => {
    // Three questions of two options: three stars is half of six, four is more than half.
    const two = (stars: number[]): string[] =>
      [["Which lays eggs?", "Dog", "Hen"], ["Which is blue?", "Sky", "Grass"], ["Which is a fruit?", "Apple", "Chair"]].flatMap(([stem, a, b], q) => [
        `${q + 1}. ${stem}`, `A. ${a}${stars.includes(q * 2) ? " *" : ""}`, `B. ${b}${stars.includes(q * 2 + 1) ? " *" : ""}`, "",
      ]);
    const half = text(two([1, 2, 5]));
    assert.deepEqual(rightOf(at(half, 0)), ["Hen"], "three of six end in a star");
    assert.deepEqual(wordsOf(at(half, 1)), ["Sky", "Grass"]);
    const more = text(two([1, 2, 3, 5]));
    assert.deepEqual(wordsOf(at(more, 0)), ["Dog", "Hen *"], "four of six do not");
  });

  test("a word set off with stars for emphasis is not a mark at the end, and the Answer line decides", () => {
    // "*Hen*" three times in a bank that gives its answers on a line: an emphasised word, not a star at the end.
    const lines = ["Hen", "Four", "Blue"].flatMap((w, q) => [`${q + 1}. Pick the best word number ${q + 1}.`, "A. Plain", `B. *${w}*`, "C. Other", "Answer: B", ""]);
    const result = text(lines);
    // The older rule for a star after the letter may take the first star; this one must not take the last as well.
    assert.equal(fileNote(result), undefined, "no option was taken as right because of a star at the end of its line");
    for (const q of result.questions) assert.equal(optionsOf(q)[1]?.correct, true, "B is the key, from the Answer line");
    assert.match(wordsOf(at(result, 0))[1] ?? "", /^\*?Hen\*$/, "the star at the end stays in the words");
  });

  test("a star in front of an option is still the key, and is read by its own rule", () => {
    const q = at(text(["1. Which animal lays eggs?", "A. Dog", "*B. Hen", "C. Cat"]), 0);
    assert.deepEqual(rightOf(q), ["Hen"]);
    assert.equal(fileNote(text(["1. Which animal lays eggs?", "A. Dog", "*B. Hen", "C. Cat"])), undefined);
  });
});

describe("Correct: as the line that gives the answer", () => {
  test("is read as Answer: is", () => {
    for (const result of both(["1. Which animal lays eggs?", "A. Dog", "B. Hen", "C. Cat", "Correct: B", "", "2. What is 2 + 2?", "A. Three", "B. Four", "Correct: B."])) {
      assert.deepEqual(rightOf(at(result, 0)), ["Hen"]);
      assert.deepEqual(rightOf(at(result, 1)), ["Four"]);
      assert.equal(result.orphans.length, 0);
    }
  });

  test("gives the answer of a typed answer question, and Correct answer: still works", () => {
    const blank = at(text(["Type: F", "1. The capital of France is ____.", "Correct: Paris"]), 0);
    assert.equal(blank.type, "fillInBlank");
    assert.deepEqual((blank.body as any).blanks[0].accepted, ["Paris"]);
    assert.deepEqual(rightOf(at(text(["1. Which animal lays eggs?", "A. Dog", "B. Hen", "Correct answer: B"]), 0)), ["Hen"]);
  });

  test("is not feedback and is not a sentence that begins with the word", () => {
    // "Correct feedback:" and "Correct answers include ..." are not a Correct: line.
    const feedback = at(text(["1. Which animal lays eggs?", "A. Dog", "B. Hen", "Answer: B", "Correct feedback: Well done."]), 0);
    assert.deepEqual(rightOf(feedback), ["Hen"]);
    assert.equal(has(feedback, FindingCode.KeyTextNotUsed), false, "it is not taken for a second answer");
    assert.equal(verdict(feedback), "parsed");
    const sentence = at(text(["1. Which of these is right?", "A. Correct answers include tests", "B. Wrong", "Answer: A"]), 0);
    assert.deepEqual(wordsOf(sentence), ["Correct answers include tests", "Wrong"]);
  });

  test("at the end of the line of the last option, as ANS: is", () => {
    const q = at(text(["1. What does 'perro' mean?", "A. cat   B. dog   C. bird   Correct: B"]), 0);
    assert.deepEqual(wordsOf(q), ["cat", "dog", "bird"]);
    assert.deepEqual(rightOf(q), ["dog"]);
  });
});
