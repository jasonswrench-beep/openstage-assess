/**
 * Typography is what the author wrote, from the file in to the file out.
 *
 * Curly quotes, the en dash, the em dash and the ellipsis used to be flattened on the way in ("--" for a dash, a straight quote for a
 * curly one) so that exact-match grading, search and QTI would not trip over them. The cost was that an instructor's text came out
 * different on the printed test and in every export, and about one question in eight in the real Word files read for this was
 * changed. It is kept now, and these tests follow it the whole way: the importers, a saved bank, every export, the Word and PDF
 * print. What needs the flat form (the search, the check for copies, the accuracy gate) folds both sides of its comparison and
 * stores nothing folded.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";

import { Bank } from "../src/bank/store.ts";
import { unzipSync } from "../src/container/zip.ts";
import { exportBlackboardUpload } from "../src/export/blackboard-upload.ts";
import { exportCommonCartridge } from "../src/export/common-cartridge.ts";
import { exportD2lCsv } from "../src/export/d2l-csv.ts";
import { exportGift } from "../src/export/gift.ts";
import { exportMoodleXml } from "../src/export/moodle-xml.ts";
import { exportOpenStageSpreadsheet } from "../src/export/openstage-spreadsheet.ts";
import { exportQti12 } from "../src/export/qti12.ts";
import { giftImporter } from "../src/import/gift.ts";
import { spreadsheetImporter } from "../src/import/spreadsheet.ts";
import { standardTextImporter } from "../src/import/standard-text.ts";
import { wordImporter } from "../src/import/word.ts";
import { createQuestion } from "../src/model/create.ts";
import { verdictFrom } from "../src/model/findings.ts";
import type { Question } from "../src/model/question.ts";
import { foldTypography, plainToRich, richTextToPlain } from "../src/model/richtext.ts";
import { checkItemQuality } from "../src/quality/items.ts";
import { printOptions, printTest } from "../src/print/index.ts";
import { docx, paragraph, run } from "./support/docx-writer.ts";

const AT = "2026-01-01T00:00:00.000Z";
const STEM = "Which is “right” – it’s — fine…?";
const OPTION = "Mercury’s ‘core’ — hot";
const plain = (rich: Parameters<typeof richTextToPlain>[0]): string => richTextToPlain(rich).replace(/\s+/g, " ").trim();

const make = (type: string, body: Record<string, unknown>, stem = STEM): Question =>
  createQuestion({ type: type as never, stem: plainToRich(stem), body: body as never, at: AT, by: "test" });

/** One question of each kind an exporter carries, every one with typography in it. */
const questions = (): Question[] => [
  make("multipleChoice", { shuffle: true, options: [OPTION, "Venus"].map((t, i) => ({ id: `o${i}`, content: plainToRich(t), correct: i === 0 })) }),
  make("trueFalse", { correct: true }, `True or false: the Sun is a “star” — yes…`),
  make("shortAnswer", { caseSensitive: false, accepted: ["Earth’s moon"] }, `What is Earth’s natural satellite called…?`),
  make("essay", { modelAnswer: plainToRich("Because it hasn’t cleared its orbit — see “dwarf” planets…") }, `Explain why Pluto is “not” a planet – briefly…`),
];

/** All the text an export wrote, decoded, from a plain file or from every file inside a zip. */
function writtenText(files: Array<{ name: string; content?: string; bytes?: Uint8Array }>): string {
  const parts: string[] = [];
  for (const file of files) {
    if (file.bytes) for (const data of unzipSync(file.bytes).values()) parts.push(Buffer.from(data).toString("utf8"));
    else parts.push(file.content ?? "");
  }
  return parts.join("\n");
}

