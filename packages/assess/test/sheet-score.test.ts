/**
 * Scoring sheets from settled answers, the test record's key and the adjustments; settling readings with a person's decisions; and the item
 * statistics, checked against figures worked out by hand.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { createQuestion } from "../src/model/create.ts";
import { plainToRich } from "../src/model/richtext.ts";
import type { Question } from "../src/model/question.ts";
import { versionQuestions, type TestRecord } from "../src/model/test.ts";
import { assembleBatch, type BatchEntry } from "../src/sheets/batch.ts";
import { imageFingerprint, type GreyImage } from "../src/sheets/image.ts";
import { SheetReader } from "../src/sheets/read.ts";
import { adjustmentEffect, adjustmentWords, scoreSheets, settleSheets, type Adjustment, type SettledAnswer, type SettledSheet } from "../src/sheets/score.ts";
import { SMALL_GROUP, itemStatistics } from "../src/sheets/stats.ts";
import { drawn, essayq, mcq, tfq, testOf } from "./support/sheet-fixtures.ts";

const AT = "2026-01-01T00:00:00.000Z";
let made = 9000;
const opt = (id: string, correct: boolean) => ({ id, content: plainToRich(id), correct });
const make = (type: "multipleChoice" | "multipleResponse", options: Array<[string, boolean]>, more: { points?: number; partial?: boolean } = {}): Question =>
  createQuestion({
    type,
    stem: plainToRich("A question"),
    body: type === "multipleChoice" ? { shuffle: true, options: options.map(([id, c]) => opt(id, c)) } : { shuffle: true, partialCredit: more.partial ?? false, options: options.map(([id, c]) => opt(id, c)) },
    points: more.points,
    by: "t",
    at: AT,
    id: `q_${String(++made).padStart(26, "0")}`,
  });

/** A settled sheet from places: `[1]` is B, `"blank"` is left empty, `"?"` is not yet decided. */
const settled = (number: number, version: number | undefined, answers: Record<number, number[] | "blank" | "?">, problems: string[] = []): SettledSheet => ({
  number,
  ...(version !== undefined ? { version } : {}),
  answers: Object.fromEntries(Object.entries(answers).map(([q, a]) => [q, (a === "blank" ? { kind: "blank", by: "reader" } : a === "?" ? { kind: "unsettled", why: "not sure" } : { kind: "marked", places: a, by: "reader" }) as SettledAnswer])),
  problems,
});

