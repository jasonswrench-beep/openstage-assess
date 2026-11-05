/**
 * A matching question that the importer padded with placeholder pairs keeps its error when it is edited.
 *
 * A matching question needs two pairs. When a file gave one, the importer filled the second with "(missing)" on both sides so the
 * question could be stored and repaired, and said with an error that it was not complete. The error was about a missing answer, which
 * an edit works out again from the body, and the body looked complete: "(missing)" is a word. So the first edit of any kind cleared
 * the error, and a question with a pair of placeholders became usable, exported and printed as if it were an answer.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { standardTextImporter } from "../src/import/standard-text.ts";
import { verdictOf } from "../src/import/types.ts";
import { createQuestion, editQuestion, withRecomputedFindings } from "../src/model/create.ts";
import { FindingCode } from "../src/model/findings.ts";
import type { MatchingBody, Question } from "../src/model/question.ts";
import { plainToRich, rich } from "../src/model/richtext.ts";
import { checkAnswerKey, hasUsableKey } from "../src/quality/answer-key.ts";
import { isPlaceholderText } from "../src/quality/placeholders.ts";

const matching = (pairs: Array<[string, string]>): Question =>
  createQuestion({
    type: "matching",
    stem: plainToRich("Match each country to its capital."),
    body: { shuffle: true, distractors: [], pairs: pairs.map(([left, right], i) => ({ id: `p${i}`, left: plainToRich(left), right })) } as never,
  });

const errors = (q: Question) => checkAnswerKey(q).map((f) => [f.field, f.message]);

describe("a placeholder pair is a pair with nothing in it", () => {
  test("is an error on each side that says (missing), and on an empty side", () => {
    assert.deepEqual(errors(matching([["(missing)", "(missing)"], ["France", "Paris"]])), [
      ["body.pairs.0.right", "This pair has no right-hand match."],
      ["body.pairs.0.left", "This pair has nothing on its left."],
    ]);
    assert.deepEqual(errors(matching([["France", "(missing)"], ["Spain", "Madrid"]])), [["body.pairs.0.right", "This pair has no right-hand match."]]);
    assert.deepEqual(errors(matching([["(missing)", "Paris"], ["Spain", "Madrid"]])), [["body.pairs.0.left", "This pair has nothing on its left."]]);
    assert.deepEqual(errors(matching([["", "Paris"], ["Spain", "Madrid"]])), [["body.pairs.0.left", "This pair has nothing on its left."]]);
    assert.deepEqual(errors(matching([["France", "  "], ["Spain", "Madrid"]])), [["body.pairs.0.right", "This pair has no right-hand match."]]);
  });

  test("two complete pairs are fine, and so is a left side that is a picture", () => {
    assert.deepEqual(errors(matching([["France", "Paris"], ["Spain", "Madrid"]])), []);
    const picture = createQuestion({
      type: "matching",
      stem: plainToRich("Match."),
      body: { shuffle: true, distractors: [], pairs: [{ id: "p0", left: rich('<oa-media ref="m1"></oa-media>'), right: "Paris" }, { id: "p1", left: plainToRich("Spain"), right: "Madrid" }] } as never,
      media: [{ id: "m1", file: "media/m1.png", mime: "image/png", alt: "A flag" }],
    });
    assert.deepEqual(errors(picture), []);
  });

  test("a word that merely contains missing is a word", () => {
    assert.deepEqual(errors(matching([["The missing link", "Fossil"], ["Spain", "(missing) is not it"]])), []);
  });

  test("a question with a placeholder pair has no usable key", () => {
    assert.equal(hasUsableKey(matching([["(missing)", "(missing)"], ["France", "Paris"]])), false);
    assert.equal(hasUsableKey(matching([["France", "Paris"], ["Spain", "Madrid"]])), true);
  });

  test("the words that say nothing are the placeholder, nothing, or a space, and not a picture", () => {
    assert.equal(isPlaceholderText(plainToRich("(missing)")), true);
    assert.equal(isPlaceholderText(plainToRich("   ")), true);
    assert.equal(isPlaceholderText(undefined), true);
    assert.equal(isPlaceholderText(plainToRich("Paris")), false);
    assert.equal(isPlaceholderText(rich('<oa-math ref="e1"></oa-math>')), false);
  });
});

describe("an imported matching question with one pair", () => {
  const imported = (): Question => {
    const result = standardTextImporter.parse("Type: MT\n1) Match the countries to their capitals.\na. France = Paris\n", { file: "t.txt" });
    assert.equal(result.questions.length, 1);
    return result.questions[0] as Question;
  };

  test("is padded and fails, as it always was", () => {
    const q = imported();
    const pairs = (q.body as MatchingBody).pairs;
    assert.equal(pairs.length, 2);
    assert.equal(pairs[1]?.right, "(missing)");
    assert.equal(verdictOf(q), "failed");
    assert.ok(q.findings.some((f) => f.code === FindingCode.NoAnswerKey && f.severity === "error"));
  });

  test("stays failed when it is edited in another way, because the error is worked out again", () => {
    const q = imported();
    const edited = editQuestion(q, { title: "Capitals of Europe" }, { by: "test" });
    assert.equal(verdictOf(edited), "failed", "the title changed, the pair is still empty");
    assert.equal(hasUsableKey(edited), false);
    const again = withRecomputedFindings(editQuestion(q, { points: 3 }, { by: "test" }));
    assert.ok(again.findings.some((f) => f.code === FindingCode.NoAnswerKey && f.severity === "error" && f.field?.startsWith("body.pairs.1")));
  });

  test("is fixed when words are written into the pair, and not before", () => {
    const q = imported();
    const body = q.body as MatchingBody;
    const half = editQuestion(q, { body: { ...body, pairs: [body.pairs[0], { ...body.pairs[1], right: "Madrid" }] } as never }, { by: "test" });
    assert.equal(verdictOf(half), "failed", "the right side is written and the left is not");
    assert.deepEqual(checkAnswerKey(half).map((f) => f.field), ["body.pairs.1.left"]);
    const whole = editQuestion(half, { body: { ...half.body, pairs: [body.pairs[0], { ...body.pairs[1], left: plainToRich("Spain"), right: "Madrid" }] } as never }, { by: "test" });
    assert.deepEqual(checkAnswerKey(whole), []);
    assert.equal(hasUsableKey(whole), true);
    assert.equal(verdictOf(whole), "parsed");
  });
});
