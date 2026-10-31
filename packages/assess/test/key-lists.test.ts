/**
 * A key at the end of a bank, under a heading such as "Answer Key": the entries on a line or several to a line, with a plain
 * number or a chapter and number ("4.1"), or in a table of two columns. A set of generated banks had these, and the
 * importer read the key as questions: each row of a key table became an essay whose stem was a letter, and each
 * line of a key list became a question made of the entries, all of them counted against the file. A heading that is followed by questions
 * is the copy of the test with its answers, and is not a key; that and the other places where a key must not be read are
 * tested as hard as the places where it must. These tests use invented text.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { standardTextImporter } from "../src/import/standard-text.ts";
import { type ImportResult } from "../src/import/types.ts";
import { wordImporter } from "../src/import/word.ts";
import { FindingCode, verdictFrom } from "../src/model/findings.ts";
import type { Question } from "../src/model/question.ts";
import { richTextToPlain } from "../src/model/richtext.ts";
import { docx, paragraph, run, table } from "./support/docx-writer.ts";

const OPTIONS = { file: "t.txt", at: "2026-01-01T00:00:00.000Z", author: "test" };
const text = (lines: string[]): ImportResult => standardTextImporter.parse(lines.join("\n"), OPTIONS);
const para = (l: string): string => paragraph(l === "" ? "" : run(l));
const inWord = (lines: string[], extra = ""): ImportResult =>
  wordImporter.parseBytes(docx({ body: lines.map(para).join("") + extra }), { ...OPTIONS, file: "t.docx" });
const cells = (rows: string[][]): string => table(rows.map((r) => r.map((c) => para(c))));

const plain = (rich: Parameters<typeof richTextToPlain>[0]): string => richTextToPlain(rich).replace(/\s+/g, " ").trim();
const optionsOf = (q: Question): Array<{ words: string; correct: boolean }> =>
  ((q.body as Record<string, any>)["options"] as Array<{ content: Parameters<typeof plain>[0]; correct?: boolean }>).map((o) => ({
    words: plain(o.content),
    correct: o.correct === true,
  }));
const rightOf = (q: Question): string[] => optionsOf(q).filter((o) => o.correct).map((o) => o.words);
const has = (q: Question, code: string): boolean => q.findings.some((f) => f.code === code);
const verdict = (q: Question): string => verdictFrom(q.findings);
const at = (r: ImportResult, n: number): Question => r.questions[n] as Question;
const stems = (r: ImportResult): string[] => r.questions.map((q) => plain(q.stem));

/** Five questions with options A to C and no answer given beside them, numbered by `number`. */
const QUESTIONS = (number: (n: number) => string): string[] =>
  Array.from({ length: 5 }, (_, i) => [`${number(i + 1)} Question number ${i + 1}?`, "A. First", "B. Second", "C. Third", ""]).flat();

