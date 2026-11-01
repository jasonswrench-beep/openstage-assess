/**
 * Export to Blackboard's "Upload questions" text file. The rules under test are the ones every exporter keeps (a question whose
 * key is missing is never written and no key is guessed, nothing is lost without being said against the question, what cannot be
 * written is left out and why) and the ones this format has: the type codes and the layout of each row that Blackboard documents,
 * and no others.
 *
 * `specProblems` below is a second reading of the format, written from Blackboard's help pages ("Upload or Import Questions")
 * and the sample file they link to, not from the exporter, and every file the exporter writes in these tests, including one for
 * every bank in the fixtures, has to satisfy it. `readBack` reads a row the way Blackboard's page says to, and the key it finds
 * has to be the key the question had. Neither can say that Blackboard will accept the file: only Blackboard can, and that is a
 * check for a person with a course (TESTING-TODO.md).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BLACKBOARD_UPLOAD_ID, checkBlackboardUpload, exportBlackboardUpload } from "../src/export/blackboard-upload.ts";
import { importerForContent, runImporter } from "../src/import/registry.ts";
import { createQuestion } from "../src/model/create.ts";
import { plainToRich, rich, richTextToPlain } from "../src/model/richtext.ts";
import type { Question, QuestionBody, QuestionType } from "../src/model/question.ts";

const AT = "2026-01-01T00:00:00.000Z";
const opt = (id: string, text: string, correct = false, feedback?: string) => ({ id, content: plainToRich(text), correct, ...(feedback ? { feedback: plainToRich(feedback) } : {}) });
let made = 0;
const make = (type: QuestionType, body: QuestionBody, stem: string, extra: Partial<Parameters<typeof createQuestion>[0]> = {}): Question =>
  createQuestion({ type, stem: stem.startsWith("<") ? rich(stem) : plainToRich(stem), body, by: "t", at: AT, id: `q_${String(++made).padStart(26, "0")}`, ...extra });

const MC = make("multipleChoice", { shuffle: true, options: [opt("o1", "Berlin"), opt("o2", "Paris", true), opt("o3", "Rome")] }, "What is the capital of France?");
const MA = make("multipleResponse", { shuffle: true, partialCredit: false, options: [opt("o1", "Red", true), opt("o2", "Green"), opt("o3", "Blue", true)] }, "Which are primary colours?");
const TF = make("trueFalse", { correct: false }, "A light-year is a measure of time.");
const SA = make("shortAnswer", { caseSensitive: false, accepted: ["Paris", "paris, france", "Paris"] }, "What is the capital of France?");
const FIB = make("fillInBlank", { caseSensitive: false, blanks: [{ id: "b1", accepted: ["Quartz"] }] }, "___ is the hardest common mineral.");
const ORD = make("ordering", { items: [{ id: "i2", content: plainToRich("Second"), position: 2 }, { id: "i1", content: plainToRich("First"), position: 1 }] }, "Put these in order.");
const MAT = make("matching", { shuffle: true, distractors: [], pairs: [{ id: "p1", left: plainToRich("Dog"), right: "Bark" }, { id: "p2", left: plainToRich("Cat"), right: "Meow" }] }, "Match the animal to its sound.");
const ESS = make("essay", {}, "Discuss.");

const TAB = "\t";
const rowsOf = (content: string): string[][] => content.split("\r\n").filter((l) => l !== "").map((l) => l.split(TAB));
const upload = (questions: Question[]): string => exportBlackboardUpload(questions, { name: "Test" }).files[0]?.content ?? "";
const itemOf = (question: Question) => checkBlackboardUpload([question]).items[0] as NonNullable<ReturnType<typeof checkBlackboardUpload>["items"][0]>;

/**
 * What Blackboard's pages say a file may hold. Returns what is wrong with the file, which is nothing for a file that follows it.
 * One question to a row, tab between fields, no header row, no blank line, the type in the first field, and the layout of each
 * type after it.
 */
