/**
 * Banks that cost as much as they can to look at, found by readers who built them from a few kilobytes: a folder whose children
 * share a name, questions that share every word and differ only in the order of them, a question with tens of thousands of options
 * that read the same. Each is run in a process of its own with a time limit (and a memory limit where it is memory that fails), so
 * that a return of one fails here and does not freeze every test after it; and each fixed cost is held to the answers it always gave
 * (a copy of the old code, or a plain slow way of working the same thing out, beside the new one).
 *
 * The limits in time are several times what the fixed code takes on the machine this was written on, and many times less than the
 * old code needed, so a slow machine does not fail them and the old code does.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { Bank } from "../src/bank/store.ts";
import { drawBlueprint, newBlueprint } from "../src/bank/blueprint.ts";
import { pickQuestions } from "../src/bank/pick.ts";
import { folderNameKey, type FolderNode } from "../src/model/bank.ts";
import * as folderModel from "../src/model/bank.ts";
import { createQuestion } from "../src/model/create.ts";
import type { Question } from "../src/model/question.ts";
import { plainToRich, rich } from "../src/model/richtext.ts";
import * as quality from "../src/quality/bank.ts";
import { findDuplicates as findDuplicatesBefore } from "./support/old-quality-bank.ts";
import { inEngine, MAKE_CHOICE, MAKE_PERMUTATIONS, seeded, why } from "./support/bank-hostile.ts";

const AT = "2026-01-01T00:00:00.000Z";

/** What the child reported, or the reason it did not finish. */
function finished<T>(run: ReturnType<typeof inEngine<T>>): T {
  assert.ok(run.value !== undefined, `the run did not finish: ${why(run)}`);
  return run.value as T;
}

// ---------------------------------------------------------------------------
// Taking a folder away
// ---------------------------------------------------------------------------

/** The numbering a folder's children had before it was worked out once for them all: every number against every folder, for every child. */
function numberedBefore(present: readonly string[], arriving: readonly string[]): string[] {
  const others = [...present];
  return arriving.map((child) => {
    let name = child;
    for (let n = 2; others.some((f) => folderNameKey(f) === folderNameKey(name)); n++) name = `${child} (${n})`;
    others.push(name);
    return name;
  });
}

