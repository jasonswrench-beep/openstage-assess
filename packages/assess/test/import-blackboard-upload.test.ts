/**
 * Blackboard's "Upload questions" text file, read in.
 *
 * Two kinds of file stand behind the tests. This program's own exporter is read back: what is exported and imported again is what was
 * exported, for every question of every fixture bank that the exporter writes. And rows written by hand in the shapes Blackboard's page
 * documents, with every way a key can be missing or unclear. No file written by Blackboard itself has been read, and the tests say so where
 * it matters. The rules under test are the ones every importer keeps: a key is what the file states in words (the word correct beside an
 * answer, the word true or false, the order of the items), a question with none has none and says so, and what cannot be read is kept as
 * an essay with all its words and fails, so that nothing is lost and nothing is guessed.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { exportBlackboardUpload } from "../src/export/blackboard-upload.ts";
import { blackboardUploadImporter, looksLikeBlackboardUpload } from "../src/import/blackboard-upload.ts";
import { importerForContent, runImporter } from "../src/import/registry.ts";
import { spreadsheetImporter } from "../src/import/spreadsheet.ts";
import { standardTextImporter } from "../src/import/standard-text.ts";
import type { ImportResult } from "../src/import/types.ts";
import { FindingCode, liveFindings, verdictFrom } from "../src/model/findings.ts";
import type { Question } from "../src/model/question.ts";
import { richTextToPlain } from "../src/model/richtext.ts";

const AT = "2026-11-07T00:00:00.000Z";
const T = "\t";
const plain = (v: unknown): string => richTextToPlain(v as never).replace(/\s+/g, " ").trim();
const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "utf8"));
const read = (text: string, file = "upload.txt"): ImportResult => runImporter(importerForContent(file, bytes(text)), bytes(text), { file, at: AT, author: "test" });
const rows = (...lines: string[]): string => lines.join("\r\n") + "\r\n";
const row = (...fields: string[]): string => fields.join(T);
const direct = (text: string): ImportResult => blackboardUploadImporter.parseBytes?.(bytes(text), { file: "upload.txt", at: AT, author: "test" }) as ImportResult;
const first = (r: ImportResult): Question => r.questions[0] as Question;
const body = (q: Question): any => q.body as any;
const options = (q: Question): Array<[string, boolean]> => body(q).options.map((o: any) => [plain(o.content), o.correct]);
const said = (q: Question): string => liveFindings(q.findings).map((f) => `${f.severity}: ${f.message}`).join(" | ");
const fileSaid = (r: ImportResult): string => r.fileFindings.map((f) => `${f.severity}: ${f.message}`).join(" | ");

describe("choosing the reader", () => {
  const mc = rows(row("MC", "Which is cold?", "Ice", "correct", "Fire", "incorrect"), row("TF", "Ice is cold.", "true"));

  test("a .txt or .tsv whose rows begin with a type and have the words where Blackboard puts them is an upload file", () => {
    for (const name of ["a.txt", "a.tsv", "a.text", "upload"]) assert.equal(importerForContent(name, bytes(mc)), blackboardUploadImporter, name);
    assert.ok(looksLikeBlackboardUpload(bytes(mc)));
    assert.equal(first(read(mc)).type, "multipleChoice");
  });

  test("the types are read in either case, and a byte order mark and a UTF-16 file are no harm", () => {
    assert.equal(read("﻿" + rows(row("mc", "Which?", "a", "Correct", "b", "INCORRECT"))).questions.length, 1);
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(rows(row("MC", "Which?", "a", "correct", "b", "incorrect")), "utf16le")]);
    assert.equal(importerForContent("a.txt", new Uint8Array(utf16)), blackboardUploadImporter);
    assert.deepEqual(options(first(runImporter(blackboardUploadImporter, new Uint8Array(utf16), { file: "a.txt", at: AT, author: "t" }))), [["a", true], ["b", false]]);
  });

  test("a table with no header whose first cells are types is a table, because its answers come before a letter and not the word correct", () => {
    const table = rows(row("MC", "Which?", "Ice", "Fire", "", "", "", "", "", "A"), row("MC", "Which again?", "x", "y", "", "", "", "", "", "B"));
    assert.equal(importerForContent("a.tsv", bytes(table)), spreadsheetImporter);
    assert.ok(!looksLikeBlackboardUpload(bytes(table)));
  });

  test("a plain text bank in the Standard Format, and a file with one other kind of row among the types, are not an upload file", () => {
    assert.equal(importerForContent("a.txt", bytes("1. Which?\na. x\n*b. y\n")), standardTextImporter);
    assert.ok(!looksLikeBlackboardUpload(bytes(mc + "Note to myself\r\n")));
    assert.ok(!looksLikeBlackboardUpload(bytes("")));
    assert.ok(!looksLikeBlackboardUpload(bytes(rows(row("MC", "Which?", "a", "b")))), "an MC row with no words is not enough");
  });

  test("a file of only essays, fill in the blanks, matching and ordering rows is an upload file when there are several", () => {
    const few = rows(row("ESS", "Explain."), row("FIB", "Capital?", "Paris"));
    const several = rows(row("ESS", "Explain."), row("FIB", "Capital?", "Paris"), row("ORD", "Order.", "a", "b", "c"));
    assert.ok(!looksLikeBlackboardUpload(bytes(few)));
    assert.ok(looksLikeBlackboardUpload(bytes(several)));
  });

  // Found by an independent reviewer. The check for the kind of file asked for a listed type on every row, and the reader keeps any
  // type made like one as a failed essay, so one row of a type that is not listed sent the whole file to the table reader, which
  // took the word "incorrect" for a right answer in a question that read as parsed.
  describe("a row of a type that is not listed does not send the file to the table reader", () => {
    const three = [row("MC", "Which is cold 1?", "Ice", "correct", "Fire", "incorrect", "Lava", "incorrect"), row("MC", "Which is cold 2?", "Fire", "incorrect", "Snow", "correct"), row("TF", "Ice is cold.", "true")];
    const odd = rows(...three, row("FIB_PLUS", "The [x] is [y]", "x", "cat", "y", "mat"));

    test("whatever the file is called, it is an upload file, and the odd row is kept as a failed essay with all its words", () => {
      for (const name of ["bank.tsv", "bank.csv", "bank.txt", "bank"]) {
        assert.equal(importerForContent(name, bytes(odd)), blackboardUploadImporter, name);
      }
      const r = read(odd, "bank.tsv");
      assert.equal(r.questions.length, 4);
      assert.equal(r.orphans.length, 0);
      assert.deepEqual(options(r.questions[0] as Question), [["Ice", true], ["Fire", false], ["Lava", false]]);
      assert.deepEqual(options(r.questions[1] as Question), [["Fire", false], ["Snow", true]]);
      const kept = r.questions[3] as Question;
      assert.equal(kept.type, "essay");
      assert.equal(verdictFrom(kept.findings), "failed");
      assert.match(said(kept), /error: .*FIB_PLUS/);
      for (const word of ["The [x] is [y]", "cat", "mat"]) assert.match(plain(kept.stem), new RegExp(word.replace(/[[\]]/g, "\\$&")), "every word of the row is kept");
      // No question has the word correct or incorrect as an answer: that is what the table reader made of the file.
      for (const q of r.questions.slice(0, 2)) assert.ok(!options(q).some(([text]) => /^(in)?correct$/i.test(text)));
    });

    test("every other type word of the page is the same, in either case", () => {
      for (const type of ["EAO", "JUMBLED_SENTENCE", "OPN", "LIK", "HOT", "CALC", "fib_plus", "Calc_Numeric"]) {
        const r = read(rows(...three, row(type, "Odd one", "a", "b")), "bank.tsv");
        assert.equal(r.questions.length, 4, type);
        assert.equal((r.questions[3] as Question).type, "essay", type);
        assert.equal(verdictFrom((r.questions[3] as Question).findings), "failed", type);
      }
    });

    test("a type of any length that Blackboard's page uses is a type: JUMBLED_SENTENCE and CALCULATED_NUMERIC are 16 and 18 characters", () => {
      // Found by a second reviewer: 12 was the longest allowed, and a file with either sent to the table reader read the word "incorrect"
      // as the key of a question that came out as parsed.
      for (const type of ["JUMBLED_SENTENCE", "CALCULATED_NUMERIC", "ESSAY_QUESTION_TYPE", "A".repeat(40)]) {
        const r = read(rows(...three, row(type, "Odd one", "a", "b")), "bank.tsv");
        assert.equal(importerForContent("bank.tsv", bytes(rows(...three, row(type, "Odd one", "a", "b")))), blackboardUploadImporter, type);
        assert.deepEqual(options(r.questions[0] as Question), [["Ice", true], ["Fire", false], ["Lava", false]], type);
        assert.equal(verdictFrom((r.questions[3] as Question).findings), "failed", type);
      }
      assert.ok(!looksLikeBlackboardUpload(bytes(rows(...three, row("A".repeat(41), "x", "y"), row("A".repeat(42), "x", "y")))), "past 40 it is not a type word, and two such rows are too many");
    });

    test("a few stray lines among the rows do not undo a file that has the words where the page puts them, and each is kept and said", () => {
      for (const stray of [row("Total questions: 3"), "ESS", row("ESS", "", ""), row("Q1", "something", "else"), row("", "something", "else"), row("1", "x")]) {
        const text = rows(...three, row("ESS", "Explain."), row("FIB", "Capital?", "Paris"), row("ORD", "Order.", "a", "b"), stray);
        assert.ok(looksLikeBlackboardUpload(bytes(text)), JSON.stringify(stray));
        const r = read(text, "bank.tsv");
        assert.deepEqual(options(r.questions[0] as Question), [["Ice", true], ["Fire", false], ["Lava", false]], JSON.stringify(stray));
        assert.equal(r.questions.length + r.orphans.length, 7, `every row is a question or an orphan: ${JSON.stringify(stray)}`);
      }
    });

    test("more than a quarter of the rows being anything else keeps a file from being one", () => {
      assert.ok(looksLikeBlackboardUpload(bytes(rows(...three, row("Q1", "x", "y")))), "one in four is tolerated");
      assert.ok(!looksLikeBlackboardUpload(bytes(rows(...three, row("Q1", "x", "y"), row("Q2", "x", "y")))), "two in five is not");
      // Without a row that has the words, every row has to be typed, as before.
      assert.ok(!looksLikeBlackboardUpload(bytes(rows(row("ESS", "a"), row("FIB", "b", "c"), row("ORD", "d", "e", "f"), row("Q1", "x", "y")))));
    });

    test("the header of a table is not a row: a first row that names a Question column, and a word of capitals only counts when it is written so", () => {
      const header = row("TYPE", "QUESTION", "CORRECT");
      assert.ok(!looksLikeBlackboardUpload(bytes(rows(header, row("TF", "The earth is round.", "True"), row("TF", "The sun is cold.", "False")))), "capitals do not make a header a row");
      assert.ok(!looksLikeBlackboardUpload(bytes(rows(row("Type", "Question", "Correct"), row("TF", "The earth is round.", "True"), row("TF", "The sun is cold.", "False")))));
      // And a table of true or false questions read as a table keeps its keys.
      const r = read(rows(row("Type", "Question", "Correct"), row("TF", "The earth is round.", "True"), row("TF", "The sun is cold.", "False")), "bank.tsv");
      assert.deepEqual(r.questions.map((q) => (q.body as any).correct), [true, false]);
      // Lower case is for the listed types only; an unlisted word has to be written in capitals to count as a type.
      assert.ok(!looksLikeBlackboardUpload(bytes(rows(row("MC", "Which?", "a", "correct", "b", "incorrect"), row("TF", "Ice is cold.", "true"), row("fib_plus", "x", "y")))), "one in three that is not typed is too many");
    });

    test("without a row that has the words where the page puts them, odd types are not enough", () => {
      assert.ok(!looksLikeBlackboardUpload(bytes(rows(row("FIB_PLUS", "x", "y"), row("EAO", "x", "y"), row("OPN", "x", "y"), row("LIK", "x", "y")))));
    });
  });
});

describe("this program's own Blackboard file, read back", () => {
  const fixtures = fileURLToPath(new URL("../../../fixtures/standard-format/", import.meta.url));
  let compared = 0;
  /** Writes the questions of a file as Blackboard's upload file, reads that back, and holds each question to the one it was written from. */
  const roundTrip = (name: string, raw: Uint8Array): void => {
    const source = runImporter(importerForContent(name, raw), raw, { file: name, at: AT, author: "test" });
    const out = exportBlackboardUpload(source.questions, { name: "Bank" });
    const written = out.report.items.filter((i) => i.outcome !== "leftOut");
    if (out.files.length === 0 || written.length === 0) return;
    const fileText = out.files.map((f) => f.content).join("");
    const back = read(fileText, "Bank - Blackboard.txt");
    assert.equal(back.orphans.length, 0, `${name}: ${back.orphans.map((o) => o.text).join(" / ")}`);
    assert.equal(back.questions.length, written.length, `${name}: one question back for each one written`);
    back.questions.forEach((got, n) => {
      const was = source.questions.find((q) => q.id === (written[n] as { questionId: string }).questionId) as Question;
      compared++;
      // A short answer is how a fill in the blank with one blank is written (and a short answer is written the same way).
      const sameType = got.type === was.type || ((was.type === "fillInBlank" || was.type === "shortAnswer") && got.type === "shortAnswer");
      assert.ok(sameType, `${name} question ${n + 1}: ${was.type} came back as ${got.type}`);
      const unmarked = (text: string): string => text.replace(/\[(Picture|Equation)[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
      if (was.type !== "fillInBlank") assert.equal(unmarked(plain(got.stem)), unmarked(plain(was.stem)), `${name} question ${n + 1}: the words`);
      if (was.type === "multipleChoice" || was.type === "multipleResponse") assert.deepEqual(options(got), options(was), `${name} question ${n + 1}: the answers and the key`);
      if (was.type === "trueFalse") assert.equal(body(got).correct, body(was).correct, `${name} question ${n + 1}: true or false`);
      if (was.type === "shortAnswer") assert.deepEqual(body(got).accepted, [...new Set(body(was).accepted.map((a: string) => a.replace(/\s+/g, " ").trim()).filter((a: string) => a !== ""))]);
      if (was.type === "ordering") assert.deepEqual(body(got).items.map((i: any) => plain(i.content)), [...body(was).items].sort((a: any, b: any) => a.position - b.position).map((i: any) => plain(i.content)));
      if (was.type === "matching") assert.deepEqual(body(got).pairs.map((p: any) => [plain(p.left), p.right]), body(was).pairs.map((p: any) => [plain(p.left), p.right.replace(/\s+/g, " ").trim()]));
      assert.notEqual(verdictFrom(got.findings), "failed", `${name} question ${n + 1}: ${said(got)}`);
    });
  };
  for (const name of readdirSync(fixtures).filter((n) => /\.txt$/.test(n))) {
    test(`${name}: each question that was written comes back as it was written`, () => roundTrip(name, new Uint8Array(readFileSync(join(fixtures, name)))));
  }
  test("a good number of questions were compared", () => {
    assert.ok(compared >= 30, `${compared} questions compared`);
  });

  const publisher = fileURLToPath(new URL("../../../fixtures/publisher/", import.meta.url));
  const realFiles = existsSync(publisher) ? readdirSync(publisher).filter((n) => /\.docx$/i.test(n)) : [];
  test(`the ${realFiles.length} real Word banks, when they are here, come back question for question`, { skip: realFiles.length === 0 && "none in fixtures/publisher (git-ignored, local)" }, () => {
    const before = compared;
    for (const name of realFiles) roundTrip(name, new Uint8Array(readFileSync(join(publisher, name))));
    assert.ok(compared - before > 100, `${compared - before} real questions compared`);
  });

  test("the file says it has no points, and that is the only note about a bank of choice questions", () => {
    const r = read(rows(row("MC", "Which?", "a", "correct", "b", "incorrect")));
    assert.match(fileSaid(r), /no points.*worth 1/);
    assert.equal(first(r).points, 1);
  });
});

describe("multiple choice and multiple answer", () => {
  test("the key is the word correct beside an answer, in either case, and nothing else", () => {
    const q = first(read(rows(row("MC", "Which is cold?", "Fire", "Incorrect", "Ice", "CORRECT", "Lava", "incorrect"))));
    assert.deepEqual(options(q), [["Fire", false], ["Ice", true], ["Lava", false]]);
    assert.equal(verdictFrom(q.findings), "parsed");
  });

  test("a multiple answer question with several right answers is read as all or nothing, and the file says so", () => {
    const r = read(rows(row("MA", "Which are cold?", "Ice", "correct", "Fire", "incorrect", "Snow", "correct")));
    assert.equal(first(r).type, "multipleResponse");
    assert.deepEqual(options(first(r)), [["Ice", true], ["Fire", false], ["Snow", true]]);
    assert.equal(body(first(r)).partialCredit, false);
    assert.match(fileSaid(r), /multiple answer question is read as all or nothing/);
  });

  test("no answer marked correct is no key: the question is flagged and nothing is guessed", () => {
    const q = first(read(rows(row("MC", "Which?", "a", "incorrect", "b", "incorrect"))));
    assert.deepEqual(options(q), [["a", false], ["b", false]]);
    assert.equal(verdictFrom(q.findings), "failed");
    assert.match(said(q), /No answer is marked correct.*Nothing was guessed/);
  });

  test("two answers marked correct on a multiple choice question stay marked as the file has them, and the question needs fixing", () => {
    const q = first(read(rows(row("MC", "Which?", "a", "correct", "b", "correct", "c", "incorrect"))));
    assert.deepEqual(options(q), [["a", true], ["b", true], ["c", false]]);
    assert.ok(liveFindings(q.findings).some((f) => f.code === FindingCode.MoreThanOneRight));
    assert.notEqual(verdictFrom(q.findings), "parsed");
  });

  test("an answer with no word after it, or a word that is neither correct nor incorrect, is kept as an essay with every word and fails", () => {
    for (const line of [row("MC", "Which?", "a", "correct", "b"), row("MC", "Which?", "a", "right", "b", "wrong"), row("MC", "Which?", "a", "correct", "b", "")]) {
      const q = first(read(rows(line, row("TF", "Ok?", "true"))));
      assert.equal(q.type, "essay", line);
      assert.equal(verdictFrom(q.findings), "failed");
      assert.match(plain(q.stem), /Which\?/);
      assert.match(plain(q.stem), /a/);
      assert.match(said(q), /(has no word after it|neither correct nor incorrect)/);
    }
  });

  test("an answer with no text is kept as (missing) and flagged, and fewer than two answers is not a question to choose from", () => {
    const empty = first(read(rows(row("MC", "Which?", "", "correct", "b", "incorrect"), row("TF", "Ok?", "true"))));
    assert.deepEqual(options(empty), [["(missing)", true], ["b", false]]);
    assert.ok(liveFindings(empty.findings).some((f) => f.code === FindingCode.EmptyOption));
    assert.equal(first(read(rows(row("MC", "Which?", "a", "correct"), row("TF", "Ok?", "true")))).type, "essay");
  });

  test("a quotation mark is a character like any other, and a stem that begins with one is read as it was written", () => {
    const q = first(read(rows(row("MC", '"To be or not to be" is from which play?', "Hamlet", "correct", "Macbeth", "incorrect"), row("TF", "Ok?", "true"))));
    assert.equal(plain(q.stem), '"To be or not to be" is from which play?');
    assert.deepEqual(options(q), [["Hamlet", true], ["Macbeth", false]]);
  });
});

describe("true or false, fill in the blank, matching, ordering and essay", () => {
  test("true or false is the word, in either case, and a row with anything else is kept and fails", () => {
    assert.equal(body(first(read(rows(row("TF", "Ice is cold.", "TRUE"), row("TF", "x", "false"))))).correct, true);
    assert.equal(body(read(rows(row("TF", "Ice is cold.", "true"), row("TF", "Fire is cold.", "False"))).questions[1] as Question).correct, false);
    for (const line of [row("TF", "Ice is cold.", "yes"), row("TF", "Ice is cold."), row("TF", "Ice is cold.", "true", "false")]) {
      const q = first(read(rows(line, row("TF", "Ok?", "true"))));
      assert.equal(q.type, "essay", line);
      assert.equal(verdictFrom(q.findings), "failed");
    }
  });

  test("a fill in the blank row is a short answer with every accepted answer, once each, and the file says no blank is marked", () => {
    const r = direct(rows(row("FIB", "The capital of France is?", "Paris", "paris", "Paris"), row("FIB", "Two plus two?", "4", "four")));
    assert.equal(first(r).type, "shortAnswer");
    assert.deepEqual(body(first(r)).accepted, ["Paris", "paris"]);
    assert.match(fileSaid(r), /2 fill in the blank rows have no blank marked/);
    assert.equal(first(direct(rows(row("FIB", "Q?"), row("TF", "Ok?", "true")))).type, "essay", "no accepted answer is no key");
  });

  test("matching is each left side and its right side, and an odd number of fields is not guessed at", () => {
    const q = first(read(rows(row("MAT", "Match.", "France", "Paris", "Italy", "Rome"), row("TF", "Ok?", "true"))));
    assert.deepEqual(body(q).pairs.map((p: any) => [plain(p.left), p.right]), [["France", "Paris"], ["Italy", "Rome"]]);
    for (const line of [row("MAT", "Match.", "France", "Paris", "Italy"), row("MAT", "Match.", "France", "Paris"), row("MAT", "Match.", "France", "", "Italy", "Rome")]) {
      const bad = first(read(rows(line, row("TF", "Ok?", "true"))));
      assert.equal(bad.type, "essay", line);
      assert.equal(verdictFrom(bad.findings), "failed");
    }
  });

  test("ordering is the items in the order the row lists them, and a gap in the list is not filled", () => {
    const q = first(read(rows(row("ORD", "Put in order.", "First", "Second", "Third"), row("TF", "Ok?", "true"))));
    assert.deepEqual(body(q).items.map((i: any) => [plain(i.content), i.position]), [["First", 1], ["Second", 2], ["Third", 3]]);
    assert.equal(first(read(rows(row("ORD", "Order.", "a", "", "c"), row("TF", "Ok?", "true")))).type, "essay");
    assert.equal(first(read(rows(row("ORD", "Order.", "a"), row("TF", "Ok?", "true")))).type, "essay");
  });

  test("an essay's sample answer is its model answer, and a row with nothing after the question is an essay with none", () => {
    const r = read(rows(row("ESS", "Explain."), row("ESS", "Why?", "Because."), row("TF", "Ok?", "true")));
    assert.equal(body(r.questions[0] as Question).modelAnswer, undefined);
    assert.equal(plain(body(r.questions[1] as Question).modelAnswer), "Because.");
    assert.equal(verdictFrom((r.questions[1] as Question).findings) === "failed", false);
  });

  test("a type this does not read is kept as an essay with all its words, and fails, with the reason", () => {
    for (const [type, why] of [["NUM", /numeric/], ["FIL", /file response/], ["SR", /short answer/], ["XYZ", /not one this reads/]] as Array<[string, RegExp]>) {
      const q = first(direct(rows(row(type, "Question text here", "0.5", "0.1"), row("TF", "Ok?", "true"))));
      assert.equal(q.type, "essay", type);
      assert.equal(verdictFrom(q.findings), "failed", type);
      assert.match(said(q), why);
      assert.match(plain(q.stem), /Question text here/);
      assert.match(plain(q.stem), /0\.5/, "its other words are kept");
    }
  });
});

describe("the shape of the file", () => {
  test("line breaks of every kind end a row, a row that ends in tabs is no harm, and blank lines are not rows", () => {
    const text = "MC\tWhich?\ta\tcorrect\tb\tincorrect\t\t\n\n\rTF\tOk?\ttrue\n\r\n";
    const r = read(text);
    assert.equal(r.questions.length, 2);
    assert.equal(r.orphans.length, 0);
    assert.deepEqual(options(first(r)), [["a", true], ["b", false]]);
  });

  test("a row that does not begin with a type is said and kept as text no question used", () => {
    const r = blackboardUploadImporter.parseBytes?.(bytes(rows(row("MC", "Which?", "a", "correct", "b", "incorrect"), "this is a note, not a question")), { file: "u.txt", at: AT, author: "t" }) as ImportResult;
    assert.equal(r.questions.length, 1);
    assert.equal(r.orphans.length, 1);
    assert.match(r.orphans[0]?.text ?? "", /this is a note/);
    assert.match(r.orphans[0]?.reason ?? "", /does not begin with a question type/);
  });

  test("a file with no question in it says so, and every row is shown beside its source line", () => {
    const empty = blackboardUploadImporter.parseBytes?.(bytes("\r\n\r\n"), { file: "u.txt", at: AT, author: "t" }) as ImportResult;
    assert.equal(empty.questions.length, 0);
    assert.match(fileSaid(empty), /No question was found/);
    const r = read(rows(row("MC", "Which?", "a", "correct", "b", "incorrect")));
    assert.match(r.sourceLines?.[0] ?? "", /^Row 1: MC \| Which\? \| a \| correct/);
  });

  test("a row with no question text is flagged, and what is in a cell is text and never markup", () => {
    const q = first(read(rows(row("MC", "", "a", "correct", "b", "incorrect"), row("TF", "Ok?", "true"))));
    assert.match(plain(q.stem), /no question text in the source/);
    assert.ok(liveFindings(q.findings).some((f) => f.code === FindingCode.EmptyStem));
    const html = first(read(rows(row("TF", "What does <b>bold</b> do & why?", "true"))));
    assert.equal(plain(html.stem), "What does <b>bold</b> do & why?");
  });

  test("a bank of 3000 rows is read in well under a second", () => {
    const text = rows(...Array.from({ length: 3000 }, (_, i) => row("MC", `Question ${i} about the topic?`, "first", "correct", "second", "incorrect", "third", "incorrect")));
    const start = performance.now();
    const r = read(text);
    const took = performance.now() - start;
    assert.equal(r.questions.length, 3000);
    assert.ok(took < 1500, `${Math.round(took)} ms`);
  });
});

// Found by an independent reviewer. A field made only of characters that draw nothing, or that the cleaning takes away, was compared with
// "" before the cleaning, so it was a stem, an answer or an item with no words in it: stored as an empty paragraph and read as parsed.
describe("a field that shows nothing is an empty field", () => {
  const c = (code: number): string => String.fromCharCode(code);
  // Code points and not the characters, because a zero width space written into a source file cannot be told from nothing.
  const NOTHING = [0x200b, 0x0000, 0x0001, 0x00ad, 0xfffe, 0x200d, 0x2060].map(c);

  test("a stem of it is an empty stem, with the error and the placeholder an empty one gets", () => {
    for (const none of NOTHING) {
      const q = first(read(rows(row("MC", none, "a", "correct", "b", "incorrect"), row("TF", "Ok?", "true"))));
      assert.ok(liveFindings(q.findings).some((f) => f.code === FindingCode.EmptyStem && f.severity === "error"), `U+${none.charCodeAt(0).toString(16)}`);
      assert.match(plain(q.stem), /no question text in the source/);
      assert.equal(verdictFrom(q.findings), "failed");
    }
    for (const type of ["TF", "FIB", "ESS"]) {
      const q = first(read(rows(row(type, c(0x200b), type === "TF" ? "true" : "x"), row("TF", "Ok?", "true"), row("TF", "Ok?", "true"))));
      assert.ok(liveFindings(q.findings).some((f) => f.code === FindingCode.EmptyStem), type);
    }
  });

  test("an answer of it is an empty answer: kept as (missing), with the error, and not read as the right one by what it looks like", () => {
    for (const none of NOTHING) {
      const q = first(read(rows(row("MC", "Which?", none, "correct", "b", "incorrect"))));
      assert.ok(liveFindings(q.findings).some((f) => f.code === FindingCode.EmptyOption && f.severity === "error"), `U+${none.charCodeAt(0).toString(16)}`);
      assert.equal(options(q)[0]?.[0], "(missing)");
      assert.equal(verdictFrom(q.findings), "failed");
    }
  });

  test("an item or a side of a pair of it keeps the whole row as a failed essay, and nothing is guessed to fill it", () => {
    for (const none of NOTHING) {
      const ordering = first(read(rows(row("ORD", "Order.", "a", none, "c"), row("TF", "Ok?", "true"))));
      assert.equal(ordering.type, "essay");
      assert.equal(verdictFrom(ordering.findings), "failed");
      assert.match(said(ordering), /An item has no text/);
      const matching = first(read(rows(row("MAT", "Match.", "a", none, "b", "2"), row("TF", "Ok?", "true"))));
      assert.equal(matching.type, "essay");
      assert.match(said(matching), /nothing on one side/);
    }
  });

  test("an accepted answer of it is left out, and a fill in the blank with no other is a failed essay", () => {
    for (const none of NOTHING) {
      const q = first(read(rows(row("FIB", "Symbol?", none, "Au"), row("TF", "Ok?", "true"))));
      assert.equal(q.type, "shortAnswer");
      assert.deepEqual((q.body as any).accepted, ["Au"]);
      const alone = first(read(rows(row("FIB", "Symbol?", none), row("TF", "Ok?", "true"))));
      assert.equal(alone.type, "essay", "the only answer is blank, so there is none");
      assert.equal(verdictFrom(alone.findings), "failed");
    }
  });

  test("a last field of it is no field, so a row that ends in one is the row it was, and a line of it alone is not a row", () => {
    const ended = first(read(rows(row("MC", "Which?", "a", "correct", "b", "incorrect", c(0x200b)))));
    assert.deepEqual(options(ended), [["a", true], ["b", false]]);
    assert.equal(verdictFrom(ended.findings), "parsed");
    const r = read(rows(row("TF", "Ok?", "true"), c(0x200b), row(c(0x200b), c(0x00ad)), row("TF", "Ok again?", "false")));
    assert.equal(r.questions.length, 2);
    assert.equal(r.orphans.length, 0);
  });

  test("text with a visible word in it is kept as typed, even with such characters around it", () => {
    const q = first(read(rows(row("MC", c(0x200b) + "Which?" + c(0x200b), c(0x200b) + "Ice", "correct", "Fire", "incorrect"))));
    assert.equal(plain(q.stem), "Which?");
    assert.deepEqual(options(q).map(([t]) => t), ["Ice", "Fire"]);
    assert.equal(verdictFrom(q.findings), "parsed");
  });
});