function specProblems(content: string): string[] {
  const problems: string[] = [];
  if (content.charCodeAt(0) === 0xfeff) problems.push("the file begins with a byte order mark");
  if (content !== "" && !content.endsWith("\r\n")) problems.push("the last line has no line ending");
  const lines = content.split("\r\n");
  lines.pop(); // what follows the last line ending
  lines.forEach((line, i) => {
    const where = `row ${i + 1}`;
    if (line === "") {
      problems.push(`${where}: a blank line, which Blackboard processes as an error`);
      return;
    }
    const f = line.split(TAB);
    const type = f[0] as string;
    const stem = f[1] ?? "";
    if (stem.trim() === "") problems.push(`${where}: no question text`);
    if (/[\r\n]/.test(line)) problems.push(`${where}: a line break inside a row`);
    const rest = f.slice(2);
    const filled = (fields: string[]): void => {
      if (fields.some((x) => x.trim() === "")) problems.push(`${where}: an empty field in ${type}`);
    };
    switch (type) {
      case "MC":
      case "MA": {
        if (rest.length % 2 !== 0) problems.push(`${where}: ${type} is a text and correct or incorrect for each answer`);
        const answers = rest.length / 2;
        if (answers < 2) problems.push(`${where}: ${type} needs two answers`);
        if (answers > 100) problems.push(`${where}: more than 100 answers`);
        const marks = rest.filter((_x, k) => k % 2 === 1);
        if (marks.some((m) => m !== "correct" && m !== "incorrect")) problems.push(`${where}: the word after an answer is correct or incorrect, in English`);
        const right = marks.filter((m) => m === "correct").length;
        if (type === "MC" && right !== 1) problems.push(`${where}: a multiple choice has one correct answer`);
        if (type === "MA" && right < 1) problems.push(`${where}: a multiple answer has a correct answer`);
        filled(rest);
        break;
      }
      case "TF":
        if (rest.length !== 1 || !["true", "false"].includes(rest[0] as string)) problems.push(`${where}: TF is the text and then true or false`);
        break;
      case "ESS":
        if (rest.length > 1) problems.push(`${where}: ESS is the text and an optional sample`);
        break;
      case "MAT":
        if (rest.length % 2 !== 0 || rest.length < 4) problems.push(`${where}: MAT is two pairs or more, a left side then a right side`);
        if (rest.length > 200) problems.push(`${where}: more than 100 pairs`);
        filled(rest);
        break;
      case "FIB":
        if (rest.length < 1 || rest.length > 100) problems.push(`${where}: FIB is the text and 1 to 100 answers`);
        filled(rest);
        break;
      case "ORD":
        if (rest.length < 2 || rest.length > 100) problems.push(`${where}: ORD is the text and 2 to 100 items`);
        filled(rest);
        break;
      default:
        problems.push(`${where}: ${type} is not a type this export writes`);
    }
  });
  return problems;
}

/** A row read the way Blackboard's pages say to: what each type's fields mean. The key it finds is the key of the row. */
function readBack(row: string[]): { type: string; stem: string; answers: Array<[string, boolean]>; pairs: Array<[string, string]>; list: string[]; tf?: boolean } {
  const [type, stem, ...rest] = row as [string, string, ...string[]];
  const out = { type, stem, answers: [] as Array<[string, boolean]>, pairs: [] as Array<[string, string]>, list: [] as string[] };
  if (type === "MC" || type === "MA") for (let i = 0; i < rest.length; i += 2) out.answers.push([rest[i] as string, rest[i + 1] === "correct"]);
  else if (type === "MAT") for (let i = 0; i < rest.length; i += 2) out.pairs.push([rest[i] as string, rest[i + 1] as string]);
  else if (type === "FIB" || type === "ORD") out.list = rest;
  else if (type === "TF") return { ...out, tf: rest[0] === "true" };
  return out;
}

const plain = (t: unknown): string => richTextToPlain(t as never);

