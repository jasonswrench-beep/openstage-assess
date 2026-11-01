/**
 * Ids sort in the order they were made, even when many are made in one millisecond, which is what an import does. Questions
 * had been coming out of a bank in a random order within each millisecond, so a bank imported from a file did not list its
 * questions in the file's order.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { idTime, isId, newId, newQuestionId, newUlid } from "../src/model/ids.ts";

describe("ids made in one millisecond", () => {
  test("sort in the order they were made", () => {
    const made = Array.from({ length: 5000 }, () => newUlid(1_700_000_000_000));
    assert.deepEqual([...made].sort(), made);
    assert.equal(new Set(made).size, made.length, "and no two are the same");
  });

  test("still carry the millisecond they were made in", () => {
    const ids = Array.from({ length: 50 }, () => newQuestionId(1_700_000_123_456));
    for (const id of ids) {
      assert.ok(isId(id, "q"));
      assert.equal(idTime(id), 1_700_000_123_456);
    }
  });

  test("keep the order across a change of millisecond, and across kinds of id", () => {
    const made = [newUlid(1_800_000_000_000), newUlid(1_800_000_000_000), newUlid(1_800_000_000_001), newUlid(1_800_000_000_001), newUlid(1_800_000_000_002)];
    assert.deepEqual([...made].sort(), made);
    const mixed = [newId("q", 1_900_000_000_000), newId("q", 1_900_000_000_000)];
    assert.ok((mixed[0] as string) < (mixed[1] as string));
  });

  test("are not given a smaller value by an id made for an earlier time", () => {
    const later = newUlid(2_000_000_000_001);
    const earlier = newUlid(2_000_000_000_000);
    assert.ok(earlier < later, "an earlier time sorts earlier");
    assert.equal(idTime(`q_${earlier}`), 2_000_000_000_000);
  });

  test("are still unpredictable from one millisecond to the next", () => {
    const first = newUlid(2_100_000_000_000).slice(10);
    const second = newUlid(2_100_000_000_001).slice(10);
    assert.notEqual(first, second);
    assert.equal(newUlid(2_100_000_000_002).length, 26);
  });
});
