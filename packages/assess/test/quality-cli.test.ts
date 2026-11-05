/**
 * `openassess check`, run as a person would run it: a bank with some questions that have notes in it, and what the command prints.
 * The command looks and says; it writes only when it is told to, and when it writes it writes notes and nothing else.
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Bank } from "../src/bank/store.ts";
import { createQuestion } from "../src/model/create.ts";
import { plainToRich } from "../src/model/richtext.ts";

const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, "check", ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

// Brought in by an import, so that no notes were made when it went into the bank: a question written in the app has them from the
// start, and this is about what the command does for one that does not.
const choice = (stem: string, options: string[]) =>
  createQuestion({ type: "multipleChoice", origin: { kind: "import" }, stem: plainToRich(stem), title: stem.slice(0, 30), body: { shuffle: true, options: options.map((text, i) => ({ id: `o${i}`, content: plainToRich(text.replace(/\*$/, "")), correct: text.endsWith("*") })) } as never });

describe("openassess check", () => {
  let dir = "";
  let path = "";
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "openassess-check-"));
    path = join(dir, "notes.openassess");
    const bank = Bank.createEmpty("Notes", { at: "2026-01-01T00:00:00.000Z" });
    bank.add(choice("Which is not a fruit?", ["Apple", "Carrot*", "All of the above"]));
    bank.add(choice("What is the capital of France?", ["Paris*", "Rome"]));
    bank.add(choice("What is the capital of France?", ["Paris*", "Rome"]));
    await bank.save(path);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("prints the notes on each question, the copies, and says nothing was written", () => {
    const r = run(path);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^Checked 3 question\(s\)\. 1 have notes \(2 in all\)\./);
    assert.match(r.out, /Option C, "All of the above", only makes sense beside the other options/);
    assert.match(r.out, /The stem asks for the opposite of what is usual \("not"\)/);
    assert.match(r.out, /The same question more than once:\n {4}Two questions are the same, with the same wording and the same answers/);
    assert.match(r.out, /Nothing was written\. Add --save/);
  });

  test("changes nothing in the file without --save", async () => {
    const { bank } = await Bank.open(path);
    assert.ok(bank.sortedQuestions().every((q) => q.findings.length === 0));
    assert.equal(bank.history.some((h) => h.change.startsWith("checked")), false);
  });

  test("writes the notes with --save, and only the notes", async () => {
    const before = (await Bank.open(path)).bank.sortedQuestions().map((q) => ({ id: q.id, version: q.version, history: q.history, status: q.metadata.status }));
    const r = run(path, "--save");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /The notes were written to /);
    const { bank } = await Bank.open(path);
    const after = bank.sortedQuestions();
    assert.deepEqual(after.map((q) => ({ id: q.id, version: q.version, history: q.history, status: q.metadata.status })), before);
    assert.equal(after.filter((q) => q.findings.length > 0).length, 1);
    assert.ok(bank.history.some((h) => h.change.startsWith("checked the questions for quality")));
  });

  test("a bank with nothing to note says so, and a missing bank is refused", () => {
    const quiet = join(dir, "quiet.openassess");
    const bank = Bank.createEmpty("Quiet");
    bank.add(choice("Which is a fruit?", ["Apple*", "Carrot"]));
    return bank.save(quiet).then(() => {
      const r = run(quiet);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /Checked 1 question\(s\)\. 0 have notes \(0 in all\)\.\nNothing to note\./);
      const none = run();
      assert.equal(none.code, 2);
      assert.match(none.err, /Name a bank file/);
      assert.equal(readFileSync(quiet).length > 0, true);
    });
  });
});