describe("scoring one sheet", () => {
  // 1: choice, right is B. 2: true or false, true. 3: several, A and B, all or nothing. 4: several, A and B, partial, 3 points. 5: an essay. 6: no key. 7: choice worth 2, right is D.
  const q1 = make("multipleChoice", [["a1", false], ["b1", true], ["c1", false], ["d1", false]]);
  const q3 = make("multipleResponse", [["a3", true], ["b3", true], ["c3", false], ["d3", false]]);
  const q4 = make("multipleResponse", [["a4", true], ["b4", true], ["c4", false], ["d4", false]], { points: 3, partial: true });
  const q6 = make("multipleChoice", [["a6", false], ["b6", false], ["c6", false]]);
  const q7 = make("multipleChoice", [["a7", false], ["b7", false], ["c7", false], ["d7", true]], { points: 2 });
  const record = testOf([q1, tfq(), q3, q4, essayq(), q6, q7], { versions: 1 });

  test("gives a point for each right answer, and nothing for a wrong one, a blank one, or one not yet settled", () => {
    const [s] = scoreSheets(record, [settled(1, 1, { 1: [1], 2: [0], 3: [0, 1], 4: [0, 1], 7: [3] })]);
    assert.deepEqual(s?.questions.map((q) => [q.number, q.outcome, q.earned, q.possible]), [
      [1, "right", 1, 1],
      [2, "right", 1, 1],
      [3, "right", 1, 1],
      [4, "right", 3, 3],
      [5, "notOnSheet", 0, 0],
      [6, "notScored", 0, 0],
      [7, "right", 2, 2],
    ]);
    assert.equal(s?.earned, 8);
    assert.equal(s?.possible, 8);
    assert.equal(s?.percent, 100);
    assert.equal(s?.complete, true);
    const [t] = scoreSheets(record, [settled(2, 1, { 1: [0], 2: [1], 3: "blank", 4: "?", 7: [3] })]);
    assert.deepEqual(t?.questions.filter((q) => q.number !== 5 && q.number !== 6).map((q) => [q.number, q.outcome, q.earned]), [[1, "wrong", 0], [2, "wrong", 0], [3, "blank", 0], [4, "unsettled", 0], [7, "right", 2]]);
    assert.equal(t?.earned, 2);
    assert.equal(t?.possible, 8, "a question not yet settled is in what the sheet could earn");
    assert.equal(t?.percent, 25);
    assert.equal(t?.unsettled, 1);
    assert.equal(t?.settled, 4);
    assert.equal(t?.complete, false);
    assert.equal(t?.questions.find((q) => q.number === 4)?.why, "not sure");
  });

  test("does not give a question with one answer to a sheet that marked the right one among others", () => {
    const rows = scoreSheets(record, [settled(1, 1, { 1: [1, 2] }), settled(2, 1, { 1: [0, 1] }), settled(3, 1, { 1: [1] })]);
    assert.deepEqual(rows.map((r) => r.questions[0]?.outcome), ["wrong", "wrong", "right"]);
  });

  test("scores a true or false question by its key, with true in the first place and false in the second", () => {
    const rows = scoreSheets(record, [settled(1, 1, { 2: [0] }), settled(2, 1, { 2: [1] })]);
    assert.deepEqual(rows.map((r) => r.questions[1]?.outcome), ["right", "wrong"]);
    assert.deepEqual(rows.map((r) => r.questions[1]?.marked), [["true"], ["false"]]);
  });

  test("gives a question with several answers all or nothing, unless it is set to give partial credit", () => {
    const outcome = (places: number[]) => scoreSheets(record, [settled(1, 1, { 3: places })])[0]?.questions[2];
    assert.equal(outcome([0, 1])?.outcome, "right");
    assert.equal(outcome([0])?.outcome, "wrong", "one of two is not enough");
    assert.equal(outcome([0, 1, 2])?.outcome, "wrong", "a wrong one spoils it");
    assert.equal(outcome([0])?.earned, 0);
    assert.equal(outcome([])?.outcome, "wrong");
  });

  test("gives partial credit as right minus wrong, as a share of the right ones, and never below nothing", () => {
    const outcome = (places: number[]) => scoreSheets(record, [settled(1, 1, { 4: places })])[0]?.questions[3];
    assert.deepEqual([outcome([0, 1])?.outcome, outcome([0, 1])?.earned], ["right", 3]);
    assert.deepEqual([outcome([0])?.outcome, outcome([0])?.earned], ["partial", 1.5]);
    assert.deepEqual([outcome([0, 1, 2])?.outcome, outcome([0, 1, 2])?.earned], ["partial", 1.5], "two right and one wrong is a share of half");
    assert.deepEqual([outcome([0, 2])?.outcome, outcome([0, 2])?.earned], ["wrong", 0], "one right and one wrong is nothing");
    assert.deepEqual([outcome([2, 3])?.outcome, outcome([2, 3])?.earned], ["wrong", 0], "never below nothing");
  });

  test("does not score a question with no usable key, and says so, and does not count it in what the sheet could earn", () => {
    const six = scoreSheets(record, [settled(1, 1, { 6: [0] })])[0]?.questions[5];
    assert.equal(six?.outcome, "notScored");
    assert.match(six?.why as string, /no usable answer key, so it is not scored/);
    assert.equal(six?.possible, 0);
  });

  test("takes points from each question, with a question set to 0 counting for nothing", () => {
    const zero = make("multipleChoice", [["a8", true], ["b8", false]], { points: 0 });
    const r = testOf([q1, zero], { versions: 1 });
    const [s] = scoreSheets(r, [settled(1, 1, { 1: [1], 2: [0] })]);
    assert.deepEqual([s?.earned, s?.possible], [1, 1]);
    assert.equal(s?.questions[1]?.outcome, "right");
  });

  test("has no percentage when nothing counts, and leaves a sheet with no version unscored with the reason", () => {
    const onlyEssay = testOf([essayq()], { versions: 1 });
    const [a] = scoreSheets(onlyEssay, [settled(1, 1, {})]);
    assert.equal(a?.possible, 0);
    assert.equal(a?.percent, undefined);
    const [b] = scoreSheets(record, [settled(2, undefined, { 1: [1] })]);
    assert.equal(b?.complete, false);
    assert.deepEqual(b?.questions, []);
    assert.deepEqual(b?.problems, ["Its version is not settled."]);
    const [c] = scoreSheets(record, [settled(3, 3, { 1: [1] })]);
    assert.equal(c?.complete, false, "a version the test does not have");
    const [d] = scoreSheets(record, [settled(4, 1, { 1: [1], 2: [0], 3: [0, 1], 4: [0, 1], 7: [3] }, ["Page 2 did not come."])]);
    assert.equal(d?.complete, false, "a sheet with a page missing is not complete however its questions are");
  });
});

