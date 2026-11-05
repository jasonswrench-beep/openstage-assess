/**
 * The sheet drawn as pixels, and the damage done to a picture on purpose. These are the test harness's own tools, so they are tested the
 * same way as the reader: against what they are meant to produce, measured from outside.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { encodeCode } from "../src/sheets/code.ts";
import { blur, crop, jpegBlocks, levels, noise, photocopy, placeInFrame, quarterTurn, rotate, shade, speckle, toBilevel, warp } from "../src/sheets/damage.ts";
import { MARK_SIZE, codeCells, cornerMarks, layoutFor, slotBubbles, versionBubbles } from "../src/sheets/geometry.ts";
import { newImage, sample, type GreyImage } from "../src/sheets/image.ts";
import { sheetCode } from "../src/sheets/print.ts";
import { drawn, mixed, solid, testOf, mcq } from "./support/sheet-fixtures.ts";

/** The mean grey in a disc of a radius in millimetres round a point in millimetres, at a resolution. */
function meanAt(image: GreyImage, dpi: number, x: number, y: number, radius: number): number {
  const k = dpi / 25.4;
  let sum = 0;
  let n = 0;
  for (let j = -Math.ceil(radius * k); j <= Math.ceil(radius * k); j++) {
    for (let i = -Math.ceil(radius * k); i <= Math.ceil(radius * k); i++) {
      if (Math.hypot(i / k, j / k) <= radius) {
        sum += sample(image, x * k + i + 0.5, y * k + j + 0.5);
        n++;
      }
    }
  }
  return sum / n;
}

