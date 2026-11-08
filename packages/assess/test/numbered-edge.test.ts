/**
 * The line that begins with a number and a stop and has another number after it ("8. AI IN EVERYDAY LIFE | 531"), which is how a running
 * title that begins with a number is told from a question.
 *
 * It was a pattern, `^\s*(\d{1,3}[.)])\s+(.*\d.*)$`, in which the white space after the label and the start of what follows can both take
 * the same spaces: a line of a label, 20,000 spaces and a letter tried the rest from every space of the run and read to the end of it each
 * time (447 milliseconds, and the square of the length for a longer line). It is a scan now, and the pattern is kept here, word for word,
 * to hold the scan to it on every character a line can have and on tens of thousands of lines made of the characters that matter.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { numberedEdge } from "../src/import/pdf/reader.ts";
import { contentPdf, readTextInChild } from "./support/hostile-pdf.ts";

/** The pattern as it was. */
const OLD = /^\s*(\d{1,3}[.)])\s+(.*\d.*)$/;

const oldEdge = (text: string): { label: string; rest: string } | undefined => {
  const m = OLD.exec(text);
  return m ? { label: m[1] as string, rest: m[2] as string } : undefined;
};

describe("a line that begins with a number and a stop", () => {
  test("is told from one that does not as the pattern told them, on the lines a running title and a question have", () => {
    for (const [text, expected] of [
      ["8. AI IN EVERYDAY LIFE | 531", { label: "8.", rest: "AI IN EVERYDAY LIFE | 531" }],
      ["  12)  Chapter 3", { label: "12)", rest: "Chapter 3" }],
      ["123. page 4", { label: "123.", rest: "page 4" }],
      ["1.\t\t5", { label: "1.", rest: "5" }],
      ["1.\n5", { label: "1.", rest: "5" }],
      ["1. a\n5", undefined],
      ["1.5 apples 3", undefined],
      ["1234. page 4", undefined],
      ["1. no number here", undefined],
      ["1.", undefined],
      ["1. ", undefined],
      ["", undefined],
      ["Question 1. page 4", undefined],
      ["٣. page 4", undefined],
    ] as const) {
      assert.deepEqual(numberedEdge(text), expected, JSON.stringify(text));
      assert.deepEqual(numberedEdge(text), oldEdge(text), `${JSON.stringify(text)} against the pattern`);
    }
  });

  // Every code unit, in front of the number, between the stop and the rest, and inside the rest: `\s`, a character `.` does not match, and
  // the characters that look like white space and are not (a zero width space, a line separator the pattern does not take, an Ogham mark).
  test("is told as the pattern told it for every one of the 65,536 characters in front of it, after its stop, and inside what follows", () => {
    const wrong: string[] = [];
    for (let unit = 0; unit < 0x10000; unit++) {
      const ch = String.fromCharCode(unit);
      for (const text of [`${ch}1. 5`, `1.${ch}5`, `1. a${ch}b5`, `1. 5${ch}`, `1.${ch}${ch}5`, `${ch}${ch}1)${ch}x5`, `12${ch}. 5`]) {
        if (JSON.stringify(numberedEdge(text)) !== JSON.stringify(oldEdge(text))) wrong.push(`${unit.toString(16)}: ${JSON.stringify(text)}`);
      }
    }
    assert.deepEqual(wrong.slice(0, 5), []);
  });

  test("is told as the pattern told it on 100,000 lines made of white space of every kind, digits, stops, letters and line ends", () => {
    let seed = 20261108;
    const random = (n: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed >>> 8) % n;
    };
    const SPACES = [" ", " ", "\t", "\n", "\r", " ", " ", " ", " ", "　", "﻿", "​", "\u0085", "᠎", "\v", "\f"];
    const PIECES = ["1", "2", "9", "12", "123", "1234", ".", ")", "(", "a", "word", "x5", "|", "٣", "5", "-"];
    const pick = (items: readonly string[]): string => items[random(items.length)] as string;
    const run = (items: readonly string[], most: number): string => Array.from({ length: random(most) }, () => pick(items)).join("");
    const wrong: string[] = [];
    for (let n = 0; n < 100_000; n++) {
      // Half of them are made to begin like the line that is asked about, so that most of them reach the later parts of the pattern.
      const text = n % 2 === 0 ? run([...SPACES, ...PIECES], 14) : `${run(SPACES, 3)}${pick(["1", "12", "123", "1234", "", "a"])}${pick([".", ")", "", "."])}${run(SPACES, 4)}${run([...PIECES, ...SPACES], 8)}`;
      const now = numberedEdge(text);
      const then = oldEdge(text);
      if (JSON.stringify(now) !== JSON.stringify(then)) wrong.push(`${JSON.stringify(text)}: ${JSON.stringify(now)} for ${JSON.stringify(then)}`);
    }
    assert.deepEqual(wrong.slice(0, 5), []);
  });

  // A line of a label, then a run of spaces, then a letter at the top of a page: the pattern read it in the square of the length.
  for (const [what, line] of [
    ["a label, 300,000 spaces and a letter", `1.${" ".repeat(300_000)}x`],
    ["a label and 300,000 spaces and tabs", `12.${" \t".repeat(150_000)}x`],
    ["300,000 spaces in front of a label", `${" ".repeat(300_000)}1. x`],
    ["a label and a rest of 300,000 letters with a line end in it", `1. ${"a".repeat(300_000)}\n5`],
  ] as const) {
    test(`${what} at the top of a page is read at once`, () => {
      const read = readTextInChild(contentPdf(`BT /F1 12 Tf 72 700 Td (${line.replace(/\n/g, " ")}) Tj ET`));
      assert.equal(read.timedOut, false, `still reading after ${read.ms} ms`);
      assert.equal(read.lines?.length, 1);
      assert.ok(read.ms < 5000, `read in ${read.ms} ms`);
    });
  }

  test("the scan itself is linear: a label and a million spaces and a letter are told in no time at all", () => {
    const started = performance.now();
    assert.equal(numberedEdge(`1.${" ".repeat(1_000_000)}x`), undefined);
    assert.equal(numberedEdge(`${" ".repeat(1_000_000)}1. x`), undefined);
    assert.equal(numberedEdge(`1.${" ".repeat(1_000_000)}x5`)?.rest, "x5");
    assert.ok(performance.now() - started < 1000, `${Math.round(performance.now() - started)} ms`);
  });
});
