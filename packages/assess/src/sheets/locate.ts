/**
 * Finding the four corner marks of a sheet in a picture, and which way up the page is.
 *
 * The marks are solid squares, the top left one with a white square in its middle. They are found without knowing the picture's
 * resolution, its turn or its lean: the picture is made small, divided into dark and light against the light round each spot, and
 * every dark blob is measured for how square and how solid it is. Of the blobs that are, the four that make the largest well-shaped
 * four-sided figure with exactly one hollow mark among them are the corners, and the hollow one is the top left, so a page that
 * is upside down or on its side is read the same as one that is upright. Where the marks are then found precisely, in the full
 * picture, by the weight of ink round each.
 *
 * Nothing here guesses. A picture with fewer than four such marks, or with no hollow one, or with two, or in which the marks stand in
 * the order of a page seen from the back, is refused with the reason. What the marks then say about the page (its paper, its code,
 * whether the printing is where it should be) is checked afterwards in read.ts, and any of those checks can refuse the page too.
 */

import { boxDownscale, type GreyImage } from "./image.ts";
import type { Point } from "./homography.ts";

/** Why a picture was refused. Each names what to do about it in the reason. */
export type RefusalCause =
  | "small"
  | "corners"
  | "orientation"
  | "mirrored"
  | "shape"
  | "code"
  | "paper"
  | "test"
  | "registration"
  | "quality"
  | "blank";

export interface Refusal {
  ok: false;
  cause: RefusalCause;
  reason: string;
}

export interface FoundMarks {
  /** The four marks as they stand in the picture, in pixels, named for the sheet's own corners. */
  topLeft: Point;
  topRight: Point;
  bottomRight: Point;
  bottomLeft: Point;
  /** The side of a mark in the picture, in pixels (the mean of the four). */
  side: number;
  /** How many turns of a quarter, clockwise, the page has been turned in the picture: 0 upright, 2 upside down. */
  quarterTurns: number;
}

export type MarksResult = { ok: true; marks: FoundMarks } | Refusal;

const refuse = (cause: RefusalCause, reason: string): Refusal => ({ ok: false, cause, reason });

/** The smallest picture the reader will look at: a corner mark of a sheet would be a few pixels across and could not be told from dust. */
export const MIN_LONG_SIDE = 400;

interface Blob {
  id: number;
  count: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  sumX: number;
  sumY: number;
}

interface Candidate {
  /** The centre in the small picture, in pixels. */
  cx: number;
  cy: number;
  /** The side of the square that fits it best. */
  side: number;
  hollow: boolean;
  area: number;
}

function percentile(values: Uint8Array, p: number, step = 7): number {
  const histogram = new Uint32Array(256);
  let total = 0;
  for (let i = 0; i < values.length; i += step) {
    const v = values[i] as number;
    histogram[v] = (histogram[v] as number) + 1;
    total++;
  }
  let seen = 0;
  const target = total * p;
  for (let v = 0; v < 256; v++) {
    seen += histogram[v] as number;
    if (seen >= target) return v;
  }
  return 255;
}

/** Dark against the light round it, for every pixel, as 1 for dark. The window is a sixth of the picture. */
function darkMask(image: GreyImage): Uint8Array {
  const { width, height, data } = image;
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += data[y * width + x] as number;
      integral[(y + 1) * (width + 1) + x + 1] = (integral[y * (width + 1) + x + 1] as number) + row;
    }
  }
  const half = Math.max(6, Math.round(Math.min(width, height) / 12));
  const white = percentile(data, 0.95);
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - half);
    const y1 = Math.min(height, y + half + 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - half);
      const x1 = Math.min(width, x + half + 1);
      const sum = (integral[y1 * (width + 1) + x1] as number) - (integral[y0 * (width + 1) + x1] as number) - (integral[y1 * (width + 1) + x0] as number) + (integral[y0 * (width + 1) + x0] as number);
      const mean = sum / ((x1 - x0) * (y1 - y0));
      const v = data[y * width + x] as number;
      if (v < mean * 0.8 && v < white * 0.7) mask[y * width + x] = 1;
    }
  }
  return mask;
}

