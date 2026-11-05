/**
 * What goes on the answer sheet, and the printed file itself. The rules under test: a sheet carries multiple choice, multiple
 * response and true or false questions and keeps the number of every other kind with no bubbles; one sheet serves every version, so
 * it shows the most bubbles any version needs in a place and labels a place T and F only when it is true or false in every version;
 * and the PDF has every mark where the geometry says, measured from the file's own drawing commands and not from the printer's
 * code: four corner marks (the top left hollow), a code strip that reads back as the sheet's code, bubbles at the centres the
 * geometry gives, and nothing within 10 mm of the paper's edge.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { createQuestion } from "../src/model/create.ts";
import { plainToRich } from "../src/model/richtext.ts";
import type { Question, QuestionBody, QuestionType } from "../src/model/question.ts";
import { createTest, type TestRecord } from "../src/model/test.ts";
import { measureText } from "../src/print/pdf.ts";
import { decodeCode, type SheetCode } from "../src/sheets/code.ts";
import {
  CODE_CELL,
  FOOTER_RISE,
  FOOTER_TEXT_HEIGHT,
  HOLLOW_SIZE,
  MARK_INSET,
  MARK_SIZE,
  PAPER_MM,
  codeCells,
  cornerMarks,
  exampleMarks,
  instructionArea,
  layoutFor,
  nameBox,
  slotBubbles,
  slotNumberAnchor,
  versionBubbles,
  type PaperName,
  type SheetLayout,
} from "../src/sheets/geometry.ts";
import { planSheet, useOf, type SheetPlan } from "../src/sheets/plan.ts";
import { printSheet, sheetCode, type SheetInput } from "../src/sheets/print.ts";
import { isCircle, paths, readSheetPdf, rects, texts, type ReadPage } from "./support/pdf-ops.ts";

const AT = "2026-01-01T00:00:00.000Z";
let made = 0;
const opt = (id: string, text: string, correct = false) => ({ id, content: plainToRich(text), correct });
const make = (type: QuestionType, body: QuestionBody, stem: string): Question => createQuestion({ type, stem: plainToRich(stem), body, by: "t", at: AT, id: `q_${String(++made).padStart(26, "0")}` });
const mc = (n: number, stem = "Which one?", right = 0): Question => make("multipleChoice", { shuffle: true, options: Array.from({ length: n }, (_x, i) => opt(`o${i + 1}`, `Answer ${i + 1}`, i === right)) }, stem);
const mr = (n: number): Question => make("multipleResponse", { shuffle: true, partialCredit: false, options: Array.from({ length: n }, (_x, i) => opt(`o${i + 1}`, `Answer ${i + 1}`, i < 2)) }, "Which apply?");
const tf = (stem = "A statement."): Question => make("trueFalse", { correct: true }, stem);
const essay = (): Question => make("essay", {}, "Discuss.");

const record = (questions: Question[], more: Partial<Parameters<typeof createTest>[0]> = {}): TestRecord => createTest({ name: "Quiz 1", questions, versions: 1, seed: "sheet", at: AT, ...more });
const planOf = (r: TestRecord, more: Parameters<typeof planSheet>[1] = {}): SheetPlan => {
  const planned = planSheet(r, more);
  assert.ok(planned.ok, planned.ok ? "" : planned.reason);
  return planned.plan;
};
const input = (r: TestRecord, more: Partial<SheetInput> = {}): SheetInput => ({ title: "Quiz 1", fingerprint: r.fingerprint, versions: r.versions.length, ...more });
const sheet = (r: TestRecord, more: Parameters<typeof planSheet>[1] = {}, inputMore: Partial<SheetInput> = {}): { plan: SheetPlan; layout: SheetLayout; pages: ReadPage[]; bytes: Uint8Array } => {
  const plan = planOf(r, more);
  const layout = layoutFor(plan.paper, plan.style);
  const printed = printSheet(plan, input(r, inputMore), new Date(AT));
  return { plan, layout, pages: readSheetPdf(printed.bytes), bytes: printed.bytes };
};
const near = (a: number, b: number, tolerance = 0.01): boolean => Math.abs(a - b) <= tolerance;

/** A mix a sheet can mostly carry: five answers, four, true or false, several answers, and an essay it cannot. */
const mixed = (): Question[] => [mc(4, "One"), mc(5, "Two"), tf("Three"), mr(5), essay(), mc(3, "Six"), tf("Seven")];