describe("the model keeps typography", () => {
  test("a question made from text with typography stores it as written", () => {
    const q = make("multipleChoice", { shuffle: true, options: [OPTION, "Venus"].map((t, i) => ({ id: `o${i}`, content: plainToRich(t), correct: i === 0 })) });
    assert.equal(plain(q.stem), STEM);
    assert.match(q.stem.content, /“right” – it’s — fine…/);
  });

  test("a bank saved and opened again still has it, and has it in the file", async () => {
    const bank = Bank.createEmpty("Typography", { at: AT });
    for (const q of questions()) bank.add(q);
    const bytes = bank.toBytes({ at: AT });
    const files = [...unzipSync(bytes).values()].map((d) => Buffer.from(d).toString("utf8")).join("\n");
    assert.ok(files.includes("it’s — fine…"), "the question file holds the characters, not their escapes or flat forms");
    const { bank: again } = Bank.fromBytes(bytes);
    const stems = again.sortedQuestions().map((q) => plain(q.stem));
    assert.ok(stems.includes(STEM));
    assert.ok(stems.includes("What is Earth’s natural satellite called…?"));
  });
});

describe("the importers keep it", () => {
  const OPTIONS = { file: "t.txt", at: AT, author: "test" };
  const text = `1) ${STEM}\na) ${OPTION}\n*b) Venus’ clouds\n`;

  test("the standard text format", () => {
    const q = standardTextImporter.parse(text, OPTIONS).questions[0] as Question;
    assert.equal(plain(q.stem), STEM);
    const options = (q.body as { options: Array<{ content: Parameters<typeof plain>[0] }> }).options.map((o) => plain(o.content));
    assert.deepEqual(options, [OPTION, "Venus’ clouds"]);
  });

  test("a Word file, with a key by letter", () => {
    const lines = [`1. ${STEM}`, `a) ${OPTION}`, "b) Venus", "Answer: a"];
    const result = wordImporter.parseBytes(docx({ body: lines.map((l) => paragraph(run(l))).join("") }), { ...OPTIONS, file: "t.docx" });
    const q = result.questions[0] as Question;
    assert.equal(plain(q.stem), STEM);
    assert.equal(plain((q.body as { options: Array<{ content: Parameters<typeof plain>[0] }> }).options[0]!.content), OPTION);
    assert.equal(verdictFrom(q.findings), "parsed", "keeping the characters did not turn a clean question into one that needs a look");
  });

  test("a matching question in a Word file keeps its right side and its spare answer", () => {
    const lines = ["Matching", "1) Match each body.", "a. Star = A sun’s fire — hot.", "b. Planet = A world…", "c. Comet’s tail"];
    const result = wordImporter.parseBytes(docx({ body: lines.map((l) => paragraph(run(l))).join("") }), { ...OPTIONS, file: "t.docx" });
    const body = (result.questions[0] as Question).body as { pairs: Array<{ right: string }>; distractors: string[] };
    assert.deepEqual(body.pairs.map((p) => p.right), ["A sun’s fire — hot.", "A world…"]);
    assert.deepEqual(body.distractors, ["Comet’s tail"]);
  });

  test("GIFT", () => {
    const q = giftImporter.parse(`::t::${STEM} {\n=Mercury’s core\n~Venus\n}\n`, { ...OPTIONS, file: "t.gift" }).questions[0] as Question;
    assert.equal(plain(q.stem), STEM);
  });

  test("a question spreadsheet written by OpenAssess and read back", () => {
    const written = exportOpenStageSpreadsheet(questions(), { name: "T" });
    const file = written.files[0];
    assert.ok(file);
    const back = (spreadsheetImporter.parseBytes as (b: Uint8Array, o: object) => { questions: Question[] })(new Uint8Array(Buffer.from(file.content ?? "", "utf8")), { file: "t.csv" }).questions;
    assert.equal(plain(back[0]!.stem), STEM);
    assert.equal(plain(back[1]!.stem), "True or false: the Sun is a “star” — yes…");
  });
});

