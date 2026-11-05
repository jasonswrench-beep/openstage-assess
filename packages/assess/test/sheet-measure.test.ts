/**
 * Measuring bubbles: how filled each is, and where its row really is, on sheets drawn with known marks.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { blur, levels, noise, shade, speckle } from "../src/sheets/damage.ts";
import { layoutFor, slotBubbles, versionBubbles } from "../src/sheets/geometry.ts";
import type { Homography } from "../src/sheets/homography.ts";
import type { GreyImage } from "../src/sheets/image.ts";
import { SEARCH_MM, blackLevel, edgeSigma, erf, expectedRing, measureBubbles, pixelsPerMm } from "../src/sheets/measure.ts";
import type { SheetMarks } from "../src/sheets/raster.ts";
import { drawn, mixed, solid } from "./support/sheet-fixtures.ts";

const DPI = 150;
const K = DPI / 25.4;
/** The transform of an upright picture at DPI: a millimetre is K pixels, with a shift if the transform is to be wrong on purpose. */
const upright = (shiftMm = { x: 0, y: 0 }): Homography => [K, 0, shiftMm.x * K, 0, K, shiftMm.y * K, 0, 0, 1];

function setup(count = 30, marks?: SheetMarks, more: { dpi?: number; versions?: number } = {}) {
  const d = drawn(mixed(count, { versions: more.versions ?? 1 }), { dpi: more.dpi ?? DPI });
  const layout = layoutFor(d.plan.paper, d.plan.style);
  const rows = d.plan.drawn.slice(0, layout.questionsPerPage).map((s, slot) => ({ slot, centres: slotBubbles(layout, slot).slice(0, s.places) })).filter((r) => r.centres.length > 0);
  return { d, layout, rows, image: d.render(marks) };
}

const measure = (image: GreyImage, rows: ReturnType<typeof setup>["rows"], layout: ReturnType<typeof setup>["layout"], h: Homography = upright()) =>
  measureBubbles(image, h, { black: blackLevel(image, h, layout), paper: 255 }, rows, layout.bubbleDiameter / 2);

describe("the levels of a picture", () => {
  test("takes the black of solid ink from the bodies of the corner marks, and counts the pixels to a millimetre", () => {
    const { image, layout } = setup();
    assert.ok(blackLevel(image, upright(), layout) < 8);
    assert.ok(blackLevel(levels(image, 40, 220), upright(), layout) > 35 && blackLevel(levels(image, 40, 220), upright(), layout) < 60);
    assert.ok(Math.abs(pixelsPerMm(upright(), { x: 100, y: 100 }) - K) < 1e-9);
  });
});

