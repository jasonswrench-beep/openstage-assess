/**
 * Opening a PDF: finding its objects, unpacking its streams, and walking its pages.
 *
 * The file says where its objects are in a table at the end (a cross-reference table, or since PDF 1.5 a stream of them), and
 * may say so several times over if it was saved incrementally; the newest entry for a number wins. Many objects live inside
 * object streams, which are compressed. When the table is damaged, as a file that was copied badly or cut short may be, the
 * objects are found by scanning for them, which is slower and has to be told apart from the real thing in the notes.
 *
 * A PDF that is protected is refused with a message and not opened: its text is encrypted, and whether the person may read it
 * is not for this code to decide by trying keys.
 */

import { inflateSync } from "node:zlib";

import { isDict, isName, Lexer, numberOf, parseObject, PdfError, PdfName, PdfRef, PdfStream, type PdfDict, type PdfObject } from "./objects.ts";

/** The largest file read, and the largest any one stream may grow to when it is unpacked. */
export const MAX_PDF_BYTES = 300 * 1024 * 1024;
const MAX_STREAM_BYTES = 256 * 1024 * 1024;
const MAX_PAGES = 5000;

type XrefEntry = { kind: "file"; offset: number } | { kind: "stream"; stream: number; index: number };

export interface PdfPageInfo {
  /** Counting from 1. */
  number: number;
  dict: PdfDict;
  resources: PdfDict | undefined;
  mediaBox: [number, number, number, number];
  rotate: number;
}

const find = (buf: Uint8Array, word: string, from: number, backwards = false): number => {
  const needle = Buffer.from(word, "latin1");
  const hay = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  return backwards ? hay.lastIndexOf(needle, from) : hay.indexOf(needle, from);
};

export class PdfDocument {
  readonly bytes: Uint8Array;
  readonly trailer: PdfDict = new Map();
  /** What was done to read a file that was not in order, for the person to be told. */
  readonly notes: string[] = [];
  private readonly xref = new Map<number, XrefEntry>();
  private readonly cache = new Map<number, PdfObject>();
  private readonly resolving = new Set<number>();
  private readonly objectStreams = new Map<number, Map<number, PdfObject>>();
  private base = 0;

  constructor(bytes: Uint8Array) {
    if (bytes.length === 0) throw new PdfError("This file is empty.");
    if (bytes.length > MAX_PDF_BYTES) throw new PdfError(`This PDF is larger than ${MAX_PDF_BYTES / 1024 / 1024} MB, which is more than a test bank is.`);
    this.bytes = bytes;
    const header = find(bytes, "%PDF-", 0);
    if (header === -1 || header > 1024) throw new PdfError("This file is not a PDF: it does not begin with %PDF-.");
    this.base = header;

    let ok = false;
    try {
      ok = this.readXrefChain();
    } catch {
      ok = false;
    }
    if (!ok || !this.trailer.has("Root") || !isDict(this.catalogOrNull())) {
      this.reconstruct();
    }
    if (this.trailer.has("Encrypt")) {
      throw new PdfError(
        "This PDF is protected, so its text cannot be read. If you may use it, open it in a PDF program, save a copy that is not protected (or print it to PDF), and bring that in.",
      );
    }
  }

  // -------------------------------------------------------------------------
  // The table of objects
  // -------------------------------------------------------------------------

  private catalogOrNull(): PdfObject {
    try {
      return this.resolve(this.trailer.get("Root"));
    } catch {
      return null;
    }
  }

  private readXrefChain(): boolean {
    const b = this.bytes;
    // The last one in the file: a file that was saved over and over has more than one, and the newest is at the end.
    const at = find(b, "startxref", b.length, true);
    if (at === -1) return false;
    const lex = new Lexer(b, at + 9);
    const first = lex.next();
    if (first.t !== "num") return false;
    const seen = new Set<number>();
    const queue = [first.v];
    let primary = true;
    while (queue.length > 0) {
      const offset = (queue.shift() as number) + this.base;
      if (seen.has(offset) || offset < 0 || offset >= b.length) continue;
      seen.add(offset);
      const section = this.readXrefSection(offset);
      if (!section) return false;
      if (primary) {
        for (const [k, v] of section) this.trailer.set(k, v);
        primary = false;
      }
      const stm = section.get("XRefStm");
      if (typeof stm === "number") queue.unshift(stm);
      const prev = section.get("Prev");
      if (typeof prev === "number") queue.push(prev);
      if (seen.size > 1000) return false;
    }
    return this.xref.size > 0;
  }