describe("the sheet drawn as pixels", () => {
  test("is the size of the paper at the resolution asked for", () => {
    for (const [paper, dpi] of [["letter", 150], ["a4", 200], ["letter", 300]] as const) {
      const { raster } = drawn(mixed(10), { paper, dpi });
      const image = raster.render();
      assert.equal(image.width, Math.round(((paper === "letter" ? 215.9 : 210) / 25.4) * dpi));
      assert.equal(image.height, Math.round(((paper === "letter" ? 279.4 : 297) / 25.4) * dpi));
    }
    assert.throws(() => drawn(mixed(10), { dpi: 20 }), /50 to 600/);
  });

  test("has solid black corner marks, with a white square in the middle of the top left one only", () => {
    const { raster, plan } = drawn(mixed(20), { dpi: 200 });
    const image = raster.render();
    const layout = layoutFor(plan.paper, plan.style);
    for (const m of cornerMarks(layout)) {
      const body = meanAt(image, 200, m.center.x + MARK_SIZE * 0.34, m.center.y, 0.8);
      assert.ok(body < 10, `${m.corner} body ${body}`);
      const middle = meanAt(image, 200, m.center.x, m.center.y, 0.6);
      if (m.hollow) assert.ok(middle > 245, `hollow middle ${middle}`);
      else assert.ok(middle < 10, `${m.corner} middle ${middle}`);
    }
  });

  test("draws the code strip as the sheet's own code says, a black square for each 1", () => {
    const { raster, plan, record } = drawn(mixed(20, { versions: 2 }), { dpi: 200 });
    const image = raster.render();
    const layout = layoutFor(plan.paper, plan.style);
    const bits = encodeCode(sheetCode(plan, { title: "Quiz", fingerprint: record.fingerprint, versions: 2 }, 1));
    for (const cell of codeCells(layout)) {
      const grey = meanAt(image, 200, cell.center.x, cell.center.y, 1.0);
      assert.ok(bits[cell.index] ? grey < 10 : grey > 245, `cell ${cell.index}: ${grey}`);
    }
  });

  test("draws each bubble as a thin outline round a pale inside, and nothing between the bubbles", () => {
    const { raster, plan } = drawn(mixed(20), { dpi: 200 });
    const image = raster.render();
    const layout = layoutFor(plan.paper, plan.style);
    const centres = slotBubbles(layout, 1);
    for (const c of centres.slice(0, 4)) {
      const inside = meanAt(image, 200, c.x, c.y, layout.bubbleDiameter * 0.35);
      assert.ok(inside > 225, `inside ${inside}`);
      // the outline is a ring half a bubble out from its centre
      const ring = Math.min(...Array.from({ length: 24 }, (_x, k) => sample(image, ((c.x + (layout.bubbleDiameter / 2) * Math.cos((k * Math.PI) / 12)) / 25.4) * 200, ((c.y + (layout.bubbleDiameter / 2) * Math.sin((k * Math.PI) / 12)) / 25.4) * 200)));
      assert.ok(ring < 120, `outline ${ring}`);
      assert.ok(meanAt(image, 200, c.x, c.y + layout.rowPitch / 2, 0.4) > 245, "paper between the rows");
    }
  });

  test("puts a student's pencil on the bubble it is for, darkening it and nothing near it", () => {
    const record = mixed(20);
    const { render, plan } = drawn(record, { dpi: 200 });
    const layout = layoutFor(plan.paper, plan.style);
    const blank = render();
    const marked = render(solid([1, 0, 2, 3, 0, 1, 0, 1, 0, 1]));
    const filled = slotBubbles(layout, 0)[1] as { x: number; y: number };
    const next = slotBubbles(layout, 0)[2] as { x: number; y: number };
    assert.ok(meanAt(marked, 200, filled.x, filled.y, 1.5) < 100, "the filled bubble is dark");
    assert.ok(meanAt(blank, 200, filled.x, filled.y, 1.5) > 225, "and was pale");
    assert.ok(meanAt(marked, 200, next.x, next.y, 1.5) > 225, "the next one is untouched");
    // a render does not leave its marks behind for the next: the same sheet blank again is the same picture
    assert.deepEqual(Array.from(render().data), Array.from(blank.data));
  });

  test("draws every kind of mark with the ink the kind has: a solid fill darkest, a tick, a cross and a smudge lightest", () => {
    const { render, plan } = drawn(mixed(12), { dpi: 200 });
    const layout = layoutFor(plan.paper, plan.style);
    const kinds = ["solid", "scribble", "light", "offcenter", "tick", "cross", "half", "erased"] as const;
    const image = render({ answers: Object.fromEntries(kinds.map((kind, i) => [i + 5, [{ place: 1, mark: { kind } }]])), seed: "kinds" });
    const centre = (i: number): { x: number; y: number } => slotBubbles(layout, i + 4)[1] as { x: number; y: number };
    const darkness = Object.fromEntries(kinds.map((kind, i) => [kind, 255 - meanAt(image, 200, centre(i).x, centre(i).y, 1.7)]));
    assert.ok((darkness.solid as number) > 150);
    assert.ok((darkness.solid as number) > (darkness.scribble as number));
    assert.ok((darkness.scribble as number) > (darkness.light as number));
    assert.ok((darkness.light as number) > (darkness.cross as number));
    assert.ok((darkness.half as number) > 60 && (darkness.half as number) < (darkness.solid as number));
    assert.ok((darkness.tick as number) > 15 && (darkness.tick as number) < 80);
    assert.ok((darkness.erased as number) > 15 && (darkness.erased as number) < 100, "a smudge is pale");
    // an off-centre mark is moved a millimetre to the right by default: dark at +1.4 mm, where a centred one would reach, and light at -1.4 mm
    const o = centre(3);
    assert.ok(meanAt(image, 200, o.x + 1.4, o.y, 0.4) + 80 < meanAt(image, 200, o.x - 1.4, o.y, 0.4), `${meanAt(image, 200, o.x + 1.4, o.y, 0.4)} against ${meanAt(image, 200, o.x - 1.4, o.y, 0.4)}`);
  });

  test("draws the marks of the same seed the same way, and another seed another way", () => {
    const { render } = drawn(mixed(12), { dpi: 150 });
    const a = render({ ...solid([0, 1, 2, 0]), seed: "one" });
    const b = render({ ...solid([0, 1, 2, 0]), seed: "one" });
    const c = render({ ...solid([0, 1, 2, 0]), seed: "two" });
    assert.deepEqual(Array.from(a.data), Array.from(b.data));
    assert.notDeepEqual(Array.from(a.data), Array.from(c.data));
  });

  test("marks only the page it is asked for, and the version bubbles by version", () => {
    const record = mixed(130, { versions: 2 });
    const page1 = drawn(record, { dpi: 100, page: 1 });
    const page2 = drawn(record, { dpi: 100, page: 2 });
    const layout = layoutFor(page1.plan.paper, page1.plan.style);
    const marks = { answers: { 1: [{ place: 0, mark: { kind: "solid" as const } }], 101: [{ place: 0, mark: { kind: "solid" as const } }] }, versions: [{ version: 2, mark: { kind: "solid" as const } }] };
    const one = page1.render(marks);
    const two = page2.render(marks);
    const first = slotBubbles(layout, 0)[0] as { x: number; y: number };
    assert.ok(meanAt(one, 100, first.x, first.y, 1.5) < 100, "question 1 is on page 1");
    assert.ok(meanAt(two, 100, first.x, first.y, 1.5) < 100, "question 101 is the first on page 2");
    const second = versionBubbles(layout)[1] as { center: { x: number; y: number } };
    assert.ok(meanAt(one, 100, second.center.x, second.center.y, 1.5) < 100, "version B is filled on page 1");
  });

  test("shows the sheet of a test of one question, and a large print sheet", () => {
    const one = drawn(testOf([mcq(4)]), { dpi: 100 }).render();
    assert.ok(one.data.some((v) => v < 50));
    const large = drawn(testOf(Array.from({ length: 10 }, () => mcq(5))), { dpi: 100, large: true });
    assert.equal(large.plan.style, "large");
    assert.ok(large.render().data.some((v) => v < 50));
  });
});

