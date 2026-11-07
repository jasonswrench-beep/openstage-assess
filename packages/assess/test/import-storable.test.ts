/**
 * What an importer makes from odd input can always be stored, and a word from the file is never mistaken for a property of every object.
 *
 * An imported question with no key, or with a value the model will not take, has to be storable so that it can be shown beside its
 * source and repaired: a bank refuses what the model does not accept, so a question that cannot be stored is a question that is lost,
 * and a single one stopped `import --out` for the whole file. An independent review of the table and Brightspace readers found four
 * ways it could happen (a short answer with no accepted answer, points above what a question can hold, an unknown kind with nothing
 * written in it, and the text reader's "Difficulty: constructor", which stored a function). Each importer is held to it here.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { Bank } from "../src/bank/store.ts";
import { importerForContent, runImporter } from "../src/import/registry.ts";
import type { ImportResult } from "../src/import/types.ts";
import { liveFindings, verdictFrom } from "../src/model/findings.ts";
import { MAX_POINTS, type Question } from "../src/model/question.ts";
import { validateQuestion } from "../src/model/schema.ts";

const AT = "2026-11-07T00:00:00.000Z";
const read = (file: string, text: string): ImportResult => {
  const bytes = new Uint8Array(Buffer.from(text, "utf8"));
  return runImporter(importerForContent(file, bytes), bytes, { file, at: AT, author: "test" });
};
/** Every question of a result is accepted by a bank. */
const storable = (r: ImportResult): void => {
  assert.ok(r.questions.length > 0, "there are questions to store");
  const bank = Bank.createEmpty("t");
  for (const q of r.questions) {
    assert.equal(validateQuestion(q).ok, true, JSON.stringify(validateQuestion(q)));
    bank.add(q);
  }
};
const said = (r: ImportResult, n = 0): string => liveFindings((r.questions[n] as Question).findings).map((f) => `${f.severity}: ${f.message}`).join(" | ");

describe("a question with no accepted answer", () => {
  test("a table's short answer with nothing in its cells is stored, and is flagged for the key it lacks", () => {
    const r = read("t.csv", "Type,Question,A,B,Correct\nSA,Name it?,,,\n");
    storable(r);
    assert.equal(verdictFrom((r.questions[0] as Question).findings), "failed");
  });

  test("a Brightspace short answer whose only rows are regular expressions is stored, flagged, and says so", () => {
    const r = read("l.csv", "NewQuestion,SA,\r\nQuestionText,Cap?,\r\nAnswer,100,Pa.*,regexp\r\n");
    storable(r);
    assert.equal(verdictFrom((r.questions[0] as Question).findings), "failed");
    assert.match(said(r), /is a regular expression/);
  });

  test("a Moodle short answer with no answer, a GIFT one, and a text one are stored too", () => {
    const moodle = read("m.xml", '<?xml version="1.0"?><quiz><question type="shortanswer"><name><text>N</text></name><questiontext format="html"><text>Name it?</text></questiontext><defaultgrade>1</defaultgrade></question></quiz>');
    storable(moodle);
    const gift = read("g.gift", "Name it? {}\n");
    if (gift.questions.length > 0) storable(gift);
    const text = read("s.txt", "1. Name it?\nType: SA\n");
    if (text.questions.length > 0) storable(text);
  });
});

describe("points above what a question can be worth", () => {
  const cases: Array<[string, string, string]> = [
    ["a table", "t.csv", "Question,A,B,Correct,Points\nWhich?,a,b,A,5000\n"],
    ["a Brightspace file", "l.csv", "NewQuestion,MC,\r\nQuestionText,x?,\r\nPoints,5000,\r\nOption,100,A,\r\nOption,0,B,\r\n"],
  ];
  for (const [label, file, text] of cases) {
    test(`${label} with 5000 points is stored at the most, and says it was cut`, () => {
      const r = read(file, text);
      storable(r);
      assert.equal(r.questions[0]?.points, MAX_POINTS);
      assert.match(said(r), new RegExp(`worth 5000 points, which is more than a question can be worth \\(${MAX_POINTS}\\), so it was set to ${MAX_POINTS}`));
    });
  }
  test("a question worth the most is left as it is, and says nothing", () => {
    const r = read("t.csv", `Question,A,B,Correct,Points\nWhich?,a,b,A,${MAX_POINTS}\n`);
    assert.equal(r.questions[0]?.points, MAX_POINTS);
    assert.doesNotMatch(said(r), /more than a question can be worth/);
  });
});

describe("a Brightspace kind that is not read, with nothing written in it", () => {
  test("is stored with a stand-in for its text, and fails", () => {
    const r = read("l.csv", "NewQuestion,XYZ,\r\n");
    storable(r);
    assert.equal(verdictFrom((r.questions[0] as Question).findings), "failed");
    assert.match(richOf(r), /no question text in the source/);
  });
});

const richOf = (r: ImportResult): string => (r.questions[0] as { stem: { content: string } }).stem.content;

describe("a word from the file that names a property every object has", () => {
  test("a difficulty or a Bloom level of \"constructor\" in the text reader is kept as written, and the question is stored", () => {
    for (const word of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const r = read("t.txt", `1. Q?\na. x\n*b. y\nDifficulty: ${word}\nBloom: ${word}\n`);
      storable(r);
      assert.equal((r.questions[0] as { metadata: { difficulty?: unknown } }).metadata.difficulty, undefined, word);
      assert.equal((r.questions[0] as { metadata: { bloom?: unknown } }).metadata.bloom, undefined, word);
    }
  });

  test("a column named constructor is not a column, and a Type of constructor is not a type", () => {
    const r = read("t.csv", "Question,A,B,Correct,Constructor,Type\nWhich?,a,b,A,x,constructor\n");
    storable(r);
    assert.match(r.fileFindings.map((f) => f.message).join(" | "), /Constructor/, "the column is named as not used");
    // A type that is not one this knows is kept as an essay, with the reason, and not as whatever an object property would give.
    assert.equal(r.questions[0]?.type, "essay");
    assert.match(said(r), /The type "constructor" is not one OpenAssess reads from a table/);
  });
});
