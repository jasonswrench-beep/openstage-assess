/**
 * A learning system's quiz results report read into the item statistics: each layout by its column names, nothing about a student
 * read, the system's own points taken as given, a response counted only where its words are exactly an answer, and a question matched
 * to the bank only by words (or a title) that one question alone has.
 *
 * The reports below are written from each system's documentation and from memory of their reports, not from real downloads: no real
 * report has been read yet, which `TESTING-TODO.md` keeps open.
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Bank } from "../src/bank/store.ts";
import { unzipSync } from "../src/container/zip.ts";
import { createQuestion } from "../src/model/create.ts";
import { plainToRich } from "../src/model/richtext.ts";
import { createTest } from "../src/model/test.ts";
import type { Question } from "../src/model/question.ts";
import { matchQuestions, plainOf, readLmsResults, scoresFromLms, type LmsRead } from "../src/results/lms-results.ts";
import { itemStatistics } from "../src/sheets/stats.ts";

const AT = "2026-01-01T00:00:00.000Z";
let made = 0;
const mc = (stem: string, options: string[], right: number, title?: string): Question =>
  createQuestion({ type: "multipleChoice", stem: plainToRich(stem), ...(title ? { title } : {}), body: { shuffle: false, options: options.map((o, i) => ({ id: `o${i}`, content: plainToRich(o), correct: i === right })) }, by: "t", at: AT, id: `q_${String(++made).padStart(26, "0")}` });
const mr = (stem: string, options: string[], right: number[]): Question =>
  createQuestion({ type: "multipleResponse", stem: plainToRich(stem), body: { shuffle: false, partialCredit: true, options: options.map((o, i) => ({ id: `o${i}`, content: plainToRich(o), correct: right.includes(i) })) }, by: "t", at: AT, id: `q_${String(++made).padStart(26, "0")}` });

const sum = mc("What is 2 + 2?", ["3", "4", "5"], 1);
const capital = mc("Which city is the capital of France?", ["Lyon", "Paris", "Nice"], 1, "Capital");
const primes = mr("Which of these are prime?", ["2", "4", "5", "9"], [0, 2]);
const bankQuestions = [sum, capital, primes];

const canvasRows = [
  ["name", "id", "sis_id", "section", "section_id", "section_sis_id", "submitted", "attempt", "101: What is 2 + 2?", "1.0", "102: <p>Which city is the capital of France?</p>", "2.0", "103: Which of these are prime?", "1.0", "n correct", "n incorrect", "score"],
  ["Ana Lopez", "9001", "S1", "Sec 1", "1", "", "2026-10-01 10:00", "1", "4", "1", "Paris", "2", "2,5", "1", "3", "0", "4"],
  ["Bo Chan", "9002", "S2", "Sec 1", "1", "", "2026-10-01 10:05", "1", "5", "0", "Paris", "2", "2", "0.5", "1", "2", "2.5"],
  ["Cy Odu", "9003", "S3", "Sec 1", "1", "", "2026-10-01 10:09", "1", "", "0", "Lyon", "0", "4,9", "0", "0", "3", "0"],
];

const ok = (r: LmsRead): Extract<LmsRead, { ok: true }> => {
  assert.ok(r.ok, r.ok ? "" : r.reason);
  return r;
};

describe("reading a results report", () => {
  test("Canvas's Student Analysis: a question to a pair of columns, the response and the points earned", () => {
    const r = ok(readLmsResults("canvas", canvasRows));
    assert.deepEqual(r.questions.map((q) => [q.key, q.text]), [["101", "What is 2 + 2?"], ["102", "Which city is the capital of France?"], ["103", "Which of these are prime?"]]);
    assert.equal(r.attempts.length, 3);
    assert.deepEqual(r.attempts[1]?.answers.get("103"), { response: "2", earned: 0.5, possible: 1 });
    assert.deepEqual(r.attempts[0]?.answers.get("102"), { response: "Paris", earned: 2, possible: 2 });
  });

  test("reads nothing about a student: no name, id, section or date is in what it read", () => {
    const r = ok(readLmsResults("canvas", canvasRows));
    const text = JSON.stringify({ ...r, attempts: r.attempts.map((a) => ({ number: a.number, answers: [...a.answers] })) });
    for (const personal of ["Ana Lopez", "Bo Chan", "9001", "S1", "Sec 1", "2026-10-01"]) assert.ok(!text.includes(personal), personal);
    assert.match(r.notes[0] ?? "", /^7 columns about students .* were not read\. Attempts are known only by their place in the file\.$/);
  });

  test("Brightspace's export: a row for each question of each attempt, the attempt told apart by its rows and never by who", () => {
    const rows = [
      ["Org Defined ID", "Username", "FirstName", "LastName", "Attempt #", "Q #", "Q Type", "Q Title", "Q Text", "Answer", "Score", "Out Of"],
      ["111", "ana", "Ana", "Lopez", "1", "1", "MC", "", "What is 2 + 2?", "4", "1", "1"],
      ["111", "ana", "Ana", "Lopez", "1", "2", "MC", "Capital", "Which is the capital?", "Paris", "2", "2"],
      ["111", "ana", "Ana", "Lopez", "2", "1", "MC", "", "What is 2 + 2?", "3", "0", "1"],
      ["111", "ana", "Ana", "Lopez", "2", "2", "MC", "Capital", "Which is the capital?", "Paris", "2", "2"],
      ["222", "bo", "Bo", "Chan", "1", "1", "MC", "", "What is 2 + 2?", "", "", "1"],
    ];
    const r = ok(readLmsResults("brightspace", rows));
    assert.equal(r.attempts.length, 3);
    assert.deepEqual(r.questions.map((q) => [q.key, q.title]), [["1", undefined], ["2", "Capital"]]);
    assert.deepEqual(r.attempts[2]?.answers.get("1"), { response: "", possible: 1 }, "no points given is no points, never 0");
    assert.ok(!JSON.stringify(r.questions).includes("Lopez"));
  });

  test("Blackboard's Download Results, by question and user", () => {
    const rows = [
      ["Last Name", "First Name", "Username", "Attempt", "Question ID", "Question", "Answer", "Possible Points", "Auto Score", "Manual Score"],
      ["Lopez", "Ana", "ana", "1", "q1", "What is 2 + 2?", "4", "1", "1", ""],
      ["Lopez", "Ana", "ana", "1", "q2", "Which city is the capital of France?", "Paris", "2", "2", ""],
      ["Chan", "Bo", "bo", "1", "q1", "What is 2 + 2?", "5", "1", "0", ""],
      ["Chan", "Bo", "bo", "1", "q2", "Which city is the capital of France?", "Nice", "2", "0", ""],
    ];
    const r = ok(readLmsResults("blackboard", rows));
    assert.equal(r.attempts.length, 2);
    assert.deepEqual(r.attempts[1]?.answers.get("q2"), { response: "Nice", earned: 0, possible: 2 });
  });

  test("refuses a file that is not the report named, with what is missing, and never reads columns by their place", () => {
    const canvas = readLmsResults("canvas", [["Student", "Q1", "Q2"], ["Ana", "A", "B"]]);
    assert.equal(canvas.ok, false);
    assert.match(canvas.ok ? "" : canvas.reason, /not Canvas's Student Analysis/);
    const bb = readLmsResults("blackboard", canvasRows);
    assert.match(bb.ok ? "" : bb.reason, /not Blackboard's Download Results.*"question id".*"question"/i);
    const broken = readLmsResults("canvas", [["name", "101: A question", "points"], ["Ana", "x", "1"]]);
    assert.match(broken.ok ? "" : broken.reason, /should be headed with its points/);
    const notNumber = readLmsResults("canvas", [["101: A question", "1.0"], ["x", "one"]]);
    assert.match(notNumber.ok ? "" : notNumber.reason, /Row 2 has "one" where the points earned/);
    const mixed = readLmsResults("brightspace", [["Username", "Q #", "Q Text", "Score", "Out Of"], ["a", "1", "First words", "1", "1"], ["b", "1", "Other words", "1", "1"]]);
    assert.match(mixed.ok ? "" : mixed.reason, /different words/);
  });

  test("takes markup off with a plain scan, and a lone < is a character", () => {
    assert.equal(plainOf("<p>Is 3 <b>&lt;</b> 4?</p>").replace(/\s+/g, " ").trim(), "Is 3 < 4?");
    assert.equal(plainOf("a < b"), "a < b");
    const t = Date.now();
    plainOf("<".repeat(200000));
    assert.ok(Date.now() - t < 500, "a run of < is read once");
  });
});

describe("faults found by an independent review", () => {
  test("a report with no column that says whose a row is, is refused: attempts cannot be told apart", () => {
    const rows = [["Q #", "Q Text", "Answer", "Score", "Out Of"], ["1", "What is 2 + 2?", "4", "1", "1"], ["1", "What is 2 + 2?", "5", "0", "1"], ["2", "Which?", "a", "1", "1"], ["2", "Which?", "c", "1", "1"]];
    const r = readLmsResults("brightspace", rows);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.reason, /no column that says whose each row is/);
  });

  test("a report sorted by question, so one attempt's rows are apart, is refused rather than mixed", () => {
    const rows = [["Username", "Q #", "Q Text", "Answer", "Score", "Out Of"], ["x", "1", "One", "a", "1", "1"], ["y", "1", "One", "b", "0", "1"], ["z", "1", "One", "a", "1", "1"], ["x", "2", "Two", "c", "1", "1"]];
    const r = readLmsResults("brightspace", rows);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.reason, /Row 5 goes with an attempt whose rows came earlier/);
  });

  test("a multiple answer response that is one answer's words and also two answers' marks neither", () => {
    const q = mr("Pick.", ["A, B", "A", "B"], [1, 2]);
    const read = ok(readLmsResults("canvas", [["1: Pick.", "1"], ["A, B", "1"], ["A; B", "1"]]));
    const scores = scoresFromLms(read, matchQuestions(read.questions, [q]), [q]);
    assert.deepEqual(scores.map((s) => s.questions[0]?.marked), [[], ["o1", "o2"]]);
  });

  test("Blackboard's Manual Score is used where it is filled, and said", () => {
    const rows = [["Username", "Question ID", "Question", "Answer", "Possible Points", "Auto Score", "Manual Score"], ["a", "q1", "What is 2 + 2?", "four", "1", "0", "1"], ["b", "q1", "What is 2 + 2?", "4", "1", "1", ""]];
    const r = ok(readLmsResults("blackboard", rows));
    assert.deepEqual(r.attempts.map((a) => a.answers.get("q1")?.earned), [1, 1]);
    assert.ok(r.notes.some((n) => /1 answer has a score given by hand/.test(n)), r.notes.join(" | "));
  });

  test("a question worth no points counts on no attempt, and the others still make figures", () => {
    const read = ok(readLmsResults("canvas", [["1: What is 2 + 2?", "1", "2: Which city is the capital of France?", "0"], ["4", "1", "Paris", "0"], ["5", "0", "Lyon", "0"]]));
    const scores = scoresFromLms(read, matchQuestions(read.questions, bankQuestions), bankQuestions);
    assert.deepEqual(scores.map((s) => [s.complete, s.possible]), [[true, 1], [true, 1]]);
    assert.equal(scores[0]?.questions[1]?.outcome, "notScored");
  });
});

describe("matching to the bank", () => {
  test("by words that one question alone has, then by a title one question alone has", () => {
    const m = matchQuestions([{ key: "1", text: "What is 2 + 2?" }, { key: "2", text: "Which is the capital?", title: "Capital" }, { key: "3", text: "Not in the bank" }], bankQuestions);
    assert.deepEqual(m.map((x) => [x.key, x.questionId, x.by]), [["1", sum.id, "words"], ["2", capital.id, "title"], ["3", undefined, undefined]]);
    assert.match(m[2]?.reason ?? "", /No question of the bank has these words/);
  });

  test("matches typography folded on both sides, and nothing looser", () => {
    const curly = mc("Who wrote “Hamlet”?", ["Shakespeare", "Marlowe"], 0);
    const m = matchQuestions([{ key: "a", text: 'Who wrote "Hamlet"?' }, { key: "b", text: "Who wrote Hamlet?" }], [curly]);
    assert.equal(m[0]?.questionId, curly.id);
    assert.equal(m[1]?.questionId, undefined);
  });

  test("words two bank questions share match neither, and two report questions that find one bank question use neither", () => {
    const a = mc("Pick one.", ["x", "y"], 0);
    const b = mc("Pick one.", ["p", "q"], 1);
    assert.match(matchQuestions([{ key: "1", text: "Pick one." }], [a, b])[0]?.reason ?? "", /2 questions of the bank have these words/);
    const twice = matchQuestions([{ key: "1", text: "What is 2 + 2?" }, { key: "2", text: "What is 2 + 2?" }], bankQuestions);
    assert.deepEqual(twice.map((x) => x.questionId), [undefined, undefined]);
    assert.match(twice[0]?.reason ?? "", /Another question of the report/);
  });
});

describe("scoring and figures", () => {
  test("the system's own points, an answer counted only where its words are exactly the answer, and the figures from them", () => {
    const read = ok(readLmsResults("canvas", canvasRows));
    const matches = matchQuestions(read.questions, bankQuestions);
    const scores = scoresFromLms(read, matches, bankQuestions);
    assert.deepEqual(scores.map((s) => [s.number, s.earned, s.possible, s.complete]), [[1, 4, 4, true], [2, 2.5, 4, true], [3, 0, 4, true]]);
    assert.deepEqual(scores[0]?.questions.map((q) => [q.outcome, q.marked]), [["right", ["o1"]], ["right", ["o1"]], ["right", ["o0", "o2"]]]);
    assert.deepEqual(scores[1]?.questions.map((q) => q.outcome), ["wrong", "right", "partial"]);
    assert.deepEqual(scores[2]?.questions.map((q) => [q.outcome, q.marked]), [["blank", []], ["wrong", ["o0"]], ["wrong", ["o1", "o3"]]]);
    const record = createTest({ name: "Quiz", questions: bankQuestions, versions: 1, seed: "s", at: AT });
    const stats = itemStatistics(record, scores);
    assert.equal(stats.sheets, 3);
    assert.equal(stats.items.find((i) => i.questionId === sum.id)?.difficulty, 0.3333);
    assert.deepEqual(stats.items.find((i) => i.questionId === capital.id)?.options.map((o) => o.chosen), [1, 2, 0]);
  });

  test("a response in other words is no answer marked, never the nearest", () => {
    const read = ok(readLmsResults("canvas", [["1: What is 2 + 2?", "1"], ["four", "1"], ["4.", "0"]]));
    const scores = scoresFromLms(read, matchQuestions(read.questions, bankQuestions), bankQuestions);
    assert.deepEqual(scores.map((s) => s.questions[0]?.marked), [[], []]);
    assert.equal(scores[0]?.questions[0]?.outcome, "right", "the points are the system's, whatever the words");
  });

  test("an attempt with a question the system gave no points for is not complete, and is left out of the figures", () => {
    const read = ok(readLmsResults("canvas", [["1: What is 2 + 2?", "1"], ["4", "1"], ["4", ""]]));
    const scores = scoresFromLms(read, matchQuestions(read.questions, bankQuestions), bankQuestions);
    assert.deepEqual(scores.map((s) => s.complete), [true, false]);
    assert.equal(scores[1]?.questions[0]?.outcome, "unsettled");
    assert.equal(itemStatistics(createTest({ name: "Q", questions: [sum], versions: 1, seed: "s", at: AT }), scores).sheets, 1);
  });
});

describe("openassess results", () => {
  let dir = "";
  const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, "results", ...args], { encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "openassess-results-"));
    const bank = Bank.createEmpty("Quiz bank", { at: AT });
    for (const q of bankQuestions) bank.add(q);
    writeFileSync(join(dir, "quiz3.csv"), canvasRows.map((r) => r.map((c) => (/[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\r\n"));
    return bank.save(join(dir, "b.openassess"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("refuses a date that is not a day", () => {
    const r = run(join(dir, "b.openassess"), join(dir, "quiz3.csv"), "--lms", "canvas", "--date", "2026-13-45", "--save-statistics");
    assert.equal(r.code, 2);
    assert.match(r.err, /--date is a day written like 2026-11-04, not "2026-13-45"/);
  });

  test("names the systems it reads when none is given", () => {
    const r = run(join(dir, "b.openassess"), join(dir, "quiz3.csv"));
    assert.equal(r.code, 2);
    assert.match(r.err, /canvas: Canvas, the Student Analysis report/);
    assert.match(r.err, /blackboard: Blackboard/);
  });

  test("reads a report, shows the figures, writes a .pstat with no student in it, and keeps the figures only when told", () => {
    const out = join(dir, "out");
    const r = run(join(dir, "b.openassess"), join(dir, "quiz3.csv"), "--lms", "canvas", "--date", "2026-10-02", "--out", out, "--save-statistics");
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /3 attempts and 3 questions read from Canvas's Student Analysis report; 3 matched/);
    assert.match(r.out, /Matched by its title|over 3 complete attempts/);
    const [file] = readdirSync(out);
    assert.match(file ?? "", /^Quiz results \(Canvas\) - Results for statistics 2026-10-02\.pstat$/, "named for the system and never for the report's file");
    const text = new TextDecoder().decode(unzipSync(new Uint8Array(readFileSync(join(out, file as string)))).get("project.json"));
    const project = JSON.parse(text);
    assert.equal(project.source.report.notes[0], "From Canvas's Student Analysis report, with the learning system's own points.");
    for (const personal of ["Ana Lopez", "Lopez", "Bo Chan", "9001", "Sec 1"]) assert.ok(!text.includes(personal), personal);
    assert.match(r.out, /class-level figures were kept/);
  });
});
