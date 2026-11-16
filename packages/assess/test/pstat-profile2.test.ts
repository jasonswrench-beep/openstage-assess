/**
 * Profile 2 of the .pstat (PSTAT-1 section 7.2): the letters marked in version A's lettering and `assessment.json`, the key and the
 * details of every question by its bank id. The core's case `letters-60` is a class of sixty sheets with the letters each marked;
 * here its sheets are scored by OpenAssess's own scorer (with the adjustments the case names: an answer also accepted, a question
 * credited to everyone and one dropped), the points must be the case's, and the file written must be the case's own file, part and
 * all. The core is read from where it is and not copied; without it those tests say they were skipped.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { unzipSync } from "../src/container/zip.ts";
import { createQuestion } from "../src/model/create.ts";
import { plainToRich } from "../src/model/richtext.ts";
import { answerAt, createTest, versionQuestions, type TestRecord, type VersionLabel } from "../src/model/test.ts";
import { scoreSheets, type Adjustment, type SettledSheet } from "../src/sheets/score.ts";
import { PSTAT_ENTRY, PSTAT_PART, pstatProject2, writePstatFile } from "../src/sheets/pstat-export.ts";

const AT = "2026-11-01T00:00:00.000Z";
const repo = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const core = [process.env.OPENSTAGE_CORE, join(repo, "..", "openstage-core")].filter((c): c is string => !!c).find((c) => existsSync(join(c, "testsets", "item-analysis", "cases", "letters-60", "answers.csv")));
const skip = core ? false : "openstage-core with set 1.1.0 is not on this machine (set OPENSTAGE_CORE to its folder)";

interface Item {
  id: string;
  possible: number;
  partial_credit: boolean;
  type: "multiple_choice" | "select_all" | "true_false";
  options: string[];
  correct: string[];
  adjustment: "none" | "credit_all" | "dropped";
}

const ulid = (prefix: string, n: number): string => `${prefix}_01KA9C3T00${String(n).padStart(16, "0")}`;
const csv = (path: string): Array<Record<string, string>> => {
  const [head, ...lines] = readFileSync(path, "utf8").trim().split(/\r?\n/);
  const cols = (head as string).split(",");
  return lines.map((line) => Object.fromEntries(line.split(",").map((c, i) => [cols[i] as string, c])));
};

/** The case's test as OpenAssess holds one: its questions by the bank ids the set uses, and the adjustments the case names. */
function caseTest(items: Item[], versions: number): { record: TestRecord; adjustments: Adjustment[] } {
  const questions = items.map((it, j) => {
    const id = ulid("q", j + 1);
    const letterIndex = (l: string) => l.charCodeAt(0) - 65;
    if (it.type === "true_false") return createQuestion({ type: "trueFalse", stem: plainToRich("A statement"), body: { correct: it.correct[0] === "A" }, by: "t", at: AT, id, points: it.possible });
    // The first accepted letter is the bank's key; another accepted letter is an adjustment (answer also right), as a person adds one.
    const right = it.type === "select_all" ? [...(it.correct[0] ?? "")].map(letterIndex) : it.correct.length > 0 ? [letterIndex(it.correct[0] as string)] : [0];
    const options = it.options.map((_l, k) => ({ id: `o${k + 1}`, content: plainToRich(`Answer ${k + 1}`), correct: right.includes(k) }));
    return it.type === "select_all"
      ? createQuestion({ type: "multipleResponse", stem: plainToRich("Select all"), body: { shuffle: false, partialCredit: it.partial_credit, options }, by: "t", at: AT, id, points: it.possible })
      : createQuestion({ type: "multipleChoice", stem: plainToRich("Pick one"), body: { shuffle: false, options }, by: "t", at: AT, id, points: it.possible });
  });
  const record = createTest({ id: ulid("t", 0), name: "letters-60", questions, versions, seed: "letters-60", at: AT });
  const adjustments: Adjustment[] = [];
  items.forEach((it, j) => {
    const questionId = ulid("q", j + 1);
    if (it.adjustment === "dropped") adjustments.push({ id: `adj_${adjustments.length + 1}`, kind: "drop", questionId, at: AT });
    if (it.adjustment === "credit_all") adjustments.push({ id: `adj_${adjustments.length + 1}`, kind: "credit", questionId, at: AT });
    if (it.type === "multiple_choice" && it.adjustment === "none") for (const extra of it.correct.slice(1)) adjustments.push({ id: `adj_${adjustments.length + 1}`, kind: "alsoRight", questionId, answer: answerAt(record, "A", questionId, extra) as string, at: AT });
  });
  return { record, adjustments };
}