describe("the rows", () => {
  test("a multiple choice question: the text, then each answer with correct or incorrect", () => {
    assert.deepEqual(rowsOf(upload([MC])), [["MC", "What is the capital of France?", "Berlin", "incorrect", "Paris", "correct", "Rome", "incorrect"]]);
  });

  test("a multiple answer question marks each right answer, and says partial credit cannot go", () => {
    assert.deepEqual(rowsOf(upload([MA])), [["MA", "Which are primary colours?", "Red", "correct", "Green", "incorrect", "Blue", "correct"]]);
    assert.equal(itemOf(MA).outcome, "exported");
    const partial = make("multipleResponse", { shuffle: true, partialCredit: true, options: [opt("o1", "Red", true), opt("o2", "Green"), opt("o3", "Blue", true)] }, "Which are primary colours?");
    assert.equal(itemOf(partial).outcome, "exportedWithLosses");
    assert.match(itemOf(partial).notes.join(" "), /Partial credit cannot be carried/);
  });

  test("a true or false question is the word true or false, in lower case and English", () => {
    assert.deepEqual(rowsOf(upload([TF])), [["TF", "A light-year is a measure of time.", "false"]]);
    assert.deepEqual(rowsOf(upload([make("trueFalse", { correct: true }, "Water is wet.")])), [["TF", "Water is wet.", "true"]]);
  });

  test("a fill in the blank with one blank is the text and each accepted answer", () => {
    assert.deepEqual(rowsOf(upload([FIB])), [["FIB", "___ is the hardest common mineral.", "Quartz"]]);
    assert.equal(itemOf(FIB).outcome, "exported");
  });

  test("a short answer is written as a fill in the blank with its accepted answers once each, and says so", () => {
    assert.deepEqual(rowsOf(upload([SA])), [["FIB", "What is the capital of France?", "Paris", "paris, france"]]);
    assert.equal(itemOf(SA).outcome, "exportedWithLosses");
    assert.equal(itemOf(SA).asType, "fill in the blank");
    assert.match(itemOf(SA).notes.join(" "), /marked by hand/);
  });

  test("an ordering is the items in the right order, and says Ultra may refuse it", () => {
    assert.deepEqual(rowsOf(upload([ORD])), [["ORD", "Put these in order.", "First", "Second"]]);
    assert.match(itemOf(ORD).notes.join(" "), /Ultra/);
  });

  test("a matching question is each left side and its right side", () => {
    assert.deepEqual(rowsOf(upload([MAT])), [["MAT", "Match the animal to its sound.", "Dog", "Bark", "Cat", "Meow"]]);
    assert.equal(itemOf(MAT).outcome, "exported");
  });

  test("spare matching answers cannot be carried, and two pairs with one match are warned about", () => {
    const spare = make("matching", { shuffle: true, distractors: ["Moo", "Oink"], pairs: [{ id: "p1", left: plainToRich("Dog"), right: "Bark" }, { id: "p2", left: plainToRich("Cat"), right: "Meow" }] }, "Match.");
    assert.match(itemOf(spare).notes.join(" "), /2 spare answers cannot be carried/);
    assert.deepEqual(rowsOf(upload([spare]))[0]?.slice(2), ["Dog", "Bark", "Cat", "Meow"], "the spare answers are not in the row");
    const same = make("matching", { shuffle: true, distractors: [], pairs: [{ id: "p1", left: plainToRich("Dog"), right: "Pet" }, { id: "p2", left: plainToRich("Cat"), right: "pet" }] }, "Match.");
    assert.match(itemOf(same).notes.join(" "), /same match/);
  });

  test("an essay is the text, with the model answer as the sample when there is one", () => {
    assert.deepEqual(rowsOf(upload([ESS])), [["ESS", "Discuss."]]);
    const withModel = make("essay", { modelAnswer: plainToRich("A good answer says X.") }, "Discuss.");
    assert.deepEqual(rowsOf(upload([withModel])), [["ESS", "Discuss.", "A good answer says X."]]);
    assert.equal(itemOf(withModel).outcome, "exported");
    const rubric = make("essay", { rubric: [{ id: "r1", criterion: "Clarity", levels: [] }] } as unknown as QuestionBody, "Discuss.");
    assert.match(itemOf(rubric).notes.join(" "), /rubric cannot be carried/);
  });

  test("tabs and line breaks inside the text become spaces, so a row stays one row of the same fields", () => {
    const q = make("multipleChoice", { shuffle: true, options: [opt("o1", "one\ttwo", true), opt("o2", "three\nfour")] }, "Line one\tand\n\nline two?");
    const rows = rowsOf(upload([q]));
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], ["MC", "Line one and line two?", "one two", "correct", "three four", "incorrect"]);
    assert.deepEqual(specProblems(upload([q])), []);
  });

  test("a tab or a line break in text that is stored as plain text becomes a space as well", () => {
    // plainToRich turns a tab into markup that reads as a space; text stored as plain keeps the tab itself, which would end the field.
    const q = createQuestion({
      type: "multipleChoice",
      stem: { format: "plain", content: "Col one\tCol two\r\nnext" },
      body: { shuffle: true, options: [{ id: "o1", content: { format: "plain", content: "a\tb" }, correct: true }, opt("o2", "c")] },
      by: "t",
      at: AT,
      id: `q_${String(++made).padStart(26, "0")}`,
    });
    assert.deepEqual(rowsOf(upload([q])), [["MC", "Col one Col two next", "a b", "correct", "c", "incorrect"]]);
    assert.deepEqual(specProblems(upload([q])), []);
  });

  test("text that looks like a keyword is only text", () => {
    const q = make("multipleChoice", { shuffle: true, options: [opt("o1", "correct", true), opt("o2", "incorrect")] }, "true");
    assert.deepEqual(rowsOf(upload([q])), [["MC", "true", "correct", "correct", "incorrect", "incorrect"]]);
    assert.equal(readBack(rowsOf(upload([q]))[0] as string[]).answers.filter(([, right]) => right).length, 1);
  });
});

