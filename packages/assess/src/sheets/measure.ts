/**
 * How filled each bubble is, measured from the picture.
 *
 * The transform from the sheet to the picture puts every bubble within a millimetre of where it is, which is not enough on its own:
 * a copier shifts and stretches a little, and a bubble measured half over its own outline looks faintly marked when it is blank.
 * So each row of bubbles is first found again by its printed outline (the five circles of a question move together, and five circles
 * tell more than one), within a millimetre of where the transform puts it. Then the mean ink inside the inner 70 percent of each
 * circle is taken, against the paper beside it, and set against the sheet's own blank level, so that the printed letter in a bubble
 * and a grey tint over the whole page are not marks.
 *
 * A fill of 0 is a blank bubble and 1 is as dark as the corner marks. What the numbers mean is decided in decide.ts.
 */

import { applyHomography, type Homography, type Point } from "./homography.ts";
import { sample, type GreyImage } from "./image.ts";
import { cornerMarks, MARK_SIZE, type SheetLayout } from "./geometry.ts";

export interface Levels {
  /** The grey of solid ink: the mean of the corner marks' bodies. */
  black: number;
  /** The grey of paper over the whole picture. */
  paper: number;
}

export interface BubbleMeasure {
  /** 0 for blank to 1 for solid, against the sheet's own blank level. */
  fill: number;
  /** The ink inside the circle before the sheet's blank level is taken off, 0 to about 1. */
  ink: number;
}

export interface GroupMeasure {
  bubbles: BubbleMeasure[];
  /** Where the group was found, as a shift in millimetres from where the transform put it. */
  offset: Point;
  /** How clearly the printed outlines stood out where the group was found: the ring's ink above the paper's, as a share of black. */
  ring: number;
  /**
   * True when the printed circles of the group cannot be vouched for: the best place was at the edge of the search, so they may be
   * somewhere else altogether, or no row on the page had outlines clear enough to say where any of them are.
   */
  atLimit: boolean;
  /** True when this group's outlines could not be made out and the shift of the groups round it was used. */
  inherited: boolean;
}

export interface PageMeasure {
  rows: Array<GroupMeasure & { slot: number }>;
  version?: GroupMeasure;
  levels: Levels & { blank: number };
  /** Pixels to a millimetre of the sheet at its middle. */
  pixelsPerMm: number;
  /** The median clearness of the printed outlines over every group: how well the picture shows the print. */
  ringMedian: number;
  /** The largest shift any group needed, and the median, in millimetres. */
  shiftMax: number;
  shiftMedian: number;
  /** True when some bubble to be measured falls outside the picture. */
  outside: boolean;
}

/** The furthest, in millimetres, that a group of bubbles may be moved to find its own outline. */
export const SEARCH_MM = 1.0;
/** A bubble at least this dark inside is solid enough to hide its own outline, which is what lets a row take its neighbours' shift. */
const SOLID_INK = 0.4;
/** The share of a circle's radius that is measured: the inner 70 percent. */
export const INNER = 0.7;

const ANGLES = 12;
const COS = Array.from({ length: ANGLES }, (_x, i) => Math.cos((2 * Math.PI * i) / ANGLES));
const SIN = Array.from({ length: ANGLES }, (_x, i) => Math.sin((2 * Math.PI * i) / ANGLES));
const GOLDEN = 2.399963229728653;
const SUNFLOWER = 40;

interface Local {
  cx: number;
  cy: number;
  /** Where a step of a millimetre to the right and a millimetre down go, in pixels. */
  exx: number;
  exy: number;
  eyx: number;
  eyy: number;
}

function localAt(h: Homography, p: Point): Local {
  const c = applyHomography(h, p);
  const a = applyHomography(h, { x: p.x + 1, y: p.y });
  const b = applyHomography(h, { x: p.x, y: p.y + 1 });
  return { cx: c.x, cy: c.y, exx: a.x - c.x, exy: a.y - c.y, eyx: b.x - c.x, eyy: b.y - c.y };
}

/** The pixels to a millimetre at a point of the sheet. */
export function pixelsPerMm(h: Homography, at: Point): number {
  const l = localAt(h, at);
  return (Math.hypot(l.exx, l.exy) + Math.hypot(l.eyx, l.eyy)) / 2;
}

