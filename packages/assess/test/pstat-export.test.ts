/**
 * The .pstat export: the scored sheets of a class in the core's profile `OpenAssess item results 1`, held to the core's own reader and
 * checker and to the files of the shared item-analysis test set (C3), which are what PrismStatistics is checked against. The core is
 * read from where it is (`OPENSTAGE_CORE`, or `openstage-core` beside this repository) and not copied; without it those tests say they
 * were skipped, and the tests of the layout below still run.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { unzipSync } from "../src/container/zip.ts";
import { createQuestion } from "../src/model/create.ts";
import { plainToRich } from "../src/model/richtext.ts";
import { createTest } from "../src/model/test.ts";
import type { QuestionScore, SheetScore } from "../src/sheets/score.ts";
import { PSTAT_ENTRY, PSTAT_PROFILE, pstatAppVersion, pstatFileName, pstatProject, writePstatFile, type PstatProject } from "../src/sheets/pstat-export.ts";

const AT = "2026-01-01T00:00:00.000Z";
let made = 0;
const question = (partial = false) =>
  createQuestion({
    type: partial ? "multipleResponse" : "multipleChoice",
    stem: plainToRich("A secret question"),
    body: partial
      ? { shuffle: false, partialCredit: true, options: [0, 1, 2].map((i) => ({ id: `o${i}`, content: plainToRich(`Answer ${i}`), correct: i < 2 })) }
      : { shuffle: false, options: [0, 1, 2, 3].map((i) => ({ id: `o${i}`, content: plainToRich(`Answer ${i}`), correct: i === 0 })) },
    by: "t",
    at: AT,
    id: `q_${String(++made).padStart(26, "0")}`,
  });

/** Scored sheets from a table of points: `null` is a question that does not count on that sheet. */
function scoresOf(record: ReturnType<typeof createTest>, rows: Array<{ sheet: number; version: number | undefined; points: Array<number | null>; complete?: boolean }>, possible: number[]): SheetScore[] {
  return rows.map((r) => {
    const questions: QuestionScore[] = record.questions.map((q, j) => {
      const earned = r.points[j] ?? null;
      const counts = earned !== null;
      return { number: j + 1, questionId: q.id, outcome: counts ? (earned === possible[j] ? "right" : earned === 0 ? "wrong" : "partial") : "dropped", earned: counts ? earned : 0, possible: counts ? (possible[j] as number) : 0, marked: [] } as QuestionScore;
    });
    const earned = questions.reduce((s, q) => s + q.earned, 0);
    return { number: r.sheet, version: r.version, earned, possible: questions.reduce((s, q) => s + q.possible, 0), settled: questions.length, unsettled: r.complete === false ? 1 : 0, complete: r.complete !== false, problems: [], questions };
  });
}

const parse = (bytes: Uint8Array): PstatProject => {
  const files = unzipSync(bytes);
  assert.deepEqual([...files.keys()], [PSTAT_ENTRY], "project.json is the only entry");
  const data = files.get(PSTAT_ENTRY) as Uint8Array;
  assert.notDeepEqual([...data.slice(0, 3)], [0xef, 0xbb, 0xbf], "no byte-order mark");
  return JSON.parse(new TextDecoder().decode(data));
};

