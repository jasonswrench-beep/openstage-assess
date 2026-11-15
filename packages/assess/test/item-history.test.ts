/**
 * Item history: the class figures a bank keeps, read back across classes for each question, with the change in difficulty and notes
 * on the questions worth another look. The notes are worked out each time, use only classes that saw the question as it is now, say
 * nothing under 30 attempts, and change nothing about a question.
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Bank } from "../src/bank/store.ts";
import { itemHistory, TOO_EASY, WEAK_DISCRIMINATION } from "../src/bank/item-history.ts";
import { createQuestion } from "../src/model/create.ts";
import { newAdministrationId } from "../src/model/ids.ts";
import { plainToRich } from "../src/model/richtext.ts";
import type { Question } from "../src/model/question.ts";
import type { Administration } from "../src/model/statistics.ts";
import { createTest } from "../src/model/test.ts";

let made = 0;
const mc = (stem: string, at = "2026-01-05T00:00:00.000Z"): Question =>
  createQuestion({ type: "multipleChoice", stem: plainToRich(stem), body: { shuffle: false, options: [0, 1, 2, 3].map((i) => ({ id: `o${i}`, content: plainToRich(`Answer ${i}`), correct: i === 0 })) }, by: "t", at, id: `q_${String(++made).padStart(26, "0")}` });

/** A question edited on a day: version 2 from then on. */
const edited = (q: Question, day: string): Question => ({ ...q, version: 2, history: [...q.history, { at: `${day}T12:00:00.000Z`, by: "t", change: "edited", fromVersion: 1, toVersion: 2 }] });

const TEST_ID = `t_${"5".padStart(26, "0")}`;
function run(date: string, items: Array<{ q: Question; sheets: number; difficulty?: number; pointBiserial?: number; chosen?: number[] }>, testId = TEST_ID): Administration {
  const sheets = Math.max(...items.map((i) => i.sheets));
  return {
    recordVersion: 1,
    id: newAdministrationId(),
    testId,
    testName: `Test of ${date}`,
    date,
    sheets,
    unstable: sheets < 30,
    items: items.map((i) => ({
      questionId: i.q.id,
      sheets: i.sheets,
      ...(i.difficulty !== undefined ? { difficulty: i.difficulty } : {}),
      ...(i.pointBiserial !== undefined ? { pointBiserial: i.pointBiserial } : {}),
      options: (i.chosen ?? [i.sheets, 0, 0, 0]).map((c, k) => ({ answer: `o${k}`, chosen: c })),
      blanks: 0,
    })),
  };
}
const none = () => undefined;
const codes = (h: ReturnType<typeof itemHistory>, q: Question): string[] => (h.get(q.id)?.notes ?? []).map((n) => n.code);

