/**
 * Characters typed from Word's Symbol font.
 *
 * Insert Symbol writes `<w:sym>` with a font and a code; text typed while the font is Symbol is ordinary letters in a run whose
 * font is Symbol. Both show as Greek letters and signs, and both were wrong (skipped without a mark, or read as the Latin letters). The
 * documents in fixtures/word-authored/symbols were written by Word itself (`npm run check:word-symbols`); the rest is the table.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { inSymbolFont, isSymbolFont, symbolChar } from "../src/import/docx/symbols.ts";
import { wordImporter } from "../src/import/word.ts";
import type { Question } from "../src/model/question.ts";
import { richTextToPlain } from "../src/model/richtext.ts";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "word-authored", "symbols");
const read = (name: string) => wordImporter.parseBytes(new Uint8Array(readFileSync(join(dir, `${name}.docx`))), { file: `${name}.docx`, at: "2026-01-01T00:00:00.000Z", author: "test" });
const stem = (name: string): string => richTextToPlain((read(name).questions[0] as Question).stem).replace(/\s+/g, " ");

describe("documents that Word wrote with symbols in them", () => {
  test("Insert Symbol from the Symbol font is the Greek letter or sign it shows", () => {
    assert.equal(stem("symbols-insert"), "Is the angle α and the error ± small?");
    assert.match(read("symbols-insert").fileFindings.map((f) => f.message).join(" | "), /2 characters typed from the Symbol font were read/);
  });

  test("text typed while the font is Symbol is read as the letters it shows, not the letters it is written with", () => {
    assert.equal(stem("symbols-typed"), "Which letters are αβγ Greek?");
  });

  test("a character of an ordinary font from Insert Symbol is the Unicode character", () => {
    assert.equal(stem("symbols-arial"), "Is the error ± or 30 ° small?");
  });

  test("a Wingdings character is a picture: it is marked where it stood and counted by its font, and nothing is guessed", () => {
    const r = read("symbols-wingdings");
    assert.equal(stem("symbols-wingdings"), "Is this ticked [symbol]?");
    assert.match(r.fileFindings.map((f) => f.message).join(" | "), /1 symbol character was not read \(1 from Wingdings\)\. Each is marked \[symbol\]/);
    assert.equal(r.questions.length, 1, "and the question is still a question");
  });
});

describe("the Symbol font's table", () => {
  test("has the Greek letters, in capitals and in small, as they sit in the font", () => {
    // Symbol is not in alphabetical order: a b c d e f g are alpha beta chi delta epsilon phi gamma.
    assert.deepEqual([..."abcdefg"].map((c) => symbolChar(c.charCodeAt(0))), ["α", "β", "χ", "δ", "ε", "φ", "γ"]);
    assert.deepEqual([..."ABCDEFG"].map((c) => symbolChar(c.charCodeAt(0))), ["Α", "Β", "Χ", "Δ", "Ε", "Φ", "Γ"]);
    assert.equal(symbolChar("m".charCodeAt(0)), "μ", "mu");
    assert.equal(symbolChar("p".charCodeAt(0)), "π", "pi");
    assert.equal(symbolChar("w".charCodeAt(0)), "ω", "omega");
    assert.equal(symbolChar("S".charCodeAt(0)), "Σ", "capital sigma");
  });

  test("has the signs of arithmetic and logic", () => {
    const signs: Array<[number, string]> = [[0xb1, "±"], [0xb0, "°"], [0xb4, "×"], [0xb8, "÷"], [0xa3, "≤"], [0xb3, "≥"], [0xb9, "≠"], [0xbb, "≈"], [0xa5, "∞"], [0xae, "→"], [0xac, "←"], [0xd6, "√"], [0xe5, "∑"], [0xf2, "∫"], [0xb6, "∂"], [0x2d, "−"], [0xce, "∈"], [0xc8, "∪"]];
    for (const [code, want] of signs) assert.equal(symbolChar(code), want, `0x${code.toString(16)}`);
  });

  test("reads a code at its own place and at 0xF000 above it, which is where Word keeps it", () => {
    assert.equal(symbolChar(0x61), "α");
    assert.equal(symbolChar(0xf061), "α");
    assert.equal(symbolChar(0xf0b1), "±");
  });

  test("is not sure of a code it does not hold, and says so instead of guessing", () => {
    for (const code of [0xe6, 0xf6, 0xfe, 0xf1, 0x60, 0x0, 0xd2]) assert.equal(symbolChar(code), undefined, `0x${code.toString(16)}`);
  });

  test("knows the Symbol font by name in any case", () => {
    assert.deepEqual(["Symbol", "symbol", " SYMBOL "].map(isSymbolFont), [true, true, true]);
    assert.deepEqual([undefined, "Arial", "Symbols", "Wingdings"].map(isSymbolFont), [false, false, false, false]);
  });
});

describe("text in a run whose font is Symbol", () => {
  test("is changed letter by letter, the ordinary characters by the font for them and the rest by the font for the rest", () => {
    assert.deepEqual(inSymbolFont("ab", { ascii: "Symbol", hAnsi: "Symbol" }), { text: "αβ", changed: 2, unsure: 0 });
    // A letter is shown in the font for ordinary text, so a run whose ordinary font is Arial keeps its letters.
    assert.deepEqual(inSymbolFont("ab", { ascii: "Arial", hAnsi: "Symbol" }), { text: "ab", changed: 0, unsure: 0 });
    // A sign above the ordinary range is shown in the other font.
    assert.deepEqual(inSymbolFont("±", { ascii: "Arial", hAnsi: "Symbol" }), { text: "±", changed: 0, unsure: 0 });
  });

  test("counts a character the table is not sure of, and leaves it as written", () => {
    assert.deepEqual(inSymbolFont("aç", { ascii: "Symbol", hAnsi: "Symbol" }), { text: "aç".replace("a", "α"), changed: 1, unsure: 1 });
  });

  test("leaves digits and punctuation, which are the same in the font, as they are, and does not count them as changed", () => {
    assert.deepEqual(inSymbolFont("(1+2)=3", { ascii: "Symbol", hAnsi: "Symbol" }), { text: "(1+2)=3", changed: 0, unsure: 0 });
  });
});
