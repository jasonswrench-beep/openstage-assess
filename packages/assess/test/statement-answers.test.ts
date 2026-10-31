/**
 * A true or false statement that ends with its own answer, "The Sun is a star. (T)", in a file that has no type line or
 * section to say they are true or false questions. A set of generated banks wrote them this way, and each came out an essay
 * with the answer in its stem. The suffix is read as the answer where the file does it as a habit, three one-line statements
 * at least, because "(F)" may be the last word of a stem that means Fahrenheit; and where the statement stands alone, with
 * nothing under it, because a stem that goes on to a second line or to options is not one. These tests use invented text.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { standardTextImporter } from "../src/import/standard-text.ts";
import { relabelUnlabelledGroups } from "../src/import/standard-text-relabel.ts";
import { type ImportResult, type SourceBlock } from "../src/import/types.ts";
import { wordImporter } from "../src/import/word.ts";
import { FindingCode, verdictFrom } from "../src/model/findings.ts";
import type { Question } from "../src/model/question.ts";
import { richTextToPlain } from "../src/model/richtext.ts";
import { docx, paragraph, run } from "./support/docx-writer.ts";

const OPTIONS = { file: "t.txt", at: "2026-01-01T00:00:00.000Z", author: "test" };
const text = (lines: string[]): ImportResult => standardTextImporter.parse(lines.join("\n"), OPTIONS);
const inWord = (lines: string[]): ImportResult =>
  wordImporter.parseBytes(docx({ body: lines.map((l) => (l === "" ? paragraph("") : l.startsWith("**") ? paragraph(run(l.slice(2), "<w:b/>")) : paragraph(run(l)))).join("") }), {
    ...OPTIONS,
    file: "t.docx",
  });
const both = (lines: string[]): ImportResult[] => [text(lines), inWord(lines)];

const plain = (rich: Parameters<typeof richTextToPlain>[0]): string => richTextToPlain(rich).replace(/\s+/g, " ").trim();
const has = (q: Question, code: string): boolean => q.findings.some((f) => f.code === code);
const verdict = (q: Question): string => verdictFrom(q.findings);
const at = (r: ImportResult, n: number): Question => r.questions[n] as Question;
const correct = (q: Question): unknown => (q.body as Record<string, unknown>)["correct"];

const STATEMENTS = [
  "1. The Sun is a star. (T)", "",
  "2. A light-year is a measure of time. (F)", "",
  "3. Water boils at a lower temperature on a mountain. (True)", "",
  "4. The Moon is larger than the Earth. (False)", "",
];

describe("a statement that ends with its answer", () => {
  test("in a bank that numbers nothing, a title and instructions leave a first run that is no statement, and then no group", () => {
    const statement = (n: number): string[] => [`Statement number ${n} is true. (T)`, ""];
    const blocks = (first: string[]): SourceBlock[] => [...first, "", ...statement(1), ...statement(2), ...statement(3)].map((t, i) => ({ index: i, text: t }));
    assert.equal(relabelUnlabelledGroups(blocks(["Science Quiz", "Instructions: Read each one.", "The Sun is a star."])), undefined, "the line left over is not an answered statement");
    assert.equal(relabelUnlabelledGroups(blocks(["Science Quiz", "Instructions: Read each one.", "The Sun is a star. (T)"]))?.groups, 4);
  });

  test("is a true or false question in a file that does it three times or more, and the answer is its key", () => {
    for (const result of both(STATEMENTS)) {
      assert.equal(result.questions.length, 4);
      assert.deepEqual(result.questions.map((q) => q.type), ["trueFalse", "trueFalse", "trueFalse", "trueFalse"]);
      assert.deepEqual(result.questions.map(correct), [true, false, true, false]);
      assert.deepEqual(result.questions.map((q) => plain(q.stem)), [
        "The Sun is a star.", "A light-year is a measure of time.", "Water boils at a lower temperature on a mountain.", "The Moon is larger than the Earth.",
      ]);
      for (const q of result.questions) {
        assert.equal(verdict(q), "parsed");
        assert.ok(has(q, FindingCode.TypeFromEvidence));
      }
      assert.equal(result.orphans.length, 0);
    }
  });

  test("not in a file that does it twice: the suffix is part of the words", () => {
    const result = text(STATEMENTS.slice(0, 4));
    assert.equal(result.questions.length, 2);
    for (const q of result.questions) assert.equal(q.type, "essay");
    assert.match(plain(at(result, 0).stem), /\(T\)$/);
  });

  test("not when a second line follows it, since the stem goes on", () => {
    const lines = [...STATEMENTS];
    lines.splice(1, 0, "It is the closest one to us.");
    const result = text(lines);
    assert.equal(at(result, 0).type, "essay");
    assert.equal(at(result, 1).type, "trueFalse");
  });

  test("statements that go on to a second line are not counted toward the habit", () => {
    const two = STATEMENTS.slice(0, 4);
    const goingOn = (n: number): string[] => [`${n}. A statement that goes on, number ${n}. (T)`, "and here is the rest of it.", ""];
    const result = text([...two, ...goingOn(3), ...goingOn(4), ...goingOn(5)]);
    assert.equal(at(result, 0).type, "essay", "two that stand alone are not three");
    assert.equal(at(result, 1).type, "essay");
  });

  test("lines that are not numbered questions are not counted toward the habit", () => {
    const stray = ["Some notes follow.", "The first note ends with a mark. (T)", "", "The second note ends with a mark. (F)", "", "The third note ends with a mark. (T)", ""];
    const result = text([...STATEMENTS.slice(0, 4), ...stray]);
    assert.equal(at(result, 0).type, "essay", "two numbered statements are not three, whatever else is in the file");
  });

  test("not when options follow it, since the suffix is then part of a stem", () => {
    const lines = ["0. Which unit is used for temperature in the United States (F)", "A. Fahrenheit", "*B. Celsius", "", ...STATEMENTS];
    const result = text(lines.map((l) => l.replace(/^0\./, "5.")));
    const q = result.questions.find((x) => /unit is used/.test(plain(x.stem))) as Question;
    assert.equal(q.type, "multipleChoice");
    assert.match(plain(q.stem), /\(F\)$/);
  });

  test("not when a type line says what it is: Type: E is an essay", () => {
    const lines = ["Type: E", "5. Describe the weather on a mountain. (F)", "", ...STATEMENTS];
    const result = text(lines);
    const essay = result.questions.find((x) => /Describe the weather/.test(plain(x.stem))) as Question;
    assert.equal(essay.type, "essay");
    assert.match(plain(essay.stem), /\(F\)$/);
  });

  test("a stem of another kind in the same file keeps its words, the suffix and all", () => {
    const lines = [...STATEMENTS, "5. Convert one hundred degrees Celsius to degrees (F)", "Answer: 212"];
    const result = text(lines);
    const q = result.questions.find((x) => /Convert one hundred/.test(plain(x.stem))) as Question;
    assert.notEqual(q.type, "trueFalse");
  });

  test("when the statements have no numbers at all, they are read as the questions of a bank that numbers nothing", () => {
    const options = (n: number): string[] => [`Which of these is number ${n} in order?`, "First thing", "**Second thing", "Third thing", ""];
    const lines = [
      ...options(1), "The Sun is a star. (T)", "", ...options(2), "A light-year is a measure of time. (F)", "", ...options(3),
      "Water boils at a lower temperature on a mountain. (True)", "", ...options(4),
    ];
    const result = inWord(lines);
    assert.equal(result.questions.length, 7);
    assert.deepEqual(result.questions.filter((q) => q.type === "trueFalse").map(correct), [true, false, true]);
  });
});
