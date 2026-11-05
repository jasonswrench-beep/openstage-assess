/**
 * Reading a page of a sheet end to end, from a picture of a sheet with known marks: the answers, the version, the flags, and every
 * reason the reader gives for refusing a page.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { blur, crop, levels, quarterTurn, rotate, toBilevel, placeInFrame } from "../src/sheets/damage.ts";
import { cornerMarks, layoutFor, slotBubbles, slotRow, codeCells, type PaperName } from "../src/sheets/geometry.ts";
import type { GreyImage } from "../src/sheets/image.ts";
import { SheetReader, decideAll, isBilevel, MIN_DPI, type SheetReading } from "../src/sheets/read.ts";
import type { SheetMarks } from "../src/sheets/raster.ts";
import { drawn, essayq, mcq, mixed, mrq, testOf, tfq } from "./support/sheet-fixtures.ts";

/** A solid mark for each question number listed, in the place given: `{ 1: 2 }` is question 1, place C. */
const marks = (places: Record<number, number | number[]>, more: SheetMarks = {}): SheetMarks => ({
  ...more,
  answers: { ...Object.fromEntries(Object.entries(places).map(([q, p]) => [q, ([] as number[]).concat(p).map((place) => ({ place, mark: { kind: "solid" as const } }))])), ...(more.answers ?? {}) },
});

const ok = (r: ReturnType<SheetReader["read"]>): SheetReading => {
  assert.ok(r.ok, r.ok ? "" : `${r.cause}: ${r.reason}`);
  return r;
};
const refused = (r: ReturnType<SheetReader["read"]>): { cause: string; reason: string } => {
  assert.equal(r.ok, false, "the page should have been refused");
  return r.ok ? { cause: "", reason: "" } : { cause: r.cause, reason: r.reason };
};

