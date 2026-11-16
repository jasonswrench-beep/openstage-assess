/**
 * Written-answer boxes (development list item 9, built before any reading of handwriting): a short answer is written in a box on a page
 * after the bubble pages, the page is read like any other up to its boxes, each box is cut out upright for a person, and the person's
 * points are the question's score. Nothing written in a box is read by the program.
 *
 * Without boxes asked for, nothing changes: the same plan, the same pages and the same strips as before.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createQuestion } from "../src/model/create.ts";
import { plainToRich } from "../src/model/richtext.ts";
import { createTest, versionQuestions, type TestRecord } from "../src/model/test.ts";
import { assembleBatch, type BatchEntry } from "../src/sheets/batch.ts";
import { decodeCode, encodeCode, isBoxPage, LAYOUT_BOXES } from "../src/sheets/code.ts";
import { cropRects } from "../src/sheets/crop.ts";
import { blur, rotate } from "../src/sheets/damage.ts";
import { boxesPerPage, boxRect } from "../src/sheets/geometry.ts";
import type { GreyImage } from "../src/sheets/image.ts";
import { planSheet, type SheetPlan } from "../src/sheets/plan.ts";
import { pageBoxes, printSheet, sheetCode } from "../src/sheets/print.ts";
import { pstatProject2, writePstatFile } from "../src/sheets/pstat-export.ts";
import { SheetRaster, type SheetMarks } from "../src/sheets/raster.ts";
import { SheetReader, type SheetReading } from "../src/sheets/read.ts";
import { newScoresFile, readScoresFile, restore, writeScoresFile } from "../src/sheets/scores-file.ts";
import { scoreSheets, settleSheets, type Decision } from "../src/sheets/score.ts";
import { itemStatistics } from "../src/sheets/stats.ts";

const AT = "2026-11-01T00:00:00.000Z";
let made = 0;
const id = (p: string) => `${p}_${String(++made).padStart(26, "0")}`;
const mc = () => createQuestion({ type: "multipleChoice", stem: plainToRich("Pick"), body: { shuffle: false, options: [0, 1, 2, 3].map((k) => ({ id: `o${k}`, content: plainToRich(`A${k}`), correct: k === 1 })) }, by: "t", at: AT, id: id("q") });
const sa = (points = 2) => createQuestion({ type: "shortAnswer", stem: plainToRich("Name the capital of France."), body: { caseSensitive: false, accepted: ["Paris"] }, by: "t", at: AT, id: id("q"), points });

function testWith(questions: ReturnType<typeof mc>[], versions = 1, more: Partial<Parameters<typeof createTest>[0]> = {}): TestRecord {
  return createTest({ id: id("t"), name: "Boxes", questions, versions, seed: "boxes", at: AT, ...more });
}

const planOf = (record: TestRecord, boxes: boolean): SheetPlan => {
  const p = planSheet(record, { paper: "letter", boxes });
  if (!p.ok) throw new Error(p.reason);
  return p.plan;
};

function page(record: TestRecord, plan: SheetPlan, number: number, marks: SheetMarks = {}, dpi = 150): GreyImage {
  return new SheetRaster(plan, { title: record.name, fingerprint: record.fingerprint, versions: record.versions.length }, number, dpi).render(marks);
}

/** Writes across a box, as a student's pencil would, so the piece cut out is not white. */
function writeIn(image: GreyImage, rect: { x: number; y: number; width: number; height: number }, dpi = 150): void {
  const k = dpi / 25.4;
  for (let y = Math.round((rect.y + 10) * k); y < Math.round((rect.y + 14) * k); y++) for (let x = Math.round((rect.x + 8) * k); x < Math.round((rect.x + 40) * k); x++) image.data[y * image.width + x] = 30;
}

/** The picture turned a quarter clockwise, as a page put on the glass sideways comes out. */
function quarterTurn(image: GreyImage): GreyImage {
  const width = image.height;
  const height = image.width;
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = image.data[(image.height - 1 - x) * image.width + y] ?? 255;
  return { width, height, data };
}

const ok = (r: ReturnType<SheetReader["read"]>): SheetReading => {
  assert.ok(r.ok, r.ok ? "" : `${r.cause}: ${r.reason}`);
  return r;
};