describe("what is left out, and why", () => {
  test("a numeric, a hotspot and a calculated question are not written, each with its reason", () => {
    const numeric = make("numeric", { mode: "exact", value: 3 }, "How many?");
    assert.equal(itemOf(numeric).outcome, "leftOut");
    assert.match(itemOf(numeric).notes.join(" "), /tolerance/);
    assert.equal(exportBlackboardUpload([numeric]).files.length, 0, "no file is written when nothing can be");
    for (const type of ["hotspot", "calculated"] as const) {
      const q = make(type, {} as QuestionBody, "Something.");
      assert.equal(itemOf(q).outcome, "leftOut", type);
      assert.match(itemOf(q).notes.join(" "), /cannot be written in it/, type);
    }
  });

  test("a question with no usable key is never written, and no key is guessed to fit", () => {
    const none = make("multipleChoice", { shuffle: true, options: [opt("o1", "A"), opt("o2", "B")] }, "Which?");
    const two = make("multipleChoice", { shuffle: true, options: [opt("o1", "A", true), opt("o2", "B", true)] }, "Which?");
    const noTf = make("trueFalse", {} as QuestionBody, "Is it?");
    const noAccepted = make("shortAnswer", { caseSensitive: false, accepted: [] }, "What?");
    for (const q of [none, two, noTf, noAccepted]) {
      assert.equal(itemOf(q).outcome, "leftOut", q.stem.content);
      assert.equal(exportBlackboardUpload([q]).files.length, 0);
    }
    // with a good question beside it, the file holds the good one only
    assert.equal(rowsOf(upload([none, MC, noTf])).length, 1);
  });

  test("a question with a blank answer, one answer, two blanks, or too many answers is left out", () => {
    const empty = make("multipleChoice", { shuffle: true, options: [opt("o1", "A", true), opt("o2", "   ")] }, "Which?");
    const single = make("multipleChoice", { shuffle: true, options: [opt("o1", "A", true)] }, "Which?");
    const two = make("fillInBlank", { caseSensitive: false, blanks: [{ id: "b1", accepted: ["x"] }, { id: "b2", accepted: ["y"] }] }, "_ and _.");
    const many = make("multipleChoice", { shuffle: true, options: Array.from({ length: 101 }, (_x, i) => opt(`o${i}`, `Answer ${i}`, i === 0)) }, "Which?");
    for (const q of [empty, single, two, many]) assert.equal(itemOf(q).outcome, "leftOut", q.stem.content);
    assert.match(itemOf(many).notes.join(" "), /at most 100/);
    assert.match(itemOf(two).notes.join(" "), /2 blanks/);
  });

  test("an ordering with one item, a matching with one pair, and a pair with a blank side are left out", () => {
    const one = make("ordering", { items: [{ id: "i1", content: plainToRich("A"), position: 1 }] }, "Order.");
    const pair = make("matching", { shuffle: true, distractors: [], pairs: [{ id: "p1", left: plainToRich("x"), right: "1" }] }, "Match.");
    const blank = make("matching", { shuffle: true, distractors: [], pairs: [{ id: "p1", left: plainToRich("x"), right: "1" }, { id: "p2", left: plainToRich("y"), right: " " }] }, "Match.");
    const blankLeft = make("matching", { shuffle: true, distractors: [], pairs: [{ id: "p1", left: plainToRich(" "), right: "1" }, { id: "p2", left: plainToRich("y"), right: "2" }] }, "Match.");
    for (const q of [one, pair, blank, blankLeft]) assert.equal(itemOf(q).outcome, "leftOut", q.stem.content);
  });

  test("a question with no words is left out", () => {
    const q = make("trueFalse", { correct: true }, "<p> </p>");
    assert.equal(itemOf(q).outcome, "leftOut");
  });
});

