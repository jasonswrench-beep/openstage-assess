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
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Bank, countMismatchMessage } from "../src/bank/store.ts";
import { unzipSync, zipSync } from "../src/container/zip.ts";
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

describe("a bank that opens with a different number of questions than it says", () => {
  const threeQuestions = (): Bank => {
    const bank = Bank.createEmpty("Counted");
    for (const stem of ["First question", "Second question", "Third question"]) bank.add(createQuestion({ type: "essay", stem: plainToRich(stem), body: {} }));
    return bank;
  };
  const questionFiles = (files: Map<string, Uint8Array>): string[] => [...files.keys()].filter((name) => name.startsWith("questions/"));

  test("a bank that was written as it is reports nothing", () => {
    const { report } = Bank.fromBytes(threeQuestions().toBytes());
    assert.equal(report.countMismatch, undefined);
    assert.deepEqual(report.invalid, []);
  });

  test("says so when a question file is gone, which is what a sync or a merge that took one side does", () => {
    const files = unzipSync(threeQuestions().toBytes());
    files.delete(questionFiles(files)[0] as string);
    const { bank, report } = Bank.fromBytes(zipSync([...files].map(([name, data]) => ({ name, data }))));
    assert.equal(bank.questions.size, 2);
    assert.deepEqual(report.countMismatch, { says: 3, found: 2 });
    assert.match(countMismatchMessage(report.countMismatch as { says: number; found: number }), /^This bank says it held 3 questions when it was last saved, and 2 could be read\. If files were lost when it was synced or merged, the missing question is in an earlier copy\.$/);
  });

  test("says so, more gently, when there are more than it says", () => {
    const files = unzipSync(threeQuestions().toBytes());
    const extra = createQuestion({ type: "essay", stem: plainToRich("A fourth question from another copy"), body: {} });
    files.set(`questions/${extra.id}.json`, new Uint8Array(Buffer.from(JSON.stringify(extra))));
    const { report } = Bank.fromBytes(zipSync([...files].map(([name, data]) => ({ name, data }))));
    assert.deepEqual(report.countMismatch, { says: 3, found: 4 });
    assert.match(countMismatchMessage(report.countMismatch as { says: number; found: number }), /says it held 3 questions.*4 were read\. It has more than it says.*Nothing is lost\.$/);
  });

  test("names the numbers in the singular and the plural", () => {
    assert.match(countMismatchMessage({ says: 1, found: 0 }), /held 1 question when.*the missing question is in/);
    assert.match(countMismatchMessage({ says: 5, found: 2 }), /held 5 questions when.*2 could be read.*the missing questions are in/);
  });

  test("a bank that says nothing about its count has nothing to disagree with", () => {
    const files = unzipSync(threeQuestions().toBytes());
    const manifest = JSON.parse(Buffer.from(files.get("manifest.json") as Uint8Array).toString("utf8"));
    delete manifest.questionCount;
    files.set("manifest.json", new Uint8Array(Buffer.from(JSON.stringify(manifest))));
    assert.equal(Bank.fromBytes(zipSync([...files].map(([name, data]) => ({ name, data })))).report.countMismatch, undefined);
  });

  test("a question that cannot be read is kept, and a bank that keeps one is not at odds with itself after it is saved", () => {
    const files = unzipSync(threeQuestions().toBytes());
    files.set(questionFiles(files)[0] as string, new Uint8Array(Buffer.from("{ this is not json")));
    const opened = Bank.fromBytes(zipSync([...files].map(([name, data]) => ({ name, data }))));
    assert.equal(opened.report.invalid.length, 1);
    assert.deepEqual(opened.report.countMismatch, { says: 3, found: 2 }, "it was three when saved, and one can no longer be read");
    // Saved again, it says what it holds now, and still keeps the file.
    const reopened = Bank.fromBytes(opened.bank.toBytes());
    assert.equal(reopened.report.countMismatch, undefined);
    assert.equal(reopened.report.invalid.length, 1, "the unreadable file is still there, kept as it was");
    const damaged = questionFiles(files)[0] as string;
    assert.equal(Buffer.from(unzipSync(opened.bank.toBytes()).get(damaged) as Uint8Array).toString("utf8"), "{ this is not json", "byte for byte");
  });

  test("a question file with a mistake in it, and one that is not JSON at all, are both kept through a save", () => {
    const files = unzipSync(threeQuestions().toBytes());
    const [first, second] = questionFiles(files);
    files.set(first as string, new Uint8Array(Buffer.from("not json at all")));
    const wrong = JSON.parse(Buffer.from(files.get(second as string) as Uint8Array).toString("utf8"));
    wrong.points = -4;
    files.set(second as string, new Uint8Array(Buffer.from(JSON.stringify(wrong))));
    const opened = Bank.fromBytes(zipSync([...files].map(([name, data]) => ({ name, data }))));
    assert.equal(opened.report.invalid.length, 2);
    const saved = unzipSync(opened.bank.toBytes());
    for (const name of [first, second] as string[]) assert.ok(saved.has(name), `${name} was dropped by the save`);
  });
});