describe("item history", () => {
  test("lists every class in date order, with the change in difficulty from the first to the last", () => {
    const q = mc("Q1");
    const h = itemHistory([q], [run("2026-05-01", [{ q, sheets: 40, difficulty: 0.6, pointBiserial: 0.4, chosen: [24, 6, 5, 5] }]), run("2026-01-10", [{ q, sheets: 35, difficulty: 0.5, pointBiserial: 0.35, chosen: [18, 7, 5, 5] }])], none).get(q.id)!;
    assert.deepEqual(h.runs.map((r) => [r.date, r.difficulty, r.current]), [["2026-01-10", 0.5, true], ["2026-05-01", 0.6, true]]);
    assert.deepEqual(h.trend, { from: 0.5, to: 0.6, change: 0.1, fromDate: "2026-01-10", toDate: "2026-05-01" });
    assert.deepEqual(h.pooled, { classes: 2, sheets: 75, difficulty: 0.5533, pointBiserial: 0.3767 });
    assert.deepEqual(h.notes, [], "a question doing its job gets no note");
  });

  test("a question that runs the wrong way, or only a little, is noted, and the note asks for a look and changes nothing", () => {
    const wrong = mc("Wrong way");
    const weak = mc("Weak");
    const copyBefore = JSON.stringify(wrong);
    const h = itemHistory([wrong, weak], [run("2026-03-01", [{ q: wrong, sheets: 40, difficulty: 0.5, pointBiserial: -0.2, chosen: [20, 10, 5, 5] }, { q: weak, sheets: 40, difficulty: 0.5, pointBiserial: WEAK_DISCRIMINATION - 0.05, chosen: [20, 10, 5, 5] }])], none);
    assert.deepEqual(codes(h, wrong), ["history.wrong-way"]);
    assert.match(h.get(wrong.id)!.notes[0]!.message, /Check that the key is right/);
    assert.deepEqual(codes(h, weak), ["history.weak"]);
    assert.equal(JSON.stringify(wrong), copyBefore, "the question is not touched");
  });

  test("says nothing on fewer than 30 attempts, however bad the figures look", () => {
    const q = mc("Small class");
    const h = itemHistory([q], [run("2026-03-01", [{ q, sheets: 12, difficulty: 0.1, pointBiserial: -0.5, chosen: [1, 11, 0, 0] }])], none);
    assert.deepEqual(h.get(q.id)?.notes, []);
    const two = itemHistory([q], [run("2026-03-01", [{ q, sheets: 15, difficulty: 0.1, pointBiserial: -0.5, chosen: [2, 13, 0, 0] }]), run("2026-04-01", [{ q, sheets: 15, difficulty: 0.1, pointBiserial: -0.5, chosen: [2, 13, 0, 0] }])], none);
    assert.ok(codes(two, q).includes("history.wrong-way"), "two small classes of the same wording add up to 30");
  });

  test("uses only classes that saw the question as it is now: one edited since has its old figures shown and noted on nothing", () => {
    const q = edited(mc("Edited"), "2026-04-15");
    const h = itemHistory([q], [run("2026-03-01", [{ q, sheets: 40, difficulty: 0.1, pointBiserial: -0.3, chosen: [4, 36, 0, 0] }])], none).get(q.id)!;
    assert.equal(h.runs[0]?.current, false);
    assert.equal(h.runs[0]?.version, 1);
    assert.deepEqual(h.notes, []);
    assert.equal(h.pooled, undefined);
    const after = itemHistory([q], [run("2026-03-01", [{ q, sheets: 40, difficulty: 0.1, pointBiserial: -0.3 }]), run("2026-05-01", [{ q, sheets: 40, difficulty: 0.97, pointBiserial: 0.2, chosen: [39, 1, 0, 0] }])], none).get(q.id)!;
    assert.deepEqual(after.runs.map((r) => r.current), [false, true]);
    assert.deepEqual(after.notes.map((n) => n.code).sort(), ["history.too-easy", "history.unchosen"], "from the class after the change alone");
  });

  test("a class from before the question was made in this bank saw the wording it started with", () => {
    const q = mc("Imported later", "2026-11-01T00:00:00.000Z");
    const h = itemHistory([q], [run("2026-09-01", [{ q, sheets: 40, difficulty: 0.98, pointBiserial: 0.1, chosen: [39, 1, 0, 0] }])], none).get(q.id)!;
    assert.equal(h.runs[0]?.current, true);
  });

  test("takes the version a class saw from the test's own copy when the bank still holds the test", () => {
    const q1 = mc("Copied");
    const record = createTest({ id: TEST_ID, name: "Midterm", questions: [q1], versions: 1, seed: "s", at: "2026-02-01T00:00:00.000Z" });
    const now = edited(q1, "2026-01-01"); // a history that says version 2 was in force, and a test copy that says 1
    const h = itemHistory([now], [run("2026-03-01", [{ q: now, sheets: 40, difficulty: 0.5, pointBiserial: 0.3 }])], (id) => (id === TEST_ID ? record : undefined)).get(now.id)!;
    assert.equal(h.runs[0]?.version, 1);
    assert.equal(h.runs[0]?.current, false);
  });

  test("notes a wrong answer nobody chose, too easy and too hard, and a change in difficulty with the same wording", () => {
    const easy = mc("Easy");
    const hard = mc("Hard");
    const drift = mc("Drift");
    const h = itemHistory(
      [easy, hard, drift],
      [
        run("2026-01-10", [{ q: easy, sheets: 40, difficulty: TOO_EASY, pointBiserial: 0.2, chosen: [38, 2, 0, 0] }, { q: hard, sheets: 40, difficulty: 0.2, pointBiserial: 0.3, chosen: [8, 12, 10, 10] }, { q: drift, sheets: 40, difficulty: 0.4, pointBiserial: 0.3, chosen: [16, 12, 6, 6] }]),
        run("2026-05-10", [{ q: drift, sheets: 40, difficulty: 0.75, pointBiserial: 0.3, chosen: [30, 4, 3, 3] }]),
      ],
      none,
    );
    assert.deepEqual(codes(h, easy).sort(), ["history.too-easy", "history.unchosen"]);
    assert.match(h.get(easy.id)!.notes.find((n) => n.code === "history.unchosen")!.message, /Nobody chose answers C, D in 40 attempts/);
    assert.deepEqual(codes(h, hard), ["history.too-hard"]);
    assert.deepEqual(codes(h, drift), ["history.drift"]);
    assert.match(h.get(drift.id)!.notes[0]!.message, /got easier between 2026-01-10 \(40 percent right\) and 2026-05-10 \(75 percent\).*known to students/);
  });

  test("a question with no key gets no note about unchosen answers, since which are wrong is not known", () => {
    const q = createQuestion({ type: "multipleChoice", stem: plainToRich("No key"), body: { shuffle: false, options: [0, 1, 2].map((i) => ({ id: `o${i}`, content: plainToRich(`A${i}`), correct: false })) }, by: "t", at: "2026-01-01T00:00:00.000Z", id: `q_${String(++made).padStart(26, "0")}` });
    const h = itemHistory([q], [run("2026-03-01", [{ q, sheets: 40, difficulty: 0.5, pointBiserial: 0.3, chosen: [20, 20, 0] }])], none);
    assert.ok(!codes(h, q).includes("history.unchosen"));
  });
});