describe("what is lost on the way, said against the question", () => {
  test("points, feedback, formatting, pictures and equations", () => {
    const heavy = make("trueFalse", { correct: true }, '<p>See <strong>this</strong> <oa-media ref="m1"></oa-media> and <oa-math ref="e1"></oa-math>.</p>', {
      points: 3,
      media: [{ id: "m1", file: "media/m1.png", mime: "image/png", alt: "the chart" }],
      math: [{ id: "e1", latex: "x^2", mathml: "<math></math>" }],
      feedback: { general: plainToRich("Well done.") },
    });
    const notes = itemOf(heavy).notes.join(" ");
    assert.match(notes, /3 points cannot be carried/);
    assert.match(notes, /Feedback cannot be carried/);
    assert.match(notes, /became plain text/);
    assert.match(notes, /1 picture cannot be carried/);
    assert.match(notes, /1 equation became text/);
    const stem = rowsOf(upload([heavy]))[0]?.[1] ?? "";
    assert.match(stem, /\[Picture: the chart\]/);
    assert.match(stem, /\[Equation: x\^2\]/);
    assert.doesNotMatch(stem, /</, "no markup is written");
  });

  test("a question worth one point, with no feedback and plain text, loses nothing", () => {
    for (const q of [MC, MA, TF, FIB, MAT, ESS]) assert.deepEqual(itemOf(q).notes, [], q.stem.content);
  });

  test("feedback on a single answer is said too", () => {
    const q = make("multipleChoice", { shuffle: true, options: [opt("o1", "A", true, "Yes."), opt("o2", "B")] }, "Which?");
    assert.match(itemOf(q).notes.join(" "), /Feedback cannot be carried/);
  });

  test("an answer order that is fixed is said", () => {
    const q = make("multipleChoice", { shuffle: false, options: [opt("o1", "A", true), opt("o2", "B")] }, "Which?");
    assert.match(itemOf(q).notes.join(" "), /fixed order/);
  });
});

