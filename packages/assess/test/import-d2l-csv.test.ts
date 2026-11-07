/**
 * Brightspace (D2L) Question Library CSV, read in.
 *
 * Two kinds of file stand behind the tests. This program's own exporter is read back (what is exported and imported again is what
 * was exported: every question of every fixture bank that the exporter writes comes back with the same type, words, answers and key).
 * And files written by hand in the shapes a guide to Brightspace's template gives, which differ from the exporter's in the cells it
 * leaves empty: an HTML flag after an option's text, a feedback cell, a hint, an image, a difficulty, a scoring word, how a short
 * answer is matched. No real file written by Brightspace has been read, and the test says so where it matters. The rules under test
 * are the ones every importer keeps: a key is read only where the file states it in a shape this knows, a weight that is part of the
 * points is never a key, and what cannot be read is said and kept, not dropped or guessed.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { exportD2lCsv } from "../src/export/d2l-csv.ts";
import { d2lCsvImporter, looksLikeD2lCsv } from "../src/import/d2l-csv.ts";
import { importerForContent, runImporter } from "../src/import/registry.ts";
import { spreadsheetImporter } from "../src/import/spreadsheet.ts";
import type { ImportResult } from "../src/import/types.ts";
import { FindingCode, liveFindings, verdictFrom } from "../src/model/findings.ts";
import type { Question } from "../src/model/question.ts";
import { richTextToPlain } from "../src/model/richtext.ts";

const AT = "2026-11-07T00:00:00.000Z";
const plain = (v: unknown): string => richTextToPlain(v as never).replace(/\s+/g, " ").trim();
const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "utf8"));
const read = (text: string, file = "library.csv"): ImportResult => runImporter(importerForContent(file, bytes(text)), bytes(text), { file, at: AT, author: "test" });
const said = (q: Question): string => liveFindings(q.findings).map((f) => `${f.severity}: ${f.message}`).join(" | ");
const fileSaid = (r: ImportResult): string => r.fileFindings.map((f) => `${f.severity}: ${f.message}`).join(" | ");
const first = (r: ImportResult): Question => r.questions[0] as Question;
const body = (q: Question): any => q.body as any;
const options = (q: Question): Array<[string, boolean]> => body(q).options.map((o: any) => [plain(o.content), o.correct]);
const codes = (q: Question): string[] => liveFindings(q.findings).map((f) => f.code);

describe("choosing the reader", () => {
  test("a .csv or a .txt whose first row that is not a comment begins a question is a Brightspace library, not a table", () => {
    const text = "// a comment\r\nNewQuestion,MC,\r\nQuestionText,Which?,\r\nOption,100,Yes\r\nOption,0,No\r\n";
    assert.equal(importerForContent("a.csv", bytes(text)), d2lCsvImporter);
    assert.equal(importerForContent("a.txt", bytes(text)), d2lCsvImporter);
    assert.ok(looksLikeD2lCsv(bytes(text)));
    assert.equal(first(read(text)).type, "multipleChoice");
  });

  test("keywords are read without regard to case, and a byte order mark in front of the first one is no harm", () => {
    const r = read("﻿newquestion,mc,\r\nquestiontext,Which?,\r\noption,100,Yes\r\noption,0,No\r\n");
    assert.equal(r.questions.length, 1);
    assert.deepEqual(options(first(r)), [["Yes", true], ["No", false]]);
  });

  test("a plain question table is still a table, and a CSV that merely mentions NewQuestion later is too", () => {
    const table = "Question,A,B,Correct\nWhich?,a,b,A\n";
    assert.equal(importerForContent("a.csv", bytes(table)), spreadsheetImporter);
    assert.equal(importerForContent("a.csv", bytes("Question,Note\nWhich?,NewQuestion\n")), spreadsheetImporter);
    assert.ok(!looksLikeD2lCsv(bytes("NewQuestion,\r\nQuestionText,x\r\n")), "a NewQuestion row with no type is not a library");
  });
});

describe("this program's own Brightspace file, read back", () => {
  const fixtures = fileURLToPath(new URL("../../../fixtures/standard-format/", import.meta.url));
  let compared = 0;
  /** Writes the questions of a file as a Brightspace CSV, reads that back, and holds each question to the one it was written from. */
  const roundTrip = (name: string, raw: Uint8Array): void => {
    {
      const source = runImporter(importerForContent(name, raw), raw, { file: name, at: AT, author: "test" });
      const out = exportD2lCsv(source.questions, { name: "Bank" });
      const file = out.files[0];
      if (!file) return;
      const back = read(file.content, "Bank - Brightspace.csv");
      assert.equal(back.orphans.length, 0);
      const written = out.report.items.filter((i) => i.outcome !== "leftOut");
      assert.equal(back.questions.length, written.length, "one question back for each one written");
      back.questions.forEach((got, n) => {
        const was = source.questions.find((q) => q.id === (written[n] as { questionId: string }).questionId) as Question;
        compared++;
        // A short answer is how a fill in the blank with one blank is written, and a picture or an equation is a marker.
        const sameType = got.type === was.type || (was.type === "fillInBlank" && got.type === "shortAnswer");
        assert.ok(sameType, `${name} question ${n + 1}: ${was.type} came back as ${got.type}`);
        // A picture or an equation cannot go in the file and is written into the text as a marker, which is counted.
        const unmarked = (text: string): string => text.replace(/\[(Picture|Equation)[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
        if (was.type !== "fillInBlank") assert.equal(unmarked(plain(got.stem)), unmarked(plain(was.stem)), `${name} question ${n + 1}: the words`);
        if (was.type === "multipleChoice" || was.type === "multipleResponse") {
          assert.deepEqual(options(got), options(was), `${name} question ${n + 1}: the answers and the key`);
        }
        if (was.type === "trueFalse") assert.equal(body(got).correct, body(was).correct);
        if (was.type === "shortAnswer") assert.deepEqual(body(got).accepted, [...new Set(body(was).accepted.map((a: string) => a.replace(/\s+/g, " ").trim()))]);
        if (was.type === "ordering") assert.deepEqual(body(got).items.map((i: any) => plain(i.content)), [...body(was).items].sort((a: any, b: any) => a.position - b.position).map((i: any) => plain(i.content)));
        if (was.type === "matching") assert.deepEqual(body(got).pairs.map((p: any) => [plain(p.left), p.right]), body(was).pairs.map((p: any) => [plain(p.left), p.right.replace(/\s+/g, " ").trim()]));
        if (Number.isInteger(was.points) && was.points >= 1 && was.points <= 100) assert.equal(got.points, was.points, `${name} question ${n + 1}: the points`);
        // The exporter writes only a question with a usable key, so one that comes back has its key and is not a failure.
        assert.notEqual(verdictFrom(got.findings), "failed", `${name} question ${n + 1}: ${said(got)}`);
      });
    }
  };
  for (const name of readdirSync(fixtures).filter((n) => /\.txt$/.test(n))) {
    test(`${name}: each question that was written comes back as it was written`, () => roundTrip(name, new Uint8Array(readFileSync(join(fixtures, name)))));
  }
  test("a good number of questions were compared", () => {
    assert.ok(compared >= 30, `${compared} questions compared`);
  });

  // The real Word banks kept on the machine that has them (the folder is git-ignored), written as Brightspace files and read back.
  const publisher = fileURLToPath(new URL("../../../fixtures/publisher/", import.meta.url));
  const realFiles = existsSync(publisher) ? readdirSync(publisher).filter((n) => /\.docx$/i.test(n)) : [];
  test(`the ${realFiles.length} real Word banks, when they are here, come back question for question`, { skip: realFiles.length === 0 && "none in fixtures/publisher (git-ignored, local)" }, () => {
    const before = compared;
    for (const name of realFiles) roundTrip(name, new Uint8Array(readFileSync(join(publisher, name))));
    assert.ok(compared - before > 100, `${compared - before} real questions compared`);
  });
});

describe("the kinds of question", () => {
  test("multiple choice: the weight that is the whole of the points is the key, with an option's feedback and an HTML flag", () => {
    const r = read(
      [
        "NewQuestion,MC,,",
        "ID,Q-12,,",
        "Title,Capitals,,",
        "QuestionText,<p>Which is the <b>capital</b> of France?</p>,HTML,",
        "Points,3,,",
        "Difficulty,2,,",
        "Option,0,Rome,,Not Rome.,",
        "Option,100,<i>Paris</i>,HTML,Yes!,",
        "Option,0,Madrid,,,",
        "Feedback,Capitals are in the atlas.,,",
      ].join("\r\n"),
    );
    const q = first(r);
    assert.equal(q.type, "multipleChoice");
    assert.equal(q.title, "Capitals");
    assert.equal(q.points, 3);
    assert.equal(plain(q.stem), "Which is the capital of France?");
    assert.match(q.stem.content, /<strong>capital<\/strong>/);
    assert.deepEqual(options(q), [["Rome", false], ["Paris", true], ["Madrid", false]]);
    assert.match(body(q).options[1].content.content, /<em>Paris<\/em>/);
    assert.equal(plain(body(q).options[0].feedback), "Not Rome.");
    assert.equal(plain(body(q).options[1].feedback), "Yes!");
    assert.equal(plain(q.feedback.general), "Capitals are in the atlas.");
    assert.equal(q.metadata.custom?.["Question ID"], "Q-12");
    assert.equal(q.metadata.custom?.["Difficulty"], "2");
    assert.equal(verdictFrom(q.findings), "parsed");
    assert.match(fileSaid(r), /1 question has a Difficulty from 1 to 5.*kept as written/);
  });

  test("part credit is never a key, and no option worth the whole means no key", () => {
    const part = first(read("NewQuestion,MC,\r\nQuestionText,Which?,\r\nOption,50,Half,\r\nOption,50,Also half,\r\nOption,0,None,\r\n"));
    assert.deepEqual(options(part), [["Half", false], ["Also half", false], ["None", false]]);
    assert.match(said(part), /No option is worth the whole of the points, so no option is read as the key\. Nothing was guessed\./);
    assert.match(said(part), /Some options are worth part of the points\. Partial credit for a multiple choice question is not kept/);
    assert.equal(verdictFrom(part.findings), "failed");
  });

  test("two options worth the whole are both marked as the file has them, and the question needs fixing", () => {
    const q = first(read("NewQuestion,MC,\r\nQuestionText,Which?,\r\nOption,100,A,\r\nOption,100,B,\r\nOption,0,C,\r\n"));
    assert.deepEqual(options(q), [["A", true], ["B", true], ["C", false]]);
    assert.ok(codes(q).includes(FindingCode.MoreThanOneRight));
    assert.notEqual(verdictFrom(q.findings), "parsed");
  });

  test("a weight that is not a number makes the question unreadable, kept as an essay with its words, and failed", () => {
    const q = first(read("NewQuestion,MC,\r\nQuestionText,Which?,\r\nOption,high,Paris,\r\nOption,0,Rome,\r\n"));
    assert.equal(q.type, "essay");
    assert.match(plain(q.stem), /Which\?/);
    assert.match(plain(q.stem), /Paris/);
    assert.match(plain(q.stem), /Rome/);
    assert.match(said(q), /weight "high", which is not a number/);
    assert.equal(verdictFrom(q.findings), "failed");
  });

  test("an option with no text is kept as (missing) and an error", () => {
    const q = first(read("NewQuestion,MC,\r\nQuestionText,Which?,\r\nOption,100,Yes,\r\nOption,0,,\r\n"));
    assert.deepEqual(options(q), [["Yes", true], ["(missing)", false]]);
    assert.ok(codes(q).includes(FindingCode.EmptyOption));
  });

  test("true or false: the row worth the whole is the key, and the feedback follows the right and the wrong row", () => {
    const q = first(read("NewQuestion,TF,\r\nQuestionText,The sky is blue.,\r\nTRUE,100,Correct!,\r\nFALSE,0,Look up.,\r\n"));
    assert.equal(q.type, "trueFalse");
    assert.equal(body(q).correct, true);
    assert.equal(plain(q.feedback.correct), "Correct!");
    assert.equal(plain(q.feedback.incorrect), "Look up.");
    const no = first(read("NewQuestion,TF,\r\nQuestionText,Fish fly.,\r\nTRUE,0,\r\nFALSE,100,\r\n"));
    assert.equal(body(no).correct, false);
  });

  test("true or false with neither or both worth the whole has no key, and says so", () => {
    const neither = first(read("NewQuestion,TF,\r\nQuestionText,x,\r\nTRUE,0,\r\nFALSE,0,\r\n"));
    assert.equal(body(neither).correct, undefined);
    assert.match(said(neither), /Neither TRUE nor FALSE is worth the whole/);
    const both = first(read("NewQuestion,TF,\r\nQuestionText,x,\r\nTRUE,100,\r\nFALSE,100,\r\n"));
    assert.equal(body(both).correct, undefined);
    assert.match(said(both), /Both TRUE and FALSE are worth the whole/);
    const one = first(read("NewQuestion,TF,\r\nQuestionText,x,\r\nTRUE,100,\r\n"));
    assert.equal(one.type, "essay");
    assert.match(said(one), /one TRUE row and one FALSE row/);
  });

  test("multiselect: an option is right where it says 1, and the scoring word says whether credit is shared", () => {
    const text = (scoring: string): string => `NewQuestion,MS,\r\nQuestionText,Pick the primes.,\r\n${scoring === "" ? "" : `Scoring,${scoring}\r\n`}Option,1,Two,\r\nOption,0,Four,\r\nOption,1,Five,\r\n`;
    const none = first(read(text("")));
    assert.equal(none.type, "multipleResponse");
    assert.deepEqual(options(none), [["Two", true], ["Four", false], ["Five", true]]);
    assert.equal(body(none).partialCredit, false, "all or nothing is the default");
    assert.equal(body(first(read(text("AllOrNothing")))).partialCredit, false);
    assert.equal(body(first(read(text("All or nothing")))).partialCredit, false);
    assert.equal(body(first(read(text("RightMinusWrong")))).partialCredit, true);
    const shared = first(read(text("RightAnswers")));
    assert.equal(body(shared).partialCredit, true);
    assert.match(said(shared), /The scoring "RightAnswers" gives credit for each right answer chosen/);
    assert.equal(body(first(read(text("Correct Selections")))).partialCredit, true);
    const odd = first(read(text("Whatever")));
    assert.equal(body(odd).partialCredit, false);
    assert.match(said(odd), /The scoring "Whatever" is not one this knows, so the question is all or nothing/);
  });

  test("a multiselect option that is neither 1 nor 0 is not turned into a key", () => {
    const q = first(read("NewQuestion,MS,\r\nQuestionText,Pick.,\r\nOption,100,A,\r\nOption,0,B,\r\n"));
    assert.equal(q.type, "essay");
    assert.match(said(q), /weight "100", and a multiselect option is 1 for a right answer and 0 for a wrong one/);
    assert.equal(verdictFrom(q.findings), "failed");
  });

  test("short answer: each Answer row is accepted, how it is matched is read, and a regular expression is not an answer", () => {
    const q = first(read("NewQuestion,SA,\r\nQuestionText,Capital of France?,\r\nInputBox,3,40\r\nAnswer,100,Paris,sensitive\r\nAnswer,,paris,sensitive\r\nAnswer,100,Par.*,regexp\r\n"));
    assert.equal(q.type, "shortAnswer");
    assert.deepEqual(body(q).accepted, ["Paris", "paris"]);
    assert.equal(body(q).caseSensitive, false, "the last row's way of matching is the one used, which here is the regular expression, so the question is not case sensitive");
    assert.match(said(q), /The answer "Par\.\*" is a regular expression/);
    const sensitive = first(read("NewQuestion,SA,\r\nQuestionText,x?,\r\nAnswer,100,Paris,sensitive\r\n"));
    assert.equal(body(sensitive).caseSensitive, true);
    const blank = first(read("NewQuestion,SA,\r\nQuestionText,x?,\r\nAnswer,100,Paris,\r\n"));
    assert.equal(body(blank).caseSensitive, false);
  });

  test("matching: a choice and the match with its number are a pair, wherever the rows are, and a spare match is said", () => {
    const q = first(read("NewQuestion,M,\r\nQuestionText,Match.,\r\nChoice,1,France\r\nChoice,2,Spain\r\nMatch,2,Madrid\r\nMatch,1,Paris\r\nMatch,9,Rome\r\n"));
    assert.equal(q.type, "matching");
    assert.deepEqual(body(q).pairs.map((p: any) => [plain(p.left), p.right]), [["France", "Paris"], ["Spain", "Madrid"]]);
    assert.deepEqual(body(q).distractors, ["Rome"]);
    assert.match(said(q), /1 match has a number that no choice has, so it was read as spare answer: Rome/);
  });

  test("matching: a choice with no match, or two, is not guessed and the question is kept as an essay", () => {
    const none = first(read("NewQuestion,M,\r\nQuestionText,Match.,\r\nChoice,1,France\r\nChoice,2,Spain\r\nMatch,1,Paris\r\n"));
    assert.equal(none.type, "essay");
    assert.match(said(none), /The choice "Spain" has no match, and nothing is guessed to fill it/);
    const two = first(read("NewQuestion,M,\r\nQuestionText,Match.,\r\nChoice,1,France\r\nChoice,2,Spain\r\nMatch,1,Paris\r\nMatch,1,Lyon\r\nMatch,2,Madrid\r\n"));
    assert.equal(two.type, "essay");
    assert.match(said(two), /The choice "France" has 2 matches, and nothing says which is the right one/);
    assert.equal(verdictFrom(two.findings), "failed");
  });

  test("ordering: the items are in the right order as they stand", () => {
    const q = first(read("NewQuestion,O,\r\nQuestionText,Put in order.,\r\nScoring,AllOrNothing\r\nItem,First,\r\nItem,Second,\r\nItem,Third,\r\n"));
    assert.equal(q.type, "ordering");
    assert.deepEqual(body(q).items.map((i: any) => [i.position, plain(i.content)]), [[1, "First"], [2, "Second"], [3, "Third"]]);
    const few = first(read("NewQuestion,O,\r\nQuestionText,x,\r\nItem,Only,\r\n"));
    assert.equal(few.type, "essay");
  });

  test("written response: the answer key is the model answer, and the starting text and the hint are said and not kept", () => {
    const q = first(read("NewQuestion,WR,\r\nQuestionText,Explain.,\r\nInitialText,Start here,\r\nAnswerKey,A good answer says this.,\r\nHint,Think about it,\r\n"));
    assert.equal(q.type, "essay");
    assert.equal(plain(body(q).modelAnswer), "A good answer says this.");
    assert.match(said(q), /The text to start the answer box with was not read: "Start here"/);
    assert.match(said(q), /A hint was not read: "Think about it"/);
  });

  test("a kind this does not read is kept as an essay with every word of it, and fails", () => {
    const q = first(read("NewQuestion,FIB,\r\nQuestionText,The ___ is blue.,\r\nAnswer,100,sky,\r\n"));
    assert.equal(q.type, "essay");
    assert.match(plain(q.stem), /The ___ is blue\./);
    assert.match(plain(q.stem), /sky/);
    assert.match(said(q), /A fill in the blank question is not read/);
    assert.equal(verdictFrom(q.findings), "failed");
    const other = first(read("NewQuestion,ZZ,\r\nQuestionText,x,\r\n"));
    assert.match(said(other), /A question of the type "ZZ" is not one this reads/);
  });
});

describe("what a file carries that a question here cannot hold", () => {
  test("an image the file names is said, and a picture in the HTML of a text stays as [picture] with the question flagged", () => {
    const q = first(read('NewQuestion,MC,\r\nQuestionText,"<p>Look: <img src=""images/map.png"" alt=""A map""></p>",HTML\r\nImage,images/map.png,\r\nOption,100,North,\r\nOption,0,South,\r\n'));
    assert.match(said(q), /An image was not read: "images\/map\.png"/);
    assert.match(said(q), /A picture could not be kept, and stands as \[picture\]/);
    assert.ok(codes(q).includes("import.unread-object"), codes(q).join(","));
  });

  test("a row it does not know is named, comments are counted, and a row before the first question is an orphan", () => {
    // A file whose first row is not a question is not told to be a library by its look, so this one is handed to the reader directly.
    const r = d2lCsvImporter.parseBytes?.(bytes("// note\r\nstray,row\r\nNewQuestion,MC,\r\nQuestionText,Which?,\r\nMysteryRow,1,2\r\nOption,100,A,\r\nOption,0,B,\r\n// another\r\n"), { file: "library.csv", at: AT, author: "test" }) as ImportResult;
    assert.equal(r.questions.length, 1);
    assert.equal(r.orphans.length, 1);
    assert.match(r.orphans[0]?.reason ?? "", /before the first NewQuestion row/);
    assert.match(said(first(r)), /A row was not read: "MysteryRow"/);
    assert.match(fileSaid(r), /2 rows are comments \(they begin with \/\/\) and were not read/);
  });

  test("a points cell that is not a number is said, and the default is used; blank is the default", () => {
    const q = first(read("NewQuestion,MC,\r\nQuestionText,x?,\r\nPoints,lots,\r\nOption,100,A,\r\nOption,0,B,\r\n"));
    assert.equal(q.points, 1);
    assert.match(said(q), /The Points cell says "lots", which is not a number above 0/);
    assert.equal(first(read("NewQuestion,MC,\r\nQuestionText,x?,\r\nOption,100,A,\r\nOption,0,B,\r\n")).points, 1);
    assert.equal(first(read("NewQuestion,MC,\r\nQuestionText,x?,\r\nPoints,2.5,\r\nOption,100,A,\r\nOption,0,B,\r\n")).points, 2.5);
  });

  test("each question points at its own rows, and the rows are shown beside it", () => {
    const r = read("// c\r\nNewQuestion,MC,\r\nQuestionText,One?,\r\nOption,100,A,\r\nOption,0,B,\r\nNewQuestion,TF,\r\nQuestionText,Two.,\r\nTRUE,100,\r\nFALSE,0,\r\n");
    assert.equal(r.questions.length, 2);
    const a = r.questions[0] as Question;
    const b = r.questions[1] as Question;
    const lines = r.sourceLines ?? [];
    const span = (q: Question): string[] => lines.slice((q.origin as any).source.firstBlock, (q.origin as any).source.lastBlock + 1);
    assert.equal(span(a).length, 4);
    assert.match(span(a)[0] as string, /NewQuestion \| MC/);
    assert.equal(span(b).length, 4);
    assert.match(span(b)[0] as string, /NewQuestion \| TF/);
  });

  test("an empty file or a file of comments says no question was found", () => {
    const r = read("// only a comment\r\n", "library.csv");
    assert.equal(r.questions.length, 0);
  });
});
