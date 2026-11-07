/**
 * Chapter, section, objective, page, Bloom level, difficulty and tag columns of a question table are the question's own fields.
 *
 * Before this they were reported as "not used", so a table an instructor had already organised by chapter and difficulty came in with
 * all of that gone, and Coverage and a blueprint had nothing to work with. A word that the text reader knows for a difficulty or a
 * Bloom level is read the same way here (one table of words, `metadata-words.ts`); one that is not known is kept as written under its
 * own name and said, and is never turned into a guess. The text is invented.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { writeXlsx } from "../src/container/xlsx.ts";
import { coverage } from "../src/bank/coverage.ts";
import { spreadsheetImporter } from "../src/import/spreadsheet.ts";
import type { ImportResult } from "../src/import/types.ts";
import { FindingCode, liveFindings } from "../src/model/findings.ts";
import type { Question } from "../src/model/question.ts";
import { validateQuestion } from "../src/model/schema.ts";

const AT = "2026-11-07T00:00:00.000Z";
const csv = (text: string): ImportResult => spreadsheetImporter.parseBytes?.(new Uint8Array(Buffer.from(text, "utf8")), { file: "questions.csv", at: AT, author: "test" }) as ImportResult;
const first = (r: ImportResult): Question => r.questions[0] as Question;
const said = (q: Question): string => liveFindings(q.findings).map((f) => `${f.severity}: ${f.message}`).join(" | ");

const HEAD = "Question,A,B,Correct,Chapter,Section,Objective,Page,Bloom's level,Difficulty,Tags";

describe("the columns a bank is organised by", () => {
  test("are the question's own fields", () => {
    const q = first(csv(`${HEAD}\nWhich?,a,b,B,Chapter 3,3.2,Explain the cycle,41,Apply,Hard,"water, cycle; earth"`));
    assert.equal(q.metadata.chapter, "Chapter 3");
    assert.equal(q.metadata.section, "3.2");
    assert.equal(q.metadata.objective, "Explain the cycle");
    assert.equal(q.metadata.page, "41");
    assert.equal(q.metadata.bloom, "apply");
    assert.equal(q.metadata.difficulty, "hard");
    assert.deepEqual(q.metadata.tags, ["water", "cycle", "earth"]);
    assert.equal(validateQuestion(q).ok, true, "the question is valid");
  });

  test("none of them is reported as not used, and a table with only these is read as it was", () => {
    const r = csv(`${HEAD}\nWhich?,a,b,B,3,,,,,,`);
    assert.ok(!r.fileFindings.some((f) => /not used/.test(f.message)), r.fileFindings.map((f) => f.message).join("\n"));
    assert.equal(first(r).metadata.chapter, "3");
    assert.equal(first(r).metadata.section, undefined, "an empty cell sets nothing");
    assert.equal(first(r).metadata.bloom, undefined);
  });

  test("the words people use for a difficulty and a Bloom level are the ones the text reader knows", () => {
    const rows = [["Easy", "Remember"], ["moderate", "Understanding"], ["DIFFICULT", "Application"], ["simple", "Analysis"], ["average", "Evaluation"], ["challenging", "Synthesis"]];
    const r = csv(`Question,A,B,Correct,Difficulty,Bloom\n${rows.map(([d, b], i) => `Q${i}?,a,b,A,${d},${b}`).join("\n")}`);
    assert.deepEqual(r.questions.map((q) => q.metadata.difficulty), ["easy", "medium", "hard", "easy", "medium", "hard"]);
    assert.deepEqual(r.questions.map((q) => q.metadata.bloom), ["remember", "understand", "apply", "analyze", "evaluate", "create"]);
  });

  test("a difficulty that is a number is not turned into easy, medium or hard, because a number could be a place on any scale", () => {
    const r = csv("Question,A,B,Correct,Difficulty\nOne?,a,b,A,1\nTwo?,a,b,A,3\nThree?,a,b,A,5");
    assert.deepEqual(r.questions.map((q) => q.metadata.difficulty), [undefined, undefined, undefined]);
    assert.deepEqual(r.questions.map((q) => q.metadata.custom?.["Difficulty"]), ["1", "3", "5"]);
    assert.match(said(r.questions[1] as Question), /Difficulty "3" is a number, and a number could be a place on any scale \(1 to 3, 1 to 5\)/);
  });

  test("a difficulty or a level that is not known is kept as written, under its own name, and said", () => {
    const q = first(csv("Question,A,B,Correct,Difficulty,Bloom\nWhich?,a,b,A,5 of 5,Metacognition"));
    assert.equal(q.metadata.difficulty, undefined);
    assert.equal(q.metadata.bloom, undefined);
    assert.equal(q.metadata.custom?.["Difficulty"], "5 of 5");
    assert.equal(q.metadata.custom?.["Bloom level"], "Metacognition");
    assert.match(said(q), /Difficulty "5 of 5" was not recognised \(easy, medium or hard\), so it was kept as written/);
    assert.match(said(q), /Bloom level "Metacognition" was not recognised/);
    assert.ok(liveFindings(q.findings).some((f) => f.code === FindingCode.UnknownMetadataLabel && f.severity === "warn"));
    assert.equal(validateQuestion(q).ok, true);
  });

  test("a word that is a property of every object is not a level", () => {
    const q = first(csv("Question,A,B,Correct,Difficulty,Bloom\nWhich?,a,b,A,constructor,__proto__"));
    assert.equal(q.metadata.difficulty, undefined);
    assert.equal(q.metadata.bloom, undefined);
    assert.equal(q.metadata.custom?.["Difficulty"], "constructor");
    assert.equal(q.metadata.custom?.["Bloom level"], "__proto__");
  });

  test("a Category column and a Tags column are both tags, with no repeats", () => {
    const q = first(csv("Question,A,B,Correct,Category,Tags\nWhich?,a,b,A,Water,\"Water; Rain\""));
    assert.deepEqual(q.metadata.tags, ["Water", "Rain"]);
  });

  test("the question's number is kept beside them", () => {
    const q = first(csv("Question ID,Question,A,B,Correct,Chapter\nQ-9,Which?,a,b,A,2"));
    assert.equal(q.metadata.custom?.["Question ID"], "Q-9");
    assert.equal(q.metadata.chapter, "2");
  });

  test("a workbook's numbers are read as the words they are shown as", () => {
    const bytes = writeXlsx([{ name: "Questions", rows: [["Question", "A", "B", "Correct", "Chapter", "Difficulty"], ["Which?", "a", "b", "A", 3, 2]] }]);
    const q = first(spreadsheetImporter.parseBytes?.(bytes, { file: "questions.xlsx", at: AT, author: "test" }) as ImportResult);
    assert.equal(q.metadata.chapter, "3");
    assert.equal(q.metadata.difficulty, undefined, "a number is not a difficulty");
    assert.equal(q.metadata.custom?.["Difficulty"], "2");
  });

  test("Coverage can count by them, which is what they were wanted for", () => {
    const r = csv("Question,A,B,Correct,Chapter,Difficulty\nOne?,a,b,A,1,easy\nTwo?,a,b,A,1,hard\nThree?,a,b,A,2,hard");
    const grid = coverage(r.questions, "chapter", "difficulty");
    const cell = (row: string, col: string): number => (grid.cells[grid.rowLabels.indexOf(row)] as number[])[grid.colLabels.indexOf(col)] ?? 0;
    assert.equal(cell("1", "easy"), 1);
    assert.equal(cell("1", "hard"), 1);
    assert.equal(cell("2", "hard"), 1);
    assert.equal(grid.total, 3);
  });
});

describe("the other names a table gives its columns", () => {
  test("Questions, Marks, Ans and Q Type are the columns they stand for", () => {
    const q = first(csv("Q Type,Questions,A,B,Ans,Marks\nMC,Which?,a,b,B,2"));
    const typed = first(csv("Q Type,Questions,A,B,Marks\nSA,Name the capital of France.,Paris,paris,3"));
    assert.equal(typed.type, "shortAnswer", "Q Type is the Type column");
    assert.equal(typed.points, 3);
    assert.equal(q.type, "multipleChoice");
    assert.equal(q.points, 2);
    assert.deepEqual((q.body as unknown as { options: Array<{ correct: boolean }> }).options.map((o) => o.correct), [false, true]);
  });
});
