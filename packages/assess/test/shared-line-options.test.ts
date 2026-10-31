/**
 * Several options in one paragraph, and the question that looks complete when they are not told apart. A generated
 * bank wrote `A. mother   B. aunt` and, under it, `C. sister   D. grandmother   ANS: C`, with every option in lower
 * case. The scanner will not take "B. aunt" for an option, because "C. difficile" in the middle of a sentence is not
 * one, so the question came out with two options, `mother B. aunt` and `sister D. grandmother`, the second marked
 * right, and nothing flagged. Two things changed. A gap of two spaces or a tab before the letter is enough to say a
 * new option begins, whatever follows it. And options lettered A and C, with no B, are a warning whatever caused
 * them. These tests use invented text.
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
const at = (result: ImportResult, n: number): Question => result.questions[n] as Question;

describe("options that share a paragraph, with a gap between them", () => {
  const SISTER = ["1. What does 'hermana' mean?", "A. mother   B. aunt", "C. sister   D. grandmother   ANS: C"];

  test("lower case options are split where two spaces come before the next letter", () => {
    for (const result of both(SISTER)) {
      const q = at(result, 0);
      assert.deepEqual(wordsOf(q), ["mother", "aunt", "sister", "grandmother"]);
      assert.deepEqual(rightOf(q), ["sister"]);
      assert.equal(verdict(q), "parsed");
      assert.equal(has(q, FindingCode.OptionLetterGap), false);
      assert.ok(result.fileFindings.some((f) => f.code === FindingCode.OptionsSplitFromLine), "and the file says lines were split");
    }
  });

  test("a tab is a gap, and so are more than two spaces", () => {
    for (const gap of ["\t", "    ", "\t\t"]) {
      const q = at(text(["1. What does 'perro' mean?", `A. cat${gap}B. dog${gap}C. bird${gap}ANS: B`]), 0);
      assert.deepEqual(wordsOf(q), ["cat", "dog", "bird"], JSON.stringify(gap));
      assert.deepEqual(rightOf(q), ["dog"]);
    }
    // In Word the tab is a tab element and not a character in the text.
    const q = at(inWord(["1. What does 'perro' mean?", "A. cat\tB. dog\tC. bird\tANS: B"]), 0);
    assert.deepEqual(wordsOf(q), ["cat", "dog", "bird"]);
  });

  test("the first option at the end of the question's words is split the same way", () => {
    const q = at(text(["1. What colour is grass?   A. red   B. green   C. blue   ANS: B"]), 0);
    assert.equal(plain(q.stem), "What colour is grass?");
    assert.deepEqual(wordsOf(q), ["red", "green", "blue"]);
    assert.deepEqual(rightOf(q), ["green"]);
  });

  test("a single space before a lower case word is still not a new option, so C. difficile stays in its option", () => {
    const q = at(text(["1. Which is a bacterium?", "A. a virus", "B. found with C. difficile", "C. a fungus", "D. a prion", "Answer: B"]), 0);
    assert.deepEqual(wordsOf(q), ["a virus", "found with C. difficile", "a fungus", "a prion"]);
    assert.deepEqual(rightOf(q), ["found with C. difficile"]);
    assert.equal(has(q, FindingCode.OptionLetterGap), false);
  });

  test("a gap does not split a letter that is out of order, and a stem is not made options of by one letter", () => {
    // B is expected after A, so a gap before a C does nothing. And one letter with no B after it is not a first option.
    const q = at(text(["1. Which is a bacterium?", "A. a virus   C. a fungus", "B. found here", "Answer: B"]), 0);
    assert.ok(wordsOf(q).includes("a virus   C. a fungus") || wordsOf(q).includes("a virus C. a fungus"));
    const stem = at(text(["1. The dose is given to infants with  A. rash that spreads."]), 0);
    assert.equal(stem.type, "essay");
    assert.match(plain(stem.stem), /A\. rash that spreads/);
  });
});

describe("options lettered with a letter missing", () => {
  test("a question whose options run together on a single space is flagged, which is how it was wrong and fine before", () => {
    // One space and lower case: the options are not told apart, so B is missing, and the question says so.
    for (const result of both(["1. What does 'hermana' mean?", "A. mother B. aunt", "C. sister D. grandmother ANS: C"])) {
      const q = at(result, 0);
      assert.deepEqual(wordsOf(q), ["mother B. aunt", "sister D. grandmother"], "not split: the words say it could be a sentence");
      assert.ok(has(q, FindingCode.OptionLetterGap));
      assert.equal(verdict(q), "needsReview", "and it is no longer parsed");
      const note = q.findings.find((f) => f.code === FindingCode.OptionLetterGap);
      assert.equal(note?.severity, "warn");
      assert.match(note?.message ?? "", /lettered A, C, which does not run on from A in order, so B is missing/);
    }
  });

  test("each way letters can be out of order says so", () => {
    const gap = (letters: string[]): Question =>
      at(text(["1. Which is right?", ...letters.map((l) => `${l}. option ${l}`), "Answer: A"]), 0);
    const message = (q: Question): string => q.findings.find((f) => f.code === FindingCode.OptionLetterGap)?.message ?? "";
    assert.match(message(gap(["A", "C"])), /lettered A, C, .* so B is missing/);
    assert.match(message(gap(["A", "B", "D"])), /lettered A, B, D, .* so C is missing/);
    assert.match(message(gap(["A", "D"])), /so B, C are missing/);
    assert.match(message(gap(["B", "C", "D"])), /lettered B, C, D, .*the first is not A/);
    assert.match(message(gap(["A", "C", "B"])), /does not run on from A in order\./);
  });

  test("letters that run on from A in order are not a gap, however many there are", () => {
    for (const letters of [["A", "B"], ["A", "B", "C"], ["A", "B", "C", "D", "E"], ["A", "B", "C", "D", "E", "F", "G"]]) {
      const q = at(text(["1. Which is right?", ...letters.map((l) => `${l}. option ${l}`), "Answer: A"]), 0);
      assert.equal(has(q, FindingCode.OptionLetterGap), false, letters.join(""));
    }
  });

  test("a repeated letter is the repeated letter's warning and not this one", () => {
    const q = at(text(["1. Which is right?", "A. one", "A. two", "C. three", "Answer: C"]), 0);
    assert.ok(has(q, FindingCode.DuplicateOptionLetter));
    assert.equal(has(q, FindingCode.OptionLetterGap), false);
  });

  test("a true or false question, and a bank with no letters at all, have no gap", () => {
    assert.equal(has(at(text(["1. Ice floats.", "a. True", "b. False", "Answer: a"]), 0), FindingCode.OptionLetterGap), false);
    const typed = text(["MC", "Which animal lays eggs?", "Dog", "*Hen", "Cat", "", "MC", "Which is blue?", "*Sky", "Grass", "", "MC", "How many days in a week?", "5", "*7", "9"]);
    assert.equal(typed.questions.length, 3);
    for (const q of typed.questions) assert.equal(has(q, FindingCode.OptionLetterGap), false);
  });

  test("one option is too few options and is said so in its own words, not as a gap", () => {
    const q = at(text(["1. Which is right?", "B. only one", "Answer: B"]), 0);
    assert.ok(has(q, FindingCode.TooFewOptions));
    assert.equal(has(q, FindingCode.OptionLetterGap), false);
  });

  test("a question with more options than there are letters is not held to the alphabet", () => {
    const options = Array.from({ length: 27 }, (_, i) => `${i === 3 ? "*" : ""}option ${i + 1}`);
    const q = at(text(["MC", "Which is right?", ...options, "", "MC", "Which is second?", "x", "*y", "", "MC", "Which is third?", "*p", "q"]), 0);
    assert.equal(wordsOf(q).length, 27);
    assert.equal(has(q, FindingCode.OptionLetterGap), false);
  });

  test("only the choice types are held to it: a stated essay and a matching question with letters are not", () => {
    const essay = at(text(["Type: E", "1. Explain how a lever works.", "A. effort", "C. load"]), 0);
    assert.equal(essay.type, "essay");
    assert.equal(has(essay, FindingCode.OptionLetterGap), false);
    const matching = at(text(["Type: MT", "1. Match each tool to its use.", "A. hammer = nails", "C. saw = wood"]), 0);
    assert.equal(matching.type, "matching");
    assert.equal(has(matching, FindingCode.OptionLetterGap), false);
    // Without the type line, two lettered options are a choice question, and the gap is said.
    assert.ok(has(at(text(["1. Explain how a lever works.", "A. effort", "C. load"]), 0), FindingCode.OptionLetterGap));
  });
});
