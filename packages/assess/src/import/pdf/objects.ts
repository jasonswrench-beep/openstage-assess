/**
 * The objects a PDF is made of, and a reader for them.
 *
 * A PDF is a file of numbered objects: numbers, names, strings, arrays, dictionaries, references to other objects, and streams
 * (a dictionary followed by bytes). This is the lexer and parser for them and nothing more; finding an object by its number,
 * and unpacking a stream, is the document's job (document.ts).
 *
 * The file is untrusted, so nothing here trusts a size it declares or recurses without a bound. What it does not understand it
 * reads past, or refuses with an error that names the place, and never guesses at.
 */

export class PdfName {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
}

export class PdfRef {
  readonly num: number;
  readonly gen: number;
  constructor(num: number, gen: number) {
    this.num = num;
    this.gen = gen;
  }
}

/** A string is bytes, because what the bytes mean (text, a font's character codes, a date) depends on where it is used. */
export class PdfString {
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
}

export type PdfDict = Map<string, PdfObject>;

export class PdfStream {
  readonly dict: PdfDict;
  readonly raw: Uint8Array;
  constructor(dict: PdfDict, raw: Uint8Array) {
    this.dict = dict;
    this.raw = raw;
  }
}

export type PdfObject = null | boolean | number | PdfName | PdfRef | PdfString | PdfObject[] | PdfDict | PdfStream;

export class PdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfError";
  }
}

export const isDict = (o: PdfObject | undefined): o is PdfDict => o instanceof Map;
export const isName = (o: PdfObject | undefined, name?: string): o is PdfName => o instanceof PdfName && (name === undefined || o.name === name);

/** Characters that end a token without being whitespace. */
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const isSpace = (c: number): boolean => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;

export type Token =
  | { t: "num"; v: number; integer: boolean }
  | { t: "name"; v: string }
  | { t: "str"; v: Uint8Array }
  | { t: "kw"; v: string }
  | { t: "punct"; v: "[" | "]" | "<<" | ">>" | "{" | "}" }
  | { t: "eof" };

/** Deepest nesting of arrays and dictionaries read. Nothing real goes near it. */
const MAX_DEPTH = 64;

export class Lexer {
  readonly buf: Uint8Array;
  pos: number;

  constructor(buf: Uint8Array, pos = 0) {
    this.buf = buf;
    this.pos = pos;
  }