describe("a key written as a list under its heading", () => {
  test("with several entries to a line", () => {
    for (const result of [text, inWord].map((read) => read([...QUESTIONS((n) => `${n}.`), "Answer Key", "1. B   2. C   3. A", "4. B   5. C"]))) {
      assert.equal(result.questions.length, 5, "the key is not read as questions");
      assert.deepEqual(result.questions.map((q) => rightOf(q)[0]), ["Second", "Third", "First", "Second", "Third"]);
      for (const q of result.questions) assert.equal(verdict(q), "parsed");
      assert.equal(result.orphans.length, 0);
    }
  });

  test("with one entry to a line, and with the heading spelled other ways", () => {
    for (const heading of ["Answer Key", "Answer Key:", "ANSWER KEY", "Chapter 3 Answer Key"]) {
      const result = text([...QUESTIONS((n) => `${n}.`), heading, "1. B", "2. C", "3. A", "4. B", "5. C"]);
      assert.equal(result.questions.length, 5, heading);
      assert.deepEqual(result.questions.map((q) => rightOf(q)[0]), ["Second", "Third", "First", "Second", "Third"], heading);
    }
  });

  test("with the entries separated by commas or semicolons, with several letters for a multiple response, and True and False", () => {
    const lines = [
      "Type: MA", "1. Which are fruit?", "A. Apple", "B. Pear", "C. Chair", "", "2. Ice floats.", "A. True", "B. False", "",
      "Answer Key", "1. A, B;  2. A",
    ];
    const result = text(lines);
    assert.equal(result.questions.length, 2);
    assert.deepEqual(rightOf(at(result, 0)), ["Apple", "Pear"]);
    assert.equal(at(result, 0).type, "multipleResponse");
    assert.equal(at(result, 1).type, "trueFalse");
    assert.equal((at(result, 1).body as any).correct, true, "A is True, and a true or false question keeps only its answer");
  });

  test("a question the key leaves out has no key, and is refused, not guessed", () => {
    const result = text([...QUESTIONS((n) => `${n}.`), "Answer Key", "1. B   2. C", "4. B   5. C"]);
    assert.equal(result.questions.length, 5);
    assert.equal(verdict(at(result, 2)), "failed");
    assert.ok(has(at(result, 2), FindingCode.NoAnswerKey));
    assert.deepEqual(rightOf(at(result, 3)), ["Second"]);
  });

  test("two letters for a single-answer question are an error, as ever", () => {
    const result = text(["Type: MC", ...QUESTIONS((n) => `${n}.`), "Answer Key", "1. B, C   2. C   3. A   4. B   5. C"]);
    assert.ok(has(at(result, 0), FindingCode.MultipleKeysOnSingleAnswer));
    assert.equal(verdict(at(result, 0)), "failed");
  });

  test("questions numbered 4.1 and a key that numbers them 4.1", () => {
    const result = text([...QUESTIONS((n) => `4.${n}`), "Answer Key", "4.1. B   4.2. C   4.3. A", "4.4. B   4.5. C"]);
    assert.equal(result.questions.length, 5);
    assert.deepEqual(result.questions.map((q) => rightOf(q)[0]), ["Second", "Third", "First", "Second", "Third"]);
  });

  test("a heading with questions under it is the copy with the answers, and is not a key", () => {
    const lines = [
      "1. Which is first?", "A. One", "B. Two", "", "2. Which is second?", "A. Three", "B. Four", "",
      "Answer Key", "1. Which is first?", "A. One", "*B. Two", "", "2. Which is second?", "A. Three", "*B. Four",
    ];
    const result = text(lines);
    assert.equal(result.questions.length, 2, "the two copies are folded into two questions");
    assert.ok(result.fileFindings.some((f) => f.code === FindingCode.RepeatedQuestionsFolded || f.code === FindingCode.AnswerKeyPart));
  });

  test("a heading with prose under it, or entries that carry other words, is not a key", () => {
    const prose = text([...QUESTIONS((n) => `${n}.`), "Answer Key", "The answers are given to your teacher.", "1. B"]);
    assert.equal(rightOf(at(prose, 0)).length, 0);
    const words = text([...QUESTIONS((n) => `${n}.`), "Answer Key", "1. B and see page 4   2. C"]);
    assert.equal(rightOf(at(words, 0)).length, 0, "an entry with other words after it is not read");
  });

  test("a colon after the number, and True and False written out", () => {
    const colon = text([...QUESTIONS((n) => `${n}.`), "Answer Key", "1: B   2: C   3: A", "4: B   5: C"]);
    assert.equal(colon.questions.length, 5);
    assert.deepEqual(colon.questions.map((q) => rightOf(q)[0]), ["Second", "Third", "First", "Second", "Third"]);
    const tf = text(["1. Ice floats.", "A. True", "B. False", "", "2. Fire is cold.", "A. True", "B. False", "", "Answer Key", "1. True   2. False"]);
    assert.equal(tf.questions.length, 2, "the key is not read as questions");
    assert.equal((at(tf, 0).body as any).correct, true);
    assert.equal((at(tf, 1).body as any).correct, false);
  });

  test("an entry run into the next one is not an entry", () => {
    const result = text([...QUESTIONS((n) => `${n}.`), "Answer Key", "1. B2. C   3. A"]);
    assert.equal(rightOf(at(result, 0)).length, 0, "'B2' is not question 1 answered B and question 2 answered C");
    assert.equal(verdict(at(result, 0)), "failed");
  });

  test("a question with a dash, n/a or none in the key has no key, wherever it is in the list, and its own answer stands", () => {
    // The question at `p` is a fill in the blank with its answer given beside it; the others are choices the key answers.
    for (const none of ["-", "–", "—", "n/a", "N/A", "none"]) {
      for (const p of [0, 1, 2]) {
        const parts = [0, 1, 2].flatMap((i) =>
          i === p ? [`Type: F`, `4.${i + 1} The capital of France is ____.`, "Answer: Paris", ""] : [`4.${i + 1} Which is number ${i + 1}?`, "A. One", "B. Two", ""],
        );
        const key = [0, 1, 2].map((i) => `4.${i + 1}. ${i === p ? none : "B"}`);
        const where = `${JSON.stringify(none)} at ${p}`;
        const listed = text([...parts, "Answer Key", ...key]);
        assert.equal(listed.questions.length, 3, where);
        assert.deepEqual((at(listed, p).body as any).blanks[0].accepted, ["Paris"], `the dash is not an accepted answer, ${where}`);
        for (const q of listed.questions) assert.equal(verdict(q), "parsed", where);
        // The same with plain numbers.
        const plain = text([...parts.map((l) => l.replace(/^4\.(\d)/, "$1.")), "Answer Key", ...key.map((l) => l.replace(/^4\./, ""))]);
        assert.equal(plain.questions.length, 3, `plain, ${where}`);
        assert.deepEqual((at(plain, p).body as any).blanks[0].accepted, ["Paris"], `plain, ${where}`);
      }
    }
  });

  test("a choice question the key gives a dash has no key, and is refused, not guessed", () => {
    const cases: Array<[string[], number]> = [
      [["1. —", "2. B", "3. A"], 0],
      [["1. B", "2. —", "3. A"], 1],
      [["1. B", "2. A", "3. —"], 2],
      [["1. B   2. —   3. A"], 1],
    ];
    for (const [lines, dashed] of cases) {
      const result = text([...QUESTIONS((n) => `${n}.`).slice(0, 15), "Answer Key", ...lines]);
      const where = lines.join(" / ");
      assert.equal(result.questions.length, 3, where);
      assert.equal(verdict(at(result, dashed)), "failed", where);
      assert.ok(has(at(result, dashed), FindingCode.NoAnswerKey), where);
      assert.equal(rightOf(at(result, dashed)).length, 0, `no option is made right, ${where}`);
      for (const other of [0, 1, 2].filter((n) => n !== dashed)) assert.equal(verdict(at(result, other)), "parsed", where);
    }
  });

  test("one entry under the heading, and then something that is not an entry, is not a key", () => {
    const result = text([...QUESTIONS((n) => `${n}.`).slice(0, 15), "Answer Key", "1. B", "Please see your teacher for the rest."]);
    assert.equal(rightOf(at(result, 0)).length, 0, "one lone line that looks like an entry does not make a key");
  });

  test("a number the list gives twice with different letters is two keys for one question, which is an error and not a pick", () => {
    const result = text(["Type: MC", ...QUESTIONS((n) => `${n}.`).slice(0, 10), "Answer Key", "1. B   2. A", "1. A"]);
    assert.ok(has(at(result, 0), FindingCode.MultipleKeysOnSingleAnswer));
    assert.equal(verdict(at(result, 0)), "failed");
    assert.equal(verdict(at(result, 1)), "parsed");
  });

  test("the first question of the next chapter, numbered 5.1, is not an entry of this chapter's key", () => {
    const four = [1, 2].flatMap((n) => [`4.${n} Which is number ${n} of chapter four?`, "A. One", "B. Two", ""]);
    const five = [1, 2].flatMap((n) => [`5.${n} Which is number ${n} of chapter five?`, "A. One", "B. Two", ""]);
    const result = text([...four, "Answer Key", "4.1. B   4.2. A", "", ...five, "Answer Key", "5.1. A   5.2. B"]);
    assert.equal(result.questions.length, 4);
    assert.deepEqual(result.questions.map((q) => rightOf(q)[0]), ["Two", "One", "One", "Two"]);
    assert.deepEqual(stems(result).slice(2), ["Which is number 1 of chapter five?", "Which is number 2 of chapter five?"]);
  });

  test("a key for fill in the blank questions numbered 4.1, with words for the answers, one to a line", () => {
    const questions = ["Type: F", "4.1 The capital of France is ____.", "", "Type: F", "4.2 The lightest gas is ____.", "", "Type: F", "4.3 A word for frozen water is ____.", ""];
    for (const heading of ["Answer Key", "Answers:"]) {
      const result = text([...questions, heading, "4.1. Paris", "4.2. Hydrogen", "4.3. Ice"]);
      assert.equal(result.questions.length, 3, `${heading}: the key is not read as questions`);
      assert.deepEqual(result.questions.map((q) => (q.body as any).blanks[0].accepted), [["Paris"], ["Hydrogen"], ["Ice"]], heading);
      for (const q of result.questions) assert.equal(verdict(q), "parsed", heading);
    }
  });

  test("a dotted number with words is not an entry of a key when no question above has that number", () => {
    const questions = [1, 2, 3].flatMap((n) => ["Type: F", `4.${n} Blank number ${n} is ____.`, `Answer: word${n}`, ""]);
    const result = text([...questions, "Answer Key", "9.9. Paris"]);
    assert.equal(result.questions.length, 3, "the three questions stand");
    assert.deepEqual(result.questions.map((q) => (q.body as any).blanks[0].accepted), [["word1"], ["word2"], ["word3"]], "and none of them takes the line");
    assert.ok(!result.fileFindings.some((f) => f.code === FindingCode.KeyLetterMissing), "the line was never read as an entry");
    assert.ok(JSON.stringify(result.orphans).includes("9.9. Paris"), "the line is kept as an orphan, not dropped");
    assert.ok(!result.fileFindings.some((f) => f.code === FindingCode.UnparsedBlock), "the heading was not read as a key with nothing in it");
  });

  test("an entry for a question the file does not have is said, and applied to nothing", () => {
    const result = text([...QUESTIONS((n) => `${n}.`), "Answer Key", "1. B   2. C   3. A   4. B   5. C   9. A"]);
    assert.equal(result.questions.length, 5);
    assert.ok(result.fileFindings.some((f) => f.code === FindingCode.KeyLetterMissing && /question 9/.test(f.message)));
  });
});

