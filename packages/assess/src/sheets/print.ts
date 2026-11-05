/**
 * Printing the answer sheet: one PDF that is the master, photocopied for the class.
 *
 * The sheet is a PDF only, at 100 percent, because Word cannot promise where a shape lands on a page. Everything on it is drawn
 * from the positions in geometry.ts, in millimetres converted once to points here, and the same file is what the reader measures
 * against, so they cannot disagree about where a bubble is.
 *
 * What is drawn: four corner marks (the top left with a white centre), the code strip, the title and a name box, the version bubbles
 * when there is more than one version, a few lines of instruction with a mark to copy and three not to make, and the grid of
 * bubbles with the question numbers. A question the sheet cannot carry keeps its number and has no bubbles.
 */

import { deflateSync } from "node:zlib";

import { measureText } from "../print/pdf.ts";
import { encodeCode, layoutNumber, type SheetCode } from "./code.ts";
import {
  CODE_CELL,
  FOOTER_RISE,
  HOLLOW_SIZE,
  VERSION_LABELS,
  cornerMarks,
  codeCells,
  exampleMarks,
  instructionArea,
  layoutFor,
  nameBox,
  pagesNeeded,
  slotBubbles,
  slotNumberAnchor,
  versionBubbles,
  type Point,
  type SheetLayout,
} from "./geometry.ts";
import type { SheetPlan } from "./plan.ts";

const PT = 72 / 25.4;
const KAPPA = 0.5522847498;
const BLACK = "0 g 0 G";

const n = (value: number): string => String(Math.round(value * 1000) / 1000);

/** Text a PDF string can hold: Latin-1, with anything else a question mark, and the three characters that need a backslash. */
function pdfString(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    const c = code > 255 || code < 32 ? "?" : ch;
    out += c === "(" || c === ")" || c === "\\" ? `\\${c}` : c.charCodeAt(0) > 126 ? `\\${c.charCodeAt(0).toString(8).padStart(3, "0")}` : c;
  }
  return `(${out})`;
}

/**
 * Where a sheet is drawn. The sheet is described once, in drawSheetPage, as these five shapes in millimetres from the top left, and
 * a surface turns them into something: the PDF writer below makes the operators of a page, and raster.ts makes pixels for the test
 * harness. The picture a reader is tested on is therefore the printed page drawn by another hand, never a second description of it.
 */
export interface Surface {
  /** A rectangle given by its top left corner, filled or outlined, in a grey (0 black, 1 white). */
  rect(x: number, y: number, w: number, h: number, mode: "f" | "S", gray?: number): void;
  /** A circle outline or disc. */
  circle(c: Point, diameter: number, mode: "f" | "S", gray?: number, width?: number): void;
  /** The lower half of a disc. */
  halfDisc(c: Point, diameter: number): void;
  line(a: Point, b: Point, width?: number, gray?: number): void;
  /** Text with its baseline at y. The x is the left, centre or right of the text. */
  text(str: string, x: number, y: number, size: number, o?: { bold?: boolean; align?: "left" | "center" | "right"; gray?: number }): void;
}

/** A page of drawing in millimetres from the top left, as the operators of a PDF content stream. */
class Page implements Surface {
  readonly ops: string[] = [];
  readonly height: number;

  constructor(height: number) {
    this.height = height;
  }

  private x = (mm: number): string => n(mm * PT);
  private y = (mm: number): string => n((this.height - mm) * PT);

  /** A rectangle given by its top left corner. */
  rect(x: number, y: number, w: number, h: number, mode: "f" | "S", gray = 0): void {
    this.ops.push(`${n(gray)} g ${n(gray)} G ${this.x(x)} ${this.y(y + h)} ${n(w * PT)} ${n(h * PT)} re ${mode}`);
  }

