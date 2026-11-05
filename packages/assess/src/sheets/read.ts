/**
 * Reading one page of a scanned or photographed answer sheet into a reading: every bubble's fill, what each question says, and every
 * place a person has to look.
 *
 * The steps, each of which can refuse the page with the reason and what to do (a refused page is shown to the instructor, never
 * dropped and never guessed at): find the four corner marks and which way up the page is; settle the paper from the code strip,
 * which must agree with its own check bits and with the paper it was read as; check that the sheet belongs to this test and is
 * printed in the layout this test would print; check the picture is big and sharp enough and the grid is on it; find each row of
 * bubbles by its printed outline and measure it; and apply the rules in decide.ts.
 *
 * A reading holds the fill of every bubble, so a different answer key or a settled version never needs another scan.
 */

import { planSheet, type SheetPlan } from "./plan.ts";
import { versionBubbles, cornerMarks, codeCells, layoutFor, pagesNeeded, slotBubbles, slotRow, PAPER_MM, MARK_SIZE, VERSION_LABELS, type PaperName, type Rect, type SheetLayout } from "./geometry.ts";
import { decodeCode, styleOf, type SheetCode } from "./code.ts";
import { decideQuestion, decideVersion, type FlagKind, type QuestionDecision, type QuestionStatus } from "./decide.ts";
import { applyHomography, homographyFrom, type Homography, type Point } from "./homography.ts";
import { sample, type GreyImage } from "./image.ts";
import { findCornerMarks, paperLevel, type FoundMarks, type Refusal } from "./locate.ts";
import { blackLevel, edgeSigma, expectedRing, measureBubbles, pixelsPerMm, type PageMeasure } from "./measure.ts";
import type { TestRecord } from "../model/test.ts";

export type { Refusal };

/** The least dots to the inch a picture may have: below this the printed circles are a few pixels across. */
export const MIN_DPI = 100;
/** The softest edges the reader will read: the standard deviation of the blur, in millimetres (3 pixels at 150 dots to the inch is about 0.5). */
export const MAX_BLUR_MM = 0.5;
/** How much of the clearness a picture this sharp should show the printed circles at must be there: the rest allows for noise, a JPEG and a page that is not quite flat. */
export const RING_SHARE = 0.5;

export interface QuestionReading {
  /** From 1, as the booklet numbers it. */
  number: number;
  status: QuestionStatus;
  /** The places (from 0) that are filled, when the question is answered. */
  marked: number[];
  /** The fill of every bubble the sheet draws for the question, from the first place. */
  fills: number[];
  kind?: FlagKind;
  reason?: string;
  /** The part of the sheet to show when a person settles it, in millimetres from the top left of the page. */
  rect: Rect;
}

export interface SheetFlag {
  kind: FlagKind | "version";
  /** The question, or undefined for a flag on the sheet itself. */
  question?: number;
  page: number;
  reason: string;
  rect: Rect;
}

export interface SheetReading {
  ok: true;
  code: SheetCode;
  /** The version, from 1: from the sheet's own code when it was printed for one, from the bubble the student filled, or the only version. */
  version?: number;
  versionSource: "code" | "bubble" | "single";
  versionFills?: number[];
  /** The decision for each question on this page, for the version above. Empty when the version is not settled. */
  questions: QuestionReading[];
  /** The fill of every bubble on the page, by question number (from 1), so a decision can be made again for another version. */
  fills: Record<number, number[]>;
  /** The questions whose row could not be found where it should be. */
  unregistered: number[];
  flags: SheetFlag[];
  /** What the picture was like: how many dots to the inch it was read at, and how clearly the printing showed. */
  quality: { dpi: number; markSidePx: number; ring: number; ringExpected: number; blurMm: number; shiftMedianMm: number; shiftMaxMm: number; blankLevel: number; quarterTurns: number; bilevel: boolean };
  /** Things to tell the instructor about the picture, which are not flags on a question. */
  notes: string[];
}

export type SheetResult = SheetReading | Refusal;

const refuse = (cause: Refusal["cause"], reason: string): Refusal => ({ ok: false, cause, reason });

/**
 * Whether a picture is black and white: every pixel black or white, with hardly any grey at the edges of things, which a grey scan has
 * all along every line. Such a picture cannot show a pale mark, and the reader says so.
 */
