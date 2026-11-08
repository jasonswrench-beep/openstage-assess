/**
 * A long run of white space in a file must not make a reader slow.
 *
 * A pattern that begins with white space and is not anchored takes N squared steps on a run of N spaces that does not lead to what it looks
 * for, because each of the N places inside the run is tried and read to the end of it. A file with one line of 100,000 spaces took 8 seconds
 * to read and a table whose first rows held cells of 32,767 spaces (Excel's limit) took 27. Nothing real looks like this, but a damaged
 * file or a pasted block can, and a program that stops for a minute on a file is not reading it. The runs here are 60,000 characters long,
 * where a quadratic pattern takes seconds and a linear one a few milliseconds, and the limit is a second and a half so that a slow machine
 * does not fail it. Found by an independent reviewer (the header cells and the table), and then by feeding every reader runs of spaces,
 * tabs, no-break spaces and a mix in each place a line can be: the stem, an option, an answer, feedback, a Type or Points line.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { importerForContent, runImporter } from "../src/import/registry.ts";

const AT = "2026-11-07T00:00:00.000Z";
const N = 60000;
const LIMIT_MS = 1500;

function timeOf(file: string, text: string): number {
  const bytes = new Uint8Array(Buffer.from(text, "utf8"));
  const start = performance.now();
  const importer = importerForContent(file, bytes);
  runImporter(importer, bytes, { file, at: AT, author: "test" });
  return performance.now() - start;
}

const RUNS: Array<[string, string]> = [
  ["spaces", " ".repeat(N)],
  ["tabs", "\t".repeat(N)],
  ["no-break spaces", " ".repeat(N)],
  ["spaces and tabs", " \t".repeat(N / 2)],
];

// Each makes a text file with the run in one place of a question.
const PLACES: Array<[string, (run: string) => string]> = [
  ["on a line of its own before the first question", (r) => `${r}\n1. Which?\na. x\n*b. y\n`],
  ["inside a stem", (r) => `1. Which${r}is it?\na. x\n*b. y\n`],
  ["after a stem", (r) => `1. Which is it?${r}\na. x\n*b. y\n`],
  ["inside an option", (r) => `1. Which?\na. x${r}y\n*b. y\n`],
  ["after an option, before (correct)", (r) => `1. Which?\na. x${r}(correct)\nb. y\n`],
  ["after an option, before a tick", (r) => `1. Which?\na. x${r}✓\nb. y\n`],
  ["after an option, before a star", (r) => `1. Which?\na. x${r}*\nb. y\n`],
  ["after an option, before an inline answer", (r) => `1. Which?\na. x${r}ANS: b\nb. y\n`],
  ["in an Answer line", (r) => `1. Which?\na. x\nb. y\nAnswer:${r}b\n`],
  ["after an Answer line", (r) => `1. Which?\na. x\nb. y\nAnswer: b${r}\n`],
  ["in a feedback line", (r) => `1. Which?\na. x\n*b. y\nFeedback:${r}good\n`],
  ["in a Type line", (r) => `1. Which?\nType:${r}MC\na. x\n*b. y\n`],
  ["in a Points line", (r) => `1. Which?\nPoints:${r}2\na. x\n*b. y\n`],
  ["between inline options", (r) => `1. Which?\na. x${r}b. y${r}c. z\nAnswer: b\n`],
  ["inside a bracket in the middle of a file", (r) => `1. A?\na. x\n*b. y\n[${r}]\n1. Which?\na. x\n*b. y\n`],
  ["before a page note", (r) => `1. Which? ${r}(p. 4)\na. x\n*b. y\n`],
  ["before a true or false mark", (r) => `1. Ice is cold.${r}(T)\n`],
  ["before a source note", (r) => `1. Which?\na. x\n*b. y\n  ${r}(Source: chapter 2)\n`],
  // The patterns for the end of a line only run on a line that ends in the mark they look for, so the run has to be in a line that ends
  // in a star or a bracket and is not followed by it.
  ["inside an option that ends in a star", (r) => `1. Which?\na. x${r}y*\nb. z\n`],
  ["inside a stem that ends in a bracket", (r) => `1. Which${r}is it? (see below)\na. x\n*b. y\n`],
  ["inside a true or false stem that ends in a bracket", (r) => `1. Ice${r}is cold. (maybe)\nAnswer: True\n`],
  ["inside a stem that ends in a source note", (r) => `1. Which${r}is it? (Source: chapter 2)\na. x\n*b. y\n`],
  ["inside a stem that ends in a page note", (r) => `1. Which${r}is it? (p. 4)\na. x\n*b. y\n`],
  ["in the middle of the value of an Answer line", (r) => `1. Which?\na. x\nb. y\nAnswer: b${r}c\n`],
  ["inside a stem marked Type: TF that ends in a bracket", (r) => `Type: TF\n1. Ice${r}is cold. (maybe)\nAnswer: True\n`],
  // A habit of marking the right option with a star at its end is only looked for once several options do it.
  [
    "inside an option that ends in a star, in a file that marks its right answers that way",
    (r) => [1, 2, 3].map((n) => `${n}. Which?\na. x\nb. y*\nc. z`).join("\n\n") + `\n\n4. Which?\na. x\nb. y\nc. z${r}w*\n`,
  ],
];

describe("a long run of white space", () => {
  for (const [name, run] of RUNS) {
    test(`${name}: every place of a question in a text file reads in well under a second`, () => {
      const slow: string[] = [];
      for (const [place, make] of PLACES) {
        const ms = timeOf("bank.txt", make(run));
        if (ms > LIMIT_MS) slow.push(`${place} took ${Math.round(ms)} ms`);
      }
      assert.deepEqual(slow, []);
    });
  }

  // Found by a second reviewer: the check that a stem holds its own options had one lazy pattern across "a." and "b.", and a stem made of
  // thousands of "a." with no "b." took N squared steps (five such stems took 20 seconds).
  test("a stem made of thousands of option markers, in a file of five questions that were all guessed at", () => {
    const stem = "a. ".repeat(64000);
    const text = Array.from({ length: 5 }, (_, i) => `${i + 1}. ${stem}`).join("\n\n");
    const ms = timeOf("bank.txt", text);
    assert.ok(ms < LIMIT_MS, `${Math.round(ms)} ms`);
  });

  test("in a table: a header cell, a cell of a headerless table, and a cell of an answer", () => {
    const long = " ".repeat(32767);
    const cases: Array<[string, string, string]> = [
      ["a header cell of spaces", "t.csv", `Question,A,B,Correct,Notes${long}\nWhich?,x,y,A,z\n`],
      ["a header cell with spaces after a dash", "t.csv", `Question -${long}max,A,B,Correct\nWhich?,x,y,A\n`],
      ["a header cell of thousands of dashes with a space each side", "t.csv", `Question,A,B,Correct,Notes${" - ".repeat(10000)}\nWhich?,x,y,A,z\n`],
      // Only a table of the CSV kind has no limit on the size of a cell, and every dash that is tried reads the rest of the cell.
      ["a header cell of 200,000 dashes with a space each side", "t.csv", `Question,A,B,Correct,Notes${" - ".repeat(200000)}\nWhich?,x,y,A,z\n`],
      ["a header cell of thousands of dashes and words", "t.csv", `Question${" - max".repeat(6000)},A,B,Correct\nWhich?,x,y,A\n`],
      ["a header cell of open brackets", "t.csv", `Question,A,B,Correct,${"(".repeat(32767)}\nWhich?,x,y,A,z\n`],
      ["ten rows of a headerless table with a cell of spaces", "t.csv", ["MC,Which?,a,b,c,d,e,A", ...Array.from({ length: 9 }, () => `MC,x${long}y,a,b,c,d,e,A`)].join("\n") + "\n"],
      ["a stem cell of spaces", "t.csv", `Question,A,B,Correct\n"Which?${long}",x,y,A\n`],
      ["an answer cell of spaces", "t.csv", `Question,A,B,Correct\nWhich?,"x${long}y",z,A\n`],
      ["a field of spaces in a Blackboard upload file", "t.txt", `MC\tWhich?\tx${long}y\tcorrect\tz\tincorrect\n`],
    ];
    const slow: string[] = [];
    for (const [name, file, text] of cases) {
      const ms = timeOf(file, text);
      if (ms > LIMIT_MS) slow.push(`${name} took ${Math.round(ms)} ms`);
    }
    assert.deepEqual(slow, []);
  });
});
