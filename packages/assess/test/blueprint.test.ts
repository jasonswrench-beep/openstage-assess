/**
 * Blueprints (`bank/blueprint.ts`): a stored recipe for a test, kept in a bank.
 *
 * Held here: a recipe that does not hold together is refused with a reason (above all a blank value, which `matchesFacets` would read
 * as "no filter" and so take from the whole bank); drawing takes what each rule asks for and no more, never fills a short rule up with
 * something else, takes a question that fits two rules once, and says why it came out short; the same seed gives the same questions;
 * a bank keeps its blueprints through a save, and a blueprint file it cannot read is kept byte for byte, reported, and not used.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { Bank } from "../src/bank/store.ts";
import { conditionsOf, conditionsText, describeDraw, drawBlueprint, impossible, newBlueprint, validateBlueprint, MOST_CONDITIONS, MOST_RULES, type Blueprint, type BlueprintRule } from "../src/bank/blueprint.ts";
import { matchesFacets, type CoverageAxis } from "../src/bank/coverage.ts";
import { MOST_PICKED, pickQuestions } from "../src/bank/pick.ts";
import { blueprintPath } from "../src/container/layout.ts";
import { unzipSync, zipSync } from "../src/container/zip.ts";
import { createQuestion } from "../src/model/create.ts";
import { isId } from "../src/model/ids.ts";
import type { Metadata, Question } from "../src/model/question.ts";
import { seededRandom } from "../src/model/random.ts";
import { plainToRich } from "../src/model/richtext.ts";
import { hasUsableKey } from "../src/quality/answer-key.ts";

let n = 0;
function mc(meta: Partial<Metadata> = {}, keyed = true): Question {
  n++;
  return createQuestion({
    type: "multipleChoice",
    stem: plainToRich(`Which city is the capital of the country number ${n} in the region called land${n}?`),
    body: { shuffle: true, options: [`Alpha${n}`, `Beta${n}`, `Gamma${n}`].map((t, i) => ({ id: `o${i}`, content: plainToRich(t), correct: keyed && i === 0 })) } as never,
    metadata: { tags: [], status: "draft", ...meta },
  });
}
const many = (meta: Partial<Metadata>, count: number, keyed = true): Question[] => Array.from({ length: count }, () => mc(meta, keyed));

const AT = "2026-11-06T12:00:00.000Z";
const recipe = (rules: Array<{ axis: string; value: string; count: number; and?: Array<{ axis: string; value: string }> }>, name = "Midterm"): Blueprint => newBlueprint({ name, rules }, AT);
const rule = (axis: CoverageAxis, value: string, count: number): BlueprintRule => ({ axis, value, count });
const rejected = (value: unknown): string => {
  const checked = validateBlueprint(value);
  assert.equal(checked.ok, false, "should have been refused");
  return checked.ok ? "" : checked.issues.map((i) => `${i.path}: ${i.message}`).join("\n");
};

describe("a blueprint that holds together", () => {
  test("a good recipe is accepted and its values are tidied", () => {
    const bp = recipe([rule("chapter", " 1 ", 5), rule("bloom", "apply", 2)]);
    assert.ok(isId(bp.id, "bp"));
    assert.equal(bp.rules[0]?.value, "1", "a value is trimmed, since the questions' values are");
    assert.equal(validateBlueprint(bp).ok, true);
  });

  test("a blank value is refused, because a blank filter would take from the whole bank", () => {
    assert.match(rejected({ ...recipe([rule("chapter", "1", 3)]), rules: [{ axis: "chapter", value: "", count: 3 }] }), /rules\.0\.value.*would match every question/);
    assert.match(rejected({ ...recipe([rule("chapter", "1", 3)]), rules: [{ axis: "chapter", value: "   ", count: 3 }] }), /rules\.0\.value/);
  });

  test("a value with space round it is refused, since it would match nothing and say nothing", () => {
    assert.match(rejected({ ...recipe([rule("chapter", "1", 3)]), rules: [{ axis: "chapter", value: " 1", count: 3 }] }), /no space at either end/);
  });

  test("the axis, the count, the number of rules and a repeated rule are all held to", () => {
    const base = recipe([rule("chapter", "1", 3)]);
    assert.match(rejected({ ...base, rules: [{ axis: "colour", value: "red", count: 3 }] }), /rules\.0\.axis/);
    for (const count of [0, -1, 1.5, MOST_PICKED + 1, "3", null, Number.NaN]) {
      assert.match(rejected({ ...base, rules: [{ axis: "chapter", value: "1", count }] }), /rules\.0\.count/, `count ${String(count)}`);
    }
    assert.match(rejected({ ...base, rules: [] }), /at least one rule/);
    assert.match(rejected({ ...base, rules: Array.from({ length: MOST_RULES + 1 }, (_, i) => ({ axis: "chapter", value: String(i), count: 1 })) }), /at most/);
    assert.match(rejected({ ...base, rules: [rule("chapter", "1", 2), rule("chapter", "1", 3)] }), /same thing/);
    assert.equal(validateBlueprint({ ...base, rules: [rule("chapter", "1", 2), rule("tag", "1", 3)] }).ok, true, "the same value on another axis is another rule");
  });

  test("the record itself is held to: version, id, name, dates, and no field it does not know", () => {
    const base = recipe([rule("chapter", "1", 3)]);
    assert.match(rejected({ ...base, recordVersion: 2 }), /version 2/);
    assert.match(rejected({ ...base, id: "t_00000000000000000000000000" }), /not a blueprint id/);
    assert.match(rejected({ ...base, name: "" }), /needs a name/);
    assert.match(rejected({ ...base, name: " padded " }), /needs a name/);
    assert.match(rejected({ ...base, name: "x".repeat(121) }), /at most 120/);
    assert.match(rejected({ ...base, created: "yesterday" }), /created/);
    assert.match(rejected({ ...base, seed: "abc" }), /seed is not a field/);
    assert.match(rejected({ ...base, rules: [{ axis: "chapter", value: "1", count: 3, weight: 2 }] }), /weight is not a field of a rule/);
    for (const v of [null, 3, "text", [], undefined]) assert.equal(validateBlueprint(v).ok, false);
  });
});

describe("drawing from a blueprint", () => {
  const bank = [...many({ chapter: "1" }, 12), ...many({ chapter: "2" }, 12), ...many({ chapter: "3" }, 2)];
  const byId = new Map(bank.map((q) => [q.id, q] as const));

  test("takes what each rule asks for, from the value it names and no other", () => {
    const draw = drawBlueprint(bank, recipe([rule("chapter", "1", 5), rule("chapter", "2", 3)]), { seed: "s" });
    assert.equal(draw.ids.length, 8);
    assert.equal(draw.wanted, 8);
    assert.equal(draw.short, 0);
    assert.equal(new Set(draw.ids).size, 8, "none twice");
    assert.deepEqual(draw.rules.map((r) => r.ids.length), [5, 3]);
    for (const id of draw.rules[0]?.ids ?? []) assert.equal(byId.get(id)?.metadata.chapter, "1");
    for (const id of draw.rules[1]?.ids ?? []) assert.equal(byId.get(id)?.metadata.chapter, "2");
  });

  test("the same seed takes the same questions from the same bank, whatever order it is held in, and another seed takes others", () => {
    const bp = recipe([rule("chapter", "1", 5), rule("chapter", "2", 5)]);
    const a = drawBlueprint(bank, bp, { seed: "one" });
    assert.deepEqual(drawBlueprint([...bank].reverse(), bp, { seed: "one" }).ids, a.ids);
    const reached = new Set<string>();
    for (const seed of ["two", "three", "four", "five"]) for (const id of drawBlueprint(bank, bp, { seed }).ids) reached.add(id);
    assert.ok(reached.size > 10, "other seeds reach other questions");
    assert.notDeepEqual(drawBlueprint(bank, bp, { seed: "two" }).ids, a.ids);
  });

  test("a rule that finds fewer than it wants is short by that many and is never made up from anything else", () => {
    const draw = drawBlueprint(bank, recipe([rule("chapter", "3", 5), rule("chapter", "1", 2)]), { seed: "s" });
    assert.equal(draw.rules[0]?.ids.length, 2);
    assert.equal(draw.rules[0]?.short, 3);
    assert.equal(draw.short, 3);
    assert.equal(draw.ids.length, 4, "two from chapter 3 and two from chapter 1, and nothing added to reach seven");
    assert.match(describeDraw(draw).join("\n"), /4 of 7 questions taken, 3 short/);
    assert.match(describeDraw(draw).join("\n"), /chapter 3: wanted 5, took 2; the bank has no more/);
  });

  test("a question that fits two rules is taken once, and the second rule says it found it taken", () => {
    const qs = [...many({ chapter: "1", bloom: "apply" }, 3), ...many({ chapter: "1", bloom: "remember" }, 3)];
    const draw = drawBlueprint(qs, recipe([rule("bloom", "apply", 3), rule("chapter", "1", 6)]), { seed: "s" });
    assert.equal(new Set(draw.ids).size, draw.ids.length);
    assert.equal(draw.ids.length, 6, "the three that fit both were taken by the first rule, and the other three by the second");
    assert.equal(draw.rules[1]?.pick.left.chosen, 3);
    const flipped = drawBlueprint(qs, recipe([rule("chapter", "1", 6), rule("bloom", "apply", 3)]), { seed: "s" });
    assert.equal(flipped.rules[1]?.short, 3, "taken first by the wide rule, the narrow one finds them gone, and says so");
    assert.match(describeDraw(flipped).join("\n"), /3 already in the test/);
  });

  test("it leaves out a retired question and one with no usable key, and counts them", () => {
    const qs = [...many({ chapter: "1" }, 2), ...many({ chapter: "1", status: "retired" }, 2), ...many({ chapter: "1" }, 3, false)];
    const draw = drawBlueprint(qs, recipe([rule("chapter", "1", 9)]), { seed: "s" });
    assert.equal(draw.ids.length, 2);
    assert.deepEqual({ retired: draw.rules[0]?.pick.left.retired, noKey: draw.rules[0]?.pick.left.noKey }, { retired: 2, noKey: 3 });
    assert.match(describeDraw(draw).join("\n"), /3 with no usable answer key, 2 retired/);
  });

  test("questions already in the test are not taken again", () => {
    const first = drawBlueprint(bank, recipe([rule("chapter", "3", 1)]), { seed: "s" });
    const second = drawBlueprint(bank, recipe([rule("chapter", "3", 2)]), { seed: "s", chosen: first.ids });
    assert.equal(second.ids.length, 1);
    assert.ok(!second.ids.includes(first.ids[0] as string));
  });

  test("a rule for the questions that have no value takes those and only those", () => {
    const qs = [...many({ chapter: "1" }, 3), ...many({}, 3)];
    const draw = drawBlueprint(qs, recipe([rule("chapter", "(none)", 3)]), { seed: "s" });
    assert.equal(draw.ids.length, 3);
    for (const id of draw.ids) assert.equal(qs.find((q) => q.id === id)?.metadata.chapter, undefined);
  });

  test("drawing changes no question", () => {
    const before = JSON.stringify(bank);
    drawBlueprint(bank, recipe([rule("chapter", "1", 5)]), { seed: "s" });
    assert.equal(JSON.stringify(bank), before);
  });

  test("a hundred random banks and recipes: never more than asked, none twice, each from its value, never retired or without a key", () => {
    const random = seededRandom("blueprint-property-20261106");
    const pickOf = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    for (let run = 0; run < 100; run++) {
      const qs: Question[] = [];
      for (let i = 0, total = 5 + Math.floor(random() * 40); i < total; i++) {
        qs.push(mc({ chapter: pickOf(["1", "2", "3", undefined] as const), bloom: pickOf(["apply", "remember", undefined] as const), status: random() < 0.15 ? "retired" : "draft" }, random() > 0.2));
      }
      const rules: Array<{ axis: string; value: string; count: number }> = [];
      for (const [axis, value] of [["chapter", "1"], ["chapter", "2"], ["bloom", "apply"], ["chapter", "(none)"]] as const) if (random() < 0.7) rules.push(rule(axis, value, 1 + Math.floor(random() * 8)));
      if (rules.length === 0) rules.push(rule("chapter", "1", 2));
      const bp = recipe(rules);
      const draw = drawBlueprint(qs, bp, { seed: `run${run}` });
      assert.equal(new Set(draw.ids).size, draw.ids.length, `run ${run}: none twice`);
      assert.equal(draw.ids.length + draw.short, draw.wanted, `run ${run}: taken and short add up to what was asked`);
      const lookup = new Map(qs.map((q) => [q.id, q] as const));
      for (const r of draw.rules) {
        assert.ok(r.ids.length <= r.rule.count, `run ${run}: no more than the rule asked for`);
        for (const id of r.ids) {
          const q = lookup.get(id) as Question;
          assert.notEqual(q.metadata.status, "retired", `run ${run}: not retired`);
          assert.ok(hasUsableKey(q), `run ${run}: has a key`);
        }
      }
      assert.deepEqual(drawBlueprint(qs, bp, { seed: `run${run}` }).ids, draw.ids, `run ${run}: the same again`);
    }
  });
});

describe("a bank that keeps blueprints", () => {
  const fresh = (): Bank => Bank.createEmpty("Recipes", { at: AT });

  test("adds, lists, finds, changes and removes a recipe", () => {
    const bank = fresh();
    const a = bank.addBlueprint(recipe([rule("chapter", "1", 5)], "Quiz 1"));
    const b = bank.addBlueprint(newBlueprint({ name: "Midterm", rules: [rule("chapter", "2", 5)] }, "2026-11-07T12:00:00.000Z"));
    assert.deepEqual(bank.listBlueprints().map((x) => x.name), ["Quiz 1", "Midterm"], "oldest first");
    assert.equal(bank.getBlueprint(a.id)?.name, "Quiz 1");
    const changed = bank.updateBlueprint(a.id, { name: "Quiz one", rules: [rule("chapter", " 1 ", 6)] }, "2026-11-08T12:00:00.000Z");
    assert.equal(changed.name, "Quiz one");
    assert.equal(changed.rules[0]?.value, "1");
    assert.equal(changed.rules[0]?.count, 6);
    assert.equal(changed.created, AT);
    assert.equal(changed.modified, "2026-11-08T12:00:00.000Z");
    assert.equal(bank.removeBlueprint(b.id), true);
    assert.equal(bank.removeBlueprint(b.id), false);
    assert.equal(bank.listBlueprints().length, 1);
  });

  test("refuses a recipe that does not hold together, a repeated id and a repeated name, and changes nothing", () => {
    const bank = fresh();
    const a = bank.addBlueprint(recipe([rule("chapter", "1", 5)], "Quiz 1"));
    assert.throws(() => bank.addBlueprint({ ...recipe([rule("chapter", "1", 5)], "Other"), rules: [] }), /does not hold together/);
    assert.throws(() => bank.addBlueprint({ ...recipe([rule("chapter", "1", 5)], "Other"), id: a.id }), /already holds a blueprint with the id/);
    assert.throws(() => bank.addBlueprint(recipe([rule("chapter", "1", 5)], "quiz 1")), /already holds a blueprint called "Quiz 1"/, "names are told apart without regard to case");
    const b = bank.addBlueprint(recipe([rule("chapter", "2", 5)], "Quiz 2"));
    assert.throws(() => bank.updateBlueprint(b.id, { name: "QUIZ 1" }), /already holds a blueprint called/);
    assert.throws(() => bank.updateBlueprint(b.id, { rules: [rule("chapter", "", 2)] }), /does not hold together/);
    assert.throws(() => bank.updateBlueprint("bp_00000000000000000000000000", { name: "x" }), /holds no blueprint/);
    assert.deepEqual(bank.getBlueprint(b.id), b, "a refused change left it as it was");
  });

  test("a recipe survives a save and an open, and a bank without any opens as it did", () => {
    const bank = fresh();
    const a = bank.addBlueprint(recipe([rule("chapter", "1", 5), rule("tag", "lab", 2)], "Quiz 1"));
    const { bank: again, report } = Bank.fromBytes(bank.toBytes({ at: AT }));
    assert.deepEqual(again.getBlueprint(a.id), a);
    assert.deepEqual(report.invalid, []);
    assert.deepEqual(report.unknownFiles, []);
    const plain = Bank.fromBytes(fresh().toBytes({ at: AT }));
    assert.equal(plain.bank.blueprints.size, 0);
    assert.deepEqual(plain.report.invalid, []);
  });

  test("a recipe holds no question: the file names values and counts only", () => {
    const bank = fresh();
    const q = bank.add(mc({ chapter: "1" }));
    bank.addBlueprint(recipe([rule("chapter", "1", 1)], "Quiz 1"));
    const entries = unzipSync(bank.toBytes({ at: AT }));
    const file = [...entries.entries()].find(([name]) => name.startsWith("blueprints/"));
    assert.ok(file);
    assert.ok(!Buffer.from(file[1]).toString("utf8").includes(q.id), "so a question can be changed or removed without a recipe going stale");
  });

  test("removing or changing a recipe touches no question and no test", () => {
    const bank = fresh();
    const q = bank.add(mc({ chapter: "1" }));
    const a = bank.addBlueprint(recipe([rule("chapter", "1", 1)], "Quiz 1"));
    const questionBefore = JSON.stringify(bank.get(q.id));
    bank.updateBlueprint(a.id, { rules: [rule("chapter", "2", 1)] });
    bank.removeBlueprint(a.id);
    assert.equal(JSON.stringify(bank.get(q.id)), questionBefore);
    assert.equal(bank.history.length, 1, "only the question being added is in the history");
  });

  test("two recipes of one name, as a merge of two copies can leave, still open, and either one's rules can be changed", () => {
    const bank = fresh();
    const a = bank.addBlueprint(recipe([rule("chapter", "1", 5)], "Quiz 1"));
    const entries = unzipSync(bank.toBytes({ at: AT }));
    const twin = recipe([rule("chapter", "2", 5)], "Quiz 1");
    entries.set(blueprintPath(twin.id), new Uint8Array(Buffer.from(JSON.stringify(twin), "utf8")));
    const { bank: merged, report } = Bank.fromBytes(zipSync([...entries].map(([name, data]) => ({ name, data }))));
    assert.deepEqual(report.invalid, []);
    assert.equal(merged.blueprints.size, 2);
    assert.doesNotThrow(() => merged.updateBlueprint(a.id, { rules: [rule("chapter", "3", 1)] }));
  });
});

describe("a blueprint file the bank cannot read is kept, reported and not used", () => {
  const good = recipe([rule("chapter", "1", 5)], "Quiz 1");
  const open = (files: Record<string, string>): { bank: Bank; report: ReturnType<typeof Bank.fromBytes>["report"]; kept: Map<string, Uint8Array> } => {
    const bank = Bank.createEmpty("Recipes", { at: AT });
    const entries = unzipSync(bank.toBytes({ at: AT }));
    for (const [name, text] of Object.entries(files)) entries.set(name, new Uint8Array(Buffer.from(text, "utf8")));
    const opened = Bank.fromBytes(zipSync([...entries].map(([name, data]) => ({ name, data }))));
    return { ...opened, kept: unzipSync(opened.bank.toBytes({ at: AT })) };
  };
  const text = (data: Uint8Array | undefined): string => (data ? Buffer.from(data).toString("utf8") : "<missing>");

  test("a file that is not JSON", () => {
    const damaged = '{"recordVersion": 1, "id": "bp_0000';
    const path = blueprintPath("bp_BROKEN00000000000000000A");
    const { bank, report, kept } = open({ [path]: damaged });
    assert.equal(bank.blueprints.size, 0);
    assert.equal(report.invalid.length, 1);
    assert.match(report.invalid[0]?.issues[0]?.message ?? "", /not valid JSON/);
    assert.equal(text(kept.get(path)), damaged, "kept byte for byte through a save");
  });

  test("a file of the wrong shape, one with a field this program does not know, and one with a version it does not read", () => {
    const wrongShape = JSON.stringify({ ...good, rules: "all of them" });
    const extra = JSON.stringify({ ...good, id: "bp_00000000000000000000000001", seed: "abc" });
    const newer = JSON.stringify({ ...good, id: "bp_00000000000000000000000002", recordVersion: 2 });
    const files = { [blueprintPath(good.id)]: wrongShape, [blueprintPath("bp_00000000000000000000000001")]: extra, [blueprintPath("bp_00000000000000000000000002")]: newer };
    const { bank, report, kept } = open(files);
    assert.equal(bank.blueprints.size, 0, "none of them used");
    assert.equal(report.invalid.length, 3, "each said");
    for (const [path, body] of Object.entries(files)) assert.equal(text(kept.get(path)), body, `${path} kept as it was`);
  });

  test("a second file with an id already loaded is kept and said, and the first stays", () => {
    const copy = JSON.stringify({ ...good, name: "A copy" });
    const { bank, report, kept } = open({ [blueprintPath(good.id)]: JSON.stringify(good), "blueprints/copy.json": copy });
    assert.equal(bank.blueprints.size, 1);
    assert.equal(bank.getBlueprint(good.id)?.name, "Quiz 1");
    assert.match(report.invalid.map((i) => i.issues[0]?.message).join("\n"), /already holds the blueprint/);
    assert.equal(text(kept.get("blueprints/copy.json")), copy);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// A rule for a cell of the grid a test is planned on: a chapter and a level together
// ---------------------------------------------------------------------------------------------------------------------------------

describe("a rule that asks for values on more than one axis", () => {
  /** "Chapter 2 and the Apply level": a cell of the grid `assess coverage` shows. */
  const cell = (chapter: string, bloom: string, count: number): BlueprintRule => ({ axis: "chapter", value: chapter, count, and: [{ axis: "bloom", value: bloom }] });
  const grid = [...many({ chapter: "1", bloom: "apply" }, 4), ...many({ chapter: "1", bloom: "remember" }, 4), ...many({ chapter: "2", bloom: "apply" }, 2), ...many({ chapter: "2", bloom: "remember" }, 4)];
  const lookup = new Map(grid.map((q) => [q.id, q] as const));
  const where = (ids: readonly string[]): string[] => ids.map((id) => `${lookup.get(id)?.metadata.chapter}/${lookup.get(id)?.metadata.bloom}`).sort();
  const withAnd = (and: unknown): unknown => ({ ...recipe([cell("1", "apply", 2)]), rules: [{ axis: "chapter", value: "1", count: 2, and }] });

  describe("the record", () => {
    test("is tidied, and a rule with nothing else has no field for it, so it reads in an older program", () => {
      const bp = newBlueprint({ name: "Grid", rules: [{ axis: "chapter", value: " 2 ", count: 3, and: [{ axis: "bloom", value: " apply " }] }, { axis: "chapter", value: "1", count: 2, and: [] }, { axis: "tag", value: "lab", count: 1 }] }, AT);
      assert.deepEqual(bp.rules[0]?.and, [{ axis: "bloom", value: "apply" }], "its values are trimmed, as the questions' are");
      assert.equal(bp.rules[0]?.value, "2");
      assert.equal("and" in (bp.rules[1] as object), false, "an empty list is not written");
      assert.equal("and" in (bp.rules[2] as object), false);
      assert.equal(validateBlueprint(bp).ok, true);
      assert.ok(!JSON.stringify(bp.rules[2]).includes("and"), "the file of a recipe that never used it is what it always was");
    });

    test("is held to: a list of one to four, objects with an axis and a value and nothing else, no blank", () => {
      assert.equal(validateBlueprint(withAnd([{ axis: "bloom", value: "apply" }])).ok, true);
      assert.match(rejected(withAnd([])), /rules\.0\.and.*list of 1 to 4/);
      assert.match(rejected(withAnd("bloom")), /rules\.0\.and/);
      assert.match(rejected(withAnd(["bloom"])), /rules\.0\.and\.0.*object/);
      assert.match(rejected(withAnd([{ axis: "bloom", value: "" }])), /rules\.0\.and\.0\.value.*would match every question/);
      assert.match(rejected(withAnd([{ axis: "bloom", value: "   " }])), /rules\.0\.and\.0\.value/);
      assert.match(rejected(withAnd([{ axis: "bloom", value: " apply" }])), /rules\.0\.and\.0\.value.*no space at either end/);
      assert.match(rejected(withAnd([{ axis: "colour", value: "red" }])), /rules\.0\.and\.0\.axis/);
      assert.match(rejected(withAnd([{ axis: "bloom", value: "apply", weight: 1 }])), /weight is not a field of a condition/);
      assert.match(rejected(withAnd([{ axis: "bloom", value: "x".repeat(201) }])), /at most 200/);
      const tags = (n: number): unknown => withAnd(Array.from({ length: n }, (_, i) => ({ axis: "tag", value: `t${i}` })));
      assert.equal(validateBlueprint(tags(MOST_CONDITIONS - 1)).ok, true, "four others and the first make five");
      assert.match(rejected(tags(MOST_CONDITIONS)), /rules\.0\.and/);
    });

    test("a set that could never be had by one question is refused, in words", () => {
      assert.match(rejected(withAnd([{ axis: "chapter", value: "2" }])), /one chapter.*could never take a question/, "a question has one chapter");
      assert.match(rejected(withAnd([{ axis: "chapter", value: "1" }])), /chapter 1 twice/);
      const tagged = (...tags: string[]): unknown => ({ ...recipe([rule("tag", tags[0] as string, 2)]), rules: [{ axis: "tag", value: tags[0], count: 2, and: tags.slice(1).map((value) => ({ axis: "tag", value })) }] });
      assert.equal(validateBlueprint(tagged("lab", "exam")).ok, true, "a question may have several tags");
      assert.match(rejected(tagged("lab", "lab")), /tag lab twice/);
      assert.match(rejected(tagged("lab", "(none)")), /no tag/);
      assert.match(rejected(tagged("(none)", "lab")), /no tag/);
      assert.equal(validateBlueprint({ ...recipe([rule("chapter", "(none)", 1)]), rules: [{ axis: "chapter", value: "(none)", count: 1, and: [{ axis: "bloom", value: "apply" }] }] }).ok, true, "no chapter at the apply level is a cell like any other");
      assert.equal(impossible([{ axis: "chapter", value: "1" }, { axis: "bloom", value: "apply" }]), undefined);
    });

    test("the same values in another order are one rule, and a rule with more is another", () => {
      const swapped: BlueprintRule = { axis: "bloom", value: "apply", count: 1, and: [{ axis: "chapter", value: "1" }] };
      assert.match(rejected({ ...recipe([rule("chapter", "1", 1)]), rules: [cell("1", "apply", 2), swapped] }), /same thing/);
      assert.equal(validateBlueprint({ ...recipe([rule("chapter", "1", 1)]), rules: [cell("1", "apply", 2), rule("chapter", "1", 3), rule("bloom", "apply", 1)] }).ok, true, "chapter 1, and chapter 1 at apply, are different rules");
    });

    test("conditionsOf and conditionsText give the first value and then the others", () => {
      assert.deepEqual(conditionsOf(cell("2", "apply", 1)), [{ axis: "chapter", value: "2" }, { axis: "bloom", value: "apply" }]);
      assert.equal(conditionsText(cell("2", "apply", 1)), "chapter 2 and bloom apply");
      assert.equal(conditionsText(rule("chapter", "2", 1)), "chapter 2", "a rule of one value reads as it always did");
    });
  });

  describe("drawing", () => {
    test("takes only the questions that have every value, and is short when the cell is thin, never made up from a neighbour", () => {
      const draw = drawBlueprint(grid, recipe([cell("2", "apply", 5)]), { seed: "s" });
      assert.deepEqual(where(draw.ids), ["2/apply", "2/apply"], "chapter 2 has four at the remember level and chapter 1 has four at apply, and none of them was taken");
      assert.equal(draw.short, 3);
      assert.match(describeDraw(draw).join("\n"), /chapter 2 and bloom apply: wanted 5, took 2; the bank has no more/);
    });

    test("a plan on both axes takes each cell from its own", () => {
      const draw = drawBlueprint(grid, recipe([cell("1", "apply", 3), cell("1", "remember", 2), cell("2", "remember", 4), cell("2", "apply", 1)]), { seed: "s" });
      assert.equal(draw.short, 0);
      assert.deepEqual(draw.rules.map((r) => where(r.ids).join(",")), ["1/apply,1/apply,1/apply", "1/remember,1/remember", "2/remember,2/remember,2/remember,2/remember", "2/apply"]);
    });

    test("a wider rule after a narrow one finds the narrow one's questions taken, and says so", () => {
      const draw = drawBlueprint(grid, recipe([cell("1", "apply", 4), rule("chapter", "1", 6)]), { seed: "s" });
      assert.equal(draw.rules[1]?.ids.length, 4, "the four at the remember level");
      assert.equal(draw.rules[1]?.short, 2);
      assert.equal(draw.rules[1]?.pick.left.chosen, 4);
      assert.match(describeDraw(draw).join("\n"), /chapter 1: wanted 6, took 4; left out 4 already in the test/);
    });

    test("a question must have both tags, and no more tags than that are asked for", () => {
      const qs = [mc({ tags: ["lab", "exam"] }), mc({ tags: ["lab", "exam", "x"] }), mc({ tags: ["lab"] }), mc({ tags: ["exam"] }), mc({ tags: [] })];
      const draw = drawBlueprint(qs, { ...recipe([rule("tag", "lab", 9)]), rules: [{ axis: "tag", value: "lab", count: 9, and: [{ axis: "tag", value: "exam" }] }] }, { seed: "s" });
      assert.deepEqual([...draw.ids].sort(), [qs[0]?.id, qs[1]?.id].sort(), "the two that have both");
    });

    test("no value on one axis with a value on another takes the questions that have the second and not the first", () => {
      const qs = [mc({ bloom: "apply" }), mc({ bloom: "apply", chapter: "1" }), mc({ chapter: "1" }), mc({})];
      const draw = drawBlueprint(qs, { ...recipe([rule("chapter", "(none)", 1)]), rules: [{ axis: "chapter", value: "(none)", count: 9, and: [{ axis: "bloom", value: "apply" }] }] }, { seed: "s" });
      assert.deepEqual(draw.ids, [qs[0]?.id]);
    });

    test("a rule of one value takes what it took before, and so does an empty list of others", () => {
      // One blueprint id for both: the id is part of the seed, and recipe() makes a new one each time.
      const base = recipe([rule("chapter", "1", 5)]);
      const plain = drawBlueprint(grid, base, { seed: "s" });
      const empty = drawBlueprint(grid, { ...base, rules: [{ axis: "chapter", value: "1", count: 5, and: [] }] }, { seed: "s" });
      assert.deepEqual(empty.ids, plain.ids);
      const picked = pickQuestions(grid, { axis: "chapter", value: "1", count: 5, seed: "x" });
      assert.deepEqual(pickQuestions(grid, { axis: "chapter", value: "1", count: 5, seed: "x", also: [] }), picked, "no further condition, the same pick");
    });

    test("the same seed takes the same questions, in any order the bank is held, and other seeds reach the whole cell and nothing outside it", () => {
      const bp = recipe([cell("1", "apply", 2)]);
      const a = drawBlueprint(grid, bp, { seed: "one" });
      assert.deepEqual(drawBlueprint([...grid].reverse(), bp, { seed: "one" }).ids, a.ids);
      const reached = new Set<string>();
      for (const seed of ["two", "three", "four", "five", "six", "seven", "eight", "nine"]) for (const id of drawBlueprint(grid, bp, { seed }).ids) reached.add(id);
      assert.deepEqual(where([...reached]), ["1/apply", "1/apply", "1/apply", "1/apply"]);
    });

    test("pick refuses a blank condition, since a blank filter would take from the whole bank", () => {
      assert.throws(() => pickQuestions(grid, { axis: "chapter", value: "1", count: 1, also: [{ axis: "bloom", value: "  " }] }), /needs a value.*match every question/);
      assert.equal(pickQuestions(grid, { axis: "chapter", value: "1", count: 9, also: [{ axis: "bloom", value: "apply" }] }).candidates, 4);
    });

    test("a hundred random banks and recipes of several values: each taken question has every value, none twice, never more than asked", () => {
      const random = seededRandom("blueprint-cells-20261107");
      const pickOf = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
      for (let run = 0; run < 100; run++) {
        const qs: Question[] = [];
        for (let i = 0, total = 10 + Math.floor(random() * 50); i < total; i++) {
          qs.push(mc({ chapter: pickOf(["1", "2", "3", undefined] as const), bloom: pickOf(["apply", "remember", undefined] as const), difficulty: pickOf(["easy", "hard", undefined] as const), tags: random() < 0.5 ? ["lab"] : random() < 0.5 ? ["lab", "exam"] : [], status: random() < 0.1 ? "retired" : "draft" }, random() > 0.15));
        }
        const rules: BlueprintRule[] = [];
        for (let i = 0, wanted = 1 + Math.floor(random() * 4); i < wanted; i++) {
          const and: Array<{ axis: CoverageAxis; value: string }> = [{ axis: "bloom", value: pickOf(["apply", "remember", "(none)"]) }];
          if (random() < 0.4) and.push({ axis: "difficulty", value: pickOf(["easy", "hard"]) });
          rules.push({ axis: "chapter", value: pickOf(["1", "2", "3", "(none)"]), count: 1 + Math.floor(random() * 6), and });
        }
        // Two random rules can be the same cell; that is the engine refusing a recipe, so a run that made one draws the unique ones.
        const unique = [...new Map(rules.map((r) => [conditionsText(r), r] as const)).values()];
        const bp = recipe(unique);
        assert.equal(validateBlueprint(bp).ok, true, `run ${run}: a recipe of cells holds together`);
        const draw = drawBlueprint(qs, bp, { seed: `run${run}` });
        assert.equal(new Set(draw.ids).size, draw.ids.length, `run ${run}: none twice`);
        assert.equal(draw.ids.length + draw.short, draw.wanted, `run ${run}: taken and short add up`);
        const found = new Map(qs.map((q) => [q.id, q] as const));
        for (const r of draw.rules) {
          assert.ok(r.ids.length <= r.rule.count, `run ${run}: no more than asked`);
          for (const id of r.ids) {
            const q = found.get(id) as Question;
            for (const c of conditionsOf(r.rule)) assert.ok(matchesFacets(q, { [c.axis]: c.value }), `run ${run}: ${conditionsText(r.rule)}`);
            assert.notEqual(q.metadata.status, "retired", `run ${run}: not retired`);
            assert.ok(hasUsableKey(q), `run ${run}: has a key`);
          }
        }
        assert.deepEqual(drawBlueprint(qs, bp, { seed: `run${run}` }).ids, draw.ids, `run ${run}: the same again`);
      }
    });
  });

  describe("kept in a bank", () => {
    test("survives a save and an open, a change keeps and tidies its other values, and a refused change leaves it as it was", () => {
      const bank = Bank.createEmpty("Recipes", { at: AT });
      const a = bank.addBlueprint(recipe([cell("2", "apply", 3), rule("chapter", "1", 2)], "Midterm"));
      const { bank: again, report } = Bank.fromBytes(bank.toBytes({ at: AT }));
      assert.deepEqual(again.getBlueprint(a.id), a);
      assert.deepEqual(report.invalid, []);
      const changed = bank.updateBlueprint(a.id, { rules: [{ axis: "chapter", value: " 2 ", count: 4, and: [{ axis: "bloom", value: " apply " }] }] }, "2026-11-08T12:00:00.000Z");
      assert.deepEqual(changed.rules, [cell("2", "apply", 4)], "the other value was kept, and trimmed");
      assert.throws(() => bank.updateBlueprint(a.id, { rules: [{ axis: "chapter", value: "2", count: 4, and: [{ axis: "chapter", value: "3" }] }] }), /does not hold together[\s\S]*one chapter/);
      assert.deepEqual(bank.getBlueprint(a.id), changed, "a refused change left it as it was");
    });

    test("a file with a field of a condition this program does not know is kept byte for byte, reported and not used", () => {
      const bank = Bank.createEmpty("Recipes", { at: AT });
      const entries = unzipSync(bank.toBytes({ at: AT }));
      const made = recipe([cell("1", "apply", 1)], "Odd");
      const odd = JSON.stringify({ ...made, rules: [{ axis: "chapter", value: "1", count: 1, and: [{ axis: "bloom", value: "apply", level: 2 }] }] });
      const path = blueprintPath(made.id);
      entries.set(path, new Uint8Array(Buffer.from(odd, "utf8")));
      const opened = Bank.fromBytes(zipSync([...entries].map(([name, data]) => ({ name, data }))));
      assert.equal(opened.bank.blueprints.size, 0);
      assert.match(opened.report.invalid.map((i) => i.issues.map((m) => m.message).join(" ")).join("\n"), /level is not a field of a condition/);
      assert.equal(Buffer.from(unzipSync(opened.bank.toBytes({ at: AT })).get(path) as Uint8Array).toString("utf8"), odd);
    });

    test("it still holds no question: the file names values and counts only", () => {
      const bank = Bank.createEmpty("Recipes", { at: AT });
      const q = bank.add(mc({ chapter: "2", bloom: "apply" }));
      bank.addBlueprint(recipe([cell("2", "apply", 1)], "Quiz"));
      const file = [...unzipSync(bank.toBytes({ at: AT })).entries()].find(([name]) => name.startsWith("blueprints/"));
      assert.ok(file);
      assert.ok(!Buffer.from(file[1]).toString("utf8").includes(q.id));
    });
  });
});
