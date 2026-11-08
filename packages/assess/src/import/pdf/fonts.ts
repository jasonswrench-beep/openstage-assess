/**
 * Reading text out of a PDF's fonts: what a character code means, how wide it is, and whether the font is bold or italic.
 *
 * What a code means is the font's ToUnicode map where the file gives one, and its encoding otherwise. A font that has neither
 * (a subset of a TrueType font written without a map) cannot be read, and its text comes out as the replacement character and
 * is counted, so a page of it is reported rather than passed off as a page of text.
 *
 * Width matters because the text of a line is cut into pieces wherever the file moves the pen, and whether a gap between two
 * pieces is a space is told by how wide the gap is against the width of a space in that font.
 */

import { parseToUnicode, type ToUnicode } from "./cmap.ts";
import type { PdfDocument } from "./document.ts";
import { isDict, PdfName, PdfStream, type PdfDict, type PdfObject } from "./objects.ts";

export interface Glyph {
  text: string;
  /** In thousandths of the font size. */
  width: number;
  /** A single-byte code 32, which is the only one word spacing applies to. */
  wordSpace: boolean;
}

export interface PdfFont {
  name: string;
  bold: boolean;
  italic: boolean;
  /** Codes that had no meaning in the file, counted so that a page of them is reported. */
  unreadable: number;
  decode(bytes: Uint8Array): Glyph[];
}

/**
 * How many codes after its first a range of one width (`first last width`) is kept for. A font has at most 65,536 codes, so a range that
 * names more is kept as far as any code goes. (It was the size of the work and of the memory, a Map entry for each code; it is not now,
 * and it is kept because a range read as it always was is a width that is the same as it always was.)
 */
const MAX_RANGE_CODES = 70_000;
/** Codes and the first code of a range are kept to this: past it a number of a PDF is not told from its neighbour (a double has 53 bits). */
const MAX_CODE = 2 ** 50;

/** The font's own name, without the six capitals and a plus that a subset puts in front. */
const plainName = (base: string): string => base.replace(/^[A-Z]{6}\+/, "");

function weightOf(name: string, descriptor: PdfDict | undefined, doc: PdfDocument): { bold: boolean; italic: boolean } {
  const flags = descriptor ? doc.number(descriptor.get("Flags")) : 0;
  const weight = descriptor ? doc.number(descriptor.get("FontWeight")) : 0;
  const angle = descriptor ? doc.number(descriptor.get("ItalicAngle")) : 0;
  return {
    bold: /bold|black|heavy|semibold|demi(?!tasse)|extrabold|ultra/i.test(name) || /[-_ ](?:[6-9]00)\b/.test(name) || weight >= 600 || (flags & 0x40000) !== 0,
    italic: /italic|oblique|slanted|kursiv/i.test(name) || /(?:^|[-_ ,])(?:it|ital)(?:$|[-_ ,])/i.test(name) || angle !== 0 || (flags & 0x40) !== 0,
  };
}

// ---------------------------------------------------------------------------
// Glyph names
// ---------------------------------------------------------------------------

const NAMES: Record<string, string> = {
  space: " ", exclam: "!", quotedbl: '"', numbersign: "#", dollar: "$", percent: "%", ampersand: "&", quotesingle: "'", parenleft: "(", parenright: ")",
  asterisk: "*", plus: "+", comma: ",", hyphen: "-", minus: "−", period: ".", slash: "/", colon: ":", semicolon: ";", less: "<", equal: "=",
  greater: ">", question: "?", at: "@", bracketleft: "[", backslash: "\\", bracketright: "]", asciicircum: "^", underscore: "_", grave: "`",
  braceleft: "{", bar: "|", braceright: "}", asciitilde: "~", bullet: "•", endash: "–", emdash: "—", quoteleft: "‘",
  quoteright: "’", quotedblleft: "“", quotedblright: "”", quotesinglbase: "‚", quotedblbase: "„", ellipsis: "…",
  fi: "ﬁ", fl: "ﬂ", trademark: "™", copyright: "©", registered: "®", degree: "°", plusminus: "±", multiply: "×",
  divide: "÷", section: "§", paragraph: "¶", dagger: "†", daggerdbl: "‡", cent: "¢", sterling: "£", yen: "¥",
  Euro: "€", guillemotleft: "«", guillemotright: "»", periodcentered: "·", nbspace: " ", nonbreakingspace: " ",
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", germandbls: "ß", ae: "æ", AE: "Æ",
  oe: "œ", OE: "Œ", oslash: "ø", Oslash: "Ø", dotlessi: "ı", florin: "ƒ", fraction: "⁄", onequarter: "¼", onehalf: "½",
  threequarters: "¾", mu: "µ", logicalnot: "¬", brokenbar: "¦", currency: "¤", exclamdown: "¡", questiondown: "¿",
};
const ACCENTS: Record<string, string> = { grave: "̀", acute: "́", circumflex: "̂", tilde: "̃", dieresis: "̈", ring: "̊", caron: "̌", cedilla: "̧", macron: "̄" };

