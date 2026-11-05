/**
 * A batch of pages as a class of sheets: pages put together into sheets, and the flags for what is wrong with the order they came in.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { assembleBatch, type BatchEntry } from "../src/sheets/batch.ts";
import { imageFingerprint, type GreyImage } from "../src/sheets/image.ts";
import { SheetReader } from "../src/sheets/read.ts";
import type { Refusal } from "../src/sheets/locate.ts";
import { drawn, mcq, testOf } from "./support/sheet-fixtures.ts";

// A test of 130 questions has two pages of sheet, and a test of 12 has one.
const long = testOf(Array.from({ length: 130 }, () => mcq(4)), { versions: 2 });
const short = testOf(Array.from({ length: 12 }, () => mcq(4)), { versions: 1 });

const pictures = (record: typeof long, version: number, marks: number): GreyImage[] => {
  const pages = Math.ceil(record.questions.length / 100);
  return Array.from({ length: pages }, (_x, i) => drawn(record, { dpi: 100, page: i + 1 }).render({ answers: { [1 + i * 100]: [{ place: marks % 4, mark: { kind: "solid" } }] }, versions: [{ version, mark: { kind: "solid" } }] }));
};

function entriesOf(record: typeof long, items: Array<{ image: GreyImage; file?: string; page?: number }>): BatchEntry[] {
  const reader = new SheetReader(record);
  return items.map((item, i) => ({ source: { file: item.file ?? "scan.pdf", page: item.page ?? i + 1 }, fingerprint: imageFingerprint(item.image), result: reader.read(item.image) }));
}

const refusal: Refusal = { ok: false, cause: "corners", reason: "Four corner marks could not be found" };

describe("putting pages into sheets", () => {
  test("makes a sheet of each page for a test of one page, numbered by place in the batch", () => {
    const images = [0, 1, 2].map((m) => drawn(short, { dpi: 100 }).render({ answers: { 1: [{ place: m, mark: { kind: "solid" } }] } }));
    const batch = assembleBatch(entriesOf(short, images.map((image) => ({ image }))), 1);
    assert.deepEqual(batch.sheets.map((s) => [s.number, s.pages.length, s.pages[0]?.entry]), [[1, 1, 0], [2, 1, 1], [3, 1, 2]]);
    assert.deepEqual(batch.flags, []);
    assert.deepEqual(batch.duplicates, []);
  });

  test("puts a page 1 and its page 2 together, and says nothing when the batch is in order", () => {
    const a = pictures(long, 1, 0);
    const b = pictures(long, 2, 1);
    const batch = assembleBatch(entriesOf(long, [...a, ...b].map((image) => ({ image }))), 2);
    assert.equal(batch.sheets.length, 2);
    assert.deepEqual(batch.sheets.map((s) => s.pages.map((p) => p?.entry)), [[0, 1], [2, 3]]);
    assert.deepEqual(batch.flags, []);
    assert.equal(batch.sheets[0]?.version, 1);
    assert.equal(batch.sheets[1]?.version, 2);
  });
});

describe("a sheet of three pages", () => {
  const triple = testOf(Array.from({ length: 250 }, () => mcq(4)), { versions: 1 });
  const three = [1, 2, 3].map((page) => drawn(triple, { dpi: 100, page }).render({ answers: { [(page - 1) * 100 + 1]: [{ place: page, mark: { kind: "solid" } }] } }));

  test("puts the three pages together in order, without a flag", () => {
    const batch = assembleBatch(entriesOf(triple, three.map((image) => ({ image }))), 3);
    assert.deepEqual(batch.sheets.map((s) => s.pages.map((p) => p?.entry)), [[0, 1, 2]]);
    assert.deepEqual(batch.flags, []);
  });

  test("puts a page 3 that came before its page 2 into its sheet, and says they were not in order", () => {
    const batch = assembleBatch(entriesOf(triple, [three[0], three[2], three[1]].map((image) => ({ image: image as GreyImage }))), 3);
    assert.equal(batch.sheets.length, 1);
    assert.deepEqual(batch.sheets[0]?.pages.map((p) => p?.entry), [0, 2, 1]);
    assert.deepEqual(batch.flags.map((f) => f.kind), ["page-order"]);
    assert.match(batch.flags[0]?.reason as string, /is page 3 of sheet 1, and came before page 2\. The pages are not in order/);
  });

  test("starts a new sheet for a page 3 that has no place in the sheet in hand", () => {
    const batch = assembleBatch(entriesOf(triple, [three[0], three[1], three[2], three[2]].map((image, i) => ({ image: i === 3 ? (drawn(triple, { dpi: 100, page: 3 }).render({ answers: { 201: [{ place: 0, mark: { kind: "solid" } }] } })) : (image as GreyImage) }))), 3);
    assert.equal(batch.sheets.length, 2);
    assert.deepEqual(batch.flags.map((f) => f.kind), ["page-order", "missing-page"]);
  });
});

describe("the checks that run on a batch", () => {
  test("flags the same picture twice, and does not count the second, so a sheet is not scored twice", () => {
    const images = [0, 1].map((m) => drawn(short, { dpi: 100 }).render({ answers: { 1: [{ place: m, mark: { kind: "solid" } }] } }));
    const batch = assembleBatch(entriesOf(short, [{ image: images[0] as GreyImage, file: "a.png", page: 1 }, { image: images[1] as GreyImage, file: "b.png", page: 1 }, { image: images[0] as GreyImage, file: "c.png", page: 1 }]), 1);
    assert.equal(batch.sheets.length, 2, "the second copy is not a sheet");
    assert.deepEqual(batch.duplicates, [2]);
    assert.deepEqual(batch.flags.map((f) => [f.kind, f.entries]), [["duplicate", [0, 2]]]);
    assert.match(batch.flags[0]?.reason as string, /c\.png, page 1 is the same picture as a\.png, page 1\. It was not counted again/);
  });

  test("tells a different picture from the same one, even when only the marks differ", () => {
    const a = drawn(short, { dpi: 100 }).render({ answers: { 1: [{ place: 0, mark: { kind: "solid" } }] } });
    const b = drawn(short, { dpi: 100 }).render({ answers: { 1: [{ place: 1, mark: { kind: "solid" } }] } });
    assert.notEqual(imageFingerprint(a), imageFingerprint(b));
    assert.deepEqual(assembleBatch(entriesOf(short, [{ image: a }, { image: b }]), 1).duplicates, []);
  });

  test("flags a page 1 with no page 2 after it, and a page 2 with no page 1 before it", () => {
    const [a1, a2] = pictures(long, 1, 0) as [GreyImage, GreyImage];
    const [b1, b2] = pictures(long, 2, 1) as [GreyImage, GreyImage];
    // a1 is alone (its page 2 never came), then b1 and b2 are a sheet, then a2 is alone (its page 1 never came)
    const batch = assembleBatch(entriesOf(long, [a1, b1, b2, a2].map((image) => ({ image }))), 2);
    assert.equal(batch.sheets.length, 3);
    const missing = batch.flags.filter((f) => f.kind === "missing-page");
    assert.equal(missing.length, 2);
    assert.match(missing[0]?.reason as string, /Sheet 1 has 1 of its 2 pages: page 2 did not come/);
    assert.match(missing[1]?.reason as string, /Sheet 3 has 1 of its 2 pages: page 1 did not come/);
    const order = batch.flags.filter((f) => f.kind === "page-order");
    assert.equal(order.length, 1);
    assert.match(order[0]?.reason as string, /is page 2 and there is no page 1 before it/);
  });

  test("puts a page 2 that came before its page 1 together with it, and says the pages were out of order", () => {
    const [a1, a2] = pictures(long, 1, 0) as [GreyImage, GreyImage];
    const batch = assembleBatch(entriesOf(long, [a2, a1].map((image) => ({ image }))), 2);
    assert.equal(batch.sheets.length, 1);
    assert.deepEqual(batch.sheets[0]?.pages.map((p) => p?.entry), [1, 0]);
    assert.deepEqual(batch.flags.map((f) => f.kind), ["page-order"]);
    assert.equal(batch.flags.some((f) => f.kind === "missing-page"), false, "nothing is missing in the end");
  });

  test("starts a new sheet when a page 1 comes where a page 2 was expected, and says the first sheet lacks it", () => {
    const [a1] = pictures(long, 1, 0) as [GreyImage];
    const [b1, b2] = pictures(long, 1, 3) as [GreyImage, GreyImage];
    const batch = assembleBatch(entriesOf(long, [a1, b1, b2].map((image) => ({ image }))), 2);
    assert.deepEqual(batch.sheets.map((s) => s.pages.map((p) => p?.entry)), [[0, undefined], [1, 2]]);
    assert.deepEqual(batch.flags.map((f) => [f.kind, f.sheet]), [["missing-page", 1]]);
  });

  test("flags the pages of a sheet that name different versions", () => {
    const [a1] = pictures(long, 1, 0) as [GreyImage, GreyImage];
    const [, b2] = pictures(long, 2, 1) as [GreyImage, GreyImage];
    const batch = assembleBatch(entriesOf(long, [a1, b2].map((image) => ({ image }))), 2);
    assert.equal(batch.sheets.length, 1);
    assert.deepEqual(batch.flags.map((f) => f.kind), ["version-mismatch"]);
    assert.match(batch.flags[0]?.reason as string, /do not name the same version \(A and B\)/);
    assert.equal(batch.sheets[0]?.version, undefined, "no version is claimed for a sheet whose pages disagree");
  });

  test("holds a page that could not be read where it would have been, and says so", () => {
    const [a1, a2] = pictures(long, 1, 0) as [GreyImage, GreyImage];
    const reader = new SheetReader(long);
    const entries: BatchEntry[] = [
      { source: { file: "scan.pdf", page: 1 }, fingerprint: imageFingerprint(a1), result: reader.read(a1) },
      { source: { file: "scan.pdf", page: 2 }, fingerprint: "unreadable", result: refusal },
      { source: { file: "scan.pdf", page: 3 }, fingerprint: imageFingerprint(a2), result: reader.read(a2) },
    ];
    const batch = assembleBatch(entries, 2);
    // page 1 and the unreadable page make one sheet; the third picture, a page 2, has no page 1 before it
    assert.deepEqual(batch.sheets.map((s) => s.pages.map((p) => [p?.entry, p?.refused])), [[[0, false], [1, true]], [[undefined, undefined], [2, false]]]);
    const refused = batch.flags.find((f) => f.kind === "refused");
    assert.match(refused?.reason as string, /scan\.pdf, page 2 was not read \(Four corner marks could not be found\) and is held as page 2 of sheet 1/);
  });

  test("makes a sheet of a refused page when it is the first of a batch, and handles an empty batch", () => {
    const only = assembleBatch([{ source: { file: "x.png", page: 1 }, fingerprint: "x", result: refusal }], 1);
    assert.equal(only.sheets.length, 1);
    assert.equal(only.sheets[0]?.pages[0]?.refused, true);
    assert.deepEqual(assembleBatch([], 2), { sheets: [], flags: [], duplicates: [] });
    assert.throws(() => assembleBatch([], 0), /at least one page/);
  });
});
