/**
 * Text that Word hides, and text in boxes. Both are text a person reading the document on a page does not take for part of a
 * question, so neither is read; the file says how much there was and quotes the first, so that a question or a key left in
 * one is looked for and not lost. Hidden text is a toggle like bold (a hidden paragraph style under a hidden character style
 * shows the text again), a hidden paragraph that has no text left is not a blank line, and it still takes its number in a
 * list: those three were asked of Word itself, see test/tools/word-formatting-check.ts and word-numbering-check.ts. These
 * tests use invented text.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { docxToBlocks, wordImporter } from "../src/import/word.ts";
import { FindingCode, verdictFrom } from "../src/model/findings.ts";
import type { Question } from "../src/model/question.ts";
import { abstractNum, docx, level, listProperties, num, numberingPart, paragraph, run, table } from "./support/docx-writer.ts";

const OPTIONS = { file: "t.docx", at: "2026-01-01T00:00:00.000Z", author: "test" };
const HIDE = "<w:vanish/>";
const MARK_HIDDEN = `<w:rPr>${HIDE}</w:rPr>`;

const NORMAL = '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>';
const paragraphStyle = (id: string, props: string, basedOn = "Normal"): string =>
  `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${id}"/><w:basedOn w:val="${basedOn}"/><w:rPr>${props}</w:rPr></w:style>`;
const characterStyle = (id: string, props: string): string => `<w:style w:type="character" w:styleId="${id}"><w:name w:val="${id}"/><w:rPr>${props}</w:rPr></w:style>`;

const read = (body: string, styles?: string): ReturnType<typeof docxToBlocks> => docxToBlocks(docx({ body, ...(styles !== undefined ? { styles } : {}) }));
const texts = (body: string, styles?: string): string[] => read(body, styles).blocks.map((b) => b.text);
const hiddenFinding = (body: string, styles?: string): string | undefined => read(body, styles).findings.find((f) => /^Hidden text/.test(f.message))?.message;
const markFinding = (body: string, styles?: string): string | undefined => read(body, styles).findings.find((f) => /paragraph marks? (is|are) hidden/.test(f.message))?.message;

/** A paragraph that is hidden whole, as Word makes one when the paragraph is selected with its mark and hidden. */
const hiddenParagraph = (text: string, properties = ""): string => paragraph(run(text, HIDE), properties + MARK_HIDDEN);