/** The grey of solid ink on this picture, from the bodies of the four corner marks (between the window and the edge of each). */
export function blackLevel(image: GreyImage, h: Homography, layout: SheetLayout): number {
  const values: number[] = [];
  const reach = MARK_SIZE * 0.34;
  for (const mark of cornerMarks(layout)) {
    for (const [u, v] of [[reach, 0], [-reach, 0], [0, reach], [0, -reach], [reach, reach], [-reach, -reach], [reach, -reach], [-reach, reach]] as Array<[number, number]>) {
      const p = applyHomography(h, { x: mark.center.x + u, y: mark.center.y + v });
      values.push(sample(image, p.x, p.y));
    }
  }
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)] as number;
}

/**
 * How soft the edges in the picture are, as the width in millimetres of the blur (its standard deviation): the corner marks are sharp
 * squares, so how far the dark takes to turn to light across their edges says how much the scanner, the camera and the paper have
 * softened everything. A sharp scan reads about 0.05 to 0.1; a photograph out of focus a few tenths.
 *
 * Each of the sixteen edges is looked at along a line of five places, going out from the dark of the mark across to the paper, and the
 * ten to ninety percent distance of the turn is the width. Returns undefined when no edge could be measured.
 */
export function edgeSigma(image: GreyImage, h: Homography, layout: SheetLayout): number | undefined {
  const half = MARK_SIZE / 2;
  const reach = 1.6;
  const step = 0.04;
  const widths: number[] = [];
  for (const mark of cornerMarks(layout)) {
    for (const [nx, ny] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as Array<[number, number]>) {
      const tx = -ny;
      const ty = nx;
      const profile: number[] = [];
      for (let s = -reach; s <= reach + 1e-9; s += step) {
        let sum = 0;
        for (const along of [-2.5, -1.25, 0, 1.25, 2.5]) {
          const p = applyHomography(h, { x: mark.center.x + nx * (half + s) + tx * along, y: mark.center.y + ny * (half + s) + ty * along });
          sum += sample(image, p.x, p.y);
        }
        profile.push(sum / 5);
      }
      const end = Math.round(0.4 / step);
      const dark = profile.slice(0, end).reduce((a, b) => a + b, 0) / end;
      const light = profile.slice(-end).reduce((a, b) => a + b, 0) / end;
      if (light - dark < 80) continue;
      const u = profile.map((v) => (v - dark) / (light - dark));
      const cross = (level: number): number | undefined => {
        for (let i = 1; i < u.length; i++) {
          if ((u[i - 1] as number) < level && (u[i] as number) >= level) return (i - 1 + (level - (u[i - 1] as number)) / ((u[i] as number) - (u[i - 1] as number))) * step;
        }
        return undefined;
      };
      const a = cross(0.1);
      const b = cross(0.9);
      if (a !== undefined && b !== undefined && b > a) widths.push(b - a);
    }
  }
  if (widths.length < 6) return undefined;
  return median(widths) / 2.563;
}

/** The error function, to a part in ten million. */
export function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

/**
 * How clear the printed outlines should be in a picture whose edges are blurred by sigma millimetres: a line of the outline's width turned
 * into a smear. About 0.9 on a sharp scan, falling as the blur grows. A picture whose outlines are much less clear than this is one in which
 * the circles are not where the transform has them.
 */
