import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { crc32, unzipSync, zipSync, textEntry } from "../src/container/zip.ts";
import { Bank } from "../src/bank/store.ts";
import { createQuestion } from "../src/model/create.ts";
import { plainToRich } from "../src/model/richtext.ts";
import { localId } from "../src/model/ids.ts";
import { BANK_EXTENSION, BANK_FORMAT_VERSION } from "../src/naming.ts";
import { FutureFormatError } from "../src/model/migrate.ts";
import type { Question } from "../src/model/question.ts";

function question(n: number, overrides: Record<string, unknown> = {}): Question {
  return createQuestion({
    type: "multipleChoice",
    stem: `Question ${n}: what is the capital of country ${n}?`,
    points: 1,
    metadata: { chapter: String((n % 3) + 1), tags: [`unit-${(n % 2) + 1}`], status: "draft" },
    body: {
      shuffle: true,
      options: [0, 1, 2, 3].map((j) => ({
        id: localId("o", j),
        content: plainToRich(`City ${j + 1} of country ${n}`),
        correct: j === 0,
      })),
    },
    at: "2026-01-01T00:00:00.000Z",
    by: "test",
    ...overrides,
  });
}

describe("the zip container", () => {
  test("round-trips text", () => {
    const bytes = zipSync([textEntry("a.txt", "hello"), textEntry("dir/b.json", '{"x":1}')]);
    const files = unzipSync(bytes);
    assert.equal(Buffer.from(files.get("a.txt")!).toString("utf8"), "hello");
    assert.equal(Buffer.from(files.get("dir/b.json")!).toString("utf8"), '{"x":1}');
  });

  test("round-trips content that does not compress", () => {
    const random = new Uint8Array(4096);
    for (let i = 0; i < random.length; i++) random[i] = (i * 2654435761) % 256;
    const files = unzipSync(zipSync([{ name: "noise.bin", data: random }]));
    assert.deepEqual(files.get("noise.bin"), random);
  });

  test("round-trips a stored entry", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const files = unzipSync(zipSync([{ name: "m.png", data, store: true }]));
    assert.deepEqual(files.get("m.png"), data);
  });

  test("handles UTF-8 names and large text", () => {
    const text = "Ångström ".repeat(5000);
    const files = unzipSync(zipSync([textEntry("équations/å.txt", text)]));
    assert.equal(Buffer.from(files.get("équations/å.txt")!).toString("utf8"), text);
  });

  test("says plainly when a file is not a zip", () => {
    assert.throws(
      () => unzipSync(new Uint8Array([1, 2, 3, 4])),
      /not a zip/,
    );
  });

  test("crc32 matches the known value for the standard check string", () => {
    assert.equal(crc32(new Uint8Array(Buffer.from("123456789", "ascii"))), 0xcbf43926);
  });
});

