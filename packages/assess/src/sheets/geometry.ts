/**
 * Where everything is on an answer sheet, in millimetres.
 *
 * This is the one source both the printer and the reader use, so the two cannot disagree about where a bubble sits. Positions are
 * measured from the top left of the page, x to the right and y downward, and a position is always the centre of the thing unless
 * it says it is a rectangle.
 *
 * The page has four corner marks, 8 mm squares inset 12 mm from the paper's edge so that printers, copiers and scanners do not
 * crop them. The top left one has a white centre, which tells the reader which way up the page is. Between the top two is a row of
 * 48 squares that carry a code (code.ts). Under them are the name box and the version bubbles, a few lines of instructions with
 * marks to copy and marks not to make, and the grid: questions run down columns, numbered as the booklet numbers them, with the
 * number on the left and the bubbles to its right.
 *
 * Nothing the reader needs sits within 10 mm of the paper's edge.
 */

export type PaperName = "letter" | "a4";
export type SheetStyle = "standard" | "wide" | "large";

export const PAPER_MM: Record<PaperName, { width: number; height: number }> = {
  letter: { width: 215.9, height: 279.4 },
  a4: { width: 210, height: 297 },
};

/** The corner marks. */
export const MARK_SIZE = 8;
export const MARK_INSET = 12;
/** The white square in the middle of the top left mark. */
export const HOLLOW_SIZE = 3;

/** The code strip: 48 squares of 3 mm in a row. */
export const CODE_CELLS = 48;
export const CODE_CELL = 3;

export const VERSION_LABELS = ["A", "B", "C", "D"] as const;

/** The most pages of an answer sheet that a test can have, from the 3 bits of the code that say how many. */
export const MAX_SHEET_PAGES = 8;

export interface SheetLayout {
  paper: PaperName;
  style: SheetStyle;
  width: number;
  height: number;
  /** Bubbles to a question. */
  places: number;
  bubbleDiameter: number;
  /** Across, from the centre of one bubble to the next. */
  placePitch: number;
  /** Down, from the centre of one row to the next. */
  rowPitch: number;
  rowsPerColumn: number;
  columns: number;
  questionsPerPage: number;
  /** The space for a question's number, to the left of its bubbles. */
  numberWidth: number;
  /** The space between one column and the next. */
  columnGap: number;
  /** Where the grid starts: the left edge of the first column, and the top edge of the first row. */
  gridLeft: number;
  gridTop: number;
}

interface Shape {
  places: number;
  bubbleDiameter: number;
  placePitch: number;
  rowPitch: number;
  rowsPerColumn: number;
  columns: number;
  numberWidth: number;
}

const SHAPES: Record<SheetStyle, Shape> = {
  // A to E, 100 questions on a page.
  standard: { places: 5, bubbleDiameter: 5, placePitch: 6.5, rowPitch: 6, rowsPerColumn: 25, columns: 4, numberWidth: 8 },
  // A to H, for a test with a question of six to eight answers: 50 questions on a page.
  wide: { places: 8, bubbleDiameter: 5, placePitch: 6.5, rowPitch: 6, rowsPerColumn: 25, columns: 2, numberWidth: 8 },
  // 7 mm bubbles for a student who needs them. Three columns of 17 hold 51 questions, where the spec's 50 would not divide.
  // The rows are 10 mm apart and not more: at 10.5 the last row of a Letter sheet ran into the line printed under the grid.
  large: { places: 5, bubbleDiameter: 7, placePitch: 8.5, rowPitch: 10, rowsPerColumn: 17, columns: 3, numberWidth: 11 },
};

const COLUMN_GAP = 3;
const GRID_TOP = 76;

/** Where the line under the grid stands: the baseline of "Mark only inside the bubbles", up from the bottom edge. */
export const FOOTER_RISE = 25;
/** The height of its letters, in millimetres, for a test that the grid stays clear of it. */
export const FOOTER_TEXT_HEIGHT = 2.5;

/** What can be said against a pairing before it is used. Undefined when the pairing is fine. */
export function styleProblem(style: SheetStyle, options: number): string | undefined {
  const max = SHAPES[style].places;
  if (options > max) return `a ${style} sheet has ${max} bubbles to a question, and this test has a question of ${options} answers`;
  return undefined;
}