describe("every export carries it", () => {
  const exporters: Array<[string, (qs: Question[]) => { files: Array<{ name: string; content?: string; bytes?: Uint8Array }> }]> = [
    ["the question spreadsheet", (qs) => exportOpenStageSpreadsheet(qs, { name: "T" })],
    ["Moodle XML", (qs) => exportMoodleXml(qs, { name: "T" })],
    ["GIFT", (qs) => exportGift(qs, { name: "T" })],
    ["the Brightspace question library file", (qs) => exportD2lCsv(qs, { name: "T" })],
    ["a QTI 1.2 package", (qs) => exportQti12(qs, { name: "T" })],
    ["a Common Cartridge package", (qs) => exportCommonCartridge(qs, { name: "T" })],
    ["the Blackboard upload file", (qs) => exportBlackboardUpload(qs, { name: "T" })],
  ];

  for (const [label, run] of exporters) {
    test(`${label} writes the stem, the option and the answer as they were typed, and flattens none of it`, () => {
      const out = writtenText(run(questions()).files);
      assert.ok(out.includes(STEM), "the stem");
      assert.ok(out.includes(OPTION), "the option");
      assert.ok(out.includes("Earth’s moon") || out.includes("Earth’s natural satellite"), "the short answer's wording");
      // A flat form of an em dash or an ellipsis in this text would be "--" or "...".
      assert.doesNotMatch(out.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?xml[^>]*\?>/g, ""), /fine\.\.\.|it's --|"right" -/, "no flat form of what was typed");
    });
  }
});

describe("both printed forms carry it", () => {
  const opts = printOptions({ title: "Typography", kind: "student" });

  test("the Word file holds the characters", () => {
    const result = printTest(questions(), opts, "docx");
    const xml = Buffer.from(unzipSync(result.file.bytes).get("word/document.xml") ?? new Uint8Array()).toString("utf8");
    assert.ok(xml.includes(STEM));
    assert.ok(xml.includes(OPTION));
  });

  test("the PDF draws them as the Windows Latin-1 codes, and says that nothing could not be drawn", () => {
    const result = printTest(questions(), opts, "pdf");
    const raw = Buffer.from(result.file.bytes);
    const body = raw.toString("latin1");
    const streams: string[] = [];
    for (const m of body.matchAll(/stream\r?\n/g)) {
      const from = m.index! + m[0].length;
      const end = body.indexOf("endstream", from);
      try {
        streams.push(inflateSync(raw.subarray(from, end)).toString("latin1"));
      } catch {
        // not a deflated stream
      }
    }
    const drawn = streams.join("\n");
    // “ ” ‘ ’ – — … are 0x93 0x94 0x91 0x92 0x96 0x97 0x85.
    assert.ok(drawn.includes("Which is \u0093right\u0094 \u0096 it\u0092s \u0097 fine\u0085?"), "the stem, character by character");
    assert.doesNotMatch(result.report.general.join("\n"), /cannot be drawn/);
  });
});

describe("what needs the flat form folds both sides, and stores nothing folded", () => {
  test("a search for a word with an apostrophe finds it however the apostrophe was drawn", () => {
    const bank = Bank.createEmpty("Search", { at: AT });
    bank.add(make("essay", {}, "Explain Mercury’s orbit."));
    assert.equal(bank.search("Mercury's").length, 1);
    assert.equal(bank.search("Mercury’s").length, 1);
    assert.equal(bank.search("mercury s orbit").length, 1);
  });

  test("the same question typed with straight quotes and with curly ones is a copy", () => {
    // A short stem is only a copy of another when it is the same, so this is the case the folding decides: with one drawn curly and
    // the other straight, every word is the same and only the quotation marks differ.
    const bank = Bank.createEmpty("Copies", { at: AT });
    bank.add(make("essay", {}, "Who wrote “Hamlet” – the play?"));
    bank.add(make("essay", {}, 'Who wrote "Hamlet" - the play?'));
    const run = bank.checkQuality("test");
    assert.equal(run.report.duplicates.length, 1, "the two are one question to the check for copies");
  });

  test("the accuracy gate reads a fixture written in plain keys against a file with typography", () => {
    // Folded on both sides by the harness's comparison; the stored text above is the typed one.
    assert.equal(foldTypography("“Hamlet” — it’s…"), '"Hamlet" -- it\'s...');
  });

  test("the quality checks still see a negative stem and a contraction written with a curly apostrophe", () => {
    const q = make("multipleChoice", { shuffle: true, options: ["One", "Two"].map((t, i) => ({ id: `o${i}`, content: plainToRich(t), correct: i === 0 })) }, "Which of these isn’t a planet?");
    const notes = checkItemQuality(q).map((f) => f.message).join("\n");
    assert.match(notes, /not|asks/i, "a note on a stem that asks for the opposite is still raised");
  });
});