describe("taking away a folder whose children have the same name", () => {
  test("10,000 children called the same are numbered in milliseconds, and none is lost or merged", () => {
    // 1,200 took 24 seconds and 10,000 about four hours: the numbering tried every number against every folder for every child.
    const run = inEngine<{ ms: number; movedUp: number; count: number; unique: number; first: string[]; last: string; middle: string }>(
      `const { Bank } = await engine("bank/store.ts");
const bank = Bank.createEmpty("t");
bank.folders.root = [{ id: "fp", name: "parent", questionIds: [], children: Array.from({ length: 10000 }, (_, i) => ({ id: "c" + i, name: "same", questionIds: [], children: [] })) }];
const started = performance.now();
const done = bank.removeFolder("fp");
const ms = performance.now() - started;
const names = bank.folders.root.map((f) => f.name);
report({ ms, movedUp: done.movedUp, count: names.length, unique: new Set(names).size, first: names.slice(0, 3), last: names[names.length - 1], middle: names[4999] });`,
    );
    const done = finished(run);
    assert.ok(done.ms < 1000, `taking the folder away took ${Math.round(done.ms)} ms`);
    assert.equal(done.movedUp, 10_000);
    assert.equal(done.count, 10_000, "every child is still there");
    assert.equal(done.unique, 10_000, "and each has a name of its own");
    assert.deepEqual(done.first, ["same", "same (2)", "same (3)"]);
    assert.equal(done.middle, "same (5000)");
    assert.equal(done.last, "same (10000)");
  });

  test("a folder beside it with a numbered name is stepped over, and so is a name written another way", () => {
    const bank = Bank.createEmpty("t", { at: AT });
    const node = (id: string, name: string, children: FolderNode[] = []): FolderNode => ({ id, name, questionIds: [], children });
    bank.folders.root = [node("a", "Notes"), node("b", "notes (2)"), node("p", "parent", [node("c1", "Notes"), node("c2", "NOTES"), node("c3", "Notes (2)"), node("c4", "Fresh")])];
    bank.removeFolder("p");
    assert.deepEqual(bank.folders.root.map((f) => f.name), ["Notes", "notes (2)", "Notes (3)", "NOTES (4)", "Notes (2) (2)", "Fresh"]);
  });

  test("the names are the ones the slow numbering gave, for names that differ in case, in how an accent is written, and in a final sigma", () => {
    const pieces = ["a", "A", "\u{e1}", "a\u{301}", "\u{c1}", "A\u{301}", "x", "x (2)", "X (2)", "x (3)", "\u{391}\u{3a3}", "\u{3b1}\u{3c2}", "\u{391}\u{3a3} (2)", "\u{130}", "i\u{307}", "\u{df}", "SS", "ss", "Stra\u{df}e", "k", "\u{212a}", "  ", "(2)", " (2)", "a (2) (2)"];
    const next = seeded(20261108);
    const some = (max: number): string[] => Array.from({ length: next(max + 1) }, () => (next(3) === 0 ? `${pieces[next(pieces.length)]}${pieces[next(pieces.length)]}` : pieces[next(pieces.length)]) as string);
    for (let run = 0; run < 4000; run++) {
      const present = some(8);
      const arriving = some(14);
      assert.deepEqual(folderModel.namesMovingUp(present, arriving), numberedBefore(present, arriving), JSON.stringify({ present, arriving }));
    }
  });

  test("a bank takes a folder away with the names the slow numbering gave, and the questions stay in the bank", () => {
    const next = seeded(7);
    // "Gone" is the name of the folder taken away: a child with that name does not clash with it, since it goes.
    const names = ["Notes", "notes", "Notes (2)", "Quiz", "Quiz (3)", "\u{dc}nit", "U\u{308}nit", "Gone"];
    for (let run = 0; run < 200; run++) {
      const bank = Bank.createEmpty("t", { at: AT });
      const q = bank.add(createQuestion({ type: "essay", stem: plainToRich("An essay stem."), body: {}, at: AT, by: "test" }));
      let id = 0;
      const make = (name: string, children: FolderNode[] = []): FolderNode => ({ id: `f${id++}`, name, questionIds: [], children });
      const before = Array.from({ length: next(5) }, () => make(names[next(names.length)] as string));
      const inside = Array.from({ length: next(9) }, () => make(names[next(names.length)] as string));
      const after = Array.from({ length: next(4) }, () => make(names[next(names.length)] as string));
      const gone = make("Gone", inside);
      gone.questionIds.push(q.id);
      bank.folders.root = [...before, gone, ...after];
      bank.rebuildIndex();
      const expected = numberedBefore([...before, ...after].map((f) => f.name), inside.map((f) => f.name));
      bank.removeFolder(gone.id);
      assert.deepEqual(bank.folders.root.map((f) => f.name), [...before.map((f) => f.name), ...expected, ...after.map((f) => f.name)]);
      assert.equal(bank.questions.size, 1, "the question stays");
      assert.equal(bank.folderIdOf(q.id), undefined, "in no folder");
    }
  });

  test("a bank with 130,000 children in one folder can have it taken away (a spread of that many into splice throws)", () => {
    const run = inEngine<{ ms: number; count: number; last: string }>(
      `const { Bank } = await engine("bank/store.ts");
const bank = Bank.createEmpty("t");
bank.folders.root = [{ id: "fp", name: "parent", questionIds: [], children: Array.from({ length: 130000 }, (_, i) => ({ id: "c" + i, name: "n" + i, questionIds: [], children: [] })) }, { id: "after", name: "after", questionIds: [], children: [] }];
const started = performance.now();
bank.removeFolder("fp");
report({ ms: performance.now() - started, count: bank.folders.root.length, last: bank.folders.root[bank.folders.root.length - 1].name });`,
    );
    const done = finished(run);
    assert.equal(done.count, 130_001);
    assert.equal(done.last, "after", "what was after the folder is still after it");
    assert.ok(done.ms < 3000, `${Math.round(done.ms)} ms`);
  });
});

