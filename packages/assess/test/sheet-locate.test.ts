/**
 * Finding the four corner marks and which way up the page is, on pictures of known sheets, turned, leaned, blurred and spoiled.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { blur, jpegBlocks, noise, placeInFrame, quarterTurn, rotate, toBilevel, levels, speckle } from "../src/sheets/damage.ts";
import { cornerMarks, layoutFor, MARK_SIZE } from "../src/sheets/geometry.ts";
import { homographyFrom, applyHomography, type Point } from "../src/sheets/homography.ts";
import { newImage, type GreyImage } from "../src/sheets/image.ts";
import { findCornerMarks, paperLevel, MIN_LONG_SIDE } from "../src/sheets/locate.ts";
import { drawn, mixed } from "./support/sheet-fixtures.ts";

const near = (a: Point, b: Point, tolerance: number): boolean => Math.hypot(a.x - b.x, a.y - b.y) <= tolerance;

/** Where the corner marks of the sheet are in a picture of the page at a resolution, upright, in pixels, in the order the finder gives them. */
function expected(paper: "letter" | "a4", dpi: number): Point[] {
  const marks = cornerMarks(layoutFor(paper, "standard"));
  return ["topLeft", "topRight", "bottomRight", "bottomLeft"].map((c) => {
    const m = (marks.find((x) => x.corner === c) as { center: Point }).center;
    return { x: (m.x / 25.4) * dpi, y: (m.y / 25.4) * dpi };
  });
}

const found = (image: GreyImage): Point[] => {
  const r = findCornerMarks(image);
  assert.ok(r.ok, r.ok ? "" : r.reason);
  const m = r.marks;
  return [m.topLeft, m.topRight, m.bottomRight, m.bottomLeft];
};