/** The case's sheets as OpenAssess settles them: each letter of version A turned into the place it has on the sheet's own version. */
function settled(record: TestRecord, items: Item[], answers: Array<Record<string, string>>): SettledSheet[] {
  return answers.map((row) => {
    const version = Number(row["version"]);
    const label = String.fromCharCode(64 + version) as VersionLabel;
    const list = versionQuestions(record, label);
    const out: SettledSheet = { number: Number(row["sheet"]), version, answers: {}, problems: [] };
    items.forEach((it, j) => {
      const id = ulid("q", j + 1);
      const at = list.findIndex((q) => q.id === id);
      const cell = row[it.id] ?? "";
      if (cell === "") {
        out.answers[at + 1] = { kind: "blank", by: "reader" };
        return;
      }
      const q = list[at];
      const places = [...cell].map((l) => {
        const answer = answerAt(record, "A", id, l) as string;
        if (it.type === "true_false") return answer === "true" ? 0 : 1;
        return (q?.body as { options: Array<{ id: string }> }).options.findIndex((o) => o.id === answer);
      });
      out.answers[at + 1] = { kind: "marked", places, by: "reader" };
    });
    return out;
  });
}

describe("profile 2 against the core's letters-60 case", () => {
  test("OpenAssess's scorer gives the case's points, and the file it writes is the case's file, part and all", { skip }, async () => {
    const pstat = await import(pathToFileURL(join(core as string, "packages", "pstat", "src", "index.js")).href);
    const dir = join(core as string, "testsets", "item-analysis", "cases", "letters-60");
    const info = JSON.parse(readFileSync(join(dir, "case.json"), "utf8")) as { versions: number; items: Item[] };
    const { record, adjustments } = caseTest(info.items, info.versions);
    const scores = scoreSheets(record, settled(record, info.items, csv(join(dir, "answers.csv"))), adjustments);

    // The points: OpenAssess's scoring is the spec's rule, which is what lets it write profile 2 at all.
    const want = csv(join(dir, "scores.csv"));
    scores.forEach((s, r) => {
      info.items.forEach((it, j) => {
        const q = s.questions.find((x) => x.questionId === ulid("q", j + 1));
        const cell = want[r]?.[it.id] ?? "";
        assert.equal(q && q.possible > 0 ? q.earned : null, cell === "" ? null : Number(cell), `sheet ${s.number} ${it.id}`);
      });
    });

    const made = pstatProject2(record, scores, "OpenAssess test", { source: "scanned sheets", given: "2026-11-10", adjustments });
    assert.equal(made.refused, undefined);
    const bytes = writePstatFile(made.project, made.part);
    assert.deepEqual([...unzipSync(bytes).keys()], [PSTAT_ENTRY, PSTAT_PART], "project.json, then the part, and nothing else");
    assert.deepEqual(pstat.checkPstat(bytes), []);
    const theirs = new Uint8Array(readFileSync(join(dir, "letters-60.pstat")));
    assert.deepEqual({ ...pstat.readPstat(bytes), app_version: "" }, { ...pstat.readPstat(theirs), app_version: "" });
    assert.deepEqual(pstat.readPart(bytes), pstat.readPart(theirs));
  });

  test("the core's checker refuses a profile 2 file whose key does not give a point written, so the test above can fail", { skip }, async () => {
    const pstat = await import(pathToFileURL(join(core as string, "packages", "pstat", "src", "index.js")).href);
    const dir = join(core as string, "testsets", "item-analysis", "cases", "letters-60");
    const info = JSON.parse(readFileSync(join(dir, "case.json"), "utf8")) as { versions: number; items: Item[] };
    const { record, adjustments } = caseTest(info.items, info.versions);
    const scores = scoreSheets(record, settled(record, info.items, csv(join(dir, "answers.csv"))), adjustments);
    const made = pstatProject2(record, scores, "OpenAssess test", { source: "scanned sheets", given: "2026-11-10", adjustments });
    const firstKey = made.part?.questions[0]?.key[0] as { correct: string[] };
    firstKey.correct = firstKey.correct[0] === "A" ? ["B"] : ["A"];
    assert.ok((pstat.checkPstat(writePstatFile(made.project, made.part)) as unknown[]).length > 0);
    assert.ok((pstat.checkPstat(writePstatFile(made.project)) as unknown[]).length > 0, "profile 2 without its part is refused");
  });
});

