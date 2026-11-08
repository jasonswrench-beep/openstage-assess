/**
 * Choosing a question in a long list.
 *
 * Choosing a question used to draw the whole list again. For a bank of 5000 questions (40,000 elements, measured in the built-in
 * browser on 7 November 2026) that took 0.5 to 0.9 seconds for every question looked at, and the row a keyboard user had chosen was
 * thrown away with the rest, so focus was lost. `markSelected` changes the rows that are there and only the ones that need it. This holds
 * that, with a stand-in for the page's document; the time and the focus were measured in the browser, which this cannot do.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// @ts-expect-error the interface is plain JavaScript, checked as such, and has no declaration file
import { h } from "../ui/dom.js";
// @ts-expect-error the interface is plain JavaScript, checked as such, and has no declaration file
import { fillRows, markSelected, questionRow } from "../ui/list.js";
import { type FakeNode, installFakeDocument } from "./support/fake-dom.ts";

installFakeDocument();

const summary = (n: number) => ({ id: `q${n}`, title: `Question ${n}`, type: "multipleChoice", snippet: `Question ${n}`, verdict: "parsed" as const });
const listOf = (keys: Array<string | number>, selected: string | number | null = null): FakeNode => {
  const list = h("ul", { class: "qlist" });
  keys.forEach((key, i) => list.append(questionRow({ number: i + 1, key, summary: summary(i + 1), selected: key === selected, onSelect: () => undefined })));
  return list;
};
const rows = (list: FakeNode): FakeNode[] => list.querySelectorAll("button.qrow");
const current = (list: FakeNode): Array<string | undefined> => rows(list).filter((r) => r.getAttribute("aria-current") === "true").map((r) => r.dataset["key"]);

describe("markSelected", () => {
  test("marks the chosen row and no other, for keys that are ids and for keys that are numbers", () => {
    const byId = listOf(["q_a", "q_b", "q_c"], "q_a");
    assert.deepEqual(current(byId), ["q_a"]);
    markSelected(byId, "q_c");
    assert.deepEqual(current(byId), ["q_c"]);
    const byNumber = listOf([0, 1, 2, 3], 0);
    markSelected(byNumber, 2);
    assert.deepEqual(current(byNumber), ["2"], "the number 0 is a key like any other, and 2 is not 20");
    markSelected(byNumber, 0);
    assert.deepEqual(current(byNumber), ["0"], "a key of 0 is chosen, not taken for none");
  });

  test("null chooses none, and a key no row has chooses none", () => {
    const list = listOf(["a", "b"], "a");
    markSelected(list, null);
    assert.deepEqual(current(list), []);
    markSelected(list, "b");
    markSelected(list, "zzz");
    assert.deepEqual(current(list), []);
  });

  test("writes only the two rows that change, however long the list", () => {
    const list = listOf(Array.from({ length: 2000 }, (_, i) => i), 5);
    const before = rows(list).reduce((n, r) => n + r.writes, 0);
    markSelected(list, 1500);
    const written = rows(list).reduce((n, r) => n + r.writes, 0) - before;
    assert.equal(written, 2, "the row that was chosen and the row that is");
    assert.deepEqual(current(list), ["1500"]);
    markSelected(list, 1500);
    assert.equal(rows(list).reduce((n, r) => n + r.writes, 0) - before, 2, "choosing the same row again changes nothing");
  });

  test("a row keeps its own element, so the one a person is on is not thrown away", () => {
    const list = listOf(["a", "b", "c"], "a");
    const [first, second] = rows(list);
    markSelected(list, "b");
    assert.equal(rows(list)[0], first);
    assert.equal(rows(list)[1], second);
  });
});

describe("fillRows", () => {
  const items = (n: number) => Array.from({ length: n }, (_, i) => ({ key: i }));
  const row = (item: { key: number }, at: number) => questionRow({ number: at + 1, key: item.key, summary: summary(item.key), selected: false, onSelect: () => undefined });
  const moreLine = (list: FakeNode): FakeNode | undefined => list.children.find((c) => c.className === "more-rows");
  const buttonsOf = (line: FakeNode): FakeNode[] => line.querySelectorAll("button");

  test("draws every row and no line about more when there are no more than the limit", () => {
    const list = h("ul", {});
    assert.equal(fillRows(list, items(30), row, { limit: 1000, more: () => undefined }), 30);
    assert.equal(rows(list).length, 30);
    assert.equal(moreLine(list), undefined);
    const exact = h("ul", {});
    fillRows(exact, items(1000), row, { limit: 1000, more: () => undefined });
    assert.equal(moreLine(exact), undefined, "exactly the limit is not 'more'");
  });

  test("draws the limit and says how many are not drawn, with the way to draw them", () => {
    const list = h("ul", {});
    assert.equal(fillRows(list, items(20000), row, { limit: 1000, more: () => undefined }), 1000);
    assert.equal(rows(list).length, 1000);
    const line = moreLine(list);
    assert.ok(line, "the line is there");
    assert.match(line.words, /Showing the first 1,000 of 20,000 questions/);
    assert.deepEqual(buttonsOf(line).map((b) => b.words), ["Show 1,000 more"], "no Show all past 5,000: it froze the window for 8.6 seconds at 20,000");
    assert.equal(list.children.at(-1), line, "it ends the list");
  });

  test("offers Show all up to 5,000 questions and not beyond", () => {
    const at5000 = h("ul", {});
    fillRows(at5000, items(5000), row, { limit: 1000, more: () => undefined });
    assert.deepEqual(buttonsOf(moreLine(at5000) as FakeNode).map((b) => b.words), ["Show 1,000 more", "Show all 5,000 (slow)"]);
    const over = h("ul", {});
    fillRows(over, items(5001), row, { limit: 1000, more: () => undefined });
    assert.deepEqual(buttonsOf(moreLine(over) as FakeNode).map((b) => b.words), ["Show 1,000 more"]);
    // Drawn as far as 4,500 of 5,000: the rest is under a thousand, so Show all would only repeat the first button.
    const near = h("ul", {});
    fillRows(near, items(5000), row, { limit: 4500, more: () => undefined });
    assert.deepEqual(buttonsOf(moreLine(near) as FakeNode).map((b) => b.words), ["Show 500 more"]);
  });

  test("offers only the rest when the rest is no more than a thousand, and no 'show all'", () => {
    const list = h("ul", {});
    fillRows(list, items(1400), row, { limit: 1000, more: () => undefined });
    assert.deepEqual(buttonsOf(moreLine(list) as FakeNode).map((b) => b.words), ["Show 400 more"]);
  });

  test("the buttons ask for the next thousand and for all, and say where the first new row is", () => {
    const asked: Array<[number, number]> = [];
    const list = h("ul", {});
    fillRows(list, items(5000), row, { limit: 1000, more: (limit: number, firstNew: number) => asked.push([limit, firstNew]) });
    const [next, all] = buttonsOf(moreLine(list) as FakeNode);
    next?.click();
    all?.click();
    assert.deepEqual(asked, [[2000, 1000], [5000, 1000]]);
  });

  test("always draws as far as the chosen row, however far down it is", () => {
    const list = h("ul", {});
    assert.equal(fillRows(list, items(5000), row, { limit: 1000, chosenAt: 2499, more: () => undefined }), 2500);
    assert.equal(rows(list).length, 2500);
    assert.match((moreLine(list) as FakeNode).words, /first 2,500 of 5,000/);
    const near = h("ul", {});
    assert.equal(fillRows(near, items(5000), row, { limit: 1000, chosenAt: 10, more: () => undefined }), 1000, "a chosen row within the limit changes nothing");
    const none = h("ul", {});
    assert.equal(fillRows(none, items(5000), row, { limit: 1000, chosenAt: -1, more: () => undefined }), 1000, "none chosen (findIndex says -1) changes nothing");
  });

  test("rows keep their numbers and keys, so choosing one by key still works in the part that is drawn", () => {
    const list = h("ul", {});
    fillRows(list, items(3000), row, { limit: 1000, more: () => undefined });
    markSelected(list, 999);
    assert.deepEqual(current(list), ["999"]);
    assert.equal(rows(list)[999]?.querySelectorAll("span").find((s) => s.className === "n")?.words, "1000");
  });
});

describe("the screens that use it", () => {
  const UI = join(import.meta.dirname, "..", "ui");
  for (const file of ["review.js", "bank.js"]) {
    const source = readFileSync(join(UI, file), "utf8");
    test(`${file} marks the chosen row in place when a question is chosen, and names each row for it`, () => {
      const select = /async function select\([^)]*\) \{[\s\S]*?\n  \}\n/.exec(source)?.[0] ?? "";
      assert.match(select, /markSelected\(list, /, "choosing a question marks the row");
      assert.doesNotMatch(select, /renderList\(\)/, "and does not draw the whole list again");
      assert.match(source, /questionRow\(\{[^}]*\bkey: /, "each row is given the key it is marked by");
    });
    test(`${file} draws its rows through fillRows, as far as the chosen one, and starts again from the first thousand for another list`, () => {
      assert.match(source, /fillRows\(list, /, "the list is filled in pages");
      assert.match(source, /chosenAt: /, "as far as the chosen row");
      assert.match(source, /let rowLimit = ROWS_AT_FIRST/, "it starts from its first rows");
      if (file === "review.js") assert.match(source, /filter = key; rowLimit = ROWS_AT_FIRST;/, "and a different filter starts from them again");
      assert.doesNotMatch(source, /for \(const summary of items\) list\.append|bank\.questions\.forEach\(/, "and no loop draws every row");
    });
  }
  test("the bank starts again from the first thousand only when the search or filters change, and keeps how far it was shown after an edit", () => {
    const source = readFileSync(join(UI, "bank.js"), "utf8");
    assert.match(source, /if \(suffix !== listedFor\) \{[\s\S]*?rowLimit = ROWS_AT_FIRST;/);
  });
});
