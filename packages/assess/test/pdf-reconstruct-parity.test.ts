/**
 * What a PDF whose objects are found by searching reads as, held to what the release before read from the same files.
 *
 * When the table of objects is lost, each object is read from where it begins. A fix for objects that never close ended each at the
 * start of the next one, found as text that looks like `N G obj`; a reader showed that a string, a comment or a piece of junk inside an
 * object holds that text too, and the object was cut there: a page dictionary with `(see 9 0 obj here)` before its `/Contents` lost its
 * contents, and the file that had read was refused as "probably a scan". 1,206 of 21,150 damaged files read differently, and none of the
 * tests said so, because none of them was held to what the release before read. This one is: `support/pdf-alpha21/` is the PDF reader
 * of that release, copied byte for byte, and these tests read the same files with both and compare every line, every note, and what the
 * importer makes of them. A difference is a change in what a file reads as, and has to be argued for.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PDF_PROFILE_ID } from "../src/import/pdf.ts";
import { assembleParagraphs } from "../src/import/pdf/paragraphs.ts";
import { readPdfText, type PdfText } from "../src/import/pdf/reader.ts";
import { standardTextImporter } from "../src/import/standard-text.ts";
import type { SourceBlock } from "../src/import/types.ts";
import { readPdfText as readPdfTextAlpha21 } from "./support/pdf-alpha21/reader.ts";
import { pdfShapes } from "./support/pdf-shapes.ts";
import { at, buildPdf, type FontSpec, type PdfSpec } from "./support/pdf-builder.ts";
import { hybridPdf, prefixedPdf, savedAgain, savedOnceMore, withTableLost } from "./support/pdf-revisions.ts";

type Read = (bytes: Uint8Array) => PdfText;

const ULID = /[0-9A-HJKMNP-TV-Z]{26}/g;

/** What a file read as: every line with its place, every note, or the words it was refused in. */
function lines(read: Read, bytes: Uint8Array): unknown {
  try {
    const r = read(bytes);
    return { pages: r.pages.map((p) => ({ number: p.number, height: p.height, lines: p.lines.map((l) => [l.text, Math.round(l.y * 100)]) })), notes: r.notes };
  } catch (error) {
    return { refused: `${(error as Error).name}: ${(error as Error).message}` };
  }
}

/** What the importer makes of the text a reader gave: its questions, their keys and findings, the orphans, and the file's findings. */
function imported(read: Read, bytes: Uint8Array): string {
  let text: PdfText;
  try {
    text = read(bytes);
  } catch (error) {
    return `refused ${(error as Error).message}`;
  }
  const { paragraphs } = assembleParagraphs(text.pages);
  const blocks: SourceBlock[] = paragraphs.map((p, index) => ({ index, text: p.text, kind: "paragraph" }));
  const result = standardTextImporter.parse(blocks, { profile: PDF_PROFILE_ID, file: "input.pdf", at: "2026-01-01T00:00:00.000Z", author: "test" });
  return JSON.stringify({ questions: result.questions, orphans: result.orphans, fileFindings: result.fileFindings, notes: text.notes }).replace(ULID, "ULID");
}

function same(name: string, bytes: Uint8Array): void {
  assert.deepEqual(lines(readPdfText, bytes), lines(readPdfTextAlpha21, bytes), `${name}: the lines and notes`);
  assert.equal(imported(readPdfText, bytes), imported(readPdfTextAlpha21, bytes), `${name}: the questions the importer makes`);
}

describe("the shapes of a file with no table of objects", () => {
  const shapes = pdfShapes();

  test("are 97 files from 31 shapes", () => {
    assert.equal(shapes.length, 97);
    assert.equal(new Set(shapes.map((s) => s.name.split("__")[0])).size, 31, "31 shapes, and one of them written four more ways");
  });

  for (const shape of shapes) {
    test(`${shape.name} reads as it did in the release before`, () => {
      same(shape.name, shape.bytes);
    });
  }

  // The five that were lost, said in words so that a failure of the comparison above has a name.
  for (const [name, expected] of [
    ["dict_string_before_contents__brk", "1. dict string"],
    ["catalog_string_before_pages__brk", "1. catalog string"],
    ["stream_dict_string__none", "1. stream dict string"],
    ["stream_dict_string_after_filter__notrailer", "1. stream dict string flate"],
    ["comment_in_dict__brk", "1. comment in dict"],
  ] as const) {
    test(`${name}: text that looks like the start of an object inside a string or a comment of an object does not end it`, () => {
      const shape = shapes.find((s) => s.name === name);
      assert.ok(shape);
      const page = readPdfText(shape.bytes).pages[0];
      assert.deepEqual(page?.lines.map((l) => l.text), [expected, "A. Option one", "B. Option two"]);
    });
  }
});

