/**
 * Picking questions for a test (`bank/pick.ts`): some of the questions that have a value, at random from a seed.
 *
 * What is held here is what it will not pick (a retired question, one already chosen, one with no usable key, one that is a copy of
 * another), that it says what it left out and why, that the same seed gives the same questions and another gives others, and that
 * a question is never picked for a value it does not have.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { NONE } from "../src/bank/coverage.ts";
import { MOST_PICKED, pickQuestions } from "../src/bank/pick.ts";
import { createQuestion } from "../src/model/create.ts";
import { FindingCode, finding } from "../src/model/findings.ts";
import type { Metadata, Question } from "../src/model/question.ts";
import { plainToRich } from "../src/model/richtext.ts";

let n = 0;
/** A multiple choice question about a made-up topic, with its own words so that no two are alike. */
function mc(meta: Partial<Metadata> = {}, stem?: string): Question {
  n++;
  return createQuestion({
    type: "multipleChoice",
    stem: plainToRich(stem ?? `What is the capital of country number ${n} in the region called land${n}?`),
    body: { shuffle: true, options: [`Alpha${n}`, `Beta${n}`, `Gamma${n}`].map((t, i) => ({ id: `o${i}`, content: plainToRich(t), correct: i === 0 })) } as never,
    metadata: { tags: [], status: "draft", ...meta },
  });
}

const chapter = (c: string, count: number): Question[] => Array.from({ length: count }, () => mc({ chapter: c }));

describe("picking", () => {
  const bank = [...chapter("1", 12), ...chapter("2", 12)];

  test("picks the number asked for, from the value asked for, and only from it", () => {
    const picked = pickQuestions(bank, { axis: "chapter", value: "1", count: 5 });
    assert.equal(picked.ids.length, 5);
    assert.equal(new Set(picked.ids).size, 5, "none twice");
    const byId = new Map(bank.map((q) => [q.id, q] as const));
    for (const id of picked.ids) assert.equal(byId.get(id)?.metadata.chapter, "1");
    assert.equal(picked.wanted, 5);
    assert.equal(picked.candidates, 12);
    assert.deepEqual(picked.left, { retired: 0, chosen: 0, noKey: 0, alike: 0 });
  });

  test("the same seed picks the same questions, in the same order, and another seed picks others", () => {
    const a = pickQuestions(bank, { axis: "chapter", value: "1", count: 5, seed: "one" });
    const again = pickQuestions([...bank].reverse(), { axis: "chapter", value: "1", count: 5, seed: "one" });
    assert.deepEqual(again.ids, a.ids, "whatever order the bank is held in");
    const others = new Set<string>();
    for (const seed of ["two", "three", "four", "five", "six"]) for (const id of pickQuestions(bank, { axis: "chapter", value: "1", count: 5, seed }).ids) others.add(id);
    assert.ok(others.size > 5, "different seeds reach different questions");
    assert.notDeepEqual(pickQuestions(bank, { axis: "chapter", value: "1", count: 5, seed: "two" }).ids, a.ids);
  });

  test("the choice is not the same for two values that happen to be asked for with the same seed", () => {
    const one = pickQuestions(bank, { axis: "chapter", value: "1", count: 12, seed: "x" }).ids;
    const two = pickQuestions(bank, { axis: "chapter", value: "2", count: 12, seed: "x" }).ids;
    assert.equal(new Set([...one, ...two]).size, 24);
  });

  test("asks for more than there are, and gets all there are, saying how many were wanted", () => {
    const picked = pickQuestions(bank, { axis: "chapter", value: "2", count: 50 });
    assert.equal(picked.ids.length, 12);
    assert.equal(picked.wanted, 50);
    assert.equal(picked.candidates, 12);
  });

  test("a value nothing has picks nothing", () => {
    assert.deepEqual(pickQuestions(bank, { axis: "chapter", value: "9", count: 3 }).ids, []);
    assert.deepEqual(pickQuestions([], { axis: "chapter", value: "1", count: 3 }), { ids: [], wanted: 3, candidates: 0, left: { retired: 0, chosen: 0, noKey: 0, alike: 0 } });
  });

  test("picks by any axis: a tag among several, none, Bloom level", () => {
    const tagged = [mc({ tags: ["a", "b"] }), mc({ tags: ["b"] }), mc({ tags: [] }), mc({ bloom: "apply" })];
    assert.deepEqual(pickQuestions(tagged, { axis: "tag", value: "a", count: 9 }).ids, [tagged[0]?.id]);
    assert.equal(pickQuestions(tagged, { axis: "tag", value: "b", count: 9 }).ids.length, 2);
    assert.equal(pickQuestions(tagged, { axis: "tag", value: NONE, count: 9 }).ids.length, 2, "the two with no tag");
    assert.deepEqual(pickQuestions(tagged, { axis: "bloom", value: "apply", count: 9 }).ids, [tagged[3]?.id]);
    assert.equal(pickQuestions(tagged, { axis: "bloom", value: NONE, count: 9 }).ids.length, 3);
  });

  test("a question with no value is not picked for one it does not have", () => {
    const mixed = [mc({ chapter: "1" }), mc({}), mc({ chapter: "  " })];
    assert.equal(pickQuestions(mixed, { axis: "chapter", value: "1", count: 9 }).ids.length, 1);
    assert.equal(pickQuestions(mixed, { axis: "chapter", value: NONE, count: 9 }).ids.length, 2);
  });
});

