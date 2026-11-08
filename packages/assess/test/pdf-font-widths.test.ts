/**
 * The widths of a font, and what a wrong width does to a page.
 *
 * Whether a gap between two pieces of a line is a space is told by how wide the gap is against the width of the piece before it, so a
 * font whose widths are not read puts no space between words that a program placed one by one. A budget of a million widths for the
 * whole document, set to stop a file of 3 KB from asking for 700 MB, took the widths from the sixteenth font that had 65,536 of them and
 * left them at the default, and a question set in the seventeenth became an essay, or went, with nothing said that widths had run out.
 * Widths are now kept as ranges and looked up by search, so that nothing is made for each code a range names and there is no budget.
 * The reading of overlapping, out-of-order and wrong entries is held to the Map that it replaced (`support/pdf-alpha21/fonts.ts`).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { pdfImporter } from "../src/import/pdf.ts";
import { PdfDocument } from "../src/import/pdf/document.ts";
import { loadFont } from "../src/import/pdf/fonts.ts";
import { readPdfText } from "../src/import/pdf/reader.ts";
import { PdfDocument as PdfDocumentAlpha21 } from "./support/pdf-alpha21/document.ts";
import { loadFont as loadFontAlpha21 } from "./support/pdf-alpha21/fonts.ts";
import { assemble, buffer, heapOf, inChild, readTextInChild, type Piece } from "./support/hostile-pdf.ts";

// ---------------------------------------------------------------------------
// A document of many fonts, each as wide as a font can be
// ---------------------------------------------------------------------------

const CHARS = " 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.)(?+:*,-";
const MAP =
  "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /X def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange " +
  `${CHARS.length} beginbfchar\n${[...CHARS].map((c, i) => `<${(i + 1).toString(16).padStart(4, "0")}> <${c.charCodeAt(0).toString(16).padStart(4, "0")}>`).join("\n")}\n` +
  "endbfchar endcmap CMapName currentdict /CMap defineresource pop end end";
const hex = (text: string): string => `<${[...text].map((c) => (CHARS.indexOf(c) + 1).toString(16).padStart(4, "0")).join("")}>`;

/**
 * A page of one-page documents' worth of Type0 fonts, each with a description of its own whose /W gives all 65,536 codes the width 500,
 * and each used for the pieces of a line: `fillers` fonts that set a line each, and then `questionFonts` that set the question, every
 * label and every word a piece of its own, a word space (0.3 of the size) between the end of a piece and the next. If a font's widths
 * are missing the pieces are placed as if every glyph were as wide as the default, 1000, and the gap to the next is negative: no space.
 */