describe("the files", () => {
  test("a long bank is split into files of 250, named in order, each question once", () => {
    const many = Array.from({ length: 600 }, (_x, i) => make("trueFalse", { correct: i % 2 === 0 }, `Statement number ${i + 1}.`));
    const result = exportBlackboardUpload(many, { name: "Big bank" });
    assert.deepEqual(result.files.map((f) => f.name), ["Big bank - Blackboard 1.txt", "Big bank - Blackboard 2.txt", "Big bank - Blackboard 3.txt"]);
    assert.deepEqual(result.files.map((f) => f.questions), [250, 250, 100]);
    const stems = result.files.flatMap((f) => rowsOf(f.content).map((r) => r[1]));
    assert.deepEqual(stems, many.map((q) => plain(q.stem)));
    for (const f of result.files) assert.deepEqual(specProblems(f.content), [], f.name);
    assert.match(result.report.general.join(" "), /3 files/);
    assert.deepEqual(result.report.files, result.files.map((f) => f.name));
  });

  test("a bank of 250 or fewer is one file with the plain name", () => {
    assert.deepEqual(exportBlackboardUpload([MC], { name: "Week 1" }).files.map((f) => f.name), ["Week 1 - Blackboard.txt"]);
    assert.equal(exportBlackboardUpload(Array.from({ length: 250 }, () => MC), { name: "x" }).files.length, 1);
    assert.equal(exportBlackboardUpload(Array.from({ length: 251 }, () => MC), { name: "x" }).files.length, 2);
  });

  test("the file is UTF-8 with no byte order mark and CRLF line endings, with no header row or blank line", () => {
    const content = upload([MC, TF]);
    assert.ok(content.endsWith("\r\n"));
    assert.equal(content.charCodeAt(0), "M".charCodeAt(0));
    assert.ok(!content.includes("\r\n\r\n"));
    assert.ok(!/(^|\n)[^\r\n]*\n/.test(content.replace(/\r\n/g, "")), "no bare line feed");
    const accents = make("multipleChoice", { shuffle: true, options: [opt("o1", "Café", true), opt("o2", "Théâtre")] }, "Où est le café?");
    const bytes = Buffer.from(upload([accents]), "utf8");
    assert.equal(bytes.toString("utf8").includes("Où est le café?"), true);
  });

  test("names the file for the bank, makes the name safe, and reports every question once, in order", () => {
    const result = exportBlackboardUpload([MC, make("numeric", { mode: "exact", value: 1 }, "Number?"), TF], { name: 'Week 1: "Planets"?' });
    assert.deepEqual(result.files.map((f) => f.name), ["Week 1- -Planets-- - Blackboard.txt"]);
    assert.equal(result.files[0]?.questions, 2);
    assert.deepEqual(result.report.items.map((i) => [i.position, i.outcome]), [[1, "exported"], [2, "leftOut"], [3, "exported"]]);
    assert.equal(result.report.destination, BLACKBOARD_UPLOAD_ID);
    assert.equal(result.report.total, 3);
    assert.deepEqual([result.report.exported, result.report.exportedWithLosses, result.report.leftOut], [2, 0, 1]);
  });

  test("tells a person where to upload it, to set the points first, and what the file cannot do", () => {
    const general = checkBlackboardUpload([MC]).general.join(" ");
    assert.match(general, /Upload questions from file/);
    assert.match(general, /Upload Questions/);
    assert.match(general, /every question arrives worth zero/);
    assert.match(general, /Images are not carried/);
  });

  test("a bank with nothing it can write gives no file", () => {
    const result = exportBlackboardUpload([make("numeric", { mode: "exact", value: 1 }, "Number?")]);
    assert.deepEqual(result.files, []);
    assert.deepEqual(result.report.files, []);
  });
});