describe("damage done to a picture on purpose", () => {
  const striped = (): GreyImage => {
    const image = newImage(60, 40, 255);
    for (let y = 0; y < 40; y++) for (let x = 20; x < 30; x++) image.data[y * 60 + x] = 0;
    return image;
  };

  test("moves a picture by a transform, with the background where the page is not", () => {
    const image = striped();
    const out = warp(image, [1, 0, 10, 0, 1, 5, 0, 0, 1], 80, 60, 128);
    assert.equal(out.data[5 * 80 + 10 + 25], 0, "the stripe moved right 10 and down 5");
    assert.equal(out.data[0], 128, "the background");
    assert.equal(out.data[10 * 80 + 12], 255, "the page itself");
    assert.throws(() => warp(image, [0, 0, 0, 0, 0, 0, 0, 0, 1], 10, 10), /cannot be undone/);
  });

  test("turns a page by an angle onto a frame big enough for it, and by quarter turns exactly", () => {
    const image = striped();
    const turned = rotate(image, 90);
    assert.ok(Math.abs(turned.width - 40) <= 2 && Math.abs(turned.height - 60) <= 2);
    const quarter = quarterTurn(image, 1);
    assert.deepEqual([quarter.width, quarter.height], [40, 60]);
    assert.equal(quarter.data[25 * 40 + 39], 0, "the stripe at x 25 goes to row 25 at the right edge");
    assert.deepEqual(Array.from(quarterTurn(image, 4).data), Array.from(image.data));
    assert.deepEqual(Array.from(quarterTurn(quarterTurn(image, 1), 3).data), Array.from(image.data));
    assert.deepEqual(Array.from(quarterTurn(image, -1).data), Array.from(quarterTurn(image, 3).data));
  });

  test("puts a page in a frame so that its corners land where they are sent", () => {
    const image = newImage(100, 100, 255);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) image.data[y * 100 + x] = 0;
    const out = placeInFrame(image, [{ x: 50, y: 20 }, { x: 150, y: 30 }, { x: 140, y: 130 }, { x: 40, y: 120 }], 200, 160, 200);
    assert.ok((out.data[26 * 200 + 55] as number) < 50, "the black corner is where the top left was sent");
    assert.equal(out.data[2 * 200 + 2], 200, "and the frame beyond is background");
    assert.throws(() => placeInFrame(image, [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }], 10, 10), /do not make a shape/);
  });

  test("crops by distances from each side", () => {
    const out = crop(striped(), 20, 5, 30, 5);
    assert.deepEqual([out.width, out.height], [10, 30]);
    assert.equal(out.data[0], 0);
  });

  test("blurs without changing the average, and a blur of nothing is the same picture", () => {
    const image = striped();
    assert.equal(blur(image, 0), image);
    const out = blur(image, 2);
    const mean = (i: GreyImage): number => i.data.reduce((s, v) => s + v, 0) / i.data.length;
    assert.ok(Math.abs(mean(out) - mean(image)) < 3);
    assert.ok((out.data[20 * 60 + 18] as number) < 255 && (out.data[20 * 60 + 18] as number) > 0, "an edge is soft");
  });

  test("adds noise, specks and shade the same way for the same seed", () => {
    const image = newImage(80, 80, 200);
    const a = noise(image, 10, "x");
    assert.deepEqual(Array.from(a.data), Array.from(noise(image, 10, "x").data));
    assert.notDeepEqual(Array.from(a.data), Array.from(noise(image, 10, "y").data));
    const sd = Math.sqrt(a.data.reduce((s, v) => s + (v - 200) ** 2, 0) / a.data.length);
    assert.ok(sd > 7 && sd < 13, `standard deviation ${sd}`);
    const dusty = speckle(image, 30, 4, "s");
    assert.ok(dusty.data.some((v) => v < 150));
    assert.deepEqual(Array.from(dusty.data), Array.from(speckle(image, 30, 4, "s").data));
    const lit = shade(newImage(100, 10, 200), 0.4, 0);
    assert.ok((lit.data[0] as number) > (lit.data[99] as number) + 40, "darker on one side");
    assert.ok(Math.abs((lit.data[50] as number) - 200 * 0.8) < 8, "by a gradient across");
  });

  test("remaps grey, makes a black and white scan, and saves as a JPEG of a quality", () => {
    const ramp = newImage(256, 1);
    for (let i = 0; i < 256; i++) ramp.data[i] = i;
    const mapped = levels(ramp, 20, 230);
    assert.deepEqual([mapped.data[0], mapped.data[255]], [20, 230]);
    assert.ok((levels(ramp, 0, 255, 2).data[64] as number) > 64, "a gamma above 1 lightens the middle");
    const bilevel = toBilevel(ramp, 100);
    assert.deepEqual([bilevel.data[99], bilevel.data[100]], [0, 255]);
    const rich = newImage(64, 64, 128);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) rich.data[y * 64 + x] = ((x * 7 + y * 13) % 11) * 20 + ((x + y) % 2 ? 6 : 0);
    const high = jpegBlocks(rich, 95);
    const low = jpegBlocks(rich, 10);
    const error = (i: GreyImage): number => i.data.reduce((s, v, k) => s + Math.abs(v - (rich.data[k] as number)), 0) / i.data.length;
    assert.ok(error(high) < 4, `quality 95 error ${error(high)}`);
    assert.ok(error(low) > error(high) * 2, `quality 10 error ${error(low)} against ${error(high)}`);
    assert.deepEqual(Array.from(jpegBlocks(rich, 40).data), Array.from(jpegBlocks(rich, 40).data));
    assert.deepEqual([jpegBlocks(newImage(13, 11), 50).width, jpegBlocks(newImage(13, 11), 50).height], [13, 11], "a size that is not a multiple of 8");
    const copy = photocopy(newImage(100, 100, 255), "c", { darken: 0.5 });
    assert.ok(copy.data.some((v) => v < 255) && (copy.data[0] as number) <= 255);
  });
});
