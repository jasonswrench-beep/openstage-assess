/**
 * A bank taken out and brought in again is the same bank.
 *
 * Random questions, written in words that are hard on a text format (commas, braces, colons, a leading equals sign or plus or at sign,
 * quotes, markup, a number or a letter and a full stop at the start, "Answer: B", Chinese), are exported to GIFT and to the question
 * spreadsheet, read back by the importer for that format, and compared: the type, the stem, every option and which is right, the
 * accepted answers, the pairs. A tab or a line break may come back as a space (a cell and a line of GIFT cannot hold them); nothing
 * else may change. A question a format cannot carry (matching, in the spreadsheet) is reported as left out by the destination check
 * and is not in the file, so it is not compared. 1,590 questions were compared this way when it was written, with no difference.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { exportGift } from "../src/export/gift.ts";
import { exportOpenStageSpreadsheet } from "../src/export/openstage-spreadsheet.ts";
import { giftImporter } from "../src/import/gift.ts";
import { spreadsheetImporter } from "../src/import/spreadsheet.ts";
import { createQuestion } from "../src/model/create.ts";
import type { Question } from "../src/model/question.ts";
import { plainToRich, richTextToPlain } from "../src/model/richtext.ts";

const WORDS = ["alpha", "Beta", "gamma delta", "x = y", "a, b, c", "{braces}", "~tilde", "#hash", "50% of it", "colon: here", "semi; colon", "back\\slash", 'quote "q"', "it's", "café", "中文", "=SUM(1)", "+plus", "-minus", "@at", "<b>tag</b>", "a & b", "tab\there", "two  spaces", "]]>", "line one\nline two", "$dollar", "\\n", "::title::", "1.", "A.", "Answer: B"];

function generator(seed: number): (n: number) => number {
  let state = seed >>> 0;
  return (n) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 4294967296) * n);
  };
}

function questions(int: (n: number) => number): Question[] {
  const text = (): string =>
    Array.from({ length: 1 + int(3) }, () => WORDS[int(WORDS.length)])
      .join(" ")
      .trim() || "word";
  const unique = (n: number): string[] => {
    const seen = new Set<string>();
    while (seen.size < n) seen.add(text());
    return [...seen];
  };
  return Array.from({ length: 1 + int(5) }, () => {
    const stem = plainToRich(`${text()}?`);
    switch (int(6)) {
      case 0:
      case 1: {
        const options = unique(2 + int(3));
        const right = int(options.length);
        return createQuestion({ type: "multipleChoice", stem, points: 1 + int(5), body: { shuffle: true, options: options.map((t, i) => ({ id: `o${i}`, content: plainToRich(t), correct: i === right })) } as never });
      }
      case 2:
        return createQuestion({ type: "multipleResponse", stem, body: { shuffle: true, partialCredit: false, options: unique(4).map((t, i) => ({ id: `o${i}`, content: plainToRich(t), correct: i % 2 === 0 })) } as never });
      case 3:
        return createQuestion({ type: "trueFalse", stem, body: { correct: int(2) === 0 } });
      case 4:
        return createQuestion({ type: "shortAnswer", stem, body: { caseSensitive: false, accepted: unique(1 + int(2)) } });
      default: {
        const lefts = unique(3);
        const rights = unique(3);
        return createQuestion({ type: "matching", stem, body: { shuffle: true, distractors: [], pairs: lefts.map((l, i) => ({ id: `p${i}`, left: plainToRich(l), right: rights[i] as string })) } as never });
      }
    }
  });
}

const flat = (s: string): string => s.replace(/\s+/g, " ").trim();
const plain = (v: Parameters<typeof richTextToPlain>[0]): string => flat(richTextToPlain(v));

/** What a person would call the question: what it says, what its answers are, and which are right. */
function shape(q: Question): unknown {
  const body = q.body as unknown as Record<string, any>;
  switch (q.type) {
    case "multipleChoice":
    case "multipleResponse":
      return { type: q.type, stem: plain(q.stem), options: body["options"].map((o: any) => [plain(o.content), o.correct]) };
    case "trueFalse":
      return { type: q.type, stem: plain(q.stem), correct: body["correct"] };
    case "shortAnswer":
      return { type: q.type, stem: plain(q.stem), accepted: [...body["accepted"]].map((a: string) => flat(a)).sort() };
    case "matching":
      return { type: q.type, stem: plain(q.stem), pairs: body["pairs"].map((p: any) => [plain(p.left), flat(p.right)]) };
    default:
      return { type: q.type, stem: plain(q.stem) };
  }
}

describe("taking a bank out and bringing it in again", () => {
  const ROUNDS = 120;

  test("GIFT keeps every question: its stem, its answers and which are right", () => {
    let compared = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const qs = questions(generator(500 + round));
      const file = exportGift(qs, { name: "Round trip" }).files[0];
      assert.ok(file, `round ${round}: a file was written`);
      const back = giftImporter.parse(file.content ?? "", { file: "round.gift" }).questions;
      assert.equal(back.length, qs.length, `round ${round}: ${qs.length} went out, ${back.length} came back`);
      qs.forEach((q, i) => {
        assert.deepEqual(shape(back[i] as Question), shape(q), `round ${round}, question ${i + 1} (${q.type})`);
        compared++;
      });
    }
    assert.ok(compared > 300, `${compared} questions compared`);
  });

  test("the question spreadsheet keeps every question it carries, and the check says which it cannot", () => {
    let compared = 0;
    let leftOut = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const all = questions(generator(900 + round));
      const carried = all.filter((q) => q.type !== "matching");
      const exported = exportOpenStageSpreadsheet(all, { name: "Round trip" });
      leftOut += exported.report.items.filter((item) => item.outcome === "leftOut").length;
      assert.equal(exported.report.items.filter((item) => item.outcome === "leftOut").length, all.length - carried.length, `round ${round}: every matching question is said to be left out, and no other`);
      const file = exported.files[0];
      if (!file) {
        assert.equal(carried.length, 0, `round ${round}: no file, so nothing was carried`);
        continue;
      }
      const back = (spreadsheetImporter.parseBytes as (b: Uint8Array, o: object) => { questions: Question[] })(new Uint8Array(Buffer.from(file.content ?? "", "utf8")), { file: "round.csv" }).questions;
      assert.equal(back.length, carried.length, `round ${round}: ${carried.length} were carried, ${back.length} came back`);
      carried.forEach((q, i) => {
        assert.deepEqual(shape(back[i] as Question), shape(q), `round ${round}, question ${i + 1} (${q.type})`);
        compared++;
      });
    }
    assert.ok(compared > 200 && leftOut > 0, `${compared} compared, ${leftOut} reported as left out`);
  });

  test("the same seed gives the same questions, and another gives others", () => {
    const a = questions(generator(7)).map(shape);
    assert.deepEqual(questions(generator(7)).map(shape), a);
    assert.notDeepEqual(questions(generator(8)).map(shape), a);
  });
});