describe("a bank", () => {
  test("round-trips through bytes with questions, folders and history intact", () => {
    const bank = Bank.createEmpty("Test bank", { at: "2026-01-01T00:00:00.000Z" });
    const folder = bank.addFolder("Chapter 1");
    const q = question(1);
    bank.add(q, { folderId: folder.id });
    bank.add(question(2));

    const { bank: reopened, report } = Bank.fromBytes(bank.toBytes());
    assert.equal(reopened.questions.size, 2);
    assert.equal(reopened.manifest.title, "Test bank");
    assert.equal(reopened.manifest.bankId, bank.manifest.bankId);
    assert.equal(reopened.manifest.questionCount, 2);
    assert.deepEqual(report.invalid, []);
    assert.deepEqual(report.unknownFiles, []);
    assert.deepEqual(reopened.folders.root[0]?.questionIds, [q.id]);
    assert.ok(reopened.history.length >= 2);
  });

  test("saved twice at the same time, comes out the same, whatever the clock does between", (t) => {
    // Every file in the zip is stamped, to two seconds, with a time. Stamped with the clock they differ when it ticks between two
    // saves, which made a test that saves twice and compares fail now and then. With a time given they are stamped with it.
    t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-06-15T10:00:00").getTime() });
    const bank = Bank.createEmpty("Test bank", { at: "2026-01-01T00:00:00.000Z" });
    bank.add(question(1));
    const first = Buffer.from(bank.toBytes({ at: "2026-02-03T04:05:06.000Z" }));
    t.mock.timers.tick(5000);
    const second = Buffer.from(bank.toBytes({ at: "2026-02-03T04:05:06.000Z" }));
    assert.deepEqual(second, first);
    // And with no time given the files are stamped with the clock, as before.
    const clockA = Buffer.from(bank.toBytes());
    t.mock.timers.tick(5000);
    const clockB = Buffer.from(bank.toBytes());
    assert.notDeepEqual(clockB, clockA);
  });

  test("refuses to add a question that does not satisfy the model", () => {
    const bank = Bank.createEmpty("Test bank");
    const broken = { ...question(1), points: -5 };
    assert.throws(() => bank.add(broken as Question), /does not satisfy the model/);
  });

  test("refuses the same id twice", () => {
    const bank = Bank.createEmpty("Test bank");
    const q = question(1);
    bank.add(q);
    assert.throws(() => bank.add(q), /already holds a question/);
  });

  test("an edit that would break the model changes nothing", () => {
    const bank = Bank.createEmpty("Test bank");
    const q = question(1);
    bank.add(q);
    assert.throws(() => bank.update(q.id, { points: -1 }), /nothing was changed/);
    assert.equal(bank.get(q.id)?.version, 1);
  });

  test("removing a question takes it out of its folder and the index", () => {
    const bank = Bank.createEmpty("Test bank");
    const folder = bank.addFolder("Chapter 1");
    const q = question(1);
    bank.add(q, { folderId: folder.id });
    assert.equal(bank.search("capital").length, 1);

    assert.equal(bank.remove(q.id), true);
    assert.equal(bank.search("capital").length, 0);
    assert.deepEqual(bank.folders.root[0]?.questionIds, []);
    assert.equal(bank.remove(q.id), false);
  });

  test("search matches stems, options, tags and metadata, and narrows as words are added", () => {
    const bank = Bank.createEmpty("Test bank");
    for (let i = 1; i <= 5; i++) bank.add(question(i));

    // Every question says "capital", so that word alone matches all of them.
    assert.equal(bank.search("capital").length, 5);
    // "5" appears only in question 5: the options only count cities 1 to 4.
    assert.equal(bank.search("country 5").length, 1);
    // Tags and metadata are indexed, not only the stem and the options.
    assert.equal(bank.search("unit-1").length > 0, true);
    assert.equal(bank.search("nothinghere").length, 0);
  });

  test("the last word of a search is a prefix, so results narrow as a person types", () => {
    const bank = Bank.createEmpty("Test bank");
    bank.add(question(1));
    assert.equal(bank.search("capi").length, 1);
    assert.equal(bank.search("capitol").length, 0);
  });

  test("a structured query filters without free text", () => {
    const bank = Bank.createEmpty("Test bank");
    for (let i = 1; i <= 6; i++) bank.add(question(i));
    assert.equal(bank.list({ chapter: ["1"] }).length, 2);
    assert.equal(bank.list({ statuses: ["approved"] }).length, 0);
    assert.equal(bank.list({ types: ["multipleChoice"] }).length, 6);
  });

  test("stats count types, statuses and findings", () => {
    const bank = Bank.createEmpty("Test bank");
    bank.add(question(1));
    bank.add(
      question(2, {
        findings: [{ code: "x", severity: "error" as const, message: "broken" }],
      }),
    );
    const stats = bank.stats();
    assert.equal(stats.questions, 2);
    assert.equal(stats.byType["multipleChoice"], 2);
    assert.equal(stats.withErrors, 1);
  });

  test("a file from a newer format version is refused rather than opened optimistically", () => {
    const bank = Bank.createEmpty("Test bank");
    bank.add(question(1));
    const bytes = bank.toBytes();

    const files = unzipSync(bytes);
    const manifest = JSON.parse(Buffer.from(files.get("manifest.json")!).toString("utf8")) as Record<string, unknown>;
    manifest["formatVersion"] = BANK_FORMAT_VERSION + 1;
    const tampered = zipSync(
      [...files].map(([name, data]) =>
        name === "manifest.json"
          ? textEntry(name, JSON.stringify(manifest))
          : { name, data },
      ),
    );

    assert.throws(() => Bank.fromBytes(tampered), FutureFormatError);
  });

  test("a question file the engine cannot read is reported and kept, not dropped", () => {
    const bank = Bank.createEmpty("Test bank");
    bank.add(question(1));
    const files = unzipSync(bank.toBytes());
    const entries = [...files].map(([name, data]) => ({ name, data }));
    entries.push(textEntry("questions/q_BROKEN.json", '{"id":"q_BROKEN","oops":true}'));

    const { bank: reopened, report } = Bank.fromBytes(zipSync(entries));
    assert.equal(report.invalid.length, 1);
    assert.equal(report.invalid[0]?.id, "q_BROKEN");
    // Still present in the file after a save, because it is the author's work.
    const again = unzipSync(reopened.toBytes());
    assert.ok(again.has("questions/q_BROKEN.json"));
  });

  test("a file the engine does not recognise survives a round trip", () => {
    const bank = Bank.createEmpty("Test bank");
    const entries = [...unzipSync(bank.toBytes())].map(([name, data]) => ({ name, data }));
    entries.push(textEntry("notes/scratch.txt", "something a later version added"));

    const { bank: reopened, report } = Bank.fromBytes(zipSync(entries));
    assert.deepEqual(report.unknownFiles, ["notes/scratch.txt"]);
    const again = unzipSync(reopened.toBytes());
    assert.equal(Buffer.from(again.get("notes/scratch.txt")!).toString("utf8"), "something a later version added");
  });

  test("saves and opens from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openassess-test-"));
    try {
      const path = join(dir, `course${BANK_EXTENSION}`);
      const bank = Bank.createEmpty("Course bank");
      bank.add(question(1));
      await bank.save(path);

      const { bank: reopened } = await Bank.open(path);
      assert.equal(reopened.questions.size, 1);
      assert.equal(reopened.manifest.title, "Course bank");
      assert.equal(reopened.path, path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the performance budget", () => {
  test("a 500-question bank saves, opens and searches inside two seconds each", () => {
    const bank = Bank.createEmpty("Large bank");
    for (let i = 1; i <= 500; i++) bank.add(question(i));

    const savedAt = performance.now();
    const bytes = bank.toBytes();
    const saveMs = performance.now() - savedAt;

    const openedAt = performance.now();
    const { bank: reopened } = Bank.fromBytes(bytes);
    const openMs = performance.now() - openedAt;

    const searchedAt = performance.now();
    const hits = reopened.search("country 250");
    const searchMs = performance.now() - searchedAt;

    assert.equal(reopened.questions.size, 500);
    assert.equal(hits.length, 1);
    assert.ok(saveMs < 2000, `save took ${saveMs.toFixed(0)} ms`);
    assert.ok(openMs < 2000, `open took ${openMs.toFixed(0)} ms`);
    assert.ok(searchMs < 2000, `search took ${searchMs.toFixed(0)} ms`);
  });
});
