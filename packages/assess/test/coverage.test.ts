/**
 * What a bank covers (`bank/coverage.ts`): counts of questions by objective, chapter, tag, Bloom level, difficulty, kind and
 * status, and the grid of any two against each other.
 *
 * It counts what is there. A question with no objective is counted under "(none)", so a grid never adds up to less than the bank
 * and a person can see how much is not tagged; a retired question is left out unless asked for; and a question with several tags is
 * counted once under each.
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Bank } from "../src/bank/store.ts";
import { COVERAGE_AXES, NONE, coverage, facets, isCoverageAxis, matchesFacets, valuesOn } from "../src/bank/coverage.ts";
import { createQuestion } from "../src/model/create.ts";
import type { Metadata, Question } from "../src/model/question.ts";
import { plainToRich } from "../src/model/richtext.ts";

let n = 0;
function q(meta: Partial<Metadata> = {}, type: Question["type"] = "essay"): Question {
  n++;
  const body = type === "trueFalse" ? { correct: true } : {};
  return createQuestion({ type, stem: plainToRich(`Question ${n}`), body: body as never, metadata: { tags: [], status: "draft", ...meta } });
}

describe("the values a question has", () => {
  test("one on most axes, with a blank or missing value counted as none", () => {
    const a = q({ objective: "1.1 Define", chapter: " Chapter 2 ", bloom: "apply", difficulty: "hard", section: "A" });
    assert.deepEqual(valuesOn(a, "objective"), ["1.1 Define"]);
    assert.deepEqual(valuesOn(a, "chapter"), ["Chapter 2"]);
    assert.deepEqual(valuesOn(a, "bloom"), ["apply"]);
    assert.deepEqual(valuesOn(a, "difficulty"), ["hard"]);
    assert.deepEqual(valuesOn(a, "section"), ["A"]);
    assert.deepEqual(valuesOn(a, "type"), ["essay"]);
    assert.deepEqual(valuesOn(a, "status"), ["draft"]);
    const bare = q({ objective: "   " });
    for (const axis of ["objective", "chapter", "section", "bloom", "difficulty"] as const) assert.deepEqual(valuesOn(bare, axis), [NONE], axis);
  });

  test("a question's tags are all its values, once each, and none when it has none", () => {
    assert.deepEqual(valuesOn(q({ tags: ["unit-1", " review ", "unit-1", ""] }), "tag"), ["unit-1", "review"]);
    assert.deepEqual(valuesOn(q({ tags: [] }), "tag"), [NONE]);
    assert.deepEqual(valuesOn(q({ tags: ["", "  "] }), "tag"), [NONE]);
  });

  test("every axis is one the grid can use", () => {
    assert.deepEqual([...COVERAGE_AXES], ["objective", "chapter", "section", "tag", "bloom", "difficulty", "type", "status"]);
    assert.equal(isCoverageAxis("bloom"), true);
    assert.equal(isCoverageAxis("points"), false);
    assert.equal(isCoverageAxis(""), false);
  });
});

describe("the grid of two things against each other", () => {
  const bank = [
    q({ objective: "1.2 Explain", bloom: "understand" }),
    q({ objective: "1.2 Explain", bloom: "understand" }),
    q({ objective: "1.2 Explain", bloom: "apply" }),
    q({ objective: "1.10 Compare", bloom: "analyze" }),
    q({ objective: "1.1 Define", bloom: "remember" }),
    q({ objective: "1.1 Define" }),
    q({ bloom: "remember" }),
    q({}),
  ];

  test("counts each question once, with the labels in the order a person expects", () => {
    const grid = coverage(bank, "objective", "bloom");
    assert.deepEqual(grid.rowLabels, ["1.1 Define", "1.2 Explain", "1.10 Compare", NONE], "numbers in order, so 1.10 comes after 1.2, and none last");
    assert.deepEqual(grid.colLabels, ["remember", "understand", "apply", "analyze", NONE], "Bloom from remembering up, and none last");
    assert.deepEqual(grid.cells, [
      [1, 0, 0, 0, 1],
      [0, 2, 1, 0, 0],
      [0, 0, 0, 1, 0],
      [1, 0, 0, 0, 1],
    ]);
    assert.deepEqual(grid.rowTotals, [2, 3, 1, 2]);
    assert.deepEqual(grid.colTotals, [2, 2, 1, 1, 2]);
    assert.equal(grid.total, 8);
    assert.equal(grid.rows, "objective");
    assert.equal(grid.cols, "bloom");
  });

  test("never adds up to less than the bank: the questions with nothing are counted too", () => {
    const grid = coverage(bank, "objective", "bloom");
    assert.equal(grid.cells.flat().reduce((a, b) => a + b, 0), bank.length);
    assert.equal(grid.rowTotals.reduce((a, b) => a + b, 0), bank.length);
    assert.equal(grid.colTotals.reduce((a, b) => a + b, 0), bank.length);
  });

  test("leaves out the retired, unless asked", () => {
    const withRetired = [...bank, q({ objective: "1.1 Define", bloom: "remember", status: "retired" })];
    assert.equal(coverage(withRetired, "objective", "bloom").total, 8);
    assert.deepEqual(coverage(withRetired, "objective", "bloom").cells, coverage(bank, "objective", "bloom").cells);
    const all = coverage(withRetired, "objective", "bloom", { includeRetired: true });
    assert.equal(all.total, 9);
    assert.equal(all.cells[0]?.[0], 2);
  });

  test("an empty bank has an empty grid", () => {
    const grid = coverage([], "objective", "bloom");
    assert.deepEqual([grid.rowLabels, grid.colLabels, grid.cells, grid.total], [[], [], [], 0]);
    assert.deepEqual(coverage([q({ status: "retired" })], "type", "status").rowLabels, []);
  });

  test("a value the model does not list is kept, after the ones it does and before none", () => {
    const odd = [q({ bloom: "remember" }), q({ bloom: "invented" as never }), q({})];
    assert.deepEqual(coverage(odd, "bloom", "type").rowLabels, ["remember", "invented", NONE]);
  });

  test("difficulty, type and status are in their own order, not the alphabet", () => {
    const mixed = [q({ difficulty: "hard" }, "essay"), q({ difficulty: "easy" }, "trueFalse"), q({ difficulty: "medium" }, "essay"), q({ status: "approved" }), q({ status: "reviewed" })];
    assert.deepEqual(coverage(mixed, "difficulty", "type").rowLabels, ["easy", "medium", "hard", NONE]);
    assert.deepEqual(coverage(mixed, "difficulty", "type").colLabels, ["trueFalse", "essay"]);
    assert.deepEqual(coverage(mixed, "status", "type").rowLabels, ["draft", "reviewed", "approved"]);
  });

  test("a question with several tags is counted under each, and the total is still the number of questions", () => {
    const tagged = [q({ tags: ["unit-1", "midterm"], bloom: "apply" }), q({ tags: ["unit-1"], bloom: "apply" }), q({ bloom: "apply" })];
    const grid = coverage(tagged, "tag", "bloom");
    assert.deepEqual(grid.rowLabels, ["midterm", "unit-1", NONE]);
    assert.deepEqual(grid.cells, [[1], [2], [1]]);
    assert.deepEqual(grid.rowTotals, [1, 2, 1]);
    assert.equal(grid.total, 3);
    assert.ok(grid.rowTotals.reduce((a, b) => a + b, 0) > grid.total, "more than the questions, because one has two tags");
    // Tags on both axes: a question is counted for each pair.
    const both = coverage([q({ tags: ["a", "b"] })], "tag", "tag");
    assert.deepEqual(both.cells, [[1, 1], [1, 1]]);
    assert.equal(both.total, 1);
  });

  test("the same axis against itself is a diagonal", () => {
    const grid = coverage([q({ chapter: "1" }), q({ chapter: "2" }), q({ chapter: "2" })], "chapter", "chapter");
    assert.deepEqual(grid.cells, [[1, 0], [0, 2]]);
  });
});

describe("the choices of a filter", () => {
  test("every axis, with the values it takes and how many questions have each", () => {
    const f = facets([q({ chapter: "1", bloom: "apply", tags: ["a"] }), q({ chapter: "1", tags: ["a", "b"] }), q({ chapter: "2", status: "retired" })]);
    assert.deepEqual(f.chapter, [{ value: "1", count: 2 }]);
    assert.deepEqual(f.bloom, [{ value: "apply", count: 1 }, { value: NONE, count: 1 }]);
    assert.deepEqual(f.tag, [{ value: "a", count: 2 }, { value: "b", count: 1 }]);
    assert.deepEqual(f.status, [{ value: "draft", count: 2 }]);
    assert.deepEqual(Object.keys(f).sort(), [...COVERAGE_AXES].sort());
    assert.deepEqual(facets([q({ chapter: "2", status: "retired" })], { includeRetired: true }).chapter, [{ value: "2", count: 1 }]);
  });
});

describe("a question that has every value asked for", () => {
  const a = q({ chapter: "1", bloom: "apply", tags: ["x", "y"] });
  test("matches a value, a tag among several, and every filter at once", () => {
    assert.equal(matchesFacets(a, { chapter: "1" }), true);
    assert.equal(matchesFacets(a, { chapter: "2" }), false);
    assert.equal(matchesFacets(a, { tag: "y" }), true);
    assert.equal(matchesFacets(a, { tag: "z" }), false);
    assert.equal(matchesFacets(a, { chapter: "1", bloom: "apply", tag: "x" }), true);
    assert.equal(matchesFacets(a, { chapter: "1", bloom: "create" }), false);
  });

  test("(none) asks for a question without a value, and an empty filter asks for nothing", () => {
    assert.equal(matchesFacets(a, { objective: NONE }), true, "it has no objective");
    assert.equal(matchesFacets(a, { chapter: NONE }), false);
    assert.equal(matchesFacets(q({ tags: [] }), { tag: NONE }), true);
    assert.equal(matchesFacets(a, { chapter: "", bloom: "" }), true);
    assert.equal(matchesFacets(a, {}), true);
  });
});

describe("openassess coverage", () => {
  const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, "coverage", ...args], { encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  let dir = "";
  let path = "";
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "openassess-coverage-"));
    path = join(dir, "c.openassess");
    const bank = Bank.createEmpty("Coverage", { at: "2026-01-01T00:00:00.000Z" });
    bank.add(q({ objective: "Define", bloom: "remember", tags: ["a", "b"] }));
    bank.add(q({ objective: "Define", bloom: "apply" }));
    bank.add(q({ objective: "Compare", bloom: "apply", status: "retired" }));
    bank.add(q({}));
    await bank.save(path);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("prints a grid with its totals, objectives down and Bloom levels across, by default", () => {
    const r = run(path);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^3 question\(s\), objective down and bloom across\./);
    assert.deepEqual(r.out.trimEnd().split("\n").slice(2), [
      "        remember  apply  (none)  Total",
      "Define         1      1       0      2",
      "(none)         0      0       1      1",
      "Total          1      1       1      3",
    ]);
    assert.doesNotMatch(r.out, /Compare/, "the retired question is left out");
  });

  test("counts the retired with --retired, and takes the axes asked for", () => {
    assert.match(run(path, "--retired").out, /^4 question\(s\)/);
    assert.match(run(path, "--retired").out, /Compare/);
    const byTag = run(path, "--rows", "tag", "--cols", "type");
    assert.match(byTag.out, /A question with several tags is counted under each/);
    assert.match(byTag.out, /^a {2,}1/m);
  });

  test("refuses an axis it does not know, and a missing bank, with the choices", () => {
    const bad = run(path, "--rows", "points");
    assert.equal(bad.code, 2);
    assert.match(bad.err, /Choose from objective, chapter, section, tag, bloom, difficulty, type, status/);
    assert.equal(run().code, 2);
  });

  test("says so when there is nothing to count", async () => {
    const empty = join(dir, "empty.openassess");
    await Bank.createEmpty("Empty").save(empty);
    assert.match(run(empty).out, /There are no questions to count\./);
  });
});