describe("the .pstat export", () => {
  const record = createTest({ id: `t_${"9".padStart(26, "0")}`, name: "Midterm", questions: [question(), question(), question(true), question()], versions: 2, seed: "s", at: AT });
  const scores = scoresOf(
    record,
    [
      { sheet: 3, version: 2, points: [1, 0, 0.5, null] },
      { sheet: 1, version: 1, points: [1, 1, 1, 1] },
      { sheet: 2, version: 1, points: [0, 1, 0, 0] },
      { sheet: 4, version: 2, points: [0, 0, 0, null], complete: false },
      { sheet: 5, version: undefined, points: [1, 1, 1, 1] },
    ],
    [1, 1, 1, 1],
  );
  const { project, sheets, leftOut } = pstatProject(record, scores, "OpenAssess 0.1.0-alpha.28");

  test("writes one case per complete sheet, in sheet-number order, with the profile's variables", () => {
    assert.equal(project.format, "PrismStatistics project");
    assert.equal(project.version, 1);
    assert.equal(project.profile, PSTAT_PROFILE);
    assert.deepEqual([sheets, leftOut], [3, 2]);
    const d = project.dataset;
    assert.equal(d.name, "Midterm");
    assert.deepEqual(d.variables.map((v) => [v.id, v.name, v.label, v.measure]), [
      [1, "sheet", "Sheet number", "nominal"],
      [2, "version", "Version", "nominal"],
      [3, "q01", "Question 1", "scale"],
      [4, "q02", "Question 2", "scale"],
      [5, "q03", "Question 3", "scale"],
      [6, "q04", "Question 4", "scale"],
      [7, "total", "Total score", "scale"],
    ]);
    assert.deepEqual(d.variables[1]?.value_labels, [{ value: 1, label: "A" }, { value: 2, label: "B" }]);
    assert.equal(d.next_id, 8);
    assert.deepEqual(d.columns.map((c) => c.values), [[1, 2, 3], [1, 1, 2], [1, 0, 1], [1, 1, 0], [1, 0, 0.5], [1, 0, null], [4, 1, 1.5]]);
    assert.deepEqual(project.operations, []);
    assert.deepEqual(project.results, []);
  });

  test("says what it left out and where a question does not count", () => {
    assert.equal(project.source.file_name, "Midterm results");
    assert.deepEqual([project.source.report.rows, project.source.report.variables, project.source.report.short_rows], [3, 7, 0]);
    assert.deepEqual(project.source.report.notes, [
      "2 sheets were left out because they are not complete: a question that counts is not settled, a page is missing, or the version is not known.",
      "q04 does not count on version B, so its cells there are empty.",
    ]);
  });

  test("never writes a question's words, a file name or anything about a student", () => {
    const text = new TextDecoder().decode(unzipSync(writePstatFile(project)).get(PSTAT_ENTRY) as Uint8Array);
    assert.doesNotMatch(text, /secret question|Answer [0-9]/);
    assert.doesNotMatch(text, /\.png|\.pdf|student|name"\s*:\s*"[^"]*@/i);
  });

  test("leaves out a question that counts on no sheet, and says so", () => {
    const dropped = scoresOf(record, [{ sheet: 1, version: 1, points: [1, null, 1, 1] }, { sheet: 2, version: 2, points: [0, null, 1, null] }], [1, 1, 1, 1]);
    const p = pstatProject(record, dropped, "OpenAssess test").project;
    // Each by its number on version A, so the names skip the one left out (PSTAT-1 revision 1.1).
    assert.deepEqual(p.dataset.variables.map((v) => [v.name, v.label]), [["sheet", "Sheet number"], ["version", "Version"], ["q01", "Question 1"], ["q03", "Question 3"], ["q04", "Question 4"], ["total", "Total score"]]);
    assert.ok(p.source.report.notes.includes("Question 2 counts on none of the sheets written (it was dropped), so it is left out."), p.source.report.notes.join(" | "));
  });

  test("refuses to make a file with no sheet or no question, which the profile has no room for", () => {
    const none = pstatProject(record, scoresOf(record, [{ sheet: 1, version: 1, points: [1, 1, 1, 1], complete: false }], [1, 1, 1, 1]), "OpenAssess test");
    assert.match(none.refused ?? "", /No sheet is complete/);
    const dropped = pstatProject(record, scoresOf(record, [{ sheet: 1, version: 1, points: [null, null, null, null] }], [1, 1, 1, 1]), "OpenAssess test");
    assert.match(dropped.refused ?? "", /No question counts/);
    assert.equal(pstatProject(record, scoresOf(record, [{ sheet: 1, version: 1, points: [1, 0, 1, 1] }], [1, 1, 1, 1]), "x").refused, undefined);
  });

  test("the total is the sum of the cells to the last digit, however many places the points have", () => {
    const thirds = pstatProject(record, scoresOf(record, [{ sheet: 1, version: 1, points: [0.3333333, 0.3333333, 0.3333333, 0.1] }], [1, 1, 1, 1]), "x").project;
    const cells = thirds.dataset.columns.slice(2, -1).map((c) => c.values[0] as number);
    assert.equal(thirds.dataset.columns.at(-1)?.values[0], cells.reduce((s, v) => s + v, 0));
  });

  test("numbers the questions with as many digits as the largest needs", () => {
    const many = createTest({ id: `t_${"8".padStart(26, "0")}`, name: "Long", questions: Array.from({ length: 101 }, () => question()), versions: 1, seed: "s", at: AT });
    const p = pstatProject(many, scoresOf(many, [{ sheet: 1, version: 1, points: many.questions.map(() => 1) }], many.questions.map(() => 1)), "x").project;
    assert.equal(p.dataset.variables[2]?.name, "q001");
    assert.equal(p.dataset.variables[102]?.name, "q101");
    // With two of the 101 left out the width is still version A's: three digits, and the names stop at q099.
    const fewer = pstatProject(many, scoresOf(many, [{ sheet: 1, version: 1, points: many.questions.map((_q, i) => (i >= 99 ? null : 1)) }], many.questions.map(() => 1)), "x").project;
    assert.equal(fewer.dataset.variables[2]?.name, "q001");
    assert.equal(fewer.dataset.variables.at(-2)?.name, "q099");
  });

  test("the same sheets make the same bytes, and the file is a single deflated project.json", () => {
    const a = writePstatFile(project);
    assert.deepEqual(a, writePstatFile(project));
    assert.deepEqual(parse(a), project);
    // A whole number is written as an integer, which PrismStatistics requires of a count or an id.
    assert.match(new TextDecoder().decode(unzipSync(a).get(PSTAT_ENTRY) as Uint8Array), /"next_id":8[,}]/);
  });

  test("names the program and the release, and the file by the test and the date", () => {
    assert.equal(pstatAppVersion("v0.1.0-alpha.28", "0.1.0"), "OpenAssess 0.1.0-alpha.28");
    assert.equal(pstatAppVersion(undefined, "0.1.0"), "OpenAssess 0.1.0 (run from the source)");
    assert.equal(pstatFileName("Midterm", "2026-11-15"), "Midterm - Results for statistics 2026-11-15.pstat");
    assert.equal(pstatFileName("CON", "2026-11-15").startsWith("CON_") || pstatFileName("CON", "2026-11-15").startsWith("Untitled"), true, "a device name is kept apart");
  });
});

// ------------------------------------------------------------------------------------------------------------------------------
// Against the core

const repo = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const core = [process.env.OPENSTAGE_CORE, join(repo, "..", "openstage-core")].filter((c): c is string => !!c).find((c) => existsSync(join(c, "packages", "pstat", "src", "index.js")) && existsSync(join(c, "testsets", "item-analysis", "cases")));
const skip = core ? false : "openstage-core is not on this machine (set OPENSTAGE_CORE to its folder)";

describe("the .pstat export against the core", () => {
  test("every case of the item-analysis test set is written as the set's own file, and the core's checker finds nothing wrong", { skip }, async () => {
    const pstat = await import(pathToFileURL(join(core as string, "packages", "pstat", "src", "index.js")).href);
    const casesDir = join(core as string, "testsets", "item-analysis", "cases");
    const names = readdirSync(casesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    assert.ok(names.length >= 7);
    // Profile 2's case (letters-60) is a file OpenAssess does not write yet; every profile 1 case is held to, omitted-25 among them
    // when the core's set is 1.1.0 or later.
    let compared = 0;
    for (const name of names) {
      const setFile = new Uint8Array(readFileSync(join(casesDir, name, `${name}.pstat`)));
      if (pstat.readPstat(setFile).profile !== "OpenAssess item results 1") continue;
      compared++;
      const info = JSON.parse(readFileSync(join(casesDir, name, "case.json"), "utf8")) as { versions?: number; items: Array<{ id: string; possible: number; partial_credit: boolean }> };
      const [head, ...lines] = readFileSync(join(casesDir, name, "scores.csv"), "utf8").trim().split(/\r?\n/);
      const cols = (head as string).split(",");
      const rows = lines.map((line) => Object.fromEntries(line.split(",").map((c, i) => [cols[i], c === "" ? null : Number(c)])) as Record<string, number | null>);
      const versions = Math.max(1, ...rows.map((r) => r.version as number));
      const record = createTest({ id: `t_${name.replace(/[^a-z0-9]/g, "").padStart(26, "0").slice(-26)}`, name, questions: info.items.map((it) => question(it.partial_credit)), versions, seed: name, at: AT });
      const scores = scoresOf(record, rows.map((r) => ({ sheet: r.sheet as number, version: r.version as number, points: info.items.map((it) => r[it.id] ?? null) })), info.items.map((it) => it.possible));
      const ours = writePstatFile(pstatProject(record, scores, "OpenAssess test").project);
      assert.deepEqual(pstat.checkPstat(ours), [], `${name}: the core's checker`);
      const mine = pstat.readPstat(ours);
      const theirs = pstat.readPstat(setFile);
      assert.deepEqual({ ...mine, app_version: "" }, { ...theirs, app_version: "" }, `${name}: the set's file`);
      assert.match(mine.app_version, /^OpenAssess /);
    }
    assert.ok(compared >= 7, `only ${compared} cases compared`);
  });

  test("the files the review found refused by the core's checker are accepted: a question left out, 100 questions with one left out, points with seven places", { skip }, async () => {
    const pstat = await import(pathToFileURL(join(core as string, "packages", "pstat", "src", "index.js")).href);
    const four = createTest({ id: `t_${"6".padStart(26, "0")}`, name: "Four", questions: [question(), question(), question(), question()], versions: 1, seed: "s", at: AT });
    const dropped = writePstatFile(pstatProject(four, scoresOf(four, [{ sheet: 1, version: 1, points: [1, null, 0, 1] }, { sheet: 2, version: 1, points: [0, null, 1, 1] }], [1, 1, 1, 1]), "OpenAssess test").project);
    assert.deepEqual(pstat.checkPstat(dropped), []);
    const many = createTest({ id: `t_${"4".padStart(26, "0")}`, name: "Hundred", questions: Array.from({ length: 100 }, () => question()), versions: 1, seed: "s", at: AT });
    const ninetyNine = writePstatFile(pstatProject(many, scoresOf(many, [{ sheet: 1, version: 1, points: many.questions.map((_q, i) => (i === 99 ? null : 1)) }], many.questions.map(() => 1)), "OpenAssess test").project);
    assert.deepEqual(pstat.checkPstat(ninetyNine), []);
    const thirds = writePstatFile(pstatProject(four, scoresOf(four, [{ sheet: 1, version: 1, points: [0.3333333, 0.3333333, 0.3333333, 0] }], [1, 1, 1, 1]), "OpenAssess test").project);
    assert.deepEqual(pstat.checkPstat(thirds), []);
  });

  test("the core's checker refuses a broken file, so the test above can fail", { skip }, async () => {
    const pstat = await import(pathToFileURL(join(core as string, "packages", "pstat", "src", "index.js")).href);
    const record = createTest({ id: `t_${"7".padStart(26, "0")}`, name: "Broken", questions: [question(), question()], versions: 1, seed: "s", at: AT });
    const p = pstatProject(record, scoresOf(record, [{ sheet: 1, version: 1, points: [1, 0] }, { sheet: 2, version: 1, points: [0, 1] }], [1, 1]), "OpenAssess test").project;
    p.dataset.columns[4]!.values[0] = 5; // a total that is not the sum of its questions
    assert.ok((pstat.checkPstat(writePstatFile(p)) as unknown[]).length > 0);
  });
});
