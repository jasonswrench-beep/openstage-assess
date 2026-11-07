/**
 * Export to Brightspace's Question Library CSV. The rules under test are the ones every exporter keeps (a question whose key is
 * missing is never written and no key is guessed, nothing is lost without being said against the question, what cannot be
 * written is left out and why) and the ones this format has: the keywords and values Brightspace documents, and no others.
 *
 * `specProblems` below is a second reading of the format, written from D2L's own article ("Import questions into the Question
 * Library", the part on preparing a CSV file) and not from the exporter, and every file the exporter writes in these tests,
 * including one for every bank in the fixtures, has to satisfy it. It cannot say that Brightspace will accept the file: only
 * Brightspace can, and that is a check for a person with a course (TESTING-TODO.md).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkD2lCsv, D2L_CSV_ID, exportD2lCsv } from "../src/export/d2l-csv.ts";
import { importerForContent, runImporter } from "../src/import/registry.ts";
import { parseDelimited } from "../src/import/table-csv.ts";
import { createQuestion } from "../src/model/create.ts";
import { plainToRich, rich } from "../src/model/richtext.ts";
import type { Question, QuestionBody, QuestionType } from "../src/model/question.ts";

const AT = "2026-01-01T00:00:00.000Z";
const opt = (id: string, text: string, correct = false, feedback?: string) => ({ id, content: plainToRich(text), correct, ...(feedback ? { feedback: plainToRich(feedback) } : {}) });
let made = 0;
const make = (type: QuestionType, body: QuestionBody, stem: string, extra: Partial<Parameters<typeof createQuestion>[0]> = {}): Question =>
  createQuestion({ type, stem: stem.startsWith("<") ? rich(stem) : plainToRich(stem), body, by: "t", at: AT, id: `q_${String(++made).padStart(26, "0")}`, ...extra });

const MC = make("multipleChoice", { shuffle: true, options: [opt("o1", "Berlin"), opt("o2", "Paris", true), opt("o3", "Rome")] }, "What is the capital of France?");
const MS = make("multipleResponse", { shuffle: true, partialCredit: true, options: [opt("o1", "Red", true), opt("o2", "Green"), opt("o3", "Blue", true)] }, "Which are primary colours?");
const TF = make("trueFalse", { correct: false }, "A light-year is a measure of time.");
const SA = make("shortAnswer", { caseSensitive: false, accepted: ["Paris", "paris, france"] }, "What is the capital of France?");

/** The rows of a file as cells, with the comment rows left out. */
const rowsOf = (content: string): string[][] => parseDelimited(content).rows.map((r) => r.cells).filter((c) => !(c[0] ?? "").startsWith("//"));
const csvOf = (questions: Question[]): string => exportD2lCsv(questions, { name: "Test" }).files[0]?.content ?? "";
const itemOf = (question: Question) => checkD2lCsv([question]).items[0] as NonNullable<ReturnType<typeof checkD2lCsv>["items"][0]>;

/**
 * What D2L's article says a file may hold. Returns what is wrong with the file, which is nothing for a file that follows it.
 * The seven question types and their rows, the values that mark a right answer (100, or 1 for a multiselect), the optional
 * entries, and the one place the third cell may say HTML.
 */