  /** A circle outline or disc, from four curves, so a reader of the file can find its centre and size from the drawing itself. */
  circle(c: Point, diameter: number, mode: "f" | "S", gray = 0, width = 0.25): void {
    const r = diameter / 2;
    const k = KAPPA * r;
    const p = (x: number, y: number): string => `${this.x(x)} ${this.y(y)}`;
    this.ops.push(
      `${n(gray)} g ${n(gray)} G ${n(width * PT)} w ${p(c.x + r, c.y)} m ` +
        `${p(c.x + r, c.y + k)} ${p(c.x + k, c.y + r)} ${p(c.x, c.y + r)} c ` +
        `${p(c.x - k, c.y + r)} ${p(c.x - r, c.y + k)} ${p(c.x - r, c.y)} c ` +
        `${p(c.x - r, c.y - k)} ${p(c.x - k, c.y - r)} ${p(c.x, c.y - r)} c ` +
        `${p(c.x + k, c.y - r)} ${p(c.x + r, c.y - k)} ${p(c.x + r, c.y)} c h ${mode}`,
    );
  }

  /** The lower half of a disc: a half-filled bubble, as an example of a mark that is not enough. */
  halfDisc(c: Point, diameter: number): void {
    const r = diameter / 2;
    const k = KAPPA * r;
    const p = (x: number, y: number): string => `${this.x(x)} ${this.y(y)}`;
    this.ops.push(`0 g 0 G ${p(c.x - r, c.y)} m ${p(c.x - r, c.y + k)} ${p(c.x - k, c.y + r)} ${p(c.x, c.y + r)} c ${p(c.x + k, c.y + r)} ${p(c.x + r, c.y + k)} ${p(c.x + r, c.y)} c h f`);
  }

  line(a: Point, b: Point, width = 0.4, gray = 0): void {
    this.ops.push(`${n(gray)} G ${n(width * PT)} w ${this.x(a.x)} ${this.y(a.y)} m ${this.x(b.x)} ${this.y(b.y)} l S`);
  }

  /** Text with its baseline at y. The x is the left, centre or right of the text. */
  text(str: string, x: number, y: number, size: number, o: { bold?: boolean; align?: "left" | "center" | "right"; gray?: number } = {}): void {
    const width = measureText(str, size, o.bold ? "bold" : "regular") / PT;
    const left = o.align === "center" ? x - width / 2 : o.align === "right" ? x - width : x;
    this.ops.push(`BT ${n(o.gray ?? 0)} g /${o.bold ? "F2" : "F1"} ${n(size)} Tf 1 0 0 1 ${this.x(left)} ${this.y(y)} Tm ${pdfString(str)} Tj ET`);
  }
}

/** Lines of text no wider than a width, broken between words. */
function wrap(text: string, widthMm: number, size: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line === "" ? word : `${line} ${word}`;
    if (line !== "" && measureText(next, size) / PT > widthMm) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line !== "") lines.push(line);
  return lines;
}

export interface SheetInput {
  title: string;
  /** The test record's fingerprint, 20 bits. */
  fingerprint: number;
  /** How many versions the test has. */
  versions: number;
  /** Print the sheet for one version (1 to 4) instead of the shared sheet with version bubbles. */
  version?: number;
  /** Print the name box. On by default. */
  nameBox?: boolean;
}

/** The code a page of this sheet carries. */
export function sheetCode(plan: SheetPlan, input: SheetInput, page: number): SheetCode {
  const layout = layoutFor(plan.paper, plan.style);
  return {
    layout: layoutNumber(plan.style),
    paper: plan.paper,
    large: plan.large,
    test: input.fingerprint,
    page,
    pages: pagesNeeded(layout, plan.drawn.length),
    version: input.version ?? 0,
  };
}

const hex5 = (value: number): string => value.toString(16).toUpperCase().padStart(5, "0");

