/**
 * The answer sheet as pixels, with a student's pencil on it: the test harness's picture of a sheet that has been filled in.
 *
 * The sheet is drawn by the same function that prints it (drawSheetPage in print.ts), onto a surface that paints pixels in place of
 * writing PDF operators, so what the reader is tested on is the printed page and not a second description of it. Pencil marks are
 * drawn on top, in the way students make them (a solid fill, a scribble, a light mark, a mark off the centre, a tick, a cross, a half
 * fill, an erasure) and stray marks too. The picture is drawn at several times the resolution asked for and reduced, so edges come out
 * soft the way a scanner's do.
 *
 * Nothing here is used to read a sheet. It exists so that the reader can be tested at volume, with the answer known, before any real
 * paper is available; real paper is a separate corpus, kept apart.
 */

import { measureText } from "../print/pdf.ts";
import { seededRandom } from "../model/random.ts";
import { layoutFor, placeOf, slotBubbles, versionBubbles } from "./geometry.ts";
import { newImage, type GreyImage } from "./image.ts";
import type { Point } from "./homography.ts";
import type { SheetPlan } from "./plan.ts";
import { drawSheetPage, type SheetInput, type Surface } from "./print.ts";

export type MarkKind = "solid" | "scribble" | "light" | "offcenter" | "tick" | "cross" | "half" | "erased";

export interface PencilMark {
  kind: MarkKind;
  /** How dark the lead is, from 0 to 1. Each kind has its own usual value. */
  darkness?: number;
  /** How far an off-centre mark is moved, in millimetres. */
  dx?: number;
  dy?: number;
}

/** A stray mark: a dot of lead somewhere on the sheet, in millimetres. */
export interface Stray {
  x: number;
  y: number;
  size: number;
  darkness: number;
}

export interface SheetMarks {
  /** Marks by question number, from 1: a mark in each listed place (from 0) of the question. */
  answers?: Record<number, Array<{ place: number; mark: PencilMark }>>;
  /** Marks on the version bubbles, by version (1 to 4). */
  versions?: Array<{ version: number; mark: PencilMark }>;
  strays?: Stray[];
  /** Makes the grain of the lead the same every time. */
  seed?: string;
}

const MM_PER_INCH = 25.4;

