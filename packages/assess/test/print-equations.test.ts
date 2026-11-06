/**
 * Equations on a printed test.
 *
 * An equation used to be printed as the words "[Equation: LaTeX]" with a note. A Word file now carries it as an equation, from the copy
 * of Word's own XML the bank kept, so that a printed test is as good as the test that was imported; a PDF has no fonts for one and
 * still prints the words, with the note. Because a bank is a file a person can edit by hand, the stored XML is read again by the reader
 * that made it before it is written into a printed document, and what it does not understand is words and not markup.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { unzipSync } from "../src/container/zip.ts";
import { cleanOmml } from "../src/import/docx/omml.ts";
import { parseXml } from "../src/import/docx/xml.ts";
import { wordImporter } from "../src/import/word.ts";
import { createQuestion } from "../src/model/create.ts";
import { mathPlaceholder, plainToRich, rich } from "../src/model/richtext.ts";
import type { Question } from "../src/model/question.ts";
import { printOptions, printTest } from "../src/print/index.ts";
import { docx, paragraph, run } from "./support/docx-writer.ts";

const AT = new Date("2026-02-03T04:05:06Z");
const OPTIONS = { file: "t.docx", at: "2026-01-01T00:00:00.000Z", author: "test" };
const text = (bytes: Uint8Array | undefined): string => Buffer.from(bytes ?? new Uint8Array()).toString("utf8");

/** A question made by importing a Word file, so that the equation is the one a real import keeps. */
function imported(): Question {
  const body =
    paragraph(run("1. Solve ") + "<m:oMath><m:f><m:fPr><m:ctrlPr/></m:fPr><m:num><m:r><m:t>x</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f><m:r><m:t>=3</m:t></m:r></m:oMath>" + run(" for x.")) +
    paragraph(run("a) 6")) +
    paragraph(run("b) 5")) +
    paragraph(run("Answer: a"));
  const q = wordImporter.parseBytes(docx({ body }), OPTIONS).questions[0] as Question;
  assert.equal(q.math.length, 1);
  return q;
}

const opts = (more: Record<string, unknown> = {}) => printOptions({ title: "Maths", kind: "student", ...more });
const documentOf = (bytes: Uint8Array): string => text(unzipSync(bytes).get("word/document.xml"));

describe("an equation in the Word file", () => {
  const q = imported();
  const made = printTest([q], opts(), "docx", AT);
  const document = documentOf(made.file.bytes);

  test("is written as the equation it is, with its parts, and not as the words of its LaTeX", () => {
    assert.match(document, /<m:oMath xmlns:m="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/math"><m:f>/);
    assert.ok(document.includes("<m:num><m:r><m:t xml:space=\"preserve\">x</m:t></m:r></m:num>"));
    assert.ok(!document.includes("[Equation"), "no words stand in its place");
    assert.ok(!document.includes("\\frac"), "and no LaTeX is printed");
  });

  test("stands in the line of the question, between the words around it", () => {
    const at = (needle: string) => document.indexOf(needle);
    assert.ok(at("Solve") < at("<m:oMath") && at("<m:oMath") < at("for x."), "words, equation, words");
  });

  test("makes a document that is well formed, and says nothing was lost", () => {
    assert.doesNotThrow(() => parseXml(document));
    assert.ok(!made.report.items.some((i) => i.notes.some((n) => /equation/.test(n))), JSON.stringify(made.report.items));
  });

  test("reads back from the printed test as the same equation", () => {
    const back = wordImporter.parseBytes(made.file.bytes, { file: "printed.docx" });
    const first = back.questions[0] as Question | undefined;
    assert.ok(first, "the printed test reads back as a question");
    assert.deepEqual(first.math.map((m) => m.latex), [q.math[0]!.latex]);
    assert.equal(first.math[0]!.omml, q.math[0]!.omml);
  });

  test("is on the answer key as well", () => {
    const key = documentOf(printTest([q], opts({ kind: "key" }), "docx", AT).file.bytes);
    assert.ok(key.includes("<m:f>") && !key.includes("[Equation"));
  });
});

