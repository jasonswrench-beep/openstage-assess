/**
 * Two more types a file gives away by its answer, found by a set of generated banks that named no type: a question whose
 * answer line or key names two options, "ANS: B, D", and a stem with a blank in it whose answer is words. The first was an
 * error on a single-answer question for a key that two letters make plain; the second was an essay with no key. Neither
 * reading guesses a key: the options marked are the file's own letters and the accepted answer is the file's own words. The
 * first is flagged, because two letters may be a slip as well as a multiple response; the second is not, as the answer is
 * what a typed-in blank has. What stays unread is as tested as what is read: a letter answer to a stem with a blank is the key
 * of a choice question whose options were lost, and is never made a fill in the blank. These tests use invented text.
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

const body = (q: Question): Record<string, any> => q.body as Record<string, any>;
const plain = (rich: Parameters<typeof richTextToPlain>[0]): string => richTextToPlain(rich).replace(/\s+/g, " ").trim();
const has = (q: Question, code: string): boolean => q.findings.some((f) => f.code === code);
const verdict = (q: Question): string => verdictFrom(q.findings);
const at = (result: ImportResult, n: number): Question => result.questions[n] as Question;
const right = (q: Question): string[] =>
  (body(q)["options"] as Array<{ content: Parameters<typeof plain>[0]; correct?: boolean }>).filter((o) => o.correct).map((o) => plain(o.content));
const blanks = (q: Question): string[] => (body(q)["blanks"] as Array<{ accepted: string[] }>)[0]?.accepted ?? [];

const FRUIT = ["1. Which of these are fruit?", "A. Chair", "B. Apple", "C. Desk", "D. Pear"];

describe("two letters on the answer line or in the key, with no type named", () => {
  test("are a multiple response with both options marked, and flagged, not an error", () => {
    for (const form of ["B, D", "B and D", "B & D", "B/D", "B,D", "b, d", "B; D", "B D"]) {
      for (const result of both([...FRUIT, `Answer: ${form}`])) {
        const q = at(result, 0);
        assert.equal(q.type, "multipleResponse", form);
        assert.deepEqual(right(q), ["Apple", "Pear"], form);
        assert.equal(verdict(q), "needsReview", `${form}: two letters may be a slip, so it is checked`);
        assert.ok(has(q, FindingCode.TypeInferred), form);
        assert.ok(!has(q, FindingCode.MultipleKeysOnSingleAnswer), form);
        assert.match(q.findings.find((f) => f.code === FindingCode.TypeInferred)?.message ?? "", /2 options/, form);
      }
    }
  });

  test("the same when the letters are in a key at the end", () => {
    for (const lines of [
      [...FRUIT, "", "Answers:", "1. B, D"],
      [...FRUIT, "", "Answer Key", "1. B, D   2. A"],
    ]) {
      const q = at(text(lines), 0);
      assert.equal(q.type, "multipleResponse");
      assert.deepEqual(right(q), ["Apple", "Pear"]);
    }
  });

  test("one letter is a single-answer question, as before", () => {
    const q = at(text([...FRUIT, "Answer: B"]), 0);
    assert.equal(q.type, "multipleChoice");
    assert.deepEqual(right(q), ["Apple"]);
    assert.equal(verdict(q), "parsed");
  });

  test("a type the file states is not overruled: MC with two letters stays an error, MA with two is read", () => {
    const mc = at(text(["Type: MC", ...FRUIT, "Answer: B, D"]), 0);
    assert.equal(mc.type, "multipleChoice");
    assert.ok(has(mc, FindingCode.MultipleKeysOnSingleAnswer));
    assert.equal(verdict(mc), "failed");
    const ma = at(text(["Type: MA", ...FRUIT, "Answer: B, D"]), 0);
    assert.equal(ma.type, "multipleResponse");
    assert.equal(verdict(ma), "parsed");
    assert.ok(!has(ma, FindingCode.TypeInferred));
  });

  test("a letter that is no option is not one of two: the question stays a single-answer one, and says what it did not use", () => {
    const q = at(text([...FRUIT, "Answer: B, Z"]), 0);
    assert.equal(q.type, "multipleChoice");
    assert.ok(has(q, FindingCode.KeyTextNotUsed));
    assert.equal(verdict(q), "needsReview");
    assert.ok(!has(q, FindingCode.TypeInferred), "it is not read as a multiple response");
  });

  test("letters run together are not split: the key is not applied and the question is refused", () => {
    const q = at(text([...FRUIT, "Answer: BD"]), 0);
    assert.equal(verdict(q), "failed");
    assert.deepEqual(right(q), []);
  });

  test("a star on one option and two letters on the answer line: the star is used, and the disagreement is said", () => {
    const q = at(text(["1. Which of these are fruit?", "A. Chair", "*B. Apple", "C. Desk", "D. Pear", "Answer: B, D"]), 0);
    assert.equal(q.type, "multipleChoice");
    assert.deepEqual(right(q), ["Apple"]);
    assert.ok(has(q, FindingCode.KeysDisagree));
  });

  test("two options that are True and False are not a multiple response", () => {
    const q = at(text(["1. Ice floats on water.", "A. True", "B. False", "Answer: A"]), 0);
    assert.equal(q.type, "trueFalse");
  });
});

describe("a stem with a blank and an answer in words, with no type named", () => {
  test("is a fill in the blank with the answer accepted", () => {
    for (const result of both(["1. The capital of France is ____.", "Answer: Paris"])) {
      const q = at(result, 0);
      assert.equal(q.type, "fillInBlank");
      assert.deepEqual(blanks(q), ["Paris"]);
      assert.equal(verdict(q), "parsed");
      assert.ok(has(q, FindingCode.TypeFromEvidence));
      assert.ok(!has(q, FindingCode.TypeInferred));
      assert.equal(result.orphans.length, 0);
    }
  });

  test("with the answer in a key at the end", () => {
    const q = at(text(["1. The capital of France is ____.", "", "Answers:", "1. Paris"]), 0);
    assert.equal(q.type, "fillInBlank");
    assert.deepEqual(blanks(q), ["Paris"]);
  });

  test("a word made of letters is a word: Paris, Cage and Bad are not option letters", () => {
    for (const word of ["Paris", "Cage", "Bad", "Eat", "Is"]) {
      const q = at(text(["1. The word is ____.", `Answer: ${word}`]), 0);
      assert.equal(q.type, "fillInBlank", word);
      assert.deepEqual(blanks(q), [word], word);
    }
  });

  test("a letter that can be no option, since options go no further than T, is a value: x and z", () => {
    for (const value of ["x", "Z"]) {
      const q = at(text(["1. The unknown in the equation is ____.", `Answer: ${value}`]), 0);
      assert.equal(q.type, "fillInBlank", value);
      assert.deepEqual(blanks(q), [value], value);
    }
  });

  test("an answer line of words and a key that gives a letter disagree about what this is, so it is not read as a fill in the blank", () => {
    const q = at(text(["1. The capital of France is ____.", "Answer: Paris", "", "Answers:", "1. B"]), 0);
    assert.equal(q.type, "essay");
    assert.ok(has(q, FindingCode.TypeInferred));
    assert.equal(verdict(q), "needsReview");
  });

  test("an answer that is a letter or letters is the key of a choice question, so it is not a fill in the blank", () => {
    for (const letters of ["B", "b", "B, D", "A and C", "B D", "a"]) {
      for (const result of both(["1. Pick the right word: ____", `Answer: ${letters}`])) {
        const q = at(result, 0);
        assert.equal(q.type, "essay", letters);
        assert.ok(has(q, FindingCode.TypeInferred), `${letters}: flagged, as before`);
        assert.equal(verdict(q), "needsReview", letters);
        assert.ok(!has(q, FindingCode.TypeFromEvidence), letters);
      }
    }
  });

  test("two blanks and one answer is a fill in the blank that is flagged for the count", () => {
    const q = at(text(["1. The ____ and the ____ are planets.", "Answer: Mars, Venus"]), 0);
    assert.equal(q.type, "fillInBlank");
    assert.ok(has(q, FindingCode.BlankCountMismatch));
    assert.equal(verdict(q), "needsReview");
  });

  test("no answer is still an essay, flagged, and a type the file states is not overruled", () => {
    const none = at(text(["1. The capital of France is ____."]), 0);
    assert.equal(none.type, "essay");
    assert.equal(verdict(none), "needsReview");
    const stated = at(text(["Type: E", "1. The capital of France is ____.", "Answer: Paris"]), 0);
    assert.equal(stated.type, "essay");
    assert.ok(!has(stated, FindingCode.TypeFromEvidence));
  });

  test("a stem with options and a blank is a choice question, whatever its answer says", () => {
    const q = at(text(["1. The capital of France is ____.", "A. Paris", "B. Rome", "Answer: A"]), 0);
    assert.equal(q.type, "multipleChoice");
    assert.deepEqual(right(q), ["Paris"]);
  });
});