function specProblems(content: string): string[] {
  const problems: string[] = [];
  if (content.charCodeAt(0) === 0xfeff) problems.push("the file begins with a byte order mark, in front of the first keyword");
  if (!content.endsWith("\r\n")) problems.push("the last line has no line ending");
  const rows = rowsOf(content);
  const KEYWORDS = new Set(["NewQuestion", "QuestionText", "Title", "Points", "Scoring", "Option", "Answer", "TRUE", "FALSE", "Choice", "Match", "Item", "Feedback"]);
  const SCORING = new Set(["EquallyWeighted", "RightMinusWrong", "AllOrNothing", "RightAnswers", "CorrectAnswersLimitedSelections"]);
  let at = -1;
  let type = "";
  let block: string[][] = [];
  const close = (): void => {
    if (at === -1) return;
    const where = `question ${at}`;
    const of = (k: string): string[][] => block.filter((r) => r[0] === k);
    const texts = of("QuestionText");
    if (texts.length !== 1 || !(texts[0]?.[1] ?? "").trim()) problems.push(`${where}: needs exactly one QuestionText with words`);
    for (const r of block) if ((r[2] ?? "") === "HTML" && r[0] !== "QuestionText") problems.push(`${where}: HTML is only said on QuestionText here`);
    const points = of("Points");
    if (points.length > 1) problems.push(`${where}: two Points rows`);
    for (const p of points) if (!/^\d+$/.test(p[1] ?? "") || Number(p[1]) < 1 || Number(p[1]) > 100) problems.push(`${where}: Points ${p[1]} is not 1 to 100`);
    for (const s of of("Scoring")) if (!SCORING.has(s[1] ?? "")) problems.push(`${where}: Scoring "${s[1]}" is not one Brightspace names`);
    const options = of("Option");
    const answers = of("Answer");
    const allowed: Record<string, string[]> = {
      MC: ["NewQuestion", "Title", "QuestionText", "Points", "Option", "Feedback"],
      MS: ["NewQuestion", "Title", "QuestionText", "Points", "Scoring", "Option", "Feedback"],
      TF: ["NewQuestion", "Title", "QuestionText", "Points", "TRUE", "FALSE", "Feedback"],
      SA: ["NewQuestion", "Title", "QuestionText", "Points", "Answer", "Feedback"],
      M: ["NewQuestion", "Title", "QuestionText", "Points", "Choice", "Match", "Feedback"],
      O: ["NewQuestion", "Title", "QuestionText", "Points", "Item", "Feedback"],
      WR: ["NewQuestion", "Title", "QuestionText", "Points", "Feedback"],
    };
    for (const r of block) if (!(allowed[type] ?? []).includes(r[0] as string)) problems.push(`${where}: ${r[0]} is not a row of a ${type} question`);
    if (type === "MC") {
      if (options.length < 2) problems.push(`${where}: a multiple choice needs two options`);
      for (const o of options) if (!["100", "0"].includes(o[1] as string) || !(o[2] ?? "").trim()) problems.push(`${where}: an option is 100 or 0, with text in the third cell`);
      if (options.filter((o) => o[1] === "100").length !== 1) problems.push(`${where}: one option is 100`);
    } else if (type === "MS") {
      if (options.length < 2) problems.push(`${where}: a multiselect needs two options`);
      for (const o of options) if (!["1", "0"].includes(o[1] as string) || !(o[2] ?? "").trim()) problems.push(`${where}: a multiselect option is 1 or 0, with text in the third cell`);
      if (!options.some((o) => o[1] === "1")) problems.push(`${where}: no option is right`);
    } else if (type === "TF") {
      const t = of("TRUE");
      const f = of("FALSE");
      if (t.length !== 1 || f.length !== 1) problems.push(`${where}: one TRUE row and one FALSE row`);
      else if (![t[0]?.[1], f[0]?.[1]].every((v) => v === "100" || v === "0") || t[0]?.[1] === f[0]?.[1]) problems.push(`${where}: one of TRUE and FALSE is 100 and the other 0`);
    } else if (type === "SA") {
      if (answers.length < 1) problems.push(`${where}: a short answer needs an Answer`);
      for (const a of answers) if (a[1] !== "100" || !(a[2] ?? "").trim()) problems.push(`${where}: an Answer is 100, with text in the third cell`);
    } else if (type === "M") {
      const c = of("Choice");
      const m = of("Match");
      if (c.length < 2 || c.length !== m.length) problems.push(`${where}: matching needs as many Match rows as Choice rows, and two of each`);
      const numbers = (rs: string[][]): string => rs.map((r) => r[1]).join(",");
      if (numbers(c) !== numbers(m) || numbers(c) !== c.map((_, i) => i + 1).join(",")) problems.push(`${where}: Choice and Match are numbered 1 to ${c.length}, each once`);
      for (const r of [...c, ...m]) if (!(r[2] ?? "").trim()) problems.push(`${where}: a choice or a match has no text in the third cell`);
    } else if (type === "O") {
      const items = of("Item");
      if (items.length < 2) problems.push(`${where}: an ordering needs two items`);
      for (const i of items) if (!(i[1] ?? "").trim()) problems.push(`${where}: an Item has its text in the second cell`);
    }
    block = [];
  };
  for (const r of rows) {
    const k = r[0] as string;
    if (!KEYWORDS.has(k)) {
      problems.push(`${k} is not a row Brightspace's article names`);
      continue;
    }
    if (k === "NewQuestion") {
      close();
      at++;
      type = r[1] ?? "";
      if (at === -1) at = 0;
      if (!["MC", "TF", "MS", "SA", "M", "O", "WR"].includes(type)) problems.push(`question ${at}: ${type} is not a type that a CSV file can import`);
    } else if (at === -1) {
      problems.push(`${k} comes before any NewQuestion`);
      continue;
    }
    block.push(r);
  }
  close();
  return problems;
}