describe("openassess history", () => {
  let dir = "";
  const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
  const runCli = (...args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, "history", ...args], { encoding: "utf8" });
  const good = mc("A good question about something");
  const bad = mc("A question that runs the wrong way");
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "openassess-history-"));
    const bank = Bank.createEmpty("History", { at: "2026-01-01T00:00:00.000Z" });
    bank.add(good);
    bank.add(bad);
    await bank.save(join(dir, "empty.openassess"));
    bank.addAdministration(run("2026-03-01", [{ q: good, sheets: 40, difficulty: 0.6, pointBiserial: 0.4, chosen: [24, 6, 5, 5] }, { q: bad, sheets: 40, difficulty: 0.5, pointBiserial: -0.2, chosen: [20, 10, 5, 5] }]));
    await bank.save(join(dir, "h.openassess"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("lists each question's classes and its notes, and with --to-revise only those with a note", () => {
    const all = runCli(join(dir, "h.openassess"));
    assert.equal(all.status, 0, all.stderr);
    assert.match(all.stdout, /1 class kept; 2 questions have figures, 1 with something worth a look\./);
    assert.match(all.stdout, /2026-03-01 {2}Test of 2026-03-01 +40 attempts {2}difficulty 0\.6/);
    const some = runCli(join(dir, "h.openassess"), "--to-revise");
    assert.match(some.stdout, /runs the wrong way|did worse on this question/);
    assert.doesNotMatch(some.stdout, /A good question/);
    const json = JSON.parse(runCli(join(dir, "h.openassess"), "--json").stdout);
    assert.equal(json.length, 2);
  });

  test("says so when the bank keeps no class figures", () => {
    const r = runCli(join(dir, "empty.openassess"));
    assert.equal(r.status, 0);
    assert.match(r.stdout, /keeps no class figures yet/);
  });
});
