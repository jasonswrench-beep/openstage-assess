/**
 * What a question says from how filled its bubbles are: the rules table of the specification, row by row, and at its edges.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { BLANK, BLANK_MULTIPLE, FILLED, decideQuestion, decideVersion } from "../src/sheets/decide.ts";
import type { SlotUse } from "../src/sheets/plan.ts";

const choice = (places: number): SlotUse => ({ kind: "choice", places, questionId: "q" });
const several = (places: number): SlotUse => ({ kind: "multiple", places, questionId: "q" });
const trueFalse = (): SlotUse => ({ kind: "trueFalse", places: 2, questionId: "q" });
const none = (): SlotUse => ({ kind: "none", places: 0, questionId: "q", why: "an essay" });

describe("deciding a question", () => {
  test("one bubble filled and the rest empty is an answer", () => {
    assert.deepEqual(decideQuestion([0, 0.8, 0, 0.02], choice(4)), { status: "answered", marked: [1] });
    assert.deepEqual(decideQuestion([0.95, 0], trueFalse()), { status: "answered", marked: [0] });
    assert.deepEqual(decideQuestion([0, 0, 0.5, 0, 0.01], choice(5)), { status: "answered", marked: [2] }, "a mark exactly at the line is a mark");
  });

  test("nothing marked is blank, and is flagged for a quick confirm", () => {
    const d = decideQuestion([0, 0.01, 0.02, 0], choice(4));
    assert.equal(d.status, "blank");
    assert.equal(d.kind, "blank");
    assert.deepEqual(d.marked, []);
    assert.equal(decideQuestion([BLANK, 0, 0, 0], choice(4)).status, "blank", "exactly at the line for empty is empty");
  });

  test("anything between empty and filled is faint, and flagged with what was seen", () => {
    for (const fill of [BLANK + 0.01, 0.2, 0.3, 0.4, FILLED - 0.01]) {
      const d = decideQuestion([0, fill, 0, 0], choice(4));
      assert.equal(d.status, "flagged", `fill ${fill}`);
      assert.equal(d.kind, "faint");
      assert.deepEqual(d.marked, []);
      assert.match(d.reason as string, /Bubble B is marked lightly or in part \(fill/);
    }
    // a faint mark beside a firm one is still a flag: it could be an erasure, or the answer
    const beside = decideQuestion([0.8, 0.3, 0, 0], choice(4));
    assert.equal(beside.status, "flagged");
    assert.match(beside.reason as string, /Bubble B/);
  });

  test("two filled bubbles on a question with one answer is a flag that names them", () => {
    const d = decideQuestion([0.7, 0, 0.9, 0], choice(4));
    assert.equal(d.status, "flagged");
    assert.equal(d.kind, "multiple");
    assert.match(d.reason as string, /More than one bubble is marked \(A, C\) on a question with one answer/);
    assert.equal(decideQuestion([0.9, 0.9], trueFalse()).status, "flagged", "true and false");
  });

  test("a question with several answers records the set of filled bubbles, each plainly filled or plainly empty", () => {
    assert.deepEqual(decideQuestion([0.8, 0, 0.9, 0.7, 0], several(5)), { status: "answered", marked: [0, 2, 3] });
    assert.deepEqual(decideQuestion([0, 0.9, 0, 0, 0], several(5)), { status: "answered", marked: [1] });
    assert.equal(decideQuestion([0, 0, 0, 0, 0], several(5)).status, "blank");
    const faint = decideQuestion([0.8, 0.3, 0, 0, 0], several(5));
    assert.equal(faint.status, "flagged");
    assert.equal(faint.kind, "faint");
  });

  test("a question with several answers has a stricter line for empty, since a missed mark changes the set without a sign", () => {
    assert.ok(BLANK_MULTIPLE < BLANK);
    const pale = (BLANK + BLANK_MULTIPLE) / 2;
    // between the two lines: empty for one answer, faint for several
    assert.equal(decideQuestion([0.8, pale, 0, 0, 0], choice(5)).status, "answered", "a trace beside the answer on a question with one answer is paper");
    assert.equal(decideQuestion([0.8, pale, 0, 0, 0], several(5)).status, "flagged", "and on a question with several it is a mark that may be an answer");
    assert.equal(decideQuestion([0.8, BLANK, 0, 0], choice(4)).status, "answered");
    assert.equal(decideQuestion([0.8, BLANK, 0, 0, 0], several(5)).status, "flagged");
    assert.equal(decideQuestion([0.8, BLANK_MULTIPLE, 0, 0, 0], several(5)).status, "answered", "at the stricter line it is empty");
  });

  test("a mark in a bubble this version's question does not have is a flag, and a mark where it has none at all", () => {
    // version B has four answers where the shared sheet draws five
    const d = decideQuestion([0, 0, 0.8, 0, 0.7], choice(4));
    assert.equal(d.status, "flagged");
    assert.equal(d.kind, "beyond");
    assert.match(d.reason as string, /in bubble E, which this version's question does not have/);
    // a pale mark there is a flag too: it is not paper
    assert.equal(decideQuestion([0.9, 0, 0, 0, 0.2], choice(4)).kind, "beyond");
    // and nothing there leaves the answer standing
    assert.equal(decideQuestion([0.9, 0, 0, 0, 0.02], choice(4)).status, "answered");
    const essay = decideQuestion([0.8, 0, 0, 0], none());
    assert.equal(essay.status, "flagged");
    assert.match(essay.reason as string, /where this version of the test has no bubbles for the question/);
  });

  test("a question the sheet does not carry is not on the sheet, and says nothing", () => {
    assert.deepEqual(decideQuestion([], none()), { status: "notOnSheet", marked: [] });
    assert.deepEqual(decideQuestion([0, 0, 0, 0], none()), { status: "notOnSheet", marked: [] }, "bubbles drawn for another version, all empty");
    assert.deepEqual(decideQuestion([], undefined), { status: "notOnSheet", marked: [] });
  });

  test("a row whose printed circles could not be found is flagged whatever its fills say", () => {
    const d = decideQuestion([0, 0.9, 0, 0], choice(4), false);
    assert.equal(d.status, "flagged");
    assert.equal(d.kind, "registration");
    assert.deepEqual(d.marked, []);
  });

  test("never records the answers of a question with several from a black and white picture, and reads the rest as always", () => {
    const d = decideQuestion([0.9, 0, 0.9, 0, 0], several(5), true, true);
    assert.equal(d.status, "flagged");
    assert.equal(d.kind, "bilevel");
    assert.match(d.reason as string, /black and white/);
    assert.match(d.reason as string, /A, C/);
    assert.equal(decideQuestion([0, 0, 0, 0, 0], several(5), true, true).kind, "bilevel", "an empty row too: a pale mark may be missing");
    assert.deepEqual(decideQuestion([0, 0.9, 0, 0], choice(4), true, true), { status: "answered", marked: [1] });
  });

  test("the lines are where the specification's table starts them, set lower than its first values after measuring", () => {
    assert.equal(FILLED, 0.5);
    assert.equal(BLANK, 0.1);
    assert.ok(BLANK < FILLED);
  });
});

describe("deciding the version", () => {
  test("is the one filled bubble, when the others are empty", () => {
    assert.deepEqual(decideVersion([0, 0.9, 0, 0]), { version: 2 });
    assert.deepEqual(decideVersion([0.8, 0]), { version: 1 });
    assert.deepEqual(decideVersion([0.02, 0.01, 0.01, 0.97]), { version: 4 });
  });

  test("is not settled when none is filled, two are, or one is only faint", () => {
    assert.match(decideVersion([0, 0, 0]).reason as string, /No version bubble is marked/);
    assert.match(decideVersion([0.9, 0.9, 0]).reason as string, /More than one version bubble is marked \(A, B\)/);
    assert.match(decideVersion([0, 0.3, 0]).reason as string, /marked lightly or in part \(fill 0.30\)/);
    assert.match(decideVersion([0.9, 0.3, 0]).reason as string, /lightly or in part/, "a firm one beside a faint one");
    for (const fills of [[0, 0, 0], [0.9, 0.9], [0, 0.3]]) assert.equal(decideVersion(fills).version, undefined);
  });
});