export function glyphToText(name: string): string | undefined {
  const known = NAMES[name];
  if (known !== undefined) return known;
  if (/^[A-Za-z]$/.test(name)) return name;
  let m = /^uni([0-9A-Fa-f]{4})$/.exec(name);
  if (m) return String.fromCharCode(parseInt(m[1] as string, 16));
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) return String.fromCodePoint(parseInt(m[1] as string, 16));
  m = /^([A-Za-z])(grave|acute|circumflex|tilde|dieresis|ring|caron|cedilla|macron)$/.exec(name);
  if (m) return `${m[1]}${ACCENTS[m[2] as string]}`.normalize("NFC");
  const dot = name.indexOf(".");
  if (dot > 0) return glyphToText(name.slice(0, dot));
  return undefined;
}

const decoders = new Map<string, InstanceType<typeof TextDecoder>>();
function singleByte(label: string, code: number): string {
  let d = decoders.get(label);
  if (!d) {
    try {
      d = new TextDecoder(label);
    } catch {
      d = new TextDecoder("windows-1252");
    }
    decoders.set(label, d);
  }
  return d.decode(Uint8Array.of(code));
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

function toUnicodeOf(doc: PdfDocument, font: PdfDict): ToUnicode | undefined {
  const stream = doc.resolve(font.get("ToUnicode"));
  if (!(stream instanceof PdfStream)) return undefined;
  try {
    return parseToUnicode(doc.streamData(stream));
  } catch {
    return undefined;
  }
}

/** The 14 fonts every viewer has: no widths in the file, so a width of an average letter stands in for a space's neighbours. */
const MONO = /courier|mono/i;

function simpleFont(doc: PdfDocument, font: PdfDict, baseName: string): PdfFont {
  const descriptor = doc.dict(font.get("FontDescriptor"));
  const toUnicode = toUnicodeOf(doc, font);
  const first = doc.number(font.get("FirstChar"));
  const widths = doc.array(font.get("Widths"))?.map((w) => doc.number(w));
  const missing = descriptor ? doc.number(descriptor.get("MissingWidth")) : 0;
  const fallbackWidth = missing || (MONO.test(baseName) ? 600 : 500);

  // The encoding: a name, or a dictionary that names a base and lists the codes it changes.
  const encoding = doc.resolve(font.get("Encoding"));
  const differences = new Map<number, string>();
  let baseLabel = "windows-1252";
  const baseOf = (n: string | undefined): void => {
    if (n === "MacRomanEncoding") baseLabel = "macintosh";
    else if (n === "WinAnsiEncoding" || n === "StandardEncoding" || n === "PDFDocEncoding") baseLabel = "windows-1252";
  };
  if (encoding instanceof PdfName) baseOf(encoding.name);
  else if (isDict(encoding)) {
    baseOf(doc.name(encoding.get("BaseEncoding")));
    let code = 0;
    for (const item of doc.array(encoding.get("Differences")) ?? []) {
      const r = doc.resolve(item);
      if (typeof r === "number") code = r;
      else if (r instanceof PdfName) {
        const t = glyphToText(r.name);
        if (t !== undefined) differences.set(code, t);
        code++;
      }
    }
  }

  const { bold, italic } = weightOf(baseName, descriptor, doc);
  const out: PdfFont = {
    name: baseName,
    bold,
    italic,
    unreadable: 0,
    decode(bytes: Uint8Array): Glyph[] {
      return Array.from(bytes, (code) => {
        let text = toUnicode?.lookup(code) ?? differences.get(code);
        if (text === undefined) text = code < 32 ? "" : singleByte(baseLabel, code);
        const w = widths && code >= first && code - first < widths.length ? (widths[code - first] as number) : undefined;
        return { text, width: w !== undefined && w > 0 ? w : fallbackWidth, wordSpace: code === 32 };
      });
    },
  };
  return out;
}

/**
 * The widths of a font by code: pieces of codes that do not overlap, each with where its widths are, found by binary search on the first
 * code of each piece. A width is a number in `pool`, and the pool holds each array of widths of the file once, however many ranges name it.
 *
 * It was a Map with an entry for each code a range named, and a budget on the entries, because a range can name 70,000 codes and 100,000
 * ranges can be in 3 KB: first for each range, then for each font, and then for the whole document (one million). The budget for the
 * document took the widths from the sixteenth full font on and left them at the descendant's default, and the width of a gap is what
 * decides whether a space is written: a question set in the seventeenth font of a file lost the spaces between its words, and became an
 * essay or went. Nothing here is the size of the codes a range names, so there is nothing to run out of: the memory is the arrays the file
 * paid for, and the pieces are no more than twice the ranges.
 */
class WidthTable {
  readonly first: number[] = [];
  readonly last: number[] = [];
  /** A piece's width is `pool[bias + stride * code]`: a stride of 1 for an array of widths, 0 for the one width of a range. */
  readonly bias: number[] = [];
  readonly stride: number[] = [];
  readonly pool: number[] = [];

  at(code: number): number | undefined {
    const first = this.first;
    let lo = 0;
    let hi = first.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((first[mid] as number) <= code) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (found === -1 || code > (this.last[found] as number)) return undefined;
    return this.pool[(this.bias[found] as number) + (this.stride[found] as number) * code];
  }
}

const widthTables = new WeakMap<PdfDict, WidthTable>();

/**
 * The widths a composite font's descendant sets in its /W array, by code. A later entry wins over an earlier one for a code both name, as
 * it did when the entries were set one after the other, and the pieces left are found by sweeping the entries from the lowest code up with
 * the latest of those that cover the place at the top of a heap: the work is the entries times the log of them, and nothing is done for each
 * code. Made once for each descendant (a Type0 font is a dictionary of its own and any number of them may name the same one).
 */
function widthsOf(doc: PdfDocument, descendant: PdfDict | undefined): WidthTable {
  if (!descendant) return new WidthTable();
  const known = widthTables.get(descendant);
  if (known) return known;
  const table = new WidthTable();
  widthTables.set(descendant, table);
  const w = doc.array(descendant.get("W"));
  if (!w) return table;

  // The entries, in the order the file has them. A first code that is not a whole number names no code, and one past what a double can tell
  // apart names none that a font has.
  const sFirst: number[] = [];
  const sLast: number[] = [];
  const sBase: number[] = [];
  const sStride: number[] = [];
  const poolOf = new Map<object, number>();
  const pool = table.pool;
  for (let i = 0; i < w.length; ) {
    const start = doc.number(w[i]);
    const second = doc.resolve(w[i + 1]);
    const usable = Number.isInteger(start) && Math.abs(start) <= MAX_CODE;
    if (Array.isArray(second)) {
      i += 2;
      if (!usable || second.length === 0) continue;
      // An array of widths named again and again is in the pool once.
      let base = poolOf.get(second);
      if (base === undefined) {
        base = pool.length;
        for (const item of second) pool.push(doc.number(item));
        poolOf.set(second, base);
      }
      sFirst.push(start);
      sLast.push(start + second.length - 1);
      sBase.push(base);
      sStride.push(1);
    } else {
      const end = doc.number(second);
      const value = doc.number(w[i + 2]);
      i += 3;
      const last = Math.min(Math.floor(end), start + MAX_RANGE_CODES - 1);
      if (!usable || last < start) continue;
      sFirst.push(start);
      sLast.push(last);
      sBase.push(pool.length);
      sStride.push(0);
      pool.push(value);
    }
  }

  // The sweep. `heap` holds the entries that have begun, the latest at the top; an entry that has ended is dropped when it gets to the top.
  const count = sFirst.length;
  const byStart = Array.from({ length: count }, (_, k) => k).sort((a, b) => (sFirst[a] as number) - (sFirst[b] as number) || a - b);
  const heap: number[] = [];
  const push = (value: number): void => {
    let at = heap.length;
    heap.push(value);
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if ((heap[parent] as number) >= value) break;
      heap[at] = heap[parent] as number;
      at = parent;
    }
    heap[at] = value;
  };
  const pop = (): void => {
    const lastValue = heap.pop() as number;
    if (heap.length === 0) return;
    let at = 0;
    for (;;) {
      let child = 2 * at + 1;
      if (child >= heap.length) break;
      if (child + 1 < heap.length && (heap[child + 1] as number) > (heap[child] as number)) child++;
      if ((heap[child] as number) <= lastValue) break;
      heap[at] = heap[child] as number;
      at = child;
    }
    heap[at] = lastValue;
  };
  const piece: number[] = [];
  let next = 0;
  let here = count > 0 ? (sFirst[byStart[0] as number] as number) : 0;
  while (next < count || heap.length > 0) {
    if (heap.length === 0) here = sFirst[byStart[next] as number] as number;
    while (next < count && (sFirst[byStart[next] as number] as number) <= here) push(byStart[next++] as number);
    while (heap.length > 0 && (sLast[heap[0] as number] as number) < here) pop();
    if (heap.length === 0) continue;
    const winner = heap[0] as number;
    const after = next < count ? (sFirst[byStart[next] as number] as number) : Number.POSITIVE_INFINITY;
    const end = Math.min(sLast[winner] as number, after - 1);
    const n = table.first.length;
    if (n > 0 && piece[n - 1] === winner && (table.last[n - 1] as number) + 1 === here) table.last[n - 1] = end;
    else {
      table.first.push(here);
      table.last.push(end);
      table.bias.push((sBase[winner] as number) - (sStride[winner] as number) * (sFirst[winner] as number));
      table.stride.push(sStride[winner] as number);
      piece.push(winner);
    }
    here = end + 1;
  }
  return table;
}