function fontsPdf(fillers: number, questionFonts = 0): Buffer {
  const total = fillers + questionFonts;
  const pieces: Piece[] = [
    { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { num: 2, body: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
    { num: 10, dict: "", data: buffer(MAP) },
  ];
  let fontResources = "";
  for (let i = 0; i < total; i++) {
    const [font, descendant, descriptor] = [11 + i * 3, 12 + i * 3, 13 + i * 3];
    pieces.push({ num: font, body: `<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+Font${i} /Encoding /Identity-H /DescendantFonts [${descendant} 0 R] /ToUnicode 10 0 R >>` });
    pieces.push({
      num: descendant,
      body: `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAA+Font${i} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /DW 1000 /W [0 65535 500] >>`,
    });
    pieces.push({ num: descriptor, body: `<< /Type /FontDescriptor /FontName /AAAAAA+Font${i} /Flags 4 >>` });
    fontResources += `/F${i} ${font} 0 R `;
  }
  const size = 12;
  let content = "";
  let y = 760;
  for (let i = 0; i < fillers; i++, y -= 14) content += `BT /F${i} ${size} Tf 72 ${y} Td ${hex(`filler line ${i}`)} Tj ET\n`;
  const line = (font: number, parts: string[]): void => {
    let x = 72;
    for (const part of parts) {
      content += `BT /F${font} ${size} Tf ${x} ${y} Td ${hex(part)} Tj ET\n`;
      x += part.length * 0.5 * size + 0.3 * size;
    }
    y -= 20;
  };
  if (questionFonts > 0) {
    const f = (k: number): number => fillers + Math.min(k, questionFonts - 1);
    line(f(0), ["1.", "What", "is", "2+2?"]);
    line(f(1), ["a)", "Three"]);
    line(f(2), ["b)", "Four"]);
    line(f(3), ["c)", "Five"]);
    line(f(0), ["Answer:", "b"]);
  }
  pieces.push({ num: 3, body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << ${fontResources} >> >> /Contents 4 0 R >>` });
  pieces.push({ num: 4, dict: "", data: buffer(content) });
  return assemble(pieces);
}

describe("a document with many fonts that each have all 65,536 widths", () => {
  // Every font sets "A." and "Three" as two pieces 0.3 of the size apart; the gap is a space if the font's width for its glyphs is read.
  const twoPieces = (fonts: number): Buffer => {
    const pieces: Piece[] = [
      { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
      { num: 2, body: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
      { num: 10, dict: "", data: buffer(MAP) },
    ];
    let resources = "";
    let content = "";
    for (let i = 0; i < fonts; i++) {
      pieces.push({ num: 11 + i * 3, body: `<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+Font${i} /Encoding /Identity-H /DescendantFonts [${12 + i * 3} 0 R] /ToUnicode 10 0 R >>` });
      pieces.push({ num: 12 + i * 3, body: `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAA+Font${i} /DW 1000 /W [0 65535 500] >>` });
      resources += `/F${i} ${11 + i * 3} 0 R `;
      const y = 750 - i * 14;
      content += `BT /F${i} 12 Tf 72 ${y} Td ${hex("A.")} Tj ET\nBT /F${i} 12 Tf ${72 + 12 + 3.6} ${y} Td ${hex("Three")} Tj ET\n`;
    }
    pieces.push({ num: 3, body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << ${resources} >> >> /Contents 4 0 R >>` });
    pieces.push({ num: 4, dict: "", data: buffer(content) });
    return assemble(pieces);
  };

  for (const fonts of [1, 15, 16, 17, 20, 40]) {
    test(`reads every one of ${fonts} with its widths, so that the gap in each line is a space`, () => {
      const lines = readPdfText(twoPieces(fonts)).pages[0]?.lines.map((l) => l.text);
      assert.deepEqual(lines, Array.from({ length: fonts }, () => "A. Three"));
    });
  }

  // The fifteenth filler font and the sixteenth and seventeenth: the question was an essay with the options in its stem, and then no question.
  for (const fillers of [0, 15, 16, 17, 30]) {
    test(`reads a question set in the fonts after ${fillers} others as a multiple choice question with its key`, () => {
      const bytes = fontsPdf(fillers, 4);
      const lines = readPdfText(bytes).pages[0]?.lines.map((l) => l.text);
      assert.deepEqual(lines?.slice(fillers), ["1. What is 2+2?", "a) Three", "b) Four", "c) Five", "Answer: b"]);
      const result = pdfImporter.parseBytes(bytes, { file: "bank.pdf", at: "2026-01-01T00:00:00.000Z", author: "test" });
      const choices = result.questions.filter((q) => q.type === "multipleChoice");
      assert.equal(choices.length, 1, "the question is one multiple choice question, and not an essay with its options in the stem");
      const options = (choices[0]?.body as unknown as { options: Array<{ correct: boolean }> }).options;
      assert.deepEqual(options.map((o) => o.correct), [false, true, false]);
    });
  }
});

// ---------------------------------------------------------------------------
// Overlapping entries
// ---------------------------------------------------------------------------

