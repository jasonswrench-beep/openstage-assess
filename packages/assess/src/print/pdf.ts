/**
 * A printed test as a PDF, written by hand with no library.
 *
 * The file uses the fonts every PDF reader has built in (Helvetica, in four weights, and Courier), so nothing is embedded
 * and the file is small. Those fonts hold the Western European characters of Windows Latin-1, and the built-in Symbol font
 * holds the Greek letters and the signs of mathematics (less than or equal, the integral, the arrows), which are drawn from it
 * where a text has them. A character outside both, such as a letter in another script, cannot be drawn, is printed as a
 * question mark, and is counted so that the report can say so and point to the Word file, which can hold any text.
 *
 * The layout is the same as Word's: this draws the blocks it is given. Lines are broken with the real widths of the fonts,
 * a little under the full width so that a small error in a width cannot push a word past the margin, and a question is kept
 * on a page with its first answer. The file is untagged, which is another cost: a screen reader gets a better reading from
 * the Word file.
 */

import { deflateSync } from "node:zlib";

import { symbolCodeOf } from "../import/docx/symbols.ts";
import type { Block, Para, PdfImage, PrintDocument, PrintedPicture, Run } from "./layout.ts";

const NUMBER_INDENT = 28;

type FontKey = "regular" | "bold" | "italic" | "boldItalic" | "mono";
/** A face a piece of text is drawn in: one of the Latin faces, or the Symbol font for a Greek letter or a sign. */
type Face = FontKey | "symbol";
const BASE_FONT: Record<FontKey, string> = { regular: "Helvetica", bold: "Helvetica-Bold", italic: "Helvetica-Oblique", boldItalic: "Helvetica-BoldOblique", mono: "Courier" };
const RESOURCE: Record<Face, string> = { regular: "F1", bold: "F2", italic: "F3", boldItalic: "F4", mono: "F5", symbol: "F6" };

/**
 * The widths of the Symbol font's characters, by Symbol code, in thousandths of the size (the font's published metrics, written
 * from memory of them). They decide only where a line is broken: a line with a Symbol character is drawn in one text object, in
 * which the reader moves along by the font's real widths, so a width that is a little off cannot make two pieces touch.
 */
const SYMBOL_WIDTH: Record<number, number> = {
  0x41: 722, 0x42: 667, 0x43: 722, 0x44: 612, 0x45: 611, 0x46: 763, 0x47: 603, 0x48: 722, 0x49: 333, 0x4a: 631, 0x4b: 722, 0x4c: 686, 0x4d: 889,
  0x4e: 722, 0x4f: 722, 0x50: 768, 0x51: 741, 0x52: 556, 0x53: 592, 0x54: 611, 0x55: 690, 0x56: 439, 0x57: 768, 0x58: 645, 0x59: 795, 0x5a: 611,
  0x61: 631, 0x62: 549, 0x63: 549, 0x64: 494, 0x65: 439, 0x66: 521, 0x67: 411, 0x68: 603, 0x69: 329, 0x6a: 603, 0x6b: 549, 0x6c: 549, 0x6d: 576,
  0x6e: 521, 0x6f: 549, 0x70: 549, 0x71: 521, 0x72: 549, 0x73: 603, 0x74: 439, 0x75: 576, 0x76: 713, 0x77: 686, 0x78: 493, 0x79: 686, 0x7a: 494,
  0x2d: 549, 0x2a: 500, 0x22: 713, 0x24: 549, 0x27: 439, 0x40: 549, 0x5c: 863, 0x5e: 658, 0x7e: 549,
  0xa3: 549, 0xa5: 713, 0xab: 1042, 0xac: 987, 0xad: 603, 0xae: 987, 0xaf: 603, 0xb3: 549, 0xb5: 713, 0xb6: 494, 0xb9: 549, 0xba: 549, 0xbb: 549,
  0xc0: 823, 0xc6: 823, 0xc7: 768, 0xc8: 768, 0xce: 713, 0xcf: 713, 0xd1: 713, 0xd5: 823, 0xd6: 549, 0xd8: 713, 0xd9: 603, 0xda: 603,
  0xdb: 1042, 0xdc: 987, 0xde: 987, 0xe5: 713, 0xf2: 274,
};
const symbolWidth = (code: number): number => SYMBOL_WIDTH[code] ?? 650;