/** The connected dark blobs of a mask, joined across corners. */
function blobsOf(mask: Uint8Array, width: number, height: number): { labels: Int32Array; blobs: Blob[] } {
  const labels = new Int32Array(width * height);
  const blobs: Blob[] = [];
  const stack = new Int32Array(width * height);
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] !== 1 || labels[start] !== 0) continue;
    const blob: Blob = { id: blobs.length + 1, count: 0, minX: width, minY: height, maxX: 0, maxY: 0, sumX: 0, sumY: 0 };
    let top = 0;
    stack[top++] = start;
    labels[start] = blob.id;
    while (top > 0) {
      const i = stack[--top] as number;
      const x = i % width;
      const y = (i - x) / width;
      blob.count++;
      blob.sumX += x;
      blob.sumY += y;
      if (x < blob.minX) blob.minX = x;
      if (x > blob.maxX) blob.maxX = x;
      if (y < blob.minY) blob.minY = y;
      if (y > blob.maxY) blob.maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const j = ny * width + nx;
          if (mask[j] === 1 && labels[j] === 0) {
            labels[j] = blob.id;
            stack[top++] = j;
          }
        }
      }
    }
    blobs.push(blob);
  }
  return { labels, blobs };
}

/** The smallest rectangle, at any turn, that holds a set of points: its two sides and the share of it the points fill. */
function tightestRectangle(xs: number[], ys: number[]): { w: number; h: number; fill: number } {
  let best = { w: 0, h: 0, area: Infinity };
  // Every degree, which keeps a mark turned a little from losing a tenth of its fill to a rectangle that is not quite square to it.
  const step = xs.length > 6000 ? 3 : 1;
  for (let degrees = 0; degrees < 90; degrees += step) {
    const a = (degrees * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i] as number;
      const y = ys[i] as number;
      const u = x * c + y * s;
      const v = -x * s + y * c;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
    const w = u1 - u0 + 1;
    const h = v1 - v0 + 1;
    if (w * h < best.area) best = { w, h, area: w * h };
  }
  return { w: best.w, h: best.h, fill: xs.length / best.area };
}

/** The blobs that are solid squares, with whether each has a white square in its middle. */
function squareBlobs(small: GreyImage, labels: Int32Array, blobs: Blob[]): Candidate[] {
  const { width, height, data } = small;
  const white = percentile(data, 0.95);
  const out: Candidate[] = [];
  for (const b of blobs) {
    const w = b.maxX - b.minX + 1;
    const h = b.maxY - b.minY + 1;
    if (b.count < 25 || w < 5 || h < 5) continue;
    // A corner mark is small beside the page. A blob a quarter of the picture across is a shadow, a thumb or the table.
    if (w > width * 0.25 || h > height * 0.25) continue;
    const bboxAspect = w / h;
    if (bboxAspect < 0.5 || bboxAspect > 2) continue;
    if (b.count / (w * h) < 0.4) continue;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let y = b.minY; y <= b.maxY; y++) {
      for (let x = b.minX; x <= b.maxX; x++) {
        if (labels[y * width + x] === b.id) {
          xs.push(x);
          ys.push(y);
        }
      }
    }
    const rect = tightestRectangle(xs, ys);
    const squareness = Math.min(rect.w, rect.h) / Math.max(rect.w, rect.h);
    // A solid mark fills its rectangle; one with a window in it fills 86 percent; a disc, the shape of a filled bubble, 79.
    if (squareness < 0.7 || rect.fill < 0.78) continue;
    const cx = b.sumX / b.count + 0.5;
    const cy = b.sumY / b.count + 0.5;
    const side = Math.sqrt(rect.w * rect.h);
    // Hollow: the grey at the very middle is far lighter than the grey of the body of the mark, a third of the way out.
    const near = Math.max(1, side * 0.15);
    const body0 = side * 0.3;
    let centre = 0;
    let centreN = 0;
    let body = 0;
    let bodyN = 0;
    for (let i = 0; i < xs.length; i++) {
      const d = Math.hypot((xs[i] as number) + 0.5 - cx, (ys[i] as number) + 0.5 - cy);
      if (d >= body0) {
        body += data[(ys[i] as number) * width + (xs[i] as number)] as number;
        bodyN++;
      }
    }
    for (let y = Math.floor(cy - near); y <= Math.ceil(cy + near); y++) {
      for (let x = Math.floor(cx - near); x <= Math.ceil(cx + near); x++) {
        if (x < 0 || y < 0 || x >= width || y >= height || Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > near) continue;
        centre += data[y * width + x] as number;
        centreN++;
      }
    }
    if (centreN === 0 || bodyN === 0) continue;
    const bodyGrey = body / bodyN;
    const hollow = centre / centreN > (bodyGrey + white) / 2;
    out.push({ cx, cy, side, hollow, area: rect.w * rect.h });
  }
  return out;
}

