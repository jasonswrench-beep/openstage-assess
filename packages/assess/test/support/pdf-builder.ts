/**
 * Makes small PDFs for tests, in the shapes real ones come in.
 *
 * A PDF here is a list of pages, each the text of a content stream, with the fonts they use, and optionally a picture. It can be
 * written the old way (a table of objects at the end) or the way since PDF 1.5 (most objects packed and compressed in an object
 * stream, a stream for the table), and damaged on purpose, so that the reader is tried on both and on the failures. It is not a
 * PDF writer for anything else, and what it writes is not evidence about files that other programs wrote: the real banks in the
 * private fixtures folder are.
 */

import { deflateSync } from "node:zlib";

export interface FontSpec {
  /** `simple` is a Type1 or TrueType font with a one-byte code; `composite` is Type0 with two-byte codes and a ToUnicode map. */
  kind: "simple" | "composite";
  base: string;
  /** For a simple font: the encoding name. */
  encoding?: string;
  /** For a composite font: what code means which text (code, text), and the width of every code, which is how wide a space is. */
  codes?: Array<[number, string]>;
  width?: number;
  /** For a simple font: widths from the first code on (FirstChar is 32). */
  widths?: number[];
  /** Differences: code, glyph name. */
  differences?: Array<[number, string]>;
  /** For a simple font: a ToUnicode map by one-byte code, which the file's encoding must not override. */
  simpleMap?: Array<[number, string]>;
}

export interface PdfSpec {
  /** One content stream for each page. */
  pages: string[];
  fonts: Record<string, FontSpec>;
  /** A picture the pages can draw as /Im0. */
  image?: boolean;
  /** Pack objects into an object stream and write the table as a stream (PDF 1.5). */
  modern?: boolean;
  /** Compress content streams. */
  compress?: boolean;
  /** Write a table of objects that points nowhere, so that the reader has to look for them. (Only the table of the old way.) */
  damagedTable?: boolean;
  /**
   * Make the word `startxref` point at a place that is not a table, in a file of either way. The objects must then be found by searching,
   * and in a file of the modern way many of them are inside an object stream, which is found the same way and then opened.
   */
  brokenStartxref?: boolean;
  /** In a file of the modern way: the order the object stream lists its objects in, which has nothing to do with where they are. */
  objectStreamOrder?: "descending" | "shuffled";
  /** Say the file is encrypted. */
  encrypted?: boolean;
  mediaBox?: [number, number, number, number];
  /** An earlier copy of the word the end of the file is found by, as a file saved over and over has. */
  staleStartxref?: boolean;
  /** Cut this many bytes off the end of the first page's compressed content. */
  truncateContent?: number;
  /** Declare content streams a length that is wrong. */
  wrongLength?: boolean;
  /** Make this page's compressed content (counting from 0) something that is not compressed data at all. */
  badPage?: number;
  /** The text of a /DecodeParms dictionary for the compressed content of one page, given by `parmsPage` (counting from 0). */
  decodeParms?: string;
  parmsPage?: number;
  /**
   * Write `stream` and `endstream` with a carriage return and a line feed, as the programs that write the PDFs people are given do (all five
   * of the real banks do, and none of them writes a bare line feed). Nothing else in the builder wrote one, so the byte after the word
   * `stream` was always a line feed, and a reader that began the data one byte early on a CR LF was tested by nothing.
   */
  crlf?: boolean;
}

/** A place past the end of any file this builds. */
const BROKEN_STARTXREF = 99_999_999;

/** A line of text at a place: BT, the font, the place, the text, ET. */
export function at(x: number, y: number, size: number, text: string, font = "F1"): string {
  return `BT /${font} ${size} Tf ${x} ${y} Td (${text.replace(/[\\()]/g, (c) => `\\${c}`)}) Tj ET\n`;
}

/** A line of text in a composite font, as codes. */
export function atCodes(x: number, y: number, size: number, codes: number[], font: string): string {
  return `BT /${font} ${size} Tf ${x} ${y} Td <${codes.map((c) => c.toString(16).padStart(4, "0")).join("")}> Tj ET\n`;
}

/** The same string for every code, as a ToUnicode map. */
function toUnicode(codes: Array<[number, string]>, bytes = 2): string {
  const hex = (s: string): string => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(4, "0")).join("");
  return [
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
    `1 begincodespacerange <${"00".repeat(bytes)}> <${"ff".repeat(bytes)}> endcodespacerange`,
    `${codes.length} beginbfchar`,
    ...codes.map(([c, t]) => `<${c.toString(16).padStart(bytes * 2, "0")}> <${hex(t)}>`),
    "endbfchar endcmap end end",
  ].join("\n");
}

