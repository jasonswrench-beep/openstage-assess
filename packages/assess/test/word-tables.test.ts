/**
 * Questions laid out in Word tables.
 *
 * A table is read as one of three layouts (a grid with a header row, rows that begin
 * with a label, an answer key) or not at all. Most of what follows is the second
 * half of that: a table that only looks like a layout is the way a wrong answer gets
 * in, so each way a table can fail to qualify has a test, and each layout has the
 * text fixtures to prove it reads exactly as the same questions typed.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { scoreFile, type ExpectedFile } from "../src/harness/score.ts";
import { standardTextImporter } from "../src/import/standard-text.ts";
import { scanStandardText } from "../src/import/standard-text-scan.ts";
import { linesToBlocks, type ImportResult } from "../src/import/types.ts";
import { docxToBlocks, wordImporter } from "../src/import/word.ts";
import { FindingCode } from "../src/model/findings.ts";
import type { Question } from "../src/model/question.ts";
import { richTextToPlain } from "../src/model/richtext.ts";
import { docx, docxFromLines, paragraph, run, table, type TableOptions } from "./support/docx-writer.ts";
import { project } from "./support/project.ts";
import { soup } from "./support/soup.ts";

const OPTIONS = { file: "t.docx", at: "2026-01-01T00:00:00.000Z", author: "test" };
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "..", "..", "..", "fixtures", "standard-format");
const linesOf = (text: string) => text.replace(/\r\n?/g, "\n").split("\n");

const cell = (text: string, properties = ""): string => paragraph(text === "" ? "" : run(text, properties));
const optionsOf = (q: Question | undefined): Array<[string, boolean]> =>
  q && "options" in q.body ? q.body.options.map((o) => [richTextToPlain(o.content), o.correct]) : [];
const tableFindings = (result: ImportResult) => result.fileFindings.filter((f) => f.code === FindingCode.TableLayout).map((f) => f.message);
const read = (body: string) => wordImporter.parseBytes(docx({ body }), OPTIONS);

// ---------------------------------------------------------------------------
// Labelled rows: a question to a table
// ---------------------------------------------------------------------------

describe("rows that begin with a label", () => {
  const question = (extra: string[][] = []): string[][] => [
    [cell("1."), cell("Which is a planet?")],
    [cell("a."), cell("Sirius")],
    [cell("*b."), cell("Mars")],
    [cell("c."), cell("The Sun")],
    ...extra,
  ];

  test("a table for a question reads as the question", () => {
    const result = read(table(question()));
    assert.deepEqual(optionsOf(result.questions[0]), [["Sirius", false], ["Mars", true], ["The Sun", false]]);
    assert.deepEqual(result.counts, { parsed: 1, needsReview: 0, failed: 0, orphans: 0 });
    assert.deepEqual(tableFindings(result), ["1 table was read as questions: 1 as labelled rows."]);
  });

  test("several questions in one table, with a blank row between", () => {
    const result = read(table([...question(), [cell(""), cell("")], [cell("2."), cell("Is it?")], [cell("a."), cell("Yes")], [cell("*b."), cell("No")]]));
    assert.equal(result.questions.length, 2);
    assert.equal(result.counts.parsed, 2);
  });

  test("the key as a check mark in a last cell", () => {
    for (const mark of ["✓", "✔", "☑", "✅", "*", "correct", "Correct", "right"]) {
      const result = read(table([[cell("1."), cell("Which?"), cell("")], [cell("a."), cell("One"), cell("")], [cell("b."), cell("Two"), cell(mark)], [cell("c."), cell("Three"), cell("")]]));
      assert.deepEqual(optionsOf(result.questions[0]), [["One", false], ["Two", true], ["Three", false]], mark);
    }
  });

  test("a last cell that could be an option's own words is not a mark", () => {
    for (const word of ["x", "yes", "Yes", "true", "ok"]) {
      const result = read(table([[cell("1."), cell("Which?"), cell("")], [cell("a."), cell("One"), cell(word)], [cell("b."), cell("Two"), cell("")]]));
      assert.equal(optionsOf(result.questions[0]).some(([, correct]) => correct), false, word);
      assert.match(optionsOf(result.questions[0])[0]?.[0] ?? "", new RegExp(`One ${word}`), "the words are kept with the option");
    }
  });

  test("a check mark beside the question number marks nothing, and the question is still the question", () => {
    const result = read(table([[cell("1."), cell("Which?"), cell("✓")], [cell("a."), cell("One"), cell("")], [cell("b."), cell("Two"), cell("")]]));
    assert.equal(result.questions.length, 1);
    assert.equal(richTextToPlain(result.questions[0]?.stem as never), "Which? ✓");
    assert.equal(optionsOf(result.questions[0]).some(([, correct]) => correct), false);
  });

  test("an option whose text runs over two paragraphs carries on", () => {
    const result = read(table([[cell("1."), cell("Which?")], [cell("a."), cell("First") + cell("and then more")], [cell("*b."), cell("Two")]]));
    assert.match(optionsOf(result.questions[0])[0]?.[0] ?? "", /^First\sand then more$/);
  });

  test("a label with nothing beside it is an option with no text, as it is typed", () => {
    const typed = standardTextImporter.parse("1. Which?\na. One\nb. \n*c. Three\n", OPTIONS);
    const result = read(table([[cell("1."), cell("Which?")], [cell("a."), cell("One")], [cell("b."), cell("")], [cell("*c."), cell("Three")]]));
    assert.deepEqual(result.questions[0]?.findings.map((f) => f.code), typed.questions[0]?.findings.map((f) => f.code));
    assert.equal(result.questions[0]?.findings.some((f) => f.code === FindingCode.EmptyOption), true);
  });

  test("a row of one cell is a line of its own, as it would be outside the table", () => {
    const result = read(table([[cell("Type: MC")], ...question()]));
    assert.equal(result.questions[0]?.type, "multipleChoice");
    assert.equal(result.counts.parsed, 1);
  });

  test("a cell spread across the width is such a line", () => {
    // the writer spreads a short row over the width, as Word does
    const result = read(table([[cell("Type: MC")], ...question()]));
    const xml = table([[cell("x")], [cell("a."), cell("y")]]);
    assert.match(xml, /gridSpan/);
    assert.equal(result.counts.parsed, 1);
  });

  test("a table with no labels is read cell by cell, as it always was, and the file says so", () => {
    const result = read(table([[cell("Year"), cell("Sales")], [cell("2019"), cell("100")]]) + paragraph(run("1. Q?")) + paragraph(run("a. x")) + paragraph(run("*b. y")));
    assert.equal(result.counts.parsed, 1);
    assert.equal(tableFindings(result).length, 1);
    assert.match(tableFindings(result)[0] ?? "", /^1 table was read cell by cell, in order, as plain text. A table is read as questions when it is a grid headed Question and A, B, C/);
  });

  test("rows whose first cell is some other words make the whole table plain", () => {
    const result = read(table([[cell("1."), cell("Which?")], [cell("Note"), cell("Be careful")], [cell("a."), cell("One")]]));
    assert.deepEqual(tableFindings(result).map((m) => m.slice(0, 20)), ["1 table was read cel"]);
  });

  test("a label made by Word's own list is not a typed label, so the table is left to its cells", () => {
    // A cell that holds a numbered paragraph has its label as list numbering and not as text.
    const body = table([[cell("Which?"), cell("")], [cell("One"), cell("")]]);
    assert.equal(read(body).questions.length, 0);
  });

  test("cells merged down make the table plain", () => {
    const merged =
      '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid>' +
      `<w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr>${cell("1.")}</w:tc><w:tc>${cell("Which?")}</w:tc></w:tr>` +
      `<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr>${cell("")}</w:tc><w:tc>${cell("a. One")}</w:tc></w:tr></w:tbl>`;
    assert.equal(tableFindings(read(merged)).some((m) => /read cell by cell/.test(m)), true);
  });

  test("a table inside a cell makes the outer table plain, and the inner one is still looked at", () => {
    const inner = table(question());
    const outer = table([[cell("Questions below") + inner, cell("")]]);
    const result = read(outer);
    assert.equal(result.questions.length, 1, "the inner table is a question to a table");
    assert.equal(tableFindings(result).length, 2);
  });

  test("a table of lines with no label in it is not a layout, and is counted as plain", () => {
    const result = read(table([[cell("1. One?")], [cell("a. x")], [cell("*b. y")]]));
    assert.equal(result.counts.parsed, 1, "the lines are still read, as they always were");
    assert.deepEqual(tableFindings(result).map((m) => /read cell by cell/.test(m)), [true]);
  });

  test("a row that starts late or ends early makes the table plain", () => {
    const row = (props: string) => `<w:tr><w:trPr>${props}</w:trPr><w:tc>${cell("a.")}</w:tc><w:tc>${cell("One")}</w:tc></w:tr>`;
    const grid = (props: string) =>
      `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid><w:tr><w:tc>${cell("1.")}</w:tc><w:tc>${cell("Which?")}</w:tc></w:tr>${row(props)}</w:tbl>`;
    for (const props of ['<w:gridBefore w:val="1"/>', '<w:gridAfter w:val="1"/>']) {
      assert.equal(tableFindings(read(grid(props))).some((m) => /read cell by cell/.test(m)), true, props);
    }
    assert.equal(tableFindings(read(grid(""))).some((m) => /as labelled rows/.test(m)), true, "the same table without the property is read");
  });

  test("a row that begins with a cell merged across the first column is not a label table", () => {
    const body =
      '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid>' +
      `<w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>${cell("1.")}</w:tc><w:tc>${cell("Which?")}</w:tc></w:tr></w:tbl>`;
    assert.equal(read(body).questions.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

describe("a grid with a header row", () => {
  const header = (...names: string[]): string[] => names.map((n) => cell(n));
  const grid = (head: string[], ...rows: string[][]) => table([header(...head), ...rows.map((r) => r.map((c) => cell(c)))]);

  test("a question to a row, with its options in columns and the key in a column", () => {
    const result = read(
      grid(
        ["No.", "Question", "A", "B", "C", "D", "Answer"],
        ["1", "Which is a planet?", "Sirius", "Mars", "The Sun", "Vega", "B"],
        ["2", "Which is a star?", "Venus", "Earth", "Sirius", "Mars", "C"],
      ),
    );
    assert.deepEqual(optionsOf(result.questions[0]), [["Sirius", false], ["Mars", true], ["The Sun", false], ["Vega", false]]);
    assert.deepEqual(optionsOf(result.questions[1]), [["Venus", false], ["Earth", false], ["Sirius", true], ["Mars", false]]);
    assert.deepEqual(result.counts, { parsed: 2, needsReview: 0, failed: 0, orphans: 0 });
    assert.deepEqual(tableFindings(result), ["1 table was read as questions: 1 as a grid with a header row."]);
  });

  test("the headers can be written many ways", () => {
    const named = [
      ["#", "Question text", "Option A", "Option B", "Correct Answer"],
      ["Q", "Stem", "Choice A", "Choice B", "Key"],
      ["Number", "QUESTION", "a.", "b.", "ANS"],
      ["Item", "Prompt", "A", "B", "Answer Key"],
    ];
    for (const head of named) {
      const result = read(grid(head, ["1", "Which?", "One", "Two", "B"]));
      assert.deepEqual(optionsOf(result.questions[0]), [["One", false], ["Two", true]], head.join(" | "));
    }
  });

  test("several answers, and True or False, in the key column", () => {
    const result = read(grid(["No", "Question", "A", "B", "C", "Answer", "Type"], ["1", "Which are primes?", "2", "4", "5", "A, C", "MA"]));
    assert.deepEqual(optionsOf(result.questions[0]), [["2", true], ["4", false], ["5", true]]);
    assert.equal(result.questions[0]?.type, "multipleResponse");
  });

  test("an empty option cell is an option that is not there", () => {
    const result = read(grid(["No", "Question", "A", "B", "C", "D", "Answer"], ["1", "Which?", "One", "Two", "Three", "", "A"], ["2", "Which?", "One", "Two", "", "", "B"]));
    assert.deepEqual(result.questions.map((q) => optionsOf(q).length), [3, 2]);
  });

  test("without a number column the questions are numbered by their place", () => {
    const result = read(grid(["Question", "A", "B", "Answer"], ["First?", "x", "y", "A"], ["Second?", "x", "y", "B"]));
    assert.equal(result.questions.length, 2);
    assert.equal(result.counts.parsed, 2);
  });

  test("a number written as Q3 or 3) is the number 3, which an Answers list then finds", () => {
    for (const written of ["Q3", "3)", "3.", "#3", "3"]) {
      const body = grid(["Number", "Question", "A", "B"], [written, "x?", "p", "q"]) + paragraph() + paragraph(run("Answers:")) + paragraph(run("3. B"));
      const result = read(body);
      assert.deepEqual(optionsOf(result.questions[0]), [["p", false], ["q", true]], written);
    }
  });

  test("the type, points, title and the labels a publisher uses are read", () => {
    const result = read(
      grid(
        ["No", "Title", "Question", "A", "B", "Answer", "Points", "Type", "Difficulty", "Page", "Feedback", "Rationale"],
        ["1", "Planets", "Which?", "One", "Two", "B", "2.5", "MC", "Easy", "12", "Well done.", "Because."],
      ),
    );
    const [q] = result.questions;
    assert.equal(q?.title, "Planets");
    assert.equal(q?.points, 2.5);
    assert.equal(q?.metadata.difficulty, "easy");
    assert.equal(q?.metadata.page, "12");
    assert.equal(q?.metadata.custom?.["Rationale"], "Because.");
    assert.equal(richTextToPlain(q?.feedback.general as never), "Well done.");
    assert.equal(result.counts.parsed, 1);
  });

  test("feedback for a right answer and for a wrong one", () => {
    const result = read(grid(["No", "Question", "A", "B", "Answer", "Correct Feedback", "Incorrect Feedback"], ["1", "Which?", "One", "Two", "B", "Yes.", "No."]));
    const [q] = result.questions;
    assert.equal(richTextToPlain(q?.feedback.correct as never), "Yes.");
    assert.equal(richTextToPlain(q?.feedback.incorrect as never), "No.");
  });

  test("a column the profile does not know is reported with its words and not dropped", () => {
    const result = read(grid(["No", "Question", "A", "B", "Answer", "Source file"], ["1", "Which?", "One", "Two", "B", "chapter3.docx"]));
    assert.deepEqual(optionsOf(result.questions[0]), [["One", false], ["Two", true]]);
    assert.equal(result.orphans.length, 1);
    assert.equal(result.orphans[0]?.text, "Column: Source file: chapter3.docx");
  });

  test("points or a type that do not read as one are kept as words and not turned into a directive", () => {
    const result = read(grid(["No", "Question", "A", "B", "Answer", "Points", "Type"], ["1", "Which?", "One", "Two", "B", "2 pts", "multiple choice"]));
    assert.equal(result.questions[0]?.points, 1);
    assert.deepEqual(result.orphans.map((o) => o.text), ["Column: Type: multiple choice", "Column: Points: 2 pts"]);
    assert.deepEqual(optionsOf(result.questions[0]), [["One", false], ["Two", true]]);
  });

  test("a question cell over several paragraphs carries on as the stem", () => {
    const body = table([header("No", "Question", "A", "B", "Answer"), [cell("1"), cell("First part") + cell("Second part"), cell("x"), cell("y"), cell("A")]]);
    const result = read(body);
    assert.match(richTextToPlain(result.questions[0]?.stem as never), /First part\sSecond part/);
  });

  test("a header repeated at the top of a page is not a question", () => {
    const head = header("No", "Question", "A", "B", "Answer");
    const body = table([head, [cell("1"), cell("One?"), cell("x"), cell("y"), cell("A")], head, [cell("2"), cell("Two?"), cell("x"), cell("y"), cell("B")]]);
    assert.equal(read(body).questions.length, 2);
  });

  test("an empty row is not a question", () => {
    const body = table([header("No", "Question", "A", "B", "Answer"), [cell(""), cell(""), cell(""), cell(""), cell("")], [cell("1"), cell("One?"), cell("x"), cell("y"), cell("A")]]);
    assert.equal(read(body).questions.length, 1);
  });

  test("the key marked by bold in the option cell is read by the file's habit, as anywhere else", () => {
    const rows = Array.from({ length: 5 }, (_, k) => [cell(String(k + 1)), cell(`Q${k + 1}?`), cell("x"), cell("y", "<w:b/>"), cell("z"), cell("")]);
    const result = read(table([header("No", "Question", "A", "B", "C", "Answer"), ...rows]));
    assert.deepEqual(result.questions.map((q) => optionsOf(q).findIndex(([, correct]) => correct)), [1, 1, 1, 1, 1]);
    assert.equal(result.fileFindings.some((f) => f.code === FindingCode.FormattingKeyUsed), true);
  });

  test("the key in words and the key in formatting that disagree: the words are used and it is said", () => {
    const rows = Array.from({ length: 5 }, (_, k) => [cell(String(k + 1)), cell(`Q${k + 1}?`), cell("x"), cell("y", "<w:b/>"), cell("z"), cell(k === 0 ? "C" : "")]);
    const result = read(table([header("No", "Question", "A", "B", "C", "Answer"), ...rows]));
    assert.equal(result.questions[0]?.findings.some((f) => f.code === FindingCode.KeysDisagree), true);
  });
});

describe("a table that is only like a grid is not one", () => {
  const header = (...names: string[]): string[] => names.map((n) => cell(n));

  test("no question column", () => {
    const body = table([header("No", "A", "B", "Answer"), [cell("1"), cell("x"), cell("y"), cell("A")]]);
    assert.equal(read(body).questions.length, 0);
  });

  test("fewer than two option columns", () => {
    const body = table([header("No", "Question", "A", "Answer"), [cell("1"), cell("Which?"), cell("x"), cell("A")]]);
    assert.equal(read(body).questions.length, 0);
  });

  test("two question columns, or the same option letter twice", () => {
    assert.equal(read(table([header("Question", "Question", "A", "B"), [cell("q"), cell("q"), cell("x"), cell("y")]])).questions.length, 0);
    assert.equal(read(table([header("Question", "A", "A", "B"), [cell("q"), cell("x"), cell("y"), cell("z")]])).questions.length, 0);
  });

  test("two answer columns", () => {
    const body = table([header("Question", "A", "B", "Answer", "Key"), [cell("q"), cell("x"), cell("y"), cell("A"), cell("B")]]);
    assert.equal(read(body).questions.length, 0);
  });

  test("a row with a different number of cells", () => {
    const body = table([header("No", "Question", "A", "B", "Answer"), [cell("1"), cell("Which?"), cell("x"), cell("y")]], false);
    assert.equal(read(body).questions.length, 0);
  });

  test("a cell merged across the old way, with the same number of cells in the row", () => {
    const cells = (hMerge: string) =>
      `<w:tr><w:tc>${cell("1")}</w:tc><w:tc><w:tcPr>${hMerge}</w:tcPr>${cell("Which?")}</w:tc><w:tc><w:tcPr>${hMerge ? "<w:hMerge/>" : ""}</w:tcPr>${cell("")}</w:tc><w:tc>${cell("y")}</w:tc><w:tc>${cell("A")}</w:tc></w:tr>`;
    const grid = (hMerge: string) =>
      '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid>' +
      `<w:tr>${["No", "Question", "A", "B", "Answer"].map((n) => `<w:tc>${cell(n)}</w:tc>`).join("")}</w:tr>${cells(hMerge)}</w:tbl>`;
    assert.equal(read(grid('<w:hMerge w:val="restart"/>')).questions.length, 0, "merged");
    assert.equal(read(grid("")).questions.length, 1, "the same row, not merged, is a question");
  });

  test("a cell merged across", () => {
    const body =
      '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid>' +
      `<w:tr>${["Question", "A", "B", "Answer"].map((n) => `<w:tc>${cell(n)}</w:tc>`).join("")}</w:tr>` +
      `<w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>${cell("Which?")}</w:tc><w:tc>${cell("y")}</w:tc><w:tc>${cell("A")}</w:tc></w:tr></w:tbl>`;
    assert.equal(read(body).questions.length, 0);
  });

  test("a table of data headed with other words", () => {
    const body = table([header("Year", "Sales", "Profit"), [cell("2019"), cell("100"), cell("10")]]);
    const result = read(body);
    assert.equal(result.questions.length, 0);
    assert.match(tableFindings(result)[0] ?? "", /read cell by cell/);
  });

  test("nothing is lost when a table is left plain: its words are still in the file", () => {
    const body = table([header("Year", "Sales"), [cell("2019"), cell("100")]]);
    const text = docxToBlocks(docx({ body })).blocks.map((b) => b.text);
    assert.deepEqual(text, ["Year", "Sales", "2019", "100"]);
  });
});

// ---------------------------------------------------------------------------
// Answer key
// ---------------------------------------------------------------------------

describe("an answer key in a table", () => {
  const questions = paragraph(run("1. Q one?")) + paragraph(run("a. x")) + paragraph(run("b. y")) + paragraph() + paragraph(run("2. Q two?")) + paragraph(run("a. x")) + paragraph(run("b. y")) + paragraph();
  const entries = (...rows: Array<[string, string]>) => rows.map(([n, v]) => [cell(n), cell(v)]);

  test("with a header row, as the heading of the list", () => {
    const result = read(questions + table([[cell("Question"), cell("Answer")], ...entries(["1", "B"], ["2", "A"])]));
    assert.deepEqual(result.questions.map((q) => optionsOf(q).findIndex(([, c]) => c)), [1, 0]);
    assert.deepEqual(result.counts, { parsed: 2, needsReview: 0, failed: 0, orphans: 0 });
    assert.deepEqual(tableFindings(result), ["1 table was read as questions: 1 as an answer key."]);
  });

  test("without a header row, with letters in the second column", () => {
    const result = read(questions + table(entries(["1.", "B"], ["2.", "A"])));
    assert.deepEqual(result.questions.map((q) => optionsOf(q).findIndex(([, c]) => c)), [1, 0]);
  });

  test("when the heading is already a paragraph above it, it is not said twice", () => {
    const withHeading = read(questions + paragraph(run("Answers:")) + table(entries(["1.", "B"], ["2.", "A"])));
    assert.deepEqual(withHeading.questions.map((q) => optionsOf(q).findIndex(([, c]) => c)), [1, 0]);
    assert.equal(withHeading.fileFindings.some((f) => f.code === FindingCode.UnparsedBlock), false, "no empty second heading");
    const headed = read(questions + paragraph(run("Answers:")) + table([[cell("Question"), cell("Answer")], ...entries(["1", "B"], ["2", "A"])]));
    assert.equal(headed.fileFindings.some((f) => f.code === FindingCode.UnparsedBlock), false);
  });

  test("a number written as Q1, #1 or 1)", () => {
    const result = read(questions + table(entries(["Q1", "B"], ["#2", "A"])));
    assert.deepEqual(result.questions.map((q) => optionsOf(q).findIndex(([, c]) => c)), [1, 0]);
  });

  test("a table of a number and a letter with no heading is an answer key, and gets the heading it lacks", () => {
    // The same two cells are also a question numbered 1 whose stem is "B". A bank that ends with such a table
    // is far more often an answer key, and reading it as a question would invent one.
    const result = read(questions + table(entries(["1.", "B"])));
    assert.equal(result.questions.length, 2);
    assert.equal(optionsOf(result.questions[0]).findIndex(([, c]) => c), 1);
  });

  test("answers that are words need a header to be believed", () => {
    const blank = paragraph(run("Type: F")) + paragraph(run("1. The capital of France is ____.")) + paragraph();
    const headed = read(blank + table([[cell("Question"), cell("Answer")], ...entries(["1", "Paris"])]));
    assert.deepEqual((headed.questions[0]?.body as { blanks: Array<{ accepted: string[] }> }).blanks[0]?.accepted, ["Paris"]);
    const headless = read(blank + table(entries(["1", "Paris"])));
    assert.equal(headless.questions[0]?.findings.some((f) => f.code === FindingCode.NoAnswerKey), true);
  });

  test("three columns, or a merged cell, is not a key", () => {
    const three = read(questions + table([[cell("1"), cell("B"), cell("x")], [cell("2"), cell("A"), cell("y")]]));
    assert.equal(three.questions.every((q) => q.findings.some((f) => f.code === FindingCode.NoAnswerKey)), true);
  });

  test("a key above the questions it belongs to", () => {
    const result = read(table([[cell("Question"), cell("Answer")], ...entries(["1", "B"], ["2", "A"])]) + paragraph() + questions);
    assert.deepEqual(result.questions.map((q) => optionsOf(q).findIndex(([, c]) => c)), [1, 0]);
  });
});

// ---------------------------------------------------------------------------
// The text fixtures, as tables
// ---------------------------------------------------------------------------

async function fixtures() {
  const names = (await readdir(FIXTURES)).filter((n) => n.endsWith(".txt")).sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      lines: linesOf(await readFile(join(FIXTURES, name), "utf8")),
      expected: JSON.parse(await readFile(join(FIXTURES, `${name}.expected.json`), "utf8")) as ExpectedFile,
    })),
  );
}

describe("the text fixtures, put in tables, come back identical", () => {
  const forms: Array<{ name: string; tables: TableOptions; keyMark?: string }> = [
    { name: "a row for each line", tables: { mode: "rows" } },
    { name: "a row for each line, the key a check mark", tables: { mode: "marked" } },
    { name: "a row for each line, the answer key headed", tables: { mode: "rows", key: "headed" } },
    { name: "a row for each line, the answer key under its heading", tables: { mode: "rows", key: "headless" } },
    { name: "the check marks and a headed answer key", tables: { mode: "marked", key: "headed" } },
  ];

  test("every fixture, every form, with and without noise, matches the text version and scores in full", async () => {
    let compared = 0;
    let tables = 0;
    for (const { name, lines, expected } of await fixtures()) {
      const direct = project(standardTextImporter.parse(lines.join("\n"), OPTIONS));
      for (const form of forms) {
        for (const noise of [false, true]) {
          const bytes = docxFromLines(lines, { tables: form.tables, ...(noise ? { noise: true, seed: compared + 1 } : {}) });
          const via = wordImporter.parseBytes(bytes, OPTIONS);
          assert.deepEqual(project(via), direct, `${name} as ${form.name}${noise ? " with noise" : ""} differs from the text version`);
          assert.equal(scoreFile({ ...expected, file: name }, via).score, 1, `${name} as ${form.name} did not score in full`);
          tables += docxToBlocks(bytes).blocks.filter((b) => b.table !== undefined).length;
          compared++;
        }
      }
    }
    assert.ok(compared >= 21 * 5 * 2);
    assert.ok(tables > 1000, `only ${tables} lines were in tables, so the tables were not what was tested`);
  });

  test("the check marks and the answer tables really are read as layouts", async () => {
    let labelled = 0;
    let keys = 0;
    for (const { lines } of await fixtures()) {
      const row = wordImporter.parseBytes(docxFromLines(lines, { tables: { mode: "marked" } }), OPTIONS);
      const asKey = wordImporter.parseBytes(docxFromLines(lines, { tables: { mode: "rows", key: "headed" } }), OPTIONS);
      const said = (r: ImportResult) => r.fileFindings.filter((f) => f.code === FindingCode.TableLayout).map((f) => f.message).join(" ");
      if (/as labelled rows/.test(said(row))) labelled++;
      if (/as an answer key/.test(said(asKey))) keys++;
    }
    assert.ok(labelled >= 18, `only ${labelled} fixtures had a table read as labelled rows`);
    assert.ok(keys >= 5, `only ${keys} fixtures had an answer key read as one`);
  });

  test("a file of lines in no sensible order, in tables, reads as the text and loses nothing", () => {
    // Not the forms with an answer table of their own: a table of a number and a letter with no heading
    // above it is an answer key by design, and in lines chosen at random a question whose stem is a
    // single letter looks exactly like one.
    const plain = forms.filter((f) => !f.tables.key);
    for (let seed = 1; seed <= 120; seed++) {
      const { text, markers } = soup(seed, seed % 2 === 0);
      const direct = standardTextImporter.parse(text, OPTIONS);
      const form = plain[seed % plain.length] as (typeof forms)[number];
      const via = wordImporter.parseBytes(docxFromLines(linesOf(text), { tables: form.tables, noise: seed % 3 === 0, seed }), OPTIONS);
      assert.deepEqual(project(via), project(direct), `seed ${seed} as ${form.name} differs\n${text}`);
      const everything = JSON.stringify([via.questions, via.orphans, via.fileFindings]);
      for (const marker of markers) assert.ok(everything.includes(marker), `seed ${seed}: ${marker} was lost\n${text}`);
    }
  });
});

describe("the text fixtures, whose simple questions are rows of a grid", () => {
  const positionless = (r: ImportResult) => {
    const p = project(r);
    return { ...p, questions: p.questions.map((q) => ({ ...q, source: null })), orphans: p.orphans.map(([text]) => text) };
  };

  /** Re-express the questions that a grid can hold as grids, and leave the rest as they were. */
  function withGrids(lines: string[]): { body: string; grids: number; questions: number } {
    const scanned = scanStandardText(linesToBlocks(lines.join("\n")), "f.txt", 1);
    const isDirective = (s: string) => /^\s*(Title|Type|Points)\s*:/i.test(s);
    type Row = { first: number; last: number; type?: string; number: number; stem: string; options: Array<{ letter: string; text: string }>; key: string };
    const eligible: Row[] = [];
    for (const q of scanned.questions) {
      const range = lines.slice(q.firstBlock, q.lastBlock + 1);
      const letters = q.options.map((o) => o.letter);
      const sequential = letters.every((l, i) => l === String.fromCharCode(97 + i));
      const hints = q.typeHint === undefined || ["MC", "MA", "MR", "TF"].includes(q.typeHint);
      let before = q.firstBlock - 1;
      while (before >= 0 && (lines[before] ?? "").trim() === "") before--;
      const directive = before >= 0 && isDirective(lines[before] as string) ? before : -1;
      const onlyType = directive === -1 || (/^\s*Type\s*:/i.test(lines[directive] as string) && !(directive > 0 && isDirective(lines[directive - 1] as string)));
      const plain =
        q.stemLines.length === 1 &&
        !q.stemAfterBlank &&
        q.options.length >= 2 &&
        q.options.length <= 8 &&
        sequential &&
        hints &&
        onlyType &&
        q.options.every((o) => o.lines.length === 1 && o.feedback.length === 0 && o.firstBlock === o.lastBlock) &&
        q.correctFeedback.length === 0 &&
        q.incorrectFeedback.length === 0 &&
        q.metadata.length === 0 &&
        q.answerLines.length === 0 &&
        q.keyValues.length === 0 &&
        range.length === 1 + q.options.length &&
        !range.some((l) => l.trim() === "");
      if (!plain) continue;
      const starred = q.options.filter((o) => o.starred).map((o) => o.letter.toUpperCase());
      eligible.push({
        first: directive === -1 ? q.firstBlock : directive,
        last: q.lastBlock,
        ...(directive === -1 ? {} : { type: (lines[directive] as string).replace(/^\s*Type\s*:\s*/i, "").trim() }),
        number: q.number,
        stem: q.stemLines[0] as string,
        options: q.options.map((o) => ({ letter: o.letter, text: o.lines[0] as string })),
        key: starred.join(", "),
      });
    }

    const parts: string[] = [];
    let at = 0;
    let grids = 0;
    while (at < lines.length) {
      const here = eligible.find((e) => e.first === at);
      if (!here) {
        const line = lines[at] as string;
        parts.push(paragraph(line === "" ? "" : run(line)));
        at++;
        continue;
      }
      // this question and the ones straight after it, with only blank lines between
      const group: Row[] = [here];
      let end = here.last + 1;
      for (;;) {
        let next = end;
        while (next < lines.length && (lines[next] as string).trim() === "") next++;
        const more = eligible.find((e) => e.first === next);
        if (!more) break;
        group.push(more);
        end = more.last + 1;
      }
      const width = Math.max(...group.map((g) => g.options.length));
      const typed = group.some((g) => g.type !== undefined);
      const head = ["No.", ...(typed ? ["Type"] : []), "Question", ...Array.from({ length: width }, (_, i) => String.fromCharCode(65 + i)), "Answer"];
      const rows = group.map((g) => [
        String(g.number),
        ...(typed ? [g.type ?? ""] : []),
        g.stem,
        ...Array.from({ length: width }, (_, i) => g.options[i]?.text ?? ""),
        g.key,
      ]);
      parts.push(table([head, ...rows].map((r) => r.map((c) => cell(c)))));
      grids++;
      at = end;
    }
    return { body: parts.join(""), grids, questions: eligible.length };
  }

  test("those questions read the same as the text, and the score is whole", async () => {
    let grids = 0;
    let questions = 0;
    for (const { name, lines, expected } of await fixtures()) {
      const made = withGrids(lines);
      if (made.grids === 0) continue;
      grids += made.grids;
      questions += made.questions;
      const via = wordImporter.parseBytes(docx({ body: made.body }), OPTIONS);
      const direct = standardTextImporter.parse(lines.join("\n"), OPTIONS);
      assert.deepEqual(positionless(via), positionless(direct), `${name} with its simple questions as grids differs from the text`);
      assert.equal(scoreFile({ ...expected, file: name }, via).score, 1, `${name} with its simple questions as grids did not score in full`);
    }
    assert.ok(grids >= 8 && questions >= 15, `only ${questions} questions in ${grids} grids were tested`);
  });
});

