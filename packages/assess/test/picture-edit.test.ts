/**
 * Putting a picture in a question by hand, taking one out, and giving one other bytes.
 *
 * The rules: the picture is told by its own bytes, named by a hash of them (so the same picture is one file), added without a
 * description and said to lack one, put at the end of the question's text unless the person says otherwise, and never taken from
 * under the words that show it. A file that is not a picture is refused in words, not stored.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createQuestion, dismissFinding, editQuestion } from "../src/model/create.ts";
import { FindingCode, verdictFrom } from "../src/model/findings.ts";
import { MAX_PICTURE_BYTES } from "../src/model/image.ts";
import { addPicture, MAX_PICTURES_PER_QUESTION, PictureError, placedPictures, removePicture, replacePicture } from "../src/model/picture-edit.ts";
import type { Question } from "../src/model/question.ts";
import { collectRefs, plainToRich, richTextToPlain } from "../src/model/richtext.ts";
import { emf, gif, jpeg, png } from "./support/images.ts";

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex").slice(0, 16);
const BLUE = png(40, 30);
const RED = png(20, 20, { color: [200, 30, 30] });

const essay = (): Question => createQuestion({ type: "essay", stem: plainToRich("Describe the figure."), body: {}, by: "t", at: "2026-01-01T00:00:00.000Z" });
const apply = (q: Question, made: ReturnType<typeof addPicture>): Question => (made ? editQuestion(q, made.edit, { by: "t", change: made.change }) : q);
const has = (q: Question, code: string): boolean => q.findings.some((f) => f.code === code && f.dismissed !== true);

describe("adding a picture", () => {
  const made = addPicture(essay(), BLUE);
  const q = apply(essay(), made);

  test("stores it under a name made from its bytes, with its type and size, and no description", () => {
    assert.equal(made?.file, `media/p-${sha(BLUE)}.png`);
    assert.equal(made?.change, "added a picture");
    assert.deepEqual(q.media, [{ id: "m1", file: `media/p-${sha(BLUE)}.png`, mime: "image/png", alt: "", width: 40, height: 30 }]);
  });

  test("puts it at the end of the text, as a paragraph of its own, so that it shows at once", () => {
    assert.deepEqual(collectRefs(q.stem).media, ["m1"]);
    assert.equal(richTextToPlain(q.stem), "Describe the figure.");
    assert.match(q.stem.content, /<p>Describe the figure\.<\/p><p><oa-media ref="m1"><\/oa-media><\/p>$/);
  });

  test("says that it has no description, as a warning, so that one is written", () => {
    assert.ok(has(q, FindingCode.MissingAltText));
    assert.equal(verdictFrom(q.findings), "needsReview");
    assert.equal(q.findings.find((f) => f.code === FindingCode.MissingAltText)?.severity, "warn");
  });

  test("is one more version of the question, with a history entry that says what was done", () => {
    assert.equal(q.version, 2);
    assert.equal(q.history.at(-1)?.change, "added a picture");
  });

  test("without place, is carried and not shown, and a second add puts it in the text", () => {
    const carried = apply(essay(), addPicture(essay(), BLUE, { place: false }));
    assert.equal(carried.media.length, 1);
    assert.deepEqual([...placedPictures(carried)], []);
    const again = addPicture(carried, BLUE);
    assert.equal(again?.change, "put a picture in the text");
    assert.equal(again?.edit.media, undefined, "the picture is not added twice");
    assert.deepEqual(collectRefs(apply(carried, again).stem).media, ["m1"]);
  });

  test("the same picture again is no change at all, and a different one is the second", () => {
    assert.equal(addPicture(q, BLUE), undefined);
    const two = apply(q, addPicture(q, RED));
    assert.deepEqual(two.media.map((m) => m.id), ["m1", "m2"]);
    assert.deepEqual(collectRefs(two.stem).media, ["m1", "m2"]);
  });

  test("a JPEG and a GIF are pictures too, each named by its own type", () => {
    assert.equal(addPicture(essay(), jpeg(10, 10))?.file.endsWith(".jpg"), true);
    assert.equal(addPicture(essay(), gif(10, 10))?.file.endsWith(".gif"), true);
  });

  test("a stem that was plain text is made rich, with its words kept", () => {
    const plainStem = { ...essay(), stem: { format: "plain" as const, content: "Look & say." } };
    const next = apply(plainStem, addPicture(plainStem, BLUE));
    assert.equal(richTextToPlain(next.stem), "Look & say.");
    assert.deepEqual(collectRefs(next.stem).media, ["m1"]);
  });

  test("what is not a picture is refused in words, and nothing is made of it", () => {
    for (const bytes of [new Uint8Array(0), new TextEncoder().encode("<script>alert(1)</script>"), emf(), new Uint8Array(MAX_PICTURE_BYTES + 1)]) {
      assert.throws(() => addPicture(essay(), bytes), (e: unknown) => e instanceof PictureError && /not a PNG, JPEG or GIF picture/.test(e.message));
    }
  });

  test("a question carries a limited number", () => {
    let full = essay();
    for (let i = 0; i < MAX_PICTURES_PER_QUESTION; i++) full = apply(full, addPicture(full, png(5 + i, 5), { place: false }));
    assert.equal(full.media.length, MAX_PICTURES_PER_QUESTION);
    assert.throws(() => addPicture(full, png(500, 5)), /at most 40 pictures/);
    assert.equal(addPicture(full, png(5, 5), { place: false }), undefined, "one it already has is still no change");
  });

  test("a note that was dismissed stays dismissed when a second picture without a description comes in", () => {
    const note = q.findings.find((f) => f.code === FindingCode.MissingAltText);
    assert.ok(note);
    const dismissed = dismissFinding(q, FindingCode.MissingAltText, "t");
    const two = apply(dismissed, addPicture(dismissed, RED));
    assert.equal(two.findings.filter((f) => f.code === FindingCode.MissingAltText).length, 1);
    assert.equal(two.findings.find((f) => f.code === FindingCode.MissingAltText)?.dismissed, true);
  });

  test("a picture added and then described no longer has the note", () => {
    const described = editQuestion(q, { media: q.media.map((m) => ({ ...m, alt: "A blue box" })) }, { by: "t" });
    assert.ok(!has(described, FindingCode.MissingAltText));
    assert.equal(verdictFrom(described.findings), "parsed");
  });
});

describe("replacing a picture", () => {
  const base = apply(apply(essay(), addPicture(essay(), BLUE)), undefined);
  const described = editQuestion(base, { media: base.media.map((m) => ({ ...m, alt: "A blue box", decorative: false })) }, { by: "t" });

  test("gives it other bytes and keeps its place, its description and its decoration mark", () => {
    const made = replacePicture(described, "m1", RED);
    assert.equal(made?.file, `media/p-${sha(RED)}.png`);
    assert.equal(made?.change, "replaced a picture");
    assert.equal(made?.edit.stem, undefined, "the text is not touched");
    const next = apply(described, made);
    assert.deepEqual(next.media, [{ id: "m1", file: `media/p-${sha(RED)}.png`, mime: "image/png", alt: "A blue box", decorative: false, width: 20, height: 20 }]);
    assert.deepEqual(collectRefs(next.stem).media, ["m1"]);
  });

  test("with the same picture is no change, with a different type changes the type, and an unknown picture is refused", () => {
    assert.equal(replacePicture(described, "m1", BLUE), undefined);
    assert.equal(apply(described, replacePicture(described, "m1", jpeg(8, 6))).media[0]?.mime, "image/jpeg");
    assert.throws(() => replacePicture(described, "m9", RED), /no such picture/);
    assert.throws(() => replacePicture(described, "m1", emf()), PictureError);
  });
});

describe("removing a picture", () => {
  test("is refused while a text has it in place, in words that say what to do", () => {
    const q = apply(essay(), addPicture(essay(), BLUE));
    assert.throws(() => removePicture(q, "m1"), (e: unknown) => e instanceof PictureError && /Take its \[picture\] words out of the text and save/.test(e.message));
  });

  test("works for one no text shows, takes it out of the question, and leaves the question's words alone", () => {
    const q = apply(essay(), addPicture(essay(), BLUE, { place: false }));
    const made = removePicture(q, "m1");
    assert.equal(made.change, "removed a picture");
    const next = apply(q, made);
    assert.deepEqual(next.media, []);
    assert.equal(richTextToPlain(next.stem), "Describe the figure.");
  });

  test("an unknown picture is refused", () => {
    assert.throws(() => removePicture(essay(), "m1"), /no such picture/);
  });
});
