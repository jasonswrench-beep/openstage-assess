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

import { isDict, isName, Lexer, numberOf, parseObject, PdfError, PdfName, PdfRef, PdfStream, type PdfDict, type PdfObject, type Token } from "./objects.ts";

/** The largest file read, and the largest any one stream may grow to when it is unpacked. */
export const MAX_PDF_BYTES = 300 * 1024 * 1024;
const MAX_STREAM_BYTES = 256 * 1024 * 1024;
/** The widest row of a predicted stream that is believed: 16 MiB is far more than a page of any picture holds. */
const MAX_ROW_BYTES = 16 * 1024 * 1024;
const MAX_PAGES = 5000;
/** The most rows a cross-reference stream may have. A test bank is not a file of two million objects. */
const MAX_XREF_ROWS = 2_000_000;
/**
 * How much of a file objects that ran into the place where the next one begins may be read again for: this many times its length and this
 * many bytes more. A real file needs none of it, and a file whose objects have the words `9 0 obj` in a string of every one needs the length
 * of its objects. So that the work is in proportion to the file and no more: 5,000 objects that never close, each read again to the end of
 * a file of 240 KB, would be 1.2 GB of reading (51 seconds), and the budget lets a file of that size read 5 MB in all, tens of milliseconds.
 */
const REREAD_FACTOR = 16;
const REREAD_FLOOR = 1_000_000;

type XrefEntry =
  | {
      kind: "file";
      offset: number;
      /**
       * Where the words of the object are read to: the place where the next object begins, which the table gives or the search for them
       * found. An object that runs into it is read again from the whole file (`readIndirectAt`), and only while there is budget for that.
       */
      end?: number;
    }
  | { kind: "stream"; stream: number; index: number };

/** An object stream, with its objects still unread: each is read when it is asked for, and from its own start to the next one's. */
interface ObjectStream {
  data: Uint8Array;
  first: number;
  /** Where each object begins, from the start of the objects, by its number. */
  offsets: Map<number, number>;
  /** Where the object that begins at each of those places ends: where the next begins, or the end of the data. */
  ends: Map<number, number>;
  /** What has been read, by where it begins. */
  read: Map<number, PdfObject>;
}

export interface PdfPageInfo {
  /** Counting from 1. */
  number: number;
  dict: PdfDict;
  resources: PdfDict | undefined;
  mediaBox: [number, number, number, number];
  rotate: number;
}

/** What reading the words of an object comes to: the object, where it ended, and for a dictionary the word after it, which is `stream` for a stream. */
interface ReadObject {
  lex: Lexer;
  object: PdfObject;
  after: number;
  next: Token;
}

function readWords(lex: Lexer): ReadObject {
  const object = parseObject(lex);
  const after = lex.pos;
  return { lex, object, after, next: isDict(object) ? lex.next() : { t: "eof" } };
}

/** The object at the place the lexer is at: its number, its generation and the word obj, and then its words. */
function readObject(lex: Lexer, offset: number): ReadObject {
  const num = lex.next();
  const gen = lex.next();
  const obj = lex.next();
  if (num.t !== "num" || gen.t !== "num" || obj.t !== "kw" || obj.v !== "obj") throw new PdfError(`Expected an object at byte ${offset} of this PDF, and did not find one.`);
  return readWords(lex);
}

const find = (buf: Uint8Array, word: string, from: number, backwards = false): number => {
  const needle = Buffer.from(word, "latin1");
  const hay = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  return backwards ? hay.lastIndexOf(needle, from) : hay.indexOf(needle, from);
};

/**
 * Where a word first begins at or after a place, for a file that asks the same of thousands of places. Each ask used to search from its
 * own place to the first one it found, which is no more than the next one for a file that is in order; for a file of 100,000 objects
 * that say `stream` and have no `endstream` it was the rest of the file each time, and 2.5 MB took 37 seconds. What was found last is
 * remembered as a stretch (no word begins from `from` up to `at`, and one begins at `at`, or none does after `from`), and a place inside it
 * has its answer. A place before it is searched only as far as the stretch begins, and a place past it is a search of its own.
 */
export class WordFinder {
  private readonly hay: Buffer;
  private readonly needle: Buffer;
  private known = false;
  private from = 0;
  private at = -1;