describe("measuring the bubbles of a sheet", () => {
  test("reads an empty bubble as nothing and a firm mark as most of the way to black, in every place", () => {
    const answers = [0, 1, 2, 3, 0, 1, 2, 0, 1, 2];
    const { image, rows, layout, d } = setup(30, solid(answers));
    const m = measure(image, rows, layout);
    assert.equal(m.rows.length, rows.length);
    m.rows.forEach((row) => {
      const answer = answers[row.slot];
      const places = d.plan.drawn[row.slot]?.places ?? 0;
      row.bubbles.forEach((b, p) => {
        if (answer !== undefined && p === answer) assert.ok(b.fill > 0.6 && b.fill <= 1, `question ${row.slot + 1} place ${p}: ${b.fill}`);
        else assert.ok(b.fill < 0.03, `question ${row.slot + 1} place ${p} (of ${places}): ${b.fill}`);
      });
    });
    assert.equal(m.outside, false);
  });

  test("puts a lighter mark lower: a smudge, a light mark, a half fill and a firm one come out in that order", () => {
    const kinds = ["erased", "light", "half", "solid"] as const;
    const { image, rows, layout } = setup(30, { answers: Object.fromEntries(kinds.map((kind, i) => [i + 5, [{ place: 1, mark: { kind, darkness: kind === "solid" ? 0.9 : undefined } }]])), seed: "order" });
    const m = measure(image, rows, layout);
    const fills = kinds.map((_k, i) => (m.rows.find((r) => r.slot === i + 4) as { bubbles: Array<{ fill: number }> }).bubbles[1]?.fill as number);
    assert.ok(fills[0]! < fills[1]! && fills[1]! < fills[3]!, `smudge, light, solid: ${fills.join(", ")}`);
    assert.ok(fills[0]! > 0.1 && fills[0]! < 0.5, `a smudge is faint: ${fills[0]}`);
    assert.ok(fills[2]! > 0.25 && fills[2]! < 0.55, `half a fill is about half: ${fills[2]}`);
  });

  test("finds a row where its outline is, when the transform has it a few tenths of a millimetre out", () => {
    const { image, rows, layout } = setup(30, solid([0, 1, 2, 0, 1, 2, 0, 1, 2, 0]));
    for (const [dx, dy] of [[0.7, -0.5], [-0.8, 0.6], [0.4, 0.9], [0, -0.9]] as Array<[number, number]>) {
      const m = measure(image, rows, layout, upright({ x: dx, y: dy }));
      const shifts = m.rows.filter((r) => !r.inherited).map((r) => r.offset);
      assert.ok(shifts.length > rows.length * 0.8, "most rows found their own outlines");
      const mean = { x: shifts.reduce((s, p) => s + p.x, 0) / shifts.length, y: shifts.reduce((s, p) => s + p.y, 0) / shifts.length };
      assert.ok(Math.abs(mean.x + dx) < 0.2 && Math.abs(mean.y + dy) < 0.2, `shifted (${dx}, ${dy}) and found (${(-mean.x).toFixed(2)}, ${(-mean.y).toFixed(2)})`);
      // and the marks still read as marks, and the empty bubbles as empty
      const first = m.rows[0] as { bubbles: Array<{ fill: number }> };
      assert.ok((first.bubbles[0] as { fill: number }).fill > 0.6, `the mark in the first row reads at ${(first.bubbles[0] as { fill: number }).fill}`);
      assert.ok((first.bubbles[1] as { fill: number }).fill < 0.05);
      assert.ok(m.shiftMax <= Math.hypot(SEARCH_MM, SEARCH_MM) + 1e-9);
    }
  });

  test("says when a row is at the edge of its search: the printed circles may be somewhere else altogether", () => {
    const { image, rows, layout } = setup(30);
    const m = measure(image, rows, layout, upright({ x: 1.3, y: 0 }));
    assert.ok(m.rows.filter((r) => r.atLimit).length > m.rows.length * 0.9, "nearly every row is at the limit when the transform is 1.3 mm out");
    assert.ok(m.shiftMedian > 0.9);
  });

  test("shows the outlines far less clearly when the transform is further out than the search reaches, so that the reader can tell", () => {
    const { image, rows, layout } = setup(30);
    const aligned = measure(image, rows, layout);
    const far = measure(image, rows, layout, upright({ x: 2.2, y: 0 }));
    assert.ok(aligned.ringMedian > 0.7, `aligned: ${aligned.ringMedian}`);
    assert.ok(far.ringMedian < aligned.ringMedian * 0.35, `2.2 mm out: ${far.ringMedian}`);
  });

  test("finds a row whose bubbles are all solid where the rows round it are", () => {
    const all = { answers: { 10: [0, 1, 2, 3].map((place) => ({ place, mark: { kind: "solid" as const } })) }, seed: "all" };
    const { image, rows, layout } = setup(30, all);
    const m = measure(image, rows, layout, upright({ x: 0.5, y: 0 }));
    const row = m.rows.find((r) => r.slot === 9) as { offset: { x: number }; bubbles: Array<{ fill: number }>; atLimit: boolean };
    assert.equal(row.atLimit, false);
    assert.ok(Math.abs(row.offset.x + 0.5) < 0.25, `it is found where the rows round it are: ${row.offset.x}`);
    assert.ok(row.bubbles.slice(0, 4).every((b) => b.fill > 0.5), "the four marked bubbles");
    assert.ok((row.bubbles[4] as { fill: number }).fill < 0.05, "and the fifth, not marked");
  });

  test("gives a row whose outlines are hidden by solid marks the shift of the rows round it, and says so", () => {
    const { image, rows, layout } = setup(30);
    const covered = { width: image.width, height: image.height, data: image.data.slice() } as GreyImage;
    // four solid discs, each wider than the bubble it is on, so that the outlines of the row are under the ink
    for (const c of slotBubbles(layout, 9).slice(0, 4)) {
      for (let y = Math.floor((c.y - 4.2) * K); y < Math.ceil((c.y + 4.2) * K); y++) for (let x = Math.floor((c.x - 4.2) * K); x < Math.ceil((c.x + 4.2) * K); x++) if (Math.hypot(x / K - c.x, y / K - c.y) <= 4.2) covered.data[y * covered.width + x] = 20;
    }
    const m = measure(covered, rows, layout, upright({ x: 0.5, y: 0 }));
    const row = m.rows.find((r) => r.slot === 9) as { inherited: boolean; atLimit: boolean; offset: { x: number }; bubbles: Array<{ fill: number }> };
    assert.equal(row.inherited, true);
    assert.equal(row.atLimit, false, "the rows round it vouch for it, and its bubbles are solid");
    assert.ok(Math.abs(row.offset.x + 0.5) < 0.25, `it takes their shift: ${row.offset.x}`);
    assert.ok(row.bubbles.slice(0, 4).every((b) => b.fill > 0.8));
  });

  test("does not read a row whose outlines cannot be seen and whose bubbles are not solid: it is not where it was looked for", () => {
    const { image, rows, layout, d } = setup(30);
    const moved = { width: image.width, height: image.height, data: image.data.slice() } as GreyImage;
    const r = slotBubbles(layout, 9);
    const y0 = Math.floor(((r[0] as { y: number }).y - 3.2) * K);
    const y1 = Math.ceil(((r[0] as { y: number }).y + 3.2) * K);
    const x0 = Math.floor(((r[0] as { x: number }).x - 12) * K);
    const x1 = Math.ceil(((r[r.length - 1] as { x: number }).x + 5) * K);
    const dx = Math.round(1.6 * K);
    for (let y = y0; y < y1; y++) {
      for (let x = x1 + dx; x >= x0; x--) moved.data[y * moved.width + x + dx] = image.data[y * image.width + x] as number;
      for (let x = x0; x < x0 + dx; x++) moved.data[y * moved.width + x] = 255;
    }
    const m = measure(moved, rows, layout);
    const row = m.rows.find((q) => q.slot === 9) as { atLimit: boolean };
    assert.equal(row.atLimit, true, "a row 1.6 mm out is further than the search reaches, and is said not to be found");
    assert.ok(m.rows.filter((q) => q.slot !== 9).every((q) => !q.atLimit), "and the rows round it are read");
    // and when no outline can be seen anywhere, no row is vouched for
    // the corner marks stay, and everything between them is paper
    const nothing = { width: image.width, height: image.height, data: image.data.slice() } as GreyImage;
    for (let y = Math.floor(layout.gridTop * K) - 20; y < Math.floor((layout.height - 30) * K); y++) for (let x = Math.floor(20 * K); x < Math.floor((layout.width - 20) * K); x++) nothing.data[y * nothing.width + x] = 255;
    const none = measure(nothing, rows, layout);
    assert.ok(none.rows.every((q) => q.atLimit), "when no outline can be seen anywhere no row is vouched for");
    assert.ok(d.plan.drawn.length > 0);
  });

  test("is not moved by a light from one side, a dull scan, a grey tint or dust", () => {
    const answers = [1, 0, 2, 3, 1, 0, 2, 1, 0, 3];
    const { image, rows, layout } = setup(30, solid(answers));
    const spoiled: Array<[string, GreyImage]> = [
      ["shaded", shade(image, 0.35, 30)],
      ["dull", levels(image, 40, 215)],
      ["tinted", levels(image, 0, 190)],
      ["dusty", speckle(image, 200, 3, "d")],
    ];
    for (const [name, picture] of spoiled) {
      const h = upright();
      const m = measureBubbles(picture, h, { black: blackLevel(picture, h, layout), paper: name === "tinted" ? 190 : name === "dull" ? 215 : name === "shaded" ? 190 : 255 }, rows, layout.bubbleDiameter / 2);
      let wrong = 0;
      m.rows.forEach((row) => {
        const answer = answers[row.slot];
        row.bubbles.forEach((b, p) => {
          if (answer !== undefined && p === answer ? b.fill < 0.5 : b.fill > 0.1) wrong++;
        });
      });
      assert.ok(wrong <= 2, `${name}: ${wrong} bubbles read where they should not (or not where they should)`);
    }
  });

  test("takes the sheet's own blank level off, so a sheet that is grey all over is not marked all over", () => {
    const { image, rows, layout } = setup(30, solid([1, 1, 1, 1, 1, 1, 1, 1]));
    const grey = levels(image, 0, 255, 1).data.slice();
    // a faint overall tint inside every bubble's ring only: rows still measure as empty
    const tinted = { width: image.width, height: image.height, data: grey.map((v) => (v > 200 ? v - 22 : v)) };
    const m = measureBubbles(tinted, upright(), { black: 0, paper: 233 }, rows, layout.bubbleDiameter / 2);
    const empties = m.rows.flatMap((r) => r.bubbles.filter((_b, p) => p !== 1)).map((b) => b.fill);
    assert.ok(Math.max(...empties) < 0.08, `empty bubbles on a tinted page: ${Math.max(...empties)}`);
  });

  test("measures the version bubbles as a group of their own", () => {
    const { image, layout, rows } = setup(30, { versions: [{ version: 3, mark: { kind: "solid" } }] }, { versions: 4 });
    const group = { centres: versionBubbles(layout).map((b) => b.center), radius: 2.5 };
    const m = measureBubbles(image, upright(), { black: blackLevel(image, upright(), layout), paper: 255 }, rows, layout.bubbleDiameter / 2, group);
    const fills = (m.version as { bubbles: Array<{ fill: number }> }).bubbles.map((b) => b.fill);
    assert.deepEqual(fills.map((f) => f > 0.5), [false, false, true, false]);
    assert.ok(Math.abs((m.version as { offset: { x: number } }).offset.x) < 0.2);
  });

  test("says when part of the grid is off the picture, and when the outlines cannot be made out", () => {
    const { image, rows, layout } = setup(30);
    assert.equal(measure(image, rows, layout, upright({ x: 400, y: 0 })).outside, true);
    const flat = { width: image.width, height: image.height, data: new Uint8Array(image.data.length).fill(255) } as GreyImage;
    const m = measureBubbles(flat, upright(), { black: 0, paper: 255 }, rows, layout.bubbleDiameter / 2);
    assert.ok(m.ringMedian < 0.01, "no outlines on a blank picture");
    assert.ok(m.pixelsPerMm > 5);
  });
});