// The widths of the printable characters 32 to 126 in Helvetica and Helvetica-Bold, in thousandths of the size.
const REGULAR = (
  "278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 278 278 584 584 584 556 1015 " +
  "667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 333 " +
  "556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500 500 334 260 334 584"
)
  .split(" ")
  .map(Number);
const BOLD = (
  "278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 556 556 333 333 584 584 584 611 975 " +
  "722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 667 778 722 667 611 722 667 944 667 667 611 333 278 333 584 556 333 " +
  "556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 611 611 389 556 333 611 556 778 556 556 500 389 280 389 584"
)
  .split(" ")
  .map(Number);

/** Windows Latin-1: where the characters above U+007E that it holds sit in its 256 places. */
const WIN_ANSI: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** The width of a character code in thousandths of the size. The ones above 126 are close, and the line breaks leave room for that. */
function charWidth(code: number, font: FontKey): number {
  if (font === "mono") return 600;
  const bold = font === "bold" || font === "boldItalic";
  if (code >= 32 && code <= 126) return (bold ? BOLD : REGULAR)[code - 32] as number;
  if (code === 0x85 || code === 0x97 || code === 0x89 || code === 0x8c || code === 0x99) return 1000;
  if (code === 0x96 || code === 0x80) return 556;
  if (code === 0x91 || code === 0x92) return bold ? 278 : 222;
  if (code === 0x93 || code === 0x94) return bold ? 500 : 333;
  if (code === 0x95) return 350;
  if (code === 0xa0) return 278;
  if (code >= 0xc0 && code <= 0xde && code !== 0xd7) return bold ? 722 : 700;
  if (code >= 0xdf && code <= 0xff) return 556;
  return 556;
}

/** How wide a text of printable ASCII is, in points, at a size in one of the two Helvetica faces. For placing text in other drawings, such as the answer sheet. */
export function measureText(text: string, size: number, font: "regular" | "bold" = "regular"): number {
  let units = 0;
  for (const ch of text) units += charWidth(Math.min(ch.charCodeAt(0), 255), font);
  return (units * size) / 1000;
}

/** A run of a text that is drawn in one font: in Windows Latin-1, or in the Symbol font. */
interface Segment {
  symbol: boolean;
  codes: number[];
}

/**
 * A text as the codes of Windows Latin-1 and, where a character is a Greek letter or a sign the Symbol font draws, the codes of
 * that font; and the characters neither can draw, which are written as a question mark and counted. `symbols: false` is for the
 * places that are not drawn with a change of font (the page footer, the number of a question): a character there is a question mark.
 */
function segmentsOf(text: string, replaced: Map<string, number>, symbols: boolean): Segment[] {
  const segments: Segment[] = [];
  const add = (symbol: boolean, code: number): void => {
    const last = segments[segments.length - 1];
    if (last && last.symbol === symbol) last.codes.push(code);
    else segments.push({ symbol, codes: [code] });
  };
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp === 0x09 || cp === 0xa0 || (cp >= 0x2000 && cp <= 0x200a)) add(false, 32);
    else if (cp === 0xad || cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff || cp < 32) continue;
    else if (cp >= 32 && cp <= 126) add(false, cp);
    else if (cp >= 0xa1 && cp <= 0xff) add(false, cp);
    else if (WIN_ANSI[cp] !== undefined) add(false, WIN_ANSI[cp] as number);
    else {
      const drawn = symbols ? symbolCodeOf(ch) : undefined;
      if (drawn !== undefined) add(true, drawn);
      else {
        add(false, 63);
        replaced.set(ch, (replaced.get(ch) ?? 0) + 1);
      }
    }
  }
  return segments;
}

/** The character codes of a text in Windows Latin-1, and the characters that could not be drawn. */
function encode(text: string, replaced: Map<string, number>): number[] {
  return segmentsOf(text, replaced, false).flatMap((s) => s.codes);
}