  constructor(bytes: Uint8Array, word: string) {
    this.hay = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.needle = Buffer.from(word, "latin1");
  }

  after(start: number): number {
    if (this.known && start >= this.from && (this.at === -1 || start <= this.at)) return this.at;
    let found: number;
    if (this.known && start < this.from) {
      // The word may begin in front of the stretch and run into it, so the search goes as far as the end of a word that begins at its edge.
      const stop = Math.min(this.hay.length, this.from + this.needle.length - 1);
      found = this.hay.subarray(0, stop).indexOf(this.needle, start);
      if (found === -1) found = this.at;
    } else found = this.hay.indexOf(this.needle, start);
    this.known = true;
    this.from = start;
    this.at = found;
    return found;
  }
}

export class PdfDocument {
  readonly bytes: Uint8Array;
  readonly trailer: PdfDict = new Map();
  /** What was done to read a file that was not in order, for the person to be told. */
  readonly notes: string[] = [];
  private readonly xref = new Map<number, XrefEntry>();
  private readonly cache = new Map<number, PdfObject>();
  private readonly resolving = new Set<number>();
  private readonly objectStreams = new Map<number, ObjectStream>();
  /** Where each stream's data ends, for the streams whose length is not to be believed. */
  private readonly endstreams: WordFinder;
  private base = 0;
  /**
   * How many bytes the objects that ran into their end may be read again for, in all (see `readIndirectAt`). The budget is for the file and
   * not for an object, so that thousands of objects that never close cannot read the rest of the file each, and it is a multiple of the
   * file's length, so that a file whose every object has a string in it that looks like the start of another is read whole.
   */
  private rereadBudget: number;

  constructor(bytes: Uint8Array) {
    if (bytes.length === 0) throw new PdfError("This file is empty.");
    if (bytes.length > MAX_PDF_BYTES) throw new PdfError(`This PDF is larger than ${MAX_PDF_BYTES / 1024 / 1024} MB, which is more than a test bank is.`);
    this.bytes = bytes;
    this.endstreams = new WordFinder(bytes, "endstream");
    this.rereadBudget = REREAD_FACTOR * bytes.length + REREAD_FLOOR;
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
    this.boundTableObjects();
    return this.xref.size > 0;
  }