describe("what a question needs of a sheet", () => {
  test("multiple choice, multiple response and true or false have bubbles, and nothing else does", () => {
    assert.equal(useOf(mc(4)).kind, "choice");
    assert.equal(useOf(mc(4)).places, 4);
    assert.equal(useOf(mr(5)).kind, "multiple");
    assert.equal(useOf(mr(5)).places, 5);
    assert.deepEqual([useOf(tf()).kind, useOf(tf()).places], ["trueFalse", 2]);
    for (const q of [essay(), make("shortAnswer", { caseSensitive: false, accepted: ["x"] }, "Name it."), make("numeric", { mode: "exact", value: 1 }, "How many?"), make("fillInBlank", { caseSensitive: false, blanks: [{ id: "b1", accepted: ["x"] }] }, "A ____."), make("matching", { shuffle: true, distractors: [], pairs: [{ id: "p1", left: plainToRich("a"), right: "1" }, { id: "p2", left: plainToRich("b"), right: "2" }] }, "Match."), make("ordering", { items: [{ id: "i1", content: plainToRich("A"), position: 1 }, { id: "i2", content: plainToRich("B"), position: 2 }] }, "Order.")]) {
      const use = useOf(q);
      assert.deepEqual([use.kind, use.places], ["none", 0], q.type);
      assert.match(use.why ?? "", /cannot carry/, q.type);
    }
  });

  test("a question with fewer than two answers or more than eight has none, with the reason", () => {
    assert.match(useOf(mc(1)).why ?? "", /fewer than two/);
    assert.equal(useOf(mc(8)).places, 8);
    assert.match(useOf(mc(9)).why ?? "", /9 answers, and a sheet holds at most 8/);
  });

  test("a question with no usable key still has its bubbles: it is read, and never scored", () => {
    const noKey = make("multipleChoice", { shuffle: true, options: [opt("o1", "A"), opt("o2", "B")] }, "No key?");
    assert.equal(useOf(noKey).kind, "choice");
    assert.equal(useOf(noKey).places, 2);
  });
});