describe("hidden text", () => {
  test("is not read, and the file says it was there and quotes it", () => {
    const body = paragraph(run("What is two plus two? ") + run("Answer: B", HIDE));
    assert.deepEqual(texts(body), ["What is two plus two? "]);
    const found = read(body).findings.filter((f) => f.code === FindingCode.UnreadContent);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.severity, "warn");
    assert.match(found[0]?.message ?? "", /^Hidden text was left out of 1 paragraph, for example "Answer: B"\. /);
    assert.match(found[0]?.message ?? "", /untick Hidden/, "it says how to bring the text back");
  });

  test("is counted by paragraph, and the quote is the first, cut at sixty characters", () => {
    const long = "Hidden note to myself that goes on and on and on for far longer than a finding should quote";
    const body = paragraph(run("one ") + run(long, HIDE)) + paragraph(run("two ") + run("second", HIDE)) + paragraph(run("three ") + run("third", HIDE));
    const said = hiddenFinding(body) ?? "";
    assert.match(said, /left out of 3 paragraphs, for example "Hidden note to myself that goes on and on and on for far\.\.\."\. /);
    assert.ok(!said.includes("second"));
  });

  test("says nothing when nothing is hidden, or when hiding is switched off", () => {
    assert.equal(hiddenFinding(paragraph(run("plain text"))), undefined);
    for (const off of ['<w:vanish w:val="0"/>', '<w:vanish w:val="false"/>', '<w:vanish w:val="off"/>']) {
      const body = paragraph(run("shown", off));
      assert.deepEqual(texts(body), ["shown"], off);
      assert.equal(hiddenFinding(body), undefined, off);
    }
  });

  test("a hidden tab or space is left out without a finding, since there was no text", () => {
    const body = paragraph(run("a") + `<w:r><w:rPr>${HIDE}</w:rPr><w:tab/></w:r>` + run("   ", HIDE) + run("b"));
    assert.deepEqual(texts(body), ["ab"]);
    assert.equal(hiddenFinding(body), undefined);
  });

  test("by a character style, and a paragraph style that is not undone", () => {
    const styles = NORMAL + characterStyle("Secret", HIDE) + paragraphStyle("Note", HIDE);
    const viaCharacter = paragraph(run("seen ") + run("not seen", `<w:rStyle w:val="Secret"/>`));
    assert.deepEqual(texts(viaCharacter, styles), ["seen "]);
    assert.match(hiddenFinding(viaCharacter, styles) ?? "", /for example "not seen"/);

    const viaParagraph = paragraph(run("whole paragraph"), '<w:pStyle w:val="Note"/><w:rPr><w:vanish w:val="0"/></w:rPr>');
    assert.deepEqual(texts(viaParagraph, styles), [""], "the text is hidden and the mark is shown, so a blank line is left");
    assert.match(hiddenFinding(viaParagraph, styles) ?? "", /for example "whole paragraph"/);
  });

  test("is a toggle: a hidden paragraph style under a hidden character style shows the text again, as Word does", () => {
    const styles = NORMAL + characterStyle("Secret", HIDE) + paragraphStyle("Note", HIDE);
    const both = paragraph(run("shown again", '<w:rStyle w:val="Secret"/>'), '<w:pStyle w:val="Note"/><w:rPr><w:vanish w:val="0"/></w:rPr>');
    assert.deepEqual(texts(both, styles), ["shown again"]);
    const switchedOff = paragraph(run("shown", '<w:vanish w:val="0"/>'), '<w:pStyle w:val="Note"/><w:rPr><w:vanish w:val="0"/></w:rPr>');
    assert.deepEqual(texts(switchedOff, styles), ["shown"], "direct formatting wins");
    const inherited = paragraphStyle("NoteChild", "", "Note") + paragraphStyle("NoteOff", '<w:vanish w:val="0"/>', "Note");
    assert.deepEqual(texts(paragraph(run("child"), '<w:pStyle w:val="NoteChild"/><w:rPr><w:vanish w:val="0"/></w:rPr>'), styles + inherited), [""], "a style based on a hidden one is hidden");
    assert.deepEqual(texts(paragraph(run("off"), '<w:pStyle w:val="NoteOff"/><w:rPr><w:vanish w:val="0"/></w:rPr>'), styles + inherited), ["off"], "and can say it is not");
  });

  describe("a paragraph whose mark is hidden too", () => {
    test("is not a line at all, and not a blank one, when no text is left to show", () => {
      const body = paragraph(run("1. What is two plus two?")) + paragraph(run("A. Three")) + hiddenParagraph("a note to myself") + paragraph(run("B. Four"));
      assert.deepEqual(texts(body), ["1. What is two plus two?", "A. Three", "B. Four"]);
      assert.match(hiddenFinding(body) ?? "", /for example "a note to myself"/);
      assert.match(markFinding(body) ?? "", /^1 paragraph mark is hidden\. /);
    });

    test("an empty paragraph with a hidden mark goes the same way", () => {
      const body = paragraph(run("one")) + paragraph("", MARK_HIDDEN) + paragraph(run("two"));
      assert.deepEqual(texts(body), ["one", "two"]);
      assert.equal(hiddenFinding(body), undefined, "no text was hidden");
      assert.match(markFinding(body) ?? "", /1 paragraph mark is hidden/);
    });

    test("one that still shows text is read as it stands, and the file says its mark is hidden", () => {
      const body = paragraph(run("seen"), MARK_HIDDEN) + paragraph(run("next"));
      assert.deepEqual(texts(body), ["seen", "next"]);
      assert.match(markFinding(body) ?? "", /1 paragraph mark is hidden/);
      assert.equal(hiddenFinding(body), undefined);
    });

    test("with its text hidden and its mark shown is a blank line, as Word shows an empty line", () => {
      const body = paragraph(run("one")) + paragraph(run("note", HIDE)) + paragraph(run("two"));
      assert.deepEqual(texts(body), ["one", "", "two"]);
      assert.equal(markFinding(body), undefined);
    });

    test("in a table cell is kept as a blank line, since the end of a cell is joined to nothing", () => {
      const body = table([[hiddenParagraph("hidden in a cell")]]);
      const { blocks } = read(body);
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0]?.text, "");
      assert.ok(blocks[0]?.table);
    });
  });

  describe("in a list", () => {
    const numbering = numberingPart([abstractNum(1, [level(0, { text: "%1." })])], [num(1, 1)]);
    const item = (text: string, shown: boolean, mark: boolean): string =>
      paragraph(run(text, shown ? "" : HIDE), listProperties({ numId: 1, level: 0 }) + (mark ? MARK_HIDDEN : ""));
    const labels = (body: string): Array<[string | undefined, string]> =>
      docxToBlocks(docx({ body, numbering })).blocks.map((b) => [b.listLabel, b.text]);

    test("an item whose text is hidden keeps its number, and the items after it are not moved", () => {
      assert.deepEqual(labels(item("a", true, false) + item("b", false, false) + item("c", true, false)), [
        ["1.", "a"],
        ["2.", ""],
        ["3.", "c"],
      ]);
    });

    test("an item that is hidden whole is not a line, and still takes its number, as Word counts it", () => {
      assert.deepEqual(labels(item("a", true, false) + item("b", false, true) + item("c", true, false) + item("d", true, false)), [
        ["1.", "a"],
        ["3.", "c"],
        ["4.", "d"],
      ]);
    });
  });

  test("nothing hidden reaches a question or an orphan, and a key that was hidden is not taken for one", () => {
    const lines = ["1. What is two plus two?", "A. Three", "B. Four", "C. Five"];
    const visible = lines.map((l) => paragraph(run(l))).join("");

    // The only key is hidden: the question has none, and is refused, and the file says what was left out.
    const hiddenKey = wordImporter.parseBytes(docx({ body: visible + hiddenParagraph("Answer: B") + paragraph("") }), OPTIONS);
    const question = hiddenKey.questions[0] as Question;
    assert.equal(verdictFrom(question.findings), "failed");
    assert.ok((question.body as { options: Array<{ correct: boolean }> }).options.every((o) => !o.correct), "no option was marked");
    assert.match(hiddenKey.fileFindings.map((f) => f.message).join("\n"), /for example "Answer: B"/);

    // A key in view, and an old one left hidden: the visible one is the key, and the old one is nowhere.
    const both = wordImporter.parseBytes(
      docx({ body: visible + paragraph(run("Answer: B")) + hiddenParagraph("Answer: C OLD-DRAFT-MARKER") + paragraph("") }),
      OPTIONS,
    );
    const q = both.questions[0] as Question;
    assert.equal(verdictFrom(q.findings), "parsed");
    assert.deepEqual((q.body as { options: Array<{ correct: boolean }> }).options.map((o) => o.correct), [false, true, false]);
    assert.ok(!JSON.stringify({ questions: both.questions, orphans: both.orphans }).includes("OLD-DRAFT-MARKER"));
  });
});

