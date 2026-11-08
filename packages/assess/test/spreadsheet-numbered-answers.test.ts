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

  // Found by an independent reviewer. The first rule cut anything after a dash, so "Answer - wrong" was the Answer column, which is the
  // Correct column, and the wrong answers were the key in a question that read as parsed. A description is cut only when it is an
  // instruction for filling the column in; a word about what the column holds changes what it is, and the column is then not understood,
  // which is said, and nothing is guessed from it.
  describe("a description that says what the column holds is never cut", () => {
    const base = (header: string, row = "Which is cold?,Ice,Fire,Lava,Sun,Fire,A"): ImportResult => csv(`Question,A,B,C,D,${header},Correct\n${row}`);

    test("so a column of wrong answers before the Correct column is not read as the key", () => {
      for (const header of ["Answer - wrong", "Answer (Incorrect)", "Answer - incorrect", "Answer - right", "Answer - correct", "Answer - hint", "Answer - explanation", "Key - not this one", "Answer (wrong one)"]) {
        const r = base(header);
        assert.deepEqual(right(first(r)), ["Ice"], header);
        assert.equal(verdictFrom(first(r).findings), "parsed", header);
        assert.match(r.fileFindings.map((f) => f.message).join("\n"), new RegExp(`These columns were not used: ${header.replace(/[()]/g, "\\$&")}`), header);
        assert.ok(!r.fileFindings.some((f) => /repeats one already read/.test(f.message)), `${header}: Correct is read, not dropped`);
      }
    });

    test("so feedback for one outcome is not the general feedback, which every answer is shown", () => {
      for (const header of ["Feedback - when right", "Feedback - when correct", "Feedback - for a right answer", "Feedback - for a wrong answer", "Feedback - hint"]) {
        const r = csv(`Question,A,B,Correct,${header}\nWhich?,x,y,A,Well done`);
        assert.equal(first(r).feedback.general, undefined, header);
        assert.match(r.fileFindings.map((f) => f.message).join("\n"), /These columns were not used: Feedback - /, header);
      }
    });

    test("and a bracket that says what a column holds is not cut either", () => {
      const r = csv("Question,Option A (correct),Option B,Correct\nWhich?,x,y,B");
      assert.match(r.fileFindings.map((f) => f.message).join("\n"), /These columns were not used: Option A \(correct\)/);
    });
  });

  describe("an instruction for filling the column in is cut", () => {
    test("whichever way a template words it", () => {
      for (const instruction of ["max 95 characters", "Max. 95", "maximum 95 characters", "min 2", "minimum of 2", "up to 95 characters", "at most 60", "at least one", "no more than 95 characters", "between 1 and 95 characters", "limit 95", "choose one", "select all that apply", "pick one", "enter the question", "required", "optional", "95 characters", "95 words"]) {
        const r = csv(`Question - ${instruction},A,B,Correct\nWhich?,x,y,B`);
        assert.equal(r.questions.length, 1, instruction);
        assert.deepEqual(right(first(r)), ["y"], instruction);
      }
      for (const [name, instruction] of [["Question", "(max 95 characters)"], ["Question", "(required)"], ["Question", "(up to 95 words)"]]) {
        const r = csv(`${name} ${instruction},A,B,Correct\nWhich?,x,y,B`);
        assert.equal(r.questions.length, 1, instruction);
      }
    });

    test("with the dash a long dash too, and a line break in the cell the same as a space", () => {
      assert.equal(csv("Question – max 95 characters,A,B,Correct\nWhich?,x,y,B").questions.length, 1);
      assert.equal(csv("Question — max 95 characters,A,B,Correct\nWhich?,x,y,B").questions.length, 1);
      // A template that wraps its descriptions has the line break inside a quoted cell.
      assert.equal(csv('"Question - max 95\ncharacters",A,B,Correct\nWhich?,x,y,B').questions.length, 1);
      assert.equal(csv('"Question - max 95 characters\n",A,B,Correct\nWhich?,x,y,B').questions.length, 1);
      assert.equal(csv('"Question -\nmax 95",A,B,Correct\nWhich?,x,y,B').questions.length, 1);
    });

    test("only a word that begins like an instruction, not a longer word that happens to start with one", () => {
      for (const words of ["maxim of the day", "selection shown", "entering", "optionally", "pickle", "requirements"]) {
        assert.equal(csv(`Question - ${words},A,B,Correct\nWhich?,x,y,B`).questions.length, 0, words);
      }
    });
  });

  test("a dash that is part of the name is passed over, and the name before the instruction is looked up as it always is", () => {
    // "Feedback - if right" is a name of its own, so an instruction after it leaves the name.
    const feedback = csv("Question,A,B,Correct,Feedback - if right - max 100 characters\nWhich?,x,y,B,Yes it is");
    assert.equal(plain((first(feedback).feedback as { correct?: unknown }).correct ?? ""), "Yes it is");
    assert.equal(first(feedback).feedback.general, undefined);
    // "Answer - wrong" is not a name, so the instruction after it does not make one: the column is not understood, and the key stays.
    const r = csv("Question,A,B,C,D,Answer - wrong - max 60 characters,Correct\nWhich?,Ice,Fire,Lava,Sun,Fire,A");
    assert.deepEqual(right(first(r)), ["Ice"]);
    assert.match(r.fileFindings.map((f) => f.message).join("\n"), /These columns were not used: Answer - wrong - max 60 characters/);
    // Two instructions in a row are one description.
    assert.equal(csv("Question - max 95 characters - required,A,B,Correct\nWhich?,x,y,B").questions.length, 1);
    assert.equal(csv("Question (required) - max 95 characters,A,B,Correct\nWhich?,x,y,B").questions.length, 1);
  });

  test("a description that begins like an instruction and then says what the column holds is not cut", () => {
    for (const header of ["Answer - choose the wrong answers", "Answer (select the incorrect ones)", "Answer - enter a wrong answer", "Answer - max 60 characters, wrong", "Answer - choose one that is false", "Answer (required) - hint"]) {
      const r = csv(`Question,A,B,C,D,${header.replace(/,/g, ";")},Correct\nWhich is cold?,Ice,Fire,Lava,Sun,Fire,A`);
      assert.deepEqual(right(first(r)), ["Ice"], header);
      assert.ok(!r.fileFindings.some((f) => /repeats one already read/.test(f.message)), header);
    }
  });

  test("a dash with no space on a side is part of a word, even before an instruction", () => {
    // "Questions" is a name, so cutting one letter too many or too few after a dash with a space on one side only would make a column of it.
    for (const header of ["Question-max 95 characters", "Question -max 95 characters", "Question- max 95 characters", "Questions- max 95 characters", "Questions -max 95 characters"]) {
      assert.equal(csv(`${header},A,B,Correct\nWhich?,x,y,B`).questions.length, 0, header);
    }
  });

  test("small words alone are not an instruction: one of the cues has to be there", () => {
    for (const header of ["Question - the text", "Question - a question", "Question - one of the", "Question - of the answer"]) {
      assert.equal(csv(`${header},A,B,Correct\nWhich?,x,y,B`).questions.length, 0, header);
    }
    assert.equal(csv("Question - enter the text,A,B,Correct\nWhich?,x,y,B").questions.length, 1, "with a cue it is");
  });

  test("a hyphen with no spaces is part of a word, so a name that begins like another is not that column", () => {
    const r = csv("Question,A,B,Correct,Chapter-notes\nWhich?,x,y,A,Unit 4");
    assert.equal(first(r).metadata.chapter, undefined, "Chapter-notes is not the Chapter column");
    assert.match(r.fileFindings.map((f) => f.message).join("\n"), /These columns were not used: Chapter-notes/);
  });
});

