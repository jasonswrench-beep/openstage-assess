/**
 * Text that no file format will take, exported anyway.
 *
 * A question carries what was pasted into it: a form feed from a PDF, a vertical tab from Word, a stray control character, half of a
 * surrogate pair from a damaged copy. XML 1.0, which Moodle, QTI and Common Cartridge are written in, forbids all of them, so one
 * such character in one question made an LMS refuse the whole file as not well formed. A search of 12,600 exports of awkward text
 * found it in all three XML formats (the stem, an option, a title, a name) and a control character in each of the text and
 * spreadsheet formats. They are removed at the door of every exporter and when a question's text is first stored, and nothing else
 * is changed: markup, quotes, emoji, right to left text and an equals sign at the start of a cell all come out as they went in.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { unzipSync } from "../src/container/zip.ts";
import { exportBlackboardUpload } from "../src/export/blackboard-upload.ts";
import { exportCommonCartridge } from "../src/export/common-cartridge.ts";
import { exportD2lCsv } from "../src/export/d2l-csv.ts";
import { exportGift } from "../src/export/gift.ts";
import { checkMoodleXml, cdata, escapeXml, exportMoodleXml } from "../src/export/moodle-xml.ts";
import { exportOpenStageSpreadsheet } from "../src/export/openstage-spreadsheet.ts";
import { exportQti12 } from "../src/export/qti12.ts";
import { exportable, safeName } from "../src/export/text.ts";
import { parseXml } from "../src/import/docx/xml.ts";
import { createQuestion } from "../src/model/create.ts";
import type { Question } from "../src/model/question.ts";
import { printOptions, printTest } from "../src/print/index.ts";
import { normalizeCharacters, plainToRich, richTextToPlain, stripInvalidCharacters } from "../src/model/richtext.ts";

const FORBIDDEN_IN_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const FORBIDDEN_IN_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f￾￿]/;
const DIRTY = "nul\u0000 bell\u0007 vt\u000bfoo ff\u000cbar esc\u001b del\u007f lone\ud800 low\udc00 end￾￿";

describe("stripInvalidCharacters", () => {
  test("removes the control characters, the lone halves of a surrogate pair, and U+FFFE and U+FFFF", () => {
    assert.equal(stripInvalidCharacters("a\u0000b\u0001c\u0008d\u000ee\u001ff\u007fg"), "abcdefg");
    assert.equal(stripInvalidCharacters("high\ud800 and low\udc00 alone"), "high and low alone");
    assert.equal(stripInvalidCharacters("\ud800𐀀\udc00"), "𐀀", "a pair between two strays keeps the pair");
    assert.equal(stripInvalidCharacters("x￾y￿z"), "xyz");
  });

  test("turns a vertical tab and a form feed into a space, which are a line break and a page break and must not join two words", () => {
    assert.equal(stripInvalidCharacters("end of one\u000bstart of next"), "end of one start of next");
    assert.equal(stripInvalidCharacters("page one\u000cpage two"), "page one page two");
  });

  test("leaves a tab, a line break and a carriage return, which are text", () => {
    assert.equal(stripInvalidCharacters("a\tb\nc\rd"), "a\tb\nc\rd");
  });

  test("leaves everything else: letters of every script, emoji and their joiners, marks, quotes, markup and the start of a formula", () => {
    const fine = "Plain, éè שלום مرحبا 中文 \u{1F600} \u{1F468}‍\u{1F469}‍\u{1F467} <b>\"q\" & 'a'</b> ]]> =SUM(A1) \u0085 ﻿ end";
    assert.equal(stripInvalidCharacters(fine), fine);
  });

  test("is part of the first normalisation of text, so a question never stores them", () => {
    assert.equal(normalizeCharacters("a\u0000b\u000cc"), "ab c");
    const q = createQuestion({ type: "essay", stem: plainToRich(`Stem ${DIRTY}`), body: {} });
    assert.equal(richTextToPlain(q.stem), "Stem nul bell vt foo ff bar esc del lone low end");
  });
});

describe("exportable: the questions as they are written to a file", () => {
  const dirty = (): Question =>
    createQuestion({
      type: "shortAnswer",
      stem: plainToRich("A stem"),
      title: `Title ${DIRTY}`,
      body: { caseSensitive: false, accepted: [`Answer ${DIRTY}`, "clean"] },
      metadata: { tags: [`tag ${DIRTY}`], status: "draft" },
    });

  test("cleans every string anywhere in a question, and leaves the original as it was", () => {
    const original = dirty();
    const before = JSON.stringify(original);
    const [cleaned] = exportable([original]) as Question[];
    assert.equal(JSON.stringify(original), before, "the question given is not changed");
    assert.equal(cleaned?.title, "Title nul bell vt foo ff bar esc del lone low end");
    assert.deepEqual((cleaned?.body as { accepted: string[] }).accepted, ["Answer nul bell vt foo ff bar esc del lone low end", "clean"]);
    assert.deepEqual(cleaned?.metadata.tags, ["tag nul bell vt foo ff bar esc del lone low end"]);
    assert.equal(cleaned?.id, original.id, "and it is the same question");
  });

  test("returns the very same list when nothing needs cleaning, so a big bank is not copied for nothing", () => {
    const clean = [createQuestion({ type: "essay", stem: plainToRich("Fine"), body: {} })];
    assert.equal(exportable(clean), clean);
  });

  test("copies only the questions that need it", () => {
    const fine = createQuestion({ type: "essay", stem: plainToRich("Fine"), body: {} });
    const both = exportable([fine, dirty()]);
    assert.equal(both[0], fine, "a clean question is the same object");
    assert.notEqual(both[1], undefined);
  });
});

describe("the XML formats", () => {
  const stems = (): Question[] => [
    createQuestion({ type: "multipleChoice", stem: plainToRich(`Which? ${DIRTY}`), title: `T ${DIRTY}`, body: { shuffle: true, options: [`One ${DIRTY}`, "Two"].map((t, i) => ({ id: `o${i}`, content: plainToRich(t), correct: i === 0, ...(i === 0 ? { feedback: plainToRich(`Right ${DIRTY}`) } : {}) })) } as never }),
    createQuestion({ type: "shortAnswer", stem: plainToRich(`Name it ${DIRTY}`), body: { caseSensitive: false, accepted: [`Ans ${DIRTY}`] } }),
    createQuestion({ type: "matching", stem: plainToRich("Match"), body: { shuffle: true, distractors: [`Extra ${DIRTY}`], pairs: [{ id: "p1", left: plainToRich(`L1 ${DIRTY}`), right: `R1 ${DIRTY}` }, { id: "p2", left: plainToRich("L2"), right: "R2" }] } as never }),
    createQuestion({ type: "trueFalse", stem: plainToRich(`True? ${DIRTY}`), body: { correct: true } }),
  ];

  /** Every XML file an export wrote, as text. */
  const xmlOf = (files: Array<{ name: string; content?: string; bytes?: Uint8Array }>): Array<[string, string]> => {
    const out: Array<[string, string]> = [];
    for (const file of files) {
      if (file.content !== undefined && /\.xml$/i.test(file.name)) out.push([file.name, file.content]);
      if (file.bytes) for (const [inner, data] of unzipSync(file.bytes)) if (/\.xml$/i.test(inner)) out.push([`${file.name}/${inner}`, Buffer.from(data).toString("utf8")]);
    }
    return out;
  };

  for (const [label, run] of [
    ["Moodle XML", (qs: Question[]) => exportMoodleXml(qs, { name: `Bank ${DIRTY}` })],
    ["a QTI 1.2 package", (qs: Question[]) => exportQti12(qs, { name: `Bank ${DIRTY}` })],
    ["a Common Cartridge package", (qs: Question[]) => exportCommonCartridge(qs, { name: `Bank ${DIRTY}` })],
  ] as const) {
    test(`${label} has nothing XML forbids, and is well formed, whatever the text held`, () => {
      const written = xmlOf(run(stems()).files as never);
      assert.ok(written.length > 0, "an XML file was written");
      for (const [name, xml] of written) {
        assert.doesNotMatch(xml, FORBIDDEN_IN_XML, `${name} holds a character XML does not allow`);
        assert.doesNotThrow(() => parseXml(xml.replace(/^<!DOCTYPE[^>]*>/m, "")), `${name} is not well formed`);
      }
    });

    test(`${label} keeps the words on either side of what was taken out`, () => {
      const joined = xmlOf(run(stems()).files as never).map(([, xml]) => xml).join("\n");
      assert.match(joined, /Which\? nul bell vt foo ff bar esc del lone low end/);
      assert.doesNotMatch(joined, /ffesc|vtff|nulbell/, "a vertical tab and a form feed did not join two words");
    });
  }

  test("the escape and the CDATA wrapper are safe on their own, for text that goes into a file by another way", () => {
    assert.doesNotMatch(escapeXml(DIRTY), FORBIDDEN_IN_XML);
    assert.doesNotMatch(cdata(DIRTY), FORBIDDEN_IN_XML);
    assert.equal(escapeXml("a < b & \"c\""), "a &lt; b &amp; &quot;c&quot;");
    assert.equal(cdata("x ]]> y"), "<![CDATA[x ]]]]><![CDATA[> y]]>");
  });

  test("the destination check says what the export writes: the same report, with the cleaned text", () => {
    const qs = stems();
    assert.deepEqual(checkMoodleXml(qs, { name: "x" }), exportMoodleXml(qs, { name: "x" }).report);
  });
});

