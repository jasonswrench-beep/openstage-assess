/**
 * The question spreadsheet that OpenStage Author and OpenStage Scroll read.
 *
 * Author documents the file (docs/question-import.md in that project) and
 * refuses what does not fit it: more than 200 questions in a file, a multiple
 * choice with two right answers, a short answer with more than ten accepted
 * answers. The reader in this file applies those documented rules to what the
 * exporter writes. It is written here from the documentation, so these tests do
 * not depend on another project being on the same machine. The exporter was also
 * checked once against Author's own reader.
 *
 * The behaviour that matters most is the destination check: a question that
 * cannot go is left out and said so, a question that loses something says what,
 * and no answer key is ever guessed to make a row fit.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  checkOpenStageSpreadsheet,
  exportOpenStageSpreadsheet,
  MAX_ACCEPTED,
  MAX_ANSWERS,
  MAX_QUESTIONS_PER_FILE,
} from "../src/export/openstage-spreadsheet.ts";
import { formatReport, type ReportItem } from "../src/export/types.ts";
import { standardTextImporter } from "../src/import/standard-text.ts";
import { createQuestion, type CreateQuestionInput } from "../src/model/create.ts";
import { rich, plainToRich, mediaPlaceholder, mathPlaceholder } from "../src/model/richtext.ts";
import type { Question } from "../src/model/question.ts";

// ---------------------------------------------------------------------------
// Making questions
// ---------------------------------------------------------------------------

type Extra = Partial<Omit<CreateQuestionInput, "type" | "stem" | "body">>;

function mc(stem: string, options: Array<[string, boolean]>, extra: Extra = {}): Question {
  return createQuestion({
    type: "multipleChoice",
    stem: plainToRich(stem),
    body: {
      shuffle: true,
      options: options.map(([text, correct], i) => ({ id: `o${i + 1}`, content: plainToRich(text), correct })),
    },
    ...extra,
  });
}

function mr(stem: string, options: Array<[string, boolean]>, extra: Extra = {}, partialCredit = false): Question {
  return createQuestion({
    type: "multipleResponse",
    stem: plainToRich(stem),
    body: {
      shuffle: true,
      partialCredit,
      options: options.map(([text, correct], i) => ({ id: `o${i + 1}`, content: plainToRich(text), correct })),
    },
    ...extra,
  });
}

function tf(stem: string, correct: boolean | undefined, extra: Extra = {}): Question {
  return createQuestion({
    type: "trueFalse",
    stem: plainToRich(stem),
    body: correct === undefined ? {} : { correct },
    ...extra,
  });
}

function sa(stem: string, accepted: string[], extra: Extra = {}, caseSensitive = false): Question {
  return createQuestion({ type: "shortAnswer", stem: plainToRich(stem), body: { caseSensitive, accepted }, ...extra });
}

function fib(stem: string, blanks: string[][], extra: Extra = {}, caseSensitive = false): Question {
  return createQuestion({
    type: "fillInBlank",
    stem: plainToRich(stem),
    body: { caseSensitive, blanks: blanks.map((accepted, i) => ({ id: `b${i + 1}`, accepted })) },
    ...extra,
  });
}

const FOUR: Array<[string, boolean]> = [
  ["Mars", true],
  ["The Moon", false],
  ["The Sun", false],
  ["Sirius", false],
];

// ---------------------------------------------------------------------------
// Reading the file the way Author's documentation says it reads it
// ---------------------------------------------------------------------------

/** CSV into rows of cells: a byte order mark is ignored, quotes hold commas and line breaks, and two quotes mean one. */
function readCsv(raw: string): string[][] {
  const text = raw.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

interface ReadRow {
  [column: string]: string;
}

function table(csv: string): { header: string[]; rows: ReadRow[] } {
  const [header = [], ...body] = readCsv(csv);
  const rows = body.map((cells) => Object.fromEntries(header.map((name, i) => [name, cells[i] ?? ""])));
  return { header, rows };
}

/** The rules Author documents, as problems. An empty list means Author would take every row. */
function problemsAuthorWouldFind(csv: string): string[] {
  const { header, rows } = table(csv);
  const problems: string[] = [];
  if (!header.includes("Question")) problems.push("No column is called Question.");
  if (rows.length > 200) problems.push(`The file holds ${rows.length} questions and at most 200 can be added at once.`);
  rows.forEach((row, k) => {
    const at = `row ${k + 2}`;
    const answers = "ABCDEFGH".split("").map((letter) => (row[letter] ?? "").trim());
    const filled = answers.filter((a) => a !== "");
    const lastFilled = answers.reduce((last, a, i) => (a !== "" ? i : last), -1);
    const correct = (row["Correct"] ?? "").trim();
    if ((row["Question"] ?? "").trim() === "") problems.push(`${at}: there is no question`);
    switch (row["Type"]) {
      case "MC":
      case "MR": {
        if (filled.length < 2) problems.push(`${at}: needs at least two answers`);
        if (answers.slice(0, lastFilled + 1).some((a) => a === "")) problems.push(`${at}: an empty answer sits between filled ones`);
        const letters = correct.split(/[,;|/]|\s+and\s+|\s+/i).map((t) => t.trim()).filter((t) => t !== "");
        if (letters.length === 0) problems.push(`${at}: the Correct column is empty`);
        for (const letter of letters) {
          if (!/^[A-H]$/.test(letter) || (answers["ABCDEFGH".indexOf(letter)] ?? "") === "") {
            problems.push(`${at}: "${letter}" is not one of the answers`);
          }
        }
        if (row["Type"] === "MC" && letters.length > 1) problems.push(`${at}: a multiple choice question has one right answer`);
        if (row["Type"] === "MR" && letters.length >= filled.length) problems.push(`${at}: every answer is right`);
        break;
      }
      case "TF":
        if (correct !== "True" && correct !== "False") problems.push(`${at}: needs True or False in Correct`);
        if (filled.length > 0) problems.push(`${at}: a true or false question has no answers of its own`);
        break;
      case "SA": {
        const accepted = filled.length > 0 ? filled : correct.split("|").map((s) => s.trim()).filter((s) => s !== "");
        if (accepted.length === 0) problems.push(`${at}: nothing is accepted`);
        if (accepted.length > 10) problems.push(`${at}: more than ten accepted answers`);
        break;
      }
      default:
        problems.push(`${at}: the type "${row["Type"]}" is not one Author knows`);
    }
  });
  return problems;
}

function only(questions: Question[]): { row: ReadRow; item: ReportItem; csv: string } {
  const result = exportOpenStageSpreadsheet(questions, { name: "t" });
  const item = result.report.items[0] as ReportItem;
  const file = result.files[0];
  return { row: file ? (table(file.content).rows[0] as ReadRow) : {}, item, csv: file?.content ?? "" };
}

// ---------------------------------------------------------------------------

describe("the file", () => {
  test("matches the shape of Author's own template: a byte order mark, CRLF, and named columns", () => {
    const { csv } = only([mc("Which is a planet?", FOUR)]);
    assert.ok(csv.startsWith("﻿Type,Question,A,B,C,D,Correct,Points,Feedback if right,Feedback if wrong\r\n"));
    assert.ok(csv.endsWith("\r\n"));
    assert.equal(csv.includes("\n") && !csv.replace(/\r\n/g, "").includes("\n"), true, "every line end is CRLF");
  });

  test("has no Attempts column, because attempts are a delivery setting", () => {
    const { csv } = only([mc("Which is a planet?", FOUR)]);
    assert.equal(table(csv).header.includes("Attempts"), false);
  });

  test("a multiple choice question is one row with the letter of the right answer", () => {
    const { row, item } = only([mc("Which is a planet?", [["Sirius", false], ["Mars", true], ["The Sun", false]], { points: 2.5 })]);
    assert.equal(row["Type"], "MC");
    assert.equal(row["Question"], "Which is a planet?");
    assert.deepEqual([row["A"], row["B"], row["C"]], ["Sirius", "Mars", "The Sun"]);
    assert.equal(row["Correct"], "B");
    assert.equal(row["Points"], "2.5", "points are written as they are in the bank, not left to Author's default of 10");
    assert.equal(item.outcome, "exported");
    assert.deepEqual(item.notes, []);
  });

  test("a multiple response question lists every right letter", () => {
    const { row } = only([mr("Which are mammals?", [["Dolphin", true], ["Trout", false], ["Bat", true], ["Gecko", false]])]);
    assert.equal(row["Type"], "MR");
    assert.equal(row["Correct"], "A, C");
  });

  test("true or false writes True or False and no answers", () => {
    const yes = only([tf("The sky is blue.", true)]).row;
    const no = only([tf("The sky is green.", false)]).row;
    assert.deepEqual([yes["Type"], yes["Correct"], yes["A"]], ["TF", "True", ""]);
    assert.deepEqual([no["Type"], no["Correct"], no["A"]], ["TF", "False", ""]);
  });

  test("only as many answer columns as the widest question needs, and at least two", () => {
    assert.deepEqual(table(only([tf("x?", true)]).csv).header.slice(0, 5), ["Type", "Question", "A", "B", "Correct"]);
    const wide = only([mc("Pick.", Array.from({ length: 6 }, (_, i): [string, boolean] => [`Option ${i}`, i === 2])), ]);
    assert.deepEqual(table(wide.csv).header.slice(2, 8), ["A", "B", "C", "D", "E", "F"]);
  });

  test("commas, quotes, semicolons, accents and line breaks survive a round trip", () => {
    // The model stores straight quotes and "--" for a dash (see normalizeCharacters),
    // so those are what a question holds by the time it is exported.
    const awkward = 'He said, "café; résumé" -- didn\'t he?';
    const q = mc(awkward, [["One, two", true], ['Say "hi"', false]], {
      feedback: { correct: plainToRich("Yes.\n\nBecause, you see."), incorrect: plainToRich('No; "really".') },
    });
    const { row, csv } = only([q]);
    assert.equal(row["Question"], awkward);
    assert.equal(row["A"], "One, two");
    assert.equal(row["B"], 'Say "hi"');
    assert.equal(row["Feedback if right"], "Yes.\nBecause, you see.", "feedback keeps its line breaks, so Author starts a new paragraph");
    assert.equal(row["Feedback if wrong"], 'No; "really".');
    assert.deepEqual(problemsAuthorWouldFind(csv), []);
  });

  test("everything it writes satisfies the rules Author documents", () => {
    const { csv } = only([
      mc("A?", FOUR),
      mr("B?", FOUR.map(([t, c], i): [string, boolean] => [t, i < 2 ? true : c && false])),
      tf("C?", false),
      sa("D?", ["x", "y"]),
      fib("E ____?", [["z"]]),
    ]);
    assert.deepEqual(problemsAuthorWouldFind(csv), []);
  });
});

describe("short answers", () => {
  test("accepted answers go in the answer columns", () => {
    const { row } = only([sa("Capital of Italy?", ["Rome", "Roma"])]);
    assert.deepEqual([row["Type"], row["A"], row["B"], row["Correct"]], ["SA", "Rome", "Roma", ""]);
  });

  test("nine or ten go in the Correct column, separated by bars", () => {
    for (const count of [MAX_ANSWERS + 1, MAX_ACCEPTED]) {
      const accepted = Array.from({ length: count }, (_, i) => `form ${i + 1}`);
      const { row, csv } = only([sa("Many forms?", accepted)]);
      assert.equal(row["A"], "", `${count}: the answer columns are empty`);
      assert.equal(row["Correct"], accepted.join("|"), String(count));
      assert.deepEqual(problemsAuthorWouldFind(csv), []);
    }
  });

  test("more than ten is left out, because Author takes at most ten", () => {
    const { item, csv } = only([sa("Too many?", Array.from({ length: MAX_ACCEPTED + 1 }, (_, i) => `form ${i}`))]);
    assert.equal(item.outcome, "leftOut");
    assert.match(item.notes[0] ?? "", /at most 10/);
    assert.equal(csv, "", "no file when nothing can be written");
  });

  test("nine answers with a bar in one are left out, because the bar is the separator", () => {
    const { item } = only([sa("Bars?", ["a|b", ...Array.from({ length: 8 }, (_, i) => `form ${i}`)])]);
    assert.equal(item.outcome, "leftOut");
    assert.match(item.notes[0] ?? "", /bar/);
  });

  test("a fill in the blank with one blank is written as a short answer, and says so", () => {
    const { row, item } = only([fib("The capital of France is ____.", [["Paris", "paris"]])]);
    assert.deepEqual([row["Type"], row["A"], row["B"]], ["SA", "Paris", "paris"]);
    assert.equal(item.outcome, "exportedWithLosses");
    assert.equal(item.asType, "short answer");
    assert.match(item.notes.join(" "), /written as a short answer/);
  });

  test("a fill in the blank with two blanks is left out, not squeezed into one", () => {
    const { item } = only([fib("A ____ by any other ____.", [["rose"], ["name"]])]);
    assert.equal(item.outcome, "leftOut");
    assert.match(item.notes[0] ?? "", /2 blanks/);
  });

  test("case sensitivity cannot be carried, and is reported", () => {
    const { item } = only([sa("Symbol for sodium?", ["Na"], {}, true)]);
    assert.equal(item.outcome, "exportedWithLosses");
    assert.match(item.notes.join(" "), /Upper and lower case/);
  });
});

describe("what cannot go is left out, and said so", () => {
  const unsupported: Array<[string, Question]> = [
    [
      "matching",
      createQuestion({
        type: "matching",
        stem: plainToRich("Match."),
        body: { shuffle: true, distractors: [], pairs: [{ id: "p1", left: plainToRich("a"), right: "1" }, { id: "p2", left: plainToRich("b"), right: "2" }] },
      }),
    ],
    [
      "ordering",
      createQuestion({
        type: "ordering",
        stem: plainToRich("Order."),
        body: { items: [{ id: "i1", content: plainToRich("a"), position: 1 }, { id: "i2", content: plainToRich("b"), position: 2 }] },
      }),
    ],
    ["numeric", createQuestion({ type: "numeric", stem: plainToRich("How many?"), body: { mode: "exact", value: 4 } })],
    ["essay", createQuestion({ type: "essay", stem: plainToRich("Discuss."), body: {} })],
    [
      "hotspot",
      createQuestion({
        type: "hotspot",
        stem: plainToRich("Click it."),
        body: { mediaRef: "m_1", alternative: plainToRich("Alt"), regions: [{ id: "r1", shape: "rect", coords: [0, 0, 1, 1], correct: true }] },
      }),
    ],
    [
      "calculated",
      createQuestion({
        type: "calculated",
        stem: plainToRich("Compute."),
        body: { formula: "a+b", variables: [{ name: "a", min: 1, max: 2, decimals: 0 }], tolerance: 0, toleranceIsPercent: false },
      }),
    ],
  ];

  for (const [name, question] of unsupported) {
    test(`a ${name} question is left out and named`, () => {
      const result = exportOpenStageSpreadsheet([question], { name: "t" });
      const item = result.report.items[0] as ReportItem;
      assert.equal(item.outcome, "leftOut");
      assert.match(item.notes[0] ?? "", new RegExp(`${name} question cannot be written`));
      assert.equal(result.files.length, 0);
    });
  }

  test("a question with no right answer is left out with the bank's own reason, and no key is guessed", () => {
    const { item, csv } = only([mc("Which is a planet?", FOUR.map(([t]): [string, boolean] => [t, false]))]);
    assert.equal(item.outcome, "leftOut");
    assert.match(item.notes[0] ?? "", /No option is marked correct/);
    assert.equal(csv, "");
  });

  test("an unkeyed true or false is left out, never written as False", () => {
    const { item, csv } = only([tf("Is it?", undefined)]);
    assert.equal(item.outcome, "leftOut");
    assert.equal(csv, "");
  });

  test("an unkeyed short answer is left out", () => {
    const { item } = only([sa("Who?", [""])]);
    assert.equal(item.outcome, "leftOut");
  });

  test("a question with more answers than the eight columns is left out", () => {
    const { item } = only([mc("Pick.", Array.from({ length: 9 }, (_, i): [string, boolean] => [`Option ${i}`, i === 0]))]);
    assert.equal(item.outcome, "leftOut");
    assert.match(item.notes[0] ?? "", /9 answers and the spreadsheet holds 8/);
  });

  test("a multiple response with every answer right is left out, because Author refuses it", () => {
    const { item } = only([mr("All?", [["a", true], ["b", true]])]);
    assert.equal(item.outcome, "leftOut");
    assert.match(item.notes[0] ?? "", /Every answer is marked right/);
  });

  test("a left-out question does not appear in the file, and the others still do", () => {
    const result = exportOpenStageSpreadsheet(
      [mc("First?", FOUR), createQuestion({ type: "essay", stem: plainToRich("Discuss."), body: {} }), tf("Third?", true)],
      { name: "t" },
    );
    const rows = table(result.files[0]?.content ?? "").rows;
    assert.deepEqual(rows.map((r) => r["Question"]), ["First?", "Third?"]);
    assert.deepEqual(result.report.items.map((i) => [i.position, i.outcome]), [[1, "exported"], [2, "leftOut"], [3, "exported"]]);
  });
});

describe("what is lost on the way is reported against the question", () => {
  test("a multiple response with partial credit on arrives as meant, because Author always scores a share", () => {
    const { item } = only([mr("Which are mammals?", [["Dolphin", true], ["Trout", false], ["Bat", true]], {}, true)]);
    assert.equal(item.outcome, "exported");
    assert.deepEqual(item.notes, []);
  });

  test("feedback under an answer, general feedback and all-or-nothing scoring", () => {
    const q = createQuestion({
      type: "multipleResponse",
      stem: plainToRich("Which are mammals?"),
      body: {
        shuffle: true,
        partialCredit: false,
        options: [
          { id: "o1", content: plainToRich("Dolphin"), correct: true },
          { id: "o2", content: plainToRich("Trout"), correct: false, feedback: plainToRich("Fish.") },
          { id: "o3", content: plainToRich("Bat"), correct: true },
        ],
      },
      feedback: { general: plainToRich("Mammals are warm blooded.") },
    });
    const { item } = only([q]);
    const text = item.notes.join("\n");
    assert.equal(item.outcome, "exportedWithLosses");
    assert.match(text, /Feedback written under individual answers is not carried \(1 answer has it\)/);
    assert.match(text, /General feedback is not carried/);
    assert.match(text, /all or nothing, and Author always gives a share/);
  });

  test("a question that keeps its answers in order says the spreadsheet cannot", () => {
    const q = mc("Pick.", [["a", true], ["All of the above", false]]);
    (q.body as { shuffle: boolean }).shuffle = false;
    const { item } = only([q]);
    assert.match(item.notes.join(" "), /fixed order/);
  });

  test("a picture is written into the text with its alternative text, and counted", () => {
    const q = createQuestion({
      type: "multipleChoice",
      stem: rich(`<p>What does this chart ${mediaPlaceholder("m_1")} show?</p>`),
      body: { shuffle: true, options: [{ id: "o1", content: plainToRich("Sales"), correct: true }, { id: "o2", content: plainToRich("Rain"), correct: false }] },
      media: [{ id: "m_1", file: "media/m_1.png", mime: "image/png", alt: "A bar chart of sales" }],
    });
    const { row, item } = only([q]);
    assert.equal(row["Question"], "What does this chart [Picture: A bar chart of sales] show?");
    assert.match(item.notes.join(" "), /1 picture cannot be carried/);
  });

  test("a picture with no alternative text is marked, and a decorative one is not", () => {
    const make = (alt: string, decorative: boolean) =>
      createQuestion({
        type: "trueFalse",
        stem: rich(`<p>See ${mediaPlaceholder("m_1")} here.</p>`),
        body: { correct: true },
        media: [{ id: "m_1", file: "media/m_1.png", mime: "image/png", alt, ...(decorative ? { decorative: true } : {}) }],
      });
    assert.equal(only([make("", false)]).row["Question"], "See [Picture] here.");
    assert.equal(only([make("", true)]).row["Question"], "See here.");
    assert.match(only([make("", true)]).item.notes.join(" "), /1 picture/, "still counted, so the author can put it back");
  });

  test("an equation is written as its LaTeX, with characters that look like markup left alone", () => {
    const q = createQuestion({
      type: "trueFalse",
      stem: rich(`<p>Is ${mathPlaceholder("e_1")} true?</p>`),
      body: { correct: true },
      math: [{ id: "e_1", latex: "x<y & y>2", mathml: "<math/>" }],
    });
    const { row, item } = only([q]);
    assert.equal(row["Question"], "Is [Equation: x<y & y>2] true?");
    assert.match(item.notes.join(" "), /1 equation became text/);
  });

  test("bold, lists and tables become plain text, and table cells do not run together", () => {
    const q = createQuestion({
      type: "multipleChoice",
      stem: rich("<p>Read the <strong>table</strong>.</p><table><tr><td>Name</td><td>Age</td></tr></table>"),
      body: { shuffle: true, options: [{ id: "o1", content: rich("<ul><li>one</li><li>two</li></ul>"), correct: true }, { id: "o2", content: plainToRich("none"), correct: false }] },
    });
    const { row, item } = only([q]);
    assert.equal(row["Question"], "Read the table. Name Age");
    assert.equal(row["A"], "one two");
    assert.match(item.notes.join(" "), /Bold, italics, lists or tables/);
  });

  test("paragraph breaks in the question become spaces, as Author reads them, and feedback keeps its own", () => {
    const q = tf("First paragraph.\n\nSecond paragraph.", true, { feedback: { correct: plainToRich("Line one.\n\nLine two.") } });
    const { row, item } = only([q]);
    assert.equal(row["Question"], "First paragraph. Second paragraph.");
    assert.equal(row["Feedback if right"], "Line one.\nLine two.", "a line break in a feedback cell starts a new paragraph in Author");
    assert.match(item.notes.join(" "), /Paragraph breaks/);
  });

  test("plain-format text is not read as markup", () => {
    const q = createQuestion({ type: "trueFalse", stem: { format: "plain", content: "Is a < b and c > d?" }, body: { correct: true } });
    assert.equal(only([q]).row["Question"], "Is a < b and c > d?");
  });

  test("a clean question says nothing", () => {
    const { item } = only([mc("Which is a planet?", FOUR)]);
    assert.equal(item.outcome, "exported");
    assert.deepEqual(item.notes, []);
  });
});

describe("a bank larger than a file", () => {
  const many = (n: number): Question[] => Array.from({ length: n }, (_, i) => tf(`Statement ${i + 1}.`, i % 2 === 0));

  test("200 questions are one file and 201 are two, because Author refuses a longer file whole", () => {
    assert.deepEqual(exportOpenStageSpreadsheet(many(MAX_QUESTIONS_PER_FILE), { name: "Bank" }).files.map((f) => f.name), ["Bank.csv"]);
    const two = exportOpenStageSpreadsheet(many(MAX_QUESTIONS_PER_FILE + 1), { name: "Bank" });
    assert.deepEqual(two.files.map((f) => [f.name, f.questions]), [["Bank-1.csv", 200], ["Bank-2.csv", 1]]);
  });

  test("450 questions are three files that each satisfy Author, and none is lost", () => {
    const result = exportOpenStageSpreadsheet(many(450), { name: "Big" });
    assert.deepEqual(result.files.map((f) => f.questions), [200, 200, 50]);
    for (const file of result.files) assert.deepEqual(problemsAuthorWouldFind(file.content), [], file.name);
    const stems = result.files.flatMap((f) => table(f.content).rows.map((r) => r["Question"]));
    assert.deepEqual(stems, many(450).map((_, i) => `Statement ${i + 1}.`), "the order is kept across files");
    assert.match(result.report.general.join(" "), /3 files/);
  });

  test("left-out questions do not count toward the 200", () => {
    const essays = Array.from({ length: 50 }, () => createQuestion({ type: "essay", stem: plainToRich("Discuss."), body: {} }));
    const result = exportOpenStageSpreadsheet([...many(200), ...essays], { name: "Mixed" });
    assert.equal(result.files.length, 1);
    assert.equal(result.report.leftOut, 50);
  });

  test("the file name is safe on Windows", () => {
    const name = (n: string | undefined) => exportOpenStageSpreadsheet(many(1), n === undefined ? {} : { name: n }).files[0]?.name;
    assert.equal(name('Bio 101: "Cells" / Tissues?'), "Bio 101- -Cells- - Tissues-.csv");
    assert.equal(name("  ...  "), "questions.csv");
    assert.equal(name(undefined), "questions.csv");
    assert.equal(name("Chapter 4. "), "Chapter 4.csv");
  });
});

describe("the destination check", () => {
  test("is the same report the export carries, and the counts add up", () => {
    const questions = [mc("A?", FOUR), createQuestion({ type: "essay", stem: plainToRich("E"), body: {} }), sa("S?", ["x"], {}, true)];
    const report = checkOpenStageSpreadsheet(questions, { name: "t" });
    assert.deepEqual(report, exportOpenStageSpreadsheet(questions, { name: "t" }).report);
    assert.equal(report.total, 3);
    assert.equal(report.exported + report.exportedWithLosses + report.leftOut, report.total);
    assert.deepEqual([report.exported, report.exportedWithLosses, report.leftOut], [1, 1, 1]);
    assert.equal(report.items.length, 3);
  });

  test("names the file or files that will be written", () => {
    assert.deepEqual(checkOpenStageSpreadsheet([mc("A?", FOUR)], { name: "Course" }).files, ["Course.csv"]);
    assert.deepEqual(checkOpenStageSpreadsheet([], { name: "Course" }).files, []);
  });

  test("an empty list writes nothing and says so", () => {
    const result = exportOpenStageSpreadsheet([], { name: "t" });
    assert.deepEqual(result.files, []);
    assert.deepEqual([result.report.total, result.report.exported, result.report.leftOut], [0, 0, 0]);
  });

  test("always says what the spreadsheet does not hold, once", () => {
    const general = checkOpenStageSpreadsheet([mc("A?", FOUR)]).general.join(" ");
    assert.match(general, /Titles, tags, objectives/);
    assert.match(general, /no Attempts column/);
  });

  test("prints as plain text a person can read", () => {
    const text = formatReport(
      checkOpenStageSpreadsheet([mc("Fine?", FOUR), createQuestion({ type: "essay", stem: plainToRich("Discuss the causes."), body: {} })], { name: "t" }),
    ).join("\n");
    assert.match(text, /Destination check: OpenStage question spreadsheet/);
    assert.match(text, /1 exported as written/);
    assert.match(text, /Left out\n\s+The spreadsheet holds .*An essay question cannot be written in it\.\n\s+#2 "Discuss the causes\."/);
  });

  test("says a repeated note once, with the questions under it", () => {
    const essays = Array.from({ length: 12 }, (_, i) => createQuestion({ type: "essay", stem: plainToRich(`Essay ${i + 1}.`), body: {} }));
    const lines = formatReport(checkOpenStageSpreadsheet(essays, { name: "t" }));
    assert.equal(lines.filter((l) => l.includes("An essay question cannot be written in it")).length, 1);
    assert.equal(lines.filter((l) => /^\s+#\d+ "Essay/.test(l)).length, 8, "eight are named");
    assert.match(lines.join("\n"), /and 4 more: #9, #10, #11, #12/);
  });
});

describe("from an imported file", () => {
  const text = `1) Which is a planet?
a. Sirius
*b. Mars
c. The Sun

Type: MR
2) Which are mammals?
*a. Dolphin
b. Trout
*c. Bat

Type: F
3) The capital of France is ____.
a. Paris

Type: S
4) Who wrote Emma?

Type: E
5) Discuss.

Type: MT
6) Match.
a. a = 1
b. b = 2

7) A question with one option?
*a. Only

Answers:
4. Jane Austen
4. Austen
`;
  const imported = standardTextImporter.parse(text, { file: "t.txt", at: "2026-01-01T00:00:00.000Z", author: "test" });
  const result = exportOpenStageSpreadsheet(imported.questions, { name: "Imported" });

  test("each kind arrives as the right row", () => {
    const rows = table(result.files[0]?.content ?? "").rows;
    assert.deepEqual(rows.map((r) => r["Type"]), ["MC", "MR", "SA", "SA"]);
    assert.deepEqual(rows.map((r) => r["Question"]), ["Which is a planet?", "Which are mammals?", "The capital of France is ____.", "Who wrote Emma?"]);
    assert.equal(rows[3]?.["A"], "Jane Austen");
    assert.equal(rows[3]?.["B"], "Austen");
  });

  test("essay and matching are left out, and so is the question that needed a placeholder option", () => {
    const left = result.report.items.filter((i) => i.outcome === "leftOut").map((i) => i.position);
    assert.deepEqual(left, [5, 6, 7]);
    const reason = result.report.items[6]?.notes.join(" ") ?? "";
    assert.match(reason, /only one answer option/, "a placeholder option never reaches a spreadsheet");
  });

  test("what Author would read is clean", () => {
    assert.deepEqual(problemsAuthorWouldFind(result.files[0]?.content ?? ""), []);
  });
});

// Found by a reviewer: the exporter wrote a Correct cell its own reader refuses (it is also the words of another answer), and said only an
// unrelated note, so the question came back with no key. It is left out and said, as the rule for every exporter is.
describe("a Correct cell that is also the words of another answer", () => {
  const withOptions = (type: "multipleChoice" | "multipleResponse", options: Array<[string, boolean]>) =>
    createQuestion({
      type,
      stem: plainToRich("Select all the valid answers."),
      body: (type === "multipleResponse"
        ? { shuffle: true, partialCredit: true, options: options.map(([t, c], i) => ({ id: `o${i}`, content: plainToRich(t), correct: c })) }
        : { shuffle: true, options: options.map(([t, c], i) => ({ id: `o${i}`, content: plainToRich(t), correct: c })) }) as never,
      by: "test",
      at: "2026-11-07T00:00:00.000Z",
    });
  const outcome = (q: Question) => exportOpenStageSpreadsheet([q], { name: "t" }).report.items[0];

  test("is left out with the reason, for a list and for a single letter", () => {
    const list = outcome(withOptions("multipleResponse", [["A", true], ["A, B", true], ["B", false], ["Neither", false]]));
    assert.equal(list?.outcome, "leftOut");
    assert.match((list?.notes ?? []).join(" "), /Its Correct cell would read "A, B", which is also the words of another answer/);
    const single = outcome(withOptions("multipleChoice", [["D", false], ["A", true], ["C", false], ["B", false]]));
    assert.equal(single?.outcome, "leftOut", "the cell is B for the second answer, and the fourth answer is the words B");
    assert.equal(outcome(withOptions("multipleChoice", [["D", false], ["A", true], ["C", false], ["E", false]]))?.outcome, "exported", "no answer is the words B");
    const letterClash = outcome(withOptions("multipleChoice", [["x", true], ["y", false], ["z", false], ["A", false]]));
    assert.equal(letterClash?.outcome, "leftOut", "the cell is A, and the fourth answer is the words A");
  });

  test("is written when the cell is a letter that is the words of the answer it names, or is no one's words", () => {
    assert.notEqual(outcome(withOptions("multipleChoice", [["A", false], ["B", true], ["C", false]]))?.outcome, "leftOut");
    assert.notEqual(outcome(withOptions("multipleResponse", [["Ice", true], ["Snow", true], ["Fire", false]]))?.outcome, "leftOut");
  });
});
