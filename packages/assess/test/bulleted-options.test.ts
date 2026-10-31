/**
 * A bank whose options are the bullets of a Word list and whose stems are numbered by Word, or are plain paragraphs, with no
 * blank line between one question and the next. Word keeps no label for a bullet, so the reader passed the options on as lines
 * like any other, and the whole file was one run of lines. The reader now says which blocks are bullets, and the step that
 * labels a bank with no letters ends a group at the first line after the last bullet. These tests use invented text.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { type ImportResult } from "../src/import/types.ts";
import { wordImporter, docxToBlocks } from "../src/import/word.ts";
import { FindingCode, verdictFrom } from "../src/model/findings.ts";
import type { Question } from "../src/model/question.ts";
import { richTextToPlain } from "../src/model/richtext.ts";
import { abstractNum, docx, level, listProperties, num, numberingPart, paragraph, run } from "./support/docx-writer.ts";

const OPTIONS = { file: "t.docx", at: "2026-01-01T00:00:00.000Z", author: "test" };

type Line = { stem: string } | { bullet: string; bold?: boolean } | { plain: string; bold?: boolean } | { bulletBroken: [string, string] } | "blank";

/** Word's numbering for these banks: list 1 numbers its items 1., 2., and list 2 gives each a bullet. */
const NUMBERING = numberingPart(
  [abstractNum(0, [level(0, { format: "decimal", text: "%1." })]), abstractNum(1, [level(0, { format: "bullet", text: "•" })])],
  [num(1, 0), num(2, 1)],
);

const bytes = (lines: Line[]): Uint8Array =>
  docx({
    numbering: NUMBERING,
    body: lines
      .map((l) =>
        l === "blank"
          ? paragraph("")
          : "stem" in l
            ? paragraph(run(l.stem), listProperties({ numId: 1 }))
            : "bulletBroken" in l
              ? paragraph(`<w:r><w:t xml:space="preserve">${l.bulletBroken[0]}</w:t><w:br/><w:t xml:space="preserve">${l.bulletBroken[1]}</w:t></w:r>`, listProperties({ numId: 2 }))
            : "bullet" in l
              ? paragraph(run(l.bullet, l.bold ? "<w:b/>" : ""), listProperties({ numId: 2 }))
              : paragraph(run(l.plain, l.bold ? "<w:b/>" : "")),
      )
      .join(""),
  });
const read = (lines: Line[]): ImportResult => wordImporter.parseBytes(bytes(lines), OPTIONS);

const plain = (rich: Parameters<typeof richTextToPlain>[0]): string => richTextToPlain(rich).replace(/\s+/g, " ").trim();
const stemOf = (q: Question): string => plain(q.stem);
const optionsOf = (q: Question): Array<{ words: string; correct: boolean }> =>
  ((q.body as Record<string, any>)["options"] as Array<{ content: Parameters<typeof plain>[0]; correct?: boolean }>).map((o) => ({
    words: plain(o.content),
    correct: o.correct === true,
  }));
const rightOf = (q: Question): string[] => optionsOf(q).filter((o) => o.correct).map((o) => o.words);
const verdict = (q: Question): string => verdictFrom(q.findings);

const QUESTIONS: Array<[string, string[], number]> = [
  ["Which of these is a kind of fruit?", ["Chair", "Apple", "Desk", "Lamp"], 1],
  ["Which planet is closest to the sun?", ["Mercury", "Venus", "Mars", "Jupiter"], 0],
  ["What is the capital of France?", ["Rome", "Madrid", "Paris", "Berlin"], 2],
  ["Which of these animals is a mammal?", ["Trout", "Eagle", "Dolphin", "Gecko"], 2],
];
const RIGHT = QUESTIONS.map(([, options, right]) => options[right]);

/** The questions with a stem line of the kind `stem` makes, bullets for the options, `(Correct)` after the right one. */
const bank = (stem: (s: string) => Line, gap: Line[] = []): Line[] =>
  QUESTIONS.flatMap(([s, options, right]) => [stem(s), ...options.map((o, i) => ({ bullet: i === right ? `${o} (Correct)` : o }) as Line), ...gap]);

