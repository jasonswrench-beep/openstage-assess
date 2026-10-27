/**
 * Tests for the accuracy harness itself.
 *
 * The harness is the instrument every later decision about the parser is made
 * with, so a wrong reading here is worse than a parser bug: it hides parser
 * bugs. These tests pin the two properties that make the 95 percent number
 * mean something, both of which were once untrue while the suite was green.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { scoreFile, summarise, type ExpectedFile } from "../src/harness/score.ts";
import { countVerdicts, type ImportResult } from "../src/import/types.ts";
import { createQuestion } from "../src/model/create.ts";
import type { Finding } from "../src/model/findings.ts";
import type { Question } from "../src/model/question.ts";

function choice(stem: string, options: string[], correctIndex: number, findings: Finding[] = []): Question {
  const question = createQuestion({
    type: "multipleChoice",
    stem: { format: "plain", content: stem },
    body: {
      shuffle: false,
      options: options.map((content, i) => ({
        id: `o${i + 1}`,
        content: { format: "plain", content },
        correct: i === correctIndex,
      })),
    },
  });
  return findings.length > 0 ? { ...question, findings: [...question.findings, ...findings] } : question;
}

function resultOf(questions: Question[], orphans: ImportResult["orphans"] = []): ImportResult {
  return {
    profile: "test",
    file: "test.txt",
    questions,
    orphans,
    counts: countVerdicts(questions, orphans.length),
    fileFindings: [],
  };
}

const expectedOne: ExpectedFile = {
  file: "test.txt",
  orphans: 0,
  questions: [
    { type: "multipleChoice", stem: "Capital of France?", options: ["Paris", "Rome"], correct: [0] },
  ],
};

describe("the accuracy gate counts only questions a person could actually use", () => {
  it("scores a clean question as correct", () => {
    const score = scoreFile(expectedOne, resultOf([choice("Capital of France?", ["Paris", "Rome"], 0)]));
    assert.equal(score.correct, 1);
    assert.equal(score.score, 1);
  });

  it("does not score a question whose fields match but which carries an error", () => {
    // Field agreement alone used to score this 100 percent, so a parser could
    // report that it had passed while every item it produced was unusable.
    const broken = choice("Capital of France?", ["Paris", "Rome"], 0, [
      { code: "import.no-answer-key", severity: "error", message: "No correct answer was marked." },
    ]);
    const score = scoreFile(expectedOne, resultOf([broken]));

    assert.equal(score.verdicts.failed, 1);
    assert.equal(score.correct, 0, "a failed question is not a correct question");
    assert.equal(score.score, 0);
    assert.ok(score.mismatches.some((m) => m.field === "verdict"));
  });

  it("scores a deliberately broken fixture as correct when it declares the verdict it expects", () => {
    // This is how the broken-key corpus passes: the fixture asserts that the
    // parser flags the item, so flagging it is the pass.
    const expected: ExpectedFile = {
      ...expectedOne,
      questions: [{ ...expectedOne.questions[0]!, verdict: "failed" }],
    };
    const broken = choice("Capital of France?", ["Paris", "Rome"], 0, [
      { code: "import.no-answer-key", severity: "error", message: "No correct answer was marked." },
    ]);

    const score = scoreFile(expected, resultOf([broken]));
    assert.equal(score.correct, 1);
    assert.equal(score.score, 1);
  });

  it("fails a question that should have been flagged and was not", () => {
    const expected: ExpectedFile = {
      ...expectedOne,
      questions: [{ ...expectedOne.questions[0]!, verdict: "failed" }],
    };
    const score = scoreFile(expected, resultOf([choice("Capital of France?", ["Paris", "Rome"], 0)]));
    assert.equal(score.correct, 0, "a guessed key that looks clean is the worst outcome, not the best");
  });
});

describe("the gate counts text the parser lost or invented", () => {
  it("drops the score when orphan text does not match", () => {
    // A parser that swallows a chapter heading into a stem has failed even
    // when every question it produced is right.
    const expected: ExpectedFile = { ...expectedOne, orphans: 2 };
    const score = scoreFile(expected, resultOf([choice("Capital of France?", ["Paris", "Rome"], 0)]));

    assert.equal(score.correct, 1);
    assert.ok(score.score < 1, "an orphan mismatch has to move the number, not just be noted");
    assert.ok(score.mismatches.some((m) => m.field === "orphans"));
  });

  it("dilutes the score when the parser invents a question", () => {
    const score = scoreFile(
      expectedOne,
      resultOf([
        choice("Capital of France?", ["Paris", "Rome"], 0),
        choice("Invented by the parser", ["Yes", "No"], 0),
      ]),
    );
    assert.equal(score.correct, 1);
    assert.equal(score.score, 0.5);
  });

  it("scores a question the parser never found as zero", () => {
    const score = scoreFile(expectedOne, resultOf([]));
    assert.equal(score.correct, 0);
    assert.equal(score.score, 0);
  });
});

describe("the summary", () => {
  it("totals across files on the same denominator the files used", () => {
    const good = scoreFile(expectedOne, resultOf([choice("Capital of France?", ["Paris", "Rome"], 0)]));
    const bad = scoreFile(expectedOne, resultOf([]));
    const summary = summarise([good, bad]);

    assert.equal(summary.correctTotal, 1);
    assert.equal(summary.denominatorTotal, 2);
    assert.equal(summary.score, 0.5);
  });

  it("scores an empty run as zero rather than as success", () => {
    assert.equal(summarise([]).score, 0);
  });
});
