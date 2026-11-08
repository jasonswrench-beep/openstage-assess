/**
 * A question table whose answer columns are numbered ("Option 1" to "Option 4"), with a number in the Correct column.
 *
 * Many tables name their answer columns this way, and the reader knew only letters, so such a table came in with no answers at
 * all: the columns were reported as not used and every row was kept as an essay. A number is read as a place only where the answer
 * columns are numbered, because then the number names a column by the label it has; a letter names none in such a table, and a
 * number names none in a table with lettered columns. A number that is also the words of another answer is not guessed at. The
 * text here is invented.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { writeXlsx } from "../src/container/xlsx.ts";
import { spreadsheetImporter } from "../src/import/spreadsheet.ts";
import type { ImportResult } from "../src/import/types.ts";
import { FindingCode, liveFindings, verdictFrom } from "../src/model/findings.ts";
import type { Question } from "../src/model/question.ts";
import { richTextToPlain } from "../src/model/richtext.ts";

const AT = "2026-11-07T00:00:00.000Z";
const csv = (text: string): ImportResult => spreadsheetImporter.parseBytes?.(new Uint8Array(Buffer.from(text, "utf8")), { file: "questions.csv", at: AT, author: "test" }) as ImportResult;
const plain = (v: unknown): string => richTextToPlain(v as never).replace(/\s+/g, " ").trim();
const options = (q: Question): Array<[string, boolean]> => (q.body as unknown as { options: Array<{ content: unknown; correct: boolean }> }).options.map((o) => [plain(o.content), o.correct]);
const right = (q: Question): string[] => options(q).filter(([, c]) => c).map(([t]) => t);
const said = (q: Question): string => liveFindings(q.findings).map((f) => `${f.severity}: ${f.message}`).join(" | ");
const first = (r: ImportResult): Question => r.questions[0] as Question;

const HEAD = "Question,Option 1,Option 2,Option 3,Option 4,Correct";

describe("answer columns named by number", () => {
  test("are read in order, and the number in the Correct cell names the column", () => {
    const r = csv(`${HEAD}\nWhich is the capital of France?,Rome,Paris,Madrid,Berlin,2`);
    const q = first(r);
    assert.deepEqual(options(q), [["Rome", false], ["Paris", true], ["Madrid", false], ["Berlin", false]]);
    assert.equal(verdictFrom(q.findings), "parsed");
    assert.ok(!r.fileFindings.some((f) => /not used/.test(f.message)), r.fileFindings.map((f) => f.message).join("\n"));
  });

  test("the number is the number in the column's name, wherever the column stands in the sheet", () => {
    const r = csv("Question,Option 3,Option 1,Option 2,Correct\nWhich?,third,first,second,3");
    const q = first(r);
    assert.deepEqual(options(q), [["first", false], ["second", false], ["third", true]]);
  });

  test("several numbers are several right answers, with a Type to say so, or a warning without one", () => {
    const typed = csv(`Type,${HEAD}\nMR,Which are prime?,Two,Four,Five,Six,"1, 3"`);
    assert.equal(first(typed).type, "multipleResponse");
    assert.deepEqual(right(first(typed)), ["Two", "Five"]);
    const untyped = csv(`${HEAD}\nWhich are prime?,Two,Four,Five,Six,"1, 3"`);
    assert.equal(first(untyped).type, "multipleResponse");
    assert.deepEqual(right(first(untyped)), ["Two", "Five"]);
    assert.match(said(first(untyped)), /The Correct cell names 1, 3, and the Type cell is empty/);
  });

  test("the words of an answer in the Correct cell still work", () => {
    const q = first(csv(`${HEAD}\nWhich?,Rome,Paris,Madrid,Berlin,Paris`));
    assert.deepEqual(right(q), ["Paris"]);
  });

  test("a number past the last answer is an error that names the columns that are filled in, and nothing is marked", () => {
    const q = first(csv(`${HEAD}\nWhich?,Rome,Paris,Madrid,Berlin,5`));
    assert.deepEqual(right(q), []);
    assert.match(said(q), /"5" in the Correct cell is not one of the answers \(the answers filled in are 1, 2, 3, 4\)\. No answer is marked\./);
    assert.notEqual(verdictFrom(q.findings), "parsed");
  });

  test("a number that is also the words of another answer is not guessed at", () => {
    // "2" is the second column, which says 5, and it is the words of the first answer. Nothing in the file says which was meant.
    const q = first(csv("Question,Option 1,Option 2,Option 3,Correct\nWhat is 1 + 1?,2,5,7,2"));
    assert.deepEqual(right(q), []);
    assert.match(said(q), /could be the answer in column 2 or the answer whose words are "2", and the file does not say which\. No answer is marked\./);
    assert.ok(liveFindings(q.findings).some((f) => f.code === FindingCode.KeyLetterMissing && f.severity === "error"));
  });

  test("a number that is the column and the words of the same answer is fine", () => {
    const q = first(csv("Question,Option 1,Option 2,Option 3,Correct\nWhat is 1 + 1?,7,2,5,2"));
    assert.deepEqual(right(q), ["2"]);
  });

  test("a number that names a column which has no answer in this row is an error, and is not read as the words of another answer", () => {
    // Option 2 is a column of the sheet and is empty here, and "2" is also the words of Option 3. Nothing says which was meant.
    const q = first(csv("Question,Option 1,Option 2,Option 3,Correct\nPick,x,,2,2"));
    assert.deepEqual(right(q), []);
    assert.match(said(q), /"2" in the Correct cell names answer 2, which is empty in this row\. No answer is marked\./);
    assert.notEqual(verdictFrom(q.findings), "parsed");
  });

  test("a number that names no column of the sheet at all can only be the words of an answer", () => {
    // Three answer columns, and a Correct cell that says 4, which is the words of the second answer.
    const q = first(csv("Question,Option 1,Option 2,Option 3,Correct\nHow many sides has a square?,3,4,5,4"));
    assert.deepEqual(right(q), ["4"]);
  });

  test("a true or false row of a numbered table is not read as yes or no from a number that names a column", () => {
    const ambiguous = first(csv("Type,Question,Option 1,Option 2,Correct\nTF,The sky is green,False,True,1"));
    assert.equal((ambiguous.body as unknown as { correct?: boolean }).correct, false, "column 1 holds False");
    const none = first(csv("Type,Question,Option 1,Option 2,Correct\nTF,The sky is green,,,1"));
    assert.equal((none.body as unknown as { correct?: boolean }).correct, undefined);
    assert.match(said(none), /The Correct cell says "1", which in a table with numbered answer columns names a column, and that column does not hold True or False/);
    assert.notEqual(verdictFrom(none.findings), "parsed");
    const words = first(csv("Type,Question,Option 1,Option 2,Correct\nTF,The sky is green,,,False"));
    assert.equal((words.body as unknown as { correct?: boolean }).correct, false, "the word is still read");
  });

  test("a letter that is the words of an answer is that answer, even in a numbered table", () => {
    const one = first(csv("Question,Option 1,Option 2,Option 3,Correct\nWhich bar of music comes after A?,A,B,C,B"));
    assert.deepEqual(right(one), ["B"]);
    const two = first(csv('Type,Question,Option 1,Option 2,Option 3,Correct\nMR,Which two follow A?,A,B,C,"B, C"'));
    assert.deepEqual(right(two), ["B", "C"]);
  });

  test("a letter names no column when the columns are numbered, and is not read as a place", () => {
    const q = first(csv(`${HEAD}\nWhich?,Rome,Paris,Madrid,Berlin,B`));
    assert.deepEqual(right(q), []);
    assert.match(said(q), /"B" in the Correct cell is not one of the answers/);
  });

  test("a number names no column when the columns are lettered", () => {
    const q = first(csv("Question,A,B,C,D,Correct\nWhich?,Rome,Paris,Madrid,Berlin,2"));
    assert.deepEqual(right(q), []);
    assert.match(said(q), /"2" in the Correct cell is not one of the answers \(the answers filled in are A, B, C, D\)/);
  });

  test("a table that mixes lettered and numbered columns reads no number as a place", () => {
    const q = first(csv("Question,A,Option 2,C,Correct\nWhich?,Rome,Paris,Madrid,2"));
    assert.deepEqual(right(q), []);
    assert.match(said(q), /"2" in the Correct cell is not one of the answers/);
  });

  test("an empty answer is a gap, said in numbers, and the numbers still mean the columns", () => {
    const q = first(csv(`${HEAD}\nWhich?,Rome,,Madrid,Berlin,3`));
    assert.deepEqual(options(q).map(([t]) => t), ["Rome", "Madrid", "Berlin"]);
    assert.deepEqual(right(q), ["Madrid"]);
    assert.match(said(q), /Answer 2 is empty, so it was left out\. The numbers in the Correct cell still mean the columns\./);
  });

  test("the same names work for the answers that are accepted in a short answer", () => {
    const q = first(csv("Type,Question,Answer 1,Answer 2\nSA,Name the capital of France.,Paris,paris"));
    assert.equal(q.type, "shortAnswer");
    assert.deepEqual((q.body as unknown as { accepted: string[] }).accepted, ["Paris", "paris"]);
  });

  test("a workbook is read the same way", () => {
    const bytes = writeXlsx([{ name: "Questions", rows: [["Question", "Choice 1", "Choice 2", "Choice 3", "Correct Answer"], ["Which?", "Rome", "Paris", "Madrid", 2]] }]);
    const r = spreadsheetImporter.parseBytes?.(bytes, { file: "questions.xlsx", at: AT, author: "test" }) as ImportResult;
    assert.deepEqual(right(first(r)), ["Paris"]);
  });
});

// A template for a quiz game writes its columns with a description after each name. Found by trying one: it read as "layout not known".
describe("a column name with a description after it", () => {
  const GAME = [
    'Question - max 95 characters,Answer 1 - max 60 characters,Answer 2 - max 60 characters,Answer 3 - max 60 characters,Answer 4 - max 60 characters,"Time limit (sec) – 5, 10, 20, 30, 60, 90, 120, or 240 secs",Correct answer(s) - choose at least one',
    '"Which planet is closest to the Sun?",Venus,Mercury,Earth,Mars,20,2',
    '"Which are gases?",Oxygen,Iron,Nitrogen,Gold,30,"1,3"',
  ].join("\n");

  test("is its name, so a quiz game's template is read: the numbers in the last column name the answer columns", () => {
    const r = csv(GAME);
    assert.equal(r.questions.length, 2);
    assert.deepEqual(right(first(r)), ["Mercury"]);
    assert.equal(verdictFrom(first(r).findings), "parsed");
    const second = r.questions[1] as Question;
    assert.equal(second.type, "multipleResponse");
    assert.deepEqual(right(second), ["Oxygen", "Nitrogen"]);
    assert.match(said(second), /read as a multiple response\. Check that it is/);
  });

  test("a column that is not one of ours is still said not to be used, by the whole of its name", () => {
    const r = csv(GAME);
    const note = r.fileFindings.find((f) => /not used/.test(f.message));
    assert.match(note?.message ?? "", /These columns were not used: Time limit \(sec\)/);
  });

  test("is never cut when the whole of the cell is a name, and a bracket of a letter or a number is not a description", () => {
    // "Feedback - if right" is a name of its own (feedback for a right answer) and must not become the general Feedback column.
    const feedback = csv("Question,A,B,Correct,Feedback - if right\nWhich?,x,y,B,Yes it is");
    assert.equal(plain((first(feedback).feedback as { correct?: unknown }).correct ?? ""), "Yes it is");
    assert.equal(first(feedback).feedback.general, undefined);
    // "Option (A)" and "Answer (1)" are the columns for A and 1.
    assert.deepEqual(right(first(csv("Question,Option (A),Option (B),Correct\nWhich?,x,y,B"))), ["y"]);
    assert.deepEqual(right(first(csv("Question,Answer (1),Answer (2),Correct\nWhich?,x,y,2"))), ["y"]);
  });

  test("a name whose cut form is not a name either is left alone, and so is a dash with no spaces", () => {
    const r = csv("Question,A,B,Correct,Note - for me\nWhich?,x,y,A,remember");
    assert.match(r.fileFindings.map((f) => f.message).join("\n"), /These columns were not used: Note - for me/);
    const hyphen = csv("Question,A,B,Correct,Multi-part\nWhich?,x,y,A,z");
    assert.match(hyphen.fileFindings.map((f) => f.message).join("\n"), /These columns were not used: Multi-part/);
  });

  test("a table that is only text with a dash in its first cell is not taken for one with a question column", () => {
    const r = csv("Notes on the week - a few lines,second cell\nmore text,still more");
    assert.equal(r.questions.length, 0);
  });
});

describe("what a description may and may not cut", () => {
  test("a bracket that holds a letter is part of the name, even when a description follows it", () => {
    const r = csv("Question,Option (A) - max 60 characters,Option (B) - max 60 characters,Correct\nWhich?,x,y,B");
    assert.deepEqual(right(first(r)), ["y"]);
    assert.ok(!r.fileFindings.some((f) => /not used/.test(f.message)), r.fileFindings.map((f) => f.message).join("\n"));
  });

  test("a hyphen with no spaces is part of a word, so a name that begins like another is not that column", () => {
    const r = csv("Question,A,B,Correct,Chapter-notes\nWhich?,x,y,A,Unit 4");
    assert.equal(first(r).metadata.chapter, undefined, "Chapter-notes is not the Chapter column");
    assert.match(r.fileFindings.map((f) => f.message).join("\n"), /These columns were not used: Chapter-notes/);
  });
});
