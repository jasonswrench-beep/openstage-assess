/**
 * The step that gives a bank with no numbers and no letters the labels the page does not show, tested on its own, and the
 * files of that kind it must leave alone. The first file, unlabelled-groups.test.ts, reads whole banks; this one asks where the
 * step will and will not label, because a wrong place makes a question that is wrong and looks right. These tests use invented
 * text.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { standardTextImporter } from "../src/import/standard-text.ts";
import { relabelUnlabelledGroups, type Relabelled } from "../src/import/standard-text-relabel.ts";
import { type ImportResult, type SourceBlock } from "../src/import/types.ts";
import { wordImporter } from "../src/import/word.ts";
import { FindingCode, verdictFrom } from "../src/model/findings.ts";
import type { Question } from "../src/model/question.ts";
import { docx, paragraph, run } from "./support/docx-writer.ts";

const OPTIONS = { file: "t.txt", at: "2026-01-01T00:00:00.000Z", author: "test" };
/** A line that starts with "**" is written in bold, which is how these banks mark the right option. */
const inWord = (lines: string[]): ImportResult =>
  wordImporter.parseBytes(
    docx({
      body: lines
        .map((l) => (l === "" ? paragraph("") : l.startsWith("**") ? paragraph(run(l.slice(2), "<w:b/>")) : paragraph(run(l))))
        .join(""),
    }),
    { ...OPTIONS, file: "t.docx" },
  );
const verdict = (q: Question): string => verdictFrom(q.findings);
const said = (r: ImportResult): boolean => r.fileFindings.some((f) => f.code === FindingCode.UnlabelledGroups);

const blocksOf = (lines: string[]): SourceBlock[] => lines.map((t, i) => ({ index: i, text: t }));
/** A group of lines that is a question with three unlabelled options, and the blank line after it. */
const GROUP = (n: number): string[] => [`Which of these is number ${n} in order?`, "First thing", "Second thing", "Third thing", ""];
const groups = (count: number): string[] => Array.from({ length: count }, (_, i) => GROUP(i + 1)).flat();
/** A run of two lines that is no question: some prose. */
const PROSE = ["This is only some prose.", "And here is some more.", ""];
const labels = (r: Relabelled, from: number, to: number): Array<string | undefined> => r.blocks.slice(from, to).map((b) => b.listLabel);

/** Five questions with four options, the right one in bold, no numbers and no letters, a blank line between. */
const BANK: string[] = [
  "Which of these is a kind of fruit?", "Chair", "**Apple", "Desk", "Lamp", "",
  "Which planet is closest to the sun?", "**Mercury", "Venus", "Mars", "Jupiter", "",
  "What is the capital of France?", "Rome", "Madrid", "**Paris", "Berlin", "",
  "Which gas do plants take in from the air?", "Oxygen", "Helium", "**Carbon dioxide", "Neon", "",
  "Which of these animals is a mammal?", "Trout", "Eagle", "**Dolphin", "Gecko", "",
];

