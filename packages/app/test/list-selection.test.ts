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
import { markSelected, questionRow } from "../ui/list.js";
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
  }
});