describe("the text and spreadsheet formats", () => {
  const qs = (): Question[] => [
    createQuestion({ type: "multipleChoice", stem: plainToRich(`Which? ${DIRTY}`), title: `T ${DIRTY}`, body: { shuffle: true, options: [`One ${DIRTY}`, "Two"].map((t, i) => ({ id: `o${i}`, content: plainToRich(t), correct: i === 0 })) } as never }),
    createQuestion({ type: "shortAnswer", stem: plainToRich("Name it"), body: { caseSensitive: false, accepted: [`Ans ${DIRTY}`] } }),
  ];

  for (const [label, run] of [
    ["Brightspace CSV", (q: Question[]) => exportD2lCsv(q, { name: `B ${DIRTY}` })],
    ["Blackboard", (q: Question[]) => exportBlackboardUpload(q, { name: `B ${DIRTY}` })],
    ["the question spreadsheet", (q: Question[]) => exportOpenStageSpreadsheet(q, { name: `B ${DIRTY}` })],
    ["GIFT", (q: Question[]) => exportGift(q, { name: `B ${DIRTY}` })],
  ] as const) {
    test(`${label} has no control character in its text or its file name, and keeps the words`, () => {
      const result = run(qs());
      for (const file of result.files) {
        assert.doesNotMatch(file.name, FORBIDDEN_IN_TEXT, `${file.name}: a control character in the name`);
        const text = file.content ?? Buffer.from(file.bytes as Uint8Array).toString("utf8");
        assert.doesNotMatch(text, FORBIDDEN_IN_TEXT, `${file.name}: a control character in the text`);
        assert.match(text, /nul bell vt foo ff bar esc del lone low end/);
      }
    });
  }

  test("safeName takes them out of a file name too", () => {
    assert.equal(safeName(`Bank ${DIRTY}`), "Bank nul bell vt foo ff bar esc del lone low end");
    assert.equal(safeName("\u0000￾"), "questions", "a name that was all of them is no name");
  });

  test("safeName takes the dots at the start together with the space they leave, and keeps a device's name from being one", () => {
    assert.equal(safeName(". Intro to Psych"), "Intro to Psych");
    assert.equal(safeName(".. Chapter 3"), "Chapter 3");
    assert.equal(safeName("Aux. Verbs"), "Aux_. Verbs");
    assert.equal(safeName("Con. Ed. 101"), "Con_. Ed. 101");
    assert.equal(safeName("nul"), "nul_", "an extension after a bare device name is the device as well");
    assert.equal(safeName(`${"x".repeat(79)}. y`), "x".repeat(79), "a cut that ends in a dot is tidied after the cut");
  });
});