export function layoutFor(paper: PaperName, style: SheetStyle): SheetLayout {
  const { width, height } = PAPER_MM[paper];
  const s = SHAPES[style];
  const columnWidth = s.numberWidth + s.places * s.placePitch;
  const total = s.columns * columnWidth + (s.columns - 1) * COLUMN_GAP;
  return {
    paper,
    style,
    width,
    height,
    ...s,
    questionsPerPage: s.rowsPerColumn * s.columns,
    columnGap: COLUMN_GAP,
    gridLeft: (width - total) / 2,
    gridTop: GRID_TOP,
  };
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How wide one column of the grid is, number and bubbles together. */
export const columnWidth = (l: SheetLayout): number => l.numberWidth + l.places * l.placePitch;

export interface CornerMark {
  corner: "topLeft" | "topRight" | "bottomLeft" | "bottomRight";
  center: Point;
  size: number;
  /** A white square in the middle, which marks the top left. */
  hollow: boolean;
}

export function cornerMarks(l: SheetLayout): CornerMark[] {
  const c = MARK_INSET + MARK_SIZE / 2;
  return [
    { corner: "topLeft", center: { x: c, y: c }, size: MARK_SIZE, hollow: true },
    { corner: "topRight", center: { x: l.width - c, y: c }, size: MARK_SIZE, hollow: false },
    { corner: "bottomLeft", center: { x: c, y: l.height - c }, size: MARK_SIZE, hollow: false },
    { corner: "bottomRight", center: { x: l.width - c, y: l.height - c }, size: MARK_SIZE, hollow: false },
  ];
}

/** The 48 squares of the code strip, left to right, each the centre of its square. */
export function codeCells(l: SheetLayout): Array<{ index: number; center: Point; size: number }> {
  const left = (l.width - CODE_CELLS * CODE_CELL) / 2;
  const y = MARK_INSET + MARK_SIZE / 2;
  return Array.from({ length: CODE_CELLS }, (_x, index) => ({ index, center: { x: left + (index + 0.5) * CODE_CELL, y }, size: CODE_CELL }));
}

/** Where the student writes a name: never read by software, and shown at review as a picture. */
export function nameBox(l: SheetLayout): Rect {
  return { x: 22, y: 34, width: l.width - 22 - 22 - 60, height: 14 };
}

/** The four version bubbles, A to D. They are left off a test with one version. */
export function versionBubbles(l: SheetLayout): Array<{ label: (typeof VERSION_LABELS)[number]; center: Point }> {
  return VERSION_LABELS.map((label, i) => ({ label, center: { x: l.width - 52 + i * 9, y: 41 } }));
}

/** The picture of a version bubble's whole group, for review. */
export function versionArea(l: SheetLayout): Rect {
  const first = versionBubbles(l)[0] as { center: Point };
  return { x: first.center.x - 6, y: 34, width: 3 * 9 + 12, height: 14 };
}

/** Where the lines of instruction go: to the left of the example marks. */
export function instructionArea(l: SheetLayout): Rect {
  return { x: 22, y: 52, width: l.width - 22 - 104, height: 18 };
}

/** The marks the instructions show: one right, and three that are not. They are never read. */
export function exampleMarks(l: SheetLayout): Array<{ kind: "right" | "tick" | "cross" | "half"; center: Point }> {
  const kinds = ["right", "tick", "cross", "half"] as const;
  return kinds.map((kind, i) => ({ kind, center: { x: l.width - 96 + i * 22, y: 60 } }));
}

export interface QuestionPlace {
  /** Which page of the answer sheet, from 0. */
  page: number;
  /** Which question on that page, from 0. */
  slot: number;
}

/** Where the question with this number (from 1) is: its page and its place on that page. */
export function placeOf(l: SheetLayout, questionNumber: number): QuestionPlace {
  const index = questionNumber - 1;
  return { page: Math.floor(index / l.questionsPerPage), slot: index % l.questionsPerPage };
}

/** How many sheet pages a test of this many questions takes. */
export const pagesNeeded = (l: SheetLayout, questions: number): number => Math.max(1, Math.ceil(questions / l.questionsPerPage));

/** The left edge of the column a slot is in. */
function columnLeft(l: SheetLayout, slot: number): number {
  return l.gridLeft + Math.floor(slot / l.rowsPerColumn) * (columnWidth(l) + l.columnGap);
}

/** The centre of a row: vertically where its bubbles are. */
function rowCenterY(l: SheetLayout, slot: number): number {
  return l.gridTop + ((slot % l.rowsPerColumn) + 0.5) * l.rowPitch;
}

/** The centres of the bubbles of one slot, from the first place. */
export function slotBubbles(l: SheetLayout, slot: number): Point[] {
  const left = columnLeft(l, slot) + l.numberWidth;
  const y = rowCenterY(l, slot);
  return Array.from({ length: l.places }, (_x, p) => ({ x: left + (p + 0.5) * l.placePitch, y }));
}

/** Where the question's number is printed: the right edge of its space and the centre of its row. */
export function slotNumberAnchor(l: SheetLayout, slot: number): Point {
  return { x: columnLeft(l, slot) + l.numberWidth - 1.5, y: rowCenterY(l, slot) };
}

/** The whole of a question's row, the number and the bubbles, for the picture shown at review. */
export function slotRow(l: SheetLayout, slot: number): Rect {
  return { x: columnLeft(l, slot), y: rowCenterY(l, slot) - l.rowPitch / 2, width: columnWidth(l), height: l.rowPitch };
}

/** The letter of a place: A, B, C and on. */
export const placeName = (place: number): string => String.fromCharCode(65 + place);
