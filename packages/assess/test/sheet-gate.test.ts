/**
 * The accuracy gate and Check my printing. The gate is itself tested: a reader that gives a wrong answer without a flag must make it
 * fail, and one that refuses clean pages or flags too much must make it fail, or its saying PASSED would mean nothing.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { checkPrinting } from "../src/sheets/check-print.ts";
import { formatGate, runSheetGate } from "../src/sheets/gate.ts";
import { levels, toBilevel } from "../src/sheets/damage.ts";
import { cornerMarks, layoutFor, slotRow } from "../src/sheets/geometry.ts";
import { SheetReader, type SheetResult } from "../src/sheets/read.ts";
import type { GreyImage } from "../src/sheets/image.ts";
import type { TestRecord } from "../src/model/test.ts";
import { drawn, mixed, testOf, mcq } from "./support/sheet-fixtures.ts";

/** A reader that is the real one, with what it says changed by a function: the gate has to notice. */
const spoiled = (change: (r: SheetResult) => SheetResult) => (record: TestRecord) => {
  const real = new SheetReader(record);
  return { read: (image: GreyImage): SheetResult => change(real.read(image)) };
};

describe("the accuracy gate", () => {
  const options = { sheets: 6, seed: "unit-gate" };

  test("passes the real reader on a few drawn sheets, and reports every number it counts", () => {
    const report = runSheetGate(options);
    assert.equal(report.passed, true, report.failures.join("; "));
    assert.deepEqual(report.corpora.map((c) => c.name), ["synthetic", "damaged"]);
    for (const c of report.corpora) {
      assert.equal(c.wrong, 0);
      assert.equal(c.version.wrong, 0);
      assert.ok(c.sheets >= 4 && c.pages >= c.sheets && c.questions > 100, `${c.name}: ${c.sheets} sheets, ${c.questions} questions`);
      assert.ok(c.right > c.questions * 0.5, "most of the questions are read");
      assert.equal(c.right + c.wrong + c.flagged + c.blankFlagged, c.questions, "every question is counted once");
      assert.ok(Object.keys(c.byKind).includes("solid"));
      assert.ok(c.fillStats.solid && c.fillStats.solid.p50 > 0.6, "a firm mark reads firm");
      assert.ok(c.blankNoise.p99 < 0.1, "an empty bubble reads empty");
      assert.ok(c.readMs.max < 2000);
    }
    const synthetic = report.corpora[0];
    assert.equal(synthetic?.refused, 0, "no clean page is refused");
    const text = formatGate(report);
    assert.match(text, /^synthetic: \d+ sheets/);
    assert.match(text, /WRONG AND NOT FLAGGED 0/);
    assert.match(text, /PASSED \(seed unit-gate\): no answer was read wrong without a flag\./);
  });

  test("makes the same sheets from the same seed, and others from another", () => {
    const a = runSheetGate({ sheets: 3, seed: "same", only: "synthetic" });
    const b = runSheetGate({ sheets: 3, seed: "same", only: "synthetic" });
    const c = runSheetGate({ sheets: 3, seed: "other", only: "synthetic" });
    const strip = (r: typeof a) => r.corpora.map((x) => ({ ...x, readMs: undefined }));
    assert.deepEqual(strip(a), strip(b));
    assert.notDeepEqual(strip(a), strip(c));
    assert.equal(a.corpora.length, 1);
  });

  test("fails a reader that gives a wrong answer without flagging it, and says which", () => {
    let n = 0;
    const lying = spoiled((r) => {
      if (!r.ok) return r;
      return { ...r, questions: r.questions.map((q) => (q.status === "answered" && ++n % 9 === 0 ? { ...q, marked: [(q.marked[0] as number) === 0 ? 1 : 0] } : q)) };
    });
    const report = runSheetGate({ ...options, only: "synthetic", readerFor: lying });
    assert.equal(report.passed, false);
    assert.ok((report.corpora[0] as { wrong: number }).wrong > 0);
    assert.match(report.failures[0] as string, /answers? read wrong and not flagged/);
    assert.match(formatGate(report), /WRONG: synthetic#\d+ page 1 .*question \d+ read as [A-H], the student's was/);
    assert.match(formatGate(report), /FAILED \(seed unit-gate\)/);
  });

  test("fails a reader that reads the wrong version, and one that records an answer the student did not give on a blank or doubled question", () => {
    const wrongVersion = spoiled((r) => (r.ok && r.version !== undefined && r.code.version === 0 ? { ...r, version: (r.version % 4) + 1 } : r));
    const v = runSheetGate({ sheets: 8, seed: "unit-gate", only: "synthetic", readerFor: wrongVersion });
    assert.ok(v.corpora[0]!.version.wrong >= 1, "a changed version is counted as read wrong");
    assert.equal(v.passed, false);
    assert.match(v.failures.join(" "), /versions? read wrong and not flagged/);
    const guessing = spoiled((r) => (r.ok ? { ...r, questions: r.questions.map((q) => (q.status === "blank" || q.kind === "multiple" ? { ...q, status: "answered" as const, marked: [0], kind: undefined } : q)) } : r));
    const g = runSheetGate({ ...options, only: "synthetic", readerFor: guessing });
    assert.equal(g.passed, false, "recording an answer where the student left it blank or marked two is a wrong answer");
    assert.ok(g.corpora[0]!.wrong > 0);
  });

  test("fails a reader that records part of a set of answers, and one that records both marks of a question with one answer", () => {
    const partial = spoiled((r) => (r.ok ? { ...r, questions: r.questions.map((q) => (q.status === "answered" && q.marked.length > 1 ? { ...q, marked: q.marked.slice(0, -1) } : q)) } : r));
    const a = runSheetGate({ sheets: 12, seed: "unit-gate", only: "synthetic", readerFor: partial });
    assert.equal(a.passed, false, "an answer missing from a set is a wrong answer, not nearly right");
    assert.ok(a.corpora[0]!.wrong > 0);
    // the reader flagged two marks on a question with one answer; this one records them both, as a set
    const both = spoiled((r) => (r.ok ? { ...r, questions: r.questions.map((q) => (q.kind === "multiple" ? { ...q, status: "answered" as const, marked: q.fills.flatMap((f, p) => (f >= 0.5 ? [p] : [])), kind: undefined } : q)) } : r));
    const b = runSheetGate({ sheets: 12, seed: "unit-gate", only: "synthetic", readerFor: both });
    assert.equal(b.passed, false, "recording what two marks add up to, on a question with one answer, is a wrong answer");
    assert.ok(b.corpora[0]!.wrong > 0);
  });

  test("fails a reader that is too slow", () => {
    const slow = spoiled((r) => {
      // every page of a sheet of 90 questions or more: its second page, when it has one, has fewer than 90 on it
      if (r.ok && (r.questions.length >= 90 || r.code.pages > 1)) for (const end = performance.now() + 1100; performance.now() < end; ) continue;
      return r;
    });
    const report = runSheetGate({ sheets: 12, seed: "unit-gate", only: "synthetic", readerFor: slow });
    assert.equal(report.passed, false);
    assert.match(report.failures.join(" "), /a sheet of 90 questions or more took \d+ ms to read \(the target is under 1000\)/);
  });

  test("fails a reader that refuses clean pages, and one that flags nearly everything", () => {
    const refusing = spoiled(() => ({ ok: false, cause: "quality", reason: "no" }));
    const a = runSheetGate({ ...options, only: "synthetic", readerFor: refusing });
    assert.equal(a.passed, false);
    assert.match(a.failures.join(" "), /clean pages? refused/);
    const nervous = spoiled((r) => (r.ok ? { ...r, questions: r.questions.map((q) => (q.status === "answered" ? { ...q, status: "flagged" as const, marked: [], kind: "faint" as const, reason: "unsure" } : q)) } : r));
    const b = runSheetGate({ sheets: 12, seed: "unit-gate", only: "synthetic", readerFor: nervous });
    assert.equal(b.passed, false);
    assert.match(b.failures.join(" "), /percent of firm answers on clean sheets/);
  });
});

describe("Check my printing", () => {
  const record = mixed(30, { versions: 1 });
  const reader = new SheetReader(record);
  const d = drawn(record, { dpi: 200 });
  const blank = d.render();

  test("is happy with a blank copy, and says what it found", () => {
    const check = checkPrinting(reader, blank, { dpi: 200 });
    assert.equal(check.ok, true, check.problems.join(" | "));
    assert.deepEqual(check.problems, []);
    const text = check.found.join("\n");
    assert.match(text, /Found the four corner marks and the code strip: test [0-9A-F]{5}, sheet 1 of 1, Letter paper\./);
    assert.match(text, /about 200 dots to the inch/);
    assert.match(text, /scanned at 200 dots to the inch, and the corner marks are spaced as a sheet printed at about 100 percent of its size/);
    assert.match(text, /29 of 29 questions read as blank/);
    assert.match(text, /printed circles show at 10\d percent/);
  });

  test("is happy with a blank copy of a test with several versions, whose version bubbles are all empty, and says when one is not", () => {
    // Found by the app: a blank copy of a two-version test was told that a version bubble read as marked or unclear, because the reader's
    // words for a student's sheet with no version marked ("No version bubble is marked") were taken as a fault of the copy.
    const several = mixed(30, { versions: 2 });
    const sheet = drawn(several, { dpi: 200 });
    const clean = checkPrinting(new SheetReader(several), sheet.render(), { dpi: 200 });
    assert.equal(clean.ok, true, clean.problems.join(" | "));
    const smudged = checkPrinting(new SheetReader(several), sheet.render({ versions: [{ version: 2, mark: { kind: "solid" } }] }), { dpi: 200 });
    assert.equal(smudged.ok, false);
    assert.match(smudged.problems.join(" "), /A version bubble reads as marked or unclear on a copy that should be blank/);
    // The questions are judged too, though which version this is stays unknown on a blank copy: the count is of every row the sheet carries.
    assert.match(clean.found.join(" "), /29 of 29 questions read as blank/);
    const dirtyRows = checkPrinting(new SheetReader(several), sheet.render({ answers: { 3: [{ place: 1, mark: { kind: "solid" } }], 9: [{ place: 0, mark: { kind: "light", darkness: 0.4 } }] } }), { dpi: 200 });
    assert.equal(dirtyRows.ok, false);
    assert.match(dirtyRows.problems.join(" "), /2 questions \(3, 9\) read as marked on a copy that should be blank/);
    assert.match(dirtyRows.found.join(" "), /27 of 29 questions read as blank/);
    const faintly = checkPrinting(new SheetReader(several), sheet.render({ versions: [{ version: 1, mark: { kind: "light", darkness: 0.3 } }] }), { dpi: 200 });
    assert.match(faintly.problems.join(" "), /A version bubble reads as marked or unclear/);
  });

  test("does not tell a picture at 150 dots to the inch, which measures a hair under, that 150 would be better", () => {
    const at150 = checkPrinting(reader, drawn(record, { dpi: 150 }).render(), { dpi: 150 });
    assert.equal(at150.ok, true, at150.problems.join(" | "));
    const at149 = checkPrinting(reader, drawn(record, { dpi: 144 }).render(), { dpi: 144 });
    assert.match(at149.problems.join(" "), /about 144 dots to the inch. It reads, but 150 or more is better/);
  });

  test("says when the sheet was printed smaller than it was made, from the dots to the inch the picture gives", () => {
    // The same picture, said to have been scanned at 190 dots to the inch: the marks then measure 8.4 mm, a sheet printed at 105 percent.
    const big = checkPrinting(reader, blank, { dpi: 190 });
    assert.equal(big.ok, false);
    assert.match(big.problems.join(" "), /printed at about 105 percent of its size/);
    const small = checkPrinting(reader, blank, { dpi: 211 });
    assert.match(small.problems.join(" "), /printed at about 95 percent/);
    assert.match(small.problems.join(" "), /100 percent \("actual size", not "fit to page"/);
    const silent = checkPrinting(reader, blank, {});
    assert.equal(silent.ok, true);
    assert.match(silent.found.join(" "), /does not say how many dots to the inch/);
  });

  test("says when the copy is not blank, and which questions read as marked", () => {
    const dirty = d.render({ answers: { 3: [{ place: 1, mark: { kind: "solid" } }], 9: [{ place: 0, mark: { kind: "light", darkness: 0.4 } }] } });
    const check = checkPrinting(reader, dirty, { dpi: 200 });
    assert.equal(check.ok, false);
    assert.match(check.problems.join(" "), /2 questions \(3, 9\) read as marked on a copy that should be blank/);
  });

  test("passes on the refusal of a picture that cannot be read, with its reason and cause", () => {
    const check = checkPrinting(reader, levels(blank, 150, 200), { dpi: 200 });
    assert.equal(check.ok, false);
    assert.equal(check.refusal?.cause, "corners");
    assert.match(check.problems[0] as string, /Four corner marks could not be found/);
    assert.deepEqual(check.found, []);
  });

  test("warns of a low resolution, a faint print and a black and white scan, which all read but could be better", () => {
    const low = checkPrinting(reader, drawn(record, { dpi: 110 }).render(), { dpi: 110 });
    assert.match(low.problems.join(" "), /about 110 dots to the inch\. It reads, but 150 or more is better/);
    // a faint print: thin lines come out pale and the solid corner marks do not, as when a printer is on toner saver
    const k = 200 / 25.4;
    const corners = cornerMarks(layoutFor(d.plan.paper, d.plan.style)).map((m) => m.center);
    const paleLines = { width: blank.width, height: blank.height, data: blank.data.slice() } as GreyImage;
    for (let y = 0; y < blank.height; y++) {
      for (let x = 0; x < blank.width; x++) {
        if (corners.some((m) => Math.abs(x / k - m.x) < 6 && Math.abs(y / k - m.y) < 6)) continue;
        paleLines.data[y * blank.width + x] = 255 - (255 - (blank.data[y * blank.width + x] as number)) * 0.6;
      }
    }
    const faint = checkPrinting(reader, paleLines, { dpi: 200 });
    assert.equal(faint.ok, false);
    assert.match(faint.problems.join(" "), /printed circles are fainter than they should be\. Print the sheet darker/);
    const bw = checkPrinting(reader, toBilevel(blank, 140), { dpi: 200 });
    assert.match(bw.problems.join(" "), /black and white picture\. A black and white scan loses pale pencil/);
    assert.equal(checkPrinting(reader, blank, { dpi: 200 }).problems.length, 0, "and the sheet itself has none of these");
  });

  test("says when rows of circles are not where they should be", () => {
    const k = 200 / 25.4;
    const layout = layoutFor(d.plan.paper, d.plan.style);
    const row = slotRow(layout, 6);
    const shifted = { width: blank.width, height: blank.height, data: blank.data.slice() } as GreyImage;
    const dx = Math.round(1.4 * k);
    for (let y = Math.floor(row.y * k); y < Math.ceil((row.y + row.height) * k); y++) {
      for (let x = Math.ceil((row.x + row.width) * k) + dx; x >= Math.floor(row.x * k); x--) shifted.data[y * shifted.width + x + dx] = blank.data[y * blank.width + x] as number;
      for (let x = Math.floor(row.x * k); x < Math.floor(row.x * k) + dx; x++) shifted.data[y * shifted.width + x] = 255;
    }
    const check = checkPrinting(reader, shifted, { dpi: 200 });
    assert.equal(check.ok, false);
    assert.match(check.problems.join(" "), /printed circles of 1 row \(questions 7\) are not where they should be/);
  });

  test("reads a sheet of several versions and a sheet for one version, and says which", () => {
    const many = testOf([mcq(4), mcq(4), mcq(5)], { versions: 2 });
    const own = checkPrinting(new SheetReader(many), drawn(many, { dpi: 150, version: 2 }).render(), { dpi: 150 });
    assert.match(own.found.join(" "), /for version B/);
    const shared = checkPrinting(new SheetReader(many), drawn(many, { dpi: 150 }).render(), { dpi: 150 });
    // This once expected the shared sheet to fail ("on a blank copy none is marked"). That was the defect: on a blank copy no version bubble
    // is filled, which is what a blank copy is, and the words about a student's unmarked version were being said of a copy with nothing wrong.
    assert.equal(shared.ok, true, shared.problems.join(" | "));
    assert.doesNotMatch(shared.problems.join(" "), /version bubble/);
  });
});