describe("a bank whose folder file is damaged", () => {
  const withFolders = (): Bank => {
    const bank = Bank.createEmpty("Folders");
    const question = bank.add(createQuestion({ type: "essay", stem: plainToRich("A question in a folder"), body: {} }));
    bank.moveToFolder(question.id, bank.addFolder("Chapter 1").id);
    return bank;
  };
  const damage = (bytes: string, extra: Record<string, string> = {}) => {
    const files = unzipSync(withFolders().toBytes());
    files.set("folders.json", new Uint8Array(Buffer.from(bytes)));
    for (const [name, text] of Object.entries(extra)) files.set(name, new Uint8Array(Buffer.from(text)));
    return Bank.fromBytes(zipSync([...files].map(([name, data]) => ({ name, data }))));
  };

  test("opens, with its questions, instead of refusing the whole bank because one file is not JSON", () => {
    const { bank, report } = damage("{ broken");
    assert.equal(bank.questions.size, 1);
    assert.deepEqual(bank.folders.root, []);
    assert.equal(report.invalid.length, 1);
    assert.equal(report.invalid[0]?.id, "folders.json");
    assert.match(report.invalid[0]?.issues[0]?.message ?? "", /not valid JSON.*The bank was opened with no folders, and this file is kept as folders\.damaged\.json\.$/);
  });

  test("says so when the file is JSON of the wrong shape, which used to be replaced by an empty tree without a word", () => {
    const { report } = damage('{"root": 5, "filters": []}');
    assert.equal(report.invalid.length, 1);
    assert.match(report.invalid[0]?.issues[0]?.message ?? "", /^the folders are not in the shape a bank keeps them\. The bank was opened with no folders/);
  });

  test("keeps the damaged file, byte for byte, through a save, beside a good folder file", () => {
    for (const text of ["{ broken", '{"root": 5, "filters": []}', "[]"]) {
      const { bank } = damage(text);
      const saved = unzipSync(bank.toBytes());
      assert.equal(Buffer.from(saved.get("folders.damaged.json") as Uint8Array).toString("utf8"), text, text);
      const again = Bank.fromBytes(bank.toBytes());
      assert.deepEqual(again.report.invalid, [], "the folder file it wrote is a good one");
      assert.deepEqual(again.report.unknownFiles, ["folders.damaged.json"], "and the damaged one is still there, named");
    }
  });

  test("does not write over an earlier damaged file", () => {
    const { bank, report } = damage("{ second", { "folders.damaged.json": "{ first" });
    assert.match(report.invalid[0]?.issues[0]?.message ?? "", /kept as folders\.damaged-2\.json\.$/);
    const saved = unzipSync(bank.toBytes());
    assert.equal(Buffer.from(saved.get("folders.damaged.json") as Uint8Array).toString("utf8"), "{ first");
    assert.equal(Buffer.from(saved.get("folders.damaged-2.json") as Uint8Array).toString("utf8"), "{ second");
  });

  test("a good folder tree is read as it was, and a bank with no folder file at all has nothing to report", () => {
    const good = Bank.fromBytes(withFolders().toBytes());
    assert.equal(good.bank.folders.root[0]?.name, "Chapter 1");
    assert.equal(good.bank.folders.root[0]?.questionIds.length, 1);
    assert.deepEqual(good.report.invalid, []);
    const files = unzipSync(withFolders().toBytes());
    files.delete("folders.json");
    const none = Bank.fromBytes(zipSync([...files].map(([name, data]) => ({ name, data }))));
    assert.deepEqual(none.report.invalid, []);
    assert.equal(none.bank.questions.size, 1);
    assert.equal(unzipSync(none.bank.toBytes()).has("folders.damaged.json"), false);
  });
});

describe("openassess validate and info on a bank that lost a file", () => {
  const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, ...args], { encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  test("both say so, and validate fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openassess-lost-"));
    try {
      const bank = Bank.createEmpty("Lost");
      for (const stem of ["One question", "Two questions", "Three questions"]) bank.add(createQuestion({ type: "essay", stem: plainToRich(stem), body: {} }));
      const files = unzipSync(bank.toBytes());
      files.delete([...files.keys()].find((f) => f.startsWith("questions/")) as string);
      const path = join(dir, "lost.openassess");
      writeFileSync(path, zipSync([...files].map(([name, data]) => ({ name, data }))));

      const validate = run("validate", path);
      assert.equal(validate.code, 1, validate.err);
      assert.match(validate.out, /\(the bank as a whole\)\n {4}This bank says it held 3 questions when it was last saved, and 2 could be read\./);
      assert.match(validate.out, /1 question\(s\) do not satisfy the model\./);

      const info = run("info", path);
      assert.equal(info.code, 0, info.err);
      assert.match(info.out, /This bank says it held 3 questions when it was last saved, and 2 could be read\./);

      const whole = join(dir, "whole.openassess");
      await bank.save(whole);
      assert.equal(run("validate", whole).code, 0);
      assert.doesNotMatch(run("info", whole).out, /says it held/);
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
