/**
 * The question table importer: a list of questions in Excel or CSV. The rules under test are the ones every importer keeps (a
 * key is read only where a cell gives one, nothing is dropped without a word, a question that cannot be built is kept and
 * fails) and the ones a table adds: a row is found by the number a spreadsheet shows, a workbook is read as the untrusted file
 * it is, and what Excel stores in a cell is what the importer reads, not what the cell looks like. The text is invented.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { textEntry, zipSync } from "../src/container/zip.ts";
import { writeXlsx, type XlsxCell } from "../src/container/xlsx.ts";
import { importerForContent, runImporter } from "../src/import/registry.ts";
import { looksLikeQuestionTable, spreadsheetImporter } from "../src/import/spreadsheet.ts";
import { readCsv } from "../src/import/table-csv.ts";
import { readXlsx } from "../src/import/table-xlsx.ts";
import { TableError } from "../src/import/table.ts";
import type { ImportResult } from "../src/import/types.ts";
import { FindingCode, liveFindings, verdictFrom } from "../src/model/findings.ts";
import { richTextToPlain } from "../src/model/richtext.ts";
import type { Question } from "../src/model/question.ts";

const AT = "2026-01-01T00:00:00.000Z";
const OPTIONS = { file: "questions.csv", at: AT, author: "test" };
const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "utf8"));
const csv = (text: string, file = "questions.csv"): ImportResult => spreadsheetImporter.parseBytes?.(bytes(text), { ...OPTIONS, file }) as ImportResult;
const xlsx = (rows: XlsxCell[][]): ImportResult => spreadsheetImporter.parseBytes?.(writeXlsx([{ name: "Questions", rows }]), { ...OPTIONS, file: "questions.xlsx" }) as ImportResult;

const plain = (q: Question): string => richTextToPlain(q.stem);
const verdict = (q: Question): string => verdictFrom(q.findings);
const codes = (q: Question): string[] => liveFindings(q.findings).map((f) => f.code);
const has = (q: Question, code: string): boolean => codes(q).includes(code);
const body = (q: Question): Record<string, unknown> => q.body as unknown as Record<string, unknown>;
const options = (q: Question): Array<[string, boolean]> =>
  (body(q)["options"] as Array<{ content: unknown; correct: boolean }>).map((o) => [richTextToPlain(o.content as never), o.correct]);
const fileNotes = (r: ImportResult): string[] => r.fileFindings.map((f) => `${f.severity}: ${f.message}`);
const only = (r: ImportResult): Question => {
  assert.equal(r.questions.length, 1, "one question");
  return r.questions[0] as Question;
};

const HEAD = "Type,Question,A,B,C,D,Correct,Points,Feedback if right,Feedback if wrong";

// ---------------------------------------------------------------------------
// The kinds of question, and the key
// ---------------------------------------------------------------------------

describe("a table of questions", () => {
  test("reads the template OpenStage Author gives, every kind of question with its key", () => {
    const r = csv(
      [
        "Type,Question,A,B,C,D,E,Correct,Points,Feedback if right,Feedback if wrong",
        "MC,Which channel suits a quick yes or no between two colleagues?,A short message,A formal letter,A staff meeting,A printed memo,,A,10,Right: quick.,Not quite.",
        "MC,Which of these is a planet?,Mars,The Moon,The Sun,Sirius,Halley's Comet,A,,,",
        'MR,Which of these help a reader decide what to read first?,A clear subject line,A long first paragraph,A short summary at the top,Writing in capital letters,,"A, C",10,,',
        "TF,A reply to everyone is always the right choice.,,,,,,False,,,",
        "SA,What is the name of the movement of ideas from one person to another?,Communication,communicating,,,,,,,",
      ].join("\r\n"),
    );
    assert.deepEqual(r.questions.map((q) => q.type), ["multipleChoice", "multipleChoice", "multipleResponse", "trueFalse", "shortAnswer"]);
    assert.deepEqual(r.questions.map(verdict), ["parsed", "parsed", "parsed", "parsed", "parsed"]);
    assert.deepEqual(options(r.questions[0] as Question), [["A short message", true], ["A formal letter", false], ["A staff meeting", false], ["A printed memo", false]]);
    assert.deepEqual(options(r.questions[2] as Question).map((o) => o[1]), [true, false, true, false]);
    assert.equal(body(r.questions[3] as Question)["correct"], false);
    assert.deepEqual(body(r.questions[4] as Question)["accepted"], ["Communication", "communicating"]);
    assert.equal((r.questions[0] as Question).points, 10);
    assert.equal(richTextToPlain((r.questions[0] as Question).feedback.correct as never), "Right: quick.");
    assert.equal(richTextToPlain((r.questions[0] as Question).feedback.incorrect as never), "Not quite.");
    assert.deepEqual(r.counts, { parsed: 5, needsReview: 0, failed: 0, orphans: 0 });
  });

  test("an empty Correct cell leaves no answer marked, and says so, whatever the type", () => {
    const r = csv([HEAD, "MC,Q one?,a,b,c,,,,,", "MR,Q two?,a,b,c,,,,,", "TF,Q three?,,,,,,,,", "SA,Q four?,,,,,,,,"].join("\n"));
    assert.equal(r.questions.length, 4);
    for (const q of r.questions) {
      assert.equal(verdict(q), "failed", plain(q));
      assert.ok(has(q, FindingCode.NoAnswerKey), plain(q));
    }
    assert.deepEqual(options(r.questions[0] as Question).map((o) => o[1]), [false, false, false]);
    assert.equal(body(r.questions[2] as Question)["correct"], undefined);
    assert.deepEqual(body(r.questions[3] as Question)["accepted"], []);
    // The check says what is wrong in general, and the importer says where: which cell was empty.
    for (const q of r.questions) assert.ok(liveFindings(q.findings).some((f) => f.code === FindingCode.KeyLetterMissing && /empty/.test(f.message)), plain(q));
  });

  test("a letter that names an empty answer marks nothing, and the question says which letters it has", () => {
    const q = only(csv([HEAD, "MC,Q?,a,b,c,,D,,,"].join("\n")));
    assert.equal(verdict(q), "failed");
    assert.ok(has(q, FindingCode.KeyLetterMissing));
    const message = liveFindings(q.findings).find((f) => f.code === FindingCode.KeyLetterMissing)?.message ?? "";
    assert.match(message, /"D"/);
    assert.match(message, /A, B, C/);
    assert.deepEqual(options(q).map((o) => o[1]), [false, false, false]);
  });

  test("one wrong letter among right ones marks none of them: a half-applied key is not a key", () => {
    const q = only(csv([HEAD, 'MR,Q?,a,b,c,,"A, E",,,'].join("\n")));
    assert.ok(has(q, FindingCode.KeyLetterMissing));
    assert.deepEqual(options(q).map((o) => o[1]), [false, false, false]);
  });

  test("a letter means its column, so a gap between answers does not move the key", () => {
    const q = only(csv([HEAD, "MC,Q?,first,,third,,C,,,"].join("\n")));
    assert.deepEqual(options(q), [["first", false], ["third", true]]);
    assert.ok(has(q, FindingCode.OptionLetterGap));
  });

  test("the words of an answer in the Correct cell are an answer, with commas and spaces in them", () => {
    const q = only(csv([HEAD, 'MC,Q?,"Paris, France",Rome,Berlin,,"Paris, France",,,'].join("\n")));
    assert.deepEqual(options(q).map((o) => o[1]), [true, false, false]);
    assert.equal(verdict(q), "parsed");
  });

  test("two letters on a question typed MC mark both and fail it; the person chooses", () => {
    const q = only(csv([HEAD, 'MC,Q?,a,b,c,,"A, B",,,'].join("\n")));
    assert.equal(q.type, "multipleChoice");
    assert.deepEqual(options(q).map((o) => o[1]), [true, true, false]);
    assert.ok(has(q, FindingCode.MultipleKeysOnSingleAnswer));
    assert.equal(verdict(q), "failed");
  });

  test("two letters and no type make a multiple response, and the question is flagged", () => {
    const q = only(csv([HEAD, ',Q?,a,b,c,,"A and C",,,'].join("\n")));
    assert.equal(q.type, "multipleResponse");
    assert.deepEqual(options(q).map((o) => o[1]), [true, false, true]);
    assert.ok(has(q, FindingCode.MoreThanOneRight));
    assert.equal(verdict(q), "needsReview");
  });

  test("a multiple response with one letter stays a multiple response", () => {
    const q = only(csv([HEAD, "MR,Q?,a,b,c,,B,,,"].join("\n")));
    assert.equal(q.type, "multipleResponse");
    assert.deepEqual(options(q).map((o) => o[1]), [false, true, false]);
  });

  test("true or false: a word, or the letter of an answer that says True or False", () => {
    const r = csv([HEAD, "TF,Q one?,,,,,true,,,", "TF,Q two?,,,,,F,,,", "TF,Q three?,True,False,,,B,,,", "TF,Q four?,False,True,,,B,,,", "TF,Q five?,,,,,maybe,,,"].join("\n"));
    assert.deepEqual(r.questions.map((q) => body(q)["correct"]), [true, false, false, true, undefined]);
    const maybe = r.questions[4] as Question;
    assert.ok(has(maybe, FindingCode.KeyLetterMissing));
    assert.equal(verdict(maybe), "failed");
    // True and False written in the answer columns are not "content that was not read".
    assert.equal(has(r.questions[2] as Question, FindingCode.UnreadContent), false);
  });

  test("answers written on a true or false row that are not True or False are reported, with their words", () => {
    const q = only(csv([HEAD, "TF,Q?,Paris,Rome,,,True,,,"].join("\n")));
    const note = liveFindings(q.findings).find((f) => f.code === FindingCode.UnreadContent)?.message ?? "";
    assert.match(note, /Paris/);
    assert.match(note, /Rome/);
  });

  test("a short answer takes its accepted answers from the answer cells, or from the Correct cell split at bars", () => {
    const r = csv([HEAD, "SA,Q one?,Paris,paris,,,,,,", 'SA,Q two?,,,,,"Na | Sodium",,,', "SA,Q three?,Paris,,,,Lyon,,,"].join("\n"));
    assert.deepEqual(body(r.questions[0] as Question)["accepted"], ["Paris", "paris"]);
    assert.deepEqual(body(r.questions[1] as Question)["accepted"], ["Na", "Sodium"]);
    // Both given: the answer cells win, and the Correct cell is said not to have been used.
    assert.deepEqual(body(r.questions[2] as Question)["accepted"], ["Paris"]);
    assert.match(liveFindings((r.questions[2] as Question).findings).find((f) => f.code === FindingCode.UnreadContent)?.message ?? "", /Lyon/);
  });

  test("an essay needs no key, and answers written on one are reported", () => {
    const r = csv([HEAD, "ES,Discuss.,,,,,,5,,", "ES,Explain.,a,b,,,A,,,"].join("\n"));
    assert.deepEqual(r.questions.map((q) => q.type), ["essay", "essay"]);
    assert.equal(verdict(r.questions[0] as Question), "parsed");
    assert.equal((r.questions[0] as Question).points, 5);
    assert.ok(has(r.questions[1] as Question, FindingCode.UnreadContent));
  });

  test("a type that is not one of the five is kept as an essay with its answers quoted, and fails", () => {
    const q = only(csv([HEAD, "MT,Match these.,Cat,Dog,,,A,,,"].join("\n")));
    assert.equal(q.type, "essay");
    assert.ok(has(q, FindingCode.UnsupportedType));
    assert.equal(verdict(q), "failed");
    const message = liveFindings(q.findings).find((f) => f.code === FindingCode.UnsupportedType)?.message ?? "";
    assert.match(message, /"MT"/);
    assert.match(message, /Cat/);
  });

  test("an empty type is worked out from the row, and only where the row says it", () => {
    const r = csv([HEAD, ",Plain choice?,a,b,,,B,,,", ",It is true.,,,,,True,,,", ",One answer only?,solo,,,,A,,,", ",Nothing here.,,,,,,,,"].join("\n"));
    assert.deepEqual(r.questions.map((q) => q.type), ["multipleChoice", "trueFalse", "essay", "essay"]);
    assert.ok(has(r.questions[1] as Question, FindingCode.TypeInferred));
    // An essay made because a row did not say what it was is flagged, with what was not used.
    const solo = r.questions[2] as Question;
    assert.equal(verdict(solo), "needsReview");
    assert.match(liveFindings(solo.findings).find((f) => f.code === FindingCode.TypeInferred)?.message ?? "", /solo/);
  });

  test("a multiple choice with fewer than two answers gets placeholders and fails", () => {
    const q = only(csv([HEAD, "MC,Q?,only,,,,A,,,"].join("\n")));
    assert.deepEqual(options(q).map((o) => o[0]), ["only", "(missing)"]);
    assert.ok(has(q, FindingCode.TooFewOptions));
    assert.equal(verdict(q), "failed");
  });

  test("points are read as the file says, and a cell that is not a number is said, not guessed", () => {
    const r = csv([HEAD, "MC,Q one?,a,b,,,A,2.5,,", 'MC,Q two?,a,b,,,A,"2,5",,', "MC,Q three?,a,b,,,A,ten,,", "MC,Q four?,a,b,,,A,-3,,", "MC,Q five?,a,b,,,A,,,"].join("\n"));
    assert.deepEqual(r.questions.map((q) => q.points), [2.5, 2.5, 1, 1, 1]);
    assert.ok(has(r.questions[2] as Question, FindingCode.PointsAssumed));
    assert.ok(has(r.questions[3] as Question, FindingCode.PointsAssumed));
    assert.equal(has(r.questions[4] as Question, FindingCode.PointsAssumed), false);
  });

  test("category becomes a tag, and an explanation becomes general feedback", () => {
    const q = only(csv(["Question,A,B,Correct,Category,Explanation", "Q?,a,b,A,Week 3,Because."].join("\n")));
    assert.deepEqual(q.metadata.tags, ["Week 3"]);
    assert.equal(richTextToPlain(q.feedback.general as never), "Because.");
  });

  test("a line break inside a cell is kept in the question", () => {
    const q = only(csv([HEAD, 'MC,"First line.\nSecond line.",a,b,,,A,,,'].join("\n")));
    assert.equal(plain(q).includes("First line."), true);
    assert.equal(plain(q).includes("Second line."), true);
    assert.notEqual(plain(q), "First line. Second line.");
  });

  test("text that looks like markup is text", () => {
    const q = only(csv([HEAD, 'MC,"What does <b>bold</b> do & why?",<i>x</i>,b,,,A,,,'].join("\n")));
    assert.ok(plain(q).includes("<b>bold</b> do & why?"));
    assert.equal(options(q)[0]?.[0], "<i>x</i>");
  });
});

// ---------------------------------------------------------------------------
// The columns
// ---------------------------------------------------------------------------

describe("the columns of a table", () => {
  test("the first row names them in any order, in any case, under the names Author knows", () => {
    const q = only(csv(["correct,ANSWER CHOICE B,Answer Choice A,prompt,tries,type", "B,Paris,Berlin,Capital of France?,3,mc"].join("\n")));
    assert.equal(plain(q), "Capital of France?");
    assert.deepEqual(options(q), [["Berlin", false], ["Paris", true]]);
  });

  test("columns that were not understood are named, and what they hold is said not to be in the questions", () => {
    const r = csv(["Question,A,B,Correct,Difficulty,Chapter", "Q?,a,b,A,hard,3"].join("\n"));
    const note = fileNotes(r).find((n) => /not used/.test(n)) ?? "";
    assert.match(note, /Difficulty/);
    assert.match(note, /Chapter/);
  });

  test("a column that repeats one already read is not read, and is named", () => {
    const r = csv(["Question,A,B,Correct,Question", "First?,a,b,A,Second?"].join("\n"));
    assert.equal(plain(only(r)), "First?");
    assert.match(fileNotes(r).join("\n"), /repeat/);
  });

  test("a column of question numbers is not the question column", () => {
    const q = only(csv(["Question #,Question,A,B,Correct", "1,Which?,a,b,B"].join("\n")));
    assert.equal(plain(q), "Which?");
  });

  test("an Attempts column is not stored, and the file says why", () => {
    const r = csv(["Question,A,B,Correct,Attempts", "Q?,a,b,A,3"].join("\n"));
    assert.match(fileNotes(r).join("\n"), /Attempts[^.]*not used/);
    assert.equal(JSON.stringify(only(r)).includes("attempts"), false);
  });

  test("with no row of names the columns are the template's, and the file says that it assumed so", () => {
    const r = csv("MC,Which?,a,b,c,,,B,2,,\nTF,True?,,,,,,True");
    assert.deepEqual(r.questions.map((q) => q.type), ["multipleChoice", "trueFalse"]);
    assert.deepEqual(options(r.questions[0] as Question).map((o) => o[1]), [false, true, false]);
    assert.equal(r.questions[0]?.points, 2);
    assert.match(fileNotes(r).join("\n"), /template/);
  });

  test("with no row of names and a layout nobody has told it, nothing is read, so no word lands in the wrong column", () => {
    // Read in the template's order, "Which?" would be the type, and the letter in the sixth column an answer, not the key.
    const r = csv("1,Which?,a,b,c,B\n2,Which else?,a,b,c,C");
    assert.equal(r.questions.length, 0);
    assert.equal(r.orphans.length, 0);
    assert.match(fileNotes(r).join("\n"), /warn: No row names the columns[^.]*nothing was read/);
  });

  test("a title above the row of names is reported, not read as a question", () => {
    const r = csv(["Final exam bank,,,", "Spring 2026,,,", "Question,A,B,Correct", "Q?,a,b,A"].join("\n"));
    assert.equal(r.questions.length, 1);
    assert.equal(r.orphans.length, 2);
    assert.match(r.orphans[0]?.text ?? "", /Final exam bank/);
  });

  test("a row with no question is an orphan, with what it holds; a wholly empty row is nothing", () => {
    const r = csv(["Question,A,B,Correct", "Q one?,a,b,A", ",,,", ",x,y,B", "Q two?,a,b,B"].join("\n"));
    assert.equal(r.questions.length, 2);
    assert.equal(r.orphans.length, 1);
    assert.match(r.orphans[0]?.text ?? "", /x \| y \| B/);
    assert.match(r.orphans[0]?.reason ?? "", /no question text/);
  });

  test("no question at all is a warning, not a silence", () => {
    const r = csv("Nothing,Useful\n1,2");
    assert.equal(r.questions.length, 0);
    assert.match(fileNotes(r).join("\n"), /warn: .*No question was found/);
  });
});

// ---------------------------------------------------------------------------
// Where a question came from
// ---------------------------------------------------------------------------

describe("where a row is", () => {
  test("a question's source is its line in the rows shown, and the row number in that line is the spreadsheet's", () => {
    const r = csv(["Question,A,B,Correct", "", "Q one?,a,b,A", ",,,", "", "Q two?,a,b,B"].join("\n"));
    assert.deepEqual(r.sourceLines, [
      "Row 1: Question | A | B | Correct",
      "Row 3: Question: Q one? | A: a | B: b | Correct: A",
      "Row 6: Question: Q two? | A: a | B: b | Correct: B",
    ]);
    assert.deepEqual(r.questions.map((q) => q.origin?.source), [
      { file: "questions.csv", firstBlock: 1, lastBlock: 1 },
      { file: "questions.csv", firstBlock: 2, lastBlock: 2 },
    ]);
    assert.equal(r.questions[0]?.origin?.profile, "spreadsheet");
  });

  test("a line break in a cell is one line of the source", () => {
    const r = csv(["Question,A,B,Correct", '"one\ntwo",a,b,A'].join("\n"));
    assert.equal(r.sourceLines?.length, 2);
    assert.match(r.sourceLines?.[1] ?? "", /one ↵ two/);
  });
});

// ---------------------------------------------------------------------------
// CSV as spreadsheets save it
// ---------------------------------------------------------------------------

describe("CSV as a spreadsheet program saves it", () => {
  test("a byte order mark, quotes holding commas, and doubled quotes", () => {
    const q = only(csv('﻿Question,A,B,Correct\n"He said ""no"", then left.","a, b",c,B'));
    assert.equal(plain(q), 'He said "no", then left.');
    assert.deepEqual(options(q), [["a, b", false], ["c", true]]);
  });

  test("semicolons, where a comma is the decimal mark, and tabs, as Unicode text", () => {
    assert.deepEqual(options(only(csv("Question;A;B;Correct;Points\nQ?;a;b;B;1,5"))), [["a", false], ["b", true]]);
    assert.equal(only(csv("Question;A;B;Correct;Points\nQ?;a;b;B;1,5")).points, 1.5);
    assert.deepEqual(options(only(csv("Question\tA\tB\tCorrect\nQ?\ta\tb\tB"))), [["a", false], ["b", true]]);
  });

  test("UTF-16, which is what Excel's Unicode Text is", () => {
    const text = "Question\tA\tB\tCorrect\nWhat is café?\tcoffee\ttea\tA";
    const body16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    const r = runImporter(spreadsheetImporter, new Uint8Array(body16), OPTIONS);
    assert.equal(plain(only(r)), "What is café?");
    assert.match(fileNotes(r).join("\n"), /UTF-16/);
    const swapped = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()]);
    assert.equal(plain(only(runImporter(spreadsheetImporter, new Uint8Array(swapped), OPTIONS))), "What is café?");
  });

  test("the Windows code page of Excel's plain CSV is read as that, and said", () => {
    const body1252 = Buffer.concat([Buffer.from("Question,A,B,Correct\nWhat is caf", "latin1"), Buffer.from([0xe9]), Buffer.from("?,coffee,tea,A", "latin1")]);
    const r = runImporter(spreadsheetImporter, new Uint8Array(body1252), OPTIONS);
    assert.equal(plain(only(r)), "What is café?");
    assert.match(fileNotes(r).join("\n"), /Windows Western/);
  });

  test("bytes that are not text are refused, not read as garbage", () => {
    assert.throws(() => readCsv(new Uint8Array([0x51, 0x00, 0x75, 0x00, 0x00, 0x00])), TableError);
  });

  test("Windows line endings, old Mac ones, and no ending on the last row", () => {
    assert.equal(csv("Question,A,B,Correct\r\nQ one?,a,b,A\rQ two?,a,b,B").questions.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

describe("an Excel workbook", () => {
  test("reads what the writer wrote: text, numbers, a true or false cell, line breaks and an empty cell", () => {
    const r = xlsx([
      ["Type", "Question", "A", "B", "Correct", "Points"],
      ["MC", "Which?\nSecond line.", "Paris", "Rome", "A", 2.5],
      ["TF", "It is true.", null, null, true, 1],
    ]);
    assert.equal(r.questions.length, 2);
    assert.equal(r.questions[0]?.points, 2.5);
    assert.ok(plain(r.questions[0] as Question).includes("Second line."));
    // Excel turns a typed TRUE into a boolean cell, and the key is True.
    assert.equal(body(r.questions[1] as Question)["correct"], true);
    assert.equal(r.sourceLines?.[1]?.startsWith("Row 2: "), true);
  });

  test("a boolean FALSE in the Correct cell is the key False, not a missing one", () => {
    assert.equal(body(only(xlsx([["Type", "Question", "Correct"], ["TF", "It is false.", false]])))["correct"], false);
  });

  test("a number is read as the number Excel shows, not as the float it is stored as", () => {
    const sheet = (v: string): ImportResult => runWorkbook({ sheets: [{ name: "S", rows: `<row r="1"><c r="A1" t="inlineStr"><is><t>Question</t></is></c><c r="B1" t="inlineStr"><is><t>Points</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Q?</t></is></c><c r="B2"><v>${v}</v></c></row>` }] });
    assert.equal(only(sheet("0.30000000000000004")).points, 0.3);
    assert.equal(only(sheet("10")).points, 10);
    assert.equal(only(sheet("2.5")).points, 2.5);
  });

  test("a sheet that is not the first is read when it names a Question column, and the others are said not to be", () => {
    const wb = writeXlsx([
      { name: "Notes", rows: [["Read me"], ["Some notes."]] },
      { name: "Week 1", rows: [["Question", "A", "B", "Correct"], ["Q one?", "a", "b", "A"]] },
      { name: "Week 2", rows: [["Question", "A", "B", "Correct"], ["Q two?", "a", "b", "B"]] },
    ]);
    const r = runImporter(spreadsheetImporter, wb, { ...OPTIONS, file: "q.xlsx" });
    assert.deepEqual(r.questions.map(plain), ["Q one?", "Q two?"]);
    assert.match(fileNotes(r).join("\n"), /info: .*"Notes" was not read/);
    assert.deepEqual(r.sourceLines?.filter((l) => l.startsWith("Sheet:")), ["Sheet: Week 1", "Sheet: Week 2"]);
  });

  test("a sheet laid out as a table that names no Question column is a warning, not a footnote", () => {
    const wb = writeXlsx([
      { name: "Main", rows: [["Question", "A", "B", "Correct"], ["Q?", "a", "b", "A"]] },
      { name: "Extra", rows: [["Prompt Text", "Option One", "Option Two", "Key"], ["Q?", "a", "b", "A"], ["Q2?", "a", "b", "B"]] },
    ]);
    const r = runImporter(spreadsheetImporter, wb, { ...OPTIONS, file: "q.xlsx" });
    assert.equal(r.questions.length, 1);
    assert.match(fileNotes(r).join("\n"), /warn: .*"Extra" was not read/);
  });

  test("hidden rows and hidden sheets are read all the same, and counted", () => {
    const r = runWorkbook({
      sheets: [
        { name: "S", rows: `<row r="1"><c r="A1" t="inlineStr"><is><t>Question</t></is></c><c r="B1" t="inlineStr"><is><t>A</t></is></c><c r="C1" t="inlineStr"><is><t>B</t></is></c><c r="D1" t="inlineStr"><is><t>Correct</t></is></c></row><row r="2" hidden="1"><c r="A2" t="inlineStr"><is><t>Hidden one?</t></is></c><c r="B2" t="inlineStr"><is><t>a</t></is></c><c r="C2" t="inlineStr"><is><t>b</t></is></c><c r="D2" t="inlineStr"><is><t>A</t></is></c></row>`, state: "hidden" },
      ],
    });
    assert.deepEqual(r.questions.map(plain), ["Hidden one?"]);
    const notes = fileNotes(r).join("\n");
    assert.match(notes, /1 row is hidden/);
    assert.match(notes, /1 sheet is hidden/);
  });

  test("a formula with no stored result is read as empty and named, because an empty Correct is a missing key", () => {
    const r = runWorkbook({
      sheets: [{ name: "S", rows: `<row r="1"><c r="A1" t="inlineStr"><is><t>Question</t></is></c><c r="B1" t="inlineStr"><is><t>A</t></is></c><c r="C1" t="inlineStr"><is><t>B</t></is></c><c r="D1" t="inlineStr"><is><t>Correct</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Q?</t></is></c><c r="B2" t="inlineStr"><is><t>a</t></is></c><c r="C2" t="inlineStr"><is><t>b</t></is></c><c r="D2"><f>IF(1=1,"A","B")</f></c></row>` }],
    });
    const q = only(r);
    assert.equal(verdict(q), "failed");
    assert.match(fileNotes(r).join("\n"), /formula with no stored result[^.]*S!D2/);
  });

  test("a formula with a stored result is read as that result", () => {
    const r = runWorkbook({
      sheets: [{ name: "S", rows: `<row r="1"><c r="A1" t="inlineStr"><is><t>Question</t></is></c><c r="B1" t="inlineStr"><is><t>A</t></is></c><c r="C1" t="inlineStr"><is><t>B</t></is></c><c r="D1" t="inlineStr"><is><t>Correct</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Q?</t></is></c><c r="B2" t="inlineStr"><is><t>a</t></is></c><c r="C2" t="inlineStr"><is><t>b</t></is></c><c r="D2" t="str"><f>"B"</f><v>B</v></c></row>` }],
    });
    assert.deepEqual(options(only(r)).map((o) => o[1]), [false, true]);
  });

  test("an error in a cell is read as empty and named, and is never taken for a key", () => {
    const r = runWorkbook({
      sheets: [{ name: "S", rows: `<row r="1"><c r="A1" t="inlineStr"><is><t>Question</t></is></c><c r="B1" t="inlineStr"><is><t>A</t></is></c><c r="C1" t="inlineStr"><is><t>B</t></is></c><c r="D1" t="inlineStr"><is><t>Correct</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Q?</t></is></c><c r="B2" t="inlineStr"><is><t>a</t></is></c><c r="C2" t="inlineStr"><is><t>b</t></is></c><c r="D2" t="e"><v>#N/A</v></c></row>` }],
    });
    assert.match(fileNotes(r).join("\n"), /error[^.]*S!D2 \(#N\/A\)/);
    const q = only(r);
    assert.deepEqual(options(q).map((o) => o[1]), [false, false]);
    // The cell is read as empty (and says so), and "#N/A" is not read as a letter that names no answer.
    const notes = liveFindings(q.findings).filter((f) => f.code === FindingCode.KeyLetterMissing);
    assert.deepEqual(notes.map((f) => f.severity), ["info"]);
    assert.equal(notes.some((f) => /N\/A/.test(f.message)), false);
    assert.equal(verdict(q), "failed");
  });

  test("a note below the first row that has the word Question in it is not the row of names", () => {
    const wb = writeXlsx([
      { name: "Main", rows: [["Question", "A", "B", "Correct"], ["Q?", "a", "b", "A"]] },
      { name: "Notes", rows: [["Notes on this bank"], ["Question", "Write the words of each question here."], ["Correct", "The letter."]] },
    ]);
    const r = runImporter(spreadsheetImporter, wb, { ...OPTIONS, file: "q.xlsx" });
    assert.deepEqual(r.questions.map(plain), ["Q?"]);
    assert.equal(r.orphans.length, 0);
    assert.match(fileNotes(r).join("\n"), /"Notes" was not read/);
  });

  test("cells given out of order, and cells left out of a row, land in their own columns", () => {
    const r = runWorkbook({
      sheets: [{ name: "S", rows: `<row r="1"><c r="B1" t="inlineStr"><is><t>Question</t></is></c><c r="D1" t="inlineStr"><is><t>Correct</t></is></c><c r="C1" t="inlineStr"><is><t>A</t></is></c><c r="E1" t="inlineStr"><is><t>B</t></is></c></row><row r="2"><c r="B2" t="inlineStr"><is><t>Q?</t></is></c><c r="C2" t="inlineStr"><is><t>x</t></is></c><c r="E2" t="inlineStr"><is><t>y</t></is></c><c r="D2" t="inlineStr"><is><t>B</t></is></c></row>` }],
    });
    assert.deepEqual(options(only(r)), [["x", false], ["y", true]]);
  });

  test("rich text in a shared string is its words, without the phonetic guide beside them", () => {
    const r = runWorkbook({
      shared: `<si><t>Question</t></si><si><r><rPr><b/></rPr><t>Rich </t></r><r><t>words?</t></r><rPh sb="0" eb="1"><t>GUIDE</t></rPh></si>`,
      sheets: [{ name: "S", rows: `<row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c></row>` }],
    });
    assert.equal(plain(only(r)), "Rich words?");
  });

  test("a workbook that writes its elements with a prefix, or in the strict namespace, is read", () => {
    const main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    const sheet = `<?xml version="1.0"?><x:worksheet xmlns:x="${main}"><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>Question</x:t></x:is></x:c></x:row><x:row r="2"><x:c r="A2" t="inlineStr"><x:is><x:t>Prefixed?</x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>`;
    assert.equal(plain(only(runWorkbook({ sheetXml: [sheet] }))), "Prefixed?");
    const strict = (ns: string): string => `<?xml version="1.0"?><worksheet xmlns="${ns}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Question</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Strict?</t></is></c></row></sheetData></worksheet>`;
    assert.equal(plain(only(runWorkbook({ sheetXml: [strict("http://purl.oclc.org/ooxml/spreadsheetml/main")] }))), "Strict?");
  });

  test("a relationship that names its part from the root of the package is followed", () => {
    const r = runWorkbook({ absoluteTargets: true, sheets: [{ name: "S", rows: `<row r="1"><c r="A1" t="inlineStr"><is><t>Question</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Rooted?</t></is></c></row>` }] });
    assert.equal(plain(only(r)), "Rooted?");
  });

  test("a sheet name with an ampersand is read, and a workbook with a chart sheet and no cells there is not an error", () => {
    const r = runWorkbook({ sheets: [{ name: "A & B", rows: `<row r="1"><c r="A1" t="inlineStr"><is><t>Question</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Named?</t></is></c></row>` }] });
    assert.equal(plain(only(r)), "Named?");
  });
});

// ---------------------------------------------------------------------------
// A file that is not what it says
// ---------------------------------------------------------------------------

describe("a file that is not a table", () => {
  const refused = (data: Uint8Array, file: string, pattern: RegExp): void => {
    assert.throws(() => runImporter(spreadsheetImporter, data, { ...OPTIONS, file }), (error: unknown) => error instanceof TableError && pattern.test(error.message));
  };

  test("an old Excel file, or one with a password, says how to save it again", () => {
    refused(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]), "old.xlsx", /\.xls.*Save As/s);
  });

  test("a PDF is named as one", () => {
    refused(bytes("%PDF-1.7\n%âã\u0000\u0001"), "q.xlsx", /PDF/);
  });

  test("a zip that is a Word file says it is not a workbook", () => {
    const word = zipSync([textEntry("[Content_Types].xml", "<Types/>"), textEntry("word/document.xml", "<w:document xmlns:w='x'/>")]);
    refused(word, "q.xlsx", /not an Excel workbook/);
  });

  test("a damaged zip says it could not be opened", () => {
    const good = writeXlsx([{ name: "S", rows: [["Question"], ["Q?"]] }]);
    refused(good.subarray(0, Math.floor(good.length / 2)), "q.xlsx", /could not be opened/);
  });

  test("a workbook whose XML has a document type declaration is refused: that is the way into entity expansion", () => {
    const evil = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">]><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`;
    assert.throws(() => runWorkbook({ sheetXml: [evil] }), (error: unknown) => error instanceof TableError && /not valid XML/.test(error.message));
  });

  test("two parts whose names differ only in case are refused, because which is real cannot be known", () => {
    const zip = zipSync([textEntry("xl/workbook.xml", "<workbook/>"), textEntry("XL/Workbook.xml", "<workbook/>")]);
    refused(zip, "q.xlsx", /same part/);
  });

  test("a workbook with nothing in it reads as no questions, with a warning that says what a table needs", () => {
    const r = runImporter(spreadsheetImporter, writeXlsx([{ name: "S", rows: [[]] }]), { ...OPTIONS, file: "q.xlsx" });
    assert.equal(r.questions.length, 0);
    assert.match(fileNotes(r).join("\n"), /warn: No question was found/);
  });

  test("a text file given the name .xlsx is read as the CSV it is", () => {
    const r = spreadsheetImporter.parseBytes?.(bytes("Question,A,B,Correct\nQ?,a,b,A"), { ...OPTIONS, file: "renamed.xlsx" }) as ImportResult;
    assert.equal(r.questions.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Choosing the importer
// ---------------------------------------------------------------------------

describe("choosing the importer for a table", () => {
  test("by the name: .xlsx, .csv and .tsv are tables", () => {
    for (const name of ["a.xlsx", "a.csv", "a.tsv", "A.XLSX"]) assert.equal(importerForContent(name, bytes("x")).id, "spreadsheet", name);
  });

  test("a .txt whose first row names a Question column and the answers is a table; any other .txt is not", () => {
    assert.equal(importerForContent("q.txt", bytes("Question\tA\tB\tCorrect\nQ?\ta\tb\tA")).id, "spreadsheet");
    assert.notEqual(importerForContent("q.txt", bytes("1. What is it?\na. one\nb. two\nAnswer: A\n")).id, "spreadsheet");
    // A header with a Question column and nothing to say where the answers are is not enough to take a text file for a table.
    assert.equal(looksLikeQuestionTable(bytes("Question\nQ?")), false);
  });

  test("Unicode text from Excel, which is UTF-16, is found by the same test", () => {
    const text = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Question\tA\tB\tCorrect\nQ?\ta\tb\tA", "utf16le")]);
    assert.equal(importerForContent("q.txt", new Uint8Array(text)).id, "spreadsheet");
  });
});

// ---------------------------------------------------------------------------
// The reader on its own
// ---------------------------------------------------------------------------

describe("the workbook reader", () => {
  test("gives each row the number a spreadsheet shows, empty rows counted and not returned", () => {
    const file = readXlsx(writeXlsx([{ name: "S", rows: [["a"], [], [], ["b"]] }]));
    assert.deepEqual(file.sheets[0]?.rows.map((r) => r.number), [1, 4]);
  });

  test("returns sheets in the order of the workbook, with their names", () => {
    const file = readXlsx(writeXlsx([{ name: "One", rows: [["a"]] }, { name: "Two", rows: [["b"]] }]));
    assert.deepEqual(file.sheets.map((s) => s.name), ["One", "Two"]);
  });
});

// ---------------------------------------------------------------------------
// Making a workbook by hand, to test the reader on shapes the writer does not write
// ---------------------------------------------------------------------------

interface HandmadeSheet {
  name: string;
  rows: string;
  state?: string;
}

interface Handmade {
  sheets?: HandmadeSheet[];
  /** Whole sheet parts, for tests of their wrapping. */
  sheetXml?: string[];
  shared?: string;
  absoluteTargets?: boolean;
}

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function runWorkbook(spec: Handmade): ImportResult {
  const parts = spec.sheetXml ?? (spec.sheets ?? []).map((s) => `<?xml version="1.0"?><worksheet xmlns="${MAIN}"><sheetData>${s.rows}</sheetData></worksheet>`);
  const names = spec.sheets?.map((s) => s.name) ?? parts.map((_, i) => `Sheet${i + 1}`);
  const prefix = spec.absoluteTargets ? "/xl/" : "";
  const workbook = `<?xml version="1.0"?><workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets>${names
    .map((n, i) => `<sheet name="${n.replace(/&/g, "&amp;")}" sheetId="${i + 1}" r:id="rId${i + 1}"${spec.sheets?.[i]?.state ? ` state="${spec.sheets[i]?.state}"` : ""}/>`)
    .join("")}</sheets></workbook>`;
  const rels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${parts
    .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="${prefix}worksheets/sheet${i + 1}.xml"/>`)
    .join("")}${spec.shared ? `<Relationship Id="rIdS" Type="${REL}/sharedStrings" Target="${prefix}sharedStrings.xml"/>` : ""}</Relationships>`;
  const zip = zipSync([
    textEntry("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    textEntry("xl/workbook.xml", workbook),
    textEntry("xl/_rels/workbook.xml.rels", rels),
    ...(spec.shared ? [textEntry("xl/sharedStrings.xml", `<?xml version="1.0"?><sst xmlns="${MAIN}">${spec.shared}</sst>`)] : []),
    ...parts.map((xml, i) => textEntry(`xl/worksheets/sheet${i + 1}.xml`, xml)),
  ]);
  return runImporter(spreadsheetImporter, zip, { ...OPTIONS, file: "hand.xlsx" });
}