describe("a printed Word test", () => {
  test("has nothing XML forbids in any part, so that Word opens it without offering to repair it", () => {
    const qs = [
      createQuestion({ type: "multipleChoice", stem: plainToRich(`Which? ${DIRTY}`), title: `T ${DIRTY}`, body: { shuffle: true, options: [`One ${DIRTY}`, "Two"].map((t, i) => ({ id: `o${i}`, content: plainToRich(t), correct: i === 0 })) } as never }),
      createQuestion({ type: "shortAnswer", stem: plainToRich(`Name ${DIRTY}`), body: { caseSensitive: false, accepted: [`Ans ${DIRTY}`] } }),
    ];
    for (const kind of ["student", "key"] as const) {
      const printed = printTest(qs, printOptions({ title: `Test ${DIRTY}`, kind }), "docx");
      assert.doesNotMatch(printed.file.name, FORBIDDEN_IN_TEXT);
      let parts = 0;
      for (const [name, data] of unzipSync(printed.file.bytes)) {
        if (!/\.(xml|rels)$/i.test(name)) continue;
        const xml = Buffer.from(data).toString("utf8");
        assert.doesNotMatch(xml, FORBIDDEN_IN_XML, `${kind}: ${name} holds a character XML does not allow`);
        assert.doesNotThrow(() => parseXml(xml), `${kind}: ${name} is not well formed`);
        parts++;
      }
      assert.ok(parts >= 5, "the parts of the document were checked");
      const body = Buffer.from(unzipSync(printed.file.bytes).get("word/document.xml") as Uint8Array).toString("utf8");
      assert.match(body, /nul bell vt foo ff bar esc del lone low end/, "the words are there, not joined");
    }
  });
});

describe("what is not touched", () => {
  test("markup, quotes, emoji, right to left text and a leading equals sign come out as they went in", () => {
    const stem = "<b>Bold</b> & \"quoted\" 'text' \u{1F600} שלום ]]> end";
    const q = createQuestion({ type: "multipleChoice", stem: plainToRich(stem), body: { shuffle: true, options: ["=SUM(A1)", "+1"].map((t, i) => ({ id: `o${i}`, content: plainToRich(t), correct: i === 0 })) } as never });
    const xml = exportMoodleXml([q], { name: "Fine" }).files[0]?.content ?? "";
    // The stem is HTML in a CDATA: the markup is kept as markup, the text is escaped by the HTML, and the end of a CDATA is split.
    assert.ok(xml.includes("<b>Bold</b> &amp; \"quoted\" 'text' \u{1F600} שלום ]]]]><![CDATA[> end") || xml.includes("&lt;b&gt;Bold&lt;/b&gt;"), "the markup in the stem is kept or escaped, never lost");
    assert.ok(xml.includes("\u{1F600}") && xml.includes("שלום"));
    assert.equal((xml.match(/<!\[CDATA\[/g) ?? []).length, (xml.match(/\]\]>/g) ?? []).length, "every CDATA is closed once, whatever ]]> the text held");
    assert.ok(xml.includes("=SUM(A1)"));
    assert.doesNotThrow(() => parseXml(xml));
  });
});