describe("the step on its own", () => {
  test("three groups are a habit, and two are not", () => {
    assert.equal(relabelUnlabelledGroups(blocksOf(groups(2))), undefined);
    assert.equal(relabelUnlabelledGroups(blocksOf(groups(3)))?.groups, 3);
  });

  test("nearly every run of lines has to be a group: four of five will do, four of six will not", () => {
    assert.equal(relabelUnlabelledGroups(blocksOf([...groups(4), ...PROSE]))?.groups, 4);
    assert.equal(relabelUnlabelledGroups(blocksOf([...groups(4), ...PROSE, ...PROSE])), undefined);
  });

  test("unnumbered stems are numbered, and every option under them is lettered", () => {
    const r = relabelUnlabelledGroups(blocksOf(groups(3))) as Relabelled;
    assert.equal(r.stemsLabelled, true);
    assert.deepEqual(r.blocks.map((b) => b.listLabel), ["1.", "a.", "b.", "c.", undefined, "2.", "a.", "b.", "c.", undefined, "3.", "a.", "b.", "c.", undefined]);
  });

  test("numbered stems are left as they are, and their options are lettered", () => {
    const numbered = Array.from({ length: 5 }, (_, i) => GROUP(i + 1).map((l, k) => (k === 0 ? `${i + 1}. ${l}` : l))).flat();
    const r = relabelUnlabelledGroups(blocksOf(numbered)) as Relabelled;
    assert.equal(r.stemsLabelled, false);
    assert.equal(r.blocks[0]?.listLabel, undefined, "its own number is the stem's number");
    assert.equal(r.blocks[1]?.listLabel, "a.");
  });

  test("stems numbered in some groups and not in others are not a habit", () => {
    const some = (numbered: number): string[] => Array.from({ length: 6 }, (_, i) => GROUP(i + 1).map((l, k) => (k === 0 && i < numbered ? `${i + 1}. ${l}` : l))).flat();
    assert.equal(relabelUnlabelledGroups(blocksOf(some(4))), undefined, "four of six");
    assert.ok(relabelUnlabelledGroups(blocksOf(some(5))), "five of six");
  });

  test("a title on a line of its own before the first group is not a stem set apart from its options", () => {
    assert.equal(relabelUnlabelledGroups(blocksOf(["Science Quiz", "", ...groups(3)]))?.groups, 3);
  });

  test("a stem on a line of its own, set apart from its options by a blank line, is not a habit this step reads", () => {
    const apart = Array.from({ length: 4 }, (_, i) => [`Which of these is number ${i + 1} in order?`, "", "Red round fruit", "Green long fruit", "Yellow bent fruit", ""]).flat();
    assert.equal(relabelUnlabelledGroups(blocksOf(apart)), undefined);
  });

  test("a question of two lines before each group is not a stem set apart", () => {
    const answered = Array.from({ length: 3 }, (_, i) => ["Ice is a solid form of water.", "Answer: True", "", ...GROUP(i + 1)]).flat();
    assert.equal(relabelUnlabelledGroups(blocksOf(answered))?.groups, 6);
  });

  test("a table is a break between runs, as a blank line is", () => {
    const withTables: SourceBlock[] = [];
    for (let i = 0; i < 3; i++) {
      for (const l of GROUP(i + 1).slice(0, 4)) withTables.push({ index: withTables.length, text: l });
      withTables.push({ index: withTables.length, text: "cell", table: { table: i, row: 0, cell: 0 } });
    }
    assert.equal(relabelUnlabelledGroups(withTables)?.groups, 3);
  });

  test("a run of more lines than a letter can go to is not a group, and is left as it was", () => {
    const long = ["Which of these is the longest list?", ...Array.from({ length: 21 }, (_, i) => `Item number ${i + 1}`), ""];
    const r = relabelUnlabelledGroups(blocksOf([...groups(5), ...long])) as Relabelled;
    assert.equal(r.groups, 5);
    assert.ok(r.blocks.slice(25).every((b) => b.listLabel === undefined));
  });

  test("a stem with lines under it that are not options and not an answer is no question", () => {
    const points = ["Which of these is only a stem?", "Points: 2", ""];
    assert.equal(relabelUnlabelledGroups(blocksOf([...groups(3), ...points, ...points, ...points])), undefined);
  });

  test("a run with a lettered line among its options is a lettered question, not one of these", () => {
    const mixed = ["Which of these has a letter?", "plain one", "A. lettered", "plain two", ""];
    assert.equal(relabelUnlabelledGroups(blocksOf([...groups(3), ...mixed, ...mixed, ...mixed])), undefined);
    const late = ["Which of these has a late letter?", "First thing", "Second thing", "Answer: B", "A. late", ""];
    assert.equal(relabelUnlabelledGroups(blocksOf([...groups(3), ...late, ...late, ...late])), undefined);
  });

  test("a stem a list has given a letter or a bullet is not a stem", () => {
    const lettered = blocksOf(groups(6));
    // The last three groups begin at 15, 20 and 25; their stems are given the label a Word list would.
    for (const at of [15, 20, 25]) (lettered[at] as SourceBlock).listLabel = "a.";
    assert.equal(relabelUnlabelledGroups(lettered), undefined);
  });

  test("a question with one option under it is not a group", () => {
    const r = relabelUnlabelledGroups(blocksOf([...groups(5), "Name the largest ocean.", "Pacific", ""])) as Relabelled;
    assert.equal(r.groups, 5);
    assert.ok(r.blocks.slice(25).every((b) => b.listLabel === undefined));
  });

  test("a question mark on an option is an option, and a lone one among the first two lines under a stem closes it", () => {
    const options = (lines: string[]): string[] => ["Which of these is a question word?", ...lines, ""];
    const r = (lines: string[]): Relabelled => relabelUnlabelledGroups(blocksOf([...options(lines), ...groups(3)])) as Relabelled;
    assert.deepEqual(labels(r(["Who?", "What?", "Where?", "When?"]), 1, 5), ["a.", "b.", "c.", "d."], "all four are options");
    assert.deepEqual(labels(r(["Red", "Green", "Is it blue?", "Yellow", "Pink"]), 1, 6), ["a.", "b.", "c.", "d.", "e."], "third under the stem: an option");
    assert.deepEqual(labels(r(["Why?", "Because"]), 1, 3), ["a.", "b."], "nothing is left to be options after it");
    assert.deepEqual(labels(r(["Consider these:", "Red", "Green", "Blue"]), 1, 5), [undefined, "a.", "b.", "c."], "a colon closes a stem too");
  });
});

