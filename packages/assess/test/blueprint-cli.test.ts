/**
 * `openassess blueprint`, run as a person would run it. The drawing is held in `blueprint.test.ts`; what is held here is the command:
 * how a rule is written and refused, that `draw` says and writes nothing, that `add` and `remove` change the bank and nothing else,
 * and that every refusal is in words and leaves the bank file as it was.
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Bank } from "../src/bank/store.ts";
import { createQuestion } from "../src/model/create.ts";
import { plainToRich } from "../src/model/richtext.ts";

const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, "blueprint", ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

let n = 0;
/** A keyed multiple choice question with its own words, so that no two are alike and every one can be taken. */
const essay = (chapter: string, bloom: string) => {
  n++;
  return createQuestion({
    type: "multipleChoice",
    stem: plainToRich(`Which city is the capital of the country number ${n} in the region called land${n}?`),
    title: `Matter ${n}`,
    body: { shuffle: true, options: [`Alpha${n}`, `Beta${n}`, `Gamma${n}`].map((t, i) => ({ id: `o${i}`, content: plainToRich(t), correct: i === 0 })) } as never,
    metadata: { chapter, bloom, tags: [], status: "draft" } as never,
  });
};

describe("openassess blueprint", () => {
  let dir = "";
  let path = "";
  const digest = () => createHash("sha256").update(readFileSync(path)).digest("hex");

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "openassess-blueprint-"));
    path = join(dir, "recipes.openassess");
    const bank = Bank.createEmpty("Recipes", { at: "2026-01-01T00:00:00.000Z" });
    for (let i = 0; i < 6; i++) bank.add(essay("Chapter 1", i < 2 ? "apply" : "remember"));
    for (let i = 0; i < 2; i++) bank.add(essay("Part 2: Cells", "apply"));
    await bank.save(path);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("says when a bank holds none", () => {
    const r = run(path, "list");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /This bank holds no blueprint\./);
  });

  test("adds a blueprint with rules, keeps it in the bank file, and lists it", async () => {
    const r = run(path, "add", "Quiz", "one", "--rule", "chapter=Chapter 1:3", "--rule", "bloom=apply:2");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Kept the blueprint "Quiz one"/);
    const { bank, report } = await Bank.open(path);
    assert.deepEqual(report.invalid, []);
    assert.deepEqual(bank.listBlueprints().map((b) => [b.name, b.rules]), [["Quiz one", [{ axis: "chapter", value: "Chapter 1", count: 3 }, { axis: "bloom", value: "apply", count: 2 }]]]);
    assert.equal(bank.questions.size, 8, "the questions are as they were");
    const listed = run(path, "list");
    assert.match(listed.out, /^Quiz one {2}\(bp_[0-9A-Z]{26}\)\n {4}3 where chapter is Chapter 1\n {4}2 where bloom is apply/);
  });

  test("a value may hold a colon, because the count is after the last one", () => {
    const r = run(path, "add", "Cells", "--rule", "chapter=Part 2: Cells:2");
    assert.equal(r.code, 0, r.err);
    assert.match(run(path, "list").out, /2 where chapter is Part 2: Cells/);
  });

  test("refuses what it cannot take, in words, and leaves the bank file as it was", () => {
    const before = digest();
    const bad: Array<[string[], RegExp]> = [
      [["add", "Nothing"], /Give at least one rule/],
      [["add", "Bad axis", "--rule", "colour=red:3"], /"colour" is not something a rule can be by\. Choose from objective, chapter/],
      [["add", "Blank", "--rule", "chapter=:3"], /has no value\. A blank value would match every question/],
      [["add", "Spaces", "--rule", "chapter=   :3"], /has no value/],
      [["add", "No count", "--rule", "chapter=Chapter 1"], /is not a rule\. Write it as axis=value:count/],
      [["add", "No count either", "--rule", "chapter=Chapter 1:"], /has no number of questions/],
      [["add", "Words for a count", "--rule", "chapter=Chapter 1:many"], /has no number of questions/],
      [["add", "Zero", "--rule", "chapter=Chapter 1:0"], /whole number from 1 to 1000/],
      [["add", "Too many", "--rule", "chapter=Chapter 1:1001"], /whole number from 1 to 1000/],
      [["add", "Twice", "--rule", "chapter=Chapter 1:1", "--rule", "chapter=Chapter 1:2"], /same thing/],
      [["add", "QUIZ ONE", "--rule", "chapter=Chapter 1:1"], /already holds a blueprint called "Quiz one"/],
      [["add"], /Say which blueprint to add/],
      [["draw", "Nothing at all"], /holds no blueprint called "Nothing at all"/],
      [["remove", "Nothing at all"], /holds no blueprint called "Nothing at all"/],
      [["shuffle", "Quiz one"], /Unknown action "shuffle"/],
    ];
    for (const [args, message] of bad) {
      const r = run(path, ...args);
      assert.equal(r.code, 2, `${args.join(" ")}: ${r.out}`);
      assert.match(r.err, message, args.join(" "));
    }
    assert.equal(digest(), before, "the file was not touched");
    assert.equal(run(path).code, 2, "no action");
  });

  test("draw shows what each rule takes, says how many it came out short and why, and writes nothing", () => {
    const before = digest();
    run(path, "add", "Big", "--rule", "chapter=Chapter 1:9");
    const kept = digest();
    const r = run(path, "draw", "big", "--seed", "abc");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^Big, seed abc\n/);
    assert.match(r.out, /9 where chapter is Chapter 1:\n( {4}q_[0-9A-Z]{26} {2}Matter \d+\n){6}/, "six questions are in chapter one");
    assert.match(r.out, /6 of 9 questions taken, 3 short\./);
    assert.match(r.out, /chapter Chapter 1: wanted 9, took 6; the bank has no more\./);
    assert.match(r.out, /Nothing was written\./);
    assert.equal(digest(), kept, "drawing wrote nothing");
    assert.notEqual(before, kept, "and adding did");
  });

  test("the same seed draws the same questions, and another seed draws others", () => {
    const a = run(path, "draw", "Quiz one", "--seed", "one").out;
    assert.equal(run(path, "draw", "Quiz one", "--seed", "one").out, a);
    const others = new Set<string>();
    for (const seed of ["two", "three", "four", "five", "six"]) others.add(run(path, "draw", "Quiz one", "--seed", seed).out);
    assert.ok(others.size > 1, "other seeds reach other questions");
  });

  test("a blueprint can be found by its id, and removed, and no question changes", async () => {
    const { bank } = await Bank.open(path);
    const quiz = bank.listBlueprints().find((b) => b.name === "Quiz one");
    assert.ok(quiz);
    assert.equal(run(path, "draw", quiz.id, "--seed", "x").code, 0);
    const questionsBefore = JSON.stringify(bank.sortedQuestions());
    const removed = run(path, "remove", "Quiz one");
    assert.equal(removed.code, 0, removed.err);
    assert.match(removed.out, /Took the blueprint "Quiz one" out of .*No test and no question was changed by it\./);
    const { bank: after } = await Bank.open(path);
    assert.deepEqual(after.listBlueprints().map((b) => b.name).sort(), ["Big", "Cells"]);
    assert.equal(JSON.stringify(after.sortedQuestions()), questionsBefore);
  });
});