/** Draws one page of the sheet (from 1) onto a surface. */
export function drawSheetPage(plan: SheetPlan, input: SheetInput, pageNumber: number, page: Surface): void {
  const layout = layoutFor(plan.paper, plan.style);
  const pages = pagesNeeded(layout, plan.drawn.length);

  // The corner marks. The top left has a white square in its middle.
  for (const mark of cornerMarks(layout)) {
    page.rect(mark.center.x - mark.size / 2, mark.center.y - mark.size / 2, mark.size, mark.size, "f");
    if (mark.hollow) page.rect(mark.center.x - HOLLOW_SIZE / 2, mark.center.y - HOLLOW_SIZE / 2, HOLLOW_SIZE, HOLLOW_SIZE, "f", 1);
  }

  // The code strip: a black square for each 1.
  const bits = encodeCode(sheetCode(plan, input, pageNumber));
  for (const cell of codeCells(layout)) {
    if (bits[cell.index]) page.rect(cell.center.x - CODE_CELL / 2, cell.center.y - CODE_CELL / 2, CODE_CELL, CODE_CELL, "f");
  }
  // In words, for a person: which test and which sheet, so a loose sheet can be put with its own.
  page.text(`Test ${hex5(input.fingerprint)}   Sheet ${pageNumber} of ${pages}${input.version ? `   Version ${VERSION_LABELS[input.version - 1]}` : ""}`, layout.width / 2, 25, 6.5, { align: "center", gray: 0.4 });

  // The title, the name box, and the version.
  page.text(input.title, 22, 31, 13, { bold: true });
  if (input.nameBox !== false) {
    const box = nameBox(layout);
    page.rect(box.x, box.y, box.width, box.height, "S", 0);
    page.text("Name", box.x + 1.5, box.y + 3.5, 6.5, { gray: 0.45 });
  }
  if (input.versions > 1 && input.version === undefined) {
    const bubbles = versionBubbles(layout).slice(0, input.versions);
    const first = bubbles[0] as { center: Point };
    page.text("Version", first.center.x - 2.5, first.center.y - 4.5, 6.5, { gray: 0.45 });
    for (const b of bubbles) {
      page.circle(b.center, 5, "S");
      page.text(b.label, b.center.x, b.center.y + 0.9, 6.5, { align: "center", gray: 0.7 });
    }
  } else if (input.version !== undefined) {
    page.text(`Version ${VERSION_LABELS[input.version - 1]}`, layout.width - 52, 44, 11, { bold: true });
  }

  // The instructions, and the marks to copy and not to copy.
  const area = instructionArea(layout);
  const lines: string[] = ["Use a pencil or a dark pen. Fill the bubble completely. If you change an answer, erase the old mark completely."];
  const uses = Object.values(plan.uses).flat();
  if (uses.some((u) => u?.kind === "multiple")) lines.push("When a question says to select all that apply, fill in every answer that is right.");
  if (plan.lettersForTrueFalse) lines.push("For a true or false question, A is True and B is False.");
  // Any version, not only a place that has no bubbles in all of them: with shuffled questions an essay can stand where another version
  // has a choice question, so the sheet has bubbles there and the student of the one version still has to answer in the booklet.
  if (uses.some((u) => u?.kind === "none")) lines.push("A question that cannot be answered with a bubble is answered in the test booklet.");
  let y = area.y + 2.8;
  for (const text of lines.flatMap((l) => wrap(l, area.width, 7.5))) {
    page.text(text, area.x, y, 7.5);
    y += 3.5;
  }
  for (const m of exampleMarks(layout)) {
    const r = layout.bubbleDiameter / 2;
    page.circle(m.center, layout.bubbleDiameter, "S");
    if (m.kind === "right") page.circle(m.center, layout.bubbleDiameter - 0.6, "f");
    else if (m.kind === "tick") {
      page.line({ x: m.center.x - r * 0.7, y: m.center.y + r * 0.1 }, { x: m.center.x - r * 0.15, y: m.center.y + r * 0.65 }, 0.5);
      page.line({ x: m.center.x - r * 0.15, y: m.center.y + r * 0.65 }, { x: m.center.x + r * 1.0, y: m.center.y - r * 0.9 }, 0.5);
    } else if (m.kind === "cross") {
      page.line({ x: m.center.x - r * 0.7, y: m.center.y - r * 0.7 }, { x: m.center.x + r * 0.7, y: m.center.y + r * 0.7 }, 0.5);
      page.line({ x: m.center.x - r * 0.7, y: m.center.y + r * 0.7 }, { x: m.center.x + r * 0.7, y: m.center.y - r * 0.7 }, 0.5);
    } else page.halfDisc(m.center, layout.bubbleDiameter - 0.6);
    page.text(m.kind === "right" ? "Right" : m.kind === "tick" ? "Not a tick" : m.kind === "cross" ? "Not a cross" : "Not half", m.center.x, m.center.y + 6.5, 6, { align: "center", gray: 0.35 });
  }

  // The grid.
  const first = (pageNumber - 1) * layout.questionsPerPage;
  for (let slot = 0; slot < layout.questionsPerPage; slot++) {
    const index = first + slot;
    if (index >= plan.drawn.length) break;
    const drawn = plan.drawn[index] as SheetPlan["drawn"][number];
    const anchor = slotNumberAnchor(layout, slot);
    page.text(`${index + 1}.`, anchor.x, anchor.y + 1, layout.style === "large" ? 11 : 8, { align: "right" });
    const centers = slotBubbles(layout, slot);
    if (drawn.places === 0) {
      page.text("answer in the booklet", (centers[0] as Point).x - layout.placePitch / 2 + 1, anchor.y + 1, 6.5, { gray: 0.5 });
      continue;
    }
    for (let p = 0; p < drawn.places; p++) {
      const c = centers[p] as Point;
      page.circle(c, layout.bubbleDiameter, "S");
      page.text(drawn.labels[p] as string, c.x, c.y + (layout.style === "large" ? 1.3 : 0.9), layout.style === "large" ? 8 : 6.5, { align: "center", gray: 0.7 });
    }
  }

  page.text("Mark only inside the bubbles, and only between the four black squares.", layout.width / 2, layout.height - FOOTER_RISE, 6.5, { align: "center", gray: 0.45 });
}