describe("the command line", () => {
  test("`export --to blackboard-upload` writes the file, and says what it would do without --out", () => {
    const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
    const source = fileURLToPath(new URL("../../../fixtures/standard-format/01-clean-multiple-choice.txt", import.meta.url));
    const folder = mkdtempSync(join(tmpdir(), "oa-bb-"));
    try {
      const run = (...args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, ...args], { encoding: "utf8" });
      const bank = join(folder, "bank.openassess");
      assert.equal(run("import", source, "--out", bank).status, 0);

      const dry = run("export", bank, "--to", "blackboard-upload");
      assert.equal(dry.status, 0, dry.stderr);
      assert.match(dry.stdout, /Destination check: Blackboard, Upload questions/);
      assert.match(dry.stdout, /Nothing was written/);
      assert.deepEqual(readdirSync(folder), ["bank.openassess"]);

      const out = join(folder, "out");
      const written = run("export", bank, "--to", "blackboard-upload", "--out", out);
      assert.equal(written.status, 0, written.stderr);
      const [name] = readdirSync(out);
      assert.match(name ?? "", / - Blackboard\.txt$/);
      assert.deepEqual(specProblems(readFileSync(join(out, name as string), "utf8")), []);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("a file against the format's own description", () => {
  test("every kind of question, together, satisfies it", () => {
    const all = [MC, MA, TF, SA, FIB, ORD, MAT, ESS, make("essay", { modelAnswer: plainToRich("Sample.") }, "Discuss more."), make("trueFalse", { correct: true }, "<p>A <em>formatted</em> one.</p>", { points: 7 })];
    assert.deepEqual(specProblems(upload(all)), []);
    assert.equal(rowsOf(upload(all)).length, all.length);
  });

  test("the checker does notice what is wrong with a file (so that passing it means something)", () => {
    const good = upload([MC]);
    assert.ok(specProblems(good.replace("\tcorrect", "\tright")).length > 0, "a word that is not correct or incorrect");
    assert.ok(specProblems(good.replace("\tincorrect\tParis", "\tcorrect\tParis")).length > 0, "two correct answers in a multiple choice");
    assert.ok(specProblems(good.replace("MC", "MCQ")).length > 0, "a type that is not written");
    assert.ok(specProblems(`﻿${good}`).length > 0, "a byte order mark");
    assert.ok(specProblems(`${good}\r\n`).length > 0, "a blank line");
    assert.ok(specProblems(good.replace(/\r\n$/, "")).length > 0, "no line ending");
    assert.ok(specProblems(upload([TF]).replace("\tfalse", "\tFalse")).length > 0, "a true or false in the wrong case");
    assert.ok(specProblems(upload([MAT]).replace("\tMeow", "")).length > 0, "a matching row with an odd number of fields");
    assert.ok(specProblems(upload([FIB]).replace("\tQuartz", "\t")).length > 0, "an empty field");
  });

  test("a row read back the way Blackboard's page reads it has the key the question had", () => {
    const rows = rowsOf(upload([MC, MA, TF, FIB, ORD, MAT]));
    const [mc, ma, tf, fib, ord, mat] = rows.map(readBack);
    assert.deepEqual(mc?.answers, [["Berlin", false], ["Paris", true], ["Rome", false]]);
    assert.deepEqual(ma?.answers.filter(([, r]) => r).map(([t]) => t), ["Red", "Blue"]);
    assert.equal(tf?.tf, false);
    assert.deepEqual(fib?.list, ["Quartz"]);
    assert.deepEqual(ord?.list, ["First", "Second"]);
    assert.deepEqual(mat?.pairs, [["Dog", "Bark"], ["Cat", "Meow"]]);
  });

  test("every bank in the fixtures, read by its importer and exported, satisfies it, and every key reads back", () => {
    const folder = join(fileURLToPath(new URL("../../../fixtures/standard-format/", import.meta.url)));
    let files = 0;
    let questions = 0;
    for (const name of readdirSync(folder).filter((n) => /\.(txt|docx)$/.test(n))) {
      const bytes = new Uint8Array(readFileSync(join(folder, name)));
      const result = runImporter(importerForContent(name, bytes), bytes, { file: name, at: AT, author: "test" });
      const exported = exportBlackboardUpload(result.questions, { name });
      if (exported.files.length === 0) continue;
      files++;
      for (const file of exported.files) {
        questions += file.questions;
        assert.deepEqual(specProblems(file.content), [], name);
      }
      // each written question, in order, reads back with the key the bank holds
      const written = result.questions.filter((_q, i) => exported.report.items[i]?.outcome !== "leftOut");
      const back = exported.files.flatMap((f) => rowsOf(f.content)).map(readBack);
      assert.equal(back.length, written.length, name);
      written.forEach((q, i) => {
        const row = back[i] as ReturnType<typeof readBack>;
        const body = q.body as unknown as { options?: Array<{ content: unknown; correct: boolean }>; correct?: boolean };
        if (row.type === "MC" || row.type === "MA") {
          assert.deepEqual(row.answers, (body.options ?? []).map((o) => [plain(o.content).replace(/\s+/g, " ").trim(), o.correct]), `${name}: ${q.title}`);
        } else if (row.type === "TF") {
          assert.equal(row.tf, body.correct, `${name}: ${q.title}`);
        }
      });
    }
    assert.ok(files >= 15, `only ${files} fixtures exported`);
    assert.ok(questions >= 40, `only ${questions} questions exported`);
  });

  const real = join(fileURLToPath(new URL("../../../fixtures/publisher/", import.meta.url)));
  const hasReal = existsSync(real) && readdirSync(real).some((n) => n.endsWith(".expected.json"));
  test("every real bank in fixtures/publisher, when there are some, exports to files that satisfy it", { skip: hasReal ? false : "none there; the folder is git-ignored and local" }, () => {
    let questions = 0;
    for (const name of readdirSync(real).filter((n) => /\.(txt|docx|xlsx|csv)$/.test(n))) {
      const bytes = new Uint8Array(readFileSync(join(real, name)));
      const result = runImporter(importerForContent(name, bytes), bytes, { file: name, at: AT, author: "test" });
      for (const file of exportBlackboardUpload(result.questions, { name }).files) {
        questions += file.questions;
        assert.deepEqual(specProblems(file.content), [], name);
      }
    }
    assert.ok(questions > 0);
  });
});