describe("text in a box", () => {
  const box = (text: string): string => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
  const alternate = (choice: string, fallback: string): string =>
    `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><w:txbxContent>${choice}</w:txbxContent></w:drawing></mc:Choice>` +
    `<mc:Fallback><w:pict><w:txbxContent>${fallback}</w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:r>`;
  const boxFinding = (body: string): string | undefined => read(body).findings.find((f) => /^Text in a picture, shape or text box/.test(f.message))?.message;

  test("is not read, and the file says where it was and that a question in it is missing", () => {
    const body = paragraph(run("See the box") + alternate(box("Box says hello"), box("Box says hello")));
    assert.deepEqual(texts(body), ["See the box[picture]"]);
    const said = boxFinding(body) ?? "";
    assert.match(said, /^Text in a picture, shape or text box was not read \(1 place\), for example "Box says hello"\./);
    assert.match(said, /A question that stands in one is not among the questions, and is not among the text left over either\./);
  });

  test("written twice, once for a newer Word and once for an older one, it is counted and quoted once", () => {
    const said = boxFinding(paragraph(alternate(box("Same words"), box("Same words")))) ?? "";
    assert.match(said, /\(1 place\)/);
    assert.match(said, /for example "Same words"\./);
    assert.ok(!said.includes("Same wordsSame words"));
  });

  test("is quoted from the newer copy, or from the older when that is all there is", () => {
    assert.match(boxFinding(paragraph(alternate(box("newer"), box("older")))) ?? "", /for example "newer"/);
    const onlyOlder = paragraph(`<w:r><mc:AlternateContent><mc:Fallback><w:pict><w:txbxContent>${box("only older")}</w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:r>`);
    assert.match(boxFinding(onlyOlder) ?? "", /for example "only older"/);
  });

  test("two boxes are two places, each quoted by the first", () => {
    const body = paragraph(alternate(box("first box"), box("first box"))) + paragraph(alternate(box("second box"), box("second box")));
    const said = boxFinding(body) ?? "";
    assert.match(said, /\(2 places\), for example "first box"\./);
  });

  test("a picture with no text in it is marked and counted, and says nothing about text", () => {
    const body = paragraph("<w:r><w:drawing/></w:r>");
    assert.deepEqual(texts(body), ["[picture]"]);
    assert.equal(boxFinding(body), undefined);
  });
});