function drawPage(plan: SheetPlan, input: SheetInput, layout: SheetLayout, pageNumber: number): Page {
  const page = new Page(layout.height);
  drawSheetPage(plan, input, pageNumber, page);
  return page;
}

export interface SheetFile {
  bytes: Uint8Array;
  pages: number;
}

/** The answer sheet as a PDF: one page for every 100 questions on a standard sheet (50 on a wide one, 51 in large print). */
export function printSheet(plan: SheetPlan, input: SheetInput, at: Date = new Date()): SheetFile {
  const layout = layoutFor(plan.paper, plan.style);
  const pages = pagesNeeded(layout, plan.drawn.length);
  const drawn = Array.from({ length: pages }, (_x, i) => drawPage(plan, input, layout, i + 1));

  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const write = (chunk: Buffer | string): void => {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "latin1") : chunk;
    parts.push(buffer);
    length += buffer.length;
  };
  const object = (id: number, body: string): void => {
    offsets[id] = length;
    write(`${id} 0 obj\n${body}\nendobj\n`);
  };

  write("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  const firstPage = 6;
  const pageIds = drawn.map((_p, i) => firstPage + 2 * i);
  const title = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(`${input.title} answer sheet`, "utf16le").swap16()]).toString("hex").toUpperCase();
  const date = at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "");
  object(1, "<< /Type /Catalog /Pages 2 0 R /Lang (en-US) /ViewerPreferences << /DisplayDocTitle true >> >>");
  object(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages} >>`);
  object(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  object(4, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  object(5, `<< /Title <${title}> /Producer (OpenAssess) /Creator (OpenAssess) /CreationDate (D:${date}) >>`);
  const resources = "<< /Font << /F1 3 0 R /F2 4 0 R >> >>";
  drawn.forEach((page, i) => {
    const id = pageIds[i] as number;
    const content = deflateSync(Buffer.from(`${BLACK}\n${page.ops.join("\n")}`, "latin1"));
    object(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(layout.width * PT)} ${n(layout.height * PT)}] /Resources ${resources} /Contents ${id + 1} 0 R >>`);
    offsets[id + 1] = length;
    write(`${id + 1} 0 obj\n<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`);
    write(content);
    write("\nendstream\nendobj\n");
  });
  const count = firstPage + 2 * pages;
  const xref = length;
  write(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let id = 1; id < count; id++) write(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  write(`trailer\n<< /Size ${count} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return { bytes: new Uint8Array(Buffer.concat(parts)), pages };
}
