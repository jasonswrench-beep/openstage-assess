/**
 * Check my printing: what the reader makes of a blank copy of the sheet that has been printed and scanned or photographed.
 *
 * The instructor prints the sheet, and before the class is given the real thing, scans one copy that nobody has marked. If the reader
 * can find the corners and the code, and every bubble comes out blank, then the printer, the paper and the scanner are all
 * doing what the reading needs. If not, the check says which part is wrong and what to change: a sheet printed at 95 percent by "fit to
 * page", a faint printer, a scanner that crops the corners, a copier that leaves a grey shadow in the bubbles.
 */

import { SheetReader, type SheetReading } from "./read.ts";
import type { Refusal } from "./locate.ts";
import type { GreyImage } from "./image.ts";
import { MARK_SIZE } from "./geometry.ts";
import { BLANK } from "./decide.ts";

export interface PrintingCheck {
  ok: boolean;
  /** What was found, in plain words, for the instructor. */
  found: string[];
  /** What is wrong and what to do about it. Empty when the printing is fine. */
  problems: string[];
  reading?: SheetReading;
  refusal?: Refusal;
}

export interface CheckOptions {
  /** The dots to the inch the picture says it was scanned at, when it says (a PNG's physical size, a JPEG's or a PDF's own). */
  dpi?: number;
}

const paperName = (paper: string): string => (paper === "a4" ? "A4" : "Letter");

export function checkPrinting(reader: SheetReader, image: GreyImage, options: CheckOptions = {}): PrintingCheck {
  const read = reader.read(image);
  if (!read.ok) {
    return { ok: false, found: [], problems: [read.reason], refusal: read };
  }
  const found: string[] = [];
  const problems: string[] = [];
  const hex = read.code.test.toString(16).toUpperCase().padStart(5, "0");
  found.push(`Found the four corner marks and the code strip: test ${hex}, sheet ${read.code.page} of ${read.code.pages}, ${paperName(read.code.paper)} paper${read.code.large ? ", large print" : ""}${read.code.version ? `, for version ${String.fromCharCode(64 + read.code.version)}` : ""}.`);
  found.push(`The picture is about ${Math.round(read.quality.dpi)} dots to the inch, and its edges are soft over ${(read.quality.blurMm * 2.563).toFixed(2)} mm (under 0.3 is sharp).`);

  // The printed size, when the picture says how many dots to the inch it is: a sheet printed with "fit to page" or "shrink to printable area" is smaller than it was made.
  // The reader finds how many dots to the inch the sheet itself has, from the distance between its corner marks, and the picture says how many it was
  // scanned at, so the share of the nominal size is the one over the other.
  if (options.dpi !== undefined && options.dpi > 0) {
    const percent = (read.quality.dpi / options.dpi) * 100;
    found.push(`The picture was scanned at ${Math.round(options.dpi)} dots to the inch, and the corner marks are spaced as a sheet printed at about ${percent.toFixed(0)} percent of its size would be. The marks themselves are ${MARK_SIZE} mm at full size.`);
    if (Math.abs(percent - 100) > 4) {
      problems.push(`The sheet was printed at about ${percent.toFixed(0)} percent of its size. Print it again at 100 percent ("actual size", not "fit to page" or "shrink to fit"), or check that the scan was made at the dots to the inch it says. The reader copes with a sheet that is a little off, but a sheet that has been shrunk puts the bubbles closer than the pencil is wide.`);
    }
  } else {
    found.push("The picture does not say how many dots to the inch it was scanned at, so the size the sheet was printed at could not be checked. If it was printed with \"fit to page\", print it again at 100 percent.");
  }

  // A blank copy has nothing in its bubbles.
  const questions = read.questions;
  // A test of several versions prints a row of version bubbles, and on a blank copy none of them is filled: that is how a blank copy is, and the
  // reader's own words for it ("No version bubble is marked") are about a student's sheet. What is wrong on a blank copy is a bubble that is not empty.
  const dirtyVersion = (read.versionFills ?? []).filter((fill) => fill > BLANK);
  if (dirtyVersion.length > 0) {
    problems.push(`A version bubble reads as marked or unclear on a copy that should be blank (${read.flags.find((f) => f.kind === "version")?.reason ?? `fill ${dirtyVersion.map((v) => v.toFixed(2)).join(", ")}`}) Check that the copy is unmarked and the sheet is clean.`);
  }
  // A shared sheet of a test with several versions has no questions decided on a blank copy, since which version it is stays unknown, and a check
  // that looked only at decided questions would count none and find nothing. The fills of every bubble are on the reading either way, so a copy whose
  // version is not known is judged by them: a row with any bubble above what paper reads as is marked.
  const byFill = questions.length === 0 && Object.keys(read.fills).length > 0;
  const marked = byFill
    ? Object.entries(read.fills)
        .filter(([, fills]) => fills.some((fill) => fill > BLANK))
        .map(([number]) => ({ number: Number(number) }))
    : questions.filter((q) => q.status === "answered" || (q.status === "flagged" && q.kind !== "registration" && q.kind !== "bilevel"));
  const total = byFill ? Object.keys(read.fills).length : questions.filter((q) => q.status !== "notOnSheet").length;
  const blank = byFill ? total - marked.length : questions.filter((q) => q.status === "blank").length;
  const bubbles = Object.values(read.fills).flat();
  const darkest = bubbles.length ? Math.max(...bubbles) : 0;
  found.push(`${blank} of ${total} questions read as blank; the darkest bubble reads ${darkest.toFixed(2)} where a mark reads 0.5 or more and paper reads 0.00 to 0.02.`);
  if (marked.length > 0) {
    problems.push(`${marked.length} question${marked.length === 1 ? "" : "s"} (${marked.slice(0, 8).map((q) => q.number).join(", ")}${marked.length > 8 ? ", and more" : ""}) read as marked on a copy that should be blank. Something dark is in the bubbles: a shadow from the lid, toner or ink spread, a scanner that adds noise, a mark on the copy. Try another copy, clean the glass, or print on a better printer.`);
  }
  if (read.unregistered.length > 0) {
    problems.push(`The printed circles of ${read.unregistered.length} row${read.unregistered.length === 1 ? "" : "s"} (questions ${read.unregistered.slice(0, 8).join(", ")}) are not where they should be, so those rows could not be read. The page may be curled or creased, or the printer may have stretched the sheet.`);
  }
  const share = read.quality.ring / read.quality.ringExpected;
  found.push(`The printed circles show at ${(share * 100).toFixed(0)} percent of the clearness a picture this sharp should show them at.`);
  if (share < 0.7) problems.push("The printed circles are fainter than they should be. Print the sheet darker (draft or toner saver off), or scan with the contrast not turned down.");
  // Rounded the way it is said: a sheet at 150 dots to the inch measures 149.97 or 150.03, and must not be told that 150 would be better.
  if (Math.round(read.quality.dpi) < 150) problems.push(`The picture is about ${Math.round(read.quality.dpi)} dots to the inch. It reads, but 150 or more is better, and filled sheets are read more surely at 200.`);
  if (read.quality.bilevel) problems.push("This is a black and white picture. A black and white scan loses pale pencil, and the reader will not read questions with several answers from one. Scan in grey for the most reliable reading.");
  if (read.quality.shiftMaxMm > 0.8) found.push(`The printing sits up to ${read.quality.shiftMaxMm.toFixed(1)} mm from where the corner marks put it, which the reader allows for.`);
  return { ok: problems.length === 0, found, problems, reading: read };
}