  skipSpace(): void {
    const b = this.buf;
    while (this.pos < b.length) {
      const c = b[this.pos] as number;
      if (isSpace(c)) this.pos++;
      else if (c === 0x25) {
        while (this.pos < b.length && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
      } else break;
    }
  }

  next(): Token {
    this.skipSpace();
    const b = this.buf;
    if (this.pos >= b.length) return { t: "eof" };
    const c = b[this.pos] as number;

    if (c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d) {
      this.pos++;
      return { t: "punct", v: String.fromCharCode(c) as "[" | "]" | "{" | "}" };
    }
    if (c === 0x3c) {
      if (b[this.pos + 1] === 0x3c) {
        this.pos += 2;
        return { t: "punct", v: "<<" };
      }
      return this.hexString();
    }
    if (c === 0x3e) {
      if (b[this.pos + 1] === 0x3e) {
        this.pos += 2;
        return { t: "punct", v: ">>" };
      }
      this.pos++;
      return this.next();
    }
    if (c === 0x28) return this.literalString();
    if (c === 0x29) {
      this.pos++;
      return this.next();
    }
    if (c === 0x2f) return this.name();

    const start = this.pos;
    while (this.pos < b.length && !isSpace(b[this.pos] as number) && !DELIMITERS.has(b[this.pos] as number)) this.pos++;
    const word = Buffer.from(b.subarray(start, this.pos)).toString("latin1");
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { t: "num", v: Number(word), integer: /^[+-]?\d+$/.test(word) };
    return { t: "kw", v: word };
  }

  private name(): Token {
    const b = this.buf;
    this.pos++;
    let out = "";
    while (this.pos < b.length && !isSpace(b[this.pos] as number) && !DELIMITERS.has(b[this.pos] as number)) {
      const c = b[this.pos] as number;
      if (c === 0x23 && this.pos + 2 < b.length && /^[0-9a-fA-F]{2}$/.test(Buffer.from(b.subarray(this.pos + 1, this.pos + 3)).toString("latin1"))) {
        out += String.fromCharCode(parseInt(Buffer.from(b.subarray(this.pos + 1, this.pos + 3)).toString("latin1"), 16));
        this.pos += 3;
      } else {
        out += String.fromCharCode(c);
        this.pos++;
      }
    }
    return { t: "name", v: out };
  }

  private hexString(): Token {
    const b = this.buf;
    this.pos++;
    const digits: number[] = [];
    while (this.pos < b.length && b[this.pos] !== 0x3e) {
      const c = b[this.pos] as number;
      const v = isDigit(c) ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 55 : c >= 0x61 && c <= 0x66 ? c - 87 : -1;
      if (v >= 0) digits.push(v);
      this.pos++;
    }
    this.pos++;
    if (digits.length % 2 === 1) digits.push(0);
    const out = new Uint8Array(digits.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = ((digits[i * 2] as number) << 4) | (digits[i * 2 + 1] as number);
    return { t: "str", v: out };
  }

  private literalString(): Token {
    const b = this.buf;
    this.pos++;
    const out: number[] = [];
    let depth = 1;
    while (this.pos < b.length) {
      const c = b[this.pos++] as number;
      if (c === 0x5c) {
        const e = b[this.pos++] as number;
        if (e === 0x6e) out.push(10);
        else if (e === 0x72) out.push(13);
        else if (e === 0x74) out.push(9);
        else if (e === 0x62) out.push(8);
        else if (e === 0x66) out.push(12);
        else if (e >= 0x30 && e <= 0x37) {
          let v = e - 0x30;
          for (let k = 0; k < 2; k++) {
            const d = b[this.pos] as number;
            if (d >= 0x30 && d <= 0x37) {
              v = v * 8 + (d - 0x30);
              this.pos++;
            } else break;
          }
          out.push(v & 0xff);
        } else if (e === 13) {
          if (b[this.pos] === 10) this.pos++;
        } else if (e === 10) {
          // a line continued
        } else out.push(e);
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        depth--;
        if (depth === 0) break;
        out.push(c);
      } else out.push(c);
    }
    return { t: "str", v: Uint8Array.from(out) };
  }
}

/**
 * One object, read from where the lexer is. A run of two integers and R is a reference. Streams are not read here: they follow
 * a dictionary, and where their bytes end depends on a length that may be a reference, so the document reads them.
 */
export function parseObject(lex: Lexer, depth = 0): PdfObject {
  if (depth > MAX_DEPTH) throw new PdfError("An object in this PDF is nested too deeply to be real.");
  const token = lex.next();
  return fromToken(lex, token, depth);
}

export function fromToken(lex: Lexer, token: Token, depth: number): PdfObject {
  switch (token.t) {
    case "num": {
      if (token.integer && token.v >= 0) {
        const mark = lex.pos;
        const second = lex.next();
        if (second.t === "num" && second.integer && second.v >= 0) {
          const third = lex.next();
          if (third.t === "kw" && third.v === "R") return new PdfRef(token.v, second.v);
        }
        lex.pos = mark;
      }
      return token.v;
    }
    case "name":
      return new PdfName(token.v);
    case "str":
      return new PdfString(token.v);
    case "kw":
      if (token.v === "true") return true;
      if (token.v === "false") return false;
      return null;
    case "eof":
      return null;
    case "punct": {
      if (token.v === "[") {
        const out: PdfObject[] = [];
        for (;;) {
          const t = lex.next();
          if (t.t === "eof" || (t.t === "punct" && t.v === "]")) return out;
          out.push(fromToken(lex, t, depth + 1));
        }
      }
      if (token.v === "<<") {
        const dict: PdfDict = new Map();
        for (;;) {
          const k = lex.next();
          if (k.t === "eof" || (k.t === "punct" && k.v === ">>")) return dict;
          if (k.t !== "name") continue;
          const v = lex.next();
          if (v.t === "punct" && v.v === ">>") {
            dict.set(k.v, null);
            return dict;
          }
          dict.set(k.v, fromToken(lex, v, depth + 1));
        }
      }
      return null;
    }
  }
}

/** The number a dictionary holds under a key, or the fallback. */
export function numberOf(o: PdfObject | undefined, fallback = 0): number {
  return typeof o === "number" && Number.isFinite(o) ? o : fallback;
}