describe("filing many questions at once", () => {
  test("30,000 questions go into a folder, into another, and out of both, in milliseconds", () => {
    // Each was taken out of every folder on its own, which walked the whole tree for each: 20,000 took 5 seconds.
    const run = inEngine<{ ms: number; first: unknown; second: unknown; third: unknown; inA: number; inB: number; filed: number }>(
      `const { Bank } = await engine("bank/store.ts");
const { createQuestion } = await engine("model/create.ts");
const bank = Bank.createEmpty("t");
const ids = [];
for (let i = 0; i < 30000; i++) ids.push(bank.add(createQuestion({ type: "essay", stem: "Essay number " + i, body: {} })).id);
const a = bank.addFolder("A");
const b = bank.addFolder("B");
const started = performance.now();
const first = bank.moveManyToFolder(ids, a.id);
const inA = a.questionIds.length;
const second = bank.moveManyToFolder(ids, b.id);
const inB = b.questionIds.length;
const third = bank.moveManyToFolder(ids, undefined);
const ms = performance.now() - started;
report({ ms, first, second, third, inA, inB, filed: a.questionIds.length + b.questionIds.length });`,
    );
    const done = finished(run);
    assert.ok(done.ms < 1000, `${Math.round(done.ms)} ms`);
    assert.deepEqual(done.first, { filed: 30_000, alreadyThere: 0 });
    assert.deepEqual(done.second, { filed: 30_000, alreadyThere: 0 });
    assert.deepEqual(done.third, { filed: 30_000, alreadyThere: 0 });
    assert.deepEqual([done.inA, done.inB, done.filed], [30_000, 30_000, 0], "they left each folder they were in");
  });

  test("files exactly as filing them one at a time does, damaged lists included", () => {
    const next = seeded(99);
    const questions = Array.from({ length: 12 }, (_, i) => createQuestion({ type: "essay", stem: plainToRich(`Question ${i}`), body: {}, at: AT, by: "test" }));
    const ids = questions.map((q) => q.id);
    for (let run = 0; run < 150; run++) {
      const first = Bank.createEmpty("t", { at: AT });
      for (const q of questions) first.add(q);
      const folders = ["A", "B", "C"].map((name) => first.addFolder(name).id);
      folders.push(first.addFolder("Inner", folders[0]).id);
      // Random filing, and damage: a question listed in a second folder, and one the bank does not hold.
      const damage = seeded(1000 + run);
      for (const id of ids) if (damage(3) === 0) first.moveToFolder(id, folders[damage(folders.length)] as string);
      for (let d = 0; d < 3; d++) first.allFolders()[damage(first.allFolders().length)]?.questionIds.push(ids[damage(ids.length)] as string);
      first.allFolders()[0]?.questionIds.push("q_not_in_this_bank");
      first.rebuildIndex();
      // The second is the first, folder for folder.
      const second = Bank.createEmpty("t", { at: AT });
      for (const q of questions) second.add(q);
      second.folders.root = JSON.parse(JSON.stringify(first.folders.root)) as FolderNode[];
      second.rebuildIndex();

      const chosen = ids.filter(() => next(2) === 0);
      const target = next(5) === 0 ? undefined : (folders[next(folders.length)] as string);
      const together = first.moveManyToFolder(chosen, target);
      // The one-at-a-time way, which is how it was worked out before.
      let filed = 0;
      let alreadyThere = 0;
      for (const id of new Set(chosen)) {
        if (second.folderIdOf(id) === target) {
          alreadyThere++;
          continue;
        }
        if (target === undefined) second.unfile(id);
        else second.moveToFolder(id, target);
        filed++;
      }
      assert.deepEqual(together, { filed, alreadyThere });
      assert.equal(JSON.stringify(first.folders.root), JSON.stringify(second.folders.root));
      assert.deepEqual(ids.map((id) => first.folderIdOf(id)), ids.map((id) => second.folderIdOf(id)));
    }
  });
});

