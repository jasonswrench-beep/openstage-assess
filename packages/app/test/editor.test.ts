/**
 * The conversion between the editing screen's question and the engine's. The rules under test are the ones that protect a
 * person's work: text they did not change is kept exactly, a picture is never rewritten away, a key is never filled in, and
 * a screen that sends rubbish is refused with words. The text is invented.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { checkAnswerKey, collectRefs, createQuestion, editQuestion, plainToRich, richTextToPlain, validateQuestion, type Question, type QuestionBody, type QuestionType, rich } from "../src/engine.ts";
import { blankInput, EDITABLE_TYPES, editFromInput, missingText, parseInput, questionFromInput, toEditor, type EditorInput } from "../src/editor.ts";
import { HttpError } from "../src/errors.ts";

const AT = "2026-01-01T00:00:00.000Z";

function make(type: QuestionType, body: QuestionBody, stem = "What is the capital of France?"): Question {
  return createQuestion({ type, stem, body, by: "test", at: AT });
}

const opt = (id: string, text: string, correct = false, feedback?: string) => ({
  id,
  content: plainToRich(text),
  correct,
  ...(feedback ? { feedback: plainToRich(feedback) } : {}),
});

const SAMPLES: Array<[QuestionType, QuestionBody]> = [
  ["multipleChoice", { shuffle: true, options: [opt("o1", "Berlin"), opt("o2", "Paris", true, "Paris is the capital."), opt("o3", "Rome")] }],
  ["multipleResponse", { shuffle: false, partialCredit: true, options: [opt("o1", "Red", true), opt("o2", "Green"), opt("o3", "Blue", true)] }],
  ["trueFalse", { correct: false }],
  ["fillInBlank", { caseSensitive: true, blanks: [{ id: "b1", label: "capital", accepted: ["Paris", "paris"] }] }],
  ["shortAnswer", { caseSensitive: false, accepted: ["Paris"] }],
  ["matching", { shuffle: true, distractors: ["Oslo"], pairs: [{ id: "p1", left: plainToRich("France"), right: "Paris" }, { id: "p2", left: plainToRich("Italy"), right: "Rome" }] }],
  ["ordering", { items: [{ id: "i1", content: plainToRich("First"), position: 1 }, { id: "i2", content: plainToRich("Second"), position: 2 }] }],
  ["numeric", { mode: "tolerance", value: 9.8, tolerance: 0.1, units: "m/s2" }],
  ["essay", { modelAnswer: plainToRich("A good answer names the river.") }],
];

const inputFrom = (q: Question): EditorInput => {
  const parsed = parseInput(JSON.parse(JSON.stringify(toEditor(q))));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.errors.join(" "));
  return (parsed as { ok: true; input: EditorInput }).input;
};

describe("the editor and the engine's question", () => {
  for (const [type, body] of SAMPLES) {
    test(`a ${type} question goes to the screen and back with nothing changed`, () => {
      const q = make(type, body);
      const { edit, flattened } = editFromInput(q, inputFrom(q));
      assert.deepEqual(edit.body, q.body, "the body is the one that was stored, ids and all");
      assert.deepEqual(edit.stem, q.stem);
      assert.deepEqual(edit.feedback, q.feedback);
      assert.deepEqual(flattened, []);
      assert.equal(edit.points, q.points);
      const next = editQuestion(q, edit, { by: "test" });
      assert.ok(validateQuestion(next).ok);
    });
  }

  test("every type the screen edits is one it can start blank", () => {
    for (const type of EDITABLE_TYPES) {
      const parsed = parseInput(JSON.parse(JSON.stringify(blankInput(type))));
      assert.ok(parsed.ok, `${type}: ${parsed.ok ? "" : parsed.errors.join(" ")}`);
    }
  });
});

describe("text that was not changed", () => {
  const formatted = createQuestion({
    type: "multipleChoice",
    stem: rich("<p>Which is <strong>not</strong> a primary colour?</p>"),
    body: { shuffle: true, options: [{ id: "o1", content: rich("<p><em>Green</em></p>"), correct: true }, opt("o2", "Red"), opt("o3", "Blue")] },
    by: "test",
    at: AT,
  });

  test("keeps its formatting when only something else is edited", () => {
    const input = { ...inputFrom(formatted), points: 3 };
    const { edit, flattened } = editFromInput(formatted, input);
    assert.deepEqual(edit.stem, formatted.stem);
    assert.deepEqual((edit.body as { options: Array<{ content: unknown }> }).options[0]?.content, (formatted.body as { options: Array<{ content: unknown }> }).options[0]?.content);
    assert.deepEqual(flattened, []);
    assert.equal(edit.points, 3);
  });

  test("says which fields have formatting, so the screen can warn before they are changed", () => {
    assert.deepEqual(toEditor(formatted).formatted.sort(), ["options.0", "stem"]);
  });

  test("is flattened to plain text when the person changes it, and they are told which", () => {
    const input = inputFrom(formatted);
    input.stem = "Which is NOT a primary colour?";
    const { edit, flattened } = editFromInput(formatted, input);
    assert.equal(richTextToPlain(edit.stem as never), "Which is NOT a primary colour?");
    assert.deepEqual(flattened, ["the question text"]);
  });
});

describe("a picture in the text", () => {
  const withPicture = createQuestion({
    type: "essay",
    stem: rich('<p>Describe this <oa-media ref="m1"></oa-media> chart.</p>'),
    body: {},
    media: [{ id: "m1", file: "media/m1.png", mime: "image/png", alt: "A chart" }],
    by: "test",
    at: AT,
  });

  test("is shown as a token where it stands, and does not lock the text it is in", () => {
    assert.deepEqual(toEditor(withPicture).locked, []);
    assert.equal(toEditor(withPicture).stem, "Describe this [picture 1] chart.");
  });

  test("keeps the question as it is when its text is left alone", () => {
    const { edit } = editFromInput(withPicture, { ...inputFrom(withPicture), points: 2 });
    assert.deepEqual(edit.stem, withPicture.stem);
  });

  test("is kept in place when the words around the token are changed, and moves with the token", () => {
    const input = inputFrom(withPicture);
    input.stem = "Describe this graph [picture 1].";
    const { edit } = editFromInput(withPicture, input);
    assert.equal(richTextToPlain(edit.stem as never), "Describe this graph .");
    assert.deepEqual(collectRefs(edit.stem as never).media, ["m1"]);
    assert.match((edit.stem as { content: string }).content, /graph <oa-media ref="m1"><\/oa-media>\./);
  });

  test("is let go from the text, and kept as the question's, when its token is taken out", () => {
    const input = inputFrom(withPicture);
    input.stem = "Describe this graph.";
    const { edit } = editFromInput(withPicture, input);
    assert.deepEqual(collectRefs(edit.stem as never).media, []);
    assert.equal(edit.media, undefined, "the picture itself is not in the edit, so it stays the question's");
  });

  test("is refused by number when the token names one the question does not have", () => {
    const input = inputFrom(withPicture);
    input.stem = "Describe this [picture 2] graph.";
    assert.throws(() => editFromInput(withPicture, input), (error: unknown) => error instanceof HttpError && error.status === 400 && /\[picture 2\], and this question has one picture/.test(error.message));
  });

  test("a description or decoration is an edit of the picture, and nothing else about the question changes", () => {
    const input = { ...inputFrom(withPicture), pictures: [{ id: "m1", alt: " A bar chart of sales ", decorative: false }] };
    const { edit } = editFromInput(withPicture, input);
    assert.deepEqual(edit.media, [{ id: "m1", file: "media/m1.png", mime: "image/png", alt: "A bar chart of sales" }]);
    assert.deepEqual(edit.stem, withPicture.stem);
    const decorated = editFromInput(withPicture, { ...inputFrom(withPicture), pictures: [{ id: "m1", alt: "ignored", decorative: true }] });
    assert.deepEqual(decorated.edit.media, [{ id: "m1", file: "media/m1.png", mime: "image/png", alt: "", decorative: true }]);
    assert.equal(editFromInput(withPicture, { ...inputFrom(withPicture), pictures: [{ id: "m1", alt: "A chart", decorative: false }] }).edit.media, undefined, "the same description is no edit");
  });

  test("a picture that dangles is not a token: the text is locked, as an equation's is", () => {
    const dangling = createQuestion({ type: "essay", stem: rich('<p>See <oa-media ref="gone"></oa-media>.</p>'), body: {}, by: "test", at: AT });
    assert.deepEqual(toEditor(dangling).locked, ["stem"]);
  });
});

describe("an equation in the text", () => {
  const withEquation = createQuestion({
    type: "essay",
    stem: rich('<p>Solve <oa-math ref="e1"></oa-math> now.</p>'),
    body: {},
    math: [{ id: "e1", latex: "x^2", mathml: "<math/>" }],
    by: "test",
    at: AT,
  });

  test("is listed as locked, and the text is kept as it is when left alone", () => {
    assert.deepEqual(toEditor(withEquation).locked, ["stem"]);
    const { edit } = editFromInput(withEquation, { ...inputFrom(withEquation), points: 2 });
    assert.deepEqual(edit.stem, withEquation.stem);
  });

  test("refuses to rewrite the text as plain text, since the equation would be lost without a word", () => {
    const input = inputFrom(withEquation);
    assert.equal(input.stem, "Solve now.");
    input.stem = "Solve it now.";
    assert.throws(() => editFromInput(withEquation, input), (error: unknown) => error instanceof HttpError && error.status === 400 && /holds an equation/.test(error.message));
  });
});

describe("a key is never filled in", () => {
  test("a true or false question with no answer stays without one, through the screen and back", () => {
    const q = make("trueFalse", {});
    const input = inputFrom(q);
    assert.equal(input.body.correct, null);
    const { edit } = editFromInput(q, input);
    assert.deepEqual(edit.body, {});
    assert.equal(checkAnswerKey(editQuestion(q, edit)).length, 1);
  });

  test("changing a multiple choice question to true or false carries no answer over", () => {
    const q = make("multipleChoice", SAMPLES[0]![1]);
    const input = inputFrom(q);
    input.type = "trueFalse";
    input.body = { correct: null };
    const { edit } = editFromInput(q, input);
    assert.equal(edit.type, "trueFalse");
    assert.deepEqual(edit.body, {});
  });

  test("a new option row is not marked right", () => {
    const blank = blankInput("multipleChoice");
    assert.ok((blank.body.options ?? []).every((o) => !o.correct));
  });

  test("a multiple choice question with nothing marked is stored, and the engine's own check says so", () => {
    const input = blankInput("multipleChoice");
    input.stem = "Which one?";
    input.body.options = [{ text: "One", correct: false, feedback: "" }, { text: "Two", correct: false, feedback: "" }];
    const q = questionFromInput(input, "test", AT);
    assert.ok(validateQuestion(q).ok);
    assert.ok(checkAnswerKey(q).some((f) => f.severity === "error"));
  });
});

describe("ids of rows", () => {
  test("a row the person adds does not take the id of a row that is kept", () => {
    const q = make("multipleChoice", { shuffle: true, options: [opt("o1", "A", true), opt("o3", "C")] });
    const input = inputFrom(q);
    input.body.options = [...(input.body.options ?? []), { text: "New", correct: false, feedback: "" }, { text: "Newer", correct: false, feedback: "" }];
    const { edit } = editFromInput(q, input);
    const ids = (edit.body as { options: Array<{ id: string }> }).options.map((o) => o.id);
    assert.equal(new Set(ids).size, 4);
    assert.deepEqual(ids.slice(0, 2), ["o1", "o3"]);
  });

  test("an option's text is changed in the option whose id was sent, not the one at that position", () => {
    const q = make("multipleChoice", { shuffle: true, options: [opt("o1", "A", true), opt("o2", "B")] });
    const input = inputFrom(q);
    input.body.options = [input.body.options![1]!, input.body.options![0]!];
    input.body.options[0]!.text = "B changed";
    const { edit } = editFromInput(q, input);
    const options = (edit.body as { options: Array<{ id: string; correct: boolean }> }).options;
    assert.deepEqual(options.map((o) => [o.id, o.correct]), [["o2", false], ["o1", true]]);
  });
});

describe("title and metadata", () => {
  test("a title that followed the question text follows it when the text changes", () => {
    const q = make("shortAnswer", { caseSensitive: false, accepted: ["x"] });
    const input = inputFrom(q);
    input.stem = "What is the capital of Spain?";
    const { edit } = editFromInput(q, input);
    assert.equal(edit.title, "What is the capital of Spain?");
  });

  test("a title the person wrote is kept when the text changes", () => {
    const q = createQuestion({ type: "shortAnswer", stem: "What is the capital of France?", title: "Capitals 1", body: { caseSensitive: false, accepted: ["x"] }, by: "t", at: AT });
    const input = inputFrom(q);
    input.stem = "Something else entirely?";
    assert.equal(editFromInput(q, input).edit.title, "Capitals 1");
  });

  test("a title the person changes is used", () => {
    const q = make("shortAnswer", { caseSensitive: false, accepted: ["x"] });
    const input = inputFrom(q);
    input.title = "My title";
    assert.equal(editFromInput(q, input).edit.title, "My title");
  });

  test("a field that is emptied is removed from the question, not kept", () => {
    const q = createQuestion({
      type: "shortAnswer",
      stem: "Q?",
      body: { caseSensitive: false, accepted: ["x"] },
      metadata: { status: "draft", tags: ["a"], difficulty: "hard", bloom: "apply", objective: "Know it", chapter: "3" },
      by: "t",
      at: AT,
    });
    const input = inputFrom(q);
    input.metadata = { ...input.metadata, difficulty: "", bloom: "", objective: "", chapter: "", tags: [] };
    const next = editQuestion(q, editFromInput(q, input).edit, { by: "t" });
    assert.equal(next.metadata.difficulty, undefined);
    assert.equal(next.metadata.bloom, undefined);
    assert.equal(next.metadata.objective, undefined);
    assert.equal(next.metadata.chapter, undefined);
    assert.deepEqual(next.metadata.tags, []);
    assert.ok(validateQuestion(next).ok, "and the question is still valid");
  });
});

describe("a question made on the screen", () => {
  test("has its answer key checked before it is kept, so a missing answer shows from the first moment", () => {
    for (const [type, body] of [
      ["trueFalse", { correct: null }],
      ["shortAnswer", { accepted: [], caseSensitive: false }],
      ["fillInBlank", { blanks: [{ label: "", accepted: [] }], caseSensitive: false }],
    ] as Array<[QuestionType, EditorInput["body"]]>) {
      const input = { ...blankInput(type), stem: "A question with no answer.", body };
      const q = questionFromInput(input, "test", AT);
      assert.ok(q.findings.some((f) => f.severity === "error"), `${type} has no answer and says so`);
    }
  });

  test("is told what text is missing, in words, for each place the model needs some", () => {
    const input = blankInput("multipleChoice");
    assert.deepEqual(missingText(input), [
      "The question needs some text.",
      "Option 1 has no text. Write something, or remove it.",
      "Option 2 has no text. Write something, or remove it.",
      "Option 3 has no text. Write something, or remove it.",
      "Option 4 has no text. Write something, or remove it.",
    ]);
    assert.deepEqual(missingText({ ...blankInput("matching"), stem: "Match." }), [
      "Pair 1 has nothing on the left. Write something, or remove it.",
      "Pair 2 has nothing on the left. Write something, or remove it.",
    ]);
    assert.deepEqual(missingText({ ...blankInput("ordering"), stem: "Order." }), ["Item 1 has no text. Write something, or remove it.", "Item 2 has no text. Write something, or remove it."]);
    assert.deepEqual(missingText({ ...blankInput("essay"), stem: "Discuss." }), [], "an essay needs only its question");
    assert.deepEqual(missingText({ ...blankInput("trueFalse"), stem: "True?" }), [], "and a missing key is not missing text");
  });
});

describe("what the screen sends", () => {
  const good = (): Record<string, unknown> => JSON.parse(JSON.stringify(blankInput("multipleChoice")));
  const refused = (raw: unknown): string => {
    const parsed = parseInput(raw);
    assert.equal(parsed.ok, false);
    return (parsed as { ok: false; errors: string[] }).errors.join(" ");
  };

  test("is refused when it is not an object, or names a type that does not exist, or one that cannot be edited yet", () => {
    assert.match(refused(null), /not sent as an object/);
    assert.match(refused([]), /not sent as an object/);
    assert.match(refused({ ...good(), type: "sorcery" }), /not one that OpenAssess knows/);
    assert.match(refused({ ...good(), type: "hotspot" }), /hotspot question cannot be edited here yet/);
  });

  test("is refused when a field has the wrong kind of value, and says which", () => {
    assert.match(refused({ ...good(), stem: 5 }), /question text must be text/);
    assert.match(refused({ ...good(), points: "many" }), /points must be a number/);
    assert.match(refused({ ...good(), points: -1 }), /between 0 and 1000/);
    assert.match(refused({ ...good(), metadata: { status: "published" } }), /status is not one/);
    assert.match(refused({ ...good(), metadata: { difficulty: "brutal" } }), /difficulty is not one/);
    assert.match(refused({ ...good(), body: { options: "none" } }), /Option must be a list/);
    assert.match(refused({ ...good(), body: { options: [{ text: 3 }] } }), /Option 1 must be text/);
    assert.match(refused({ ...good(), body: { options: [{ text: "x", correct: "yes" }] } }), /must be true or false/);
  });

  test("is refused when an id could climb out of where ids belong", () => {
    assert.match(refused({ ...good(), body: { options: [{ id: "../../x", text: "x", correct: false }] } }), /id that is not allowed/);
    assert.match(refused({ ...good(), body: { options: [{ id: "a b", text: "x", correct: false }] } }), /id that is not allowed/);
  });

  test("is refused when it is absurdly large", () => {
    const rows = Array.from({ length: 201 }, () => ({ text: "x", correct: false }));
    assert.match(refused({ ...good(), body: { options: rows } }), /more than 200 rows/);
    assert.match(refused({ ...good(), stem: "x".repeat(100_001) }), /longer than 100,000 characters/);
  });

  test("is refused with every problem named at once", () => {
    const text = refused({ ...good(), stem: 1, points: "x" });
    assert.match(text, /question text must be text/);
    assert.match(text, /points must be a number/);
  });

  test("ignores fields it does not know, and never reads them", () => {
    const raw = { ...good(), id: "someone-elses", version: 99, findings: [], origin: { kind: "import" }, __proto__x: 1 };
    const parsed = parseInput(raw);
    assert.ok(parsed.ok);
    assert.equal(Object.hasOwn((parsed as { input: object }).input, "id"), false);
    assert.equal(Object.hasOwn((parsed as { input: object }).input, "findings"), false);
  });
});

describe("a type the screen cannot edit yet", () => {
  test("is shown as it is, and an edit to it is refused", () => {
    const hotspot = createQuestion({
      type: "hotspot",
      stem: "Click the heart.",
      body: { mediaRef: "m1", regions: [{ id: "r1", shape: "rect", coords: [0, 0, 1, 1], correct: true }], alternative: plainToRich("The heart is in the chest.") },
      by: "t",
      at: AT,
    });
    const editor = toEditor(hotspot);
    assert.match(editor.readOnly ?? "", /hotspot question cannot be edited here yet/);
    assert.throws(() => editFromInput(hotspot, blankInput("essay")), (error: unknown) => error instanceof HttpError && error.status === 400);
  });
});