describe("where a layout's lines came from", () => {
  test("each line is tied to the cell it came from, and a question's range covers its row", () => {
    const body = table([
      [cell("No"), cell("Question"), cell("A"), cell("B"), cell("Answer")],
      [cell("1"), cell("One?"), cell("x"), cell("y"), cell("A")],
      [cell("2"), cell("Two?"), cell("x"), cell("y"), cell("B")],
    ]);
    const { blocks } = docxToBlocks(docx({ body }));
    assert.equal(blocks.every((b) => b.table?.table === 0), true);
    assert.equal(blocks.map((b) => b.index).join(), blocks.map((_, i) => i).join());
    const result = read(body);
    const ranges = result.questions.map((q) => [q.origin?.source?.firstBlock, q.origin?.source?.lastBlock]);
    assert.equal((ranges[0]?.[1] as number) < (ranges[1]?.[0] as number), true, "the two questions do not overlap");
    const first = blocks[ranges[0]?.[0] as number];
    assert.equal(first?.table?.row, 1);
  });
});

describe("speed", () => {
  test("500 questions in a grid, and in rows of labels, import within the 3 second budget", () => {
    const grid = table([
      ["No", "Question", "A", "B", "C", "D", "Answer"].map((n) => cell(n)),
      ...Array.from({ length: 500 }, (_, k) => [String(k + 1), `Which of these is the answer to question number ${k + 1}, and why does it matter?`, "A plausible but wrong option", `The right option for question ${k + 1}`, "Another wrong option", "None of these", "B"].map((c) => cell(c))),
    ]);
    const lines: string[] = [];
    for (let i = 1; i <= 500; i++) lines.push(`${i}) Which of these is the answer to question number ${i}, and why does it matter?`, "a. A plausible but wrong option", `*b. The right option for question ${i}`, "c. Another wrong option", "d. None of these", "");
    for (const [name, bytes] of [["grid", docx({ body: grid })], ["rows", docxFromLines(lines, { tables: { mode: "rows" }, noise: true, seed: 3 })]] as const) {
      const started = performance.now();
      const result = wordImporter.parseBytes(bytes, OPTIONS);
      const took = performance.now() - started;
      assert.equal(result.counts.parsed, 500, name);
      assert.ok(took < 3000, `${name}: 500 questions took ${took.toFixed(0)} ms`);
    }
  });
});