  /**
   * Gives each object the table lists, as the end of its words, the place where the next object it lists begins. An object that never
   * closes (`7 0 obj << /A 1` and nothing after it) was read to the end of the FILE even though the table says where the next begins, and
   * a page tree that listed 5,000 of them took 51 seconds. The table, unlike a search for the text `N G obj`, cannot be fooled by a string.
   * Objects the table sends to the same place have the same end, and an offset past the end of the file ends where the file does. An
   * object whose words really do go on past the next place (a table that is wrong by a few bytes) is read again by `readIndirectAt`.
   */
  private boundTableObjects(): void {
    const length = this.bytes.length;
    let count = 0;
    for (const entry of this.xref.values()) if (entry.kind === "file") count++;
    const places = new Float64Array(count);
    let n = 0;
    for (const entry of this.xref.values()) if (entry.kind === "file") places[n++] = entry.offset;
    places.sort();
    // The first place after each one, by looking back from the end through the sorted places.
    const next = new Map<number, number>();
    let after = length;
    for (let i = places.length - 1; i >= 0; i--) {
      const place = places[i] as number;
      if (place !== after && !next.has(place)) next.set(place, after);
      if (place < after) after = place;
    }
    for (const entry of this.xref.values()) if (entry.kind === "file" && entry.end === undefined) entry.end = Math.min(next.get(entry.offset) ?? length, length);
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
      // Each field is 0 to 8 bytes wide and an entry is at least one byte. The loop below counts entries by a number the file gives
      // and takes each from the data, so a width of 0 made it count to 1e9 without taking anything (5 seconds and 1.2 GB from 244
      // bytes), a negative one counted to 1e20, and a width of 1e12 for one field was a loop of its own in `read`. A table that cannot
      // be right is no table: the objects are found by searching, which says so.
      if (![w1, w2, w3].every((n) => Number.isInteger(n) && n >= 0 && n <= 8) || w1 + w2 + w3 === 0) return undefined;
      const size = numberOf(object.dict.get("Size"));
      const rawIndex = object.dict.get("Index");
      const index = Array.isArray(rawIndex) ? rawIndex.map((n) => numberOf(n, Number.NaN)) : [0, size];
      if (!index.every((n) => Number.isInteger(n) && n >= 0)) return undefined;
      const width = w1 + w2 + w3;
      // The widths and the index are believed, and the number of rows they come to was not looked at: a row of one byte is allowed, so
      // 660 bytes of file unpacked to 8 million bytes and became a Map of 8 million entries (670 MB), and the table was believed, and
      // the objects were looked up where it said and not found. No file has 2 million objects; a table that says it does is not a
      // table, and the objects are found by searching, which says so. The rows are counted before any is stored, so that nothing is built.
      let rows = 0;
      for (let s = 0; s + 1 < index.length; s += 2) rows += index[s + 1] as number;
      if (Math.min(rows, Math.floor(data.length / width)) > MAX_XREF_ROWS) return undefined;
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
    const found: Array<{ num: number; offset: number }> = [];
    while ((m = re.exec(text))) found.push({ num: Number(m[1]), offset: m.index + m[0].indexOf(m[1] as string) });
    // Each object is read from where it begins to where the next one begins, and no further unless it runs into that place (see
    // `readIndirectAt`: the place is only text that looks like the start of an object, and a string or a comment of this one may hold it).
    // An object that never closes (`7 0 obj [` and nothing after it) was read to the end of the FILE, and 5,000 of them, 64 KB, took 17
    // seconds. A stream's bytes are still looked for in the whole file: they are not read by the lexer, and a stream may hold the words
    // "1 0 obj" in its data.
    found.forEach((f, i) => this.xref.set(f.num, { kind: "file", offset: f.offset, end: i + 1 < found.length ? (found[i + 1] as { offset: number }).offset : b.length }));

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
          for (const inner of contents.offsets.keys()) {
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
      const lex = new Lexer(b, at + 7);
      const dict = parseObject(lex);
      if (isDict(dict)) for (const [k, v] of dict) this.trailer.set(k, v);
      // The next search begins where this reading ended. It began 7 bytes on, so that "trailer << " repeated 20,000 times was 20,000
      // readings that each ran to the end of the file (39 seconds); anything the reading went over is part of this trailer's dictionary.
      at = Math.max(at + 7, lex.pos);
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

  /**
   * An object that ran into the place where the next one seems to begin, read again from the whole file. The place is where the table
   * says the next object is or, with no table, where text that looks like `N G obj` stands, and such text is in a string, a comment or a
   * piece of junk inside an object as well: a page dictionary with `/Title (see 9 0 obj here)` before its `/Contents` was cut at the
   * string and lost its contents, and a file that had read was refused as "probably a scan". Reading the object whole is what was done
   * before there was a bound (and it is what is done here while the budget lasts), and the bound is what keeps 5,000 objects that never
   * close from being 5,000 reads of the rest of the file. What is charged is the bytes the second reading went over, so that an object
   * with a short string in it costs the length of the object and only an object that really does run on costs the rest of the file.
   * A second reading that fails (an object that never closes, with others inside it, nests deeper than is read) leaves the first.
   */
  private readUnbounded(offset: number): ReadObject | undefined {
    const lex = new Lexer(this.bytes, offset);
    try {
      return readObject(lex, offset);
    } catch (error) {
      if (error instanceof PdfError) return undefined;
      throw error;
    } finally {
      this.rereadBudget -= Math.max(1, lex.pos - offset);
    }
  }

  /** The object at a place in the file, with its stream if it has one. */
  private readIndirectAt(offset: number, limit?: number): PdfObject {
    const b = this.bytes;
    // The words of the object are read no further than `limit`; where its stream's bytes are is looked for in the whole file.
    let lex = new Lexer(limit === undefined ? b : b.subarray(0, limit), offset);
    let read: ReadObject | undefined;
    let refused: PdfError | undefined;
    try {
      read = readObject(lex, offset);
    } catch (error) {
      if (!(error instanceof PdfError)) throw error;
      refused = error;
    }
    // The reading stopped because the words ended and not because the object did: the bound may be inside the object, between its
    // dictionary and the word `stream` (a comment there, with the words in it), or inside the number and the word obj that begin it (a
    // table that is wrong by a few bytes puts the next place there). A bound at the end of the file is the end of the file, and reading
    // again would find the same.
    if (limit !== undefined && limit < b.length && lex.pos >= limit && this.rereadBudget > 0) {
      const again = this.readUnbounded(offset);
      if (again) read = again;
    }
    if (!read) throw refused;
    const { object, next } = read;
    lex = read.lex;
    if (!isDict(object)) return object;
    if (next.t !== "kw" || next.v !== "stream") {
      lex.pos = read.after;
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
      const e = this.endstreams.after(start);
      if (e === -1) throw new PdfError(`A stream in this PDF (at byte ${offset}) does not end.`);
      end = e;
      if (b[end - 1] === 10) end--;
      if (b[end - 1] === 13) end--;
    }
    return new PdfStream(object, b.subarray(start, end));
  }

  private loadObjectStream(num: number): ObjectStream {
    const cached = this.objectStreams.get(num);
    if (cached) return cached;
    const stream = this.get(num);
    if (!(stream instanceof PdfStream)) throw new PdfError(`Object ${num} should be an object stream and is not.`);
    const data = this.streamData(stream);
    const n = numberOf(stream.dict.get("N"));
    const first = numberOf(stream.dict.get("First"));
    if (n < 0 || n > 1_000_000 || first < 0 || first > data.length) throw new PdfError(`An object stream (${num}) in this PDF is not well formed.`);
    const head = new Lexer(data, 0);
    const offsets = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      const id = head.next();
      const off = head.next();
      if (id.t !== "num" || off.t !== "num") break;
      if (!offsets.has(id.v) && Number.isInteger(off.v) && off.v >= 0) offsets.set(id.v, off.v);
    }
    // Every object used to be read as soon as the stream was opened, each from its start to the end of the data. An offset that
    // pointed at a bracket that never closed made each of 2000 objects run to the end of 50,000 numbers: 90 seconds from 5 KB. An
    // object is now read when it is asked for, and no further than the start of the next one, so that however many are asked for the
    // reading of all of them is no more than the length of the data.
    const starts = [...new Set(offsets.values())].sort((a, b) => a - b);
    const ends = new Map<number, number>();
    starts.forEach((start, i) => ends.set(start, i + 1 < starts.length ? (starts[i + 1] as number) : Math.max(0, data.length - first)));
    const opened: ObjectStream = { data, first, offsets, ends, read: new Map() };
    this.objectStreams.set(num, opened);
    return opened;
  }

  /** One object of an object stream, read the first time it is asked for. */
  private innerObject(stream: ObjectStream, id: number): PdfObject {
    const start = stream.offsets.get(id);
    if (start === undefined) return null;
    if (stream.read.has(start)) return stream.read.get(start) as PdfObject;
    const end = stream.first + (stream.ends.get(start) as number);
    const value = parseObject(new Lexer(stream.data.subarray(0, Math.min(end, stream.data.length)), stream.first + start));
    stream.read.set(start, value);
    return value;
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
      if (entry.kind === "file") object = this.readIndirectAt(entry.offset, entry.end);
      else {
        // An object stream holds its objects under the numbers its own header gives, and the table gives the same number.
        object = this.innerObject(this.loadObjectStream(entry.stream), num);
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
    // A stream that says it has no columns, no colours or no bits has rows of no width. The loop below steps a row at a time, so a
    // row of 0 bytes never got anywhere: a PDF of 509 bytes with /Predictor 2 and /Columns 0 kept the whole program busy for as long
    // as it was left (found by reading the loop's bound, which no damaged-file run had reached). The first fix checked each number
    // for being above 0, and /Columns and /Colors written as 0.(200 zeros)1 passed it and multiplied to 0 again. So what is checked
    // is what the loop uses: whole numbers of columns and colours, a depth the format has, and a row that is at least one byte and
    // not larger than anything a page could hold. Every other value is refused in words and not guessed at (a row of 2147483648
    // bytes read as no rows, and the page was lost without a word). A row of at least one byte is not asked for in so many words: whole
    // columns, whole colours and a depth of at least 1 cannot come to less.
    const whole = (n: number): boolean => Number.isInteger(n) && n >= 1;
    const rowBytes = Math.ceil((columns * colors * bits) / 8);
    if (!whole(columns) || !whole(colors) || ![1, 2, 4, 8, 16].includes(bits) || rowBytes > MAX_ROW_BYTES) {
      throw new PdfError("A stream in this PDF describes its rows with a width, colour count or bit depth that cannot be right, so it was not read.");
    }
    const bpp = Math.max(1, Math.ceil((colors * bits) / 8));
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

/** The characters `\s` matches among the 256 a byte can be: the five of white space, the space, and the no-break space. */
const isWhite = (c: number): boolean => c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32 || c === 160;

export function ascii85(data: Uint8Array, cap = MAX_STREAM_BYTES): Uint8Array {
  // The output is bytes in a growing typed array, and the limit is looked at before a group is written. It was a plain array of numbers,
  // 8 bytes for each byte of output, with no limit at all: 800 bytes of file made 895 MB, and with a heap of 256 MB the process was
  // gone. (The same fault as the run-length decoder's, in the function next to it.) White space is taken out first, wherever it is,
  // so that a start mark or an end mark with a space inside it is still one, as it was when this was done on a string.
  const body = new Uint8Array(data.length);
  let n = 0;
  for (let i = 0; i < data.length; i++) if (!isWhite(data[i] as number)) body[n++] = data[i] as number;
  const from = n >= 2 && body[0] === 0x3c && body[1] === 0x7e ? 2 : 0;
  let to = n;
  for (let i = from; i + 1 < n; i++) {
    if (body[i] === 0x7e && body[i + 1] === 0x3e) {
      to = i;
      break;
    }
  }

  let out = new Uint8Array(Math.min(Math.max(1024, to), cap));
  let length = 0;
  const room = (extra: number): void => {
    if (length + extra > cap) throw new PdfError("A stream in this PDF unpacks to more than a test bank could hold.");
    if (length + extra > out.length) {
      const bigger = new Uint8Array(Math.min(cap, Math.max(out.length * 2, length + extra)));
      bigger.set(out.subarray(0, length));
      out = bigger;
    }
  };
  const group = [0, 0, 0, 0, 0];
  let held = 0;
  const value = (): number => {
    let v = 0;
    for (const d of group) v = v * 85 + d;
    return v;
  };
  for (let i = from; i < to; i++) {
    const c = body[i] as number;
    if (c === 0x7a && held === 0) {
      // Four zero bytes. Nothing is written: everything past `length` in the array is zero, and stays so.
      room(4);
      length += 4;
      continue;
    }
    group[held++] = c - 33;
    if (held === 5) {
      const v = value();
      room(4);
      out[length++] = (v >>> 24) & 255;
      out[length++] = (v >>> 16) & 255;
      out[length++] = (v >>> 8) & 255;
      out[length++] = v & 255;
      held = 0;
    }
  }
  if (held > 1) {
    const count = held;
    while (held < 5) group[held++] = 84;
    const v = value();
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    room(count - 1);
    for (let k = 0; k < count - 1; k++) out[length++] = bytes[k] as number;
  }
  return out.slice(0, length);
}

export function runLength(data: Uint8Array, cap = MAX_STREAM_BYTES): Uint8Array {
  // The output is bytes in a growing typed array and the limit is looked at before a run is written. It was a plain array of numbers,
  // 8 bytes for each byte of output, checked after each run: 2 KB of runs of 128 made 2 GB of memory before the limit was reached, and
  // at 2.2 million runs it ended in "Invalid array length", words that mean nothing to the person who opened the file.
  let out = new Uint8Array(Math.min(Math.max(1024, data.length * 2), cap));
  let length = 0;
  const room = (extra: number): void => {
    if (length + extra > cap) throw new PdfError("A stream in this PDF unpacks to more than a test bank could hold.");
    if (length + extra > out.length) {
      const bigger = new Uint8Array(Math.min(cap, Math.max(out.length * 2, length + extra)));
      bigger.set(out.subarray(0, length));
      out = bigger;
    }
  };
  for (let i = 0; i < data.length; ) {
    const n = data[i++] as number;
    if (n === 128) break;
    if (n < 128) {
      const count = Math.min(n + 1, data.length - i);
      room(count);
      out.set(data.subarray(i, i + count), length);
      length += count;
      i += count;
    } else {
      const v = data[i++] as number;
      const count = 257 - n;
      room(count);
      out.fill(v, length, length + count);
      length += count;
    }
  }
  return out.slice(0, length);
}