describe("faults found by an independent review of profile 2", () => {
  const mc = (n: number, points = 1) => createQuestion({ type: "multipleChoice", stem: plainToRich("Q"), body: { shuffle: false, options: [0, 1, 2].map((k) => ({ id: `o${k}`, content: plainToRich(`A${k}`), correct: k === 1 })) }, by: "t", at: AT, id: ulid("q", 70 + n), points });
  // A sheet for each place given, with every question of the test marked at that place.
  const sheetsFor = (record: TestRecord, places: number[]): SettledSheet[] =>
    places.map((p, i) => ({ number: i + 1, version: 1, answers: Object.fromEntries(record.questions.map((_q, k) => [k + 1, { kind: "marked" as const, places: [p], by: "reader" as const }])), problems: [] }));

  test("points with more than six places are written as the scorer rounded them, and a worth that rounds to nothing is dropped", async () => {
    const record = createTest({ id: ulid("t", 50), name: "Places", questions: [mc(1, 0.3333333), mc(2, 1)], versions: 1, seed: "s", at: AT });
    const adjustments: Adjustment[] = [{ id: "adj_1", kind: "points", questionId: ulid("q", 72), points: 0.1234567, at: AT }];
    const made = pstatProject2(record, scoreSheets(record, sheetsFor(record, [1, 0]), adjustments), "OpenAssess test", { source: "scanned sheets", adjustments });
    assert.equal(made.fellBack, undefined, made.fellBack);
    assert.deepEqual(made.part?.questions.map((q) => q.key[0]?.points), [0.333333, 0.123457]);
    const tiny = createTest({ id: ulid("t", 51), name: "Tiny", questions: [mc(3, 1e-7), mc(4, 1)], versions: 1, seed: "s", at: AT });
    const t = pstatProject2(tiny, scoreSheets(tiny, sheetsFor(tiny, [1])), "OpenAssess test", { source: "scanned sheets" });
    assert.equal(t.part?.questions[0]?.key[0]?.adjustment, "dropped");
    if (core) {
      const pstat = await import(pathToFileURL(join(core, "packages", "pstat", "src", "index.js")).href);
      assert.deepEqual(pstat.checkPstat(writePstatFile(made.project, made.part)), []);
      assert.deepEqual(pstat.checkPstat(writePstatFile(t.project, t.part)), []);
    }
  });

  test("a learning system's points the key cannot give (above the worth, below 0, worth nothing on one attempt) are written in profile 1, and said", () => {
    const record = createTest({ id: ulid("t", 52), name: "Online", questions: [mc(5)], versions: 1, seed: "s", at: AT });
    const attempt = (n: number, earned: number, possible: number) => ({ number: n, version: 1, earned, possible, settled: 1, unsettled: 0, complete: true, problems: [], questions: [{ number: 1, questionId: ulid("q", 75), outcome: "right" as const, earned, possible, marked: [] }] });
    for (const scores of [[attempt(1, 1.5, 1), attempt(2, 1, 1)], [attempt(1, -0.5, 1), attempt(2, 1, 1)], [attempt(1, 0, 0), attempt(2, 1, 1)]]) {
      const made = pstatProject2(record, scores, "OpenAssess test", { source: "learning system report" });
      assert.ok(made.fellBack, JSON.stringify(scores.map((s) => s.earned)));
      assert.equal(made.part, undefined);
      assert.equal(made.project.profile, "OpenAssess item results 1");
      assert.match(made.project.source.report.notes.at(-1) ?? "", /^Written with the points only \(profile 1\)/);
    }
  });

  test("the day the test was given is written only when the person gave one", () => {
    const record = createTest({ id: ulid("t", 53), name: "Day", questions: [mc(6)], versions: 1, seed: "s", at: AT });
    const scores = scoreSheets(record, sheetsFor(record, [1]));
    assert.equal(pstatProject2(record, scores, "x", { source: "scanned sheets" }).part?.test.given, null);
    assert.equal(pstatProject2(record, scores, "x", { source: "scanned sheets", given: "2026-11-10" }).part?.test.given, "2026-11-10");
  });

  test("an answer counted as right that the question does not have, read from a scores file, is refused", async () => {
    const { adjustmentProblem } = await import("../src/sheets/score.ts");
    const record = createTest({ id: ulid("t", 54), name: "Adj", questions: [mc(7)], versions: 2, seed: "s", at: AT });
    assert.equal(adjustmentProblem(record, [{ id: "a", kind: "alsoRight", questionId: ulid("q", 77), answer: "o2", at: AT }]), undefined);
    assert.match(adjustmentProblem(record, [{ id: "a", kind: "alsoRight", questionId: ulid("q", 77), answer: "o99", at: AT }]) ?? "", /does not have \(o99\)/);
    assert.match(adjustmentProblem(record, [{ id: "a", kind: "drop", questionId: ulid("q", 77), versions: [3], at: AT }]) ?? "", /version this test does not have/);
    assert.match(adjustmentProblem(record, [{ id: "a", kind: "drop", questionId: "q_nothere", at: AT }]) ?? "", /does not hold/);
  });

  test("a question's version that is not a whole number is refused when a bank is read", async () => {
    const { validateQuestion } = await import("../src/model/schema.ts");
    const q = mc(8);
    assert.equal(validateQuestion(q).ok, true);
    const bad = validateQuestion({ ...q, version: 1.5 });
    assert.equal(bad.ok, false);
  });

  test("a credited question whose marks were not settled is said, since its answer cell reads like a blank", () => {
    const record = createTest({ id: ulid("t", 55), name: "Credit", questions: [mc(9), mc(10)], versions: 1, seed: "s", at: AT });
    const adjustments: Adjustment[] = [{ id: "adj_1", kind: "credit", questionId: ulid("q", 79), at: AT }];
    const sheets: SettledSheet[] = [{ number: 1, version: 1, answers: { 1: { kind: "unsettled", why: "faint" }, 2: { kind: "marked", places: [1], by: "reader" } }, problems: [] }];
    const scores = scoreSheets(record, sheets, adjustments);
    assert.equal(scores[0]?.complete, true);
    const made = pstatProject2(record, scores, "x", { source: "scanned sheets", adjustments });
    assert.ok(made.project.source.report.notes.some((n) => /^r01: question 1 was credited to everyone, and on 1 sheet its marks were not settled/.test(n)), made.project.source.report.notes.join(" | "));
  });
});

