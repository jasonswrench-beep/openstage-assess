/**
 * The OpenStage question spreadsheet is a CSV that a person may open in a spreadsheet program, and a cell that begins with =, +, -, @,
 * a tab or a carriage return is read there as a formula: a question bank from someone else could run one on the machine of whoever
 * opened the file. So such a cell is written with an apostrophe in front, and OpenAssess's reader (and Author's question import) drop
 * one apostrophe in front of those characters, so the question comes back as it was written (the security review of 2026-11-13).
 *
 * The LMS files (the Brightspace CSV and the Blackboard upload file) are not given the apostrophe: they are for the LMS to read
 * exactly, and an apostrophe would become part of the question there.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { exportBlackboardUpload } from "../src/export/blackboard-upload.ts";
import { exportD2lCsv } from "../src/export/d2l-csv.ts";
import { exportOpenStageSpreadsheet, guardFormula } from "../src/export/openstage-spreadsheet.ts";
import { spreadsheetImporter, unguardFormula } from "../src/import/spreadsheet.ts";
import { readCsv } from "../src/import/table-csv.ts";
import type { ImportResult } from "../src/import/types.ts";
import { createQuestion } from "../src/model/create.ts";
import type { Question } from "../src/model/question.ts";
import { plainToRich, richTextToPlain } from "../src/model/richtext.ts";

const AT = "2026-01-01T00:00:00.000Z";

const STEMS = [
  "=1+1",
  '=HYPERLINK("https://example.invalid","Click")',
  "+44 is the code for which country?",
  "-3 + 4 = ?",
  "@SUM(A1:A9) is what kind of thing?",
  "'=already guarded by the author",
  "It's a plain question with an apostrophe.",
  "'Quoted' at the start.",
];

function choice(stem: string, right: string, wrong: string): Question {
  return createQuestion({
    type: "multipleChoice",
    stem: plainToRich(stem),
    body: {
      shuffle: false,
      options: [
        { id: "o0", content: plainToRich(right), correct: true },
        { id: "o1", content: plainToRich(wrong), correct: false },
      ],
    } as never,
    by: "test",
    at: AT,
  });
}

const QUESTIONS = STEMS.map((stem, i) => choice(stem, i % 2 === 0 ? "=2" : "-1", "+3"));

const csvOf = (questions: Question[]): string => exportOpenStageSpreadsheet(questions, { name: "Probe" }).files.map((f) => f.content).join("\n");

describe("the OpenStage question spreadsheet", () => {
  const text = csvOf(QUESTIONS);

  test("has no cell that a spreadsheet program would read as a formula", () => {
    const table = readCsv(new Uint8Array(Buffer.from(text, "utf8")));
    const cells = table.sheets.flatMap((s) => s.rows.flatMap((r) => r.cells));
    assert.ok(cells.length > STEMS.length * 3);
    for (const cell of cells) assert.doesNotMatch(cell, /^[=+\-@\t\r]/, `the cell ${JSON.stringify(cell)} would be read as a formula`);
    assert.ok(cells.includes("'=1+1"));
    assert.ok(cells.includes("'-3 + 4 = ?"));
    assert.ok(cells.includes("''=already guarded by the author"), "an apostrophe the author wrote there is given one more");
    assert.ok(cells.includes("It's a plain question with an apostrophe."), "and any other text is written as it is");
    assert.ok(cells.includes("'Quoted' at the start."));
  });

  test("is read back by OpenAssess with every question and answer as it was written", () => {
    const result = spreadsheetImporter.parseBytes?.(new Uint8Array(Buffer.from(text, "utf8")), { file: "questions.csv", at: AT, author: "test" }) as ImportResult;
    assert.deepEqual(result.questions.map((q) => richTextToPlain(q.stem)), STEMS);
    for (const [i, q] of result.questions.entries()) {
      const options = (q.body as unknown as { options: Array<{ content: never; correct: boolean }> }).options.map((o) => [richTextToPlain(o.content), o.correct]);
      assert.deepEqual(options, [[i % 2 === 0 ? "=2" : "-1", true], ["+3", false]]);
    }
  });
});

describe("the guard and the reader's undoing of it", () => {
  test("undo each other for every text that begins with up to three of the characters that matter", () => {
    const alphabet = ["=", "+", "-", "@", "\t", "\r", "'", "a", " "];
    let tried = 0;
    const visit = (text: string): void => {
      tried++;
      assert.equal(unguardFormula(guardFormula(text)), text, JSON.stringify(text));
      assert.doesNotMatch(guardFormula(text), /^[=+\-@\t\r]/, JSON.stringify(text));
      if (text.length < 4) for (const c of alphabet) visit(text + c);
    };
    visit("");
    assert.ok(tried > 7000);
  });

  test("the reader takes one apostrophe off a run of them only in front of those characters", () => {
    assert.equal(unguardFormula("'=x"), "=x");
    assert.equal(unguardFormula("''=x"), "'=x");
    assert.equal(unguardFormula("'''+x"), "''+x");
    assert.equal(unguardFormula("'x"), "'x");
    assert.equal(unguardFormula("'"), "'");
    assert.equal(unguardFormula("x'=y"), "x'=y");
  });
});

describe("the LMS files", () => {
  const q = choice("=1+1", "=2", "+3");

  test("the Brightspace CSV writes the question exactly, with no apostrophe", () => {
    const text = exportD2lCsv([q], { name: "Probe" }).files.map((f) => f.content).join("\n");
    assert.match(text, /=1\+1/);
    assert.doesNotMatch(text, /'=1\+1/);
  });

  test("the Blackboard upload file writes the question exactly, with no apostrophe", () => {
    const text = exportBlackboardUpload([q], { name: "Probe" }).files.map((f) => f.content).join("\n");
    assert.match(text, /=1\+1/);
    assert.doesNotMatch(text, /'=1\+1/);
  });
});
