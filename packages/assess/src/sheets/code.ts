/**
 * The code strip: 48 black or white squares at a known place on every answer sheet, which say what sheet it is.
 *
 * It is OpenAssess's own code and not a QR code, because a fixed row of squares at a known place needs no library to print or to
 * read. It holds, in order and most significant bit first:
 *
 *   Start      1 bit    always black, so a strip read backwards is caught
 *   Layout     4 bits   which arrangement of the grid (1 standard, 2 wide), so old sheets stay readable if the layout changes
 *   Paper      2 bits   Letter, A4, large print Letter, large print A4
 *   Test       20 bits  the test record's fingerprint, so a sheet from another test is refused
 *   Page       6 bits   the page number and the number of pages, each from 1 to 8
 *   Version    3 bits   0 on a sheet shared by every version, 1 to 4 on a sheet printed for one version
 *   Check      12 bits  a CRC of everything before it, so a damaged strip fails and never reads as another test
 *
 * A strip that fails its check is refused with the reason. Nothing is corrected or guessed: a sheet that cannot say what it is does
 * not get scored.
 */

import { MAX_SHEET_PAGES, type PaperName, type SheetStyle } from "./geometry.ts";

export const CODE_BITS = 48;
const DATA_BITS = CODE_BITS - 12;

/** The arrangement of the grid. A value never changes meaning once sheets have been printed with it. */
export const LAYOUT_STANDARD = 1;
export const LAYOUT_WIDE = 2;

export interface SheetCode {
  layout: number;
  paper: PaperName;
  /** Large print is a paper of its own in the code: the sheet is a different size of bubble. */
  large: boolean;
  /** 20 bits. */
  test: number;
  /** From 1. */
  page: number;
  pages: number;
  /** 0 when every version shares the sheet, otherwise 1 to 4. */
  version: number;
}

const PAPER_CODES: Array<{ paper: PaperName; large: boolean }> = [
  { paper: "letter", large: false },
  { paper: "a4", large: false },
  { paper: "letter", large: true },
  { paper: "a4", large: true },
];

/** The layout number a sheet style is printed with. A large print sheet uses the standard arrangement of five places. */
export function layoutNumber(style: SheetStyle): number {
  return style === "wide" ? LAYOUT_WIDE : LAYOUT_STANDARD;
}

/** The style a layout number and a paper code name, or undefined when this program does not know that sheet. */
export function styleOf(code: Pick<SheetCode, "layout" | "large">): SheetStyle | undefined {
  if (code.layout === LAYOUT_WIDE) return code.large ? undefined : "wide";
  if (code.layout === LAYOUT_STANDARD) return code.large ? "large" : "standard";
  return undefined;
}

// A CRC-12 with the polynomial x^12 + x^11 + x^3 + x^2 + x + 1 (0x80F), started at zero, over the bits in order.
const POLY = 0x80f;

function crc12(bits: readonly boolean[]): number {
  let register = 0;
  for (const bit of bits) {
    const top = ((register >> 11) & 1) === 1;
    register = (register << 1) & 0xfff;
    if (top !== bit) register ^= POLY;
  }
  return register;
}

function push(bits: boolean[], value: number, width: number): void {
  for (let i = width - 1; i >= 0; i--) bits.push(((value >> i) & 1) === 1);
}

function take(bits: readonly boolean[], from: number, width: number): number {
  let value = 0;
  for (let i = 0; i < width; i++) value = value * 2 + (bits[from + i] ? 1 : 0);
  return value;
}

export type CodeProblem = string;

/** Why a code cannot be written, or undefined when it can. */
export function codeProblem(code: SheetCode): CodeProblem | undefined {
  if (!Number.isInteger(code.test) || code.test < 0 || code.test >= 2 ** 20) return "the test's fingerprint is not 20 bits";
  if (!Number.isInteger(code.pages) || code.pages < 1 || code.pages > MAX_SHEET_PAGES) return `a test has 1 to ${MAX_SHEET_PAGES} sheet pages`;
  if (!Number.isInteger(code.page) || code.page < 1 || code.page > code.pages) return "the page is not one of the pages";
  if (!Number.isInteger(code.version) || code.version < 0 || code.version > 4) return "the version is 0 to 4";
  if (!Number.isInteger(code.layout) || code.layout < 1 || code.layout > 15) return "the layout is 1 to 15";
  if (styleOf(code) === undefined) return code.layout === LAYOUT_WIDE && code.large ? "there is no wide sheet in large print" : `layout ${code.layout} is not one this program knows`;
  return undefined;
}

/** The 36 data bits with their 12 check bits after them. Exported so that a test can write a strip as another version of the program would. */
export function withCheck(data: readonly boolean[]): boolean[] {
  const bits = [...data];
  push(bits, crc12(bits), 12);
  return bits;
}

/** The 48 bits of a sheet's code, in order from the left of the strip. */
export function encodeCode(code: SheetCode): boolean[] {
  const problem = codeProblem(code);
  if (problem) throw new Error(`This sheet's code cannot be written: ${problem}.`);
  const bits: boolean[] = [true];
  push(bits, code.layout, 4);
  push(bits, PAPER_CODES.findIndex((p) => p.paper === code.paper && p.large === code.large), 2);
  push(bits, code.test, 20);
  push(bits, code.page - 1, 3);
  push(bits, code.pages - 1, 3);
  push(bits, code.version, 3);
  push(bits, crc12(bits), 12);
  return bits;
}

export type CodeReading = { ok: true; code: SheetCode } | { ok: false; reason: string };

/** What a strip says, or why it cannot be trusted. */
export function decodeCode(bits: readonly boolean[]): CodeReading {
  if (bits.length !== CODE_BITS) return { ok: false, reason: `the code strip has ${bits.length} squares, not ${CODE_BITS}` };
  if (bits[0] !== true) return { ok: false, reason: "the code strip does not start where it should, so the page may be upside down or the strip damaged" };
  if (crc12(bits.slice(0, DATA_BITS)) !== take(bits, DATA_BITS, 12)) return { ok: false, reason: "the code strip is damaged: its check does not agree with it" };
  const paper = PAPER_CODES[take(bits, 5, 2)] as { paper: PaperName; large: boolean };
  const code: SheetCode = {
    layout: take(bits, 1, 4),
    paper: paper.paper,
    large: paper.large,
    test: take(bits, 7, 20),
    page: take(bits, 27, 3) + 1,
    pages: take(bits, 30, 3) + 1,
    version: take(bits, 33, 3),
  };
  const problem = codeProblem(code);
  if (problem) return { ok: false, reason: `the code strip says something this program does not know: ${problem}` };
  return { ok: true, code };
}