export function isBilevel(image: GreyImage): boolean {
  let grey = 0;
  let n = 0;
  for (let i = 0; i < image.data.length; i += 5) {
    const v = image.data[i] as number;
    if (v >= 30 && v <= 225) grey++;
    n++;
  }
  return grey / n < 0.005;
}

/** The corner marks' places on a sheet, in the order the finder gives them. */
function sheetCorners(paper: PaperName): Point[] {
  const marks = cornerMarks(layoutFor(paper, "standard"));
  return ["topLeft", "topRight", "bottomRight", "bottomLeft"].map((c) => (marks.find((m) => m.corner === c) as { center: Point }).center);
}

function transformFor(paper: PaperName, found: FoundMarks): Homography | undefined {
  return homographyFrom(sheetCorners(paper), [found.topLeft, found.topRight, found.bottomRight, found.bottomLeft]);
}

/** The code strip as squares, sampled from the picture: each is the mean of a few points round the middle of its place. */
function readStrip(image: GreyImage, h: Homography, layout: SheetLayout, black: number, paper: number): boolean[] {
  const cut = (black + paper) / 2;
  return codeCells(layout).map((cell) => {
    let sum = 0;
    let n = 0;
    for (const [dx, dy] of [[0, 0], [0.7, 0], [-0.7, 0], [0, 0.7], [0, -0.7]] as Array<[number, number]>) {
      const p = applyHomography(h, { x: cell.center.x + dx, y: cell.center.y + dy });
      sum += sample(image, p.x, p.y);
      n++;
    }
    return sum / n < cut;
  });
}

/**
 * A reader for the pages of one test. It keeps the plans of the sheet (which depend on how the sheet was printed, and that is read
 * from each page's own code) so that a class of sheets is read without planning the sheet again for each.
 */
export class SheetReader {
  readonly record: TestRecord;
  private readonly plans = new Map<string, ReturnType<typeof planSheet>>();

  constructor(record: TestRecord) {
    this.record = record;
  }

  plan(paper: PaperName, large: boolean): ReturnType<typeof planSheet> {
    const key = `${paper}:${large}`;
    let plan = this.plans.get(key);
    if (!plan) {
      plan = planSheet(this.record, { paper, large });
      this.plans.set(key, plan);
    }
    return plan;
  }

