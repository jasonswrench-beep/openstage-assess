/**
 * The piece of a picture Review shows: a row of bubbles, cut out upright, whichever way the page lay.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { CROP_DPI, cropRects } from "../src/sheets/crop.ts";
import { quarterTurn, rotate } from "../src/sheets/damage.ts";
import { layoutFor, slotBubbles, slotRow } from "../src/sheets/geometry.ts";
import type { GreyImage } from "../src/sheets/image.ts";
import { drawn, mcq, testOf } from "./support/sheet-fixtures.ts";

const record = testOf([mcq(4), mcq(4), mcq(4)]);
const layout = layoutFor("letter", "standard");
const row = slotRow(layout, 1);

function pieceOf(image: GreyImage): GreyImage {
  const pieces = cropRects(image, "letter", [row]);
  assert.ok(pieces, "the sheet is found in the picture");
  const piece = pieces[0];
  assert.ok(piece);
  return piece;
}

/** The mean grey in a small square round a point of the sheet, in the piece cut out for `row`. */
function greyAt(piece: GreyImage, x: number, y: number): number {
  const margin = 1.5;
  const perMm = piece.width / (row.width + 2 * margin);
  const cx = Math.round((x - (row.x - margin)) * perMm);
  const cy = Math.round((y - (row.y - margin)) * perMm);
  let sum = 0;
  let n = 0;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      sum += piece.data[(cy + dy) * piece.width + cx + dx] as number;
      n++;
    }
  }
  return sum / n;
}

describe("cutting a row out of a picture", () => {
  const { render } = drawn(record);
  const upright = render({ answers: { 2: [{ place: 2, mark: { kind: "solid" } }] } });

  test("is the size the rectangle and the margin make at 150 dots to the inch", () => {
    const piece = pieceOf(upright);
    const perMm = CROP_DPI / 25.4;
    assert.ok(Math.abs(piece.width - (row.width + 3) * perMm) <= 2, `${piece.width} wide`);
    assert.ok(Math.abs(piece.height - (row.height + 3) * perMm) <= 2, `${piece.height} high`);
  });

  test("shows the mark where the sheet has it and the empty bubbles light, so the piece is the row and not some other part", () => {
    const piece = pieceOf(upright);
    const bubbles = slotBubbles(layout, 1);
    const marked = bubbles[2]!;
    const empty = bubbles[0]!;
    assert.ok(greyAt(piece, marked.x, marked.y) < 90, "the filled bubble is dark");
    assert.ok(greyAt(piece, empty.x, empty.y) > 190, "an empty one is light inside");
  });

  test("is the same upright piece when the page lay sideways, upside down or a little crooked", () => {
    const base = pieceOf(upright);
    for (const [name, image] of [
      ["a quarter turn", quarterTurn(upright, 1)],
      ["a half turn", quarterTurn(upright, 2)],
      ["three quarters", quarterTurn(upright, 3)],
      ["four degrees", rotate(upright, 4)],
    ] as Array<[string, GreyImage]>) {
      const piece = pieceOf(image);
      assert.equal(piece.width, base.width, `${name}: same width`);
      assert.equal(piece.height, base.height, `${name}: same height`);
      let difference = 0;
      for (let i = 0; i < base.data.length; i++) difference += Math.abs((piece.data[i] as number) - (base.data[i] as number));
      assert.ok(difference / base.data.length < 14, `${name}: the piece matches the upright one (mean difference ${(difference / base.data.length).toFixed(1)})`);
    }
  });

  test("is never wider than a piece may be, however wide the rectangle", () => {
    const pieces = cropRects(upright, "letter", [{ x: 0, y: 0, width: layout.width, height: 10 }]);
    assert.ok(pieces?.[0]);
    assert.ok(pieces[0].width <= 1600);
  });

  test("is white where the rectangle falls off the picture", () => {
    const pieces = cropRects(upright, "letter", [{ x: layout.width - 5, y: layout.height - 5, width: 30, height: 30 }]);
    const piece = pieces?.[0];
    assert.ok(piece);
    assert.equal(piece.data[piece.data.length - 1], 255, "the far corner is outside the page");
  });

  test("cannot cut a picture that has no sheet in it, and says so by giving nothing", () => {
    const blank: GreyImage = { width: 600, height: 800, data: new Uint8Array(600 * 800).fill(255) };
    assert.equal(cropRects(blank, "letter", [row]), undefined);
  });
});