/** A file whose object 11 is a Type0 font with a description (object 10) that has the given /W text. */
function fontPdf(w: string): Buffer {
  return assemble([
    { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { num: 2, body: "<< /Type /Pages /Kids [] /Count 0 >>" },
    { num: 10, body: `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X /DW 1000 /W [${w}] >>` },
    { num: 11, body: "<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [10 0 R] >>" },
  ]);
}

/** A font whose description has the given /W text, and the widths of codes it gives (two-byte codes). */
function widthsFor(w: string, codes: number[]): number[] {
  const doc = new PdfDocument(fontPdf(w));
  const font = loadFont(doc, doc.get(11));
  return font.decode(Uint8Array.from(codes.flatMap((c) => [c >> 8, c & 255]))).map((g) => g.width);
}

describe("the widths of entries that overlap or stand out of order", () => {
  const codes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

  test("a later entry wins over an earlier one for a code that both name, whether it is an array or a range", () => {
    // 0..9 are 100; the array sets 5, 6 and 7; the range sets 7 and 8; 10 is named by none.
    assert.deepEqual(widthsFor("0 9 100 5 [200 201 202] 7 8 300", codes), [100, 100, 100, 100, 100, 200, 201, 300, 300, 100, 1000, 1000]);
  });

  test("an earlier entry stands where a later one does not reach, and a later one that covers it all wins", () => {
    assert.deepEqual(widthsFor("3 4 7 0 11 9", codes), [9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]);
    assert.deepEqual(widthsFor("0 11 9 3 4 7", codes), [9, 9, 9, 7, 7, 9, 9, 9, 9, 9, 9, 9]);
  });

  test("entries out of order are told by where they are in the list and not by their codes", () => {
    assert.deepEqual(widthsFor("8 10 50 0 9 60", codes), [60, 60, 60, 60, 60, 60, 60, 60, 60, 60, 50, 1000]);
    assert.deepEqual(widthsFor("0 9 60 8 10 50", codes), [60, 60, 60, 60, 60, 60, 60, 60, 50, 50, 50, 1000]);
  });

  test("many entries over one place leave the last", () => {
    const stacked = Array.from({ length: 5_000 }, (_, i) => `2 4 ${i + 1}`).join(" ");
    assert.deepEqual(widthsFor(stacked, codes), [1000, 1000, 5000, 5000, 5000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]);
  });

  test("a range that ends before it begins, and an array with nothing in it, name no code", () => {
    assert.deepEqual(widthsFor("5 2 77 6 [] 9 9 500", codes), [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 500, 1000, 1000]);
  });

  test("a first code that is not a number is 0, and so is a width, as they were", () => {
    assert.deepEqual(widthsFor("/Name 3 8", codes), [8, 8, 8, 8, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]);
    assert.deepEqual(widthsFor("2 4 /Name", codes), [1000, 1000, 0, 0, 0, 1000, 1000, 1000, 1000, 1000, 1000, 1000]);
  });

  test("a code that is not a whole number, or a negative one, names the codes it reaches and not the others", () => {
    assert.deepEqual(widthsFor("2.5 [300 301] 0.5 4.5 99", codes), codes.map(() => 1000));
    assert.deepEqual(widthsFor("-2 [10 11 12 13 14]", codes), [12, 13, 14, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]);
    assert.deepEqual(widthsFor("-5 2 40", codes), [40, 40, 40, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]);
  });

  test("the last entry of the list is not read when it has too few parts: a code alone, or two codes without a width", () => {
    assert.deepEqual(widthsFor("0 1 50 4", codes).slice(0, 6), [50, 50, 1000, 1000, 1000, 1000]);
    assert.deepEqual(widthsFor("0 1 50 4 6", codes).slice(0, 8), [50, 50, 1000, 1000, 0, 0, 0, 1000], "a range with no width is a range of 0, as it was");
  });
});

/** A small generator, so that the same arrays are tried each time. */
function generator(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("the widths of random /W arrays", () => {
  const TOUNICODE = "/CIDInit /ProcSet findresource begin begincmap 1 begincodespacerange <000000> <ffffff> endcodespacerange endcmap end";

  function documents(w: string, dw: string, wide: boolean): { now: ReturnType<typeof loadFont>; then: ReturnType<typeof loadFont> } {
    const pieces: Piece[] = [
      { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
      { num: 2, body: "<< /Type /Pages /Kids [] /Count 0 >>" },
      { num: 10, body: `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X ${dw} /W [${w}] >>` },
      { num: 11, body: `<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [10 0 R] ${wide ? "/ToUnicode 14 0 R" : ""} >>` },
      { num: 12, body: "[ 11 22 33 44 55 ]" },
      { num: 13, body: "777" },
      { num: 14, dict: "", data: buffer(TOUNICODE) },
    ];
    const bytes = assemble(pieces);
    const doc = new PdfDocument(bytes);
    const old = new PdfDocumentAlpha21(bytes);
    return { now: loadFont(doc, doc.get(11)), then: loadFontAlpha21(old as never, old.get(11)) as never };
  }

  test("are the widths the Map gave on 3,000 arrays made of arrays and ranges, overlapping, out of order, wrong and indirect", () => {
    const random = generator(2027);
    const below = (n: number): number => Math.floor(random() * n);
    const pick = <T>(items: readonly T[]): T => items[below(items.length)] as T;
    const CODES = ["0", "1", "2", "3", "5", "8", "10", "12", "20", "30", "40", "-3", "-1", "65530", "65535", "69990", "70000", "2.5", "-0.5", "1000000000000", "1000000000000000", "12 0 R", "13 0 R"];
    const WIDTHS = ["0", "100", "250", "500", "600", "1000", "-5", "3.5", "13 0 R", "/N", "null"];
    const entry = (): string => {
      const kind = below(10);
      if (kind < 3) return `${pick(CODES)} [${Array.from({ length: below(12) }, () => pick(WIDTHS)).join(" ")}]`;
      if (kind < 6) return `${pick(CODES)} ${pick(CODES)} ${pick(WIDTHS)}`;
      if (kind === 6) return `${pick(CODES)} 12 0 R`;
      if (kind === 7) return pick(["/Name", "null", "(str)", "true", "[ 1 2 ]", "<< /A 1 >>"]);
      if (kind === 8) return pick(CODES);
      return `${pick(CODES)} ${pick(CODES)}`;
    };
    // Codes asked of every font: the first sixty, the places where a range of 70,000 codes ends and where a two-byte code does, and a few more.
    const asked = [...Array.from({ length: 61 }, (_, i) => i), 255, 256, 1000, 65_529, 65_530, 65_531, 65_534, 65_535, 65_536, 69_989, 69_990, 69_991, 69_999, 70_000, 70_001, 100_000, 140_000];
    const wrong: string[] = [];
    for (let round = 0; round < 3_000; round++) {
      const w = Array.from({ length: below(9) }, entry).join(" ");
      const dw = pick(["", "/DW 1000", "/DW 700", "/DW 0", "/DW (x)", "/DW 2.5"]);
      // Codes of three bytes are asked in half of them, so that the 70,000 where a range stops can be seen.
      const wide = round % 2 === 1;
      const { now, then } = documents(w, dw, wide);
      const codes = wide ? asked : asked.filter((c) => c < 65_536);
      const bytes = Uint8Array.from(codes.flatMap((c) => (wide ? [c >> 16, (c >> 8) & 255, c & 255] : [c >> 8, c & 255])));
      const got = now.decode(bytes).map((g) => g.width);
      const want = then.decode(bytes).map((g) => g.width);
      if (got.length !== want.length || got.some((v, i) => v !== want[i])) {
        const at = got.findIndex((v, i) => v !== want[i]);
        wrong.push(`/W [${w}] ${dw} ${wide ? "(3 bytes)" : ""}: code ${codes[at]} is ${got[at]} for ${want[at]}`);
      }
    }
    assert.deepEqual(wrong.slice(0, 5), [], `${wrong.length} of 3,000 differ`);
  });
});

// ---------------------------------------------------------------------------
// What a small file may ask for
// ---------------------------------------------------------------------------

describe("a /W that asks for a great deal", () => {
  // The Map was set one code at a time from the first of a range, and from a first code of 20 digits the next code is the same number, so
  // the loop never moved and ended only when the budget was spent, taking every entry after it. A piece that begins there and ends there
  // is a place that does not advance: it is passed over, and in a process of its own, since a sweep that took it would not end.
  test("an entry whose first code is too big to be told from the next is passed over, and the entries after it are read", () => {
    const run = inChild(
      fontPdf("99999999999999999999 99999999999999999999 7 3 4 55 -99999999999999999999 [1 2 3] 5 6 66"),
      `const { PdfDocument } = await engine("import/pdf/document.ts"); const { loadFont } = await engine("import/pdf/fonts.ts");
       const doc = new PdfDocument(bytes);
       console.log(JSON.stringify(loadFont(doc, doc.get(11)).decode(Uint8Array.from([0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0, 7])).map((g) => g.width)));`,
      10_000,
    );
    assert.equal(run.timedOut, false, `still reading after ${run.ms} ms`);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), [1000, 55, 55, 66, 66, 1000]);
  });

  test("200,000 ranges laid over one another at random, 2.5 MB, are swept in a heap of 200 MB and in no more time than their number asks", () => {
    // Ranges of up to 60,000 codes at random places: a table of 200,000 pieces would be a Map of billions of widths.
    const random = generator(31);
    const w = Array.from({ length: 200_000 }, () => {
      const first = Math.floor(random() * 60_000);
      return `${first} ${first + Math.floor(random() * 60_000)} ${Math.floor(random() * 900)}`;
    }).join(" ");
    const pieces: Piece[] = [
      { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
      { num: 2, body: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
      { num: 3, body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Contents 4 0 R >>" },
      { num: 4, dict: "", data: buffer("BT /F1 12 Tf 72 700 Td <0041> Tj ET") },
      { num: 6, body: "<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [7 0 R] >>" },
      { num: 7, body: `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X /DW 1000 /W [${w}] >>` },
    ];
    const bytes = assemble(pieces);
    assert.ok(bytes.length > 2_000_000 && bytes.length < 5_000_000, `a file of ${bytes.length} bytes`);
    const read = readTextInChild(bytes, 30_000, heapOf(200));
    assert.equal(read.timedOut, false, `still reading after ${read.ms} ms`);
    assert.equal(read.status, 0, `the child ended with ${read.status}: ${read.stderr.slice(0, 300)}`);
    assert.equal(read.lines?.length, 1);
    assert.ok(read.ms < 10_000, `read in ${read.ms} ms`);
  });

  test("a range of 4 billion codes, and a hundred thousand of them, name no codes one by one", () => {
    const run = inChild(
      buffer("%PDF-1.5\n"),
      `const { PdfDocument } = await engine("import/pdf/document.ts"); const { loadFont } = await engine("import/pdf/fonts.ts");
       const { assemble } = await import(${JSON.stringify(new URL("./support/hostile-pdf.ts", import.meta.url).href)});
       const w = Array.from({ length: 100000 }, (_, i) => "0 4294967295 " + (i % 900)).join(" ");
       const doc = new PdfDocument(assemble([
         { num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" }, { num: 2, body: "<< /Type /Pages /Kids [] /Count 0 >>" },
         { num: 10, body: "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /X /DW 1000 /W [" + w + "] >>" },
         { num: 11, body: "<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [10 0 R] >>" }]));
       const widths = loadFont(doc, doc.get(11)).decode(Uint8Array.from([0, 5, 255, 255])).map((g) => g.width);
       console.log(JSON.stringify(widths));`,
      30_000,
      heapOf(200),
    );
    assert.equal(run.timedOut, false, `still reading after ${run.ms} ms`);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), [99999 % 900, 99999 % 900], "the last of them wins");
    assert.ok(run.ms < 10_000, `read in ${run.ms} ms`);
  });
});