// ---------------------------------------------------------------------------
// Text that looks like the start of an object, put in at random places
// ---------------------------------------------------------------------------

/** A small generator, so that the same files are made each time. */
function generator(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("files whose table of objects is lost, with the start of an object put in at random", () => {
  const WIDTHS = Array.from({ length: 224 }, () => 500);
  const FONTS: Record<string, FontSpec> = {
    F1: { kind: "simple", base: "Helvetica", widths: WIDTHS },
    F2: { kind: "simple", base: "Helvetica-Bold", widths: WIDTHS },
    F3: { kind: "composite", base: "Test", codes: [[1, "O"], [2, "K"], [3, " "]], width: 500 },
  };
  const first = at(36, 740, 12, "1. What is 2+2?") + at(36, 726, 12, "A. Three") + at(36, 712, 12, "*B. Four", "F2") + at(36, 698, 12, "C. Five");
  const second = at(36, 740, 12, "2. Which is a colour?") + at(36, 726, 12, "A. Red") + at(36, 712, 12, "B. Run") + "BT /F3 12 Tf 36 698 Td <000100020003> Tj ET\n" + at(36, 640, 12, "Answers: 1 b, 2 a");
  const specs: Array<Partial<PdfSpec>> = [
    {},
    { compress: true },
    { compress: true, wrongLength: true },
    { crlf: true, compress: true },
    { modern: true },
    { modern: true, compress: true },
    { modern: true, compress: true, objectStreamOrder: "shuffled" },
    { damagedTable: true },
    { staleStartxref: true, compress: true },
    { image: true },
  ];
  const bases = specs.map((spec) => buildPdf({ fonts: FONTS, pages: [first, second], brokenStartxref: true, ...spec }));

  test("the files themselves, with no start put in, read as they did", () => {
    bases.forEach((bytes, i) => same(`base ${i}`, bytes));
  });

  // At a random place of a random file: a start by itself, one in a comment, one in a string, and one with the line ends of a Windows file.
  test("4,000 files, each with one put in, read as they did in the release before", () => {
    const random = generator(2026);
    const below = (n: number): number => Math.floor(random() * n);
    const KINDS = [(n: number, g: number) => ` ${n} ${g} obj `, (n: number, g: number) => `\n% ${n} ${g} obj\n`, (n: number, g: number) => `(see ${n} ${g} obj here)`, (n: number, g: number) => `\r\n${n} ${g} obj\r\n`];
    const differences: string[] = [];
    for (let round = 0; round < 4_000; round++) {
      const base = bases[below(bases.length)] as Uint8Array;
      const place = below(base.length + 1);
      const text = Buffer.from((KINDS[below(KINDS.length)] as (n: number, g: number) => string)(1 + below(14), below(2)), "latin1");
      const bytes = Buffer.concat([base.subarray(0, place), text, base.subarray(place)]);
      const now = JSON.stringify(lines(readPdfText, bytes));
      const then = JSON.stringify(lines(readPdfTextAlpha21, bytes));
      if (now !== then) differences.push(`${JSON.stringify(text.toString("latin1"))} at ${place} of base ${bases.indexOf(base)}`);
    }
    assert.deepEqual(differences.slice(0, 5), [], `${differences.length} of 4,000 differ`);
  });

  test("and 400 of them, through the importer as well, make the same questions, keys and findings", () => {
    const random = generator(7);
    const below = (n: number): number => Math.floor(random() * n);
    const differences: string[] = [];
    for (let round = 0; round < 400; round++) {
      const base = bases[below(bases.length)] as Uint8Array;
      const place = below(base.length + 1);
      const text = Buffer.from(` ${1 + below(14)} ${below(2)} obj `, "latin1");
      const bytes = Buffer.concat([base.subarray(0, place), text, base.subarray(place)]);
      if (imported(readPdfText, bytes) !== imported(readPdfTextAlpha21, bytes)) differences.push(`${JSON.stringify(text.toString("latin1"))} at ${place}`);
    }
    assert.deepEqual(differences.slice(0, 5), []);
  });
});

// ---------------------------------------------------------------------------
// Files whose table of objects is right
// ---------------------------------------------------------------------------

describe("files whose table of objects is right, which is bounded now by the next place the table lists", () => {
  const WIDTHS = Array.from({ length: 224 }, () => 500);
  const FONTS: Record<string, FontSpec> = { F1: { kind: "simple", base: "Helvetica", widths: WIDTHS }, F2: { kind: "simple", base: "Helvetica-Bold", widths: WIDTHS } };
  const page = at(36, 740, 12, "1. What is 2+2?") + at(36, 726, 12, "A. Three") + at(36, 712, 12, "*B. Four", "F2") + at(36, 698, 12, "C. Five");
  const specs: Array<Partial<PdfSpec>> = [{}, { compress: true }, { crlf: true }, { compress: true, wrongLength: true }, { modern: true }, { modern: true, compress: true }, { modern: true, compress: true, objectStreamOrder: "descending" }, { image: true }, { staleStartxref: true }];
  const bases = specs.map((spec) => Buffer.from(buildPdf({ fonts: FONTS, pages: [page, page], ...spec })));
  const saved = savedAgain("OLD", "NEW");

  test("read as they did: the builder's, a file saved again (and again), a hybrid file, and one with bytes in front of its header", () => {
    bases.forEach((bytes, i) => same(`base ${i}`, bytes));
    for (const [name, bytes] of [
      ["saved again", saved],
      ["saved three times", savedOnceMore(saved, "THREE")],
      ["saved again, its table lost", withTableLost(saved)],
      ["hybrid", hybridPdf()],
      ["with bytes in front", prefixedPdf()],
    ] as const) same(name, bytes);
  });

  // One entry of the table is moved a few bytes, so that it points into the object before it or into its own number: the bound of that
  // object is where the next entry says, and an object that runs past it is read again.
  test("and 3,000 of them with one entry of the table moved read as they did in the release before", () => {
    const random = generator(99);
    const below = (n: number): number => Math.floor(random() * n);
    const differences: string[] = [];
    const classic = [...bases.filter((_, i) => specs[i]?.modern !== true), saved, hybridPdf()];
    for (let round = 0; round < 3_000; round++) {
      const base = classic[below(classic.length)] as Buffer;
      const text = base.toString("latin1");
      const rows = [...text.matchAll(/(\d{10}) 00000 n /g)];
      if (rows.length === 0) continue;
      const row = rows[below(rows.length)] as RegExpMatchArray;
      const moved = Math.max(0, Number(row[1]) + ([-60, -9, -3, -1, 1, 2, 5, 17, 60] as const)[below(9)]!);
      const bytes = Buffer.from(text.slice(0, row.index) + String(moved).padStart(10, "0") + text.slice((row.index as number) + 10), "latin1");
      if (JSON.stringify(lines(readPdfText, bytes)) !== JSON.stringify(lines(readPdfTextAlpha21, bytes))) differences.push(`${row[1]} to ${moved} in file ${classic.indexOf(base)}`);
    }
    assert.deepEqual(differences.slice(0, 5), [], `${differences.length} of 3,000 differ`);
  });
});

// ---------------------------------------------------------------------------
// The real banks
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const folder = join(here, "..", "..", "..", "fixtures", "publisher", "pdf");
const present = existsSync(folder) && readdirSync(folder).some((n) => n.endsWith(".pdf"));

describe("the real PDF banks, when they are on this machine", () => {
  const skip = present ? false : "none there; the folder is git-ignored and local";

  test("read as they did in the release before, with their table of objects and with it lost", { skip }, () => {
    for (const name of readdirSync(folder).filter((n) => n.endsWith(".pdf"))) {
      const bytes = new Uint8Array(readFileSync(join(folder, name)));
      same(name, bytes);
      // The last start-of-table is made to point at nothing, so that the objects are found by searching. (The word is the same length.)
      const text = Buffer.from(bytes).toString("latin1");
      const at = text.lastIndexOf("startxref");
      if (at === -1) continue;
      const broken = Buffer.from(`${text.slice(0, at)}startxref\n99999999\n%%EOF\n`, "latin1");
      same(`${name} with its table lost`, broken);
    }
  });
});