describe("planning a sheet", () => {
  test("is a standard sheet of five places when no question has more", () => {
    const plan = planOf(record(mixed()));
    assert.deepEqual([plan.style, plan.large, plan.pages, plan.paper], ["standard", false, 1, "letter"]);
    assert.deepEqual(plan.drawn.map((d) => d.places), [4, 5, 2, 5, 0, 3, 2]);
    assert.deepEqual(plan.drawn[0]?.labels, ["A", "B", "C", "D"]);
    assert.deepEqual(plan.drawn[2]?.labels, ["T", "F"], "true or false in every version is labelled T and F");
    assert.deepEqual(plan.drawn[4]?.labels, [], "a question a sheet cannot carry has no labels");
  });

  test("is a wide sheet when a question has six to eight answers, and a standard one when none does", () => {
    const plan = planOf(record([mc(4), mc(7), mc(8)]));
    assert.equal(plan.style, "wide");
    assert.deepEqual(plan.drawn.map((d) => d.places), [4, 7, 8]);
    assert.equal(planOf(record([mc(5), mc(2)])).style, "standard");
    assert.equal(planOf(record([mc(4), mc(6)])).style, "wide", "six answers is the least that needs a wide sheet");
  });

  test("is a large print sheet when asked, and refuses one for a question of more than five answers", () => {
    assert.equal(planOf(record([mc(5)]), { large: true }).style, "large");
    const refused = planSheet(record([mc(6)]), { large: true });
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? "" : refused.reason, /large print sheet has 5 bubbles to a question, and this test has a question of 6 answers/);
  });

  test("counts pages, and refuses a test that needs more than eight", () => {
    assert.equal(planOf(record(Array.from({ length: 100 }, () => mc(4)))).pages, 1);
    assert.equal(planOf(record(Array.from({ length: 101 }, () => mc(4)))).pages, 2);
    assert.equal(planOf(record(Array.from({ length: 800 }, () => tf()))).pages, 8);
    const refused = planSheet(record(Array.from({ length: 801 }, () => tf())));
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? "" : refused.reason, /801 questions, which is 9 pages of answer sheet, and a test has at most 8/);
    assert.equal(planOf(record(Array.from({ length: 51 }, () => mc(4))), { large: true }).pages, 1);
    assert.equal(planOf(record(Array.from({ length: 52 }, () => mc(4))), { large: true }).pages, 2);
    assert.equal(planOf(record([...Array.from({ length: 50 }, () => mc(4)), mc(7)])).pages, 2, "a wide sheet is 50 to a page");
  });

  test("says what each version holds in each place, and prints the most any version needs", () => {
    const questions = [mc(4, "Four"), mc(5, "Five"), tf("TF")];
    const r = record(questions, { versions: 2, questionOrder: "shuffled" });
    const plan = planOf(r);
    const a = plan.uses["A"]!.map((u) => u.places);
    const b = plan.uses["B"]!.map((u) => u.places);
    assert.deepEqual(a, [4, 5, 2]);
    assert.notDeepEqual(b, a, "version B has the questions in another order");
    assert.deepEqual(plan.drawn.map((d) => d.places), a.map((x, i) => Math.max(x, b[i] as number)));
    assert.equal(plan.uses["C"], undefined, "version C was not made");
  });

  test("labels a place T and F only when it is true or false in every version, and otherwise letters it and says so", () => {
    const uniform = planOf(record([tf("One"), tf("Two"), mc(4)], { versions: 3 }));
    assert.equal(uniform.lettersForTrueFalse, false);
    assert.deepEqual(uniform.drawn[0]?.labels, ["T", "F"]);

    const shuffled = planOf(record([tf("One"), mc(4, "Two")], { versions: 2, questionOrder: "shuffled" }));
    assert.equal(shuffled.lettersForTrueFalse, true, "a place that is true or false in one version and a choice in the other");
    assert.deepEqual(shuffled.drawn.map((d) => d.labels), [["A", "B", "C", "D"], ["A", "B", "C", "D"]]);
  });

  test("keeps the number of a question it cannot carry, and says so", () => {
    const plan = planOf(record(mixed()));
    assert.equal(plan.notes.length, 1);
    assert.match(plan.notes[0] as string, /Question 5 has no bubbles: a bubble sheet cannot carry this kind of question/);
    assert.equal(plan.drawn.length, 7, "every question keeps a place");
  });

  test("says it for every version when questions are shuffled, naming the version, and keeps the one version's words as they were", () => {
    const r = record([essay(), tf(), mc(4), mc(4)], { versions: 3, questionOrder: "shuffled" });
    const plan = planOf(r);
    assert.equal(plan.notes.length, 3, "one for each version, since the essay stands at another number in some");
    ["A", "B", "C"].forEach((label, i) => assert.match(plan.notes[i] as string, new RegExp(`^In version ${label}, question \\d has no bubbles: a bubble sheet cannot carry this kind of question`)));
    const at = (label: "A" | "B" | "C") => (plan.uses[label] as Array<{ kind: string }>).findIndex((u) => u.kind === "none") + 1;
    assert.ok(new Set([at("A"), at("B"), at("C")]).size > 1, "the essay is at different numbers, so the note could not be written from version A alone");
    assert.ok(plan.notes.every((note, i) => note.includes(`question ${at(["A", "B", "C"][i] as "A")} has`)));
  });
});