describe("how soft a picture is, and how clear its printing should then be", () => {
  const sharp = setup(30).image;
  const layout = setup(30).layout;

  test("measures the softness of the corner marks' edges: small on a sharp picture, and about the blur that was put on", () => {
    const none = edgeSigma(sharp, upright(), layout) as number;
    assert.ok(none > 0.04 && none < 0.15, `a sharp picture: ${none}`);
    // a blur of 2 pixels at 150 dots to the inch is 0.34 mm, and the measure is of the blur and not of the picture's own sharpness
    const soft = edgeSigma(blur(sharp, 2), upright(), layout) as number;
    assert.ok(soft > 0.3 && soft < 0.42, `blurred 2 px: ${soft}`);
    const softer = edgeSigma(blur(sharp, 4), upright(), layout) as number;
    assert.ok(softer > soft * 1.7 && softer < 0.85, `blurred 4 px: ${softer}`);
    assert.equal(edgeSigma({ width: sharp.width, height: sharp.height, data: new Uint8Array(sharp.data.length).fill(255) } as GreyImage, upright(), layout), undefined, "no edges on a blank picture");
  });

  test("measures the same softness wherever the corners are, through a turn and noise", () => {
    const k = 0.34;
    const a = edgeSigma(blur(sharp, 2), upright(), layout) as number;
    const b = edgeSigma(noise(blur(sharp, 2), 8, "n"), upright(), layout) as number;
    assert.ok(Math.abs(a - b) < 0.05 && a > k * 0.8);
  });

  test("works out the clearness the printed circles should show at, from the error function", () => {
    assert.ok(Math.abs(erf(0)) < 1e-9 && Math.abs(erf(1) - 0.8427007929) < 1e-6 && Math.abs(erf(-0.5) + 0.5204998778) < 1e-6 && Math.abs(erf(3) - 0.9999779095) < 1e-6);
    assert.ok(Math.abs(expectedRing(0.03) - 0.9) < 0.01, "a sharp picture shows them at about 0.9");
    assert.ok(Math.abs(expectedRing(0.2) - 0.9 * erf(0.25 / (2 * Math.SQRT2 * 0.2))) < 1e-9);
    assert.ok(expectedRing(0.1) > expectedRing(0.2) && expectedRing(0.2) > expectedRing(0.4), "softer, fainter");
    assert.equal(expectedRing(0.001), expectedRing(0.03), "the sharpness has a floor, since a picture cannot be sharper than its pixels");
    // and what is measured is what is expected, on a sharp picture and on a soft one
    const { rows, image } = setup(30);
    for (const s of [0, 1.2, 2]) {
      const picture = s === 0 ? image : blur(image, s);
      const m = measure(picture, rows, layout);
      const e = expectedRing(edgeSigma(picture, upright(), layout) as number);
      assert.ok(m.ringMedian / e > 0.8 && m.ringMedian / e < 1.25, `blur ${s}: measured ${m.ringMedian.toFixed(2)}, expected ${e.toFixed(2)}`);
    }
  });
});