  private setEntry(num: number, entry: XrefEntry): void {
    if (!this.xref.has(num)) this.xref.set(num, entry);
  }

  /** One cross-reference section, and the trailer that goes with it. */
  private readXrefSection(offset: number): PdfDict | undefined {
    const b = this.bytes;
    const lex = new Lexer(b, offset);
    const head = lex.next();
    if (head.t === "kw" && head.v === "xref") {
      for (;;) {
        const t = lex.next();
        if (t.t === "kw" && t.v === "trailer") {
          const dict = parseObject(lex);
          return isDict(dict) ? dict : undefined;
        }
        if (t.t !== "num") return undefined;
        const count = lex.next();
        if (count.t !== "num") return undefined;
        let num = t.v;
        for (let i = 0; i < count.v; i++) {
          const off = lex.next();
          const gen = lex.next();
          const kind = lex.next();
          if (off.t !== "num" || gen.t !== "num" || kind.t !== "kw") return undefined;
          if (kind.v === "n" && off.v > 0) this.setEntry(num, { kind: "file", offset: off.v + this.base });
          num++;
        }
      }
    }
    if (head.t === "num") {
      // A cross-reference stream: an object that holds the entries as packed numbers.
      const object = this.readIndirectAt(offset);
      if (!(object instanceof PdfStream) || !isName(object.dict.get("Type"), "XRef")) return undefined;
      const data = this.streamData(object);
      const w = object.dict.get("W");
      if (!Array.isArray(w) || w.length < 3) return undefined;
      const [w1, w2, w3] = w.map((n) => numberOf(n)) as [number, number, number];
      const size = numberOf(object.dict.get("Size"));
      const index = Array.isArray(object.dict.get("Index")) ? (object.dict.get("Index") as number[]) : [0, size];
      const width = w1 + w2 + w3;
      let p = 0;
      const read = (n: number): number => {
        let v = 0;
        for (let k = 0; k < n; k++) v = v * 256 + (data[p++] as number);
        return v;
      };
      for (let s = 0; s + 1 < index.length; s += 2) {
        const first = index[s] as number;
        const count = index[s + 1] as number;
        for (let i = 0; i < count && p + width <= data.length; i++) {
          const type = w1 === 0 ? 1 : read(w1);
          const f2 = read(w2);
          const f3 = read(w3);
          if (type === 1) this.setEntry(first + i, { kind: "file", offset: f2 + this.base });
          else if (type === 2) this.setEntry(first + i, { kind: "stream", stream: f2, index: f3 });
        }
      }
      return object.dict;
    }
    return undefined;
  }

  /** The table is missing or wrong: find the objects by looking for them. */
  private reconstruct(): void {
    this.xref.clear();
    this.cache.clear();
    this.objectStreams.clear();
    this.trailer.clear();
    this.notes.push("The table of objects in this PDF was damaged, so the objects were found by searching the file.");
    const b = this.bytes;
    const text = Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("latin1");
    const re = /(?:^|[\r\n\s])(\d+)\s+(\d+)\s+obj\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) this.xref.set(Number(m[1]), { kind: "file", offset: m.index + m[0].indexOf(m[1] as string) });