describe("the printed sheet", () => {
  test("is a PDF with a valid cross reference table, one page for every 100 questions, and the paper's size", () => {
    for (const paper of ["letter", "a4"] as PaperName[]) {
      const { bytes, pages } = sheet(record(Array.from({ length: 130 }, () => mc(4))), { paper });
      const text = Buffer.from(bytes).toString("latin1");
      assert.ok(text.startsWith("%PDF-1.4"));
      assert.ok(text.trimEnd().endsWith("%%EOF"));
      const xref = Number(/startxref\n(\d+)/.exec(text)?.[1]);
      assert.ok(text.slice(xref).startsWith("xref"));
      const table = text.slice(xref).split("\n").slice(3);
      table.slice(0, 5 + 2 * pages.length).forEach((line, i) => {
        const offset = Number(line.slice(0, 10));
        assert.ok(text.slice(offset).startsWith(`${i + 1} 0 obj`), `object ${i + 1}`);
      });
      assert.equal(pages.length, 2);
      assert.equal(Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(text)?.[1]), 2, "the page tree counts its pages");
      for (const page of pages) {
        assert.ok(near(page.widthMm, PAPER_MM[paper].width, 0.05), paper);
        assert.ok(near(page.heightMm, PAPER_MM[paper].height, 0.05), paper);
      }
    }
  });

  test("draws four corner marks 8 mm square at the geometry's places, and a white square in the middle of the top left", () => {
    for (const paper of ["letter", "a4"] as PaperName[]) {
      const { pages, layout } = sheet(record(mixed()), { paper });
      const marks = rects(pages[0] as ReadPage).filter((r) => near(r.width, MARK_SIZE) && near(r.height, MARK_SIZE) && r.mode === "fill" && r.gray === 0);
      assert.equal(marks.length, 4);
      for (const mark of cornerMarks(layout)) {
        assert.ok(marks.some((r) => near(r.x + r.width / 2, mark.center.x) && near(r.y + r.height / 2, mark.center.y)), `${mark.corner} on ${paper}`);
      }
      const hollow = rects(pages[0] as ReadPage).filter((r) => near(r.width, HOLLOW_SIZE) && near(r.height, HOLLOW_SIZE) && r.gray === 1);
      assert.equal(hollow.length, 1, "one white square");
      assert.ok(near(hollow[0]!.x + HOLLOW_SIZE / 2, 16) && near(hollow[0]!.y + HOLLOW_SIZE / 2, 16), "in the middle of the top left mark");
    }
  });

  test("draws a code strip that reads back, from the squares in the file, as the sheet's own code", () => {
    for (const [paper, style] of [["letter", "standard"], ["a4", "standard"], ["letter", "wide"]] as Array<[PaperName, "standard" | "wide"]>) {
      const r = record(style === "wide" ? [mc(7), ...mixed()] : mixed(), { versions: 3 });
      const { pages, layout, plan } = sheet(r, { paper });
      const cells = codeCells(layout);
      const squares = rects(pages[0] as ReadPage).filter((q) => near(q.width, CODE_CELL) && near(q.height, CODE_CELL) && q.mode === "fill" && q.gray === 0 && near(q.y + q.height / 2, 16));
      const bits = cells.map((c) => squares.some((q) => near(q.x + q.width / 2, c.center.x) && near(q.y + q.height / 2, c.center.y)));
      assert.equal(squares.length, bits.filter(Boolean).length, "no square that is not on a cell");
      const read = decodeCode(bits);
      assert.ok(read.ok, read.ok ? "" : read.reason);
      assert.deepEqual(read.ok && read.code, sheetCode(plan, input(r), 1));
      assert.equal(read.ok && read.code.test, r.fingerprint);
      assert.equal(read.ok && read.code.paper, paper);
      assert.equal(read.ok && read.code.version, 0, "the shared sheet");
      // Said in numbers here and not through sheetCode, which the printer itself uses: a wide sheet is layout 2, the others layout 1.
      assert.equal(read.ok && read.code.layout, style === "wide" ? 2 : 1);
      assert.equal(read.ok && read.code.large, false);
      assert.deepEqual(read.ok && [read.code.page, read.code.pages], [1, 1]);
    }
    const large = sheet(record(mixed()), { large: true });
    const squares = rects(large.pages[0] as ReadPage).filter((q) => near(q.width, CODE_CELL) && near(q.height, CODE_CELL) && q.mode === "fill" && q.gray === 0 && near(q.y + q.height / 2, 16));
    const read = decodeCode(codeCells(large.layout).map((c) => squares.some((q) => near(q.x + q.width / 2, c.center.x))));
    assert.ok(read.ok && read.code.large && read.code.layout === 1 && read.code.paper === "letter", "a large print sheet says so in its code");
  });

  test("a sheet of two pages numbers them in the code, and each page holds its own questions", () => {
    const questions = Array.from({ length: 150 }, (_x, i) => (i % 3 === 0 ? tf(`Statement ${i}`) : mc(4, `Question ${i}`)));
    const r = record(questions);
    const { pages, layout, plan } = sheet(r);
    assert.equal(pages.length, 2);
    pages.forEach((page, p) => {
      const squares = rects(page).filter((q) => near(q.width, CODE_CELL) && q.gray === 0 && q.mode === "fill" && near(q.y + q.height / 2, 16));
      const bits = codeCells(layout).map((c) => squares.some((q) => near(q.x + q.width / 2, c.center.x)));
      const read = decodeCode(bits);
      assert.ok(read.ok);
      assert.deepEqual(read.ok && [read.code.page, read.code.pages], [p + 1, 2]);
      const numbers = texts(page).filter((t) => /^\d+\.$/.test(t.text)).map((t) => Number(t.text.slice(0, -1)));
      assert.deepEqual(numbers, p === 0 ? Array.from({ length: 100 }, (_x, i) => i + 1) : Array.from({ length: 50 }, (_x, i) => i + 101));
    });
    assert.deepEqual(plan.drawn.length, 150);
  });

  test("puts every bubble at the centre the geometry gives, with the right size, and the right number in each place", () => {
    for (const [paper, extra] of [["letter", []], ["a4", []], ["letter", [mc(8)]], ["a4", [mc(7)]]] as Array<[PaperName, Question[]]>) {
      const r = record([...extra, ...mixed(), ...Array.from({ length: 40 }, (_x, i) => (i % 2 ? mc(4) : tf()))]);
      const { pages, layout, plan } = sheet(r, { paper });
      const grid = paths(pages[0] as ReadPage).filter((p) => isCircle(p) && p.mode === "stroke" && near(p.box.width, layout.bubbleDiameter) && p.center.y > layout.gridTop);
      const expected = plan.drawn.slice(0, layout.questionsPerPage).flatMap((d, slot) => slotBubbles(layout, slot).slice(0, d.places));
      assert.equal(grid.length, expected.length, `${paper} ${plan.style}: the number of bubbles`);
      for (const c of expected) assert.ok(grid.some((p) => near(p.center.x, c.x) && near(p.center.y, c.y)), `${paper} ${plan.style}: a bubble at ${c.x.toFixed(2)}, ${c.y.toFixed(2)}`);
      // no bubble that is not on the geometry
      for (const p of grid) assert.ok(expected.some((c) => near(p.center.x, c.x) && near(p.center.y, c.y)));
    }
  });

  test("letters each bubble inside it, T and F where the place is true or false in every version", () => {
    const r = record([mc(4, "One"), tf("Two"), mc(5, "Three")]);
    const { pages, layout, plan } = sheet(r);
    const letters = texts(pages[0] as ReadPage).filter((t) => /^[A-HTF]$/.test(t.text));
    plan.drawn.forEach((d, slot) => {
      slotBubbles(layout, slot).slice(0, d.places).forEach((c, p) => {
        const inside = letters.filter((t) => Math.abs(t.x + measureText(t.text, t.size) / (72 / 25.4) / 2 - c.x) < 0.3 && t.y > c.y && t.y < c.y + 2);
        assert.equal(inside.length, 1, `slot ${slot} place ${p}`);
        assert.equal(inside[0]!.text, d.labels[p]);
        assert.ok(inside[0]!.gray >= 0.5, "light grey, so it does not read as ink");
      });
    });
  });

  test("numbers every question, right-aligned in its own space, and says to answer a question it cannot carry in the booklet", () => {
    const { pages, layout, plan } = sheet(record(mixed()));
    plan.drawn.forEach((d, slot) => {
      const label = texts(pages[0] as ReadPage).find((t) => t.text === `${slot + 1}.`);
      assert.ok(label, `the number ${slot + 1}`);
      const anchor = slotNumberAnchor(layout, slot);
      const width = measureText(label!.text, label!.size) / (72 / 25.4);
      assert.ok(near(label!.x + width, anchor.x, 0.05), `question ${slot + 1} is right-aligned at the anchor`);
      assert.ok(near(label!.y, anchor.y + 1, 0.05));
      const inRow = paths(pages[0] as ReadPage).filter((p) => isCircle(p) && near(p.center.y, anchor.y) && p.center.x > anchor.x);
      assert.equal(inRow.length, d.places, `question ${slot + 1} has ${d.places} bubbles in its row`);
    });
    const note = texts(pages[0] as ReadPage).filter((t) => t.text === "answer in the booklet");
    assert.equal(note.length, 1);
    assert.ok(near(note[0]!.y, slotNumberAnchor(layout, 4).y + 1, 0.05), "in question 5's row");
  });

  test("draws the version bubbles on a shared sheet for a test of several versions, and none for one version", () => {
    const several = record(mixed(), { versions: 3 });
    const { pages, layout } = sheet(several);
    const bubbles = paths(pages[0] as ReadPage).filter((p) => isCircle(p) && p.mode === "stroke" && near(p.center.y, 41));
    assert.equal(bubbles.length, 3);
    versionBubbles(layout).slice(0, 3).forEach((v) => assert.ok(bubbles.some((p) => near(p.center.x, v.center.x) && near(p.center.y, v.center.y)), v.label));
    assert.ok(texts(pages[0] as ReadPage).some((t) => t.text === "Version"));
    assert.deepEqual(["A", "B", "C"].map((l) => texts(pages[0] as ReadPage).some((t) => t.text === l && near(t.y, 41.9, 0.5))), [true, true, true]);

    const one = sheet(record(mixed()));
    assert.equal(paths(one.pages[0] as ReadPage).filter((p) => isCircle(p) && near(p.center.y, 41)).length, 0);
    assert.ok(!texts(one.pages[0] as ReadPage).some((t) => t.text === "Version"));
  });

  test("a sheet printed for one version has no version bubbles, names the version, and says it in its code", () => {
    const r = record(mixed(), { versions: 3 });
    const { pages, layout, plan } = sheet(r, {}, { version: 3 });
    assert.equal(paths(pages[0] as ReadPage).filter((p) => isCircle(p) && near(p.center.y, 41)).length, 0);
    assert.ok(texts(pages[0] as ReadPage).some((t) => t.text === "Version C" && t.font === "F2"));
    const squares = rects(pages[0] as ReadPage).filter((q) => near(q.width, CODE_CELL) && q.gray === 0 && near(q.y + q.height / 2, 16));
    const read = decodeCode(codeCells(layout).map((c) => squares.some((q) => near(q.x + q.width / 2, c.center.x))));
    assert.deepEqual(read.ok && read.code.version, 3);
    assert.deepEqual(read.ok && read.code, sheetCode(plan, input(r, { version: 3 }), 1));
  });

  test("draws the name box unless it is left off, and never reads it: it is a plain outline", () => {
    const r = record(mixed());
    const withBox = sheet(r);
    const box = nameBox(withBox.layout);
    const outlines = (p: ReadPage) => rects(p).filter((q) => q.mode === "stroke" && near(q.width, box.width) && near(q.height, box.height));
    assert.equal(outlines(withBox.pages[0] as ReadPage).length, 1);
    assert.ok(near(outlines(withBox.pages[0] as ReadPage)[0]!.x, box.x) && near(outlines(withBox.pages[0] as ReadPage)[0]!.y, box.y));
    assert.ok(texts(withBox.pages[0] as ReadPage).some((t) => t.text === "Name"));
    const without = sheet(r, {}, { nameBox: false });
    assert.equal(outlines(without.pages[0] as ReadPage).length, 0);
    assert.ok(!texts(without.pages[0] as ReadPage).some((t) => t.text === "Name"));
  });

  test("shows a mark to copy and three not to make, at the geometry's places, and never as a grid bubble", () => {
    const { pages, layout } = sheet(record(mixed()));
    const page = pages[0] as ReadPage;
    for (const m of exampleMarks(layout)) {
      assert.ok(paths(page).some((p) => isCircle(p) && p.mode === "stroke" && near(p.center.x, m.center.x) && near(p.center.y, m.center.y)), m.kind);
    }
    const captions = texts(page).filter((t) => /^(Right|Not a tick|Not a cross|Not half)$/.test(t.text)).map((t) => t.text);
    assert.deepEqual(captions, ["Right", "Not a tick", "Not a cross", "Not half"]);
    // the right mark is a filled disc, the half one a half disc: the two filled shapes in the examples
    const filled = paths(page).filter((p) => p.mode === "fill" && p.center.y < 70 && p.center.y > 50);
    assert.equal(filled.length, 2);
    assert.ok(filled.some((p) => p.curves === 4) && filled.some((p) => p.curves === 2), "a disc and a half disc");
    assert.ok(layout.gridTop > 70);
  });

  test("says what the instructions need to say, and only that", () => {
    const lines = (r: TestRecord): string[] => texts(sheet(r).pages[0] as ReadPage).filter((t) => t.size === 7.5).map((t) => t.text);
    const plain = lines(record([mc(4), mc(4)]));
    assert.ok(plain.join(" ").includes("Fill the bubble completely"));
    assert.ok(!plain.join(" ").includes("select all that apply"));
    assert.ok(!plain.join(" ").includes("A is True"));
    assert.ok(!plain.join(" ").includes("booklet"));
    assert.ok(lines(record([mr(4)])).join(" ").includes("select all that apply"));
    assert.ok(lines(record([essay(), mc(4)])).join(" ").includes("answered in the test booklet"));
    assert.ok(lines(record([tf(), mc(4)], { versions: 2, questionOrder: "shuffled" })).join(" ").includes("A is True and B is False"));
    // Every line fits the space left for it, between the left margin and the marks to copy: the longest runs to four lines when all four notes apply.
    for (const paper of ["letter", "a4"] as PaperName[]) {
      const r = record([essay(), mr(4), tf(), mc(4)], { versions: 2, questionOrder: "shuffled" });
      const { pages, layout } = sheet(r, { paper });
      const instructions = texts(pages[0] as ReadPage).filter((t) => t.size === 7.5);
      assert.ok(instructions.length >= 5, "the notes wrap onto more lines than there are notes");
      assert.ok(instructions.map((t) => t.text).join(" ").includes("answered in the test booklet"), "an essay that stands where another version has a choice question still gets the note");
      for (const t of instructions) assert.ok(t.x + measureText(t.text, 7.5) / (72 / 25.4) <= instructionArea(layout).x + instructionArea(layout).width + 0.01, `${paper}: "${t.text}" fits`);
    }
  });

  test("says under the grid where to mark, on every page, clear of the last row and of the marks below", () => {
    const line = "Mark only inside the bubbles, and only between the four black squares.";
    for (const [questions, large] of [[130, false], [60, true]] as Array<[number, boolean]>) {
      const { pages, layout } = sheet(record(Array.from({ length: questions }, () => mc(5))), { large });
      assert.equal(pages.length, 2);
      for (const page of pages) {
        const found = texts(page).filter((t) => t.text === line);
        assert.equal(found.length, 1);
        assert.ok(near(found[0]!.y, layout.height - FOOTER_RISE));
        assert.ok(found[0]!.y < layout.height - MARK_INSET - MARK_SIZE, "above the bottom marks");
        const lowest = Math.max(...paths(page).filter((p) => isCircle(p) && p.center.y > layout.gridTop).map((p) => p.box.y + p.box.height));
        assert.ok(lowest + 3 < found[0]!.y - FOOTER_TEXT_HEIGHT, `${large ? "large" : "standard"}: the last row ends at ${lowest.toFixed(1)}, and the line's letters start at ${(found[0]!.y - FOOTER_TEXT_HEIGHT).toFixed(1)}`);
      }
    }
  });

  test("keeps everything it draws at least 10 mm from the paper's edge, except nothing: the corner marks are 12 mm in", () => {
    for (const paper of ["letter", "a4"] as PaperName[]) {
      for (const [extra, large] of [[[], false], [[mc(8)], false], [[], true]] as Array<[Question[], boolean]>) {
        const r = record([...extra, ...mixed(), ...Array.from({ length: 120 }, (_x, i) => (i % 3 ? mc(5) : tf()))], { versions: 4 });
        const { pages } = sheet(r, { paper, large }, {});
        const { widthMm, heightMm } = pages[0] as ReadPage;
        for (const page of pages) {
          for (const s of page.shapes) {
            const box =
              s.kind === "rect"
                ? { x: s.x, y: s.y, width: s.width, height: s.height }
                : s.kind === "path"
                  ? s.box
                  : { x: s.x, y: s.y - s.size / (72 / 25.4), width: measureText(s.text, s.size) / (72 / 25.4), height: s.size / (72 / 25.4) };
            assert.ok(box.x >= 10 - 0.01 && box.y >= 10 - 0.01 && box.x + box.width <= widthMm - 10 + 0.01 && box.y + box.height <= heightMm - 10 + 0.01, `${paper}: a ${s.kind} at ${box.x.toFixed(1)}, ${box.y.toFixed(1)} (${box.width.toFixed(1)} by ${box.height.toFixed(1)})`);
          }
        }
      }
    }
  });

  test("a wide sheet draws two columns of 25, a large print sheet three of 17 with 7 mm bubbles", () => {
    const wide = sheet(record(Array.from({ length: 60 }, (_x, i) => (i === 3 ? mc(8) : mc(4)))));
    assert.equal(wide.plan.style, "wide");
    assert.equal(wide.pages.length, 2);
    const columns = (page: ReadPage, layout: SheetLayout): number => new Set(paths(page).filter((p) => isCircle(p) && p.center.y > layout.gridTop).map((p) => Math.floor(slotColumnOf(layout, p.center.x)))).size;
    assert.equal(columns(wide.pages[0] as ReadPage, wide.layout), 2);
    const large = sheet(record(Array.from({ length: 60 }, () => mc(5))), { large: true });
    assert.equal(large.plan.style, "large");
    assert.equal(large.pages.length, 2);
    const big = paths(large.pages[0] as ReadPage).filter((p) => isCircle(p) && p.center.y > large.layout.gridTop && p.mode === "stroke");
    assert.equal(big.length, 51 * 5);
    assert.ok(big.every((p) => near(p.box.width, 7)));
    assert.equal(columns(large.pages[0] as ReadPage, large.layout), 3);
  });

  test("prints the title safely, whatever is in it, and the same file every time", () => {
    const r = record(mixed());
    const printed = (title: string) => readSheetPdf(printSheet(planOf(r), { ...input(r), title }, new Date(AT)).bytes)[0] as ReadPage;
    const title = texts(printed("Quiz (1) \\ Café 中")).find((t) => t.size === 13);
    assert.equal(title?.text, "Quiz (1) \\ Café ?");
    const again = printSheet(planOf(r), input(r), new Date(AT)).bytes;
    assert.deepEqual(Buffer.from(printSheet(planOf(r), input(r), new Date(AT)).bytes), Buffer.from(again));
    assert.notDeepEqual(Buffer.from(printSheet(planOf(record(mixed(), { seed: "another" })), input(record(mixed(), { seed: "another" })), new Date(AT)).bytes), Buffer.from(again));
  });

  test("says in words which test and which sheet a page is, so a loose sheet can be put with its own", () => {
    const r = record(Array.from({ length: 150 }, () => mc(4)), { versions: 2 });
    const { pages } = sheet(r);
    const hex = r.fingerprint.toString(16).toUpperCase().padStart(5, "0");
    assert.ok(texts(pages[0] as ReadPage).some((t) => t.text === `Test ${hex}   Sheet 1 of 2`));
    assert.ok(texts(pages[1] as ReadPage).some((t) => t.text === `Test ${hex}   Sheet 2 of 2`));
    const one = sheet(record(mixed(), { versions: 3 }), {}, { version: 2 });
    assert.ok(texts(one.pages[0] as ReadPage).some((t) => /Sheet 1 of 1 {3}Version B$/.test(t.text)));
  });
});

/** Which column of the grid an x position is in. */
function slotColumnOf(layout: SheetLayout, x: number): number {
  const width = layout.numberWidth + layout.places * layout.placePitch + layout.columnGap;
  return (x - layout.gridLeft) / width;
}

/** A SheetCode exported for type checks in this file only. */
export type { SheetCode };