describe("a Brightspace question library file", () => {
  test("begins with a comment row, writes UTF-8 with no byte order mark and CRLF line ends, and is one question after another", () => {
    const content = csvOf([MC]);
    assert.ok(content.startsWith("// Written by OpenAssess"), "the comment row is not quoted, so a line that begins // is seen as one");
    assert.equal(content.split("\r\n")[0]?.includes('"'), false);
    assert.equal(content.includes("﻿"), false);
    assert.ok(content.endsWith("\r\n"));
    assert.deepEqual(rowsOf(content).map((r) => r[0]), ["NewQuestion", "QuestionText", "Points", "Option", "Option", "Option"]);
  });

  test("multiple choice: NewQuestion, QuestionText, Points, and an Option for each answer, 100 for the right one and 0 for the others", () => {
    assert.deepEqual(rowsOf(csvOf([MC])), [
      ["NewQuestion", "MC", ""],
      ["QuestionText", "What is the capital of France?", ""],
      ["Points", "1", ""],
      ["Option", "0", "Berlin"],
      ["Option", "100", "Paris"],
      ["Option", "0", "Rome"],
    ]);
  });

  test("multiple response is a multiselect, whose right answer is 1 and not 100, with its scoring said", () => {
    const rows = rowsOf(csvOf([MS]));
    assert.deepEqual(rows[0], ["NewQuestion", "MS", ""]);
    assert.deepEqual(rows.filter((r) => r[0] === "Option").map((r) => r[1]), ["1", "0", "1"]);
    assert.deepEqual(rows.find((r) => r[0] === "Scoring"), ["Scoring", "RightMinusWrong", ""]);
    const allOrNothing = make("multipleResponse", { shuffle: true, partialCredit: false, options: [opt("o1", "A", true), opt("o2", "B")] }, "Pick A.");
    assert.deepEqual(rowsOf(csvOf([allOrNothing])).find((r) => r[0] === "Scoring"), ["Scoring", "AllOrNothing", ""]);
  });

  test("true or false: a TRUE row and a FALSE row, 100 for the right one", () => {
    const rows = rowsOf(csvOf([TF]));
    assert.deepEqual(rows.slice(-2), [["TRUE", "0", ""], ["FALSE", "100", ""]]);
    const yes = make("trueFalse", { correct: true }, "The Sun is a star.");
    assert.deepEqual(rowsOf(csvOf([yes])).slice(-2), [["TRUE", "100", ""], ["FALSE", "0", ""]]);
  });

  test("short answer: an Answer for each accepted answer, 100, tidied and without repeats", () => {
    const q = make("shortAnswer", { caseSensitive: false, accepted: ["Paris", "  Paris  ", "Paris,\n France", ""] }, "Capital?");
    assert.deepEqual(rowsOf(csvOf([q])).filter((r) => r[0] === "Answer"), [["Answer", "100", "Paris"], ["Answer", "100", "Paris, France"]]);
  });

  test("a short answer that counts case says so, because the file has no way to", () => {
    const q = make("shortAnswer", { caseSensitive: true, accepted: ["Na"] }, "Symbol for sodium?");
    assert.match(itemOf(q).notes.join(" "), /Upper and lower case count/);
  });

  test("an essay is a written response, and its model answer and rubric are said to be lost", () => {
    const q = make("essay", { modelAnswer: plainToRich("A model."), rubric: [{ criterion: "Clarity", points: 2 }], expectedWords: 200 }, "Discuss.");
    assert.deepEqual(rowsOf(csvOf([q])).slice(0, 2), [["NewQuestion", "WR", ""], ["QuestionText", "Discuss.", ""]]);
    const notes = itemOf(q).notes.join(" ");
    assert.match(notes, /model answer cannot be carried/);
    assert.match(notes, /rubric cannot be carried/);
    assert.match(notes, /expected length/);
    assert.equal(itemOf(q).outcome, "exportedWithLosses");
  });

  test("ordering: the items in the right order, each with its text in the second cell", () => {
    const q = make("ordering", { items: [{ id: "i1", content: plainToRich("Third"), position: 3 }, { id: "i2", content: plainToRich("First"), position: 1 }, { id: "i3", content: plainToRich("Second"), position: 2 }] }, "Put these in order.");
    assert.deepEqual(rowsOf(csvOf([q])).filter((r) => r[0] === "Item"), [["Item", "First", ""], ["Item", "Second", ""], ["Item", "Third", ""]]);
  });

  test("matching: Choice and Match rows numbered together, and spare answers said to be lost", () => {
    const q = make("matching", { shuffle: true, distractors: ["Spare"], pairs: [{ id: "p1", left: plainToRich("Dog"), right: "Bark" }, { id: "p2", left: plainToRich("Cat"), right: "Meow" }] }, "Match the animal to its sound.");
    const rows = rowsOf(csvOf([q]));
    assert.deepEqual(rows.filter((r) => r[0] === "Choice" || r[0] === "Match"), [
      ["Choice", "1", "Dog"],
      ["Choice", "2", "Cat"],
      ["Match", "1", "Bark"],
      ["Match", "2", "Meow"],
    ]);
    assert.match(itemOf(q).notes.join(" "), /1 spare answer cannot be carried/);
  });

  test("a matching question with fewer than two pairs is left out, and says so", () => {
    const one = make("matching", { shuffle: true, distractors: [], pairs: [{ id: "p1", left: plainToRich("Dog"), right: "Bark" }] }, "Match.");
    assert.equal(itemOf(one).outcome, "leftOut");
    assert.equal(csvOf([one]), "");
  });

  test("a fill in the blank with one blank is written as a short answer, and with several is left out", () => {
    const one = make("fillInBlank", { caseSensitive: false, blanks: [{ id: "b1", accepted: ["Mercury"] }] }, "The closest planet is _____.");
    assert.equal(rowsOf(csvOf([one]))[0]?.[1], "SA");
    assert.equal(itemOf(one).asType, "short answer");
    assert.match(itemOf(one).notes.join(" "), /written as a short answer, because the file cannot say where in the text the blank is/);
    const two = make("fillInBlank", { caseSensitive: false, blanks: [{ id: "b1", accepted: ["a"] }, { id: "b2", accepted: ["b"] }] }, "_____ and _____.");
    assert.equal(itemOf(two).outcome, "leftOut");
    assert.match(itemOf(two).notes.join(" "), /2 blanks/);
  });

  test("what the file has no row for is left out, with the reason", () => {
    const numeric = make("numeric", { mode: "exact", value: 42 }, "What is 6 times 7?");
    assert.equal(itemOf(numeric).outcome, "leftOut");
    assert.match(itemOf(numeric).notes.join(" "), /arithmetic or a numeric question/);
    assert.equal(exportD2lCsv([numeric]).files.length, 0, "no file is written when nothing can be");
  });
});