describe("profile 2 on its own", () => {
  const q = (n: number, correct: number) => createQuestion({ type: "multipleChoice", stem: plainToRich("Q"), body: { shuffle: false, options: [0, 1, 2].map((k) => ({ id: `o${k}`, content: plainToRich(`A${k}`), correct: k === correct })) }, by: "t", at: AT, id: ulid("q", 90 + n), metadata: { status: "draft", tags: ["unit 3"], chapter: "3", bloom: "apply", difficulty: "easy" } });

  test("a key that differs by version names its versions, an essay is other and left out, and the details are the question's", () => {
    const essay = createQuestion({ type: "essay", stem: plainToRich("Discuss."), body: {}, by: "t", at: AT, id: ulid("q", 99) });
    const record = createTest({ id: ulid("t", 9), name: "Two versions", questions: [q(1, 0), essay], versions: 2, seed: "s", at: AT });
    const adjustments: Adjustment[] = [{ id: "adj_1", kind: "drop", questionId: ulid("q", 91), versions: [2], at: AT }];
    const sheets: SettledSheet[] = [1, 2].map((v) => ({ number: v, version: v, answers: { 1: { kind: "marked", places: [0], by: "reader" } }, problems: [] }));
    const made = pstatProject2(record, scoreSheets(record, sheets, adjustments), "OpenAssess test", { source: "scanned sheets", adjustments });
    const [first, second] = made.part?.questions ?? [];
    assert.deepEqual(first?.key, [
      { versions: [1], correct: ["A"], points: 1, adjustment: "none", partial_credit: false },
      { versions: [2], correct: [], points: 1, adjustment: "dropped", partial_credit: false },
    ]);
    assert.deepEqual(first?.details, { objective: null, chapter: "3", section: null, page: null, bloom: "apply", difficulty: "easy", tags: ["unit 3"] });
    assert.deepEqual([second?.type, second?.points_variable, second?.answer_variable, second?.options], ["other", null, null, []]);
    assert.equal(made.part?.test.given, null, "no date was given");
    // The answer cell is empty exactly where the points are, on the version that dropped it.
    const r01 = made.project.dataset.columns[made.project.dataset.variables.findIndex((v) => v.name === "r01")];
    assert.deepEqual(r01?.values, ["A", null]);
  });

  test("the letters are version A's whatever version the sheet was, when the versions shuffle the answers", () => {
    const shuffled = createQuestion({ type: "multipleChoice", stem: plainToRich("Q"), body: { shuffle: true, options: [0, 1, 2, 3, 4].map((k) => ({ id: `o${k}`, content: plainToRich(`A${k}`), correct: k === 3 })) }, by: "t", at: AT, id: ulid("q", 95) });
    const record = createTest({ id: ulid("t", 6), name: "Shuffled", questions: [shuffled], versions: 4, seed: "shuffle-letters", at: AT });
    // Every version marks the right answer, at the place it has on that version.
    const sheets: SettledSheet[] = [1, 2, 3, 4].map((v) => {
      const list = versionQuestions(record, String.fromCharCode(64 + v) as VersionLabel);
      const place = (list[0]?.body as { options: Array<{ id: string }> }).options.findIndex((o) => o.id === "o3");
      return { number: v, version: v, answers: { 1: { kind: "marked", places: [place], by: "reader" } }, problems: [] };
    });
    const places = sheets.map((s) => (s.answers[1] as { places: number[] }).places[0]);
    assert.ok(new Set(places).size > 1, `the versions put the answer in different places (${places.join(", ")})`);
    const made = pstatProject2(record, scoreSheets(record, sheets), "OpenAssess test", { source: "scanned sheets" });
    const r01 = made.project.dataset.columns[made.project.dataset.variables.findIndex((v) => v.name === "r01")];
    const letterOfRightOnA = String.fromCharCode(65 + (versionQuestions(record, "A")[0]?.body as { options: Array<{ id: string }> }).options.findIndex((o) => o.id === "o3"));
    assert.deepEqual(r01?.values, [letterOfRightOnA, letterOfRightOnA, letterOfRightOnA, letterOfRightOnA]);
    assert.deepEqual(made.part?.questions[0]?.key[0]?.correct, [letterOfRightOnA]);
  });

  test("a learning system's report writes no answer variables, and every question is other, worth what the system said", () => {
    const record = createTest({ id: ulid("t", 8), name: "Online", questions: [q(2, 1)], versions: 1, seed: "s", at: AT });
    const scores = [{ number: 1, version: 1, earned: 2, possible: 2, settled: 1, unsettled: 0, complete: true, problems: [], questions: [{ number: 1, questionId: ulid("q", 92), outcome: "right" as const, earned: 2, possible: 2, marked: [] }] }];
    const made = pstatProject2(record, scores, "OpenAssess test", { source: "learning system report", given: "2026-10-01" });
    assert.ok(!made.project.dataset.variables.some((v) => v.name.startsWith("r")));
    assert.deepEqual(made.part?.questions[0]?.key, [{ correct: [], points: 2, adjustment: "none", partial_credit: false }]);
    assert.equal(made.part?.questions[0]?.type, "other");
    assert.equal(made.part?.test.source, "learning system report");
  });

  test("never writes a question's words, an option's words, a student id or a name", () => {
    const record = createTest({ id: ulid("t", 7), name: "Secret", questions: [q(3, 2)], versions: 1, seed: "s", at: AT });
    const sheets: SettledSheet[] = [{ number: 1, version: 1, answers: { 1: { kind: "marked", places: [2], by: "reader" } }, problems: [] }];
    const made = pstatProject2(record, scoreSheets(record, sheets), "OpenAssess test", { source: "scanned sheets" });
    const text = JSON.stringify(made.project) + JSON.stringify(made.part);
    assert.doesNotMatch(text, /"A[0-9]"|Pick one|"Q"/);
    assert.ok(!made.project.dataset.variables.some((v) => v.name === "student_id" || v.name === "student_name"));
  });
});
