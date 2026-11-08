/**
 * A page's content stream, read for its text.
 *
 * A content stream is a program in a small postfix language: operands, then an operator. Most of it draws (paths, colours,
 * images) and none of that matters here. What matters is the text operators, which set a font, move a pen with a matrix, and
 * show strings; and the operators that change the matrix the pen is placed by. This keeps exactly that state, and reports every
 * string shown as a run: its text, where it starts and ends on the page, how large it is and what font it was in.
 *
 * It does not draw anything and runs nothing from the file. A form (a reusable piece of a page) is read as part of the page,
 * to a bounded depth. A run is a point and a width, not a line: working out which runs make a line is the layout's work.
 */

import type { PdfDocument } from "./document.ts";
import { loadFont, type PdfFont } from "./fonts.ts";
import { fromToken, Lexer, PdfError, PdfName, PdfStream, PdfString, type PdfDict, type PdfObject } from "./objects.ts";

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Applies the first matrix and then the second, which is how the format composes them. */
function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

export interface TextRun {
  text: string;
  /** Where the run starts and ends along the line, and its baseline, in the page's own units (points, y up). */
  x0: number;
  x1: number;
  y: number;
  /** The size of the letters on the page, after every scaling. */
  size: number;
  bold: boolean;
  italic: boolean;
  font: string;
  /** The text runs along the page's x axis. Anything else (turned, mirrored) is kept, and flagged. */
  upright: boolean;
  /** Not text at all: a picture was drawn here, and this stands for it. */
  picture?: true;
}

interface Gs {
  ctm: Matrix;
  font: PdfFont | undefined;
  size: number;
  charSpace: number;
  wordSpace: number;
  scale: number;
  leading: number;
  rise: number;
}

/** Most operators read from one page, and most runs kept. A page of text is a few thousand of either. */
const MAX_OPERATORS = 5_000_000;
const MAX_RUNS = 2_000_000;
const MAX_FORM_DEPTH = 8;
/** What stands for a picture in the text, and how big the stand-in is set. Smaller than this on either side is not a picture. */
export const PICTURE_MARK = "[Picture]";
const PICTURE_SIZE = 12;
const MIN_PICTURE = 8;

export interface PageRuns {
  runs: TextRun[];
  /** Character codes that had no meaning in their font. */
  unreadable: number;
  /** What could not be read, for the file's notes. */
  notes: string[];
}