const fontOf = (run: Run, whole: boolean): FontKey => (run.mono ? "mono" : (run.bold || whole) && run.italic ? "boldItalic" : run.bold || whole ? "bold" : run.italic ? "italic" : "regular");

/** Part of a word in one face. */
interface Part {
  codes: number[];
  face: Face;
  width: number;
}

interface Atom {
  codes: number[];
  font: FontKey;
  underline: boolean;
  width: number;
  space: boolean;
  /** A forced line break. */
  newline?: boolean;
  /** A word with a Greek letter or a sign in it is drawn in more than one face, and is never broken between them. */
  parts?: Part[];
}

function atomsOf(runs: Run[], size: number, whole: boolean, replaced: Map<string, number>): Atom[] {
  const atoms: Atom[] = [];
  for (const run of runs) {
    const font = fontOf(run, whole);
    const underline = run.underline === true;
    run.text.split("\n").forEach((line, li) => {
      if (li > 0) atoms.push({ codes: [], font, underline, width: 0, space: false, newline: true });
      for (const piece of line.split(/( +|\t+)/)) {
        if (piece === "") continue;
        const space = /^[ \t]+$/.test(piece);
        const segments = space ? [{ symbol: false, codes: [32] }] : segmentsOf(piece, replaced, true);
        const partWidth = (s: Segment): number => (s.codes.reduce((sum, c) => sum + (s.symbol ? symbolWidth(c) : charWidth(c, font)), 0) * size) / 1000;
        if (segments.some((s) => s.symbol)) {
          const parts = segments.map((s): Part => ({ codes: s.codes, face: s.symbol ? "symbol" : font, width: partWidth(s) }));
          atoms.push({ codes: segments.flatMap((s) => s.codes), font, underline, width: parts.reduce((sum, p) => sum + p.width, 0), space, parts });
          continue;
        }
        const codes = segments.flatMap((s) => s.codes);
        atoms.push({ codes, font, underline, width: (codes.reduce((sum, c) => sum + charWidth(c, font), 0) * size) / 1000, space });
      }
    });
  }
  return atoms;
}

interface Line {
  atoms: Atom[];
  width: number;
}