describe("openassess blueprint, a rule for several values together", () => {
  let dir = "";
  let path = "";
  const digest = () => createHash("sha256").update(readFileSync(path)).digest("hex");

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "openassess-blueprint-cells-"));
    path = join(dir, "grid.openassess");
    const bank = Bank.createEmpty("Grid", { at: "2026-01-01T00:00:00.000Z" });
    for (let i = 0; i < 6; i++) bank.add(essay("Chapter 1", i < 2 ? "apply" : "remember"));
    for (let i = 0; i < 2; i++) bank.add(essay("Part 2: Cells", "apply"));
    for (let i = 0; i < 3; i++) bank.add(essay("Rock and Roll", "apply"));
    await bank.save(path);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("values joined with and are one rule, kept with the others, and listed in one line", async () => {
    const r = run(path, "add", "Cells", "--rule", "chapter=Chapter 1 and bloom=apply:2", "--rule", "chapter=Chapter 1 and bloom=remember:5", "--rule", "bloom=apply:1");
    assert.equal(r.code, 0, r.err);
    const { bank, report } = await Bank.open(path);
    assert.deepEqual(report.invalid, []);
    assert.deepEqual(bank.listBlueprints()[0]?.rules, [
      { axis: "chapter", value: "Chapter 1", count: 2, and: [{ axis: "bloom", value: "apply" }] },
      { axis: "chapter", value: "Chapter 1", count: 5, and: [{ axis: "bloom", value: "remember" }] },
      { axis: "bloom", value: "apply", count: 1 },
    ]);
    assert.match(run(path, "list").out, / {4}2 where chapter is Chapter 1 and bloom is apply\n {4}5 where chapter is Chapter 1 and bloom is remember\n {4}1 where bloom is apply\n/);
  });

  test("draw takes each cell from its own and says which cell came out short", () => {
    const before = digest();
    const r = run(path, "draw", "cells", "--seed", "abc");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /\n2 where chapter is Chapter 1 and bloom is apply:\n( {4}q_[0-9A-Z]{26} {2}Matter \d+\n){2}/, "the two at the apply level in chapter one");
    assert.match(r.out, /\n5 where chapter is Chapter 1 and bloom is remember:\n( {4}q_[0-9A-Z]{26} {2}Matter \d+\n){4}\n/, "four at the remember level, and no more in chapter one");
    assert.match(r.out, /chapter Chapter 1 and bloom remember: wanted 5, took 4; the bank has no more\./);
    assert.match(r.out, /7 of 8 questions taken, 1 short\./, "two, four and one: the third rule is a plain one and takes from any chapter");
    assert.equal(digest(), before, "drawing wrote nothing");
  });

  test("the word and inside a value is part of the value, and splits only where an axis name and an equals sign follow", async () => {
    const r = run(path, "add", "Rock", "--rule", "chapter=Rock and Roll:2", "--rule", "chapter=Rock and Roll and bloom=apply:1");
    assert.equal(r.code, 0, r.err);
    const { bank } = await Bank.open(path);
    assert.deepEqual(bank.listBlueprints().find((b) => b.name === "Rock")?.rules, [
      { axis: "chapter", value: "Rock and Roll", count: 2 },
      { axis: "chapter", value: "Rock and Roll", count: 1, and: [{ axis: "bloom", value: "apply" }] },
    ]);
  });

  test("a set that could never be met, a blank, a mistyped axis and a missing count are refused in words and the file is not touched", () => {
    const before = digest();
    const bad: Array<[string[], RegExp]> = [
      [["add", "Two chapters", "--rule", "chapter=Chapter 1 and chapter=Part 2: Cells:1"], /one chapter.*could never take a question/],
      [["add", "Blank", "--rule", "chapter=Chapter 1 and bloom=:2"], /has no value\..*value for bloom/],
      [["add", "Mistyped", "--rule", "chapter=Chapter 1 and colour=red:2"], /"colour" is not something a rule can be by/],
      [["add", "Twice", "--rule", "chapter=Chapter 1 and bloom=apply:2", "--rule", "bloom=apply and chapter=Chapter 1:1"], /same thing/],
      [["add", "No count", "--rule", "chapter=Chapter 1 and bloom=apply"], /is not a rule\.|has no number of questions/],
      [["add", "Six values", "--rule", "tag=a and tag=b and tag=c and tag=d and tag=e and tag=f:1"], /list of 1 to 4/],
    ];
    for (const [args, message] of bad) {
      const r = run(path, ...args);
      assert.equal(r.code, 2, `${args.join(" ")}: ${r.out}`);
      assert.match(r.err, message, args.join(" "));
    }
    assert.equal(digest(), before, "nothing was kept");
  });
});
