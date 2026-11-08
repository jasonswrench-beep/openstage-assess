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
 * The most widths the /W arrays of all the fonts of one document may set, in all; a font has at most 65,536 codes, so this is
 * fifteen fonts that are full. About 40 MB when it is used up.
 */
const MAX_WIDTHS_SET = 1_000_000;

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

/** What the widths of a document's fonts have used of the budget, and the widths already made for each descendant font. */
interface WidthStore {
  left: number;
  made: Map<PdfDict, Map<number, number>>;
}
const widthStores = new WeakMap<PdfDocument, WidthStore>();

/**
 * The widths a composite font's descendant sets in its /W array, by code. Made once for each descendant, and from one budget for the
 * whole document. The budget was one for each font: a Type0 font is a dictionary of its own and any number of them may name the same
 * descendant, so 40 fonts of 145 bytes each, that shared one /W, made 40 maps of 400,000 widths (700 MB), and 100 would have made
 * 1.7 GB. A real document has a few dozen fonts of a few hundred widths each; when the budget is gone the fonts after it have no widths
 * of their own and take the descendant's default, which only changes how wide a gap must be to be a space.
 */
function widthsOf(doc: PdfDocument, descendant: PdfDict | undefined): Map<number, number> {
  if (!descendant) return new Map();
  let store = widthStores.get(doc);
  if (!store) {
    store = { left: MAX_WIDTHS_SET, made: new Map() };
    widthStores.set(doc, store);
  }
  const known = store.made.get(descendant);
  if (known) return known;
  const widths = new Map<number, number>();
  store.made.set(descendant, widths);
  const w = doc.array(descendant.get("W"));
  if (w) {
    // Each range was kept to 70,000 codes and the number of ranges was not: 100,000 ranges of 70,000 codes, from a file of 3 KB, took two
    // minutes. A font has at most 65,536 codes, so a budget for the whole of the widths is more than any real font needs.
    for (let i = 0; i < w.length && store.left > 0; ) {
      const start = doc.number(w[i]);
      const second = doc.resolve(w[i + 1]);
      if (Array.isArray(second)) {
        for (let k = 0; k < second.length && store.left > 0; k++, store.left--) widths.set(start + k, doc.number(second[k]));
        i += 2;
      } else {
        const end = doc.number(second);
        const value = doc.number(w[i + 2]);
        for (let c = start; c <= end && c - start < 70000 && store.left > 0; c++, store.left--) widths.set(c, value);
        i += 3;
      }
    }
  }
  return widths;
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
        out.push({ text, width: widths.get(code) ?? dw, wordSpace: false });
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