describe("scoring the versions of a test through their own answer order", () => {
  const q = make("multipleChoice", [["w", false], ["x", true], ["y", false], ["z", false]]);
  const record = testOf([q, make("multipleChoice", [["p", true], ["q", false], ["r", false]])], { versions: 3, questionOrder: "shuffled", seed: "versions" });

  test("takes a letter on any version back to the bank's own answer", () => {
    for (let v = 1; v <= 3; v++) {
      const label = (["A", "B", "C"] as const)[v - 1] as "A" | "B" | "C";
      const order = record.versions[v - 1] as (typeof record.versions)[number];
      const list = versionQuestions(record, label);
      list.forEach((question, i) => {
        // the place of the right answer on this version, from the stored order and not from the scorer
        const keyId = question.id === q.id ? "x" : "p";
        const place = (order.options[question.id] as string[]).indexOf(keyId);
        const wrongPlace = place === 0 ? 1 : 0;
        const [good] = scoreSheets(record, [settled(1, v, { [i + 1]: [place] })]);
        const [bad] = scoreSheets(record, [settled(2, v, { [i + 1]: [wrongPlace] })]);
        assert.equal(good?.questions[i]?.outcome, "right", `version ${label}, question ${i + 1}`);
        assert.equal(bad?.questions[i]?.outcome, "wrong", `version ${label}, question ${i + 1}`);
        assert.deepEqual(good?.questions[i]?.marked, [keyId]);
      });
    }
    const orders = [0, 1, 2].map((v) => (record.versions[v] as { options: Record<string, string[]> }).options[q.id]?.join(""));
    assert.ok(new Set(orders).size > 1, "the versions really do put the answers in different orders");
  });
});