describe("planning and printing boxes", () => {
  test("without boxes asked for, nothing changes: a short answer is answered in the booklet and the pages are the bubble pages", () => {
    const record = testWith([mc(), sa(), mc()]);
    const plain = planOf(record, false);
    assert.deepEqual([plain.pages, plain.bubblePages, plain.boxes], [1, 1, []]);
    assert.equal(plain.uses.A?.[1]?.kind, "none");
    assert.equal(sheetCode(plain, { title: "x", fingerprint: record.fingerprint, versions: 1 }, 1).layout, 1);
  });

  test("with boxes, each short answer has a box on a written-answer page after the bubbles, and the page's code says layout 3", () => {
    const record = testWith([mc(), sa(), mc(), sa(3)]);
    const plan = planOf(record, true);
    assert.deepEqual([plan.pages, plan.bubblePages, plan.boxes], [2, 1, [2, 4]]);
    assert.equal(plan.uses.A?.[1]?.kind, "written");
    assert.match(plan.notes.at(-1) ?? "", /2 short answers are written in a box on the written-answer page \(page 2\)/);
    const input = { title: "x", fingerprint: record.fingerprint, versions: 1 };
    assert.deepEqual([sheetCode(plan, input, 1).layout, sheetCode(plan, input, 2).layout, sheetCode(plan, input, 2).pages], [1, LAYOUT_BOXES, 2]);
    assert.deepEqual(pageBoxes(plan, 2).map((b) => b.question), [2, 4]);
    assert.deepEqual(pageBoxes(plan, 1), []);
    const pdf = printSheet(plan, input);
    assert.equal(pdf.pages, 2);
  });

  test("a page holds twelve boxes on Letter and on A4, and more short answers take more pages, up to the eight a sheet can have", () => {
    assert.equal(boxesPerPage("letter"), 12);
    assert.equal(boxesPerPage("a4"), 12);
    const many = testWith(Array.from({ length: 13 }, () => sa()));
    const plan = planOf(many, true);
    assert.deepEqual([plan.bubblePages, plan.pages], [1, 3]);
    assert.deepEqual(pageBoxes(plan, 3).map((b) => b.question), [13]);
    // Every box is inside the corner marks and clear of the line at the foot.
    for (let place = 0; place < 12; place++) {
      const r = boxRect("letter", place);
      assert.ok(r.x >= 20 && r.x + r.width <= 215.9 - 20 && r.y >= 60 && r.y + r.height <= 279.4 - 25 - 5, JSON.stringify(r));
    }
    const tooMany = planSheet(testWith(Array.from({ length: 90 }, () => sa())), { paper: "letter", boxes: true });
    assert.equal(tooMany.ok, false);
    assert.match(tooMany.ok ? "" : tooMany.reason, /90 written-answer boxes, which is 9 pages of answer sheet, and a test has at most 8/);
  });

  test("a place is a box when any version holds a short answer there, and a version whose question there has bubbles leaves it", () => {
    const record = testWith([mc(), sa(), mc(), mc()], 2, { questionOrder: "shuffled" });
    const plan = planOf(record, true);
    const places = ["A", "B"].map((v) => versionQuestions(record, v as "A" | "B").findIndex((q) => q.type === "shortAnswer") + 1);
    assert.deepEqual(plan.boxes, [...new Set(places)].sort((a, b) => a - b));
  });
});