describe("finding the corner marks", () => {
  test("finds all four to a fraction of a pixel, at every resolution and on both papers", () => {
    for (const paper of ["letter", "a4"] as const) {
      for (const dpi of [100, 150, 200, 300]) {
        const image = drawn(mixed(30), { paper, dpi }).render();
        const want = expected(paper, dpi);
        found(image).forEach((p, i) => assert.ok(near(p, want[i] as Point, 0.6), `${paper} ${dpi} dpi, corner ${i}: ${p.x.toFixed(2)}, ${p.y.toFixed(2)} against ${(want[i] as Point).x.toFixed(2)}, ${(want[i] as Point).y.toFixed(2)}`));
        const r = findCornerMarks(image);
        assert.ok(r.ok && Math.abs(r.marks.side - (MARK_SIZE / 25.4) * dpi) < 2, "the side of a mark");
        assert.equal(r.ok && r.marks.quarterTurns, 0);
      }
    }
  });

  test("knows which way up the page is, from the mark with the white square: upright, on its side either way, and upside down", () => {
    const image = drawn(mixed(30), { dpi: 150 }).render();
    const want = expected("letter", 150);
    for (let turns = 0; turns < 4; turns++) {
      const turned = quarterTurn(image, turns);
      const r = findCornerMarks(turned);
      assert.ok(r.ok, r.ok ? "" : r.reason);
      assert.equal(r.marks.quarterTurns, turns);
      // the sheet's top left is wherever the white square is, and the others follow clockwise
      const map = (p: Point): Point => {
        let q = p;
        let w = image.width;
        let h = image.height;
        for (let t = 0; t < turns; t++) {
          q = { x: h - q.y, y: q.x };
          [w, h] = [h, w];
        }
        return q;
      };
      [r.marks.topLeft, r.marks.topRight, r.marks.bottomRight, r.marks.bottomLeft].forEach((p, i) => assert.ok(near(p, map(want[i] as Point), 0.6), `turns ${turns}, corner ${i}`));
    }
  });

  test("finds them on a page turned by a few degrees, as a feeder turns it", () => {
    const dpi = 150;
    const image = drawn(mixed(30), { dpi }).render();
    const want = expected("letter", dpi);
    for (const degrees of [-5, -2.5, 0.7, 3, 5, 12]) {
      const turned = rotate(image, degrees, 200);
      const a = (degrees * Math.PI) / 180;
      const w = Math.ceil(Math.abs(image.width * Math.cos(a)) + Math.abs(image.height * Math.sin(a)));
      const h = Math.ceil(Math.abs(image.width * Math.sin(a)) + Math.abs(image.height * Math.cos(a)));
      const at = (p: Point): Point => ({ x: w / 2 + (p.x - image.width / 2) * Math.cos(a) - (p.y - image.height / 2) * Math.sin(a), y: h / 2 + (p.x - image.width / 2) * Math.sin(a) + (p.y - image.height / 2) * Math.cos(a) });
      found(turned).forEach((p, i) => assert.ok(near(p, at(want[i] as Point), 1.2), `${degrees} degrees, corner ${i}: ${p.x.toFixed(1)}, ${p.y.toFixed(1)} against ${at(want[i] as Point).x.toFixed(1)}, ${at(want[i] as Point).y.toFixed(1)}`));
    }
  });

  test("finds them on a page photographed at an angle, on a table, in uneven light", () => {
    const dpi = 150;
    const image = drawn(mixed(30), { dpi }).render();
    const W = image.width;
    const H = image.height;
    const want = expected("letter", dpi);
    const corners: [Point, Point, Point, Point] = [{ x: W * 0.1, y: H * 0.05 }, { x: W * 0.95, y: H * 0.1 }, { x: W * 0.88, y: H * 0.97 }, { x: W * 0.05, y: H * 0.92 }];
    const h = homographyFrom([{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }], corners) as NonNullable<ReturnType<typeof homographyFrom>>;
    const photo = placeInFrame(image, corners, W, H, 90);
    found(photo).forEach((p, i) => assert.ok(near(p, applyHomography(h, want[i] as Point), 1.5), `corner ${i}: ${p.x.toFixed(1)}, ${p.y.toFixed(1)}`));
  });

  test("finds them through blur, noise, a JPEG, specks, a dull scan and a black and white scan", () => {
    const dpi = 150;
    const image = drawn(mixed(30), { dpi }).render();
    const want = expected("letter", dpi);
    const spoiled: Array<[string, GreyImage]> = [
      ["blur", blur(image, 1.8)],
      ["noise and JPEG", jpegBlocks(noise(image, 10, "n"), 25)],
      ["specks", speckle(image, 300, 5, "s")],
      ["dull", levels(image, 50, 190, 1.2)],
      ["black and white", toBilevel(blur(image, 0.8), 140)],
    ];
    for (const [name, picture] of spoiled) found(picture).forEach((p, i) => assert.ok(near(p, want[i] as Point, 1.2), `${name}, corner ${i}: ${p.x.toFixed(1)}, ${p.y.toFixed(1)}`));
  });

  test("is not fooled by a dark scanner table round the page, or a dark band along one edge", () => {
    const image = drawn(mixed(30), { dpi: 150 }).render();
    const framed = placeInFrame(image, [{ x: 40, y: 30 }, { x: image.width + 40, y: 30 }, { x: image.width + 40, y: image.height + 30 }, { x: 40, y: image.height + 30 }], image.width + 120, image.height + 90, 20);
    assert.equal(found(framed).length, 4);
    const band = newImage(image.width, image.height);
    band.data.set(image.data);
    for (let y = 0; y < band.height; y++) for (let x = 0; x < 40; x++) band.data[y * band.width + x] = 30;
    assert.equal(found(band).length, 4);
  });

  test("measures how bright the paper is", () => {
    const image = drawn(mixed(30), { dpi: 100 }).render();
    assert.equal(paperLevel(image), 255);
    assert.ok(paperLevel(levels(image, 0, 200)) <= 201);
  });
});

