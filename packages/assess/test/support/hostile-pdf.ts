/**
 * PDFs written by hand to be as small as possible and as expensive as possible to read, and a way to read one in a process of its own
 * under a time limit. They are the files that readers of the PDF reader built to find what no damaged-file run reaches, because each
 * needs one number, or one repeated word, to be exactly wrong. A return of any of these faults fails a test here and does not hold
 * every test after it.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const buffer = (s: string | Buffer): Buffer => (Buffer.isBuffer(s) ? s : Buffer.from(s, "latin1"));

const CONTENT = "BT /F1 12 Tf 72 700 Td (Hello) Tj ET";

/** `N 0 obj ... endobj` for a dictionary or any other body. */
const obj = (num: number, body: string): Buffer => buffer(`${num} 0 obj\n${body}\nendobj\n`);

/** A stream object: its dictionary entries (without /Length) and its bytes. */
const streamObj = (num: number, dict: string, data: Buffer): Buffer =>
  Buffer.concat([buffer(`${num} 0 obj\n<< ${dict} /Length ${data.length} >>\nstream\n`), data, buffer("\nendstream\nendobj\n")]);

/** The pieces of a small PDF with one page that says Hello in Helvetica, ready for a hostile object to be added. */
function basics(): { parts: Buffer[]; size: () => number } {
  const parts: Buffer[] = [
    buffer("%PDF-1.5\n"),
    obj(1, "<< /Type /Catalog /Pages 2 0 R >>"),
    obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    obj(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"),
    streamObj(4, "", buffer(CONTENT)),
    obj(5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
  ];
  return { parts, size: () => parts.reduce((n, p) => n + p.length, 0) };
}

/**
 * A page that reads fine, with a cross-reference STREAM whose /W and /Index are the given text, pointed at by startxref. The reader
 * should refuse such a table in words and find the objects by searching.
 */
export function xrefStreamPdf(w: string, index: string): Buffer {
  const { parts, size } = basics();
  const at = size();
  parts.push(streamObj(6, `/Type /XRef /Size 7 /W ${w} /Index ${index} /Root 1 0 R`, buffer("AAAA")));
  parts.push(buffer(`startxref\n${at}\n%%EOF\n`));
  return Buffer.concat(parts);
}

/** A page whose Type0 font keeps its description in an object stream, with a /W array of `ranges` ranges of 70,000 codes each. */
export function fontWidthsPdf(ranges: number): Buffer {
  const { parts } = basics();
  parts[3] = obj(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Contents 4 0 R >>");
  parts.push(obj(6, "<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [8 0 R] >>"));
  const inner = `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X /DW 1000 /W [${"0 69999 500 ".repeat(ranges)}] >>`;
  const header = "8 0 ";
  parts.push(streamObj(7, `/Type /ObjStm /N 1 /First ${header.length} /Filter /FlateDecode`, deflateSync(buffer(header + inner), { level: 9 })));
  parts.push(buffer("trailer\n<< /Root 1 0 R /Size 9 >>\n%%EOF\n"));
  return Buffer.concat(parts);
}

/**
 * A page whose font has a ToUnicode map that is the word `begincodespacerange` repeated, `megabytes` long when unpacked. It is never
 * closed, or (`closed`) closed once at the very end, which is the other shape that a search for the end of each block can be slow on.
 */
export function toUnicodePdf(megabytes: number, closed = false): Buffer {
  const { parts } = basics();
  parts[3] = obj(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Contents 4 0 R >>");
  parts.push(obj(6, "<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [8 0 R] /ToUnicode 7 0 R >>"));
  const unit = "begincodespacerange ";
  const map = deflateSync(buffer(unit.repeat(Math.floor((megabytes * 1048576) / unit.length)) + (closed ? "endcodespacerange" : "")), { level: 9 });
  parts.push(streamObj(7, "/Filter /FlateDecode", map));
  parts.push(obj(8, "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X /DW 1000 >>"));
  parts.push(buffer("trailer\n<< /Root 1 0 R /Size 9 >>\n%%EOF\n"));
  return Buffer.concat(parts);
}

/**
 * An object stream of `count` objects that all begin at the same place, where an array that never closes runs on for `tokens` numbers,
 * in a file with no table of objects (so that the stream is found and opened by searching).
 */
export function objectStreamPdf(count: number, tokens: number, spread = false): Buffer {
  const { parts } = basics();
  parts[3] = obj(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>");
  let header = "";
  let body = "";
  for (let i = 0; i < count; i++) {
    // Together: every object begins at the same place. Spread: each begins where the one before it should have ended, and the page
    // tree lists every one of them, so that all of them are asked for.
    header += `${20 + i} ${spread ? body.length : 0} `;
    if (spread) body += `[ ${"1 ".repeat(tokens)}`;
  }
  if (spread) parts[2] = obj(2, `<< /Type /Pages /Kids [3 0 R ${Array.from({ length: count }, (_, i) => `${20 + i} 0 R`).join(" ")}] /Count 1 >>`);
  const data = `${header}${spread ? body : `[ ${"1 ".repeat(tokens)}`}`;
  parts.push(streamObj(7, `/Type /ObjStm /N ${count} /First ${header.length} /Filter /FlateDecode`, deflateSync(buffer(data), { level: 9 })));
  parts.push(buffer("trailer\n<< /Root 1 0 R /Size 8 >>\n%%EOF\n"));
  return Buffer.concat(parts);
}

export interface ChildResult {
  /** The status the child ended with; null when it was killed for taking too long. */
  status: number | null;
  stdout: string;
  stderr: string;
  /** The child was stopped by the time limit. */
  timedOut: boolean;
  ms: number;
}

/**
 * Runs `body` (module code that can use `bytes`, a Uint8Array of the file, and imports of the engine by `engine("path")`) in a node
 * process of its own with a time limit, so that a reader that never returns is a failed test and not a frozen one.
 */
export function inChild(bytes: Uint8Array, body: string, timeoutMs = 20_000, nodeArgs: readonly string[] = []): ChildResult {
  const dir = mkdtempSync(join(tmpdir(), "openassess-hostile-"));
  try {
    const file = join(dir, "input.pdf");
    writeFileSync(file, bytes);
    const src = (path: string): string => new URL(`../../src/${path}`, import.meta.url).href;
    const script = `import { readFileSync } from "node:fs"; const bytes = new Uint8Array(readFileSync(process.argv[1])); const engine = (p) => import(${JSON.stringify(src(""))} + p);\n${body}`;
    const started = Date.now();
    const run = spawnSync(process.execPath, [...nodeArgs, "--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script, file], { encoding: "utf8", timeout: timeoutMs });
    return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "", timedOut: run.error !== undefined, ms: Date.now() - started };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The heap the child may have, in megabytes: a fault that makes a number array of millions of entries ends the process at once. */
export const heapOf = (megabytes: number): string[] => [`--max-old-space-size=${megabytes}`];

/**
 * Reads a file as text pages in a child: the lines on each page and the notes the reader made. A file the reader refuses gives
 * `refused` with the words, and `refusedBy` with the name of the error class, so that "a PdfError in words" can be told from a RangeError.
 */
export function readTextInChild(bytes: Uint8Array, timeoutMs = 20_000, nodeArgs: readonly string[] = []): ChildResult & { lines?: string[][]; notes?: string[]; refused?: string; refusedBy?: string } {
  const result = inChild(
    bytes,
    `const { readPdfText } = await engine("import/pdf/reader.ts"); try { const r = readPdfText(bytes); console.log(JSON.stringify({ lines: r.pages.map((p) => p.lines.map((l) => l.text)), notes: r.notes.map((n) => n.message) })); } catch (e) { console.log(JSON.stringify({ refused: String(e && e.message), refusedBy: String(e && e.name) })); }`,
    timeoutMs,
    nodeArgs,
  );
  if (result.status !== 0 || result.timedOut) return result;
  return { ...result, ...(JSON.parse(result.stdout) as { lines?: string[][]; notes?: string[]; refused?: string; refusedBy?: string }) };
}

// ---------------------------------------------------------------------------
// Files put together from pieces
// ---------------------------------------------------------------------------

/** One piece of a file: an object (a body, or a dictionary and the bytes of a stream), or text that is not an object at all. */
export type Piece = { num: number; body: string } | { num: number; dict: string; data: Buffer } | { raw: string | Buffer };

/**
 * A file made of pieces. It ends in a table of objects that is right (`table`), in a trailer and no table (`trailer`, so that the
 * objects are found by searching), or in nothing.
 */
export function assemble(pieces: readonly Piece[], tail: "table" | "trailer" | "none" = "table"): Buffer {
  const parts: Buffer[] = [buffer("%PDF-1.5\n")];
  let size = parts[0]!.length;
  const offsets = new Map<number, number>();
  for (const piece of pieces) {
    let chunk: Buffer;
    if ("raw" in piece) chunk = buffer(piece.raw);
    else {
      offsets.set(piece.num, size);
      chunk = "data" in piece ? streamObj(piece.num, piece.dict, piece.data) : obj(piece.num, piece.body);
    }
    parts.push(chunk);
    size += chunk.length;
  }
  if (tail === "table") {
    const count = Math.max(...offsets.keys()) + 1;
    let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (let n = 1; n < count; n++) table += offsets.has(n) ? `${String(offsets.get(n)).padStart(10, "0")} 00000 n \n` : "0000000000 65535 f \n";
    parts.push(buffer(`${table}trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`));
  } else if (tail === "trailer") parts.push(buffer("trailer\n<< /Root 1 0 R /Size 99 >>\n%%EOF\n"));
  return Buffer.concat(parts);
}

/** The five objects of a page that says Hello, with the content stream given (by default plain, saying Hello). */
export function helloPieces(content: Buffer = buffer(CONTENT), contentDict = ""): Piece[] {
  return [
    { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { num: 2, body: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
    { num: 3, body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>" },
    { num: 4, dict: contentDict, data: content },
    { num: 5, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
  ];
}

/** A page whose content stream is the given text, compressed. */
export function contentPdf(content: string | Buffer, tail: "table" | "trailer" | "none" = "table"): Buffer {
  return assemble(helloPieces(deflateSync(buffer(content), { level: 9 }), "/Filter /FlateDecode"), tail);
}

/** A file of two pages, the first with the content given, the second saying Hello. */
export function twoPagePdf(first: string | Buffer): Buffer {
  const pieces = helloPieces(deflateSync(buffer(first), { level: 9 }), "/Filter /FlateDecode");
  pieces[1] = { num: 2, body: "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>" };
  pieces.push({ num: 6, body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>" });
  pieces.push({ num: 7, dict: "", data: buffer(CONTENT) });
  return assemble(pieces);
}

/** Where `[` repeated `depth` times is put: the trailer, the catalog, the page tree, or the page. */
export function deepNestPdf(where: "trailer" | "catalog" | "pages" | "page", depth: number): Buffer {
  const open = "[".repeat(depth);
  const pieces = helloPieces();
  if (where === "catalog") pieces[0] = { num: 1, body: open };
  if (where === "pages") pieces[1] = { num: 2, body: `<< /Type /Pages /Kids [3 0 R] /Count 1 /Z ${open} >>` };
  if (where === "page") pieces[2] = { num: 3, body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R /Z ${open} >>` };
  if (where === "trailer") return Buffer.concat([assemble(pieces, "none"), buffer(`trailer\n<< /Root 1 0 R /Z ${open} >>\n%%EOF\n`)]);
  return assemble(pieces, "trailer");
}

/** A page that reads, and after its trailer `count` things that never close: objects that are an open array, or `trailer << `. */
export function unterminatedPdf(kind: "objects" | "trailers", count: number): Buffer {
  const junk = kind === "objects" ? Array.from({ length: count }, (_, i) => `${100 + i} 0 obj [ `).join("") : "trailer << ".repeat(count);
  return Buffer.concat([assemble(helloPieces(), "trailer"), buffer(junk)]);
}

/**
 * A page that reads, and after its trailer `count` objects that say `stream` and are followed by no `endstream` (or, `closed`, by one at
 * the very end of the file), so that each looks for the end of its data in the rest of the file.
 */
export function unendedStreamsPdf(count: number, closed: boolean): Buffer {
  const junk = Array.from({ length: count }, (_, i) => `${100 + i} 0 obj << >> stream\n`).join("");
  return Buffer.concat([assemble(helloPieces(), "trailer"), buffer(junk), buffer(closed ? "\nendstream\n" : "")]);
}

/** A fixed-size, deterministic row of a cross-reference stream: a type, an offset (or an object stream), and a generation (or an index). */
function packed(rows: ReadonlyArray<readonly [number, number, number]>, widths: readonly [number, number, number]): Buffer {
  const out = Buffer.alloc(rows.length * (widths[0] + widths[1] + widths[2]));
  let at = 0;
  for (const row of rows) {
    row.forEach((value, field) => {
      const width = widths[field] as number;
      for (let k = width - 1; k >= 0; k--) out[at++] = Math.floor(value / 256 ** k) & 255;
    });
  }
  return out;
}

/**
 * A file whose table of objects is a stream that is right about every object, so that it is believed and no note is made, except
 * that the dictionary says `/W` and `/Index` as given: text that is a fraction, a negative number, or a width no writer uses, and that
 * the reader must not believe. `dummyRows` rows of free entries come first, for an index that starts below 0.
 */
export function tableStreamPdf(wText: string, indexText: string, rowWidths: readonly [number, number, number] = [1, 2, 1], dummyRows = 0): Buffer {
  const { parts, size } = basics();
  const start = size();
  const offsets = [0];
  let at = parts[0]!.length;
  for (let n = 1; n <= 5; n++) {
    offsets[n] = at;
    at += parts[n]!.length;
  }
  const rows: Array<[number, number, number]> = [];
  for (let i = 0; i < dummyRows; i++) rows.push([0, 0, 0]);
  rows.push([0, 0, 255]);
  for (let n = 1; n <= 5; n++) rows.push([1, offsets[n] as number, 0]);
  rows.push([1, start, 0]);
  parts.push(streamObj(6, `/Type /XRef /Size 7 /W ${wText} /Index ${indexText} /Root 1 0 R`, packed(rows, rowWidths)));
  parts.push(buffer(`startxref\n${start}\n%%EOF\n`));
  return Buffer.concat(parts);
}

/**
 * A table of objects that is a stream of `rows` entries, the first seven right and the rest free (type 0), so that it is believed when
 * it is believed at all. The data is packed twice over, so that a million rows are a few hundred bytes of file.
 */
export function longTablePdf(rows: number): Buffer {
  const { parts, size } = basics();
  const offsets = [0];
  let at = parts[0]!.length;
  for (let n = 1; n <= 5; n++) {
    offsets[n] = at;
    at += parts[n]!.length;
  }
  const start = size();
  const real: Array<[number, number, number]> = [[0, 0, 255]];
  for (let n = 1; n <= 5; n++) real.push([1, offsets[n] as number, 0]);
  real.push([1, start, 0]);
  const data = Buffer.concat([packed(real, [1, 2, 1]), Buffer.alloc((rows - real.length) * 4)]);
  const twice = deflateSync(deflateSync(data, { level: 9 }), { level: 9 });
  parts.push(streamObj(6, `/Type /XRef /Size ${rows} /W [1 2 1] /Index [0 ${rows}] /Root 1 0 R /Filter [/FlateDecode /FlateDecode]`, twice));
  parts.push(buffer(`startxref\n${start}\n%%EOF\n`));
  return Buffer.concat(parts);
}

/** A table of objects that is `rows` one-byte entries of 1, in a file of a few hundred bytes. Believed, it makes an entry for each. */
export function tableBombPdf(rows: number): Buffer {
  const { parts, size } = basics();
  const start = size();
  const twice = deflateSync(deflateSync(Buffer.alloc(rows, 1), { level: 9 }), { level: 9 });
  parts.push(streamObj(6, `/Type /XRef /Size ${rows} /W [1 0 0] /Index [0 ${rows}] /Root 1 0 R /Filter [/FlateDecode /FlateDecode]`, twice));
  parts.push(buffer(`startxref\n${start}\n%%EOF\n`));
  return Buffer.concat(parts);
}

const WIDE_RANGES = Array.from({ length: 6 }, (_, k) => `${k * 70000} ${k * 70000 + 69999} 500`).join(" ");

/**
 * A page that selects `fonts` Type0 fonts one after the other and shows a glyph in each. All of them name one descendant font,
 * or (`distinct`) one each, and the /W of every descendant sets 420,000 widths.
 */
export function manyFontsPdf(fonts: number, distinct: boolean): Buffer {
  const pieces: Piece[] = [
    { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { num: 2, body: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
    { num: 3, body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << ${Array.from({ length: fonts }, (_, i) => `/F${i} ${100 + i} 0 R`).join(" ")} >> >> /Contents 4 0 R >>` },
    { num: 4, dict: "", data: buffer(`BT\n${Array.from({ length: fonts }, (_, i) => `/F${i} 12 Tf <0041> Tj`).join("\n")}\nET`) },
  ];
  if (!distinct) pieces.push({ num: 5, body: `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X /DW 1000 /W [${WIDE_RANGES}] >>` });
  for (let i = 0; i < fonts; i++) {
    if (distinct) pieces.push({ num: 1000 + i, body: `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X /DW 1000 /W [${WIDE_RANGES}] >>` });
    pieces.push({ num: 100 + i, body: `<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [${distinct ? 1000 + i : 5} 0 R] >>` });
  }
  return assemble(pieces);
}

/** A page whose content is packed with the filters Flate, Flate and ASCII85, and is `inner` characters of "!" (zeros) then a line that says Hello. */
export function ascii85Pdf(inner: number): Buffer {
  const hello = encodeAscii85(buffer(`\n${CONTENT}`));
  // A multiple of five, so that every group is whole and the line that says Hello begins on a group.
  const packedOnce = deflateSync(Buffer.concat([Buffer.alloc(inner - (inner % 5), 0x21), hello]), { level: 9 });
  return assemble(helloPieces(deflateSync(packedOnce, { level: 9 }), "/Filter [/FlateDecode /FlateDecode /ASCII85Decode]"));
}

/** Bytes as ASCII85, with a multiple of four in front so that no group is partial, and the end mark. */
export function encodeAscii85(data: Buffer): Buffer {
  const padded = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4, 0x20)]);
  let out = "";
  for (let i = 0; i < padded.length; i += 4) {
    let v = padded.readUInt32BE(i);
    const digits: string[] = [];
    for (let k = 0; k < 5; k++) {
      digits.unshift(String.fromCharCode((v % 85) + 33));
      v = Math.floor(v / 85);
    }
    out += digits.join("");
  }
  return buffer(`${out}~>`);
}