// A 5 by 7 letter shape for each character, only so that printed text puts about the right amount of ink in about the right place.
const GLYPHS: Record<string, string[]> = {
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  C: [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  I: [".###.", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."],
  J: ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
  K: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  Q: [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"],
  X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  Z: ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
  "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": ["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": [".###.", "#....", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "....#", ".###."],
  ".": [".....", ".....", ".....", ".....", ".....", ".##..", ".##.."],
  ",": [".....", ".....", ".....", ".....", ".##..", ".##..", ".#..."],
  ":": [".....", ".##..", ".##..", ".....", ".##..", ".##..", "....."],
  "-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
};

/** A number from 0 up to but not including 1, the same for the same three numbers: the grain of a pencil's lead. */
function grain(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** The usual darkness of each kind of mark, from a firm pencil to a faint smudge. */
const USUAL_DARKNESS: Record<MarkKind, number> = { solid: 0.85, scribble: 0.8, light: 0.42, offcenter: 0.85, tick: 0.85, cross: 0.85, half: 0.85, erased: 0.3 };

/**
 * The sheet drawn at a resolution, held so that many students' pencil marks can be put on it in turn. The blank sheet is painted once;
 * each call to render copies it, adds the marks, and reduces it to the picture a scanner would have made.
 */
export class SheetRaster implements Surface {
  readonly dpi: number;
  readonly widthPx: number;
  readonly heightPx: number;
  private readonly ss: number;
  private readonly sw: number;
  private readonly sh: number;
  private readonly k: number;
  private readonly canvas: Uint8Array;
  private readonly plan: SheetPlan;
  private readonly pageNumber: number;

  constructor(plan: SheetPlan, input: SheetInput, pageNumber: number, dpi: number) {
    if (!(dpi >= 50 && dpi <= 600)) throw new Error("A sheet is drawn at 50 to 600 dots to the inch.");
    const layout = layoutFor(plan.paper, plan.style);
    this.plan = plan;
    this.pageNumber = pageNumber;
    this.dpi = dpi;
    this.ss = dpi >= 250 ? 2 : 3;
    this.widthPx = Math.round((layout.width / MM_PER_INCH) * dpi);
    this.heightPx = Math.round((layout.height / MM_PER_INCH) * dpi);
    this.sw = this.widthPx * this.ss;
    this.sh = this.heightPx * this.ss;
    this.k = (dpi / MM_PER_INCH) * this.ss;
    this.canvas = new Uint8Array(this.sw * this.sh).fill(255);
    drawSheetPage(plan, input, pageNumber, this);
  }

  // -------------------------------------------------------------------------------------------------------------------------
  // The printed sheet: opaque shapes, darkest wins.

  private box(x0: number, y0: number, x1: number, y1: number): [number, number, number, number] {
    return [Math.max(0, Math.floor(x0 * this.k)), Math.max(0, Math.floor(y0 * this.k)), Math.min(this.sw, Math.ceil(x1 * this.k)), Math.min(this.sh, Math.ceil(y1 * this.k))];
  }

  private print(x0: number, y0: number, x1: number, y1: number, covers: (x: number, y: number) => boolean, gray: number): void {
    const value = Math.round(gray * 255);
    const [bx0, by0, bx1, by1] = this.box(x0, y0, x1, y1);
    for (let y = by0; y < by1; y++) {
      const mmY = (y + 0.5) / this.k;
      for (let x = bx0; x < bx1; x++) {
        if (!covers((x + 0.5) / this.k, mmY)) continue;
        const i = y * this.sw + x;
        if ((this.canvas[i] as number) > value) this.canvas[i] = value;
      }
    }
  }

  /** The whole of a rectangle painted with a grey, covering what is under it (the white square in the top left corner mark). */
  private paintOver(x0: number, y0: number, x1: number, y1: number, gray: number): void {
    const value = Math.round(gray * 255);
    const [bx0, by0, bx1, by1] = this.box(x0, y0, x1, y1);
    for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) this.canvas[y * this.sw + x] = value;
  }

  rect(x: number, y: number, w: number, h: number, mode: "f" | "S", gray = 0): void {
    if (mode === "f") {
      // A white fill is a hole in what was painted before it, not more paper: the corner mark's window.
      if (gray >= 1) this.paintOver(x, y, x + w, y + h, 1);
      else this.print(x, y, x + w, y + h, () => true, gray);
      return;
    }
    const half = 0.18;
    this.print(x - half, y - half, x + w + half, y + h + half, (px, py) => px < x + half || px > x + w - half || py < y + half || py > y + h - half, gray);
  }

  circle(c: Point, diameter: number, mode: "f" | "S", gray = 0, width = 0.25): void {
    const r = diameter / 2;
    const reach = r + (mode === "S" ? width / 2 : 0);
    this.print(c.x - reach, c.y - reach, c.x + reach, c.y + reach, (px, py) => {
      const d = Math.hypot(px - c.x, py - c.y);
      return mode === "f" ? d <= r : Math.abs(d - r) <= width / 2;
    }, gray);
  }

  halfDisc(c: Point, diameter: number): void {
    const r = diameter / 2;
    this.print(c.x - r, c.y, c.x + r, c.y + r, (px, py) => py >= c.y && Math.hypot(px - c.x, py - c.y) <= r, 0);
  }

  line(a: Point, b: Point, width = 0.4, gray = 0): void {
    this.print(Math.min(a.x, b.x) - width, Math.min(a.y, b.y) - width, Math.max(a.x, b.x) + width, Math.max(a.y, b.y) + width, (px, py) => distanceToSegment(px, py, a, b) <= width / 2, gray);
  }

  text(str: string, x: number, y: number, size: number, o: { bold?: boolean; align?: "left" | "center" | "right"; gray?: number } = {}): void {
    const weight = o.bold ? "bold" : "regular";
    const total = measureText(str, size, weight) / (72 / MM_PER_INCH);
    let left = o.align === "center" ? x - total / 2 : o.align === "right" ? x - total : x;
    const em = (size / 72) * MM_PER_INCH;
    for (const ch of str) {
      const advance = measureText(ch, size, weight) / (72 / MM_PER_INCH);
      if (ch !== " ") {
        const upper = ch.toUpperCase();
        const shape = GLYPHS[upper];
        const lower = ch !== upper;
        const height = em * (lower ? 0.52 : 0.72);
        const widthMm = advance * 0.84;
        const gx = left + advance * 0.08;
        if (shape) {
          const cw = widthMm / 5;
          const chh = height / 7;
          for (let r = 0; r < 7; r++) {
            for (let c = 0; c < 5; c++) {
              if ((shape[r] as string)[c] === "#") this.print(gx + c * cw, y - height + r * chh, gx + (c + 1) * cw + (o.bold ? 0.05 : 0), y - height + (r + 1) * chh, () => true, o.gray ?? 0);
            }
          }
        } else {
          // Any other mark is a small block: some ink where there would be a letter.
          this.print(gx, y - height * 0.8, gx + widthMm * 0.8, y, () => true, 1 - (1 - (o.gray ?? 0)) * 0.6);
        }
      }
      left += advance;
    }
  }

  // -------------------------------------------------------------------------------------------------------------------------
  // The student's pencil: darkens what is under it.

  private ink(x0: number, y0: number, x1: number, y1: number, covers: (x: number, y: number) => number, seed: number): void {
    const [bx0, by0, bx1, by1] = this.box(x0, y0, x1, y1);
    const cell = Math.max(1, Math.round(0.2 * this.k));
    for (let y = by0; y < by1; y++) {
      const mmY = (y + 0.5) / this.k;
      for (let x = bx0; x < bx1; x++) {
        const a = covers((x + 0.5) / this.k, mmY);
        if (a <= 0) continue;
        const g = 0.8 + 0.2 * grain(Math.floor(x / cell), Math.floor(y / cell), seed);
        const i = y * this.sw + x;
        this.canvas[i] = Math.round((this.canvas[i] as number) * (1 - Math.min(1, a * g)));
      }
    }
  }

  private mark(c: Point, radius: number, mark: PencilMark, seed: number): void {
    const dark = mark.darkness ?? USUAL_DARKNESS[mark.kind];
    const R = radius;
    const shiftX = mark.kind === "offcenter" ? (mark.dx ?? 1) : 0;
    const shiftY = mark.kind === "offcenter" ? (mark.dy ?? 0) : 0;
    const m = { x: c.x + shiftX, y: c.y + shiftY };
    const reach = R + 1.2;
    switch (mark.kind) {
      case "solid":
      case "offcenter":
      case "light":
        this.ink(m.x - reach, m.y - reach, m.x + reach, m.y + reach, (x, y) => (Math.hypot(x - m.x, y - m.y) <= R * 0.94 ? dark : 0), seed);
        break;
      case "erased":
        this.ink(c.x - reach, c.y - reach, c.x + reach, c.y + reach, (x, y) => (Math.hypot(x - c.x, y - c.y) <= R * 0.9 ? dark : 0), seed);
        break;
      case "half":
        this.ink(c.x - reach, c.y - reach, c.x + reach, c.y + reach, (x, y) => (y >= c.y && Math.hypot(x - c.x, y - c.y) <= R * 0.94 ? dark : 0), seed);
        break;
      case "scribble":
        // Diagonal strokes 0.45 mm wide and 0.6 mm apart, clipped to the bubble: about three quarters of the inside is covered.
        this.ink(c.x - reach, c.y - reach, c.x + reach, c.y + reach, (x, y) => {
          if (Math.hypot(x - c.x, y - c.y) > R * 0.97) return 0;
          const u = (x - c.x + (y - c.y)) / Math.SQRT2;
          return ((u % 0.6) + 0.6) % 0.6 < 0.45 ? dark : 0;
        }, seed);
        break;
      case "tick": {
        const p = [{ x: c.x - R * 0.7, y: c.y + R * 0.1 }, { x: c.x - R * 0.15, y: c.y + R * 0.65 }, { x: c.x + R * 1.0, y: c.y - R * 0.9 }] as [Point, Point, Point];
        this.ink(c.x - reach, c.y - reach, c.x + reach, c.y + reach, (x, y) => (Math.min(distanceToSegment(x, y, p[0], p[1]), distanceToSegment(x, y, p[1], p[2])) <= 0.25 ? dark : 0), seed);
        break;
      }
      case "cross": {
        const a1 = { x: c.x - R * 0.7, y: c.y - R * 0.7 };
        const a2 = { x: c.x + R * 0.7, y: c.y + R * 0.7 };
        const b1 = { x: c.x - R * 0.7, y: c.y + R * 0.7 };
        const b2 = { x: c.x + R * 0.7, y: c.y - R * 0.7 };
        this.ink(c.x - reach, c.y - reach, c.x + reach, c.y + reach, (x, y) => (Math.min(distanceToSegment(x, y, a1, a2), distanceToSegment(x, y, b1, b2)) <= 0.25 ? dark : 0), seed);
        break;
      }
    }
  }

  /** The sheet with a student's marks on it, reduced to the picture a scanner would make at this resolution. */
  render(marks: SheetMarks = {}): GreyImage {
    const layout = layoutFor(this.plan.paper, this.plan.style);
    const keep = this.canvas.slice();
    const random = seededRandom(marks.seed ?? "pencil");
    const seedOf = (): number => Math.floor(random() * 2 ** 31);
    try {
      for (const [numberText, list] of Object.entries(marks.answers ?? {})) {
        const at = placeOf(layout, Number(numberText));
        if (at.page !== this.pageNumber - 1) continue;
        const centers = slotBubbles(layout, at.slot);
        for (const { place, mark } of list) {
          const c = centers[place];
          if (c) this.mark(c, layout.bubbleDiameter / 2, mark, seedOf());
        }
      }
      for (const { version, mark } of marks.versions ?? []) {
        const b = versionBubbles(layout)[version - 1];
        if (b) this.mark(b.center, 2.5, mark, seedOf());
      }
      for (const s of marks.strays ?? []) this.ink(s.x - s.size, s.y - s.size, s.x + s.size, s.y + s.size, (x, y) => (Math.hypot(x - s.x, y - s.y) <= s.size / 2 ? s.darkness : 0), seedOf());
      return this.reduce();
    } finally {
      this.canvas.set(keep);
    }
  }

  private reduce(): GreyImage {
    const out = newImage(this.widthPx, this.heightPx);
    const ss = this.ss;
    const area = ss * ss;
    for (let y = 0; y < this.heightPx; y++) {
      for (let x = 0; x < this.widthPx; x++) {
        let sum = 0;
        for (let j = 0; j < ss; j++) {
          const row = (y * ss + j) * this.sw + x * ss;
          for (let i = 0; i < ss; i++) sum += this.canvas[row + i] as number;
        }
        out.data[y * this.widthPx + x] = Math.round(sum / area);
      }
    }
    return out;
  }
}

function distanceToSegment(px: number, py: number, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / length2));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

/** One page of a sheet as a picture, at a resolution, with marks on it. */
export function rasterizeSheet(plan: SheetPlan, input: SheetInput, pageNumber: number, dpi: number, marks?: SheetMarks): GreyImage {
  return new SheetRaster(plan, input, pageNumber, dpi).render(marks);
}