// ---------------------------------------------------------------------------
// Questions that are alike
// ---------------------------------------------------------------------------

/** A bank made of clusters of questions with the same words, with copies, near copies, parallels, conflicts, and every other kind of question. */
function generated(seed: number, size: number): Question[] {
  const next = seeded(seed);
  const vocabulary = Array.from({ length: 140 }, (_, i) => `${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}tem${String.fromCharCode(97 + ((i * 7) % 26))}`);
  const clusters = Array.from({ length: Math.max(4, Math.floor(size / 15)) }, () => Array.from({ length: 9 + next(5) }, () => vocabulary[next(vocabulary.length)] as string));
  const out: Question[] = [];
  const stemOf = (cluster: string[]): string => {
    const take = 6 + next(6);
    const words: string[] = [];
    for (let i = 0; i < take; i++) words.push(cluster[next(cluster.length)] as string);
    return `${words.join(" ")}${next(8) === 0 ? ` ${2 + next(3)} items` : ""}?`;
  };
  const optionsOf = (cluster: string[]): string[] => Array.from({ length: 2 + next(3) }, () => `${cluster[next(cluster.length)]} ${cluster[next(cluster.length)]}`);
  while (out.length < size) {
    const cluster = clusters[next(clusters.length)] as string[];
    const kind = next(100);
    const options = optionsOf(cluster);
    const stem = stemOf(cluster);
    const make = (): Question => {
      if (kind < 62) return createQuestion({ type: "multipleChoice", stem: plainToRich(stem), body: { shuffle: true, options: options.map((t, i) => ({ id: `o${i}`, content: plainToRich(t), correct: i === next(options.length) })) } as never });
      if (kind < 72) return createQuestion({ type: "essay", stem: plainToRich(stem), body: {} });
      if (kind < 78) return createQuestion({ type: "trueFalse", stem: plainToRich(stem), body: { correct: next(2) === 0 } });
      if (kind < 84) return createQuestion({ type: "shortAnswer", stem: plainToRich(stem), body: { caseSensitive: false, accepted: options.slice(0, 1 + next(2)) } });
      if (kind < 89) return createQuestion({ type: "matching", stem: plainToRich(stem), body: { shuffle: true, distractors: [], pairs: options.map((t, i) => ({ id: `p${i}`, left: plainToRich(t), right: `${cluster[next(cluster.length)]}` })) } as never });
      if (kind < 93) return createQuestion({ type: "ordering", stem: plainToRich(stem), body: { items: options.map((t, i) => ({ id: `i${i}`, content: plainToRich(t), position: i + 1 })) } as never });
      if (kind < 96) return createQuestion({ type: "numeric", stem: plainToRich(stem), body: { mode: "exact", value: next(3) } });
      if (kind < 98) return createQuestion({ type: "multipleChoice", stem: rich(`<p>${stem} <oa-math ref="e1"></oa-math> now</p>`), body: { shuffle: true, options: options.map((t, i) => ({ id: `o${i}`, content: plainToRich(t), correct: i === 0 })) } as never, math: [{ id: "e1", latex: `x^${next(3)}`, mathml: "<math/>" }] });
      return createQuestion({ type: "multipleChoice", stem: plainToRich(stem), body: { shuffle: true, options: options.map((t, i) => ({ id: `o${i}`, content: plainToRich(t), correct: i === 0 })) } as never, metadata: { tags: [], status: "retired" } });
    };
    // Each question is made as often as the dice say, so that exact copies are as common as near ones.
    const copies = 1 + (next(4) === 0 ? next(3) : 0);
    for (let c = 0; c < copies && out.length < size; c++) out.push(make());
  }
  return out;
}

const shown = (groups: ReadonlyArray<{ kind: string; code: string; questionIds: string[]; titles: string[]; message: string }>): string =>
  JSON.stringify(groups.map((g) => [g.kind, g.code, g.questionIds, g.titles, g.message]));