describe("what it will not pick", () => {
  test("a retired question, said", () => {
    const qs = [mc({ chapter: "1" }), mc({ chapter: "1", status: "retired" }), mc({ chapter: "1", status: "retired" })];
    const picked = pickQuestions(qs, { axis: "chapter", value: "1", count: 9 });
    assert.deepEqual(picked.ids, [qs[0]?.id]);
    assert.deepEqual(picked.left, { retired: 2, chosen: 0, noKey: 0, alike: 0 });
    assert.equal(picked.candidates, 1);
  });

  test("a question already chosen, said", () => {
    const qs = chapter("1", 6);
    const chosen = qs.slice(0, 4).map((q) => q.id);
    const picked = pickQuestions(qs, { axis: "chapter", value: "1", count: 9, chosen });
    assert.deepEqual([...picked.ids].sort(), qs.slice(4).map((q) => q.id).sort());
    assert.equal(picked.left.chosen, 4);
    // Ids it is told about that are not in the bank, or have another value, change nothing.
    assert.equal(pickQuestions(qs, { axis: "chapter", value: "1", count: 9, chosen: ["no-such-id"] }).ids.length, 6);
  });

  test("a question with no usable key, said, however it came to have none", () => {
    const none = createQuestion({ type: "multipleChoice", stem: plainToRich("An unkeyed question about nothing in particular here?"), body: { shuffle: true, options: ["One", "Two"].map((t, i) => ({ id: `o${i}`, content: plainToRich(t), correct: false })) } as never, metadata: { tags: [], status: "draft", chapter: "1" } });
    const doubtful = { ...mc({ chapter: "1" }), findings: [finding(FindingCode.KeyLetterMissing, "error", "The key names an option the question does not have.")] };
    const fine = mc({ chapter: "1" });
    const picked = pickQuestions([none, doubtful, fine], { axis: "chapter", value: "1", count: 9 });
    assert.deepEqual(picked.ids, [fine.id]);
    assert.equal(picked.left.noKey, 2);
    assert.equal(picked.candidates, 1);
  });

  test("an essay is a question a person grades, and is picked", () => {
    const essay = createQuestion({ type: "essay", stem: plainToRich("Discuss the causes of the war at length."), body: {}, metadata: { tags: [], status: "draft", chapter: "1" } });
    assert.deepEqual(pickQuestions([essay], { axis: "chapter", value: "1", count: 1 }).ids, [essay.id]);
  });

  test("a copy of a question already chosen, said", () => {
    const stem = "What is the capital of France today as the maps are drawn now?";
    const a = mc({ chapter: "1" }, stem);
    const copy = createQuestion({ ...{ type: "multipleChoice" as const, stem: plainToRich(stem), body: a.body, metadata: { tags: [], status: "draft" as const, chapter: "1" } } });
    const other = mc({ chapter: "1" });
    const picked = pickQuestions([a, copy, other], { axis: "chapter", value: "1", count: 9, chosen: [a.id] });
    assert.deepEqual(picked.ids, [other.id]);
    assert.equal(picked.left.chosen, 1);
    assert.equal(picked.left.alike, 1);
  });

  test("two copies of each other are not both picked, whichever comes first", () => {
    const stem = "What is the capital of Spain today as the maps are drawn now?";
    const make = () => createQuestion({ type: "multipleChoice", stem: plainToRich(stem), body: { shuffle: true, options: ["Madrid", "Paris"].map((t, i) => ({ id: `o${i}`, content: plainToRich(t), correct: i === 0 })) } as never, metadata: { tags: [], status: "draft", chapter: "1" } });
    const qs = [make(), make(), make(), mc({ chapter: "1" })];
    for (const seed of ["a", "b", "c", "d", "e", "f"]) {
      const picked = pickQuestions(qs, { axis: "chapter", value: "1", count: 9, seed });
      assert.equal(picked.ids.length, 2, `seed ${seed}: one of the three copies and the other question`);
      assert.equal(picked.left.alike, 2);
    }
  });

  test("a copy that is not in this value is no reason to leave a question out", () => {
    const stem = "What is the capital of Italy today as the maps are drawn now?";
    const make = (c: string) => createQuestion({ type: "multipleChoice", stem: plainToRich(stem), body: { shuffle: true, options: ["Rome", "Paris"].map((t, i) => ({ id: `o${i}`, content: plainToRich(t), correct: i === 0 })) } as never, metadata: { tags: [], status: "draft", chapter: c } });
    const inOne = make("1");
    const inTwo = make("2");
    assert.deepEqual(pickQuestions([inOne, inTwo], { axis: "chapter", value: "1", count: 9 }).ids, [inOne.id], "not chosen, so nothing to be a copy of");
    assert.deepEqual(pickQuestions([inOne, inTwo], { axis: "chapter", value: "1", count: 9, chosen: [inTwo.id] }).ids, [], "chosen, so it is");
  });
});

describe("how many", () => {
  test("is a whole number from 1 to the most", () => {
    for (const count of [0, -1, 1.5, Number.NaN, MOST_PICKED + 1]) {
      assert.throws(() => pickQuestions([], { axis: "chapter", value: "1", count }), /whole number from 1 to 1000/, String(count));
    }
    assert.doesNotThrow(() => pickQuestions([], { axis: "chapter", value: "1", count: 1 }));
    assert.doesNotThrow(() => pickQuestions([], { axis: "chapter", value: "1", count: MOST_PICKED }));
  });

  test("does not change the questions it is given", () => {
    const qs = chapter("1", 8);
    const before = JSON.stringify(qs);
    pickQuestions(qs, { axis: "chapter", value: "1", count: 3, seed: "s" });
    assert.equal(JSON.stringify(qs), before);
  });
});
