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

/** A page whose font has a ToUnicode map that is the word `begincodespacerange` repeated and never closed, `megabytes` long when unpacked. */
export function toUnicodePdf(megabytes: number): Buffer {
  const { parts } = basics();
  parts[3] = obj(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Contents 4 0 R >>");
  parts.push(obj(6, "<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [8 0 R] /ToUnicode 7 0 R >>"));
  const unit = "begincodespacerange ";
  const map = deflateSync(buffer(unit.repeat(Math.floor((megabytes * 1048576) / unit.length))), { level: 9 });
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
export function inChild(bytes: Uint8Array, body: string, timeoutMs = 20_000): ChildResult {
  const dir = mkdtempSync(join(tmpdir(), "openassess-hostile-"));
  try {
    const file = join(dir, "input.pdf");
    writeFileSync(file, bytes);
    const src = (path: string): string => new URL(`../../src/${path}`, import.meta.url).href;
    const script = `import { readFileSync } from "node:fs"; const bytes = new Uint8Array(readFileSync(process.argv[1])); const engine = (p) => import(${JSON.stringify(src(""))} + p);\n${body}`;
    const started = Date.now();
    const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script, file], { encoding: "utf8", timeout: timeoutMs });
    return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "", timedOut: run.error !== undefined, ms: Date.now() - started };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Reads a file as text pages in a child: the lines on each page and the notes the reader made. */
export function readTextInChild(bytes: Uint8Array, timeoutMs = 20_000): ChildResult & { lines?: string[][]; notes?: string[] } {
  const result = inChild(
    bytes,
    `const { readPdfText } = await engine("import/pdf/reader.ts"); try { const r = readPdfText(bytes); console.log(JSON.stringify({ lines: r.pages.map((p) => p.lines.map((l) => l.text)), notes: r.notes.map((n) => n.message) })); } catch (e) { console.log(JSON.stringify({ refused: String(e && e.message) })); }`,
    timeoutMs,
  );
  if (result.status !== 0 || result.timedOut) return result;
  return { ...result, ...(JSON.parse(result.stdout) as { lines?: string[][]; notes?: string[] }) };
}
