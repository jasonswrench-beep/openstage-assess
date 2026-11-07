/**
 * A title above the row of column names is not the row of column names.
 *
 * When "Questions" became a name for the question column, a sheet with that one word in A1 as its title and the real names in the row
 * below it read as a table whose names were the title: three essays with the words Type, MC and MC for their stems, where it had read
 * as two multiple choice questions with their keys. The row of names is the first that names two or more known columns; a first row that
 * names only the question column is the row of names only when nothing below it names more. An independent review found it.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { writeXlsx } from "../src/container/xlsx.ts";
import { spreadsheetImporter } from "../src/import/spreadsheet.ts";
import type { ImportResult } from "../src/import/types.ts";
import type { Question } from "../src/model/question.ts";
import { richTextToPlain } from "../src/model/richtext.ts";

const AT = "2026-11-07T00:00:00.000Z";
const csv = (text: string): ImportResult => spreadsheetImporter.parseBytes?.(new Uint8Array(Buffer.from(text, "utf8")), { file: "questions.csv", at: AT, author: "test" }) as ImportResult;
const stems = (r: ImportResult): string[] => r.questions.map((q) => richTextToPlain(q.stem).trim());
const right = (q: Question): string[] => (q.body as unknown as { options: Array<{ content: unknown; correct: boolean }> }).options.filter((o) => o.correct).map((o) => richTextToPlain(o.content as never).trim());

describe("a title above the names of the columns", () => {
  for (const title of ["Questions", "Question", "Test bank questions"]) {
    test(`"${title}" alone in the first row, with the names below it, reads the questions under the names`, () => {
      const r = csv(`${title}\nType,Question,A,B,Correct\nMC,What is 2+2?,3,4,B\nMC,What is 3+3?,5,6,B\n`);
      assert.deepEqual(stems(r), ["What is 2+2?", "What is 3+3?"]);
      assert.deepEqual(right(r.questions[0] as Question), ["4"]);
      assert.equal(r.questions[0]?.type, "multipleChoice");
      // The title is said, as a row above the names that was not read as a question.
      assert.equal(r.orphans.length, 1);
      assert.match(r.orphans[0]?.reason ?? "", /above the row that names the columns/);
    });
  }

  test("a table that is only a column of questions, named Questions, still reads, each as an essay", () => {
    const r = csv("Questions\nExplain the water cycle.\nDescribe a cell.\n");
    assert.deepEqual(stems(r), ["Explain the water cycle.", "Describe a cell."]);
    assert.ok(r.questions.every((q) => q.type === "essay"));
    assert.equal(r.orphans.length, 0);
  });

  test("a workbook with the title in A1 and the names in row 2 reads the same way", () => {
    const bytes = writeXlsx([{ name: "Q", rows: [["Questions"], ["Type", "Question", "A", "B", "Correct"], ["MC", "What is 2+2?", "3", "4", "B"]] }]);
    const r = spreadsheetImporter.parseBytes?.(bytes, { file: "q.xlsx", at: AT, author: "test" }) as ImportResult;
    assert.deepEqual(stems(r), ["What is 2+2?"]);
    assert.deepEqual(right(r.questions[0] as Question), ["4"]);
  });

  test("a first row that already names the columns is the row of names, whatever is below it", () => {
    const r = csv("Question,A,B,Correct\nWhich?,a,b,A\nQuestion,Type,Answer\nIs this a note?,x,y\n");
    assert.equal(r.questions[0] ? richTextToPlain(r.questions[0].stem).trim() : "", "Which?");
  });
});