const cross = (o: Point, a: Point, b: Point): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** How well four candidates make the corners of a page, from 0 for not at all. The four are ordered clockwise from the hollow one. */
function quadFor(four: Candidate[]): { score: number; order: Candidate[] } | undefined {
  const hollow = four.filter((c) => c.hollow);
  if (hollow.length !== 1) return undefined;
  const mx = four.reduce((s, c) => s + c.cx, 0) / 4;
  const my = four.reduce((s, c) => s + c.cy, 0) / 4;
  // Clockwise on the page: the picture's y runs down, so a growing angle turns clockwise.
  const sorted = [...four].sort((a, b) => Math.atan2(a.cy - my, a.cx - mx) - Math.atan2(b.cy - my, b.cx - mx));
  const start = sorted.indexOf(hollow[0] as Candidate);
  const order = [0, 1, 2, 3].map((i) => sorted[(start + i) % 4] as Candidate);
  const p = order.map((c) => ({ x: c.cx, y: c.cy }));
  // Convex, with every turn the same way.
  const turns = [0, 1, 2, 3].map((i) => cross(p[i] as Point, p[(i + 1) % 4] as Point, p[(i + 2) % 4] as Point));
  if (!(turns.every((t) => t > 0) || turns.every((t) => t < 0))) return undefined;
  const sides = [0, 1, 2, 3].map((i) => Math.hypot((p[(i + 1) % 4] as Point).x - (p[i] as Point).x, (p[(i + 1) % 4] as Point).y - (p[i] as Point).y));
  const [s0, s1, s2, s3] = sides as [number, number, number, number];
  if (Math.min(...sides) < 20) return undefined;
  if (Math.max(s0, s2) / Math.min(s0, s2) > 1.6 || Math.max(s1, s3) / Math.min(s1, s3) > 1.6) return undefined;
  const sizes = order.map((c) => c.side);
  if (Math.max(...sizes) / Math.min(...sizes) > 1.8) return undefined;
  // The marks are small beside the page: a mark's side is about a thirtieth of the distance between them.
  const span = (s0 + s2) / 2;
  const meanSide = sizes.reduce((s, x) => s + x, 0) / 4;
  if (meanSide / span > 0.12 || meanSide / span < 0.01) return undefined;
  const area = Math.abs(turns[0] as number) + Math.abs(turns[2] as number);
  return { score: area / (1 + (Math.max(...sizes) / Math.min(...sizes) - 1)), order };
}

/** Moves a mark's place from the small picture to the full one by the ink round it: the centre of the dark, to a fraction of a pixel. */
function refine(image: GreyImage, x: number, y: number, side: number): Point {
  const radius = Math.max(4, side * 0.85);
  const x0 = Math.max(0, Math.floor(x - radius));
  const x1 = Math.min(image.width - 1, Math.ceil(x + radius));
  const y0 = Math.max(0, Math.floor(y - radius));
  const y1 = Math.min(image.height - 1, Math.ceil(y + radius));
  const window: number[] = [];
  for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) window.push(image.data[j * image.width + i] as number);
  window.sort((a, b) => a - b);
  const lo = window[Math.floor(window.length * 0.03)] as number;
  const hi = window[Math.floor(window.length * 0.9)] as number;
  if (hi - lo < 30) return { x, y };
  let sum = 0;
  let sx = 0;
  let sy = 0;
  for (let j = y0; j <= y1; j++) {
    for (let i = x0; i <= x1; i++) {
      const wgt = Math.max(0, Math.min(1, (hi - (image.data[j * image.width + i] as number)) / (hi - lo)));
      sum += wgt;
      sx += wgt * (i + 0.5);
      sy += wgt * (j + 0.5);
    }
  }
  return sum > 0 ? { x: sx / sum, y: sy / sum } : { x, y };
}

/**
 * The four corner marks in a picture. The answer is in the picture's own pixels; nothing about the sheet's paper is assumed beyond the
 * marks being squares, which is why the paper is settled afterwards from the code strip.
 */
