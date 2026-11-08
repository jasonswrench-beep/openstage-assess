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
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
import { isEmptyRichText, plainToRich, rich, richTextFields, richTextToPlain } from "../src/model/richtext.ts";

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
      // The temporary file has a name of its own that this test cannot know, so what is looked at is the folder: nothing but the folder
      // that was in the way is left in it.
      assert.deepEqual(readdirSync(dir), ["blocked.openassess"], "the temporary file is gone");
      assert.deepEqual(readdirSync(target), ["keep.txt"], "what was there is as it was");
      assert.equal(bank.path, undefined, "and the bank does not think it was saved");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Found by a reader who ran two copies of the app on one library: the temporary file was always `<bank>.writing`, so two saves of one
  // bank took each other's file and one of them failed with ENOENT (1 to 10 of 40 requests answered 500, and the bank held 17 to 20 of
  // the 40 questions that had been added). Two copies still lose each other's edits, because each holds its own copy of the bank in
  // memory; what a name of its own for the temporary file fixes is the failure, not that.
  test("saves at the same moment, to the same bank, do not take each other's temporary file", async () => {
    const dir = folder();
    try {
      const target = join(dir, "shared.openassess");
      const writers = Array.from({ length: 12 }, (_x, i) => {
        const bank = Bank.createEmpty(`Writer ${i}`);
        for (let q = 0; q <= i; q++) bank.add(createQuestion({ type: "essay", stem: plainToRich(`Question ${q} of writer ${i}`), body: {} }));
        return bank;
      });
      // Three rounds, because on Windows two renames onto one file at the same moment can meet, and the second is refused for a moment
      // (EPERM): the save tries that again, and it is a rare thing to see in one round.
      for (let round = 0; round < 3; round++) {
        const settled = await Promise.allSettled(writers.map((bank) => bank.save(target)));
        assert.deepEqual(settled.filter((s) => s.status === "rejected").map((s) => String((s as PromiseRejectedResult).reason).slice(0, 120)), [], "every save is made");
      }
      assert.deepEqual(readdirSync(dir), ["shared.openassess"], "and nothing is left beside the bank");
      const { bank } = await Bank.open(target);
      assert.match(bank.manifest.title, /^Writer \d+$/, "and what is there is one of the banks whole");
      assert.equal(bank.questions.size, Number(bank.manifest.title.slice("Writer ".length)) + 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a file or a folder at the name the temporary file used to have does not stop a save", async () => {
    const dir = folder();
    try {
      const target = join(dir, "bank.openassess");
      mkdirSync(`${target}.writing`);
      await Bank.createEmpty("Not stopped").save(target);
      assert.equal((await Bank.open(target)).bank.manifest.title, "Not stopped");
      assert.deepEqual(readdirSync(dir).sort(), ["bank.openassess", "bank.openassess.writing"], "and it was not touched");
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

describe("a kept file whose name is a path something else now uses", () => {
  const text = (bytes: Uint8Array | undefined): string => Buffer.from(bytes as Uint8Array).toString("utf8");
  const zipOf = (files: Map<string, Uint8Array>): Uint8Array => zipSync([...files].map(([name, data]) => ({ name, data })));

  test("a conflicted copy with the same id is written beside the question, not dropped by the save", () => {
    const bank = Bank.createEmpty("Conflict");
    const original = bank.add(createQuestion({ type: "essay", stem: plainToRich("The stem as first written"), body: {} }));
    const files = unzipSync(bank.toBytes());
    const path = `questions/${original.id}.json`;
    const originalBytes = files.get(path) as Uint8Array;
    // The copy a sync tool makes: the same question, edited, with another file name, listed before the original.
    const edited = { ...original, stem: plainToRich("The stem as edited in the copy") };
    const reordered = new Map<string, Uint8Array>([[`questions/${original.id} (conflicted copy).json`, new Uint8Array(Buffer.from(JSON.stringify(edited)))]]);
    for (const [name, data] of files) reordered.set(name, data);

    const opened = Bank.fromBytes(zipOf(reordered));
    assert.equal(richTextToPlain(opened.bank.get(original.id)!.stem), "The stem as edited in the copy", "the copy came first and is the one that loaded");
    assert.ok(opened.report.invalid.some((e) => /already uses the id/.test(e.issues[0]?.message ?? "")), "and the original is said to be kept");

    const saved = unzipSync(opened.bank.toBytes());
    assert.ok(saved.has(path), "the loaded question is written at its own path");
    const kept = [...saved].filter(([name]) => name.startsWith(path) && name !== path);
    assert.equal(kept.length, 1, "and the original is there, under a name beside it");
    assert.equal(text(kept[0]?.[1]), text(originalBytes), "byte for byte");

    // Opened and saved again, it is still there, and nothing is reported as a collision any more.
    const again = Bank.fromBytes(opened.bank.toBytes());
    assert.deepEqual(again.report.invalid, []);
    assert.deepEqual(again.report.unknownFiles, [`${path}.kept`], "the kept original is an unknown file now, named, and kept");
    const twice = unzipSync(again.bank.toBytes());
    assert.equal(text(twice.get(`${path}.kept`)), text(originalBytes), "and it is the same again after another save");
  });

  test("a damaged file named for the path of a question that loaded from another file is kept too", () => {
    const bank = Bank.createEmpty("Collide");
    const a = bank.add(createQuestion({ type: "essay", stem: plainToRich("First question"), body: {} }));
    const b = bank.add(createQuestion({ type: "essay", stem: plainToRich("Second question"), body: {} }));
    const files = unzipSync(bank.toBytes());
    // b's file now says it is a; a's file is damaged. The damaged file is named for the path b's question will be written to.
    const bFile = JSON.parse(text(files.get(`questions/${b.id}.json`)));
    files.set(`questions/${b.id}.json`, new Uint8Array(Buffer.from(JSON.stringify({ ...bFile, id: a.id }))));
    files.set(`questions/${a.id}.json`, new Uint8Array(Buffer.from("{ damaged")));
    const opened = Bank.fromBytes(zipOf(files));
    assert.ok(opened.report.invalid.length >= 1);
    const saved = unzipSync(opened.bank.toBytes());
    const survivors = [...saved].filter(([, data]) => text(data) === "{ damaged");
    assert.equal(survivors.length, 1, "the damaged file survived the save");
  });

  test("a name that is already taken for the kept file gets the next one", () => {
    const bank = Bank.createEmpty("Names");
    const q = bank.add(createQuestion({ type: "essay", stem: plainToRich("One question"), body: {} }));
    const files = unzipSync(bank.toBytes());
    const path = `questions/${q.id}.json`;
    const opened = Bank.fromBytes(zipOf(files));
    const kept = (opened.bank as unknown as { passthrough: Map<string, Uint8Array> }).passthrough;
    kept.set(path, new Uint8Array(Buffer.from("kept one")));
    kept.set(`${path}.kept`, new Uint8Array(Buffer.from("already here")));
    const saved = unzipSync(opened.bank.toBytes());
    assert.equal(text(saved.get(`${path}.kept`)), "already here");
    assert.equal(text(saved.get(`${path}.kept-2`)), "kept one");
  });
});

describe("history lines that cannot be read", () => {
  test("are kept in a file of their own through a save, and reported with where", () => {
    const bank = Bank.createEmpty("History");
    bank.add(createQuestion({ type: "essay", stem: plainToRich("A question"), body: {} }));
    const files = unzipSync(bank.toBytes());
    const log = Buffer.from(files.get("history.jsonl") as Uint8Array).toString("utf8");
    files.set("history.jsonl", new Uint8Array(Buffer.from(`${log}{ half a line\nnot json either\n`)));
    const opened = Bank.fromBytes(zipSync([...files].map(([name, data]) => ({ name, data }))));
    const entry = opened.report.invalid.find((e) => e.id === "history.jsonl");
    assert.match(entry?.issues[0]?.message ?? "", /^2 history line\(s\) were unreadable\. They are kept as history\.damaged\.jsonl\./);
    const saved = unzipSync(opened.bank.toBytes());
    assert.equal(Buffer.from(saved.get("history.damaged.jsonl") as Uint8Array).toString("utf8"), "{ half a line\nnot json either\n");
    assert.equal(Buffer.from(saved.get("history.jsonl") as Uint8Array).toString("utf8").includes("half a line"), false, "the log itself holds only what could be read");
    const again = Bank.fromBytes(opened.bank.toBytes());
    assert.deepEqual(again.report.invalid, [], "and the log it wrote is a good one");
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