describe("finding questions that are very much alike", () => {
  test("finds the groups the old finder found, on banks with every kind of question in them", () => {
    let alike = 0;
    let same = 0;
    for (const [seed, size] of [[1, 250], [2, 400], [3, 700], [4, 1000], [5, 1200], [6, 300], [7, 800], [8, 500]] as const) {
      const questions = generated(seed, size);
      const before = findDuplicatesBefore(questions);
      const found = quality.searchDuplicates(questions);
      assert.equal(shown(found.groups), shown(before), `seed ${seed}, ${size} questions`);
      assert.equal(shown(quality.findDuplicates(questions)), shown(before));
      assert.deepEqual(found.limits, [], "nothing near the limit was held back");
      for (const g of before) {
        if (g.kind === "alike") alike++;
        else same++;
      }
    }
    assert.ok(alike >= 20 && same >= 20, `the banks must hold both kinds of group to say anything (${alike} alike, ${same} same)`);
  });

  test("a search held back by a small limit says so whenever it found anything less than the full search", () => {
    let limited = 0;
    let differed = 0;
    for (const [seed, size, limit] of [[11, 300, 6], [12, 300, 20], [13, 500, 40], [14, 500, 3], [15, 800, 100], [16, 200, 12], [17, 400, 60], [18, 600, 8]] as const) {
      const questions = generated(seed, size);
      const full = quality.searchDuplicates(questions);
      const held = quality.searchDuplicates(questions, limit);
      const same = shown(held.groups) === shown(full.groups);
      if (!same) differed++;
      if (held.limits.length > 0) limited++;
      assert.ok(same || held.limits.length > 0, `seed ${seed}: the groups differ from the full search and nothing says so`);
      for (const note of held.limits) {
        assert.equal(note.severity, "info");
        assert.equal(note.check, "alike");
        assert.match(note.message, new RegExp(`than the ${limit} looks a question is given`));
        assert.match(note.message, /Questions that are the same, word for word and answer for answer, were all found\./);
      }
      // The questions that are the same word for word are found by their own check, whatever the limit.
      assert.equal(shown(held.groups.filter((g) => g.kind === "same")) === shown(full.groups.filter((g) => g.kind === "same")) || held.limits.length > 0, true);
    }
    assert.ok(limited >= 4, "the limits were small enough to be reached on most of the banks");
    assert.ok(differed >= 1, "and on at least one the groups really were fewer");
  });

  test("says how many questions were held back, in the words of the other notes", () => {
    const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
    const questions = Array.from({ length: 12 }, (_, i) => createQuestion({ type: "essay", stem: plainToRich(`${[...words.slice(i % 8), ...words.slice(0, i % 8)].join(" ")}?`), body: {} }));
    const held = quality.searchDuplicates(questions, 2);
    assert.equal(held.limits.length, 1);
    assert.match(held.limits[0]?.message ?? "", /^The search for questions that are very much alike was cut short for \d+ questions: each has more questions with words in common than the 2 looks a question is given, so up to \d+ comparisons were not made, and a question very much alike to one of them may not be listed\./);
    assert.deepEqual(quality.searchDuplicates(questions).limits, []);
    const one = quality.searchDuplicates(questions.slice(0, 2), 1);
    assert.match(one.limits[0]?.message ?? "", /^The search for questions that are very much alike was cut short for 1 question: it has more questions with words in common than the 1 looks a question is given, so up to 1 comparison was not made, and a question very much alike to it may not be listed\./);
  });

  test("a question is stopped at its limit and not a look after it, and what it did not get to is counted", () => {
    // Four questions that share a word but are plainly different (the stem and the right answer both differ), so that each look at
    // another is one look and no more. The fourth finds three others under "alpha": with a limit of 2 it looks at two, and stops.
    const pool = ["alpha", "beta", "gamma", "delta"];
    const four = pool.map((right, i) =>
      createQuestion({
        type: "multipleChoice",
        stem: plainToRich(`alpha beta gamma delta epsilon zeta qx${String.fromCharCode(97 + i)}?`),
        body: { shuffle: true, options: [{ id: "o0", content: plainToRich(right), correct: true }, { id: "o1", content: plainToRich("x"), correct: false }] } as never,
      }),
    );
    assert.deepEqual(quality.searchDuplicates(four, 3).limits, [], "three looks are enough for three");
    const held = quality.searchDuplicates(four, 2);
    assert.equal(held.limits.length, 1);
    assert.match(held.limits[0]?.message ?? "", /^The search for questions that are very much alike was cut short for 1 question: it has more questions with words in common than the 2 looks a question is given, so up to 1 comparison was not made, and a question very much alike to it may not be listed\./);
    assert.deepEqual(held.groups, [], "and these are not alike");
  });

  test("the words counted between two questions are looks too, so questions with long stems are held back sooner", () => {
    // Twenty questions of sixty words each that share fifty-four of them and the right answer: each is a candidate of the others
    // (they share their rarest-but-one words) and is not alike to any (54 of 66 is under 85 percent), so each is counted word by word.
    const letters = (n: number): string => `${String.fromCharCode(97 + (n % 26))}${String.fromCharCode(97 + (Math.floor(n / 26) % 26))}`;
    const shared = Array.from({ length: 54 }, (_, i) => `sh${letters(i)}`);
    const long = Array.from({ length: 20 }, (_, q) =>
      createQuestion({
        type: "multipleChoice",
        stem: plainToRich(`${shared.join(" ")} ${Array.from({ length: 6 }, (_x, u) => `un${letters(q)}${letters(u)}`).join(" ")}?`),
        body: { shuffle: true, options: [{ id: "o0", content: plainToRich("yes"), correct: true }, { id: "o1", content: plainToRich("no"), correct: false }] } as never,
      }),
    );
    const full = quality.searchDuplicates(long);
    assert.deepEqual(full.groups, [], "none of them is alike to another");
    assert.deepEqual(full.limits, [], "and the whole of the work is done at the usual limit");
    const held = quality.searchDuplicates(long, 100);
    assert.equal(held.limits.length, 1, "while a limit of 100 is reached by counting the words of two questions");
  });

  test("questions already in one group are not compared with the next that joins it, so a group of thousands holds nothing back", () => {
    // 3,000 orderings of eight words: each is alike to all before it. Compared with every one of them, one question would use up
    // the limit (about ten looks for each comparison); joined to the group at its first, it needs about two looks for each.
    const EIGHT = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
    const ordering = (k: number): string[] => {
      const pool = [...EIGHT];
      const out: string[] = [];
      let f = 40320;
      for (let i = 8; i > 0; i--) {
        f /= i;
        out.push(pool.splice(Math.floor(k / f) % i, 1)[0] as string);
        k %= f;
      }
      return out;
    };
    const questions = Array.from({ length: 3000 }, (_, i) =>
      createQuestion({ type: "multipleChoice", stem: plainToRich(`${ordering(i).join(" ")}?`), body: { shuffle: true, options: [{ id: "o0", content: plainToRich("x"), correct: true }, { id: "o1", content: plainToRich("y"), correct: false }] } as never }),
    );
    const found = quality.searchDuplicates(questions);
    assert.deepEqual(found.groups.map((g) => [g.kind, g.questionIds.length]), [["alike", 3000]]);
    assert.deepEqual(found.limits, []);
    assert.equal(shown(found.groups), shown(findDuplicatesBefore(questions)), "and it is the group the old finder found");
  });

  test("the report of a whole bank carries the note beside the copies", () => {
    const questions = generated(21, 120);
    const report = quality.checkBankQuality(questions);
    assert.deepEqual(report.limits, []);
    assert.equal(shown(report.duplicates), shown(findDuplicatesBefore(questions)));
  });

  test("12,000 questions with the same eight words in different orders are searched in seconds and a small heap", () => {
    // 10,000 of them were 50 million pairs kept in a list, and a heap of 1 GB was not enough.
    const run = inEngine<{ ms: number; peak: number; groups: Array<[string, number]> }>(
      `${MAKE_CHOICE}${MAKE_PERMUTATIONS}
const { findDuplicates } = await engine("quality/bank.ts");
const questions = Array.from({ length: 12000 }, (_, i) => choice(perm(i).join(" ") + "?", ["x", "y"]));
const started = performance.now();
const groups = findDuplicates(questions);
report({ ms: performance.now() - started, peak: peakMb(), groups: groups.map((g) => [g.kind, g.questionIds.length]) });`,
      { heapMb: 400 },
    );
    const done = finished(run);
    assert.deepEqual(done.groups, [["alike", 12_000]], "they are one group, and every one of them is in it");
    assert.ok(done.ms < 8000, `${Math.round(done.ms)} ms`);
    assert.ok(done.peak < 500, `${done.peak} MB`);
  });

  test("so are 30,000, and the search says that it did not look at everything", () => {
    const run = inEngine<{ ms: number; peak: number; groups: Array<[string, number]>; limits: number; message: string }>(
      `${MAKE_CHOICE}${MAKE_PERMUTATIONS}
const { searchDuplicates } = await engine("quality/bank.ts");
const questions = Array.from({ length: 30000 }, (_, i) => choice(perm(i).join(" ") + "?", ["x", "y"]));
const started = performance.now();
const found = searchDuplicates(questions);
report({ ms: performance.now() - started, peak: peakMb(), groups: found.groups.map((g) => [g.kind, g.questionIds.length]), limits: found.limits.length, message: found.limits[0] ? found.limits[0].message : "" });`,
      { heapMb: 600 },
    );
    const done = finished(run);
    assert.deepEqual(done.groups, [["alike", 30_000]]);
    assert.equal(done.limits, 1, "each of the questions has more than 20,000 to look through");
    assert.match(done.message, /than the 20000 looks a question is given/);
    assert.ok(done.ms < 15_000, `${Math.round(done.ms)} ms`);
  });

  test("50,000 questions that are the same are found in a second, not in seconds of copying lists", () => {
    const run = inEngine<{ ms: number; groups: Array<[string, number]> }>(
      `const { createQuestion } = await engine("model/create.ts");
const { findDuplicates } = await engine("quality/bank.ts");
const questions = Array.from({ length: 50000 }, () => createQuestion({ type: "trueFalse", stem: "The Moon is made of cheese.", body: { correct: false } }));
const started = performance.now();
const groups = findDuplicates(questions);
report({ ms: performance.now() - started, groups: groups.map((g) => [g.kind, g.questionIds.length]) });`,
    );
    const done = finished(run);
    assert.deepEqual(done.groups, [["same", 50_000]]);
    assert.ok(done.ms < 2000, `${Math.round(done.ms)} ms`);
  });

  test("a question with 8,000 equations and 8,000 options is read in milliseconds (its table of equations was made for each option)", () => {
    const run = inEngine<{ ms: number; groups: number }>(
      `const { createQuestion } = await engine("model/create.ts");
const { findDuplicates } = await engine("quality/bank.ts");
const math = Array.from({ length: 8000 }, (_, i) => ({ id: "e" + i, latex: "x^" + i, mathml: "<math/>" }));
const options = Array.from({ length: 8000 }, (_, i) => ({ id: "o" + i, content: { format: "rich", content: '<p><oa-math ref="e' + i + '"></oa-math></p>' }, correct: i === 0 }));
const q = createQuestion({ type: "multipleChoice", stem: { format: "rich", content: '<p>Pick <oa-math ref="e0"></oa-math> for the unknown value please now.</p>' }, body: { shuffle: true, options }, math });
const started = performance.now();
const groups = findDuplicates([q, q]);
report({ ms: performance.now() - started, groups: groups.length });`,
    );
    const done = finished(run);
    assert.equal(done.groups, 1);
    assert.ok(done.ms < 1500, `${Math.round(done.ms)} ms`);
  });

  test("a question's equations still count as the words they are written as", () => {
    const withMath = (latex: string): Question => createQuestion({ type: "essay", stem: rich('<p>Solve <oa-math ref="e1"></oa-math> for the unknown value please.</p>'), body: {}, math: [{ id: "e1", latex, mathml: "<math/>" }] });
    assert.equal(quality.findDuplicates([withMath("x+1"), withMath("x+1")]).length, 1);
    assert.deepEqual(quality.findDuplicates([withMath("x+1"), withMath("x+2")]), []);
  });
});