export function expectedRing(sigmaMm: number): number {
  return 0.9 * erf(0.25 / (2 * Math.SQRT2 * Math.max(sigmaMm, 0.03)));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

interface Group {
  centres: Point[];
  radius: number;
}

/** How much more ink the outlines have than the paper just outside them, for a group moved by (ox, oy) millimetres. */
function ringScore(image: GreyImage, locals: Local[], radius: number, ox: number, oy: number, levels: Levels): number {
  const scale = 1 / Math.max(20, levels.paper - levels.black);
  let total = 0;
  for (const l of locals) {
    let ring = 0;
    for (const rad of [radius - 0.08, radius, radius + 0.08]) {
      for (let j = 0; j < ANGLES; j++) {
        const u = ox + rad * (COS[j] as number);
        const v = oy + rad * (SIN[j] as number);
        ring += (levels.paper - sample(image, l.cx + l.exx * u + l.eyx * v, l.cy + l.exy * u + l.eyy * v)) * scale;
      }
    }
    let outer = 0;
    for (let j = 0; j < ANGLES; j++) {
      const u = ox + (radius + 0.65) * (COS[j] as number);
      const v = oy + (radius + 0.65) * (SIN[j] as number);
      outer += (levels.paper - sample(image, l.cx + l.exx * u + l.eyx * v, l.cy + l.exy * u + l.eyy * v)) * scale;
    }
    total += ring / (3 * ANGLES) - outer / ANGLES;
  }
  return total / locals.length;
}

/** Where a group's outlines are, within the search: coarse over the whole range, then fine round the best. */
function findGroup(image: GreyImage, h: Homography, group: Group, levels: Levels): { offset: Point; ring: number; atLimit: boolean; outside: boolean; locals: Local[] } {
  const locals = group.centres.map((c) => localAt(h, c));
  const outside = locals.some((l) => l.cx < 2 || l.cy < 2 || l.cx > image.width - 2 || l.cy > image.height - 2);
  let best = { ox: 0, oy: 0, score: -Infinity };
  const consider = (ox: number, oy: number): void => {
    if (Math.abs(ox) > SEARCH_MM + 1e-9 || Math.abs(oy) > SEARCH_MM + 1e-9) return;
    // A little for staying where the transform put it, so that two equal places go to the one nearer.
    const score = ringScore(image, locals, group.radius, ox, oy, levels) - 0.01 * (ox * ox + oy * oy);
    if (score > best.score) best = { ox, oy, score };
  };
  for (let ox = -SEARCH_MM; ox <= SEARCH_MM + 1e-9; ox += 0.5) for (let oy = -SEARCH_MM; oy <= SEARCH_MM + 1e-9; oy += 0.5) consider(ox, oy);
  const centre = { ...best };
  for (let ox = centre.ox - 0.25; ox <= centre.ox + 0.25 + 1e-9; ox += 0.125) for (let oy = centre.oy - 0.25; oy <= centre.oy + 0.25 + 1e-9; oy += 0.125) consider(ox, oy);
  const atLimit = Math.abs(best.ox) >= SEARCH_MM - 0.13 || Math.abs(best.oy) >= SEARCH_MM - 0.13;
  return { offset: { x: best.ox, y: best.oy }, ring: ringScore(image, locals, group.radius, best.ox, best.oy, levels), atLimit, outside, locals };
}

/** The ink in the inner disc of a bubble, and the paper beside it, as shares of black: a number from 0 (as pale as paper) to 1 (as dark as the marks). */
function inkIn(image: GreyImage, l: Local, radius: number, ox: number, oy: number, levels: Levels): number {
  const rho = radius * INNER;
  let sum = 0;
  for (let i = 0; i < SUNFLOWER; i++) {
    const rad = rho * Math.sqrt((i + 0.5) / SUNFLOWER);
    const a = i * GOLDEN;
    const u = ox + rad * Math.cos(a);
    const v = oy + rad * Math.sin(a);
    sum += sample(image, l.cx + l.exx * u + l.eyx * v, l.cy + l.exy * u + l.eyy * v);
  }
  const mean = sum / SUNFLOWER;
  // The paper beside this bubble, not the paper of the whole picture: a photograph is lit more on one side.
  const around: number[] = [];
  for (let j = 0; j < ANGLES; j++) {
    const u = ox + (radius + 0.75) * (COS[j] as number);
    const v = oy + (radius + 0.75) * (SIN[j] as number);
    around.push(sample(image, l.cx + l.exx * u + l.eyx * v, l.cy + l.exy * u + l.eyy * v));
  }
  // A mark that spills past its bubble can darken the paper round it too, so the local paper is never taken as less than three quarters of the
  // paper of the whole picture: a photograph is lit unevenly, but not so unevenly that a dark ring of ink is paper.
  const paper = Math.max(median(around), mean, 0.75 * levels.paper);
  return Math.max(0, Math.min(1.2, (paper - mean) / Math.max(20, paper - levels.black)));
}

/**
 * Measures every bubble on a page.
 *
 * `rows` are the questions on this page, by their place on the page: the centres of the bubbles each has and the radius of a bubble.
 * `version` is the group of version bubbles, when the page has them.
 */
export function measureBubbles(
  image: GreyImage,
  h: Homography,
  levels: Levels,
  rows: Array<{ slot: number; centres: Point[] }>,
  radius: number,
  version?: { centres: Point[]; radius: number },
): PageMeasure {
  const found = rows.map((row) => ({ row, ...findGroup(image, h, { centres: row.centres, radius }, levels) }));
  const versionFound = version ? { ...findGroup(image, h, { centres: version.centres, radius: version.radius }, levels) } : undefined;

  // A row whose outlines were not clear because its bubbles are solid takes the shift of the nearest rows whose outlines were clear. A row whose
  // outlines were not clear and whose bubbles are not solid is a row that is not where it was searched for (further than the search reaches),
  // and taking the shift of its neighbours would put it right only by luck: it is reported as not found, and never read.
  const rings = found.map((f) => f.ring);
  const ringMedian = median(rings);
  // Weak is weak beside the rows round it, and weak in itself: where no row's outlines show at all, every row is weak.
  const weak = (ring: number): boolean => ring < Math.max(0.4 * ringMedian, 0.08);
  const offsets = found.map((f) => ({ ...f.offset }));
  const inherited = found.map(() => false);
  const good = found.map((f, i) => (!weak(f.ring) && !f.atLimit ? i : -1)).filter((i) => i >= 0);
  // With no row whose outlines are clear there is nothing to take a shift from, and a row left where the transform put it is not known to be
  // anywhere: it is reported as not found, and never read.
  const unknown = good.length === 0;
  const globalX = median(good.map((i) => (found[i] as { offset: Point }).offset.x));
  const globalY = median(good.map((i) => (found[i] as { offset: Point }).offset.y));
  found.forEach((f, i) => {
    if (!weak(f.ring)) return;
    const near = [...good].sort((a, b) => Math.abs(a - i) - Math.abs(b - i)).slice(0, 5);
    offsets[i] = near.length > 0 ? { x: median(near.map((k) => (found[k] as { offset: Point }).offset.x)), y: median(near.map((k) => (found[k] as { offset: Point }).offset.y)) } : { x: globalX, y: globalY };
    inherited[i] = true;
  });

  const inks = found.map((f, i) => f.row.centres.map((_c, k) => inkIn(image, f.locals[k] as Local, radius, (offsets[i] as Point).x, (offsets[i] as Point).y, levels)));
  const unverified = found.map((_f, i) => {
    if (!inherited[i]) return false;
    const row = inks[i] as number[];
    return row.filter((ink) => ink >= SOLID_INK).length * 2 < row.length;
  });
  const versionInks = versionFound && version ? version.centres.map((_c, k) => inkIn(image, versionFound.locals[k] as Local, version.radius, versionFound.offset.x, versionFound.offset.y, levels)) : undefined;

  // The sheet's own blank level: most bubbles on a page are blank, so the middle of them is what blank looks like on this copy.
  const all = [...inks.flat(), ...(versionInks ?? [])];
  const blank = Math.min(0.25, median(all));
  const fillOf = (ink: number): number => Math.max(0, Math.min(1, (ink - blank) / (1 - blank)));

  const rowsOut = found.map((f, i) => ({
    slot: f.row.slot,
    bubbles: (inks[i] as number[]).map((ink) => ({ ink, fill: fillOf(ink) })),
    offset: offsets[i] as Point,
    ring: f.ring,
    atLimit: (f.atLimit && !inherited[i]) || (Boolean(inherited[i]) && (unknown || Boolean(unverified[i]))),
    inherited: inherited[i] as boolean,
  }));
  const shifts = rowsOut.map((r) => Math.hypot(r.offset.x, r.offset.y));
  return {
    rows: rowsOut,
    version: versionFound && versionInks ? { bubbles: versionInks.map((ink) => ({ ink, fill: fillOf(ink) })), offset: versionFound.offset, ring: versionFound.ring, atLimit: versionFound.atLimit, inherited: false } : undefined,
    levels: { ...levels, blank },
    pixelsPerMm: pixelsPerMm(h, { x: 108, y: 140 }),
    ringMedian,
    shiftMax: shifts.length ? Math.max(...shifts) : 0,
    shiftMedian: median(shifts),
    outside: found.some((f) => f.outside) || Boolean(versionFound?.outside),
  };
}