describe("the key", () => {
  test("a question whose key is missing is left out, and never written with a guessed one", () => {
    const none = make("multipleChoice", { shuffle: true, options: [opt("o1", "A"), opt("o2", "B")] }, "Which?");
    const noTf = make("trueFalse", {}, "True?");
    const noSa = make("shortAnswer", { caseSensitive: false, accepted: [] }, "Name it.");
    for (const q of [none, noTf, noSa]) {
      assert.equal(itemOf(q).outcome, "leftOut", q.stem.content);
      assert.equal(csvOf([q]), "");
    }
    assert.match(itemOf(none).notes.join(" "), /cannot be exported until this is fixed in the bank/);
  });

  test("a question with two right answers on a single-answer question is left out too", () => {
    const two = make("multipleChoice", { shuffle: true, options: [opt("o1", "A", true), opt("o2", "B", true)] }, "Which?");
    assert.equal(itemOf(two).outcome, "leftOut");
  });
});

describe("what a question carries", () => {
  test("a title that was written is written, and the title an untitled question is given is not", () => {
    const titled = make("multipleChoice", { shuffle: true, options: [opt("o1", "A", true), opt("o2", "B")] }, "Which?", { title: "Week 2, question 4" });
    assert.deepEqual(rowsOf(csvOf([titled]))[1], ["Title", "Week 2, question 4", ""]);
    assert.equal(rowsOf(csvOf([MC])).some((r) => r[0] === "Title"), false);
  });

  test("points are written when Brightspace takes them, a whole number from 1 to 100, and said to be lost when it does not", () => {
    const withPoints = (n: number): Question => make("trueFalse", { correct: true }, "True?", { points: n });
    assert.deepEqual(rowsOf(csvOf([withPoints(5)])).find((r) => r[0] === "Points"), ["Points", "5", ""]);
    for (const n of [2.5, 0, 101]) {
      const q = withPoints(n);
      assert.equal(rowsOf(csvOf([q])).some((r) => r[0] === "Points"), false, String(n));
      assert.match(itemOf(q).notes.join(" "), /cannot be carried: Brightspace takes a whole number from 1 to 100/);
    }
  });

  test("general feedback is the Feedback row, and feedback for right, wrong or one answer is said to be lost", () => {
    const q = make("multipleChoice", { shuffle: true, options: [opt("o1", "A", true, "Right because"), opt("o2", "B")] }, "Which?", {
      feedback: { general: plainToRich("Read chapter 2."), correct: plainToRich("Well done."), incorrect: plainToRich("Try again.") },
    });
    assert.deepEqual(rowsOf(csvOf([q])).at(-1), ["Feedback", "Read chapter 2.", ""]);
    const notes = itemOf(q).notes.join(" ");
    assert.match(notes, /Feedback on a single answer cannot be carried/);
    assert.match(notes, /Feedback for a right answer and for a wrong one cannot be carried/);
  });

  test("a stem with formatting is written as HTML, the third cell says so, and the answers are plain with the loss said", () => {
    const q = make("multipleChoice", { shuffle: true, options: [opt("o1", "A", true), opt("o2", "B")] }, "<p>What is <strong>bold</strong>?</p>");
    const stemRow = rowsOf(csvOf([q])).find((r) => r[0] === "QuestionText") as string[];
    assert.equal(stemRow[1], "<p>What is <strong>bold</strong>?</p>");
    assert.equal(stemRow[2], "HTML");
    assert.match(itemOf(q).notes.join(" "), /The question text keeps its formatting/);
  });

  test("a stem of paragraphs becomes one line of words, and the paragraph breaks are said to be lost", () => {
    const q = make("trueFalse", { correct: true }, "First paragraph.\n\nSecond paragraph.");
    assert.equal(rowsOf(csvOf([q])).find((r) => r[0] === "QuestionText")?.[1], "First paragraph. Second paragraph.");
    assert.match(itemOf(q).notes.join(" "), /Paragraph breaks became spaces/);
  });

  test("a picture or an equation is a marker in the text, and counted, never dropped", () => {
    const q = make("trueFalse", { correct: true }, '<p>See <oa-media ref="m1"></oa-media> and <oa-math ref="e1"></oa-math>.</p>', {
      media: [{ id: "m1", file: "media/m1.png", mime: "image/png", alt: "the chart" }],
      math: [{ id: "e1", latex: "x^2", mathml: "<math></math>" }],
    });
    const text = rowsOf(csvOf([q])).find((r) => r[0] === "QuestionText")?.[1] ?? "";
    assert.match(text, /\[Picture: the chart\]/);
    assert.match(text, /\[Equation: x\^2\]/);
    const notes = itemOf(q).notes.join(" ");
    assert.match(notes, /1 picture cannot be carried/);
    assert.match(notes, /1 equation became text/);
  });

  test("an answer that is fixed in place is said to be, because the file cannot say so", () => {
    const q = make("multipleChoice", { shuffle: false, options: [opt("o1", "All of the above"), opt("o2", "None", true)] }, "Which?");
    assert.match(itemOf(q).notes.join(" "), /keeps its answers in a fixed order/);
  });
});