describe("drawing a blueprint", () => {
  test("finds the copies in the bank once, and takes what drawing each rule on its own took", () => {
    const next = seeded(5);
    const questions = generated(31, 500).map((q, i) =>
      createQuestion({ type: "multipleChoice", stem: q.stem, body: { shuffle: true, options: [{ id: "o0", content: plainToRich("x"), correct: true }, { id: "o1", content: plainToRich("y"), correct: false }] } as never, metadata: { tags: [`t${i % 5}`], status: "draft" }, at: AT, by: "t" }),
    );
    const plan = newBlueprint({ name: "plan", rules: Array.from({ length: 12 }, () => ({ axis: "tag", value: `t${next(5)}`, count: 1 + next(6) })) }, AT, "bp_test");
    const drawn = drawBlueprint(questions, plan, { seed: "s" });
    // Every rule in turn with the copies found for it each time, which is how it was drawn before.
    const ids: string[] = [];
    const picks = plan.rules.map((rule) => {
      const pick = pickQuestions(questions, { axis: rule.axis, value: rule.value, count: rule.count, chosen: ids, seed: `s:blueprint:${plan.id}:${rule.axis}:${rule.value}` });
      ids.push(...pick.ids);
      return pick;
    });
    assert.deepEqual(drawn.ids, ids);
    assert.deepEqual(drawn.rules.map((r) => r.pick), picks);
    assert.ok(ids.length > 10, "the draw took questions");
  });

  test("50 rules over 8,000 questions alike to each other search the bank once", () => {
    // The bank was searched for each rule: 50 searches, and 50 times the memory of one.
    const run = inEngine<{ ms: number; taken: number; short: number }>(
      `${MAKE_CHOICE}${MAKE_PERMUTATIONS}
const { drawBlueprint, newBlueprint } = await engine("bank/blueprint.ts");
const questions = Array.from({ length: 8000 }, (_, i) => choice(perm(i).join(" ") + "?", ["x", "y"]));
const plan = newBlueprint({ name: "plan", rules: Array.from({ length: 50 }, () => ({ axis: "type", value: "multipleChoice", count: 1 })) });
const started = performance.now();
const draw = drawBlueprint(questions, plan, { seed: "s" });
report({ ms: performance.now() - started, taken: draw.ids.length, short: draw.short });`,
    );
    const done = finished(run);
    assert.equal(done.taken, 1, "all of them are one question asked 8,000 times, so one is taken");
    assert.equal(done.short, 49);
    assert.ok(done.ms < 3500, `${Math.round(done.ms)} ms`);
  });
});

// ---------------------------------------------------------------------------
// A question with a great many options
// ---------------------------------------------------------------------------

describe("a question with a great many options that read the same", () => {
  test("80,000 identical options are checked in a second or two when the question is saved", () => {
    // The list of places for the signature was copied for each option: 40,000 took 5 seconds on every save.
    const run = inEngine<{ ms: number; codes: string[] }>(
      `${MAKE_CHOICE}
const { Bank } = await engine("bank/store.ts");
const q = choice("What is it?", Array.from({ length: 80000 }, () => "same"));
const bank = Bank.createEmpty("t");
const started = performance.now();
const saved = bank.add(q);
report({ ms: performance.now() - started, codes: saved.findings.map((f) => f.code) });`,
    );
    const done = finished(run);
    assert.ok(done.codes.includes("quality.duplicate-option"), done.codes.join(", "));
    assert.ok(done.ms < 4000, `${Math.round(done.ms)} ms`);
  });
});