// Found by an independent reviewer. A cell of only a zero width space, a control character or a soft hyphen was compared with "" before
// the cleaning took it away, so it was a stem or an answer with no words in it, stored as an empty paragraph and read as parsed.
describe("a cell that shows nothing is an empty cell", () => {
  const c = (code: number): string => String.fromCharCode(code);
  // Not U+0000, which makes the whole file refused as not a CSV, before any cell is read.
  const NOTHING = [0x200b, 0x0001, 0x001f, 0x00ad, 0xfffe, 0x200d, 0x2060].map(c);

  test("a stem of it is a row with no question text, kept as a note and not read as a question", () => {
    for (const none of NOTHING) {
      const r = csv(`Question,A,B,Correct\n${none},x,y,B\nReal question?,x,y,B`);
      assert.equal(r.questions.length, 1, `U+${none.charCodeAt(0).toString(16)}`);
      assert.equal(r.orphans.length, 1);
      assert.match(r.orphans[0]?.reason ?? "", /no question text/);
    }
  });

  test("an answer of it is no answer, as an empty answer cell is none, and does not hold a place or become the key", () => {
    for (const none of NOTHING) {
      const r = csv(`Question,A,B,C,Correct\nWhich?,x,${none},z,C`);
      assert.deepEqual(options(first(r)).map(([t]) => t), ["x", "z"], `U+${none.charCodeAt(0).toString(16)}`);
      assert.deepEqual(right(first(r)), ["z"]);
    }
    // An answer that is blank can not be named as the right one: it is not one.
    const named = csv(`Question,A,B,C,Correct\nWhich?,x,${c(0x200b)},z,B`);
    assert.deepEqual(right(first(named)), []);
    assert.equal(verdictFrom(first(named).findings), "failed");
  });

  test("a cell with a visible word in it is kept, whatever invisible characters are round it", () => {
    const r = csv(`Question,A,B,Correct\n${c(0x200b)}Which?${c(0x200b)},${c(0x200b)}Ice,Fire,A`);
    assert.equal(plain(first(r).stem), "Which?");
    assert.deepEqual(right(first(r)), ["Ice"]);
    assert.equal(verdictFrom(first(r).findings), "parsed");
  });
});