describe("an equation in the PDF", () => {
  test("is the words of its LaTeX, and the note says so, because a PDF has no fonts for one", () => {
    const q = imported();
    const made = printTest([q], opts(), "pdf", AT);
    assert.ok(made.report.items.some((i) => i.notes.some((n) => /1 equation printed as \[Equation: LaTeX\]/.test(n))), JSON.stringify(made.report.items));
    assert.ok(Buffer.from(made.file.bytes).toString("latin1").includes("%PDF"));
  });
});

describe("an equation that is not Word's", () => {
  const withMath = (math: Question["math"], stem = `<p>Solve ${mathPlaceholder("e1")} now.</p>`): Question =>
    createQuestion({
      type: "multipleChoice",
      stem: rich(stem),
      body: { shuffle: false, options: ["A", "B"].map((t, i) => ({ id: `o${i}`, content: plainToRich(t), correct: i === 0 })) } as never,
      math,
      by: "test",
      at: "2026-01-01T00:00:00.000Z",
    });
  const M = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';

  test("one typed by hand, with no copy of Word's XML, is its words in the Word file, and is counted", () => {
    const q = withMath([{ id: "e1", latex: "x^{2}", mathml: "<math/>" }]);
    const made = printTest([q], opts(), "docx", AT);
    const document = documentOf(made.file.bytes);
    assert.ok(document.includes("[Equation: x^{2}]"));
    assert.ok(!document.includes("<m:oMath"));
    assert.ok(made.report.items.some((i) => i.notes.some((n) => /1 equation printed as/.test(n))));
  });

  test("a stored copy that holds anything the reader does not know is words, and none of it reaches the document", () => {
    const hostile = `<m:oMath ${M}><m:r><m:t>x</m:t></m:r><w:fldSimple xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" w:instr="DDEAUTO c:\\\\windows\\\\system32\\\\cmd.exe"/></m:oMath>`;
    const q = withMath([{ id: "e1", latex: "x", mathml: "<math/>", omml: hostile }]);
    const document = documentOf(printTest([q], opts(), "docx", AT).file.bytes);
    assert.ok(!document.includes("DDEAUTO") && !document.includes("fldSimple") && !document.includes("<m:oMath"));
    assert.ok(document.includes("[Equation: x]"));
  });

  test("a stored copy that is not well formed, not an equation, or far too large is words", () => {
    for (const omml of ["<m:oMath", "<w:p>not an equation</w:p>", `<m:oMath ${M}>` + "<m:r><m:t>x</m:t></m:r>".repeat(20_000) + "</m:oMath>"]) {
      const q = withMath([{ id: "e1", latex: "x", mathml: "<math/>", omml }]);
      const document = documentOf(printTest([q], opts(), "docx", AT).file.bytes);
      assert.ok(document.includes("[Equation: x]"), omml.slice(0, 30));
      assert.ok(!document.includes("<m:oMath"));
    }
  });

  test("a copy written by hand that uses only what the reader knows is written out again, by the reader", () => {
    const own = `<m:oMath ${M}><m:sSup><m:sSupPr><m:ctrlPr/></m:sSupPr><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:oMath>`;
    const q = withMath([{ id: "e1", latex: "x^{2}", mathml: "<math/>", omml: own }]);
    const document = documentOf(printTest([q], opts(), "docx", AT).file.bytes);
    assert.ok(document.includes("<m:sSup><m:sSupPr></m:sSupPr><m:e><m:r><m:t xml:space=\"preserve\">x</m:t></m:r></m:e>"), document.slice(document.indexOf("<m:oMath"), document.indexOf("<m:oMath") + 300));
  });
});

describe("cleaning a stored copy", () => {
  const M = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';
  test("returns the copy the reader writes, the same one again when it is already that", () => {
    const q = imported();
    const once = cleanOmml(q.math[0]!.omml!);
    assert.equal(once, q.math[0]!.omml);
    assert.equal(cleanOmml(once!), once);
  });

  test("refuses what is not an equation of this reader's", () => {
    assert.equal(cleanOmml(""), undefined);
    assert.equal(cleanOmml("<m:oMath"), undefined);
    assert.equal(cleanOmml(`<m:oMath ${M}><m:other/></m:oMath>`), undefined);
    assert.equal(cleanOmml(`<m:oMathPara ${M}/>`), undefined);
  });
});