  /** One page of picture, read. */
  read(image: GreyImage): SheetResult {
    const located = findCornerMarks(image);
    if (!located.ok) return located;
    const found = located.marks;

    // The paper: the sheet is Letter or A4, and which is settled by reading the code strip as each, the nearer shape first. A strip that
    // reads cleanly as a paper must also say it was printed on that paper, so the wrong paper cannot read as a sheet.
    const across = Math.hypot(found.topRight.x - found.topLeft.x, found.topRight.y - found.topLeft.y) + Math.hypot(found.bottomRight.x - found.bottomLeft.x, found.bottomRight.y - found.bottomLeft.y);
    const down = Math.hypot(found.bottomLeft.x - found.topLeft.x, found.bottomLeft.y - found.topLeft.y) + Math.hypot(found.bottomRight.x - found.topRight.x, found.bottomRight.y - found.topRight.y);
    const shape = across / down;
    const shapeOf = (p: PaperName): number => (PAPER_MM[p].width - 32) / (PAPER_MM[p].height - 32);
    const papers = (["letter", "a4"] as PaperName[]).sort((a, b) => Math.abs(shape / shapeOf(a) - 1) - Math.abs(shape / shapeOf(b) - 1));
    const paperGrey = paperLevel(image);
    let chosen: { paper: PaperName; h: Homography; code: SheetCode; black: number } | undefined;
    let strip = "";
    for (const paper of papers) {
      const h = transformFor(paper, found);
      if (!h) continue;
      const layout = layoutFor(paper, "standard");
      const black = blackLevel(image, h, layout);
      if (paperGrey - black < 60) {
        return refuse("quality", "The corner marks are not much darker than the paper in this picture, so nothing on the sheet can be read reliably. Scan again with the scanner set to grey or black and white and the contrast not turned down, or photograph the page in better light.");
      }
      const decoded = decodeCode(readStrip(image, h, layout, black, paperGrey));
      if (decoded.ok && decoded.code.paper === paper) {
        chosen = { paper, h, code: decoded.code, black };
        break;
      }
      if (!strip) strip = decoded.ok ? `the code strip says it was printed on ${decoded.code.paper === "a4" ? "A4" : "Letter"} paper, which is not the shape of this page` : decoded.reason;
    }
    if (!chosen) {
      return refuse("code", `This sheet's code strip could not be read: ${strip}. The strip is the row of black and white squares across the top. Check it is not covered, torn, written on or too faint, and rescan.`);
    }
    const { paper, h, code, black } = chosen;

    const record = this.record;
    if (code.test !== record.fingerprint) {
      const hex = (v: number): string => v.toString(16).toUpperCase().padStart(5, "0");
      return refuse("test", `This sheet is from another test: its code says ${hex(code.test)} and the test being scored is ${hex(record.fingerprint)}. Open the scans for this test, or choose the test this sheet belongs to.`);
    }
    const planned = this.plan(paper, code.large);
    if (!planned.ok) return refuse("test", `The sheet for this test cannot be planned as it was printed: ${planned.reason}.`);
    const plan: SheetPlan = planned.plan;
    const style = styleOf(code);
    if (style !== plan.style) {
      return refuse("test", `This sheet was printed in a ${style} layout, and the test as it stands now would print a ${plan.style} one. The test was changed after the sheets were printed, so they cannot be read against it.`);
    }
    const layout = layoutFor(paper, plan.style);
    if (code.pages !== pagesNeeded(layout, plan.drawn.length)) {
      return refuse("test", `This sheet says the test has ${code.pages} page${code.pages === 1 ? "" : "s"} of answer sheet, and the test as it stands now needs ${pagesNeeded(layout, plan.drawn.length)}. The test was changed after the sheets were printed.`);
    }

    const ppm = pixelsPerMm(h, { x: PAPER_MM[paper].width / 2, y: PAPER_MM[paper].height / 2 });
    const dpi = ppm * 25.4;
    if (Math.round(dpi) < MIN_DPI) {
      return refuse("quality", `This picture is about ${Math.round(dpi)} dots to the inch across the page, and ${MIN_DPI} is the least that can be read (150 is better). Scan at 150 dots to the inch or more, or move the camera closer so the page fills the picture.`);
    }
    const markSideMm = found.side / ppm;
    if (markSideMm < MARK_SIZE * 0.75 || markSideMm > MARK_SIZE * 1.25) {
      return refuse("shape", `The corner marks measure ${markSideMm.toFixed(1)} mm against the ${MARK_SIZE} mm they are printed at, so these are not the marks of this sheet or the picture is distorted. Rescan the page flat.`);
    }

    // The bubbles of this page.
    const perPage = layout.questionsPerPage;
    const first = (code.page - 1) * perPage;
    const rows: Array<{ slot: number; centres: Point[] }> = [];
    for (let slot = 0; slot < perPage; slot++) {
      const drawn = plan.drawn[first + slot];
      if (!drawn) break;
      if (drawn.places > 0) rows.push({ slot, centres: slotBubbles(layout, slot).slice(0, drawn.places) });
    }
    const wantsVersion = code.version === 0 && record.versions.length > 1;
    const group = wantsVersion ? { centres: versionBubbles(layout).slice(0, record.versions.length).map((b) => b.center), radius: 2.5 } : undefined;
    const sigma = edgeSigma(image, h, layout);
    if (sigma === undefined) {
      return refuse("quality", "The edges of the corner marks cannot be measured in this picture, so its sharpness is not known. The picture may be too small, too light or too dark. Scan again at 150 dots to the inch or more in grey, or photograph the page in good light.");
    }
    if (sigma > MAX_BLUR_MM) {
      return refuse("quality", `This picture is blurred: its edges are soft over about ${(sigma * 2.563).toFixed(1)} mm where a sharp scan is under 0.3. Scan again with the page flat on the glass, or hold the camera still and focus on the page.`);
    }
    const measure: PageMeasure = measureBubbles(image, h, { black, paper: paperGrey }, rows, layout.bubbleDiameter / 2, group);
    const ringExpected = expectedRing(sigma);

    if (measure.outside) {
      return refuse("quality", "Part of the grid of bubbles falls outside the picture. The whole page has to be in the picture, with its four black corner squares. Rescan, or photograph it with a margin round it.");
    }
    if (measure.rows.length > 0 && measure.ringMedian < RING_SHARE * ringExpected) {
      return refuse("registration", `The printed circles are not where this sheet has them, or cannot be made out: they show at ${measure.ringMedian.toFixed(2)} where a picture as sharp as this one shows them at ${ringExpected.toFixed(2)}. The page may be scaled, curled or creased, or the picture too small, too light or too dark. Print the sheet at 100 percent (no fit to page), scan it flat at 150 dots to the inch or more, and use Check my printing.`);
    }
    // A page whose circles sit a good way from where the corner marks put them is not refused for that alone: each row has found its own
    // outlines (and the check above holds the clearness of them to what the picture allows), and a row at the edge of the search is flagged.

    // What the pages says: version first, since what a question holds depends on it.
    const flags: SheetFlag[] = [];
    const versionRect: Rect = { x: 0, y: 30, width: layout.width, height: 20 };
    let version: number | undefined;
    let versionSource: SheetReading["versionSource"] = "code";
    let versionFills: number[] | undefined;
    if (code.version !== 0) {
      version = code.version;
    } else if (record.versions.length === 1) {
      version = 1;
      versionSource = "single";
    } else {
      versionSource = "bubble";
      versionFills = measure.version?.bubbles.map((b) => b.fill);
      const decision = decideVersion(versionFills ?? []);
      if (decision.version !== undefined) version = decision.version;
      else flags.push({ kind: "version", page: code.page, reason: decision.reason ?? "The version is not certain.", rect: versionRect });
    }

    const fills: Record<number, number[]> = {};
    const unregistered: number[] = [];
    const registered = new Map<number, boolean>();
    for (const row of measure.rows) {
      const number = first + row.slot + 1;
      fills[number] = row.bubbles.map((b) => b.fill);
      const ok = !row.atLimit;
      registered.set(number, ok);
      if (!ok) unregistered.push(number);
    }
    const bilevel = isBilevel(image);
    const notes: string[] = [];
    if (bilevel) notes.push("This is a black and white picture. A black and white scan loses pale pencil and can turn a smudge solid, so questions with several answers are not read from it. Scan in grey for the most reliable reading.");
    const questions = version !== undefined ? decideAll(plan, version, code.page, layout, fills, registered, bilevel) : [];
    for (const q of questions) {
      if (q.status === "blank" || q.status === "flagged") flags.push({ kind: q.kind as FlagKind, question: q.number, page: code.page, reason: q.reason as string, rect: q.rect });
    }

    return {
      ok: true,
      code,
      version,
      versionSource,
      versionFills,
      questions,
      fills,
      unregistered,
      flags,
      quality: { dpi, markSidePx: found.side, ring: measure.ringMedian, ringExpected, blurMm: sigma, shiftMedianMm: measure.shiftMedian, shiftMaxMm: measure.shiftMax, blankLevel: measure.levels.blank, quarterTurns: found.quarterTurns, bilevel },
      notes,
    };
  }
}

/** The decision for every question on a page, for a version of the test. Used when a sheet is read and again when a person settles its version. */
export function decideAll(plan: SheetPlan, version: number, page: number, layout: SheetLayout, fills: Record<number, number[]>, registered: Map<number, boolean> = new Map(), bilevel = false): QuestionReading[] {
  const label = VERSION_LABELS[version - 1] as (typeof VERSION_LABELS)[number];
  const uses = plan.uses[label];
  const first = (page - 1) * layout.questionsPerPage;
  const out: QuestionReading[] = [];
  for (let slot = 0; slot < layout.questionsPerPage; slot++) {
    const index = first + slot;
    if (index >= plan.drawn.length) break;
    const number = index + 1;
    const f = fills[number] ?? [];
    const decision: QuestionDecision = decideQuestion(f, uses?.[index], registered.get(number) ?? true, bilevel);
    out.push({ number, status: decision.status, marked: decision.marked, fills: f, kind: decision.kind, reason: decision.reason, rect: slotRow(layout, slot) });
  }
  return out;
}