describe("files of this kind that the importer leaves alone", () => {
  test("options as long as each other are not taken for a stem's second paragraph", () => {
    const long = (n: number): string => `This is a rather long option for the question, number ${n}, and it runs on for a while.`;
    const lines = BANK.flatMap((l, i) => (l.startsWith("**") ? [`**${long(i)}`] : l === "" || /\?$/.test(l) ? [l] : [long(i)]));
    const result = inWord(lines);
    assert.equal(result.questions.length, 5);
    for (const q of result.questions) assert.equal(verdict(q), "parsed", "long, but alike");
  });

  test("a file with one question lettered and the rest not is read as it is", () => {
    const result = inWord(["1. Which is first?", "A. One", "*B. Two", "C. Three", "", ...BANK]);
    assert.equal(result.questions.length, 1);
    assert.ok(!said(result));
  });

  test("a file whose stems are numbered and have answer lines only has nothing to give labels to", () => {
    const lines = Array.from({ length: 4 }, (_, i) => [`${i + 1}. The capital of country number ${i + 1} is ____.`, `Answer: Town${i + 1}`, ""]).flat();
    const result = inWord(lines);
    assert.equal(result.questions.length, 4);
    assert.ok(!said(result), "the plain reading found the keys already, so it stands");
  });

  test("one key among five groups is too few to read the layout from", () => {
    const lines = BANK.map((l, i) => (l.startsWith("**") && i > 2 ? l.slice(2) : l));
    const result = inWord(lines);
    assert.equal(result.questions.length, 0);
    assert.ok(!said(result));
  });

  test("a word as the key on two groups of five is too few to read the layout from", () => {
    const lines = BANK.map((l, i) => (l.startsWith("**") ? (i < 12 ? `${l.slice(2)} (Correct)` : l.slice(2)) : l));
    const result = standardTextImporter.parse(lines.join("\n"), OPTIONS);
    assert.equal(result.questions.length, 0);
    assert.ok(!said(result));
    // And with the word on four of the five, it is read.
    const four = BANK.map((l, i) => (l.startsWith("**") ? (i < 24 ? `${l.slice(2)} (Correct)` : l.slice(2)) : l));
    assert.equal(standardTextImporter.parse(four.join("\n"), OPTIONS).questions.length, 5);
  });

  test("a stem alone with one line under it that is not an answer is not made a question", () => {
    const result = inWord([...BANK, "", "Name the largest ocean.", "Pacific"]);
    assert.equal(result.questions.length, 5);
    assert.deepEqual(result.orphans.map((o) => o.text), ["Name the largest ocean.", "Pacific"]);
  });

  test("a title and three lines of instructions are too much preamble: the first run is not read, and all of it is reported", () => {
    const result = inWord(["Science Quiz", "Instructions: Read each one.", "Directions: Mark one.", "Note: No books.", ...BANK]);
    assert.equal(result.questions.length, 4);
    assert.equal(result.orphans.length, 4 + 5);
  });

  test("a title followed by a line that is not an instruction is not a preamble either", () => {
    const result = inWord(["Science Quiz", "Spring term", ...BANK]);
    assert.equal(result.questions.length, 4);
    assert.equal(result.orphans.length, 2 + 5);
  });
});
