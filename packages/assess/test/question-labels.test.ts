/**
 * Lines a publisher puts under a question: Feedback, Rationale, Explanation,
 * Solution, "Ans. B", and labels this profile does not know.
 *
 * They used to be added to whatever came just above. Straight under the correct
 * option, "Rationale: ..." became part of that option's text, and the question
 * came out as parsed with its right answer altered. Nothing said so. These tests
 * pin the opposite: a label is never part of an answer.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { standardTextImporter } from "../src/import/standard-text.ts";
import { wordImporter } from "../src/import/word.ts";
import { FindingCode } from "../src/model/findings.ts";
import type { Question } from "../src/model/question.ts";
import { richTextToPlain } from "../src/model/richtext.ts";
import { verdictOf } from "../src/import/types.ts";
import { docxFromLines } from "./support/docx-writer.ts";

const OPTIONS = { file: "t.txt", at: "2026-01-01T00:00:00.000Z", author: "test" };
const parse = (text: string) => standardTextImporter.parse(text, OPTIONS);

const optionTexts = (q: Question | undefined): string[] =>
  q && "options" in q.body ? q.body.options.map((o) => richTextToPlain(o.content)) : [];
const generalFeedback = (q: Question | undefined): string | undefined => (q?.feedback.general ? richTextToPlain(q.feedback.general) : undefined);

const MC = "1. Which is a planet?\na. Sirius\n*b. Mars\nc. The Sun\n";

describe("Feedback", () => {
  test("straight under the options is feedback for the student, and not part of the last option", () => {
    const result = parse(`${MC}Feedback: Mars orbits the Sun.\n`);
    const [q] = result.questions;
    assert.deepEqual(optionTexts(q), ["Sirius", "Mars", "The Sun"]);
    assert.equal(generalFeedback(q), "Mars orbits the Sun.");
    assert.deepEqual(result.counts, { parsed: 1, needsReview: 0, failed: 0, orphans: 0 });
  });

  test("straight under the correct option, where it did the most harm", () => {
    const [q] = parse("1. Which is a planet?\na. Sirius\nb. The Sun\n*c. Mars\nFeedback: Mars orbits the Sun.\n").questions;
    assert.deepEqual(optionTexts(q), ["Sirius", "The Sun", "Mars"]);
  });

  test("after a blank line, where it used to be stray text", () => {
    const result = parse(`${MC}\nFeedback: Mars orbits the Sun.\n`);
    assert.equal(generalFeedback(result.questions[0]), "Mars orbits the Sun.");
    assert.equal(result.orphans.length, 0);
  });

  test("however it is written, and General Feedback too", () => {
    for (const label of ["FEEDBACK", "feedback", "Feedback ", "General Feedback", "general feedback"]) {
      const [q] = parse(`${MC}${label}: Said it.\n`).questions;
      assert.equal(generalFeedback(q), "Said it.", label);
    }
  });

  test("more than one line is joined, in order", () => {
    const [q] = parse(`${MC}Feedback: First.\nFeedback: Second.\n`).questions;
    assert.equal(generalFeedback(q), "First.\nSecond.");
  });

  test("on a question with no options, it is not added to the stem", () => {
    const [q] = parse("Type: E\n1. Explain why.\nFeedback: Look for causes.\n").questions;
    assert.equal(richTextToPlain(q?.stem as never), "Explain why.");
    assert.equal(generalFeedback(q), "Look for causes.");
  });

  test("beside the feedback for a correct or an incorrect answer, it is its own", () => {
    const [q] = parse("1. Which is a planet?\n~ Right.\n@ Wrong.\na. Sirius\n*b. Mars\nFeedback: Said it.\n").questions;
    assert.equal(generalFeedback(q), "Said it.");
    assert.equal(richTextToPlain(q?.feedback.correct as never), "Right.");
    assert.equal(richTextToPlain(q?.feedback.incorrect as never), "Wrong.");
  });

  test("after an option's own feedback, it does not become part of it", () => {
    const [q] = parse("1. Which is a planet?\na. Sirius\n@ Sirius is a star.\n*b. Mars\nFeedback: Said it.\n").questions;
    assert.equal(richTextToPlain((q?.body as { options: Array<{ feedback: never }> }).options[0]?.feedback as never), "Sirius is a star.");
    assert.equal(generalFeedback(q), "Said it.");
  });

  test("after the feedback for a correct answer, it does not become part of it", () => {
    const [q] = parse("1. Which is a planet?\n~ Right.\na. Sirius\n*b. Mars\nFeedback: Said it.\n").questions;
    assert.equal(richTextToPlain(q?.feedback.correct as never), "Right.");
  });

  test("a blank Feedback line, as a template leaves it, is nothing and is not added to anything", () => {
    const result = parse(`${MC}Feedback:\n`);
    assert.deepEqual(optionTexts(result.questions[0]), ["Sirius", "Mars", "The Sun"]);
    assert.equal(generalFeedback(result.questions[0]), undefined);
    assert.equal(result.orphans.length, 0);
    assert.deepEqual(result.counts, { parsed: 1, needsReview: 0, failed: 0, orphans: 0 });
  });
});

describe("Rationale, Explanation and Solution", () => {
  test("are kept as notes, not made feedback, and say so", () => {
    for (const label of ["Rationale", "Explanation", "Solution", "RATIONALE", "explanation"]) {
      const result = parse(`${MC}${label}: Mars is a planet.\n`);
      const [q] = result.questions;
      assert.deepEqual(optionTexts(q), ["Sirius", "Mars", "The Sun"], label);
      assert.equal(Object.values(q?.metadata.custom ?? {}).join(), "Mars is a planet.", label);
      assert.equal(generalFeedback(q), undefined, `${label} is not shown to students`);
      const said = q?.findings.find((f) => f.code === FindingCode.MetadataKeptAsNote);
      assert.equal(said?.severity, "info");
      assert.match(said?.message ?? "", /kept as a note under metadata\.custom\./);
    }
  });

  test("do not keep a question from being parsed, since they are information and not a warning", () => {
    const result = parse(`${MC}Rationale: Mars is a planet.\nExplanation: And the Sun is a star.\n`);
    assert.equal(verdictOf(result.questions[0] as Question), "parsed");
    assert.deepEqual(result.counts, { parsed: 1, needsReview: 0, failed: 0, orphans: 0 });
  });

  test("straight under the correct option they are not part of it", () => {
    const [q] = parse("1. Which is a planet?\na. Sirius\n*b. Mars\nRationale: Mars is a planet.\nc. The Sun\n").questions;
    assert.deepEqual(optionTexts(q), ["Sirius", "Mars", "The Sun"]);
  });

  test("with the feedback beside them", () => {
    const [q] = parse(`${MC}Feedback: Said it.\nRationale: Because.\nDifficulty: Easy\n`).questions;
    assert.equal(generalFeedback(q), "Said it.");
    assert.equal(q?.metadata.custom?.["Rationale"], "Because.");
    assert.equal(q?.metadata.difficulty, "easy");
  });
});

describe("a line with the shape of a label that this profile does not know", () => {
  test("straight under an option is reported as stray text and is not added to the option", () => {
    const result = parse(`${MC}Source: Chapter 7\n`);
    assert.deepEqual(optionTexts(result.questions[0]), ["Sirius", "Mars", "The Sun"]);
    assert.equal(result.orphans.length, 1);
    assert.equal(result.orphans[0]?.text, "Source: Chapter 7");
    assert.match(result.orphans[0]?.reason ?? "", /has the shape of a label that this profile does not know, and follows an option of question 1, so it was not added to it/);
  });

  test("under an option's feedback, or the feedback for the question", () => {
    const one = parse("1. Q?\na. x\n@ Not this one.\nSource: Chapter 7\n*b. y\n");
    assert.equal(one.orphans.length, 1);
    assert.equal(richTextToPlain((one.questions[0]?.body as { options: Array<{ feedback: never }> }).options[0]?.feedback as never), "Not this one.");
    assert.match(one.orphans[0]?.reason ?? "", /follows an option's feedback of question 1/);
    const two = parse("1. Q?\n~ Right.\na. x\n*b. y\n");
    assert.equal(two.orphans.length, 0);
    const three = parse("1. Q?\na. x\n*b. y\n~ Right.\nSource: Chapter 7\n");
    assert.equal(three.orphans.length, 1);
    assert.match(three.orphans[0]?.reason ?? "", /follows the feedback of question 1/);
    assert.equal(richTextToPlain(three.questions[0]?.feedback.correct as never), "Right.");
  });

  test("the lines after it do not slip back into the option", () => {
    const result = parse("1. Q?\na. x\n*b. y\nSource: Chapter 7\nand some more words\n");
    assert.deepEqual(optionTexts(result.questions[0]), ["x", "y"]);
    assert.equal(result.orphans.length, 2);
  });

  test("a wrapped option is still a wrapped option", () => {
    const [q] = parse("1. Q?\na. x\n*b. a long answer that\ncontinues here\nc. z\n").questions;
    assert.equal(optionTexts(q).length, 3);
    assert.match(optionTexts(q)[1] ?? "", /^a long answer that\scontinues here$/, "the second line is part of the option, as it always was");
  });

  test("a colon after more than three words is prose and carries on", () => {
    const [q] = parse("1. Q?\na. x\n*b. the answer\nas described in the third chapter: yes\n").questions;
    assert.match(optionTexts(q)[1] ?? "", /as described in the third chapter: yes/);
  });

  test("in a stem, a line with a colon is still part of the stem", () => {
    const [q] = parse("1. Read this.\nConsider the following: a rock falls.\na. x\n*b. y\n").questions;
    assert.match(richTextToPlain(q?.stem as never), /Consider the following: a rock falls\./);
  });
});

describe("Ans. B", () => {
  test("is the key, as Answer: B is", () => {
    for (const written of ["Ans. B", "Ans: B", "ans. b", "Answer: B"]) {
      const [q] = parse(`1. Which is a planet?\na. Sirius\nb. Mars\nc. The Sun\n${written}\n`).questions;
      const correct = (q?.body as { options: Array<{ correct: boolean }> }).options.map((o) => o.correct);
      assert.deepEqual(correct, [false, true, false], written);
      assert.deepEqual(optionTexts(q), ["Sirius", "Mars", "The Sun"], written);
    }
  });

  test("a sentence that starts with Ans is not a key", () => {
    const [q] = parse("1. Q?\na. x\nb. y\nAnsible is a tool: no\n").questions;
    assert.equal(q?.findings.some((f) => f.code === FindingCode.NoAnswerKey), true);
  });
});

describe("the same lines in a Word file", () => {
  const lines = [
    "1. Which is a planet?",
    "a. Sirius",
    "*b. Mars",
    "c. The Sun",
    "Feedback: Mars orbits the Sun.",
    "Rationale: It is a planet.",
    "Source: Chapter 7",
    "",
    "2. Is it true?",
    "a. True",
    "b. False",
    "Ans. B",
    "Explanation: Because.",
  ];

  test("read the same as the text, in every form of writing them", () => {
    const text = parse(lines.join("\n"));
    for (const make of [
      () => docxFromLines(lines),
      () => docxFromLines(lines, { noise: true, seed: 5 }),
      () => docxFromLines(lines, { numbering: { mode: "lists" } }),
      () => docxFromLines(lines, { numbering: { mode: "multilevel" }, noise: true, seed: 9 }),
    ]) {
      const word = wordImporter.parseBytes(make(), OPTIONS);
      assert.deepEqual(word.questions.map((q) => [q.type, optionTexts(q), generalFeedback(q), q.metadata.custom]), text.questions.map((q) => [q.type, optionTexts(q), generalFeedback(q), q.metadata.custom]));
      assert.deepEqual(word.orphans.map((o) => o.text), text.orphans.map((o) => o.text));
      assert.deepEqual(word.counts, text.counts);
    }
    assert.deepEqual(text.counts, { parsed: 2, needsReview: 0, failed: 0, orphans: 1 });
  });
});