describe("a key written as a table", () => {
  const key = (rows: string[][]): string => cells([["Question", "Answer"], ...rows]);

  test("with the chapter in the number, which a plain table reader refused", () => {
    const result = inWord([...QUESTIONS((n) => `4.${n}`), "Answer Key"], key([["4.1", "B"], ["4.2", "C"], ["4.3", "A"], ["4.4", "B"], ["4.5", "C"]]));
    assert.equal(result.questions.length, 5, "the rows are not questions");
    assert.deepEqual(result.questions.map((q) => rightOf(q)[0]), ["Second", "Third", "First", "Second", "Third"]);
    for (const q of result.questions) assert.equal(verdict(q), "parsed");
  });

  test("with plain numbers, as before", () => {
    const result = inWord([...QUESTIONS((n) => `${n}.`), "Answer Key"], key([["1", "B"], ["2", "C"], ["3", "A"], ["4", "B"], ["5", "C"]]));
    assert.equal(result.questions.length, 5);
    assert.deepEqual(result.questions.map((q) => rightOf(q)[0]), ["Second", "Third", "First", "Second", "Third"]);
  });

  test("a dash for a question with no key in the table is no answer, and does not become one", () => {
    const lines = [
      "4.1 Which is first?", "A. One", "B. Two", "", "Type: F", "4.2 The capital of France is ____.", "Answer: Paris", "", "4.3 Which is third?", "A. One", "B. Two", "", "4.4 Which is fourth?", "A. One", "B. Two", "",
      "Answer Key",
    ];
    const result = inWord(lines, key([["4.1", "B"], ["4.2", "—"], ["4.3", "A"], ["4.4", "B"]]));
    assert.equal(result.questions.length, 4);
    const blank = at(result, 1);
    assert.equal(blank.type, "fillInBlank");
    assert.deepEqual((blank.body as any).blanks[0].accepted, ["Paris"], "the dash is not an accepted answer");
    assert.equal(verdict(blank), "parsed");
  });

  test("the rows are not left as text under the heading: it and the table leave no orphan and no change to the last option", () => {
    const result = inWord([...QUESTIONS((n) => `${n}.`), "Answer Key"], key([["1", "B"], ["2", "C"], ["3", "A"], ["4", "B"], ["5", "C"]]));
    assert.equal(result.orphans.length, 0);
    assert.ok(!result.fileFindings.some((f) => f.code === FindingCode.AnswerKeyPart), "the heading is not said to be the heading of a copy of the questions");
    assert.deepEqual(optionsOf(at(result, 4)).map((o) => o.words), ["First", "Second", "Third"]);
    assert.deepEqual(stems(result), Array.from({ length: 5 }, (_, i) => `Question number ${i + 1}?`));
  });

  test("the same number in two chapters is two questions, each with its own entry", () => {
    const chapter = (n: number): string[] =>
      [1, 2, 3].flatMap((i) => [`${n}.${i} Which is number ${i} of chapter ${n}?`, "A. One", "B. Two", ""]);
    const result = inWord([...chapter(4), ...chapter(5), "Answer Key"], key([["4.1", "B"], ["4.2", "A"], ["4.3", "B"], ["5.1", "A"], ["5.2", "B"], ["5.3", "A"]]));
    assert.equal(result.questions.length, 6);
    assert.deepEqual(result.questions.map((q) => rightOf(q)[0]), ["Two", "One", "Two", "One", "Two", "One"]);
    for (const q of result.questions) assert.equal(verdict(q), "parsed");
  });
});

describe("what the stems of the questions are, with a key under them", () => {
  test("none of them is changed by it", () => {
    const result = text([...QUESTIONS((n) => `${n}.`), "Answer Key", "1. B   2. C   3. A   4. B   5. C"]);
    assert.deepEqual(stems(result), Array.from({ length: 5 }, (_, i) => `Question number ${i + 1}?`));
  });
});