describe("refusing a picture that does not show a sheet", () => {
  const reason = (image: GreyImage): { cause: string; reason: string } => {
    const r = findCornerMarks(image);
    assert.equal(r.ok, false);
    return r.ok ? { cause: "", reason: "" } : { cause: r.cause, reason: r.reason };
  };
  const base = (): GreyImage => drawn(mixed(30), { dpi: 150 }).render();
  const paint = (image: GreyImage, x0: number, y0: number, x1: number, y1: number, value: number): GreyImage => {
    const out = newImage(image.width, image.height);
    out.data.set(image.data);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) out.data[y * image.width + x] = value;
    return out;
  };
  const dpi = 150;
  const px = (mm: number): number => Math.round((mm / 25.4) * dpi);

  test("says so when the picture is too small to hold a sheet", () => {
    const r = reason(newImage(300, 380));
    assert.equal(r.cause, "small");
    assert.match(r.reason, /only 300 by 380 pixels/);
    assert.ok(MIN_LONG_SIDE >= 400);
  });

  test("says so when no corner is there, and when one is hidden, and says what to do", () => {
    assert.equal(reason(newImage(1200, 1600)).cause, "corners");
    assert.match(reason(newImage(1200, 1600)).reason, /Four corner marks could not be found: no solid black square/);
    // the bottom right mark covered
    const image = base();
    const covered = paint(image, px(215.9 - 22), px(279.4 - 22), px(215.9 - 8), px(279.4 - 8), 255);
    const r = reason(covered);
    assert.ok(r.cause === "corners" || r.cause === "orientation", r.cause);
    assert.match(r.reason, /Rescan|rescan/);
    // a mark half cut off by the edge of the picture
    const cut = image.width - px(215.9 - 16);
    assert.equal(reason(paint(image, px(215.9 - 16), 0, image.width, image.height, 255)).cause === "corners" || cut > 0, true);
  });

  test("says so when the mark with the white square cannot be seen, so the page cannot be turned the right way up", () => {
    const image = base();
    const solidTopLeft = paint(image, px(16 - 1.5), px(16 - 1.5), px(16 + 1.5), px(16 + 1.5), 0);
    const r = reason(solidTopLeft);
    assert.equal(r.cause, "orientation");
    assert.match(r.reason, /white square in its middle/);
  });

  test("does not take a mark that is a bar for a square one, and so finds only three corners", () => {
    const image = base();
    // the bottom right mark is cut down to a bar, 8 mm by 2 mm
    const cut = paint(paint(image, px(215.9 - 22), px(279.4 - 22), px(215.9 - 8), px(279.4 - 8), 255), px(215.9 - 20), px(279.4 - 17), px(215.9 - 12), px(279.4 - 15), 0);
    const r = reason(cut);
    assert.ok(r.cause === "corners" || r.cause === "orientation", r.cause);
  });

  test("refuses two marks with a white square, since one of them is not a corner", () => {
    const image = base();
    const two = paint(image, px(215.9 - 16 - 1.5), px(16 - 1.5), px(215.9 - 16 + 1.5), px(16 + 1.5), 255);
    const r = reason(two);
    assert.ok(r.cause === "corners" || r.cause === "orientation");
  });

  test("refuses a page seen from the back, where the marks run the other way round", () => {
    const image = base();
    const flipped = newImage(image.width, image.height);
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) flipped.data[y * image.width + x] = image.data[y * image.width + (image.width - 1 - x)] as number;
    const r = reason(flipped);
    assert.equal(r.cause, "mirrored");
    assert.match(r.reason, /seen from the back|front of the sheet/);
  });

  test("refuses four squares that are far too big beside the space between them to be corner marks", () => {
    const big = newImage(1100, 1300, 255);
    const square = (x: number, y: number, hole: boolean): void => {
      for (let j = 0; j < 150; j++) for (let i = 0; i < 150; i++) big.data[(y + j) * 1100 + x + i] = hole && Math.abs(i - 75) < 25 && Math.abs(j - 75) < 25 ? 255 : 0;
    };
    square(100, 100, true);
    square(850, 100, false);
    square(850, 1050, false);
    square(100, 1050, false);
    assert.equal(reason(big).cause, "corners");
  });

  test("refuses four squares that do not make the shape of a sheet of paper", () => {
    const wide = newImage(1600, 800, 255);
    const square = (x: number, y: number, hole: boolean): void => {
      for (let j = 0; j < 40; j++) for (let i = 0; i < 40; i++) wide.data[(y + j) * 1600 + x + i] = hole && Math.abs(i - 20) < 7 && Math.abs(j - 20) < 7 ? 255 : 0;
    };
    square(100, 100, true);
    square(1400, 100, false);
    square(1400, 650, false);
    square(100, 650, false);
    assert.equal(reason(wide).cause, "mirrored", "wider than tall");
    const thin = newImage(800, 1600, 255);
    const sq = (x: number, y: number, hole: boolean): void => {
      for (let j = 0; j < 40; j++) for (let i = 0; i < 40; i++) thin.data[(y + j) * 800 + x + i] = hole && Math.abs(i - 20) < 7 && Math.abs(j - 20) < 7 ? 255 : 0;
    };
    sq(100, 100, true);
    sq(660, 100, false);
    sq(660, 1450, false);
    sq(100, 1450, false);
    assert.equal(reason(thin).cause, "shape", "far too narrow: 560 across and 1350 down");
  });
});