function compositeFont(doc: PdfDocument, font: PdfDict, baseName: string): PdfFont {
  const descendant = doc.dict(doc.array(font.get("DescendantFonts"))?.[0]);
  const descriptor = descendant ? doc.dict(descendant.get("FontDescriptor")) : undefined;
  const toUnicode = toUnicodeOf(doc, font);
  const dw = descendant ? doc.number(descendant.get("DW"), 1000) : 1000;
  const widths = widthsOf(doc, descendant);
  const { bold, italic } = weightOf(baseName, descriptor, doc);
  // Codes are two bytes unless the map says otherwise (an Identity encoding, which is what a text PDF from a word processor has).
  const codeBytes = Math.max(1, toUnicode && toUnicode.codeBytes > 0 ? toUnicode.codeBytes : 2);
  const self: PdfFont = {
    name: baseName,
    bold,
    italic,
    unreadable: 0,
    decode(bytes: Uint8Array): Glyph[] {
      const out: Glyph[] = [];
      for (let i = 0; i + codeBytes <= bytes.length; i += codeBytes) {
        let code = 0;
        for (let k = 0; k < codeBytes; k++) code = code * 256 + (bytes[i + k] as number);
        let text = toUnicode?.lookup(code);
        if (text === undefined) {
          self.unreadable++;
          text = "�";
        }
        out.push({ text, width: widths.at(code) ?? dw, wordSpace: false });
      }
      return out;
    },
  };
  return self;
}

export function loadFont(doc: PdfDocument, fontObject: PdfObject | undefined): PdfFont {
  const font = doc.dict(fontObject);
  if (!font) return { name: "", bold: false, italic: false, unreadable: 0, decode: (b) => Array.from(b, (c) => ({ text: c >= 32 ? String.fromCharCode(c) : "", width: 500, wordSpace: c === 32 })) };
  const base = plainName(doc.name(font.get("BaseFont")) ?? "");
  return doc.name(font.get("Subtype")) === "Type0" ? compositeFont(doc, font, base) : simpleFont(doc, font, base);
}