/** Breaks atoms into lines no wider than `max`, a little under it, never leaving a space at either end of a line. */
function breakLines(atoms: Atom[], max: number): Line[] {
  const lines: Line[] = [];
  let current: Line = { atoms: [], width: 0 };
  const limit = max * 0.985;
  const end = (): void => {
    while (current.atoms.length > 0 && (current.atoms[current.atoms.length - 1] as Atom).space) {
      current.width -= (current.atoms.pop() as Atom).width;
    }
    lines.push(current);
    current = { atoms: [], width: 0 };
  };
  for (const atom of atoms) {
    if (atom.newline) {
      end();
      continue;
    }
    if (atom.space && current.atoms.length === 0) continue;
    if (!atom.space && current.atoms.length > 0 && current.width + atom.width > limit) end();
    current.atoms.push(atom);
    current.width += atom.width;
  }
  if (current.atoms.length > 0 || lines.length === 0) end();
  return lines;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

interface Item {
  block: Block;
  lines: Line[];
  /** The height this takes, with the space before and after. */
  height: number;
  keepNext: boolean;
}

const LEADING = 1.3;

function pdfString(codes: number[]): string {
  return `(${codes.map((c) => (c === 0x5c ? "\\\\" : c === 0x28 ? "\\(" : c === 0x29 ? "\\)" : String.fromCharCode(c))).join("")})`;
}

const num = (n: number): string => (Math.round(n * 100) / 100).toString();

export interface PdfResult {
  bytes: Uint8Array;
  pages: number;
  /** Characters the fonts cannot draw, printed as ?, and how many of each. */
  replaced: Array<{ char: string; count: number }>;
}

/** The test as a PDF. `at` is the time written into its properties. */
export function writePdf(doc: PrintDocument, at: Date = new Date()): PdfResult {
  const { paper } = doc;
  const textWidth = paper.width - 2 * paper.margin;
  const top = paper.margin;
  const bottom = paper.height - paper.margin;
  const replaced = new Map<string, number>();
  // Whether any text is drawn in the Symbol font, which decides whether the file has that font in it.
  let symbolUsed = false;

  // Every block, broken into lines and measured.
  const items: Item[] = doc.blocks.map((block): Item => {
    if (block.kind === "pagebreak") return { block, lines: [], height: 0, keepNext: false };
    if (block.kind === "lines") return { block, lines: [], height: block.count * doc.fontSize * 1.9, keepNext: false };
    if (block.kind === "picture") return { block, lines: [], height: block.before + block.h + block.after, keepNext: block.keepNext === true };
    // A table is a block only in the layout made for a Word file. A PDF is laid out with its tables as lines of text, a row to a line.
    if (block.kind === "table") throw new Error("A table was laid out for a Word file and cannot be drawn in a PDF.");
    const lines = breakLines(atomsOf(block.runs, block.size, block.bold === true, replaced), textWidth - block.indent);
    return { block, lines, height: block.before + lines.length * block.size * LEADING + block.after + (block.rule ? 4 : 0), keepNext: block.keepNext === true };
  });

  // The pictures drawn, each file once, under the name the pages draw it by.
  const images = new Map<string, { name: string; image: PdfImage }>();
  const imageName = (picture: PrintedPicture): string => {
    const held = images.get(picture.file);
    if (held) return held.name;
    // The layout worked out the pixels or the JPEG data when it was made for a PDF. One made for Word has none, and is not drawn here.
    if (picture.pdf === undefined) throw new Error("A picture was laid out for a Word file and cannot be drawn in a PDF.");
    const name = `Im${images.size + 1}`;
    images.set(picture.file, { name, image: picture.pdf });
    return name;
  };

  interface Page {
    ops: string[];
  }
  const pages: Page[] = [{ ops: [] }];
  let y = top;
  const page = (): Page => pages[pages.length - 1] as Page;
  const newPage = (): void => {
    pages.push({ ops: [] });
    y = top;
  };

  /** Draws one line of a paragraph with its top at `lineTop`. */
  const drawLine = (p: Para, line: Line, lineTop: number, first: boolean): void => {
    const baseline = paper.height - (lineTop + p.size * 0.95);
    const left = paper.margin + p.indent;
    const offset = p.align === "center" ? Math.max(0, (textWidth - p.indent - line.width) / 2) : 0;
    if (first && p.marker) {
      const marker = encode(p.marker, replaced);
      const hang = p.hang ?? NUMBER_INDENT;
      page().ops.push(`BT /${RESOURCE.regular} ${num(p.size)} Tf 1 0 0 1 ${num(left - hang)} ${num(baseline)} Tm ${pdfString(marker)} Tj ET`);
    }
    let x = left + offset;
    // Parts of one face and one underline are drawn together.
    interface Group {
      face: Face;
      underline: boolean;
      codes: number[];
      width: number;
    }
    const groups: Group[] = [];
    for (const atom of line.atoms) {
      for (const part of atom.parts ?? [{ codes: atom.codes, face: atom.font, width: atom.width }]) {
        const head = groups[groups.length - 1];
        if (head && head.face === part.face && head.underline === atom.underline) {
          head.codes.push(...part.codes);
          head.width += part.width;
        } else groups.push({ face: part.face, underline: atom.underline, codes: [...part.codes], width: part.width });
      }
    }
    const underline = (g: Group, from: number): void => {
      if (g.underline) page().ops.push(`0.5 w ${num(from)} ${num(baseline - 1.6)} m ${num(from + g.width)} ${num(baseline - 1.6)} l S`);
    };
    if (groups.some((g) => g.face === "symbol")) {
      // A line with a Greek letter or a sign is one text object, in which the reader moves along by the real widths of the fonts.
      symbolUsed = true;
      page().ops.push(`BT 1 0 0 1 ${num(x)} ${num(baseline)} Tm ${groups.map((g) => `/${RESOURCE[g.face]} ${num(p.size)} Tf ${pdfString(g.codes)} Tj`).join(" ")} ET`);
      for (const g of groups) {
        underline(g, x);
        x += g.width;
      }
      return;
    }
    for (const g of groups) {
      page().ops.push(`BT /${RESOURCE[g.face]} ${num(p.size)} Tf 1 0 0 1 ${num(x)} ${num(baseline)} Tm ${pdfString(g.codes)} Tj ET`);
      underline(g, x);
      x += g.width;
    }
  };

  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Item;
    const block = item.block;
    if (block.kind === "pagebreak") {
      newPage();
      continue;
    }
    if (block.kind === "table") continue;

    // A question and what has to stay with it go on one page, if they fit on one.
    if (item.keepNext) {
      let j = i;
      let group = 0;
      while (j < items.length && (items[j] as Item).keepNext) group += (items[j++] as Item).height;
      if (j < items.length) group += (items[j] as Item).height;
      if (y + group > bottom && y > top && group <= bottom - top) newPage();
    }

    if (block.kind === "lines") {
      for (let k = 0; k < block.count; k++) {
        const step = doc.fontSize * 1.9;
        if (y + step > bottom) newPage();
        y += step;
        const at2 = paper.height - y + 2;
        page().ops.push(`0.5 w 0.4 G ${num(paper.margin + NUMBER_INDENT)} ${num(at2)} m ${num(paper.margin + textWidth)} ${num(at2)} l S 0 G`);
      }
      continue;
    }

    if (block.kind === "picture") {
      if (y + block.before + block.h > bottom && y > top) newPage();
      y += y > top ? block.before : 0;
      page().ops.push(`q ${num(block.w)} 0 0 ${num(block.h)} ${num(paper.margin + block.indent)} ${num(paper.height - (y + block.h))} cm /${imageName(block.picture)} Do Q`);
      y += block.h + block.after;
      continue;
    }

    const lineHeight = block.size * LEADING;
    if (y + block.before + lineHeight > bottom && y > top) newPage();
    y += y > top ? block.before : 0;
    item.lines.forEach((line, k) => {
      if (y + lineHeight > bottom) newPage();
      drawLine(block, line, y, k === 0);
      y += lineHeight;
    });
    if (block.rule) {
      const at2 = paper.height - (y + 2);
      page().ops.push(`1 w 0.25 G ${num(paper.margin)} ${num(at2)} m ${num(paper.margin + textWidth)} ${num(at2)} l S 0 G`);
      y += 4;
    }
    y += block.after;
  }

  // The footer, now that the number of pages is known.
  // A short line of text in one weight, with a Greek letter or a sign in the Symbol font where the text has one.
  const widthOf = (segments: Segment[], font: FontKey, size: number): number =>
    (segments.reduce((sum, s) => sum + s.codes.reduce((t, c) => t + (s.symbol ? symbolWidth(c) : charWidth(c, font)), 0), 0) * size) / 1000;
  const textObject = (segments: Segment[], font: FontKey, size: number, x: number, y: number): string => {
    if (!segments.some((s) => s.symbol)) return `BT /${RESOURCE[font]} ${size} Tf 1 0 0 1 ${num(x)} ${num(y)} Tm ${pdfString(segments.flatMap((s) => s.codes))} Tj ET`;
    symbolUsed = true;
    return `BT 1 0 0 1 ${num(x)} ${num(y)} Tm ${segments.map((s) => `/${RESOURCE[s.symbol ? "symbol" : font]} ${size} Tf ${pdfString(s.codes)} Tj`).join(" ")} ET`;
  };
  /** The same segments with the last character off. */
  const shorter = (segments: Segment[]): Segment[] => {
    const last = segments[segments.length - 1] as Segment;
    return last.codes.length > 1 ? [...segments.slice(0, -1), { symbol: last.symbol, codes: last.codes.slice(0, -1) }] : segments.slice(0, -1);
  };

  // The footer, now that the number of pages is known.
  pages.forEach((p, index) => {
    const size = 9;
    const baseline = paper.margin / 2;
    const right = segmentsOf(`Page ${index + 1} of ${pages.length}`, replaced, true);
    const rightWidth = widthOf(right, "regular", size);
    // A long title is cut to leave room for the page number.
    let shown = segmentsOf(doc.footer, replaced, true);
    const room = textWidth - rightWidth - 12;
    while (shown.reduce((sum, s) => sum + s.codes.length, 0) > 1 && widthOf(shown, "regular", size) > room) shown = shorter(shown);
    p.ops.push(textObject(shown, "regular", size, paper.margin, baseline));
    p.ops.push(textObject(right, "regular", size, paper.margin + textWidth - rightWidth, baseline));
  });

  // The header, when the test has several versions: the version at the top of every page, so a loose page can be put back with its own.
  if (doc.header) {
    for (const p of pages) p.ops.push(textObject(segmentsOf(doc.header, replaced, true), "bold", 9, paper.margin, paper.height - paper.margin / 2));
  }

  // The objects.
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const write = (chunk: Buffer | string): void => {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "latin1") : chunk;
    parts.push(buffer);
    length += buffer.length;
  };
  const object = (id: number, body: Buffer | string): void => {
    offsets[id] = length;
    write(`${id} 0 obj\n`);
    write(body);
    write("\nendobj\n");
  };

  write("%PDF-1.4\n%âãÏÓ\n");
  const fontIds = { regular: 3, bold: 4, italic: 5, boldItalic: 6, mono: 7 } as const;
  const infoId = 8;
  const firstPage = 9;
  const pageIds = pages.map((_, i) => firstPage + 2 * i);

  object(1, "<< /Type /Catalog /Pages 2 0 R /Lang (en-US) /ViewerPreferences << /DisplayDocTitle true >> >>");
  object(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  for (const key of Object.keys(fontIds) as FontKey[]) {
    object(fontIds[key], `<< /Type /Font /Subtype /Type1 /BaseFont /${BASE_FONT[key]} /Encoding /WinAnsiEncoding >>`);
  }
  const date = at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "");
  const title = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(doc.title, "utf16le").swap16()]).toString("hex").toUpperCase();
  object(infoId, `<< /Title <${title}> /Producer (OpenAssess) /Creator (OpenAssess) /CreationDate (D:${date}) >>`);

  const imageBase = firstPage + 2 * pages.length;
  const imageList = [...images.values()];
  const xobjects = imageList.length > 0 ? ` /XObject << ${imageList.map((entry, k) => `/${entry.name} ${imageBase + k} 0 R`).join(" ")} >>` : "";
  // The Symbol font comes after the pictures, so the numbers of every other object are what they were. It has its own built-in
  // encoding, which is why it is not given the Windows Latin-1 one the others are.
  const symbolId = imageBase + imageList.length;
  const fontList = [...(Object.keys(fontIds) as FontKey[]).map((k) => `/${RESOURCE[k]} ${fontIds[k]} 0 R`), ...(symbolUsed ? [`/${RESOURCE.symbol} ${symbolId} 0 R`] : [])];
  const resources = `<< /Font << ${fontList.join(" ")} >>${xobjects} >>`;
  pages.forEach((p, i) => {
    const pageId = pageIds[i] as number;
    const content = deflateSync(Buffer.from(p.ops.join("\n"), "latin1"));
    object(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(paper.width)} ${num(paper.height)}] /Resources ${resources} /Contents ${pageId + 1} 0 R >>`);
    offsets[pageId + 1] = length;
    write(`${pageId + 1} 0 obj\n<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`);
    write(content);
    write("\nendstream\nendobj\n");
  });

  imageList.forEach((entry, k) => {
    const { image } = entry;
    offsets[imageBase + k] = length;
    write(`${imageBase + k} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /${image.colorSpace} /BitsPerComponent 8 /Filter /${image.filter} /Length ${image.data.length} >>\nstream\n`);
    write(Buffer.from(image.data));
    write("\nendstream\nendobj\n");
  });

  if (symbolUsed) object(symbolId, "<< /Type /Font /Subtype /Type1 /BaseFont /Symbol >>");

  const count = imageBase + imageList.length + (symbolUsed ? 1 : 0);
  const xref = length;
  write(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let id = 1; id < count; id++) write(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  write(`trailer\n<< /Size ${count} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  return {
    bytes: new Uint8Array(Buffer.concat(parts)),
    pages: pages.length,
    replaced: [...replaced].map(([char, n]) => ({ char, count: n })).sort((a, b) => b.count - a.count),
  };
}