describe("the file as a CSV", () => {
  test("quotes what needs it, doubles a quote, and keeps a comma or a quote in a cell as it was", () => {
    const q = make("shortAnswer", { caseSensitive: false, accepted: ['She said "hi", then left'] }, 'Quote: "to be, or not"');
    const content = csvOf([q]);
    assert.ok(content.includes('"Quote: ""to be, or not"""'));
    const rows = rowsOf(content);
    assert.equal(rows.find((r) => r[0] === "QuestionText")?.[1], 'Quote: "to be, or not"');
    assert.equal(rows.find((r) => r[0] === "Answer")?.[2], 'She said "hi", then left');
  });

  test("every row has three cells, as the template's rows do", () => {
    const content = csvOf([MC, MS, TF, SA]);
    for (const line of content.split("\r\n").filter((l) => l !== "" && !l.startsWith("//"))) {
      assert.equal(parseDelimited(line).rows[0]?.cells.length, 3, line);
    }
  });

  test("does not alter text to defend against a spreadsheet formula: the cell would no longer be the question", () => {
    const q = make("shortAnswer", { caseSensitive: false, accepted: ["=1+1", "-2.79"] }, "What is it?");
    assert.deepEqual(rowsOf(csvOf([q])).filter((r) => r[0] === "Answer").map((r) => r[2]), ["=1+1", "-2.79"]);
  });

  test("names the file for the bank, makes the name safe, and reports every question once, in order", () => {
    const result = exportD2lCsv([MC, TF, make("numeric", { mode: "exact", value: 1 }, "Number?")], { name: 'Week 1: "Planets"?' });
    assert.deepEqual(result.files.map((f) => f.name), ["Week 1- -Planets-- - Brightspace.csv"]);
    assert.equal(result.files[0]?.questions, 2);
    assert.deepEqual(result.report.items.map((i) => [i.position, i.outcome]), [[1, "exported"], [2, "exported"], [3, "leftOut"]]);
    assert.equal(result.report.destination, D2L_CSV_ID);
    assert.equal(result.report.total, 3);
    assert.deepEqual([result.report.exported, result.report.exportedWithLosses, result.report.leftOut], [2, 0, 1]);
  });

  test("tells a person where to import it, and what the file cannot do", () => {
    const general = checkD2lCsv([MC]).general.join(" ");
    assert.match(general, /Question Library, then Import, then Upload a File/);
    assert.match(general, /move them into a section afterwards/);
    assert.match(general, /Images are not carried/);
  });
});

