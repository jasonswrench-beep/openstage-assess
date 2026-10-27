/**
 * The rule the whole product rests on: a missing or ambiguous answer key is
 * flagged, never guessed.
 *
 * Every case here was once wrong, and wrong in the worst possible way: the
 * question came out of the importer looking clean, with a verdict of "parsed"
 * and no findings, while carrying an answer nobody wrote. A guessed key that
 * looks authored is more dangerous than a parse failure, because a parse
 * failure gets looked at.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { standardTextImporter } from "../src/import/standard-text.ts";
import { verdictOf } from "../src/import/types.ts";
import { createQuestion } from "../src/model/create.ts";
import { plainToRich } from "../src/model/richtext.ts";
import { checkAnswerKey, hasUsableKey } from "../src/quality/answer-key.ts";
import { FindingCode } from "../src/model/findings.ts";
import type { QuestionType } from "../src/model/question.ts";

function importOne(text: string) {
  const result = standardTextImporter.parse(text, { file: "t.txt" });
  assert.equal(result.questions.length, 1, "fixture should produce exactly one question");
  return result.questions[0]!;
}

describe("true or false keys are read, not assumed", () => {
  it("reads T in an answer list as True", () => {
    // "t" is also a valid option letter, so this used to fall through to the
    // letter branch, miss, and come out as False with no finding.
    const q = importOne("1) The sky is blue.\na. True\nb. False\n\nAnswers:\n1. T\n");
    assert.equal(q.type, "trueFalse");
    assert.equal((q.body as { correct?: boolean }).correct, true);
    assert.equal(verdictOf(q), "parsed");
  });

  it("reads F in an answer list as False", () => {
    const q = importOne("1) The sky is green.\na. True\nb. False\n\nAnswers:\n1. F\n");
    assert.equal((q.body as { correct?: boolean }).correct, false);
  });

  it("does not assume the first option is True", () => {
    // A bank that lists False first would otherwise have every answer
    // inverted, and nothing would show it.
    const q = importOne("Type: TF\n1) The sky is blue.\n*a. False\nb. True\n");
    assert.equal((q.body as { correct?: boolean }).correct, false);
  });

  it("leaves the key unset when the file gives none, rather than storing False", () => {
    const q = importOne("Type: TF\n1) The sky is blue.\na. True\nb. False\n");
    assert.equal((q.body as { correct?: boolean }).correct, undefined);
    assert.equal(verdictOf(q), "failed");
    assert.equal(hasUsableKey(q), false, "an unkeyed question must not pass the exporter gate");
  });
});

describe("the answer key check covers every type that has a key", () => {
  const unkeyed: Array<{ type: QuestionType; body: unknown }> = [
    { type: "trueFalse", body: {} },
    {
      type: "multipleChoice",
      body: {
        shuffle: false,
        options: [
          { id: "o1", content: plainToRich("One"), correct: false },
          { id: "o2", content: plainToRich("Two"), correct: false },
        ],
      },
    },
    {
      type: "matching",
      body: { pairs: [{ id: "p1", left: plainToRich("Left"), right: "  " }], distractors: [], shuffle: true },
    },
    {
      type: "ordering",
      body: {
        items: [
          { id: "i1", content: plainToRich("First"), position: 1 },
          { id: "i2", content: plainToRich("Second"), position: 1 },
        ],
      },
    },
    { type: "numeric", body: { mode: "exact" } },
    { type: "numeric", body: { mode: "range", min: 10, max: 2 } },
    { type: "calculated", body: { formula: "   ", variables: [], tolerance: 0, toleranceIsPercent: false } },
    {
      type: "hotspot",
      body: {
        mediaRef: "m_1",
        regions: [{ id: "r1", shape: "rect", coords: [0, 0, 1, 1], correct: false }],
        alternative: plainToRich("Which one?"),
      },
    },
    { type: "shortAnswer", body: { caseSensitive: false, accepted: [" "] } },
    { type: "fillInBlank", body: { caseSensitive: false, blanks: [{ id: "b1", accepted: [" "] }] } },
  ];

  for (const { type, body } of unkeyed) {
    it(`refuses to call an unkeyed ${type} question usable`, () => {
      const q = createQuestion({ type, stem: plainToRich("Stem"), body: body as never });
      const findings = checkAnswerKey(q);
      assert.ok(
        findings.some((f) => f.severity === "error"),
        `${type} produced no error finding, so nothing stops it reaching a learner`,
      );
      assert.equal(hasUsableKey(q), false);
    });
  }

  it("treats essay as keyed, because a person grades it", () => {
    const q = createQuestion({ type: "essay", stem: plainToRich("Discuss."), body: {} });
    assert.deepEqual(checkAnswerKey(q), []);
    assert.equal(hasUsableKey(q), true);
  });

  it("accepts a properly keyed question of each shape", () => {
    const ordering = createQuestion({
      type: "ordering",
      stem: plainToRich("Put these in order."),
      body: {
        items: [
          { id: "i1", content: plainToRich("First"), position: 1 },
          { id: "i2", content: plainToRich("Second"), position: 2 },
        ],
      },
    });
    assert.equal(hasUsableKey(ordering), true);

    const numeric = createQuestion({
      type: "numeric",
      stem: plainToRich("How many?"),
      body: { mode: "range", min: 2, max: 10 },
    });
    assert.equal(hasUsableKey(numeric), true);
  });
});

describe("the exporter gate respects what the importer recorded", () => {
  it("keeps refusing a question whose stored finding says the key was broken", () => {
    // The body can look fine while the source file was ambiguous. That
    // knowledge lives in the findings, and re-deriving from the body alone
    // would quietly clear it.
    const q = createQuestion({
      type: "multipleChoice",
      stem: plainToRich("Capital of France?"),
      body: {
        shuffle: false,
        options: [
          { id: "o1", content: plainToRich("Paris"), correct: true },
          { id: "o2", content: plainToRich("Rome"), correct: false },
        ],
      },
    });
    const flagged = {
      ...q,
      findings: [
        ...q.findings,
        {
          code: FindingCode.NoAnswerKey,
          severity: "error" as const,
          message: "The answer list gave two keys for question 1.",
        },
      ],
    };
    assert.deepEqual(checkAnswerKey(flagged), [], "the body itself is fine");
    assert.equal(hasUsableKey(flagged), false, "but the recorded problem still counts");
  });
});