describe("what the measure takes for ink, and what it does not", () => {
  const paintDisc = (picture: GreyImage, c: { x: number; y: number }, from: number, to: number, value: number): void => {
    for (let y = Math.floor((c.y - to) * K); y < Math.ceil((c.y + to) * K); y++) {
      for (let x = Math.floor((c.x - to) * K); x < Math.ceil((c.x + to) * K); x++) {
        const d = Math.hypot((x + 0.5) / K - c.x, (y + 0.5) / K - c.y);
        if (d >= from && d <= to) picture.data[y * picture.width + x] = value;
      }
    }
  };
  const copy = (picture: GreyImage): GreyImage => ({ width: picture.width, height: picture.height, data: picture.data.slice() }) as GreyImage;

  test("measures only the inner 70 percent of a circle: an O drawn round the edge is not a fill", () => {
    const { image, rows, layout } = setup(30);
    const o = copy(image);
    for (const c of slotBubbles(layout, 1).slice(0, 4)) paintDisc(o, c, 1.95, 2.38, 20);
    const m = measure(o, rows, layout);
    const row = m.rows.find((r) => r.slot === 1) as { bubbles: Array<{ fill: number }> };
    assert.ok(row.bubbles.every((b) => b.fill < 0.08), `${row.bubbles.map((b) => b.fill.toFixed(2)).join(" ")}`);
  });

  test("never takes the blank level for more than a quarter, so a page that is inked all over is not read as blank", () => {
    const { image, rows, layout, d } = setup(30);
    const inked = copy(image);
    for (let slot = 0; slot < d.plan.drawn.length; slot++) for (const c of slotBubbles(layout, slot).slice(0, d.plan.drawn[slot]?.places ?? 0)) paintDisc(inked, c, 0, 2.3, 128);
    const m = measure(inked, rows, layout);
    assert.ok(m.levels.blank <= 0.25 + 1e-9, `blank level ${m.levels.blank}`);
    const fills = m.rows.flatMap((r) => r.bubbles.map((b) => b.fill));
    assert.ok(fills.every((f) => f > 0.25), `the lowest fill is ${Math.min(...fills).toFixed(2)}`);
  });

  test("does not vouch for any row when every bubble on the page is solid and no outline shows", () => {
    const { image, rows, layout, d } = setup(30);
    const covered = copy(image);
    for (let slot = 0; slot < d.plan.drawn.length; slot++) for (const c of slotBubbles(layout, slot).slice(0, d.plan.drawn[slot]?.places ?? 0)) paintDisc(covered, c, 0, 4.4, 20);
    const m = measure(covered, rows, layout);
    assert.ok(m.rows.every((r) => r.atLimit), "there is nothing to say where any row is");
  });

  test("does not let a row take its neighbours' shift when only one of its bubbles is solid", () => {
    const { image, rows, layout } = setup(30);
    const picture = copy(image);
    const centres = slotBubbles(layout, 9).slice(0, 5);
    for (const c of centres) paintDisc(picture, c, 2.15, 2.9, 255);
    paintDisc(picture, centres[1] as { x: number; y: number }, 0, 2.0, 20);
    const m = measure(picture, rows, layout);
    const row = m.rows.find((r) => r.slot === 9) as { atLimit: boolean; inherited: boolean };
    assert.equal(row.inherited, true, "its outlines are gone");
    assert.equal(row.atLimit, true, "and one solid bubble in five does not hide them");
  });

  test("gives a row the shift of the rows near it and not the shift of the whole page", () => {
    // The page is sheared: each row is moved sideways by an amount that grows down the page, so rows at the top and the bottom want opposite shifts.
    const { image, rows, layout, d } = setup(60);
    const slope = 0.012;
    const mid = image.height * 0.54;
    const sheared = { width: image.width, height: image.height, data: new Uint8Array(image.data.length).fill(255) } as GreyImage;
    for (let y = 0; y < image.height; y++) {
      const s = Math.round(slope * (y - mid));
      for (let x = 0; x < image.width; x++) {
        const from = x - s;
        if (from >= 0 && from < image.width) sheared.data[y * image.width + x] = image.data[y * image.width + from] as number;
      }
    }
    for (const c of slotBubbles(layout, 1).slice(0, 4)) paintDisc(sheared, c, 0, 4.4, 20);
    const m = measure(sheared, rows, layout);
    const at = (slot: number) => m.rows.find((r) => r.slot === slot) as { offset: { x: number }; inherited: boolean };
    assert.equal(at(1).inherited, true);
    const neighbours = (at(0).offset.x + at(2).offset.x) / 2;
    const all = m.rows.map((r) => r.offset.x).sort((a, b) => a - b);
    const overall = all[Math.floor(all.length / 2)] as number;
    assert.ok(Math.abs(neighbours - overall) > 0.4, `the rows differ down the page: ${neighbours.toFixed(2)} near the top and ${overall.toFixed(2)} overall`);
    assert.ok(Math.abs(at(1).offset.x - neighbours) < 0.3, `it takes its neighbours' shift (${at(1).offset.x.toFixed(2)}, theirs ${neighbours.toFixed(2)})`);
    assert.ok(d.plan.drawn.length === 60);
  });

  test("takes each bubble's paper from beside it, so a page lit more on one side reads the same everywhere", () => {
    const answers = [1, 0, 2, 3, 1, 0, 2, 1, 0, 3];
    // a hundred questions, so the grid runs across the whole width of the page and the darkest bubbles are a quarter darker than the lightest
    const { image, rows, layout } = setup(100, solid(answers));
    const lit = shade(image, 0.25, 0);
    // the paper level handed in is the page's brightest, as the reader finds it: the dark side is darker than that by the shading
    const h = upright();
    const m = measureBubbles(lit, h, { black: blackLevel(lit, h, layout), paper: 255 }, rows, layout.bubbleDiameter / 2);
    let off = 0;
    m.rows.forEach((row) => {
      const answer = answers[row.slot];
      row.bubbles.forEach((b, p) => {
        if (answer !== undefined && p === answer ? b.fill < 0.5 : b.fill > 0.06) off++;
      });
    });
    assert.equal(off, 0);
  });
});