interface Obj {
  num: number;
  body: string | Buffer;
  /** A stream's dictionary text (without the Length) and its bytes. */
  stream?: { dict: string; data: Buffer; length?: number };
}

export function buildPdf(spec: PdfSpec): Uint8Array {
  const objects: Obj[] = [];
  const add = (body: string | Buffer, stream?: Obj["stream"]): number => {
    const num = objects.length + 1;
    objects.push({ num, body, ...(stream ? { stream } : {}) });
    return num;
  };
  const catalog = add("");
  const pagesRoot = add("");

  const fontRefs: Record<string, number> = {};
  for (const [name, f] of Object.entries(spec.fonts)) {
    if (f.kind === "simple") {
      const encoding = f.differences ? `/Encoding << /BaseEncoding /${f.encoding ?? "WinAnsiEncoding"} /Differences [${f.differences.map(([c, g]) => `${c} /${g}`).join(" ")}] >>` : `/Encoding /${f.encoding ?? "WinAnsiEncoding"}`;
      const widths = f.widths ? `/FirstChar 32 /LastChar ${31 + f.widths.length} /Widths [${f.widths.join(" ")}]` : "";
      const map = f.simpleMap ? add(Buffer.alloc(0), { dict: "", data: Buffer.from(toUnicode(f.simpleMap, 1), "latin1") }) : 0;
      fontRefs[name] = add(`<< /Type /Font /Subtype /Type1 /BaseFont /${f.base} ${encoding} ${widths}${map ? ` /ToUnicode ${map} 0 R` : ""} >>`);
    } else {
      const codes = f.codes ?? [];
      const map = add(Buffer.alloc(0), { dict: "", data: Buffer.from(toUnicode(codes), "latin1") });
      const descriptor = add(`<< /Type /FontDescriptor /FontName /${f.base} /Flags 4 /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 /FontBBox [0 -200 1000 900] >>`);
      const widthArray = `[${codes.map(([c]) => `${c} [${f.width ?? 500}]`).join(" ")}]`;
      const cid = add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${f.base} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /DW 1000 /W ${widthArray} >>`);
      fontRefs[name] = add(`<< /Type /Font /Subtype /Type0 /BaseFont /${f.base} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${map} 0 R >>`);
    }
  }
  const imageRef = spec.image ? add(Buffer.alloc(0), { dict: "/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8", data: Buffer.from([0, 255, 255, 0]) }) : 0;

  const resources = `<< /Font << ${Object.entries(fontRefs).map(([n, r]) => `/${n} ${r} 0 R`).join(" ")} >>${imageRef ? ` /XObject << /Im0 ${imageRef} 0 R >>` : ""} >>`;
  const pageRefs: number[] = [];
  const box = spec.mediaBox ?? [0, 0, 612, 792];
  for (const [index, content] of spec.pages.entries()) {
    let data = spec.compress ? deflateSync(Buffer.from(content, "latin1")) : Buffer.from(content, "latin1");
    if (spec.truncateContent && index === 0) data = data.subarray(0, data.length - spec.truncateContent);
    if (spec.badPage === index) data = Buffer.from("this is not compressed data at all, whatever the dictionary says");
    const parms = spec.decodeParms !== undefined && spec.parmsPage === index ? ` /DecodeParms ${spec.decodeParms}` : "";
    const stream = add(Buffer.alloc(0), { dict: spec.compress || spec.badPage === index ? `/Filter /FlateDecode${parms}` : "", data, ...(spec.wrongLength ? { length: 3 } : {}) });
    pageRefs.push(add(`<< /Type /Page /Parent ${pagesRoot} 0 R /MediaBox [${box.join(" ")}] /Resources ${resources} /Contents ${stream} 0 R >>`));
  }
  (objects[catalog - 1] as Obj).body = `<< /Type /Catalog /Pages ${pagesRoot} 0 R >>`;
  (objects[pagesRoot - 1] as Obj).body = `<< /Type /Pages /Kids [${pageRefs.map((r) => `${r} 0 R`).join(" ")}] /Count ${pageRefs.length} >>`;

  const chunks: Buffer[] = [Buffer.from(`%PDF-${spec.modern ? "1.5" : "1.4"}\n%âãÏÓ\n`, "latin1")];
  if (spec.staleStartxref) chunks.push(Buffer.from("%startxref\n7\n%%EOF\n", "latin1"));
  let size = chunks.reduce((n, c) => n + c.length, 0);
  const offsets = new Map<number, number>();
  const write = (buf: Buffer): void => {
    chunks.push(buf);
    size += buf.length;
  };
  const eol = spec.crlf ? "\r\n" : "\n";
  const writeObject = (o: Obj): void => {
    offsets.set(o.num, size);
    if (o.stream) {
      write(Buffer.from(`${o.num} 0 obj\n<< ${o.stream.dict} /Length ${o.stream.length ?? o.stream.data.length} >>\nstream${eol}`, "latin1"));
      write(o.stream.data);
      write(Buffer.from(`${eol}endstream\nendobj\n`, "latin1"));
    } else write(Buffer.concat([Buffer.from(`${o.num} 0 obj\n`, "latin1"), Buffer.isBuffer(o.body) ? o.body : Buffer.from(o.body, "latin1"), Buffer.from("\nendobj\n", "latin1")]));
  };

  const trailerExtra = spec.encrypted ? " /Encrypt << /Filter /Standard /V 1 /R 2 >>" : "";
  if (!spec.modern) {
    for (const o of objects) writeObject(o);
    const xrefAt = size;
    const rows = ["0000000000 65535 f "];
    for (const o of objects) rows.push(`${String(spec.damagedTable ? 9 : offsets.get(o.num)).padStart(10, "0")} 00000 n `);
    write(Buffer.from(`xref\n0 ${objects.length + 1}\n${rows.join("\n")}\ntrailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R${trailerExtra} >>\nstartxref\n${spec.damagedTable ? 12345 : spec.brokenStartxref ? BROKEN_STARTXREF : xrefAt}\n%%EOF\n`, "latin1"));
  } else {
    // Streams stay as they are; every other object goes in one object stream.
    const packed = objects.filter((o) => !o.stream);
    const loose = objects.filter((o) => o.stream);
    for (const o of loose) writeObject(o);
    const pairs = packed.map((o, i) => `${o.num} ${i === 0 ? 0 : packed.slice(0, i).reduce((n, p) => n + Buffer.byteLength(String(p.body)) + 1, 0)}`);
    // The header may list the objects in any order: where each begins is what it says, and the bodies stay where they are.
    if (spec.objectStreamOrder === "descending") pairs.reverse();
    else if (spec.objectStreamOrder === "shuffled") pairs.splice(0, pairs.length, ...pairs.filter((_, i) => i % 2 === 1).reverse(), ...pairs.filter((_, i) => i % 2 === 0));
    const head = pairs.join(" ");
    const bodies = packed.map((o) => String(o.body)).join("\n");
    const first = head.length + 1;
    const stmNum = objects.length + 1;
    offsets.set(stmNum, size);
    const data = deflateSync(Buffer.from(`${head}\n${bodies}`, "latin1"));
    write(Buffer.from(`${stmNum} 0 obj\n<< /Type /ObjStm /N ${packed.length} /First ${first} /Filter /FlateDecode /Length ${data.length} >>\nstream${eol}`, "latin1"));
    write(data);
    write(Buffer.from(`${eol}endstream\nendobj\n`, "latin1"));
    const xrefNum = stmNum + 1;
    const xrefAt = size;
    offsets.set(xrefNum, xrefAt);
    const entries: number[][] = [];
    for (let n = 0; n <= xrefNum; n++) {
      if (n === 0) entries.push([0, 0, 255]);
      else if (n === xrefNum) entries.push([1, xrefAt, 0]);
      else if (n === stmNum) entries.push([1, offsets.get(n) as number, 0]);
      else if (packed.some((p) => p.num === n)) entries.push([2, stmNum, packed.findIndex((p) => p.num === n)]);
      else entries.push([1, offsets.get(n) as number, 0]);
    }
    const raw = Buffer.alloc(entries.length * 6);
    entries.forEach(([t, a, b], i) => {
      raw[i * 6] = t as number;
      raw.writeUInt32BE(a as number, i * 6 + 1);
      raw[i * 6 + 5] = b as number;
    });
    const packedXref = deflateSync(raw);
    write(Buffer.from(`${xrefNum} 0 obj\n<< /Type /XRef /Size ${xrefNum + 1} /W [1 4 1] /Root ${catalog} 0 R${trailerExtra} /Filter /FlateDecode /Length ${packedXref.length} >>\nstream${eol}`, "latin1"));
    write(packedXref);
    write(Buffer.from(`${eol}endstream\nendobj\nstartxref\n${spec.brokenStartxref ? BROKEN_STARTXREF : xrefAt}\n%%EOF\n`, "latin1"));
  }
  return new Uint8Array(Buffer.concat(chunks));
}