/** Fonts are read once for the whole file, so the cache comes from the caller; the count of unreadable codes is for this page alone. */
export function readPageRuns(doc: PdfDocument, content: Uint8Array, resources: PdfDict | undefined, fonts: Map<PdfObject, PdfFont> = new Map()): PageRuns {
  const runs: TextRun[] = [];
  const notes: string[] = [];
  const unreadableBefore = [...new Set(fonts.values())].reduce((n, f) => n + f.unreadable, 0);
  let operators = 0;

  const fontFor = (res: PdfDict | undefined, name: string): PdfFont | undefined => {
    const table = res ? doc.dict(res.get("Font")) : undefined;
    const object = table?.get(name);
    if (object === undefined) return undefined;
    const resolved = doc.resolve(object);
    const key = resolved ?? object;
    let font = fonts.get(key);
    if (!font) {
      font = loadFont(doc, object);
      fonts.set(key, font);
    }
    return font;
  };

  function run(data: Uint8Array, res: PdfDict | undefined, startCtm: Matrix, depth: number): void {
    const lex = new Lexer(data, 0);
    let gs: Gs = { ctm: startCtm, font: undefined, size: 0, charSpace: 0, wordSpace: 0, scale: 1, leading: 0, rise: 0 };
    const stack: Gs[] = [];
    let tm: Matrix = IDENTITY;
    let tlm: Matrix = IDENTITY;
    let operands: PdfObject[] = [];

    const num = (i: number): number => {
      const v = operands[i];
      return typeof v === "number" ? v : 0;
    };

    /** Shows one string: every glyph advances the pen, and the whole of it is reported as one run. */
    const show = (bytes: Uint8Array): void => {
      const font = gs.font;
      if (!font || bytes.length === 0) return;
      const glyphs = font.decode(bytes);
      const startTrm = multiply([gs.size * gs.scale, 0, 0, gs.size, 0, gs.rise], multiply(tm, gs.ctm));
      let text = "";
      for (const g of glyphs) {
        text += g.text;
        const advance = ((g.width / 1000) * gs.size + gs.charSpace + (g.wordSpace ? gs.wordSpace : 0)) * gs.scale;
        tm = multiply([1, 0, 0, 1, advance, 0], tm);
      }
      const endTrm = multiply([gs.size * gs.scale, 0, 0, gs.size, 0, gs.rise], multiply(tm, gs.ctm));
      if (text === "" || runs.length >= MAX_RUNS) return;
      const size = Math.hypot(startTrm[2], startTrm[3]);
      runs.push({
        text,
        x0: startTrm[4],
        x1: endTrm[4],
        y: startTrm[5],
        size,
        bold: font.bold,
        italic: font.italic,
        font: font.name,
        upright: Math.abs(startTrm[1]) < 1e-6 * Math.max(1, Math.abs(startTrm[0])) && startTrm[0] > 0,
      });
    };

    /** A picture is not words, and cannot be read; but where it is drawn is known, and a marker there keeps it from vanishing. */
    const picture = (): void => {
      const [a, b, c, d, e, f] = gs.ctm;
      const width = Math.hypot(a, b);
      const height = Math.hypot(c, d);
      // A speck or a rule is decoration, not a picture a question could depend on.
      if (width < MIN_PICTURE || height < MIN_PICTURE || runs.length >= MAX_RUNS) return;
      runs.push({ text: PICTURE_MARK, x0: e, x1: e + width, y: Math.max(f, f + d) - PICTURE_SIZE, size: PICTURE_SIZE, bold: false, italic: false, font: "", upright: true, picture: true });
    };

    const nextLine = (tx: number, ty: number): void => {
      tlm = multiply([1, 0, 0, 1, tx, ty], tlm);
      tm = tlm;
    };

    for (;;) {
      const token = lex.next();
      if (token.t === "eof") break;
      if (token.t !== "kw") {
        try {
          operands.push(fromToken(lex, token, 0));
        } catch (error) {
          // An operand nested too deeply to be real (`[` a hundred times in a row before a string) was an error out of the whole page, which
          // lost the text in front of it as well as what follows. What was read before is kept; what follows is not read, since it is
          // not known where the operand was meant to end; and the page says so.
          if (!(error instanceof PdfError)) throw error;
          notes.push(`A part of a page could not be read, and the instructions after it were not read: ${error.message}`);
          return;
        }
        if (operands.length > 4096) operands = operands.slice(-64);
        continue;
      }
      if (++operators > MAX_OPERATORS) {
        notes.push("A page of this PDF has more drawing instructions than a page of text has, and the rest of it was not read.");
        return;
      }
      switch (token.v) {
        case "q":
          stack.push({ ...gs });
          if (stack.length > 256) stack.shift();
          break;
        case "Q":
          if (stack.length > 0) gs = stack.pop() as Gs;
          break;
        case "cm":
          gs.ctm = multiply([num(0), num(1), num(2), num(3), num(4), num(5)], gs.ctm);
          break;
        case "BT":
          tm = IDENTITY;
          tlm = IDENTITY;
          break;
        case "Tc":
          gs.charSpace = num(0);
          break;
        case "Tw":
          gs.wordSpace = num(0);
          break;
        case "Tz":
          gs.scale = num(0) / 100;
          break;
        case "TL":
          gs.leading = num(0);
          break;
        case "Ts":
          gs.rise = num(0);
          break;
        case "Tf": {
          const name = operands[0];
          gs.font = name instanceof PdfName ? fontFor(res, name.name) : undefined;
          gs.size = num(1);
          break;
        }
        case "Td":
          nextLine(num(0), num(1));
          break;
        case "TD":
          gs.leading = -num(1);
          nextLine(num(0), num(1));
          break;
        case "Tm":
          tm = [num(0), num(1), num(2), num(3), num(4), num(5)];
          tlm = tm;
          break;
        case "T*":
          nextLine(0, -gs.leading);
          break;
        case "Tj":
          if (operands[0] instanceof PdfString) show(operands[0].bytes);
          break;
        case "'":
          nextLine(0, -gs.leading);
          if (operands[0] instanceof PdfString) show(operands[0].bytes);
          break;
        case '"':
          gs.wordSpace = num(0);
          gs.charSpace = num(1);
          nextLine(0, -gs.leading);
          if (operands[2] instanceof PdfString) show(operands[2].bytes);
          break;
        case "TJ": {
          const items = operands[0];
          if (!Array.isArray(items)) break;
          for (const item of items) {
            if (item instanceof PdfString) show(item.bytes);
            else if (typeof item === "number") tm = multiply([1, 0, 0, 1, (-item / 1000) * gs.size * gs.scale, 0], tm);
          }
          break;
        }
        case "Do": {
          const name = operands[0];
          if (!(name instanceof PdfName) || depth >= MAX_FORM_DEPTH) break;
          const xobjects = res ? doc.dict(res.get("XObject")) : undefined;
          const form = doc.resolve(xobjects?.get(name.name));
          if (form instanceof PdfStream && doc.name(form.dict.get("Subtype")) === "Image") {
            picture();
            break;
          }
          if (!(form instanceof PdfStream) || doc.name(form.dict.get("Subtype")) !== "Form") break;
          try {
            const matrix = doc.array(form.dict.get("Matrix"))?.map((n) => doc.number(n));
            const m: Matrix = matrix && matrix.length === 6 ? (matrix as Matrix) : IDENTITY;
            run(doc.streamData(form), doc.dict(form.dict.get("Resources")) ?? res, multiply(m, gs.ctm), depth + 1);
          } catch (error) {
            notes.push(`A part of a page could not be read: ${(error as Error).message}`);
          }
          break;
        }
        case "BI": {
          // An inline image: a dictionary, then the word ID, then bytes that may hold anything, then EI.
          for (;;) {
            const t = lex.next();
            if (t.t === "eof" || (t.t === "kw" && t.v === "ID")) break;
          }
          const d = lex.buf;
          let p = lex.pos + 1;
          for (; p < d.length - 1; p++) {
            if (d[p] === 0x45 && d[p + 1] === 0x49 && (p === 0 || d[p - 1] === 10 || d[p - 1] === 13 || d[p - 1] === 32) && (p + 2 >= d.length || d[p + 2] === 10 || d[p + 2] === 13 || d[p + 2] === 32)) break;
          }
          lex.pos = Math.min(d.length, p + 2);
          picture();
          break;
        }
        default:
          break;
      }
      operands = [];
    }
  }

  run(content, resources, IDENTITY, 0);
  const unreadable = [...new Set(fonts.values())].reduce((n, f) => n + f.unreadable, 0) - unreadableBefore;
  return { runs, unreadable, notes };
}
