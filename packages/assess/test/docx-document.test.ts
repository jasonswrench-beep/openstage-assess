/**
 * The body of a Word document as lines.
 *
 * The rule that holds this together: a block is one visual line, in order, and an
 * empty paragraph is an empty block. That is what lets a blank line mean the same
 * thing in a Word file and in a text file.
 *
 * The other rule is that nothing is dropped silently. What is not read yet (a
 * picture, an equation, a footnote) leaves a marker or a count, so the file can
 * say so.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { documentToBlocks } from "../src/import/docx/document.ts";
import { DocxError, openDocx } from "../src/import/docx/package.ts";
import { parseXml } from "../src/import/docx/xml.ts";
import { docx, paragraph, run, table } from "./support/docx-writer.ts";

function read(body: string) {
  const pkg = openDocx(docx({ body }));
  return documentToBlocks(pkg.xml(pkg.mainDocument)!);
}

const texts = (body: string) => read(body).blocks.map((b) => b.text);

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';

describe("paragraphs and runs", () => {
  test("runs that split a label across several pieces are joined", () => {
    assert.deepEqual(texts(paragraph(run("1") + run(".") + run(" ") + run("Which is a planet?"))), ["1. Which is a planet?"]);
  });

  test("an empty paragraph is an empty block, so a blank line stays a blank line", () => {
    assert.deepEqual(texts(paragraph(run("a")) + paragraph() + paragraph() + paragraph(run("b"))), ["a", "", "", "b"]);
  });

  test("blocks are numbered in order from zero", () => {
    assert.deepEqual(read(paragraph(run("a")) + paragraph() + paragraph(run("b"))).blocks.map((b) => b.index), [0, 1, 2]);
  });

  test("white space inside a run is kept exactly", () => {
    assert.deepEqual(texts(paragraph(run("  two  spaces  "))), ["  two  spaces  "]);
  });

  test("a tab is a tab", () => {
    assert.deepEqual(texts(paragraph(run("a.\tParis"))), ["a.\tParis"]);
  });

  test("a soft line break starts a new block, because a block is one visual line", () => {
    assert.deepEqual(texts(paragraph("<w:r><w:t>one</w:t><w:br/><w:t>two</w:t><w:cr/><w:t>three</w:t></w:r>")), ["one", "two", "three"]);
  });

  test("a break at the end of a paragraph does not add a blank line after it", () => {
    assert.deepEqual(texts(paragraph("<w:r><w:t>x</w:t><w:br/></w:r>")), ["x"]);
    assert.deepEqual(texts(paragraph("<w:r><w:t>x</w:t><w:br/><w:br/></w:r>")), ["x"]);
  });

  test("a break at the start of a paragraph leaves an empty line before the text", () => {
    assert.deepEqual(texts(paragraph("<w:r><w:br/><w:t>x</w:t></w:r>")), ["", "x"]);
  });

  test("a page or column break is not a line of its own", () => {
    assert.deepEqual(texts(paragraph('<w:r><w:t>x</w:t><w:br w:type="page"/></w:r><w:r><w:br w:type="column"/><w:t>y</w:t></w:r>')), ["xy"]);
  });

  test("a hyphen that does not break is a hyphen, and a soft hyphen is nothing", () => {
    assert.deepEqual(texts(paragraph("<w:r><w:t>well</w:t><w:noBreakHyphen/><w:t>known</w:t><w:softHyphen/><w:t>word</w:t></w:r>")), ["well-knownword"]);
  });

  test("properties, spelling marks, bookmarks and empty runs add nothing", () => {
    const noisy =
      '<w:pPr><w:jc w:val="left"/></w:pPr><w:bookmarkStart w:id="1" w:name="x"/><w:proofErr w:type="spellStart"/>' +
      `<w:r><w:rPr><w:b/></w:rPr><w:t>text</w:t></w:r><w:r/><w:r><w:lastRenderedPageBreak/></w:r><w:proofErr w:type="spellEnd"/><w:bookmarkEnd w:id="1"/>`;
    assert.deepEqual(texts(`<w:p>${noisy}</w:p>`), ["text"]);
  });
});

describe("containers around runs", () => {
  test("hyperlinks, smart tags, simple fields and content controls are read through", () => {
    const body = paragraph(
      '<w:hyperlink w:anchor="a">' + run("link ") + "</w:hyperlink>" +
        '<w:smartTag w:uri="x" w:element="y">' + run("tag ") + "</w:smartTag>" +
        '<w:fldSimple w:instr=" PAGE ">' + run("field ") + "</w:fldSimple>" +
        "<w:sdt><w:sdtPr><w:alias w:val=\"c\"/></w:sdtPr><w:sdtContent>" + run("control") + "</w:sdtContent></w:sdt>",
    );
    assert.deepEqual(texts(body), ["link tag field control"]);
  });

  test("the code of a field is not text, and its result is", () => {
    const field =
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> REF x \\h </w:instrText></w:r>' +
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' + run("result") + '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
    assert.deepEqual(texts(paragraph(run("see ") + field)), ["see result"]);
  });

  test("a content control around whole paragraphs is read through too", () => {
    assert.deepEqual(texts("<w:sdt><w:sdtPr/><w:sdtContent>" + paragraph(run("inside")) + "</w:sdtContent></w:sdt>" + paragraph(run("after"))), ["inside", "after"]);
  });
});

describe("tracked changes: read with the changes accepted, and counted", () => {
  test("inserted text is kept and deleted text is left out", () => {
    const body = paragraph(
      run("keep ") +
        '<w:ins w:id="1" w:author="a" w:date="2026-01-01T00:00:00Z">' + run("added ") + "</w:ins>" +
        '<w:del w:id="2" w:author="a" w:date="2026-01-01T00:00:00Z"><w:r><w:delText>removed </w:delText></w:r></w:del>' +
        run("end"),
    );
    const { blocks, stats } = read(body);
    assert.deepEqual(blocks.map((b) => b.text), ["keep added end"]);
    assert.equal(stats.trackedInsertions, 1);
    assert.equal(stats.trackedDeletions, 1);
  });

  test("moved text is read where it now stands and not where it was", () => {
    const body = paragraph('<w:moveFrom w:id="1" w:author="a">' + "<w:r><w:t>old place</w:t></w:r>" + "</w:moveFrom>" + '<w:moveTo w:id="2" w:author="a">' + run("new place") + "</w:moveTo>");
    const { blocks, stats } = read(body);
    assert.deepEqual(blocks.map((b) => b.text), ["new place"]);
    assert.equal(stats.trackedDeletions + stats.trackedInsertions, 2);
  });
});

describe("tables", () => {
  test("the paragraphs of every cell are read in order, with where they sit", () => {
    const body =
      paragraph(run("before")) +
      table([[paragraph(run("r0c0")), paragraph(run("r0c1a")) + paragraph(run("r0c1b"))], [paragraph(run("r1c0")), paragraph()]]) +
      paragraph(run("after"));
    const { blocks, stats } = read(body);
    assert.deepEqual(blocks.map((b) => b.text), ["before", "r0c0", "r0c1a", "r0c1b", "r1c0", "", "after"]);
    // None of the question layouts, so every cell is read as plain lines, and says so.
    const at = (row: number, cell: number) => ({ table: 0, row, cell, plain: true });
    assert.deepEqual(blocks.map((b) => b.table), [undefined, at(0, 0), at(0, 1), at(0, 1), at(1, 0), at(1, 1), undefined]);
    assert.equal(stats.tables, 1);
  });

  test("a table inside a cell is read, and numbered in document order", () => {
    const inner = table([[paragraph(run("inner"))]]);
    const body = table([[paragraph(run("outer")) + inner]]) + table([[paragraph(run("second"))]]);
    const { blocks, stats } = read(body);
    assert.deepEqual(blocks.map((b) => [b.text, b.table?.table]), [["outer", 0], ["inner", 1], ["second", 2]]);
    assert.equal(stats.tables, 3);
  });
});

describe("what is not read yet is marked and counted, never dropped without a word", () => {
  test("a picture leaves a marker where it stood", () => {
    const { blocks, stats } = read(paragraph(run("See ") + "<w:r><w:drawing><wp:inline/></w:drawing></w:r>" + run(" for the answer.")));
    assert.deepEqual(blocks.map((b) => b.text), ["See [picture] for the answer."]);
    assert.equal(stats.pictures, 1);
  });

  test("older pictures, embedded objects and shapes are pictures too", () => {
    const { blocks, stats } = read(paragraph("<w:r><w:pict/></w:r><w:r><w:object/></w:r><w:r><mc:AlternateContent><mc:Choice/><mc:Fallback/></mc:AlternateContent></w:r>"));
    assert.deepEqual(blocks.map((b) => b.text), ["[picture][picture][picture]"]);
    assert.equal(stats.pictures, 3);
  });

  test("text inside a text box is counted as text that was not read", () => {
    const { stats } = read(paragraph("<w:r><w:drawing><w:txbxContent><w:p><w:r><w:t>a whole question</w:t></w:r></w:p></w:txbxContent></w:drawing></w:r>"));
    assert.equal(stats.pictures, 1);
    assert.deepEqual(stats.unreadWithText, { "a picture, shape or text box": 1 });
  });

  test("an equation that is not read leaves a marker and its reason, once for each in a block of them", () => {
    const { blocks, stats } = read(paragraph(run("Solve ") + "<m:oMath><m:strange/></m:oMath>" + run(" now ") + "<m:oMathPara><m:oMath><m:strange/></m:oMath><m:oMath><m:other/></m:oMath></m:oMathPara>"));
    assert.deepEqual(blocks.map((b) => b.text), ["Solve [equation] now [equation][equation]"]);
    assert.equal(stats.equations, 3);
    assert.equal(stats.equationsRead, 0);
    assert.deepEqual(Object.keys(stats.equationReasons).length, 2);
  });

  test("an equation that is read leaves a tag naming it, and is handed over beside the blocks (equations.test.ts has the rest)", () => {
    const { blocks, stats, math } = read(paragraph(run("Solve ") + "<m:oMath><m:r><m:t>x+1</m:t></m:r></m:oMath>"));
    assert.match(blocks[0]!.text, /^Solve \[ eq: "eq-[0-9a-f]{16}" \]$/);
    assert.deepEqual([stats.equationsRead, stats.equations, math.size], [1, 0, 1]);
  });

  test("footnote, endnote and comment references are counted, and symbols too", () => {
    const { blocks, stats } = read(
      paragraph(run("text") + '<w:r><w:footnoteReference w:id="1"/></w:r><w:r><w:endnoteReference w:id="2"/></w:r><w:r><w:commentReference w:id="3"/></w:r><w:r><w:sym w:font="Wingdings" w:char="F0FC"/></w:r>'),
    );
    // A symbol that cannot be read leaves a marker where it stood, and is counted by the font it was in.
    assert.deepEqual(blocks.map((b) => b.text), ["text[symbol]"]);
    assert.deepEqual([stats.notes, stats.comments, stats.symbols], [2, 1, 1]);
    assert.deepEqual(stats.symbolFonts, { Wingdings: 1 });
  });

  test("a character typed from the Symbol font is read as the character it shows, by Insert Symbol or by the run's font", () => {
    const { blocks, stats } = read(
      paragraph(run("alpha ") + '<w:r><w:sym w:font="Symbol" w:char="F061"/></w:r>' + run(" and ") + '<w:r><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol"/></w:rPr><w:t>bg</w:t></w:r>' + run(" in Arial: ") + '<w:r><w:sym w:font="Arial" w:char="00B1"/></w:r>'),
    );
    assert.deepEqual(blocks.map((b) => b.text), ["alpha α and βγ in Arial: ±"]);
    assert.deepEqual([stats.symbolsRead, stats.symbols, stats.symbolsUnsure], [4, 0, 0]);
  });

  test("a Symbol code the table is not sure of is left as written and counted, and a symbol of an unknown code is marked", () => {
    const { blocks, stats } = read(paragraph('<w:r><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol"/></w:rPr><w:t>aç</w:t></w:r>' + '<w:r><w:sym w:font="Symbol" w:char="F0FE"/></w:r>'));
    assert.deepEqual(blocks.map((b) => b.text), ["αç[symbol]"]);
    assert.deepEqual([stats.symbolsRead, stats.symbolsUnsure, stats.symbols], [1, 1, 1]);
  });

  test("text in an ordinary font is not touched by the Symbol table", () => {
    const { blocks, stats } = read(paragraph('<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/></w:rPr><w:t>abc</w:t></w:r>'));
    assert.deepEqual(blocks.map((b) => b.text), ["abc"]);
    assert.equal(stats.symbolsRead, 0);
  });

  test("an element this does not know that holds text is counted by name", () => {
    const { stats } = read("<w:oddBlock><w:t>hidden away</w:t></w:oddBlock>" + paragraph(run("fine")) + paragraph("<w:strangeInline>stray words</w:strangeInline>"));
    assert.deepEqual(stats.unreadWithText, { "w:oddBlock": 1, "w:strangeInline": 1 });
  });

  test("elements that hold no text are skipped without comment", () => {
    const { stats } = read("<w:bookmarkStart w:id=\"1\" w:name=\"a\"/>" + paragraph(run("x")) + "<w:bookmarkEnd w:id=\"1\"/>");
    assert.deepEqual(stats.unreadWithText, {});
  });

  test("a clean document counts nothing", () => {
    const { stats } = read(paragraph(run("plain")));
    assert.deepEqual(
      [stats.pictures, stats.equations, stats.symbols, stats.notes, stats.comments, stats.trackedInsertions, stats.trackedDeletions, Object.keys(stats.unreadWithText).length],
      [0, 0, 0, 0, 0, 0, 0, 0],
    );
    assert.equal(stats.paragraphs, 1);
  });
});

describe("a document that is not a document", () => {
  test("the wrong root is refused", () => {
    assert.throws(() => documentToBlocks(parseXml(`<w:styles ${W}/>`)), (e: unknown) => e instanceof DocxError && /starts with <w:styles>/.test((e as Error).message));
  });

  test("a document with no body is refused", () => {
    assert.throws(() => documentToBlocks(parseXml(`<w:document ${W}/>`)), (e: unknown) => e instanceof DocxError && /has no body/.test((e as Error).message));
  });
});
