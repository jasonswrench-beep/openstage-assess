/**
 * A printed test as a PDF, written by hand with no library.
 *
 * The file uses the fonts every PDF reader has built in (Helvetica, in four weights, and Courier), so nothing is embedded
 * and the file is small. That has one cost, said plainly: those fonts hold the Western European characters of Windows
 * Latin-1 and nothing else. A character outside it, such as a letter in another script, cannot be drawn, is printed as a
 * question mark, and is counted so that the report can say so and point to the Word file, which can hold any text.
 *
 * The layout is the same as Word's: this draws the blocks it is given. Lines are broken with the real widths of the fonts,
 * a little under the full width so that a small error in a width cannot push a word past the margin, and a question is kept
 * on a page with its first answer. The file is untagged, which is another cost: a screen reader gets a better reading from
 * the Word file.
 */

import { deflateSync } from "node:zlib";

import type { Block, Para, PrintDocument, Run } from "./layout.ts";

const NUMBER_INDENT = 28;

type FontKey = "regular" | "bold" | "italic" | "boldItalic" | "mono";
const BASE_FONT: Record<FontKey, string> = { regular: "Helvetica", bold: "Helvetica-Bold", italic: "Helvetica-Oblique", boldItalic: "Helvetica-BoldOblique", mono: "Courier" };
const RESOURCE: Record<FontKey, string> = { regular: "F1", bold: "F2", italic: "F3", boldItalic: "F4", mono: "F5" };

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

/** The character codes of a text in Windows Latin-1, and the characters that could not be drawn. */
function encode(text: string, replaced: Map<string, number>): number[] {
  const codes: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp === 0x09 || cp === 0xa0 || (cp >= 0x2000 && cp <= 0x200a)) codes.push(32);
    else if (cp === 0xad || cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff || cp < 32) continue;
    else if (cp >= 32 && cp <= 126) codes.push(cp);
    else if (cp >= 0xa1 && cp <= 0xff) codes.push(cp);
    else if (WIN_ANSI[cp] !== undefined) codes.push(WIN_ANSI[cp] as number);
    else {
      codes.push(63);
      replaced.set(ch, (replaced.get(ch) ?? 0) + 1);
    }
  }
  return codes;
}

const fontOf = (run: Run, whole: boolean): FontKey => (run.mono ? "mono" : (run.bold || whole) && run.italic ? "boldItalic" : run.bold || whole ? "bold" : run.italic ? "italic" : "regular");

interface Atom {
  codes: number[];
  font: FontKey;
  underline: boolean;
  width: number;
  space: boolean;
  /** A forced line break. */
  newline?: boolean;
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
        const codes = space ? [32] : encode(piece, replaced);
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

  // Every block, broken into lines and measured.
  const items: Item[] = doc.blocks.map((block): Item => {
    if (block.kind === "pagebreak") return { block, lines: [], height: 0, keepNext: false };
    if (block.kind === "lines") return { block, lines: [], height: block.count * doc.fontSize * 1.9, keepNext: false };
    const lines = breakLines(atomsOf(block.runs, block.size, block.bold === true, replaced), textWidth - block.indent);
    return { block, lines, height: block.before + lines.length * block.size * LEADING + block.after + (block.rule ? 4 : 0), keepNext: block.keepNext === true };
  });

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
    // Atoms of one font and one underline are drawn together.
    let group: Atom[] = [];
    const flush = (): void => {
      if (group.length === 0) return;
      const codes = group.flatMap((a) => a.codes);
      const width = group.reduce((sum, a) => sum + a.width, 0);
      const font = (group[0] as Atom).font;
      page().ops.push(`BT /${RESOURCE[font]} ${num(p.size)} Tf 1 0 0 1 ${num(x)} ${num(baseline)} Tm ${pdfString(codes)} Tj ET`);
      if ((group[0] as Atom).underline) page().ops.push(`0.5 w ${num(x)} ${num(baseline - 1.6)} m ${num(x + width)} ${num(baseline - 1.6)} l S`);
      x += width;
      group = [];
    };
    for (const atom of line.atoms) {
      const head = group[0];
      if (head && (head.font !== atom.font || head.underline !== atom.underline)) flush();
      group.push(atom);
    }
    flush();
  };

  for (let i = 0; i < items.length; i++) {
    const item = items[i] as Item;
    const block = item.block;
    if (block.kind === "pagebreak") {
      newPage();
      continue;
    }

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
  pages.forEach((p, index) => {
    const size = 9;
    const baseline = paper.margin / 2;
    const title = encode(doc.footer, replaced);
    const right = encode(`Page ${index + 1} of ${pages.length}`, replaced);
    const rightWidth = (right.reduce((sum, c) => sum + charWidth(c, "regular"), 0) * size) / 1000;
    // A long title is cut to leave room for the page number.
    let shown = title;
    const room = textWidth - rightWidth - 12;
    while (shown.length > 1 && (shown.reduce((sum, c) => sum + charWidth(c, "regular"), 0) * size) / 1000 > room) shown = shown.slice(0, -1);
    p.ops.push(`BT /${RESOURCE.regular} ${size} Tf 1 0 0 1 ${num(paper.margin)} ${num(baseline)} Tm ${pdfString(shown)} Tj ET`);
    p.ops.push(`BT /${RESOURCE.regular} ${size} Tf 1 0 0 1 ${num(paper.margin + textWidth - rightWidth)} ${num(baseline)} Tm ${pdfString(right)} Tj ET`);
  });

  // The header, when the test has several versions: the version at the top of every page, so a loose page can be put back with its own.
  if (doc.header) {
    const text = encode(doc.header, replaced);
    for (const p of pages) p.ops.push(`BT /${RESOURCE.bold} 9 Tf 1 0 0 1 ${num(paper.margin)} ${num(paper.height - paper.margin / 2)} Tm ${pdfString(text)} Tj ET`);
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

  const resources = `<< /Font << ${(Object.keys(fontIds) as FontKey[]).map((k) => `/${RESOURCE[k]} ${fontIds[k]} 0 R`).join(" ")} >> >>`;
  pages.forEach((p, i) => {
    const pageId = pageIds[i] as number;
    const content = deflateSync(Buffer.from(p.ops.join("\n"), "latin1"));
    object(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(paper.width)} ${num(paper.height)}] /Resources ${resources} /Contents ${pageId + 1} 0 R >>`);
    offsets[pageId + 1] = length;
    write(`${pageId + 1} 0 obj\n<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`);
    write(content);
    write("\nendstream\nendobj\n");
  });

  const count = firstPage + 2 * pages.length;
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