describe("adjusting the scoring", () => {
  const a = make("multipleChoice", [["a", true], ["b", false], ["c", false]]);
  const b = make("multipleChoice", [["a", false], ["b", true], ["c", false]], { points: 2 });
  const t = tfq();
  const m = make("multipleResponse", [["a", true], ["b", true], ["c", false]]);
  const record = testOf([a, b, t, m], { versions: 1 });
  const sheets = [settled(1, 1, { 1: [0], 2: [1], 3: [0], 4: [0, 1] }), settled(2, 1, { 1: [1], 2: [2], 3: [1], 4: [0, 2] }), settled(3, 1, { 1: "blank", 2: "?", 3: [0], 4: [0, 1] })];
  const at = (id: string, kind: Adjustment["kind"], rest: object = {}): Adjustment => ({ id, kind, questionId: a.id, ...rest }) as Adjustment;

  test("drops a question from the total, and the sheets are scored out of what is left", () => {
    const rows = scoreSheets(record, sheets, [at("x", "drop")]);
    assert.deepEqual(rows.map((r) => [r.earned, r.possible]), [[4, 4], [0, 4], [2, 4]]);
    assert.equal(rows[0]?.questions[0]?.outcome, "dropped");
    assert.equal(rows[0]?.questions[0]?.possible, 0);
  });

  test("counts another answer as right as well, for a choice, a true or false and a question with several answers", () => {
    const b2 = at("y", "alsoRight", { questionId: b.id, answer: "c" });
    assert.equal(scoreSheets(record, sheets, [b2])[1]?.questions[1]?.outcome, "right");
    const tf = at("z", "alsoRight", { questionId: t.id, answer: "false" });
    assert.deepEqual(scoreSheets(record, sheets, [tf]).map((r) => r.questions[2]?.outcome), ["right", "right", "right"]);
    const mr = at("w", "alsoRight", { questionId: m.id, answer: "c" });
    assert.equal(scoreSheets(record, sheets, [mr])[1]?.questions[3]?.outcome, "wrong", "A and C is not all of A, B and C");
    assert.equal(scoreSheets(record, sheets, [mr])[0]?.questions[3]?.outcome, "wrong", "A and B is not all of A, B and C either");
    assert.equal(scoreSheets(record, [settled(9, 1, { 4: [0, 1, 2] })], [mr])[0]?.questions[3]?.outcome, "right");
  });

  test("gives everyone credit for a question, whatever they marked and even where nothing was", () => {
    const rows = scoreSheets(record, sheets, [at("c", "credit")]);
    assert.deepEqual(rows.map((r) => [r.questions[0]?.outcome, r.questions[0]?.earned]), [["credited", 1], ["credited", 1], ["credited", 1]]);
    assert.equal(rows[2]?.unsettled, 1, "only the question that is not credited is still undecided");
  });

  test("changes the points of a question, the last change winning, and a question's own points still apply to the rest", () => {
    const rows = scoreSheets(record, sheets, [at("p1", "points", { questionId: b.id, points: 5 }), at("p2", "points", { questionId: b.id, points: 4 })]);
    assert.deepEqual([rows[0]?.questions[1]?.earned, rows[0]?.questions[1]?.possible], [4, 4]);
    assert.equal(rows[0]?.questions[0]?.possible, 1);
  });

  test("applies an adjustment to the versions it names and to no others", () => {
    const two = testOf([a, b], { versions: 2 });
    const rows = scoreSheets(two, [settled(1, 1, { 1: "blank" }), settled(2, 2, { 1: "blank" })], [{ id: "v", kind: "drop", questionId: a.id, versions: [2] }]);
    assert.equal(rows[0]?.questions.find((q) => q.questionId === a.id)?.outcome, "blank");
    assert.equal(rows[1]?.questions.find((q) => q.questionId === a.id)?.outcome, "dropped");
  });

  test("says how many sheets an adjustment would change before it is applied, and which, and by how much", () => {
    const drop = adjustmentEffect(record, sheets, [], at("d", "drop"));
    assert.equal(drop.sheets, 3);
    assert.equal(drop.changed.length, 3, "all three are scored out of less");
    assert.deepEqual(drop.changed.map((c) => [c.sheet, c.from, c.to]), [[1, 5, 4], [2, 0, 0], [3, 2, 2]]);
    const alsoB = adjustmentEffect(record, sheets, [], at("e", "alsoRight", { answer: "b" }));
    assert.deepEqual(alsoB.changed.map((c) => [c.sheet, c.from, c.to]), [[2, 0, 1]], "only the sheet that marked B changes");
    assert.deepEqual(adjustmentEffect(record, sheets, [at("d", "drop")], at("d2", "drop")).changed, [], "an adjustment already in force changes nothing");
  });

  test("describes each adjustment in words", () => {
    assert.equal(adjustmentWords(at("a", "drop")), "Dropped from the total");
    assert.equal(adjustmentWords(at("a", "credit")), "Everyone has credit");
    assert.equal(adjustmentWords(at("a", "points", { points: 2 })), "Worth 2 points");
    assert.equal(adjustmentWords(at("a", "points", { points: 1 })), "Worth 1 point");
    assert.equal(adjustmentWords(at("a", "alsoRight", { answer: "c" })), "Another answer counts as right (c)");
  });
});