export function findCornerMarks(image: GreyImage): MarksResult {
  const long = Math.max(image.width, image.height);
  if (long < MIN_LONG_SIDE) return refuse("small", `This picture is only ${image.width} by ${image.height} pixels, too small to read a sheet from. Scan at 150 dots to the inch or more, or photograph the page so it fills the frame.`);
  const factor = Math.max(1, Math.round(long / 1000));
  const small = boxDownscale(image, factor);
  const mask = darkMask(small);
  const { labels, blobs } = blobsOf(mask, small.width, small.height);
  const squares = squareBlobs(small, labels, blobs).sort((a, b) => b.area - a.area).slice(0, 12);
  if (squares.length < 4) {
    return refuse("corners", `Four corner marks could not be found: ${squares.length === 0 ? "no solid black square was seen" : `only ${squares.length} solid black square${squares.length === 1 ? " was" : "s were"} seen`}. A corner of the page may be hidden, cut off or too dark or too light to see. Rescan with the whole page in view, or photograph it with its four corners inside the frame.`);
  }
  let best: { score: number; order: Candidate[] } | undefined;
  let hollowSeen = 0;
  for (let a = 0; a < squares.length; a++) {
    for (let b = a + 1; b < squares.length; b++) {
      for (let c = b + 1; c < squares.length; c++) {
        for (let d = c + 1; d < squares.length; d++) {
          const four = [squares[a], squares[b], squares[c], squares[d]] as Candidate[];
          const hollow = four.filter((q) => q.hollow).length;
          hollowSeen = Math.max(hollowSeen, hollow);
          const quad = quadFor(four);
          if (quad && (!best || quad.score > best.score)) best = quad;
        }
      }
    }
  }
  if (!best) {
    const anyHollow = squares.some((q) => q.hollow);
    return refuse(
      anyHollow ? "corners" : "orientation",
      anyHollow
        ? "Four corner marks that make the corners of a page could not be found. A corner may be hidden, or something dark is in the way. Rescan with the whole page in view."
        : "The corner mark with the white square in its middle could not be seen, so the picture cannot be turned the right way up. A corner may be hidden or the picture too light or too dark. Rescan the page.",
    );
  }
  const [tl, tr, br, bl] = best.order as [Candidate, Candidate, Candidate, Candidate];
  // The next mark clockwise from the hollow one is the top right. On a page seen from the back the next one is the bottom left, so the
  // mark after the hollow is along the long side of the sheet: the ratio of the two sides says so.
  const toRight = Math.hypot(tr.cx - tl.cx, tr.cy - tl.cy) + Math.hypot(br.cx - bl.cx, br.cy - bl.cy);
  const toBottom = Math.hypot(bl.cx - tl.cx, bl.cy - tl.cy) + Math.hypot(br.cx - tr.cx, br.cy - tr.cy);
  const ratio = toRight / toBottom;
  if (ratio > 1.0) {
    return refuse("mirrored", `The corner marks stand in the order of a page seen from the back, or of a sheet that is not one of ours. Check that this is the front of the sheet, face up on the scanner, and rescan.`);
  }
  if (ratio < 0.55) return refuse("shape", `The four corner marks do not make the shape of a sheet of paper (the page looks stretched or squeezed). Rescan it at the paper's own size, with no "fit to page".`);

  const scale = factor;
  const place = (q: Candidate): Point => refine(image, q.cx * scale, q.cy * scale, q.side * scale);
  const side = ((tl.side + tr.side + br.side + bl.side) / 4) * scale;
  // How many quarter turns the page has been turned: which corner of the picture the hollow mark is nearest to.
  const midX = image.width / 2;
  const midY = image.height / 2;
  const hx = tl.cx * scale;
  const hy = tl.cy * scale;
  const quarterTurns = hx < midX ? (hy < midY ? 0 : 3) : hy < midY ? 1 : 2;
  return { ok: true, marks: { topLeft: place(tl), topRight: place(tr), bottomRight: place(br), bottomLeft: place(bl), side, quarterTurns } };
}

/** The grey level of paper in the picture: what a blank part of the page is, taken as a high percentile of the whole. */
export function paperLevel(image: GreyImage): number {
  return percentile(image.data, 0.95);
}
