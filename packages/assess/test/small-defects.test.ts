/**
 * Five small defects from the open list in docs/review-findings.md, each with the case that was once wrong:
 *
 *  - a stem that is only an equation was reported empty;
 *  - a picture or equation reference that dangled in most fields of a question was never found, because only four were looked at;
 *  - adding a question to a folder that is not there left it in the bank, in no folder, with an error saying it was not added;
 *  - a save that failed left a half-written file beside the bank, and was not flushed before the rename;
 *  - a Rich Text file was read as plain text, and its control words came in as lines of a question.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Bank } from "../src/bank/store.ts";
import { importerForContent, runImporter } from "../src/import/registry.ts";
import { standardTextImporter } from "../src/import/standard-text.ts";
import { wordImporter } from "../src/import/word.ts";
import { checkReferences, createQuestion } from "../src/model/create.ts";
import { FindingCode } from "../src/model/findings.ts";
import { isEmptyRichText, plainToRich, rich, richTextFields } from "../src/model/richtext.ts";

describe("an equation is not nothing", () => {
  test("a stem that is only an equation or only a picture is not empty, and no text and no reference is", () => {
    assert.equal(isEmptyRichText(rich('<p><oa-math ref="e1"></oa-math></p>')), false);
    assert.equal(isEmptyRichText(rich('<p><oa-media ref="m1"></oa-media></p>')), false);
    assert.equal(isEmptyRichText(rich("<p> </p>")), true);
    assert.equal(isEmptyRichText(undefined), true);
    assert.equal(isEmptyRichText(plainToRich("Words")), false);
  });
});

describe("every piece of rich text is walked", () => {
  test("finds the stem, the feedback and whatever the body holds, with the path of each", () => {
    const q = createQuestion({
      type: "matching",
      stem: plainToRich("Match."),
      feedback: { general: plainToRich("Well done.") },
      body: { shuffle: true, distractors: ["x"], pairs: [{ id: "p1", left: plainToRich("Left one"), right: "Right one" }] } as never,
    });
    const paths = richTextFields({ stem: q.stem, feedback: q.feedback, body: q.body }).map(([path]) => path);
    assert.deepEqual(paths, ["stem", "feedback.general", "body.pairs.0.left"]);
  });

  test("walks lists, and leaves strings and numbers alone", () => {
    assert.deepEqual(richTextFields(["a", 1, null, { content: "no format" }]), []);
    assert.deepEqual(richTextFields([plainToRich("one"), [plainToRich("two")]]).map(([p]) => p), ["0", "1.0"]);
  });
});

describe("a reference that points at nothing is found wherever it is", () => {
  const dangling = (field: string, make: (text: ReturnType<typeof rich>) => Parameters<typeof createQuestion>[0]) => {
    test(`in ${field}`, () => {
      const found = checkReferences(createQuestion(make(rich('<p>See <oa-media ref="gone"></oa-media></p>'))));
      assert.deepEqual(found.map((f) => [f.code, f.field]), [[FindingCode.DanglingMediaRef, field]]);
    });
  };

  dangling("stem", (text) => ({ type: "essay", stem: text, body: {} }));
  dangling("body.options.1.feedback", (text) => ({
    type: "multipleChoice",
    stem: plainToRich("Q"),
    body: { shuffle: true, options: [{ id: "a", content: plainToRich("A"), correct: true }, { id: "b", content: plainToRich("B"), correct: false, feedback: text }] } as never,
  }));
  dangling("body.pairs.0.left", (text) => ({ type: "matching", stem: plainToRich("Q"), body: { shuffle: true, distractors: [], pairs: [{ id: "p", left: text, right: "R" }] } as never }));
  dangling("body.items.0.content", (text) => ({ type: "ordering", stem: plainToRich("Q"), body: { items: [{ id: "i", content: text, position: 1 }] } as never }));
  dangling("body.modelAnswer", (text) => ({ type: "essay", stem: plainToRich("Q"), body: { modelAnswer: text } }));
  dangling("body.alternative", (text) => ({ type: "hotspot", stem: plainToRich("Q"), body: { mediaRef: "m", regions: [], alternative: text } as never }));
  dangling("feedback.incorrect", (text) => ({ type: "essay", stem: plainToRich("Q"), body: {}, feedback: { incorrect: text } }));

  test("a reference that is there is not found, and an equation that is not there is", () => {
    const ok = createQuestion({ type: "essay", stem: rich('<oa-media ref="m1"></oa-media>'), body: { modelAnswer: rich('<oa-math ref="e1"></oa-math>') }, media: [{ id: "m1", file: "media/m1.png", mime: "image/png", alt: "x" }], math: [{ id: "e1", latex: "x", mathml: "<math/>" }] });
    assert.deepEqual(checkReferences(ok), []);
    const missing = createQuestion({ type: "essay", stem: plainToRich("Q"), body: { modelAnswer: rich('<oa-math ref="e9"></oa-math>') } });
    assert.deepEqual(checkReferences(missing).map((f) => [f.code, f.field]), [[FindingCode.DanglingMathRef, "body.modelAnswer"]]);
  });

  test("the fields that were looked at before are named as they were, so a dismissal still matches", () => {
    const q = createQuestion({
      type: "multipleChoice",
      stem: rich('<oa-media ref="a"></oa-media>'),
      feedback: { general: rich('<oa-media ref="b"></oa-media>'), correct: rich('<oa-media ref="c"></oa-media>') },
      body: { shuffle: true, options: [{ id: "o", content: rich('<oa-media ref="d"></oa-media>'), correct: true }, { id: "p", content: plainToRich("P"), correct: false }] } as never,
    });
    assert.deepEqual(checkReferences(q).map((f) => f.field), ["stem", "feedback.general", "feedback.correct", "body.options.0.content"]);
  });
});

describe("adding to a folder that is not there", () => {
  test("changes nothing", () => {
    const bank = Bank.createEmpty("Folders");
    const q = createQuestion({ type: "essay", stem: plainToRich("Q"), body: {} });
    assert.throws(() => bank.add(q, { folderId: "no-such-folder" }), /No folder with the id no-such-folder is in this bank\./);
    assert.equal(bank.questions.size, 0, "the question is not in the bank");
    assert.equal(bank.search("Q").length, 0, "nor in the index");
    assert.equal(bank.history.length, 0, "nor in the history");
    // And the same question can be added, to a folder that is there.
    const folder = bank.addFolder("Chapter 1");
    bank.add(q, { folderId: folder.id });
    assert.equal(bank.questions.size, 1);
    assert.deepEqual(bank.folders.root[0]?.questionIds, [q.id]);
  });
});

describe("saving a bank", () => {
  const folder = (): string => mkdtempSync(join(tmpdir(), "openassess-save-"));

  test("writes the file, and leaves nothing beside it", async () => {
    const dir = folder();
    try {
      const bank = Bank.createEmpty("Saved");
      bank.add(createQuestion({ type: "essay", stem: plainToRich("Q"), body: {} }));
      const target = join(dir, "saved.openassess");
      assert.equal(await bank.save(target), target);
      assert.deepEqual(readdirSync(dir), ["saved.openassess"]);
      assert.equal((await Bank.open(target)).bank.questions.size, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a save that fails leaves no half-written file, and the bank that was there", async () => {
    const dir = folder();
    try {
      // A folder where the bank should go, with something in it: the rename cannot put a file there.
      const target = join(dir, "blocked.openassess");
      mkdirSync(target);
      writeFileSync(join(target, "keep.txt"), "kept");
      const bank = Bank.createEmpty("Blocked");
      await assert.rejects(() => bank.save(target));
      assert.equal(existsSync(`${target}.writing`), false, "the temporary file is gone");
      assert.deepEqual(readdirSync(target), ["keep.txt"], "what was there is as it was");
      assert.equal(bank.path, undefined, "and the bank does not think it was saved");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a save into a folder that is not there fails with no file left", async () => {
    const dir = folder();
    try {
      const bank = Bank.createEmpty("Nowhere");
      await assert.rejects(() => bank.save(join(dir, "missing-folder", "bank.openassess")));
      assert.deepEqual(readdirSync(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a Rich Text file", () => {
  const rtf = Buffer.from("{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Times New Roman;}}\\f0 1. What is 2 + 2?\\par a. 3\\par *b. 4\\par }");

  test("is sent to the Word importer, by name or by what it begins with, and not read as text", () => {
    assert.equal(importerForContent("bank.rtf", rtf), wordImporter);
    assert.equal(importerForContent("BANK.RTF", Buffer.from("anything")), wordImporter);
    assert.equal(importerForContent("bank.txt", rtf), wordImporter, "a Rich Text file named as text is still one");
    assert.equal(importerForContent("noextension", rtf), wordImporter);
  });

  test("is not read, and the answer says what to do", () => {
    assert.throws(() => runImporter(importerForContent("bank.rtf", rtf), rtf, { file: "bank.rtf" }), /Rich Text file \(\.rtf\).*Save As, and pick Word Document/s);
  });

  test("plain text that merely mentions rtf is still plain text", () => {
    assert.equal(importerForContent("a.txt", Buffer.from("1. What is rtf?\na. A format\n*b. Rich Text Format\n")), standardTextImporter);
    assert.equal(importerForContent("a.txt", Buffer.from("{rtf is not it")), standardTextImporter);
    assert.deepEqual(standardTextImporter.extensions, [".txt", ".md"]);
  });
});