describe("settling what was read", () => {
  const record = testOf(Array.from({ length: 12 }, () => mcq(4)), { versions: 2 });
  const reader = new SheetReader(record);
  const d = drawn(record, { dpi: 100 });
  const render = (marks: Parameters<typeof d.render>[0]): GreyImage => d.render(marks);
  const entriesOf = (images: GreyImage[]): BatchEntry[] => images.map((image, i) => ({ source: { file: "x.pdf", page: i + 1 }, fingerprint: imageFingerprint(image), result: reader.read(image) }));
  const solid = (_q: number, place: number) => ({ place, mark: { kind: "solid" as const } });

  test("takes what the reader was sure of, and leaves a blank or a flag undecided until it is decided", () => {
    const entries = entriesOf([render({ answers: { 1: [solid(1, 2)], 2: [solid(2, 0), solid(2, 1)], 3: [{ place: 0, mark: { kind: "light", darkness: 0.4 } }] }, versions: [{ version: 1, mark: { kind: "solid" } }] })]);
    const batch = assembleBatch(entries, 1);
    const [sheet] = settleSheets(batch.sheets, entries);
    assert.equal(sheet?.version, 1);
    assert.deepEqual(sheet?.answers[1], { kind: "marked", places: [2], by: "reader" });
    assert.equal(sheet?.answers[2]?.kind, "unsettled", "two marks on one answer");
    assert.equal(sheet?.answers[3]?.kind, "unsettled", "a light mark");
    assert.equal(sheet?.answers[4]?.kind, "unsettled", "a blank, not confirmed");
    assert.match((sheet?.answers[4] as { why: string }).why, /found this blank, and it has not been confirmed/);
    const [accepted] = settleSheets(batch.sheets, entries, [], { acceptBlanks: true });
    assert.deepEqual(accepted?.answers[4], { kind: "blank", by: "reader" });
    assert.equal(accepted?.answers[2]?.kind, "unsettled", "a flag is never taken as read");
  });

  test("replaces what the reader said with a person's decision, for an answer or a blank", () => {
    const entries = entriesOf([render({ answers: { 1: [solid(1, 2)], 2: [solid(2, 0), solid(2, 1)] }, versions: [{ version: 1, mark: { kind: "solid" } }] })]);
    const batch = assembleBatch(entries, 1);
    const [sheet] = settleSheets(batch.sheets, entries, [{ sheet: 1, kind: "answer", question: 2, places: [1] }, { sheet: 1, kind: "answer", question: 1, places: "blank" }, { sheet: 1, kind: "answer", question: 5, places: [3, 1] }]);
    assert.deepEqual(sheet?.answers[2], { kind: "marked", places: [1], by: "person" });
    assert.deepEqual(sheet?.answers[1], { kind: "blank", by: "person" });
    assert.deepEqual(sheet?.answers[5], { kind: "marked", places: [1, 3], by: "person" }, "a sheet is keyed in by hand, in order");
  });

  test("decides the questions of a page whose version a person settles, from the fills it kept and with no rescan", () => {
    const entries = entriesOf([render({ answers: { 1: [solid(1, 2)], 2: [solid(2, 1)] } })]);
    const batch = assembleBatch(entries, 1);
    const [before] = settleSheets(batch.sheets, entries);
    assert.equal(before?.version, undefined);
    assert.deepEqual(before?.answers, {}, "nothing is decided before the version is");
    assert.ok(before?.problems.includes("Its version is not settled."));
    const [after] = settleSheets(batch.sheets, entries, [{ sheet: 1, kind: "version", version: 2 }], { reader, acceptBlanks: true });
    assert.equal(after?.version, 2);
    assert.deepEqual(after?.answers[1], { kind: "marked", places: [2], by: "reader" });
    assert.deepEqual(after?.answers[2], { kind: "marked", places: [1], by: "reader" });
    assert.equal(after?.answers[3]?.kind, "blank");
    assert.deepEqual(after?.problems, []);
  });

  test("takes the last version a person decided when they changed their mind", () => {
    const entries = entriesOf([render({ answers: { 1: [solid(1, 2)] } })]);
    const batch = assembleBatch(entries, 1);
    const [sheet] = settleSheets(batch.sheets, entries, [{ sheet: 1, kind: "version", version: 1 }, { sheet: 1, kind: "version", version: 2 }], { reader, acceptBlanks: true });
    assert.equal(sheet?.version, 2);
  });

  test("says what is missing from a sheet: a page that did not come, and one that could not be read", () => {
    const long = testOf(Array.from({ length: 130 }, () => mcq(4)), { versions: 1 });
    const longReader = new SheetReader(long);
    const page1 = drawn(long, { dpi: 100, page: 1 }).render();
    const entries: BatchEntry[] = [{ source: { file: "y.pdf", page: 1 }, fingerprint: imageFingerprint(page1), result: longReader.read(page1) }];
    const [alone] = settleSheets(assembleBatch(entries, 2).sheets, entries);
    assert.ok(alone?.problems.includes("Page 2 did not come."));
    const withRefused: BatchEntry[] = [...entries, { source: { file: "y.pdf", page: 2 }, fingerprint: "z", result: { ok: false, cause: "corners", reason: "Four corner marks could not be found" } }];
    const [held] = settleSheets(assembleBatch(withRefused, 2).sheets, withRefused);
    assert.ok(held?.problems.some((p) => /Page 2 could not be read \(Four corner marks could not be found\)/.test(p)));
  });

  test("does not give a sheet whose pages name different versions either of them", () => {
    const long = testOf(Array.from({ length: 130 }, () => mcq(4)), { versions: 2 });
    const longReader = new SheetReader(long);
    const p1 = drawn(long, { dpi: 100, page: 1 }).render({ versions: [{ version: 1, mark: { kind: "solid" } }] });
    const p2 = drawn(long, { dpi: 100, page: 2 }).render({ versions: [{ version: 2, mark: { kind: "solid" } }] });
    const entries: BatchEntry[] = [p1, p2].map((image, i) => ({ source: { file: "m.pdf", page: i + 1 }, fingerprint: imageFingerprint(image), result: longReader.read(image) }));
    const [sheet] = settleSheets(assembleBatch(entries, 2).sheets, entries);
    assert.equal(sheet?.version, undefined);
    assert.ok(sheet?.problems.includes("Its version is not settled."));
  });
});