describe("reading and scoring boxes", () => {
  const record = testWith([mc(), sa(2), mc()]);
  const plan = planOf(record, true);
  const reader = new SheetReader(record);

  test("a written-answer page is read up to its boxes, and lists them; its bubble page reads as before", () => {
    const bubbles = ok(reader.read(page(record, plan, 1, { answers: { 1: [{ place: 1, mark: { kind: "solid" } }], 3: [{ place: 0, mark: { kind: "solid" } }] } })));
    // The short answer's row has no bubbles, as an essay's has none: it is answered in its box.
    assert.deepEqual(bubbles.questions.map((q) => [q.number, q.status]), [[1, "answered"], [2, "notOnSheet"], [3, "answered"]]);
    assert.equal(bubbles.written, undefined);
    const boxes = ok(reader.read(page(record, plan, 2)));
    assert.ok(isBoxPage(boxes.code));
    assert.deepEqual(boxes.written, [2]);
    assert.deepEqual([boxes.questions, boxes.flags], [[], []]);
  });

  test("a written-answer page is refused when the strip and the test disagree about it", () => {
    // Read against the same test planned without boxes: a page 2 of 2 is a sheet this test, as it stands, would not print.
    const other = testWith([mc(), sa(2), mc(), mc()]);
    const r = new SheetReader(other).read(page(record, plan, 2));
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.reason, /another test/);
  });

  test("a page whose kind does not fit its place is refused: a written-answer page where the bubbles should be", () => {
    // Drawn from the same plan with no bubble pages, page 1 is a page of boxes that says it is page 1 of 2.
    const r = reader.read(page(record, { ...plan, bubblePages: 0 }, 1));
    assert.equal(r.ok, false);
    assert.equal(r.ok ? "" : r.cause, "code");
    assert.match(r.ok ? "" : r.reason, /written-answer page/);
  });

  test("a blurred written-answer page is refused, as a blurred page of bubbles is", () => {
    const shown = blur(page(record, plan, 2), 5);
    const r = reader.read(shown);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.reason, /blurred/);
  });

  test("each box is cut out upright for a person, and what is written in it is in the piece", () => {
    const image = page(record, plan, 2);
    const rect = boxRect("letter", 0);
    writeIn(image, rect);
    const [piece] = cropRects(image, "letter", [rect]) ?? [];
    assert.ok(piece && piece.width > 400 && piece.height > 100, JSON.stringify(piece && [piece.width, piece.height]));
    let dark = 0;
    for (const v of piece.data) if (v < 80) dark++;
    assert.ok(dark > 500, `the writing is in the piece (${dark} dark pixels)`);
  });

  test("a written-answer page scanned sideways or turned a little is read, and its box still comes out upright", () => {
    const image = page(record, plan, 2);
    writeIn(image, boxRect("letter", 0));
    for (const shown of [quarterTurn(image), rotate(image, 2.5)]) {
      const r = ok(reader.read(shown));
      assert.deepEqual(r.written, [2]);
      const [piece] = cropRects(shown, "letter", [boxRect("letter", 0)]) ?? [];
      assert.ok(piece && piece.width > piece.height * 2, "wide and low, as the box is printed");
      // The writing is in the left part of the box, near the top, as it was written.
      let left = 0;
      let right = 0;
      for (let y = 0; y < (piece?.height ?? 0); y++) for (let x = 0; x < (piece?.width ?? 0); x++) if ((piece?.data[y * (piece?.width ?? 0) + x] ?? 255) < 80) (x < (piece?.width ?? 0) / 2 ? left++ : right++);
      assert.ok(left > right * 3, `upright: ${left} dark on the left, ${right} on the right`);
    }
  });

  function sitting(decisions: Decision[] = []) {
    const entries: BatchEntry[] = [
      { source: { file: "a", page: 1 }, fingerprint: "a1", result: reader.read(page(record, plan, 1, { answers: { 1: [{ place: 1, mark: { kind: "solid" } }], 3: [{ place: 0, mark: { kind: "solid" } }] } })) },
      { source: { file: "a", page: 2 }, fingerprint: "a2", result: reader.read(page(record, plan, 2)) },
    ];
    const batch = assembleBatch(entries, plan.pages);
    const settled = settleSheets(batch.sheets, entries, decisions, { reader });
    return { entries, batch, settled, scores: scoreSheets(record, settled) };
  }
  const saId = record.questions[1]?.id as string;

  test("a box waits for a person: the sheet is not complete until it is scored", () => {
    const { scores } = sitting();
    assert.equal(scores[0]?.complete, false);
    assert.deepEqual(scores[0]?.questions.map((q) => q.outcome), ["right", "unsettled", "wrong"]);
    assert.match(scores[0]?.questions[1]?.why ?? "", /has not been scored yet/);
  });

  test("the person's points are the score: full, part, none or left blank, and the figures count them", () => {
    for (const [awarded, outcome, earned] of [[2, "right", 2], [1, "partial", 1], [0, "wrong", 0], ["blank", "blank", 0]] as const) {
      const { scores } = sitting([{ sheet: 1, kind: "written", question: 2, awarded, of: 2 }]);
      assert.equal(scores[0]?.complete, true, String(awarded));
      assert.deepEqual([scores[0]?.questions[1]?.outcome, scores[0]?.questions[1]?.earned], [outcome, earned]);
    }
    const { scores } = sitting([{ sheet: 1, kind: "written", question: 2, awarded: 1.5, of: 2 }]);
    const stats = itemStatistics(record, scores);
    assert.equal(stats.items.find((i) => i.questionId === saId)?.difficulty, 0.75);
  });

  test("points given out of an older worth are scaled to the question's worth now, never above it", async () => {
    const { settled } = sitting([{ sheet: 1, kind: "written", question: 2, awarded: 1, of: 2 }]);
    const scores = scoreSheets(record, settled, [{ id: "adj", kind: "points", questionId: saId, points: 4, at: AT }]);
    assert.deepEqual([scores[0]?.questions[1]?.earned, scores[0]?.questions[1]?.possible], [2, 4]);
  });

  test("a score for a question with no box on the sheet is not taken", () => {
    const { scores } = sitting([{ sheet: 1, kind: "written", question: 1, awarded: 5, of: 5 }]);
    assert.deepEqual([scores[0]?.questions[0]?.outcome, scores[0]?.questions[0]?.earned], ["right", 1], "question 1 is still its bubbles' answer");
  });

  test("bubbles given by hand to a question written in a box do not score it: it waits for points", () => {
    const { scores } = sitting([{ sheet: 1, kind: "answer", question: 2, places: [0] }]);
    assert.equal(scores[0]?.questions[1]?.outcome, "unsettled");
    assert.equal(scores[0]?.complete, false);
  });

  test("a box on a version whose question there has bubbles waits for nobody: the bubbles are its answer", () => {
    const shuffled = testWith([mc(), sa(), mc(), mc()], 2, { questionOrder: "shuffled" });
    const boxedPlan = planOf(shuffled, true);
    const r2 = new SheetReader(shuffled);
    // A version and a place that has a box on the sheet but a question with bubbles on this version.
    const label = (["A", "B"] as const).find((v) => boxedPlan.boxes.some((n) => boxedPlan.uses[v]?.[n - 1]?.kind !== "written"));
    assert.ok(label, "the shuffle puts the short answer in two places");
    const version = label === "A" ? 1 : 2;
    const place = boxedPlan.boxes.find((n) => boxedPlan.uses[label]?.[n - 1]?.kind !== "written") as number;
    const input = { title: shuffled.name, fingerprint: shuffled.fingerprint, versions: 2, version };
    const bubbles = new SheetRaster(boxedPlan, input, 1, 150).render({ answers: { [place]: [{ place: 0, mark: { kind: "solid" } }] } });
    const boxes = new SheetRaster(boxedPlan, input, 2, 150).render();
    const entries: BatchEntry[] = [
      { source: { file: "v", page: 1 }, fingerprint: "v1", result: r2.read(bubbles) },
      { source: { file: "v", page: 2 }, fingerprint: "v2", result: r2.read(boxes) },
    ];
    const settled = settleSheets(assembleBatch(entries, boxedPlan.pages).sheets, entries, [], { reader: r2 });
    assert.equal(settled[0]?.answers[place]?.kind, "marked", "the bubbles' answer stands");
  });

  test("a score for a box is not taken for a row of bubbles the reader left unsettled", () => {
    // Question 1 left blank and not confirmed is unsettled, like a box not yet scored; points for a box must not settle it.
    const entries: BatchEntry[] = [
      { source: { file: "a", page: 1 }, fingerprint: "b1", result: reader.read(page(record, plan, 1, { answers: { 3: [{ place: 2, mark: { kind: "solid" } }] } })) },
      { source: { file: "a", page: 2 }, fingerprint: "b2", result: reader.read(page(record, plan, 2)) },
    ];
    const batch = assembleBatch(entries, plan.pages);
    const settled = settleSheets(batch.sheets, entries, [{ sheet: 1, kind: "written", question: 1, awarded: 1, of: 1 }], { reader });
    assert.equal(settled[0]?.answers[1]?.kind, "unsettled");
    const q1 = scoreSheets(record, settled)[0]?.questions[0];
    assert.equal(q1?.outcome, "unsettled");
    assert.match(q1?.why ?? "", /blank/);
  });

  test("the scores file keeps which boxes a page holds and the person's points, and no picture; a damaged score is refused", () => {
    const decisions: Decision[] = [{ sheet: 1, kind: "written", question: 2, awarded: 1.5, of: 2 }];
    const { entries, batch } = sitting(decisions);
    const file = newScoresFile(record, batch, entries, { decisions, pagesPerSheet: plan.pages });
    const read = readScoresFile(writeScoresFile(file));
    assert.ok(read.ok, read.ok ? "" : read.reason);
    const back = restore(read.file);
    const again = scoreSheets(record, settleSheets(back.sheets, back.entries, read.file.decisions, { reader }));
    assert.deepEqual(again[0]?.questions[1]?.earned, 1.5);
    assert.deepEqual((back.entries[1]?.result as SheetReading).written, [2]);
    const bad = { ...file, decisions: [{ sheet: 1, kind: "written", question: 2, awarded: 3, of: 2 }] } as unknown as typeof file;
    const refused = readScoresFile(writeScoresFile(bad));
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? "" : refused.reason, /not a score for a written answer/);
    // A list of boxes belongs to a written-answer page: on a page of bubbles it is refused, and so is a written-answer page with none.
    const swap = (at: number, change: (reading: Record<string, unknown>) => void) => {
      const copy = JSON.parse(JSON.stringify(file)) as typeof file;
      change((copy.sheets[0]?.pages[at] as unknown as { reading: Record<string, unknown> }).reading);
      return readScoresFile(writeScoresFile(copy));
    };
    const onBubbles = swap(0, (r) => (r["written"] = [2]));
    assert.match(onBubbles.ok ? "" : onBubbles.reason, /a page of bubbles lists boxes/);
    const none = swap(1, (r) => delete r["written"]);
    assert.match(none.ok ? "" : none.reason, /a written-answer page lists no boxes/);
  });

  test("the .pstat carries a person's points for a box, as a question the key gives by its points, and says its answer cell is empty", async () => {
    const decisions: Decision[] = [{ sheet: 1, kind: "written", question: 2, awarded: 1.5, of: 2 }];
    const { scores } = sitting(decisions);
    const made = pstatProject2(record, scores, "OpenAssess test", { source: "scanned sheets" });
    assert.equal(made.fellBack, undefined, made.fellBack);
    const q2 = made.part?.questions[1];
    assert.deepEqual([q2?.type, q2?.key], ["other", [{ correct: [], points: 2, adjustment: "none", partial_credit: false }]]);
    const cells = made.project.dataset.columns[made.project.dataset.variables.findIndex((v) => v.name === "q02")]?.values;
    assert.deepEqual(cells, [1.5]);
    // The box has no letters; the format wants an answer variable for it all the same and has no word for "scored by a person", so its
    // cell is "" as for a blank, and the file says so.
    const r02 = made.project.dataset.columns[made.project.dataset.variables.findIndex((v) => v.name === "r02")]?.values;
    assert.deepEqual(r02, [""]);
    assert.ok(made.project.source.report.notes.some((n) => /^r02: question 2 is written in a box and scored by a person/.test(n)), made.project.source.report.notes.join(" | "));
    const bytes = writePstatFile(made.project, made.part);
    const core = [process.env["OPENSTAGE_CORE"], join(import.meta.dirname, "..", "..", "..", "..", "openstage-core")].find((c) => c && existsSync(join(c, "packages", "pstat", "src", "index.js")));
    if (core) {
      const pstat = await import(pathToFileURL(join(core, "packages", "pstat", "src", "index.js")).href);
      assert.deepEqual(pstat.checkPstat(bytes), [], "the core's checker finds nothing");
    }
  });

  test("a written-answer page's strip round trips, and says it is page 2 of 2, after the bubble page", () => {
    const code = sheetCode(plan, { title: "x", fingerprint: record.fingerprint, versions: 1 }, 2);
    const back = decodeCode(encodeCode(code));
    assert.deepEqual(back.ok && back.code, code);
    assert.deepEqual([code.page, code.pages, code.layout], [2, 2, LAYOUT_BOXES]);
  });
});