describe("the command line", () => {
  test("`export --to d2l-csv` writes the file, and says what it would do without --out", () => {
    const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
    const source = fileURLToPath(new URL("../../../fixtures/standard-format/01-clean-multiple-choice.txt", import.meta.url));
    const folder = mkdtempSync(join(tmpdir(), "oa-d2l-"));
    try {
      const run = (...args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, ...args], { encoding: "utf8" });
      const bank = join(folder, "bank.openassess");
      assert.equal(run("import", source, "--out", bank).status, 0);

      const dry = run("export", bank, "--to", "d2l-csv");
      assert.equal(dry.status, 0, dry.stderr);
      assert.match(dry.stdout, /Destination check: Brightspace \(D2L\) Question Library, CSV/);
      assert.match(dry.stdout, /Nothing was written/);
      assert.deepEqual(readdirSync(folder), ["bank.openassess"]);

      const out = join(folder, "out");
      const written = run("export", bank, "--to", "d2l-csv", "--out", out);
      assert.equal(written.status, 0, written.stderr);
      const [name] = readdirSync(out);
      assert.match(name ?? "", / - Brightspace\.csv$/);
      assert.deepEqual(specProblems(readFileSync(join(out, name as string), "utf8")), []);

      const refused = run("export", bank, "--to", "nowhere");
      assert.notEqual(refused.status, 0, "a destination that does not exist is refused");
      assert.match(refused.stderr, /d2l-csv/, "and the ones that do exist are named");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("a file against the format's own description", () => {
  test("every kind of question, together, satisfies it", () => {
    const all = [
      MC,
      MS,
      TF,
      SA,
      make("essay", {}, "Discuss."),
      make("ordering", { items: [{ id: "i1", content: plainToRich("A"), position: 1 }, { id: "i2", content: plainToRich("B"), position: 2 }] }, "Order."),
      make("matching", { shuffle: true, distractors: [], pairs: [{ id: "p1", left: plainToRich("x"), right: "1" }, { id: "p2", left: plainToRich("y"), right: "2" }] }, "Match."),
      make("fillInBlank", { caseSensitive: false, blanks: [{ id: "b1", accepted: ["w"] }] }, "A _____ B."),
      make("trueFalse", { correct: true }, "<p>A <em>formatted</em> one.</p>", { points: 7, title: "Titled" }),
    ];
    assert.deepEqual(specProblems(csvOf(all)), []);
  });

  test("the checker does notice what is wrong with a file (so that passing it means something)", () => {
    const good = csvOf([MC]);
    assert.ok(specProblems(good.replace("Option,100,Paris", "Option,1,Paris")).length > 0, "a 1 where a multiple choice needs 100");
    assert.ok(specProblems(good.replace("Option,0,Rome", "Option,100,Rome")).length > 0, "two right answers");
    assert.ok(specProblems(good.replace("QuestionText", "Question")).length > 0, "a keyword that is not Brightspace's");
    assert.ok(specProblems(good.replace("NewQuestion,MC", "NewQuestion,FIB")).length > 0, "a type a CSV cannot import");
    assert.ok(specProblems(`﻿${good}`).length > 0, "a byte order mark");
    assert.ok(specProblems(csvOf([MS]).replace("Option,1,Red", "Option,100,Red")).length > 0, "100 on a multiselect");
    assert.ok(specProblems(csvOf([TF]).replace("FALSE,100", "FALSE,0")).length > 0, "a true or false with no right answer");
  });

  test("every bank in the fixtures, read by its importer and exported, satisfies it, for every question it could write", () => {
    const folder = join(fileURLToPath(new URL("../../../fixtures/standard-format/", import.meta.url)));
    let files = 0;
    let questions = 0;
    for (const name of readdirSync(folder).filter((n) => /\.(txt|docx)$/.test(n))) {
      const bytes = new Uint8Array(readFileSync(join(folder, name)));
      const result = runImporter(importerForContent(name, bytes), bytes, { file: name, at: AT, author: "test" });
      const exported = exportD2lCsv(result.questions, { name });
      if (exported.files.length === 0) continue;
      files++;
      questions += exported.files[0]?.questions ?? 0;
      assert.deepEqual(specProblems(exported.files[0]?.content ?? ""), [], name);
    }
    assert.ok(files >= 15, `only ${files} fixtures exported`);
    assert.ok(questions >= 40, `only ${questions} questions exported`);
  });

  const real = join(fileURLToPath(new URL("../../../fixtures/publisher/", import.meta.url)));
  const hasReal = existsSync(real) && readdirSync(real).some((n) => n.endsWith(".expected.json"));
  test("every real bank in fixtures/publisher, when there are some, exports to a file that satisfies it", { skip: hasReal ? false : "none there; the folder is git-ignored and local" }, () => {
    let questions = 0;
    for (const name of readdirSync(real).filter((n) => /\.(txt|docx|xlsx|csv)$/.test(n))) {
      const bytes = new Uint8Array(readFileSync(join(real, name)));
      const result = runImporter(importerForContent(name, bytes), bytes, { file: name, at: AT, author: "test" });
      const exported = exportD2lCsv(result.questions, { name });
      if (exported.files.length === 0) continue;
      questions += exported.files[0]?.questions ?? 0;
      assert.deepEqual(specProblems(exported.files[0]?.content ?? ""), [], name);
    }
    assert.ok(questions > 0);
  });
});