describe("item statistics", () => {
  const items = (n: number) => Array.from({ length: n }, () => make("multipleChoice", [["a", true], ["b", false], ["c", false]]));
  /** Sheets from a table of right (1) and wrong (0) for each question: right is place 0, wrong place 1. */
  const table = (rows: number[][], start = 1): SettledSheet[] => rows.map((row, i) => settled(start + i, 1, Object.fromEntries(row.map((v, q) => [q + 1, v ? [0] : [1]]))));

  test("works out difficulty, discrimination and KR-20 as they are worked out by hand", () => {
    const record = testOf(items(3), { versions: 1 });
    // five students: 111, 110, 100, 010, 000. Each question's right share is .6, .6, .2; the totals are 3, 2, 1, 1, 0 (mean 1.4, variance 1.04).
    const scores = scoreSheets(record, table([[1, 1, 1], [1, 1, 0], [1, 0, 0], [0, 1, 0], [0, 0, 0]]));
    const stats = itemStatistics(record, scores);
    assert.equal(stats.sheets, 5);
    assert.deepEqual(stats.items.map((i) => i.difficulty), [0.6, 0.6, 0.2]);
    // the correlation of question 1 with the total: .36 / sqrt(.24 * 1.04) = .7206; of question 3: .32 / sqrt(.16 * 1.04) = .7845
    assert.ok(Math.abs((stats.items[0]?.discrimination.pointBiserial as number) - 0.7206) < 1e-3);
    assert.ok(Math.abs((stats.items[2]?.discrimination.pointBiserial as number) - 0.7845) < 1e-3);
    assert.equal(stats.mean, 1.4);
    assert.equal(stats.sd, 1.0198);
    // KR-20 = 3 / 2 * (1 - (.24 + .24 + .16) / 1.04) = .5769
    assert.equal(stats.reliability?.kind, "KR-20");
    assert.ok(Math.abs((stats.reliability?.value as number) - 0.5769) < 1e-3);
    assert.equal(stats.reliability?.items, 3);
    assert.equal(stats.items[0]?.discrimination.upperLower, undefined, "five sheets are too few to split into a top and a bottom");
  });

  test("compares the top 27 percent with the bottom 27 percent, with a tie broken by the sheet number", () => {
    const record = testOf(items(2), { versions: 1 });
    // ten students, (A, B): 11, 11, 11, 10, 01, 10, 01, 00, 00, 01. Totals 2 2 2 1 1 1 1 0 0 1; the top three are sheets 1 to 3,
    // and the bottom three are sheets 10, 8 and 9: the ones with a total of 1 come in order of sheet number, so 10 is the last of them,
    // and it is the one that goes into the bottom group (A: 0, B: 1), where sheet 4 (A: 1, B: 0) would have if the tie went the other way
    const stats = itemStatistics(record, scoreSheets(record, table([[1, 1], [1, 1], [1, 1], [1, 0], [0, 1], [1, 0], [0, 1], [0, 0], [0, 0], [0, 1]])));
    assert.deepEqual(stats.items.map((i) => i.difficulty), [0.5, 0.6]);
    assert.equal(stats.items[0]?.discrimination.groupSize, 3);
    assert.equal(stats.items[0]?.discrimination.upperLower, 1, "all of the top and none of the bottom");
    assert.ok(Math.abs((stats.items[1]?.discrimination.upperLower as number) - 0.6667) < 1e-3, "1 less a third");
    // A: .25 / sqrt(.25 * .49) = .7143. B: .24 / sqrt(.24 * .49) = .6999
    assert.ok(Math.abs((stats.items[0]?.discrimination.pointBiserial as number) - 0.7143) < 1e-3);
    assert.ok(Math.abs((stats.items[1]?.discrimination.pointBiserial as number) - 0.6999) < 1e-3);
    // the two questions are not correlated at all in this class, so the test hangs together no better than chance
    assert.equal(stats.reliability?.value, 0);
  });

  test("takes 27 percent of the class for each group: 11 sheets of 40, not a quarter", () => {
    const record = testOf(items(2), { versions: 1 });
    // forty students whose two answers are right or wrong in a fixed pattern, so that the totals spread out
    const rows = Array.from({ length: 40 }, (_x, i) => [i % 3 === 0 ? 1 : 0, i % 4 === 0 || i < 10 ? 1 : 0]);
    const stats = itemStatistics(record, scoreSheets(record, table(rows)));
    assert.equal(stats.sheets, 40);
    assert.equal(stats.items[0]?.discrimination.groupSize, 11, "0.27 of 40 is 10.8, which is 11");
  });

  test("counts which answers were marked, and how many left it blank, for every question", () => {
    const q = make("multipleChoice", [["a", true], ["b", false], ["c", false]]);
    const tfq1 = tfq();
    const record = testOf([q, tfq1, make("multipleResponse", [["a", true], ["b", true], ["c", false]])], { versions: 1 });
    const stats = itemStatistics(record, scoreSheets(record, [settled(1, 1, { 1: [0], 2: [0], 3: [0, 1] }), settled(2, 1, { 1: [1], 2: [1], 3: [0, 2] }), settled(3, 1, { 1: [1], 2: "blank", 3: "blank" })]));
    assert.deepEqual(stats.items[0]?.options, [{ answer: "a", correct: true, chosen: 1 }, { answer: "b", correct: false, chosen: 2 }, { answer: "c", correct: false, chosen: 0 }]);
    assert.deepEqual(stats.items[1]?.options, [{ answer: "true", correct: true, chosen: 1 }, { answer: "false", correct: false, chosen: 1 }]);
    assert.deepEqual(stats.items[2]?.options.map((o) => o.chosen), [2, 1, 1], "each answer in a set counts");
    assert.deepEqual(stats.items.map((i) => i.blanks), [0, 1, 1]);
    assert.deepEqual(stats.items.map((i) => i.sheets), [3, 3, 3]);
  });

  test("uses the answers of every version for one bank question, whatever order they were in", () => {
    const q = make("multipleChoice", [["a", true], ["b", false], ["c", false], ["d", false]]);
    const record = testOf([q, make("multipleChoice", [["a", true], ["b", false]])], { versions: 2, questionOrder: "shuffled", seed: "mix" });
    const placeOfA = (v: number, id: string): number => ((record.versions[v - 1] as { options: Record<string, string[]> }).options[id] as string[]).indexOf("a");
    const positionOf = (v: number, id: string): number => (record.versions[v - 1] as { order: string[] }).order.indexOf(id) + 1;
    const other = record.questions[1] as Question;
    const sheets = [1, 2].map((v) => settled(v, v, { [positionOf(v, q.id)]: [placeOfA(v, q.id)], [positionOf(v, other.id)]: [placeOfA(v, other.id)] }));
    const stats = itemStatistics(record, scoreSheets(record, sheets));
    const first = stats.items.find((i) => i.questionId === q.id);
    assert.equal(first?.sheets, 2);
    assert.equal(first?.difficulty, 1);
    assert.deepEqual(first?.options.map((o) => [o.answer, o.chosen]), [["a", 2], ["b", 0], ["c", 0], ["d", 0]], "both versions marked the bank's own A, though their letters differ");
  });

  test("says when the group is small, and not when it is not, and leaves out sheets that are not complete", () => {
    const record = testOf(items(2), { versions: 1 });
    const few = itemStatistics(record, scoreSheets(record, [...table([[1, 0], [0, 1], [1, 1]]), settled(4, 1, { 1: [0], 2: "?" })]));
    assert.equal(few.unstable, true);
    assert.equal(few.sheets, 3);
    assert.equal(few.leftOut, 1);
    assert.ok(few.notes.some((n) => /Only 3 sheets: fewer than 30, so these figures are unstable/.test(n)));
    assert.ok(few.notes.some((n) => /1 sheet was left out because it has a question not yet settled/.test(n)));
    assert.ok(few.items[0]?.notes.some((n) => /Only 3 sheets: the figures for this question are unstable/.test(n)));
    const pattern = Array.from({ length: SMALL_GROUP }, (_x, i) => [i % 2, i % 3 === 0 ? 1 : 0]);
    const many = itemStatistics(record, scoreSheets(record, table(pattern)));
    assert.equal(many.unstable, false);
    assert.deepEqual(many.notes, []);
    assert.deepEqual(many.items[0]?.notes, []);
    assert.equal(itemStatistics(record, []).sheets, 0);
  });

  test("shows Cronbach's alpha and says so when a question gives partial credit, and nothing when nothing varies", () => {
    const partial = make("multipleResponse", [["a", true], ["b", true], ["c", false]], { partial: true });
    const record = testOf([partial, make("multipleChoice", [["a", true], ["b", false]])], { versions: 1 });
    const rows = [[[0, 1], [0]], [[0], [0]], [[2], [1]], [[0, 1], [1]], [[0, 2], [0]], [[1], [0]]].map(([a, b], i) => settled(i + 1, 1, { 1: a as number[], 2: b as number[] }));
    const stats = itemStatistics(record, scoreSheets(record, rows));
    assert.equal(stats.reliability?.kind, "Cronbach alpha");
    assert.ok(stats.notes.some((n) => /partial credit, and KR-20 is defined for questions that are right or wrong, so Cronbach's alpha is shown/.test(n)));
    const alike = testOf(items(2), { versions: 1 });
    const same = itemStatistics(alike, scoreSheets(alike, table([[1, 1], [1, 1], [1, 1]])));
    assert.equal(same.items.length, 2, "the questions are there");
    assert.equal(same.reliability, undefined, "a test everyone answered alike says nothing about how consistent it is");
    assert.equal(same.items[0]?.discrimination.pointBiserial, undefined, "a question everyone got right correlates with nothing, and is not shown as NaN");
    assert.equal(same.items[0]?.difficulty, 1);
  });

  test("leaves a question that counts on only some sheets out of the reliability, and says so", () => {
    const a = make("multipleChoice", [["a", true], ["b", false]]);
    const b = make("multipleChoice", [["a", true], ["b", false]]);
    const c = make("multipleChoice", [["a", true], ["b", false]]);
    const record = testOf([a, b, c], { versions: 2 });
    const rows = [settled(1, 1, { 1: [0], 2: [0], 3: [1] }), settled(2, 1, { 1: [1], 2: [0], 3: [0] }), settled(3, 2, { 1: [0], 2: [1], 3: [0] }), settled(4, 2, { 1: [1], 2: [1], 3: [1] })];
    const adjustments: Adjustment[] = [{ id: "d", kind: "drop", questionId: a.id, versions: [2] }];
    const stats = itemStatistics(record, scoreSheets(record, rows, adjustments));
    assert.equal(stats.items.find((i) => i.questionId === a.id)?.sheets, 2, "the dropped question counts on the sheets of version 1 only");
    assert.equal(stats.reliability?.items, 2);
    assert.ok(stats.notes.some((n) => /counts on only some sheets \(an adjustment for one version\), and is left out of the reliability figure/.test(n)));
  });
});

/** Keeps `TestRecord` in use for the type of a helper above. */
export type { TestRecord };
