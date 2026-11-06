/**
 * Greek letters and the signs of mathematics in a printed PDF.
 *
 * The PDF is written with the fonts every reader has built in, which hold Windows Latin-1 and nothing else, so a Greek letter used to be
 * printed as a question mark. That mattered more once a Word file's Symbol-font characters and equations were read: the alpha came in
 * right and then printed as "?". The built-in Symbol font holds them, so they are drawn from it, with no font embedded. A character in
 * neither (a Cyrillic or Chinese letter) is still a question mark and is still counted and said.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";

import { symbolChar, symbolCodeOf } from "../src/import/docx/symbols.ts";
import { layoutTest, printOptions, printTest, writePdf, type PrintDocument } from "../src/print/index.ts";
import { createQuestion } from "../src/model/create.ts";
import { plainToRich } from "../src/model/richtext.ts";

const AT = "2026-01-01T00:00:00.000Z";
const base = layoutTest([], printOptions({ title: "Quiz", kind: "student" })).document;
const document = (runs: Array<{ text: string; underline?: boolean; bold?: boolean }>): PrintDocument => ({
  ...base,
  blocks: [{ kind: "para", runs, size: 11, indent: 0, before: 0, after: 0 }],
});

/** The content streams of the pages of a PDF, as text. */
function streamsOf(bytes: Uint8Array): string[] {
  const raw = Buffer.from(bytes);
  const text = raw.toString("latin1");
  return [...text.matchAll(/<< \/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/g)].map((m) => {
    const from = (m.index as number) + m[0].length;
    return inflateSync(raw.subarray(from, from + Number(m[1]))).toString("latin1");
  });
}

/** What a page draws, as a reader shows it: each text object read face by face, a Symbol string through the Symbol encoding. */
function drawn(stream: string): string[] {
  const lines: string[] = [];
  for (const object of stream.matchAll(/BT ([\s\S]*?) ET/g)) {
    let line = "";
    let face = "1";
    // Within one text object a face stays until it is changed.
    for (const piece of (object[1] as string).matchAll(/\/F(\d) [\d.]+ Tf|\(((?:\\.|[^\\)])*)\) Tj/g)) {
      if (piece[1] !== undefined) {
        face = piece[1];
        continue;
      }
      const unescaped = (piece[2] as string).replace(/\\([\s\S])/g, "$1");
      line += [...unescaped].map((c) => (face === "6" ? (symbolChar(c.charCodeAt(0)) ?? "�") : c)).join("");
    }
    lines.push(line);
  }
  return lines;
}

describe("a Greek letter or a sign in a PDF", () => {
  const text = "Angle α is ≤ 30° and x ∈ A, so π − 2 ≥ 0 and ∑ is not ∫.";
  const written = writePdf(document([{ text }]));
  const stream = streamsOf(written.bytes)[0] as string;

  test("is drawn in the Symbol font, and the words round it in Helvetica, so the line reads as it was written", () => {

    assert.ok(drawn(stream).includes(text), drawn(stream).join(" | "));
    assert.match(stream, /\/F6 11 Tf/);
    assert.deepEqual(written.replaced, [], "nothing was replaced by a question mark");
  });

  test("is a font the file names and does not embed, with the encoding it has built in", () => {
    const raw = Buffer.from(written.bytes).toString("latin1");
    const symbol = [...raw.matchAll(/\d+ 0 obj\n(<< \/Type \/Font [^\n]*>>)\nendobj/g)].map((m) => m[1] as string).find((o) => /\/BaseFont \/Symbol/.test(o));
    assert.ok(symbol, "the Symbol font is in the file");
    assert.doesNotMatch(symbol as string, /\/Encoding/, "it keeps its own encoding: the Windows one would put Latin letters where its Greek ones are");
    assert.doesNotMatch(raw, /\/FontFile/);
    assert.match(raw, /\/Font << [^>]*\/F6 \d+ 0 R/);
  });

  test("is not there when the text has none: the file is as it was", () => {
    const plain = Buffer.from(writePdf(document([{ text: "Nothing but Latin text, 30° and ± 5." }])).bytes).toString("latin1");
    assert.doesNotMatch(plain, /\/Symbol/);
    assert.doesNotMatch(plain, /\/F6/);
  });

  test("is drawn in a bold or italic run too, and underlined with the rest", () => {

    const mixed = streamsOf(writePdf(document([{ text: "bold α", bold: true }, { text: " and β", underline: true }])).bytes)[0] as string;
    assert.ok(drawn(mixed).join(" ").includes("bold α and β"), drawn(mixed).join(" | "));
    assert.match(mixed, /0\.5 w [\d.]+ [\d.]+ m [\d.]+ [\d.]+ l S/);
  });

  test("keeps a word whole: a line is never broken between the letters and the Greek letter in one word", () => {

    const long = Array.from({ length: 80 }, () => "aαb").join(" ");
    const result = streamsOf(writePdf(document([{ text: long }])).bytes)[0] as string;
    const lines = drawn(result).filter((l) => l.includes("α"));
    assert.ok(lines.length >= 3, "the paragraph took several lines");
    for (const line of lines) assert.match(line, /^aαb( aαb)*$/, line);
  });

  test("is drawn in the footer and the header too: a test called Physics α is not footed with a question mark", () => {
    const withTitle: PrintDocument = { ...document([{ text: "Body." }]), footer: "Physics α test", header: "Version Δ" };
    const result = writePdf(withTitle);
    const lines = streamsOf(result.bytes).flatMap((s) => drawn(s));
    assert.ok(lines.includes("Physics α test"), lines.join(" | "));
    assert.ok(lines.includes("Version Δ"), lines.join(" | "));
    assert.deepEqual(result.replaced, []);
  });

  test("a character in neither font is still a question mark, counted and said, beside one that is drawn", () => {
    const q = createQuestion({ type: "shortAnswer", stem: plainToRich("Greek α and Russian Ж and 中."), body: { caseSensitive: false, accepted: ["x"] }, by: "t", at: AT, id: `q_${"1".padStart(26, "0")}` });
    const result = printTest([q], printOptions({ title: "Quiz", kind: "student" }), "pdf");
    const general = result.report.general.join("\n");
    assert.match(general, /2 characters cannot be drawn in a PDF's built-in fonts and were printed as \?: /);
    assert.doesNotMatch(general, /α/, "the Greek letter is not among the ones that could not be drawn");
  });
});

describe("the table the printer draws from", () => {
  test("gives back, for every Greek letter and sign it holds, the code that shows it", () => {
    let checked = 0;
    for (let code = 0x20; code <= 0xff; code++) {
      const shown = symbolChar(code);
      if (shown === undefined) continue;
      const back = symbolCodeOf(shown);
      assert.ok(back !== undefined, `${shown} has a code`);
      assert.equal(symbolChar(back as number), shown, `${shown} (code ${code.toString(16)}) is drawn as itself`);
      checked++;
    }
    assert.ok(checked > 150, `${checked} characters were checked`);
  });

  test("knows the two characters that mean the same as Delta and Omega but have code points of their own, and no others it is not sure of", () => {
    assert.equal(symbolChar(symbolCodeOf("∆") as number), "Δ");
    assert.equal(symbolChar(symbolCodeOf("Ω") as number), "Ω");
    assert.equal(symbolCodeOf("Ж"), undefined);
    assert.equal(symbolCodeOf("中"), undefined);
  });
});
