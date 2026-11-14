/**
 * A bank can come from a colleague, a publisher or a shared folder, so the formatting and the equations of its questions are cleaned
 * as it is opened, with the sanitiser that creating and editing a question use, and every exporter cleans them again before it writes
 * (the security review of 2026-11-13). Before that, a question file put in a bank by hand kept a script, an event attribute or a link
 * as it was, and an exporter wrote it into a file an LMS would show to students.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { Bank, cleanedMessage } from "../src/bank/store.ts";
import { unzipSync, zipSync } from "../src/container/zip.ts";
import { exportBlackboardUpload } from "../src/export/blackboard-upload.ts";
import { exportCommonCartridge } from "../src/export/common-cartridge.ts";
import { exportD2lCsv } from "../src/export/d2l-csv.ts";
import { exportGift } from "../src/export/gift.ts";
import { exportMoodleXml } from "../src/export/moodle-xml.ts";
import { exportOpenStageSpreadsheet } from "../src/export/openstage-spreadsheet.ts";
import { exportQti12 } from "../src/export/qti12.ts";
import { exportQti21 } from "../src/export/qti21.ts";
import type { ExportResult } from "../src/export/types.ts";
import { MATHML_NS } from "../src/model/mathml.ts";
import { createQuestion } from "../src/model/create.ts";
import type { Question } from "../src/model/question.ts";
import { mathPlaceholder, plainToRich, rich } from "../src/model/richtext.ts";

const AT = "2026-01-01T00:00:00.000Z";
const M = (inside: string): string => `<math xmlns="${MATHML_NS}">${inside}</math>`;

const HOSTILE_STEM =
  '<p>Which planet is largest?<script>alert("stem")</script><img src="x" onerror="alert(1)"> <a href="javascript:alert(2)">Read this</a>' +
  ' <span onclick="alert(3)" style="color:red">first</span> <iframe src="https://example.invalid"></iframe></p>';
const HOSTILE_OPTION = '<p>Jupiter<svg onload="alert(4)"><circle r="1"/></svg></p>';
const HOSTILE_MATH = M('<mi href="javascript:alert(5)">x</mi><semantics><mn>2</mn><annotation-xml encoding="text/html"><img src="x" onerror="alert(6)"/></annotation-xml></semantics>');

/** What no file written from a cleaned question may hold. */
const FORBIDDEN = [/<script/i, /onerror/i, /onclick/i, /onload/i, /javascript:/i, /<iframe/i, /<svg/i, /annotation-xml/i, /example\.invalid/i, /alert\(/];

function cleanQuestion(): Question {
  return createQuestion({
    type: "multipleChoice",
    stem: rich(`<p>Which planet is largest? ${mathPlaceholder("e1")}</p>`),
    body: {
      shuffle: false,
      options: [
        { id: "o0", content: plainToRich("Jupiter"), correct: true },
        { id: "o1", content: plainToRich("Mars"), correct: false },
      ],
    } as never,
    math: [{ id: "e1", latex: "x2", mathml: M("<mi>x</mi><mn>2</mn>") }],
    title: "Largest planet",
    by: "test",
    at: AT,
  });
}

/** The question as a hand-edited file would hold it: the same question with markup no editor in the program could have written. */
function hostileCopy(q: Question): Question {
  const copy = structuredClone(q) as Question & { body: { options: Array<{ content: { format: string; content: string } }> } };
  copy.stem = { format: "rich", content: `${HOSTILE_STEM}<p>${mathPlaceholder("e1")}</p>` };
  (copy.body.options[0] as { content: { format: string; content: string } }).content = { format: "rich", content: HOSTILE_OPTION };
  copy.math = [{ id: "e1", latex: "x2", mathml: HOSTILE_MATH }];
  return copy;
}

/** A bank file with the questions given, written by the program and then with the first question's file replaced, as a person could. */
function bankWith(first: Question, others: Question[] = []): Uint8Array {
  const bank = Bank.createEmpty("Probe", { at: AT });
  const placed = bank.add(cleanQuestion());
  for (const q of others) bank.add(q);
  const files = unzipSync(bank.toBytes({ at: AT }));
  const name = [...files.keys()].find((n) => n.includes(placed.id));
  assert.ok(name, "the question's file is in the bank");
  files.set(name, new TextEncoder().encode(JSON.stringify({ ...first, id: placed.id })));
  return zipSync([...files].map(([n, data]) => ({ name: n, data })));
}

/** Every file an export wrote, as text, with the files inside a zip read out. */
function textOf(result: ExportResult): string {
  return result.files
    .flatMap((f) => (f.bytes ? [...unzipSync(f.bytes).values()].map((b) => Buffer.from(b).toString("utf8")) : [f.content]))
    .join("\n");
}

const EXPORTERS: Array<[string, (q: Question[]) => ExportResult]> = [
  ["Moodle XML", (q) => exportMoodleXml(q, { name: "Probe" })],
  ["QTI 1.2", (q) => exportQti12(q, { name: "Probe" })],
  ["QTI 2.1", (q) => exportQti21(q, { name: "Probe" })],
  ["Common Cartridge", (q) => exportCommonCartridge(q, { name: "Probe" })],
  ["the Brightspace CSV", (q) => exportD2lCsv(q, { name: "Probe" })],
  ["GIFT", (q) => exportGift(q, { name: "Probe" })],
  ["the Blackboard upload file", (q) => exportBlackboardUpload(q, { name: "Probe" })],
  ["the OpenStage spreadsheet", (q) => exportOpenStageSpreadsheet(q, { name: "Probe" })],
];

describe("a bank whose question file holds a script, event attributes, links and MathML off the list", () => {
  const opened = Bank.fromBytes(bankWith(hostileCopy(cleanQuestion()), [createQuestion({ type: "essay", stem: plainToRich("Discuss Saturn's rings."), body: {}, by: "test", at: AT })]));
  const question = opened.bank.sortedQuestions().find((q) => q.title === "Largest planet") as Question;

  test("opens, with the question in it and the report saying one question was cleaned", () => {
    assert.ok(question, "the question opened");
    assert.equal(opened.bank.sortedQuestions().length, 2);
    assert.deepEqual(opened.report.cleaned, { questions: 1 });
    assert.match(cleanedMessage({ questions: 1 }), /^Some formatting in 1 question was removed/);
    assert.match(cleanedMessage({ questions: 2 }), /^Some formatting in 2 questions was removed/);
  });

  test("holds none of it once open, and keeps the words", () => {
    const stored = JSON.stringify(question);
    for (const pattern of FORBIDDEN) assert.doesNotMatch(stored, pattern, `${pattern} is still in the question`);
    assert.match(question.stem.content, /Which planet is largest\?/);
    assert.match(question.stem.content, /Read this/, "the words of the link are kept, without the link");
    assert.match(question.stem.content, /first/);
    assert.equal(question.math[0]?.mathml, M("<mi>x</mi><mn>2</mn>"));
  });

  test("and the question saved and opened again is the same, with nothing more to clean", () => {
    const again = Bank.fromBytes(opened.bank.toBytes({ at: AT }));
    assert.equal(again.report.cleaned, undefined);
    assert.deepEqual(again.bank.get(question.id), question);
  });

  test("a question with only its formatting to clean, or only an equation, is counted", () => {
    const formattingOnly = { ...cleanQuestion(), stem: { format: "rich", content: `${HOSTILE_STEM}<p>${mathPlaceholder("e1")}</p>` } } as Question;
    const equationOnly = { ...cleanQuestion(), math: [{ id: "e1", latex: "x2", mathml: HOSTILE_MATH }] } as Question;
    for (const [what, q] of [["formatting", formattingOnly], ["an equation", equationOnly]] as const) {
      const report = Bank.fromBytes(bankWith(q)).report;
      assert.deepEqual(report.cleaned, { questions: 1 }, `a question with only ${what} to clean`);
    }
  });

  test("a bank with nothing to clean says nothing, and its questions are as they were written", () => {
    const plain = Bank.fromBytes(bankWith(cleanQuestion()));
    assert.equal(plain.report.cleaned, undefined);
    const q = plain.bank.sortedQuestions()[0] as Question;
    assert.equal(q.stem.content, cleanQuestion().stem.content);
  });

  test("a question file that is not an object at all is refused as before, and does not stop the bank opening", () => {
    const damaged = Bank.fromBytes(bankWith(null as unknown as Question, [createQuestion({ type: "essay", stem: plainToRich("Still here."), body: {}, by: "test", at: AT })]));
    assert.equal(damaged.bank.sortedQuestions().length, 1);
    assert.equal(damaged.report.cleaned, undefined);
  });
});

describe("every exporter, handed a question that never went through a bank", () => {
  const handed = hostileCopy(cleanQuestion());

  for (const [name, run] of EXPORTERS) {
    test(`${name} writes none of the script, event attributes, links or MathML off the list, and keeps the words`, () => {
      const text = textOf(run([handed]));
      assert.ok(text.length > 0);
      for (const pattern of FORBIDDEN) assert.doesNotMatch(text, pattern, `${name} wrote ${pattern}`);
      assert.match(text, /Which planet is largest/);
      assert.match(text, /Jupiter/);
    });
  }

  test("and a question with nothing to clean is handed to the exporter as the same object", () => {
    const q = cleanQuestion();
    const before = JSON.stringify(q);
    for (const [, run] of EXPORTERS) run([q]);
    assert.equal(JSON.stringify(q), before, "no exporter changed the question it was given");
  });
});