    for (const num of [...this.xref.keys()]) {
      let object: PdfObject;
      try {
        object = this.get(num);
      } catch {
        continue;
      }
      if (object instanceof PdfStream && isName(object.dict.get("Type"), "ObjStm")) {
        try {
          const contents = this.loadObjectStream(num);
          let i = 0;
          for (const inner of contents.keys()) {
            if (!this.xref.has(inner)) this.xref.set(inner, { kind: "stream", stream: num, index: i });
            i++;
          }
        } catch {
          // an object stream that cannot be unpacked holds nothing that can be found
        }
      }
      const dict = object instanceof PdfStream ? object.dict : isDict(object) ? object : undefined;
      if (dict && (dict.has("Root") || dict.has("Encrypt")) && (isName(dict.get("Type"), "XRef") || dict.has("Size"))) {
        for (const [k, v] of dict) if (!this.trailer.has(k)) this.trailer.set(k, v);
      }
    }
    let at = 0;
    for (;;) {
      at = find(b, "trailer", at);
      if (at === -1) break;
      const dict = parseObject(new Lexer(b, at + 7));
      if (isDict(dict)) for (const [k, v] of dict) this.trailer.set(k, v);
      at += 7;
    }
    if (!this.trailer.has("Root")) {
      for (const num of this.xref.keys()) {
        const o = this.cache.get(num);
        if (isDict(o) && isName(o.get("Type"), "Catalog")) {
          this.trailer.set("Root", new PdfRef(num, 0));
          break;
        }
      }
    }
    if (!this.trailer.has("Root")) throw new PdfError("This PDF has no pages that can be found in it.");
  }

  // -------------------------------------------------------------------------
  // Objects
  // -------------------------------------------------------------------------

  /** The object at a place in the file, with its stream if it has one. */
  private readIndirectAt(offset: number): PdfObject {
    const b = this.bytes;
    const lex = new Lexer(b, offset);
    const num = lex.next();
    const gen = lex.next();
    const obj = lex.next();
    if (num.t !== "num" || gen.t !== "num" || obj.t !== "kw" || obj.v !== "obj") throw new PdfError(`Expected an object at byte ${offset} of this PDF, and did not find one.`);
    const object = parseObject(lex);
    if (!isDict(object)) return object;
    const after = lex.pos;
    const next = lex.next();
    if (next.t !== "kw" || next.v !== "stream") {
      lex.pos = after;
      return object;
    }
    let start = lex.pos;
    if (b[start] === 13 && b[start + 1] === 10) start += 2;
    else if (b[start] === 10 || b[start] === 13) start += 1;

    let length = -1;
    const declared = object.get("Length");
    if (typeof declared === "number") length = declared;
    else if (declared instanceof PdfRef && !this.resolving.has(declared.num)) {
      const l = this.resolve(declared);
      if (typeof l === "number") length = l;
    }
    let end = -1;
    if (length >= 0 && start + length <= b.length) {
      const tail = new Lexer(b, start + length);
      const t = tail.next();
      if (t.t === "kw" && t.v === "endstream") end = start + length;
    }
    if (end === -1) {
      const e = find(b, "endstream", start);
      if (e === -1) throw new PdfError(`A stream in this PDF (at byte ${offset}) does not end.`);
      end = e;
      if (b[end - 1] === 10) end--;
      if (b[end - 1] === 13) end--;
    }
    return new PdfStream(object, b.subarray(start, end));
  }

  private loadObjectStream(num: number): Map<number, PdfObject> {
    const cached = this.objectStreams.get(num);
    if (cached) return cached;
    const stream = this.get(num);
    if (!(stream instanceof PdfStream)) throw new PdfError(`Object ${num} should be an object stream and is not.`);
    const data = this.streamData(stream);
    const n = numberOf(stream.dict.get("N"));
    const first = numberOf(stream.dict.get("First"));
    if (n < 0 || n > 1_000_000 || first < 0 || first > data.length) throw new PdfError(`An object stream (${num}) in this PDF is not well formed.`);
    const head = new Lexer(data, 0);
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < n; i++) {
      const id = head.next();
      const off = head.next();
      if (id.t !== "num" || off.t !== "num") break;
      pairs.push([id.v, off.v]);
    }
    const out = new Map<number, PdfObject>();
    for (const [id, off] of pairs) {
      if (!out.has(id)) out.set(id, parseObject(new Lexer(data, first + off)));
    }
    this.objectStreams.set(num, out);
    return out;
  }

  /** An object by number. A number that is not in the file is null, as the format says. */
  get(num: number): PdfObject {
    if (this.cache.has(num)) return this.cache.get(num) as PdfObject;
    const entry = this.xref.get(num);
    if (!entry) return null;
    if (this.resolving.has(num)) return null;
    this.resolving.add(num);
    try {
      let object: PdfObject;
      if (entry.kind === "file") object = this.readIndirectAt(entry.offset);
      else {
        // An object stream holds its objects under the numbers its own header gives, and the table gives the same number.
        object = this.loadObjectStream(entry.stream).get(num) ?? null;
      }
      this.cache.set(num, object);
      return object;
    } finally {
      this.resolving.delete(num);
    }
  }

  /** Follows references until something is not one. A chain that loops is null. */
  resolve(o: PdfObject | undefined): PdfObject {
    let current: PdfObject | undefined = o;
    for (let hops = 0; hops < 32; hops++) {
      if (!(current instanceof PdfRef)) return current ?? null;
      current = this.get(current.num);
    }
    return null;
  }

  dict(o: PdfObject | undefined): PdfDict | undefined {
    const r = this.resolve(o);
    if (isDict(r)) return r;
    if (r instanceof PdfStream) return r.dict;
    return undefined;
  }

  array(o: PdfObject | undefined): PdfObject[] | undefined {
    const r = this.resolve(o);
    return Array.isArray(r) ? r : undefined;
  }

  number(o: PdfObject | undefined, fallback = 0): number {
    return numberOf(this.resolve(o), fallback);
  }

  name(o: PdfObject | undefined): string | undefined {
    const r = this.resolve(o);
    return r instanceof PdfName ? r.name : undefined;
  }

  // -------------------------------------------------------------------------
  // Streams
  // -------------------------------------------------------------------------

  /** A stream's bytes with its filters undone. A filter this does not read is an error that names it. */
  streamData(stream: PdfStream): Uint8Array {
    let data: Uint8Array = stream.raw;
    const filterObject = this.resolve(stream.dict.get("Filter") ?? stream.dict.get("F"));
    const filters = Array.isArray(filterObject) ? filterObject.map((f) => this.name(f)) : [this.name(filterObject)];
    const parmsObject = this.resolve(stream.dict.get("DecodeParms") ?? stream.dict.get("DP"));
    const parms = Array.isArray(parmsObject) ? parmsObject.map((p) => this.dict(p)) : [this.dict(parmsObject)];
    filters.forEach((name, i) => {
      if (name === undefined) return;
      const p = parms[i];
      switch (name) {
        case "FlateDecode":
        case "Fl": {
          let out: Uint8Array;
          try {
            out = inflateSync(data, { maxOutputLength: MAX_STREAM_BYTES });
          } catch (error) {
            if (/larger than|maxOutputLength|buffer/i.test((error as Error).message)) throw new PdfError("A stream in this PDF unpacks to more than a test bank could hold.");
            try {
              // A stream cut short still holds what was written before the cut.
              out = inflateSync(data, { finishFlush: 2, maxOutputLength: MAX_STREAM_BYTES });
            } catch {
              throw new PdfError("A stream in this PDF could not be unpacked: it is damaged.");
            }
          }
          data = p ? this.predictor(out, p) : out;
          break;
        }
        case "ASCIIHexDecode":
        case "AHx": {
          const hex = Buffer.from(data).toString("latin1").replace(/[^0-9a-fA-F]/g, "");
          data = Uint8Array.from(Buffer.from(hex.length % 2 ? `${hex}0` : hex, "hex"));
          break;
        }
        case "ASCII85Decode":
        case "A85":
          data = ascii85(data);
          break;
        case "RunLengthDecode":
        case "RL":
          data = runLength(data);
          break;
        case "DCTDecode":
        case "JPXDecode":
        case "CCITTFaxDecode":
        case "JBIG2Decode":
          throw new PdfError(`This stream is an image (${name}), not text.`);
        default:
          throw new PdfError(`A stream in this PDF uses a filter, ${name}, that this reader does not read.`);
      }
    });
    return data;
  }

  private predictor(data: Uint8Array, parms: PdfDict): Uint8Array {
    const predictor = this.number(parms.get("Predictor"), 1);
    if (predictor < 10 && predictor !== 2) return data;
    const columns = this.number(parms.get("Columns"), 1);
    const colors = this.number(parms.get("Colors"), 1);
    const bits = this.number(parms.get("BitsPerComponent"), 8);
    const bpp = Math.max(1, Math.ceil((colors * bits) / 8));
    const rowBytes = Math.ceil((columns * colors * bits) / 8);
    if (predictor === 2) {
      if (bits !== 8) return data;
      const out = Uint8Array.from(data);
      for (let r = 0; r + rowBytes <= out.length; r += rowBytes) for (let i = bpp; i < rowBytes; i++) out[r + i] = ((out[r + i] as number) + (out[r + i - bpp] as number)) & 0xff;
      return out;
    }
    const stride = rowBytes + 1;
    const rows = Math.floor(data.length / stride);
    const out = new Uint8Array(rows * rowBytes);
    for (let r = 0; r < rows; r++) {
      const type = data[r * stride] as number;
      for (let i = 0; i < rowBytes; i++) {
        const raw = data[r * stride + 1 + i] as number;
        const left = i >= bpp ? (out[r * rowBytes + i - bpp] as number) : 0;
        const up = r > 0 ? (out[(r - 1) * rowBytes + i] as number) : 0;
        const upLeft = r > 0 && i >= bpp ? (out[(r - 1) * rowBytes + i - bpp] as number) : 0;
        let v: number;
        if (type === 0) v = raw;
        else if (type === 1) v = raw + left;
        else if (type === 2) v = raw + up;
        else if (type === 3) v = raw + ((left + up) >> 1);
        else if (type === 4) {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          v = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
        } else v = raw;
        out[r * rowBytes + i] = v & 0xff;
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Pages
  // -------------------------------------------------------------------------

  pages(): PdfPageInfo[] {
    const catalog = this.dict(this.trailer.get("Root"));
    if (!catalog) throw new PdfError("This PDF has no catalog, so it has no pages to find.");
    const root = this.resolve(catalog.get("Pages"));
    if (!isDict(root)) throw new PdfError("This PDF has no page tree.");
    const out: PdfPageInfo[] = [];
    const visited = new Set<PdfDict>();
    const walk = (node: PdfDict, inherited: { resources?: PdfDict; mediaBox?: number[]; rotate?: number }, depth: number): void => {
      if (depth > 64 || visited.has(node) || out.length >= MAX_PAGES) return;
      visited.add(node);
      const resources = this.dict(node.get("Resources")) ?? inherited.resources;
      const box = this.array(node.get("MediaBox"));
      const mediaBox = box && box.length >= 4 ? box.map((n) => this.number(n)) : inherited.mediaBox;
      const rotate = node.has("Rotate") ? this.number(node.get("Rotate")) : inherited.rotate;
      const kids = this.array(node.get("Kids"));
      const type = this.name(node.get("Type"));
      if (kids && type !== "Page") {
        for (const kid of kids) {
          const d = this.dict(kid);
          if (d) walk(d, { ...(resources ? { resources } : {}), ...(mediaBox ? { mediaBox } : {}), ...(rotate !== undefined ? { rotate } : {}) }, depth + 1);
        }
        return;
      }
      const m = (mediaBox ?? [0, 0, 612, 792]) as number[];
      out.push({ number: out.length + 1, dict: node, resources, mediaBox: [m[0] as number, m[1] as number, m[2] as number, m[3] as number], rotate: rotate ?? 0 });
    };
    walk(root, {}, 0);
    return out;
  }

  /** The bytes of a page's content: its content streams, one after another, with a break between so that no token joins. */
  pageContent(page: PdfPageInfo): Uint8Array {
    const contents = this.resolve(page.dict.get("Contents"));
    const streams: PdfStream[] = [];
    const add = (o: PdfObject | undefined): void => {
      const r = this.resolve(o);
      if (r instanceof PdfStream) streams.push(r);
    };
    if (Array.isArray(contents)) contents.forEach(add);
    else add(contents);
    const parts: Buffer[] = [];
    for (const s of streams) {
      parts.push(Buffer.from(this.streamData(s)));
      parts.push(Buffer.from("\n"));
    }
    return Buffer.concat(parts);
  }
}

function ascii85(data: Uint8Array): Uint8Array {
  const text = Buffer.from(data).toString("latin1").replace(/\s+/g, "");
  const body = text.replace(/^<~/, "").replace(/~>.*$/s, "");
  const out: number[] = [];
  let group: number[] = [];
  for (const ch of body) {
    if (ch === "z" && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    group.push(ch.charCodeAt(0) - 33);
    if (group.length === 5) {
      let v = 0;
      for (const d of group) v = v * 85 + d;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      group = [];
    }
  }
  if (group.length > 1) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const d of group) v = v * 85 + d;
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...bytes.slice(0, n - 1));
  }
  return Uint8Array.from(out);
}

function runLength(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < data.length; ) {
    const n = data[i++] as number;
    if (n === 128) break;
    if (n < 128) {
      for (let k = 0; k <= n && i < data.length; k++) out.push(data[i++] as number);
    } else {
      const v = data[i++] as number;
      for (let k = 0; k < 257 - n; k++) out.push(v);
    }
    if (out.length > MAX_STREAM_BYTES) throw new PdfError("A stream in this PDF unpacks to more than a test bank could hold.");
  }
  return Uint8Array.from(out);
}