describe("reading a sheet", () => {
  test("reads the answer in each question, for choice, true or false and several answers, with the fill of every bubble", () => {
    const record = testOf([mcq(4), tfq(), mrq(5), mcq(5), essayq(), mcq(3)]);
    const { render } = drawn(record);
    const reading = ok(new SheetReader(record).read(render(marks({ 1: 2, 2: 1, 3: [0, 3], 4: 4, 6: 0 }))));
    assert.deepEqual(reading.questions.map((q) => [q.number, q.status, q.marked]), [
      [1, "answered", [2]],
      [2, "answered", [1]],
      [3, "answered", [0, 3]],
      [4, "answered", [4]],
      [5, "notOnSheet", []],
      [6, "answered", [0]],
    ]);
    assert.equal(reading.version, 1);
    assert.equal(reading.versionSource, "single");
    assert.deepEqual(Object.keys(reading.fills).map(Number), [1, 2, 3, 4, 6], "a fill for every question the sheet carries, and none for the essay");
    assert.equal((reading.fills[3] as number[]).length, 5);
    assert.ok((reading.fills[1] as number[])[2]! > 0.6 && (reading.fills[1] as number[])[0]! < 0.05);
    assert.deepEqual(reading.flags, []);
    assert.equal(reading.code.test, record.fingerprint);
    assert.ok(Math.abs(reading.quality.dpi - 150) < 1);
    assert.equal(reading.quality.bilevel, false);
    assert.deepEqual(reading.notes, []);
  });

  test("reads a sheet of every paper and style: Letter, A4, wide and large print", () => {
    const cases: Array<[string, ReturnType<typeof testOf>, { paper: PaperName; large?: boolean }]> = [
      ["letter", mixed(30), { paper: "letter" }],
      ["a4", mixed(30), { paper: "a4" }],
      ["wide", testOf([mcq(4), mcq(8), mcq(6), mcq(5), mcq(7)]), { paper: "letter" }],
      ["large print", testOf(Array.from({ length: 12 }, () => mcq(5))), { paper: "a4", large: true }],
    ];
    for (const [name, record, options] of cases) {
      const d = drawn(record, { ...options, dpi: 150 });
      const answers = Object.fromEntries(Array.from({ length: Math.min(record.questions.length, 12) }, (_x, i) => [i + 1, (d.plan.uses.A?.[i]?.places ?? 1) - 1]));
      const reading = ok(new SheetReader(record).read(d.render(marks(answers))));
      for (const q of reading.questions) {
        if (q.status === "notOnSheet") continue;
        if (q.number <= 12) {
          assert.equal(q.status, "answered", `${name}, question ${q.number}`);
          assert.deepEqual(q.marked, [(d.plan.uses.A?.[q.number - 1]?.places ?? 1) - 1], `${name}, question ${q.number}`);
        } else assert.equal(q.status, "blank", `${name}, question ${q.number} was left empty`);
      }
      assert.equal(reading.code.paper, options.paper);
      assert.equal(reading.code.large, options.large ?? false);
    }
  });

  test("reads a blank copy as every question blank and flagged for a quick confirm, and an essay as not on the sheet", () => {
    const record = mixed(30);
    const reading = ok(new SheetReader(record).read(drawn(record).render()));
    const counts = new Map<string, number>();
    for (const q of reading.questions) counts.set(q.status, (counts.get(q.status) ?? 0) + 1);
    assert.equal(counts.get("blank"), 29);
    assert.equal(counts.get("notOnSheet"), 1);
    assert.equal(counts.get("answered") ?? 0, 0);
    assert.equal(reading.flags.length, 29);
    assert.ok(reading.flags.every((f) => f.kind === "blank" && f.reason === "No bubble is marked."));
    assert.ok(reading.questions.every((q) => q.rect.width > 0 && q.rect.height > 0), "each carries the part of the sheet to show");
  });

  test("flags two marks on one answer, a light mark and a smudge, and records the rest", () => {
    const record = mixed(20);
    const reading = ok(
      new SheetReader(record).read(
        drawn(record).render({
          answers: {
            1: [{ place: 1, mark: { kind: "solid" } }],
            2: [{ place: 0, mark: { kind: "solid" } }, { place: 2, mark: { kind: "solid" } }],
            3: [{ place: 3, mark: { kind: "light", darkness: 0.4 } }],
            5: [{ place: 1, mark: { kind: "solid" } }, { place: 3, mark: { kind: "erased", darkness: 0.3 } }],
            6: [{ place: 2, mark: { kind: "tick" } }],
            7: [{ place: 1, mark: { kind: "solid" } }],
          },
        }),
      ),
    );
    const by = (n: number) => reading.questions.find((q) => q.number === n) as SheetReading["questions"][number];
    assert.equal(by(1).status, "answered");
    assert.equal(by(2).kind, "multiple");
    assert.equal(by(3).kind, "faint");
    assert.equal(by(5).kind, "faint", "a smudge beside the answer");
    assert.equal(by(6).kind, "faint", "a tick");
    assert.equal(by(7).status, "answered");
    assert.deepEqual(reading.flags.filter((f) => f.kind !== "blank").map((f) => f.question), [2, 3, 5, 6]);
    assert.ok(reading.flags.every((f) => f.page === 1 && f.rect.height > 0));
  });

  test("flags a mark in a bubble the version's question does not have, and reads the version's own places", () => {
    // Two versions with the questions in another order: a place that is a five answer question in one is a four answer question in the other.
    const record = testOf([mcq(4), mcq(5), mcq(4), mcq(5)], { versions: 2, questionOrder: "shuffled", seed: "beyond" });
    const d = drawn(record);
    const a = d.plan.uses.A as Array<{ places: number }>;
    const b = d.plan.uses.B as Array<{ places: number }>;
    const slot = a.findIndex((u, i) => u.places === 5 && (b[i] as { places: number }).places === 4);
    assert.ok(slot >= 0, "the shuffle puts a five answer question where the other version has four");
    const reading = ok(new SheetReader(record).read(d.render({ answers: { [slot + 1]: [{ place: 4, mark: { kind: "solid" } }] }, versions: [{ version: 2, mark: { kind: "solid" } }] })));
    assert.equal(reading.version, 2);
    const q = reading.questions.find((x) => x.number === slot + 1) as SheetReading["questions"][number];
    assert.equal(q.status, "flagged");
    assert.equal(q.kind, "beyond");
    assert.match(q.reason as string, /bubble E, which this version's question does not have/);
    // the same mark on a version-A sheet is an answer
    const asA = ok(new SheetReader(record).read(d.render({ answers: { [slot + 1]: [{ place: 4, mark: { kind: "solid" } }] }, versions: [{ version: 1, mark: { kind: "solid" } }] })));
    assert.deepEqual((asA.questions.find((x) => x.number === slot + 1) as SheetReading["questions"][number]).marked, [4]);
  });
});

describe("the version of a sheet", () => {
  const record = testOf([mcq(4), mcq(4), tfq(), mcq(5)], { versions: 3, questionOrder: "kept" });
  const d = drawn(record);
  const reader = new SheetReader(record);

  test("is the bubble the student filled, from A to C", () => {
    for (const version of [1, 2, 3]) {
      const reading = ok(reader.read(d.render({ answers: {}, versions: [{ version, mark: { kind: "solid" } }] })));
      assert.equal(reading.version, version);
      assert.equal(reading.versionSource, "bubble");
      assert.equal(reading.versionFills?.length, 3, "only the bubbles the test has");
    }
  });

  test("is not settled when no version bubble is marked, two are, or one is only faint, and the sheet says so and reads no question", () => {
    const none = ok(reader.read(d.render({ answers: { 1: [{ place: 0, mark: { kind: "solid" } }] } })));
    assert.equal(none.version, undefined);
    assert.deepEqual(none.questions, [], "nothing is decided before the version is");
    assert.deepEqual(none.flags.map((f) => f.kind), ["version"]);
    assert.match(none.flags[0]?.reason as string, /No version bubble is marked/);
    assert.ok((none.fills[1] as number[])[0]! > 0.6, "but every bubble was measured, so settling the version needs no rescan");
    const two = ok(reader.read(d.render({ versions: [{ version: 1, mark: { kind: "solid" } }, { version: 3, mark: { kind: "solid" } }] })));
    assert.match(two.flags[0]?.reason as string, /More than one version bubble is marked \(A, C\)/);
    const faint = ok(reader.read(d.render({ versions: [{ version: 2, mark: { kind: "light", darkness: 0.4 } }] })));
    assert.equal(faint.version, undefined);
    assert.match(faint.flags[0]?.reason as string, /lightly or in part/);
  });

  test("can be decided again for a settled version without a rescan", () => {
    const reading = ok(reader.read(d.render({ answers: { 1: [{ place: 3, mark: { kind: "solid" } }], 4: [{ place: 4, mark: { kind: "solid" } }] } })));
    const layout = layoutFor(d.plan.paper, d.plan.style);
    const settled = decideAll(d.plan, 1, 1, layout, reading.fills);
    assert.equal(settled.find((q) => q.number === 1)?.status, "answered");
    assert.deepEqual(settled.find((q) => q.number === 1)?.marked, [3]);
    assert.equal(settled.find((q) => q.number === 4)?.status, "answered");
  });

  test("is the sheet's own code when it was printed for one version, whatever the student did", () => {
    const own = drawn(record, { version: 3 });
    const reading = ok(reader.read(own.render({ answers: { 1: [{ place: 0, mark: { kind: "solid" } }] }, versions: [{ version: 1, mark: { kind: "solid" } }] })));
    assert.equal(reading.version, 3);
    assert.equal(reading.versionSource, "code");
    assert.equal(reading.code.version, 3);
    assert.equal(reading.versionFills, undefined);
  });
});

describe("a test of many questions", () => {
  test("reads each page of a sheet of two pages as its own, with the numbers the booklet has", () => {
    const record = testOf(Array.from({ length: 130 }, () => mcq(4)));
    const pages = [1, 2].map((page) => ({ page, d: drawn(record, { page, dpi: 100 }) }));
    const reader = new SheetReader(record);
    const answers: Record<number, number> = {};
    for (let q = 1; q <= 130; q++) answers[q] = q % 4;
    const [one, two] = pages.map(({ d }) => ok(reader.read(d.render(marks(answers)))));
    assert.deepEqual([one?.code.page, one?.code.pages, two?.code.page, two?.code.pages], [1, 2, 1 + 1, 2]);
    assert.equal(one?.questions.length, 100);
    assert.equal(two?.questions.length, 30);
    assert.equal(two?.questions[0]?.number, 101);
    assert.ok([...(one?.questions ?? []), ...(two?.questions ?? [])].every((q) => q.status === "answered" && q.marked[0] === q.number % 4));
  });
});

describe("reading pictures that are not perfect", () => {
  const record = mixed(40, { versions: 2 });
  const d = drawn(record, { dpi: 150 });
  const reader = new SheetReader(record);
  const answers: Record<number, number> = {};
  for (let q = 1; q <= 40; q++) if (q !== 4) answers[q] = q % 4;
  const picture = d.render(marks(answers, { versions: [{ version: 2, mark: { kind: "solid" } }] }));
  const wrong = (reading: SheetReading): number => reading.questions.filter((q) => q.status === "answered" && q.marked[0] !== q.number % 4).length;
  const right = (reading: SheetReading): number => reading.questions.filter((q) => q.status === "answered" && q.marked[0] === q.number % 4).length;

  test("reads a page turned on its side or upside down, and one that is skewed", () => {
    for (const [name, image] of [["quarter", quarterTurn(picture, 1)], ["half", quarterTurn(picture, 2)], ["three quarters", quarterTurn(picture, 3)], ["skewed 2.5", rotate(picture, 2.5, 220)], ["skewed -4", rotate(picture, -4, 40)]] as Array<[string, GreyImage]>) {
      const reading = ok(reader.read(image));
      assert.equal(reading.version, 2, name);
      assert.equal(wrong(reading), 0, name);
      assert.ok(right(reading) >= 35, `${name}: ${right(reading)} read`);
    }
  });

  test("reads a page photographed at an angle, blurred a little, and one that is dull", () => {
    const W = picture.width;
    const H = picture.height;
    const photo = placeInFrame(picture, [{ x: W * 0.08, y: H * 0.04 }, { x: W * 0.95, y: H * 0.09 }, { x: W * 0.9, y: H * 0.97 }, { x: W * 0.04, y: H * 0.93 }], W, H, 110);
    for (const [name, image] of [["photo", photo], ["blurred", blur(picture, 1.3)], ["dull", levels(picture, 40, 205, 1.1)]] as Array<[string, GreyImage]>) {
      const reading = ok(reader.read(image));
      assert.equal(wrong(reading), 0, name);
      assert.ok(right(reading) >= 33, `${name}: ${right(reading)} read`);
    }
  });

  test("says a black and white picture is one, and reads no question with several answers from it", () => {
    const grey = ok(reader.read(picture));
    assert.equal(grey.quality.bilevel, false);
    assert.equal(isBilevel(picture), false);
    const bw = toBilevel(blur(picture, 0.6), 140);
    assert.equal(isBilevel(bw), true);
    // a black and white scan saved as a JPEG has blacks that are nearly black and whites that are nearly white, and is still one
    const jittered = { width: bw.width, height: bw.height, data: bw.data.map((v, i) => (v === 0 ? (i * 7919) % 9 : 255 - ((i * 104729) % 9))) } as GreyImage;
    assert.equal(isBilevel(jittered), true);
    assert.equal(isBilevel({ width: bw.width, height: bw.height, data: bw.data.map((v, i) => (i % 4 === 0 ? 128 : v)) } as GreyImage), false, "with a quarter of its pixels grey it is not");
    const reading = ok(reader.read(bw));
    assert.equal(reading.quality.bilevel, true);
    assert.match(reading.notes.join(" "), /black and white/);
    const several = reading.questions.filter((q) => record.versions.length > 0 && q.kind === "bilevel");
    assert.ok(several.length > 0, "the questions with several answers are flagged");
    assert.equal(wrong(reading), 0);
    assert.ok(right(reading) >= 30, "and the rest are read");
  });

  test("flags a row whose circles are further from where they should be than the search can follow, and reads the other rows", () => {
    // Move one row of the picture 1.4 mm to the right, leaving the corner marks where they are.
    const layout = layoutFor(d.plan.paper, d.plan.style);
    const k = 150 / 25.4;
    const shifted = { width: picture.width, height: picture.height, data: picture.data.slice() } as GreyImage;
    const row = slotRow(layout, 6);
    const y0 = Math.floor(row.y * k);
    const y1 = Math.ceil((row.y + row.height) * k);
    const x0 = Math.floor(row.x * k);
    const x1 = Math.ceil((row.x + row.width) * k);
    const dx = Math.round(1.4 * k);
    for (let y = y0; y < y1; y++) {
      for (let x = x1 + dx; x >= x0; x--) shifted.data[y * shifted.width + x + dx] = picture.data[y * picture.width + x] as number;
      for (let x = x0; x < x0 + dx; x++) shifted.data[y * shifted.width + x] = 255;
    }
    const reading = ok(reader.read(shifted));
    assert.deepEqual(reading.unregistered, [7]);
    const q = reading.questions.find((x) => x.number === 7) as SheetReading["questions"][number];
    assert.equal(q.status, "flagged");
    assert.equal(q.kind, "registration");
    assert.equal(wrong(reading), 0);
    assert.ok(right(reading) >= 34);
  });

  test("reads in well under a second: a sheet of 100 questions at 200 dots to the inch", () => {
    const big = testOf(Array.from({ length: 100 }, () => mcq(4)), { versions: 1 });
    const bigPicture = drawn(big, { dpi: 200 }).render(marks(Object.fromEntries(Array.from({ length: 100 }, (_x, i) => [i + 1, i % 4]))));
    const bigReader = new SheetReader(big);
    bigReader.read(bigPicture);
    const t0 = performance.now();
    const reading = ok(bigReader.read(bigPicture));
    const ms = performance.now() - t0;
    assert.equal(reading.questions.filter((q) => q.status === "answered").length, 100);
    // The target is under a second on an ordinary laptop and a read takes about 50 ms, so this is the limit with room for a machine that is
    // busy with something else; the gate reports the median on a quiet one.
    assert.ok(ms < 3000, `${ms.toFixed(0)} ms`);
  });
});

describe("refusing a page, with the reason", () => {
  const record = mixed(30, { versions: 1 });
  const d = drawn(record, { dpi: 150 });
  const reader = new SheetReader(record);
  const picture = d.render(marks({ 1: 1, 2: 0 }));

  test("refuses a sheet from another test, naming both", () => {
    const other = mixed(30, { versions: 1, seed: "another" });
    const r = refused(new SheetReader(other).read(picture));
    assert.equal(r.cause, "test");
    assert.match(r.reason, /This sheet is from another test: its code says [0-9A-F]{5} and the test being scored is [0-9A-F]{5}/);
  });

  test("refuses a sheet printed in another layout than the test would print now, since the test was changed", () => {
    // The sheet is printed wide, for a question of seven answers; the test then has that question cut to four, and its fingerprint is as it was.
    const wideRecord = testOf([mcq(4), mcq(7), mcq(5)], { versions: 1 });
    const wide = drawn(wideRecord, { dpi: 150 }).render(marks({ 1: 1 }));
    assert.equal(ok(new SheetReader(wideRecord).read(wide)).code.layout, 2);
    const changed = structuredClone(wideRecord);
    const seven = changed.questions[1] as unknown as { body: { options: Array<{ id: string }> } };
    seven.body.options = seven.body.options.slice(0, 4);
    for (const v of changed.versions) v.options[(changed.questions[1] as { id: string }).id] = (v.options[(changed.questions[1] as { id: string }).id] as string[]).slice(0, 4);
    const r = refused(new SheetReader(changed).read(wide));
    assert.equal(r.cause, "test");
    assert.match(r.reason, /printed in a wide layout, and the test as it stands now would print a standard one/);
  });

  test("refuses a sheet that says the test has a different number of pages of answer sheet than the test now needs", () => {
    const hundred = testOf(Array.from({ length: 100 }, () => mcq(4)), { versions: 1 });
    const page = drawn(hundred, { dpi: 100 }).render(marks({ 1: 1 }));
    assert.equal(ok(new SheetReader(hundred).read(page)).code.pages, 1);
    // a question added after the sheet was printed: the fingerprint is as it was, the test now needs two pages
    const grown = structuredClone(hundred);
    const extra = { ...structuredClone(grown.questions[0] as (typeof grown.questions)[number]), id: "q_99999999999999999999999999" } as (typeof grown.questions)[number];
    grown.questions.push(extra);
    (grown.sections[0] as { questionIds: string[] }).questionIds.push(extra.id);
    for (const v of grown.versions) {
      v.order.push(extra.id);
      v.options[extra.id] = (extra as unknown as { body: { options: Array<{ id: string }> } }).body.options.map((o) => o.id);
    }
    const r = refused(new SheetReader(grown).read(page));
    assert.equal(r.cause, "test");
    assert.match(r.reason, /says the test has 1 page of answer sheet, and the test as it stands now needs 2/);
  });

  test("refuses corner marks that are not the size they are printed at", () => {
    // Each mark is made 12 mm square, with the white square in the top left one kept.
    const layout = layoutFor(d.plan.paper, d.plan.style);
    const k = 150 / 25.4;
    const big = { width: picture.width, height: picture.height, data: picture.data.slice() } as GreyImage;
    for (const m of cornerMarks(layout)) {
      for (let y = Math.floor((m.center.y - 6) * k); y < Math.ceil((m.center.y + 6) * k); y++) for (let x = Math.floor((m.center.x - 6) * k); x < Math.ceil((m.center.x + 6) * k); x++) big.data[y * big.width + x] = 0;
      if (m.hollow) for (let y = Math.floor((m.center.y - 1.5) * k); y < Math.ceil((m.center.y + 1.5) * k); y++) for (let x = Math.floor((m.center.x - 1.5) * k); x < Math.ceil((m.center.x + 1.5) * k); x++) big.data[y * big.width + x] = 255;
    }
    const r = refused(reader.read(big));
    assert.equal(r.cause, "shape");
    assert.match(r.reason, /corner marks measure 1[12]\.\d mm against the 8 mm they are printed at/);
  });

  test("refuses a code strip that is covered or written on, and says what the strip is", () => {
    const layout = layoutFor(d.plan.paper, d.plan.style);
    const k = 150 / 25.4;
    const spoiled = { width: picture.width, height: picture.height, data: picture.data.slice() } as GreyImage;
    // Four squares are turned over, black to white and white to black: which they are depends on the test's fingerprint, which is made fresh each run,
    // so painting them all black would change nothing on the one run in sixteen when they were black already.
    for (const cell of codeCells(layout).slice(20, 24)) {
      const wasBlack = (picture.data[Math.floor(cell.center.y * k) * picture.width + Math.floor(cell.center.x * k)] as number) < 128;
      for (let y = Math.floor((cell.center.y - 1.5) * k); y < Math.ceil((cell.center.y + 1.5) * k); y++) for (let x = Math.floor((cell.center.x - 1.5) * k); x < Math.ceil((cell.center.x + 1.5) * k); x++) spoiled.data[y * spoiled.width + x] = wasBlack ? 255 : 0;
    }
    const r = refused(reader.read(spoiled));
    assert.equal(r.cause, "code");
    assert.match(r.reason, /code strip could not be read: .*(damaged|does not start)/);
    assert.match(r.reason, /row of black and white squares across the top/);
  });

  test("refuses a picture with too few dots to the inch, a blurred one, and one with no contrast", () => {
    const small = drawn(record, { dpi: 70 }).render(marks({ 1: 1 }));
    const tiny = refused(reader.read(small));
    assert.equal(tiny.cause, "quality");
    assert.match(tiny.reason, new RegExp(`about 7\\d dots to the inch.*${MIN_DPI} is the least`));
    const soft = refused(reader.read(blur(picture, 3.6)));
    assert.equal(soft.cause, "quality");
    assert.match(soft.reason, /blurred/);
    const flat = refused(reader.read(levels(picture, 110, 165)));
    assert.equal(flat.cause, "quality");
    assert.match(flat.reason, /not much darker than the paper/);
    // and a picture so washed out that the marks are not seen at all is refused by the finder, which says why
    const washed = refused(reader.read(levels(picture, 150, 200)));
    assert.equal(washed.cause, "corners");
    assert.match(washed.reason, /too dark or too light to see/);
  });

  test("refuses a page whose grid is not where the corner marks say it is, and says what to do", () => {
    // The corner marks stay; everything between them is moved 2.3 mm to the right.
    const layout = layoutFor(d.plan.paper, d.plan.style);
    const k = 150 / 25.4;
    const dx = Math.round(2.3 * k);
    const shifted = { width: picture.width, height: picture.height, data: picture.data.slice() } as GreyImage;
    const top = Math.floor(70 * k);
    const bottom = Math.floor((layout.height - 28) * k);
    for (let y = top; y < bottom; y++) {
      for (let x = Math.floor(15 * k); x < Math.floor((layout.width - 15) * k); x++) shifted.data[y * shifted.width + x] = picture.data[y * picture.width + x - dx] as number;
    }
    const r = refused(reader.read(shifted));
    assert.equal(r.cause, "registration");
    assert.match(r.reason, /printed circles are not where this sheet has them/);
    assert.match(r.reason, /Check my printing/);
  });

  test("refuses what the corner finder refuses, with its reason", () => {
    assert.equal(refused(reader.read(crop(picture, 0, 0, 0, 400))).cause, "corners");
    const back = { width: picture.width, height: picture.height, data: new Uint8Array(picture.data.length) } as { width: number; height: number; data: Uint8Array };
    for (let y = 0; y < picture.height; y++) for (let x = 0; x < picture.width; x++) back.data[y * picture.width + x] = picture.data[y * picture.width + (picture.width - 1 - x)] as number;
    assert.equal(refused(reader.read(back as GreyImage)).cause, "mirrored");
    assert.equal(refused(reader.read({ width: 200, height: 200, data: new Uint8Array(40000).fill(255) })).cause, "small");
  });

  test("keeps a plan for each paper and style it is asked about, and plans a test as printed", () => {
    const a = reader.plan("letter", false);
    assert.equal(reader.plan("letter", false), a);
    assert.notEqual(reader.plan("a4", false), a);
    assert.ok(a.ok && a.plan.style === "standard");
    const large = reader.plan("letter", true);
    assert.ok(large.ok && large.plan.style === "large");
  });
});

/** Keeps the helpers this file imports from being reported as unused. */
export const __helpers = { slotBubbles };