describe("what the Word reader says about a bullet", () => {
  test("a bulleted paragraph is a bullet, and a numbered one or a plain one is not", () => {
    const { blocks } = docxToBlocks(bytes([{ stem: "A numbered stem here" }, { bullet: "A bullet" }, { plain: "A plain line" }]));
    assert.deepEqual(blocks.map((b) => b.bullet === true), [false, true, false]);
    assert.equal(blocks[1]?.listLabel, undefined, "a bullet has no label");
    assert.equal(blocks[0]?.listLabel, "1.");
  });
});

describe("a bank whose options are bullets", () => {
  test("under stems that Word numbers, with no blank line between the questions", () => {
    const result = read(bank((s) => ({ stem: s })));
    assert.equal(result.questions.length, 4);
    assert.deepEqual(result.questions.map(stemOf), QUESTIONS.map(([s]) => s));
    assert.deepEqual(result.questions.map((q) => rightOf(q)[0]), RIGHT);
    for (const q of result.questions) {
      assert.equal(optionsOf(q).length, 4);
      assert.equal(verdict(q), "parsed");
    }
    assert.equal(result.orphans.length, 0);
    assert.match(result.fileFindings.find((f) => f.code === FindingCode.UnlabelledGroups)?.message ?? "", /question numbers but no option letters/);
  });

  test("under plain paragraphs that are not numbered", () => {
    const result = read(bank((s) => ({ plain: s })));
    assert.equal(result.questions.length, 4);
    assert.deepEqual(result.questions.map(stemOf), QUESTIONS.map(([s]) => s));
    assert.deepEqual(result.questions.map((q) => rightOf(q)[0]), RIGHT);
    assert.match(result.fileFindings.find((f) => f.code === FindingCode.UnlabelledGroups)?.message ?? "", /no question numbers and no option letters/);
  });

  test("with a blank line between the questions as well", () => {
    const result = read(bank((s) => ({ stem: s }), ["blank"]));
    assert.equal(result.questions.length, 4);
    assert.deepEqual(result.questions.map((q) => rightOf(q)[0]), RIGHT);
  });

  test("with the right option in bold and no word after it", () => {
    const lines = QUESTIONS.flatMap(([s, options, right]) => [
      { stem: s } as Line,
      ...options.map((o, i) => ({ bullet: o, bold: i === right }) as Line),
    ]);
    const result = read(lines);
    assert.equal(result.questions.length, 4);
    assert.deepEqual(result.questions.map((q) => rightOf(q)[0]), RIGHT);
  });

  test("a bulleted option with a soft line break in it is one option, and the line after the break does not begin a question", () => {
    const lines = bank((s) => ({ stem: s }));
    // The first option of the third question, "Rome", written over two lines of the same bullet.
    const at = lines.findIndex((l) => typeof l !== "string" && "bullet" in l && l.bullet === "Rome");
    lines[at] = { bulletBroken: ["Rome, the capital", "of Italy"] };
    // And the last option of the first, with the next question's stem straight after it.
    const last = lines.findIndex((l) => typeof l !== "string" && "bullet" in l && l.bullet === "Lamp");
    lines[last] = { bulletBroken: ["Lamp, a light", "for a room"] };
    const result = read(lines);
    assert.equal(result.questions.length, 4);
    assert.deepEqual(optionsOf(result.questions[2] as Question).map((o) => o.words), ["Rome, the capital of Italy", "Madrid", "Paris", "Berlin"]);
    assert.deepEqual(optionsOf(result.questions[0] as Question).map((o) => o.words), ["Chair", "Apple", "Desk", "Lamp, a light for a room"]);
    assert.deepEqual(result.questions.map((q) => rightOf(q)[0]), RIGHT);
    assert.deepEqual(result.questions.map(stemOf), QUESTIONS.map(([s]) => s));
  });

  test("a title above the first question, on a line of its own, is reported and not a stem", () => {
    const result = read([{ plain: "Science Quiz" }, "blank", ...bank((s) => ({ stem: s }))]);
    assert.equal(result.questions.length, 4);
    assert.deepEqual(result.orphans.map((o) => o.text), ["Science Quiz"]);
  });

  test("lines that are not bullets, one after another with no blank line, are not a bank this step reads", () => {
    const lines: Line[] = QUESTIONS.flatMap(([s, options]) => [{ plain: s } as Line, ...options.map((o) => ({ plain: o }) as Line)]);
    const result = read(lines);
    assert.equal(result.questions.length, 0);
  });
});
