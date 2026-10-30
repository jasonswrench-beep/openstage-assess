/**
 * How a run of text looks in a Word document, worked out from its styles and its
 * own formatting. The expected values are written out. The rules that are not
 * obvious (a toggle property that a character style turns back off) were checked
 * against Word; see test/tools/word-formatting-check.ts.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { documentToBlocks } from "../src/import/docx/document.ts";
import { readFormatting } from "../src/import/docx/formatting.ts";
import { readNumbering } from "../src/import/docx/numbering.ts";
import { first, parseXml, type XmlElement } from "../src/import/docx/xml.ts";
import { docxToBlocks } from "../src/import/word.ts";
import { docx, paragraph, run } from "./support/docx-writer.ts";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const styles = (inner: string): XmlElement => parseXml(`<w:styles ${W}>${inner}</w:styles>`);
const rPr = (inner: string): XmlElement => parseXml(`<w:rPr ${W}>${inner}</w:rPr>`);

const paragraphStyle = (id: string, props = "", basedOn = "", isDefault = false): string =>
  `<w:style w:type="paragraph"${isDefault ? ' w:default="1"' : ""} w:styleId="${id}"><w:name w:val="${id}"/>${basedOn ? `<w:basedOn w:val="${basedOn}"/>` : ""}${props ? `<w:rPr>${props}</w:rPr>` : ""}</w:style>`;
const characterStyle = (id: string, props = "", basedOn = ""): string =>
  `<w:style w:type="character" w:styleId="${id}"><w:name w:val="${id}"/>${basedOn ? `<w:basedOn w:val="${basedOn}"/>` : ""}${props ? `<w:rPr>${props}</w:rPr>` : ""}</w:style>`;

describe("direct formatting", () => {
  const formatting = readFormatting(undefined);

  test("a run with nothing says nothing", () => {
    assert.deepEqual(formatting.run(undefined, undefined), {});
    assert.deepEqual(formatting.run(rPr(""), undefined), {});
  });

  test("bold, italic and underline", () => {
    assert.deepEqual(formatting.run(rPr("<w:b/><w:i/><w:u w:val=\"single\"/>"), undefined), { bold: true, italic: true, underline: true });
  });

  test("a property turned off is off", () => {
    assert.deepEqual(formatting.run(rPr('<w:b w:val="0"/><w:i w:val="false"/><w:u w:val="none"/>'), undefined), {});
    assert.deepEqual(formatting.run(rPr('<w:b w:val="1"/><w:i w:val="on"/>'), undefined), { bold: true, italic: true });
  });

  test("any kind of underline is underline", () => {
    for (const kind of ["double", "dotted", "words", "thick"]) {
      assert.deepEqual(formatting.run(rPr(`<w:u w:val="${kind}"/>`), undefined), { underline: true }, kind);
    }
  });

  test("a highlight is its name, and none is none", () => {
    assert.deepEqual(formatting.run(rPr('<w:highlight w:val="yellow"/>'), undefined), { highlight: "yellow" });
    assert.deepEqual(formatting.run(rPr('<w:highlight w:val="none"/>'), undefined), {});
  });

  test("a colour is its value, and automatic and black are none", () => {
    assert.deepEqual(formatting.run(rPr('<w:color w:val="c00000"/>'), undefined), { color: "C00000" });
    assert.deepEqual(formatting.run(rPr('<w:color w:val="auto"/>'), undefined), {});
    assert.deepEqual(formatting.run(rPr('<w:color w:val="000000"/>'), undefined), {});
  });
});

describe("formatting that comes from styles", () => {
  test("a paragraph style gives its runs its look", () => {
    const f = readFormatting(styles(paragraphStyle("Key", "<w:b/>") + paragraphStyle("Plain")));
    assert.deepEqual(f.run(undefined, "Key"), { bold: true });
    assert.deepEqual(f.run(undefined, "Plain"), {});
  });

  test("a character style gives the run its look", () => {
    const f = readFormatting(styles(characterStyle("Strong", "<w:b/>") + characterStyle("Marked", '<w:u w:val="single"/><w:color w:val="FF0000"/>')));
    assert.deepEqual(f.run(rPr('<w:rStyle w:val="Strong"/>'), undefined), { bold: true });
    assert.deepEqual(f.run(rPr('<w:rStyle w:val="Marked"/>'), undefined), { underline: true, color: "FF0000" });
  });

  test("a highlight in a character style is ignored, as Word ignores it, and one in a paragraph style is not", () => {
    // Checked against Word, which shows no highlight for the first and yellow for the second.
    const f = readFormatting(styles(characterStyle("Marked", '<w:highlight w:val="yellow"/>') + paragraphStyle("Lit", '<w:highlight w:val="yellow"/>')));
    assert.deepEqual(f.run(rPr('<w:rStyle w:val="Marked"/>'), undefined), {});
    assert.deepEqual(f.run(undefined, "Lit"), { highlight: "yellow" });
    assert.deepEqual(f.run(rPr('<w:rStyle w:val="Marked"/>'), "Lit"), { highlight: "yellow" }, "a character style's highlight, even none, does not undo the paragraph's");
    assert.deepEqual(f.run(rPr('<w:rStyle w:val="Marked"/><w:highlight w:val="green"/>'), undefined), { highlight: "green" }, "direct formatting still highlights");
  });

  test("direct formatting beats a style", () => {
    const f = readFormatting(styles(characterStyle("Strong", "<w:b/>") + characterStyle("Red", '<w:color w:val="FF0000"/>')));
    assert.deepEqual(f.run(rPr('<w:rStyle w:val="Strong"/><w:b w:val="0"/>'), undefined), {});
    assert.deepEqual(f.run(rPr('<w:rStyle w:val="Red"/><w:color w:val="0000FF"/>'), undefined), { color: "0000FF" });
  });

  test("a style based on another carries on from it, and the nearest says what it says", () => {
    const f = readFormatting(
      styles(
        paragraphStyle("A", "<w:b/><w:i/>") +
          paragraphStyle("B", '<w:i w:val="0"/><w:u w:val="single"/>', "A") +
          paragraphStyle("C", "", "B"),
      ),
    );
    assert.deepEqual(f.run(undefined, "A"), { bold: true, italic: true });
    assert.deepEqual(f.run(undefined, "B"), { bold: true, underline: true });
    assert.deepEqual(f.run(undefined, "C"), { bold: true, underline: true });
  });

  test("the document's defaults and the default paragraph style sit underneath", () => {
    const f = readFormatting(
      styles(
        '<w:docDefaults><w:rPrDefault><w:rPr><w:color w:val="404040"/></w:rPr></w:rPrDefault></w:docDefaults>' +
          paragraphStyle("Normal", "<w:i/>", "", true) +
          paragraphStyle("Other", '<w:color w:val="FF0000"/>'),
      ),
    );
    assert.deepEqual(f.run(undefined, undefined), { italic: true, color: "404040" });
    assert.deepEqual(f.run(undefined, "Other"), { color: "FF0000" }, "a named style replaces the default one, and keeps the document default");
  });

  test("bold in a paragraph style and bold in a character style cancel, as Word has it", () => {
    // Bold and italic are toggle properties. Checked against Word.
    const f = readFormatting(styles(paragraphStyle("Heading", "<w:b/>") + characterStyle("Strong", "<w:b/>")));
    assert.deepEqual(f.run(rPr('<w:rStyle w:val="Strong"/>'), "Heading"), {});
    assert.deepEqual(f.run(undefined, "Heading"), { bold: true });
    assert.deepEqual(f.run(rPr('<w:rStyle w:val="Strong"/><w:b/>'), "Heading"), { bold: true }, "direct formatting settles it");
  });

  test("a loop of styles that are based on each other ends", () => {
    const f = readFormatting(styles(paragraphStyle("A", "<w:b/>", "B") + paragraphStyle("B", "", "A")));
    assert.deepEqual(f.run(undefined, "A"), { bold: true });
  });

  test("a style that is not there says nothing", () => {
    const f = readFormatting(styles(paragraphStyle("Normal", "", "", true)));
    assert.deepEqual(f.run(rPr('<w:rStyle w:val="Missing"/>'), "AlsoMissing"), {});
  });
});

describe("runs on blocks", () => {
  const body = (inner: string) => docx({ body: inner });
  const runsOf = (bytes: Uint8Array) => docxToBlocks(bytes).blocks.map((b) => b.runs);

  test("every block's runs add up to its text", () => {
    const bytes = body(
      paragraph(run("plain ") + run("bold", "<w:b/>") + run(" and ", "<w:i/>") + run("more\tafter a tab", "")) +
        paragraph() +
        paragraph(run("one", "<w:b/>") + "<w:r><w:br/></w:r>" + run("two")),
    );
    for (const block of docxToBlocks(bytes).blocks) assert.equal((block.runs ?? []).map((r) => r.text).join(""), block.text);
  });

  test("neighbouring runs with the same look are one run", () => {
    assert.deepEqual(runsOf(body(paragraph(run("a", "<w:b/>") + run("b", "<w:b/>") + run("c")))), [[{ text: "ab", bold: true }, { text: "c" }]]);
  });

  test("a soft break splits the runs between the lines", () => {
    const bytes = body(paragraph(run("one", "<w:b/>") + "<w:r><w:br/></w:r>" + run("two", "<w:i/>")));
    assert.deepEqual(runsOf(bytes), [[{ text: "one", bold: true }], [{ text: "two", italic: true }]]);
  });

  test("text in a hyperlink, a field or a tracked insertion has its look too", () => {
    const bytes = body(
      paragraph(
        `<w:hyperlink w:anchor="x">${run("link", "<w:b/>")}</w:hyperlink>` +
          `<w:ins w:id="1" w:author="a">${run(" added", "<w:b/>")}</w:ins>` +
          '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> X </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
          run(" field", "<w:b/>") +
          '<w:r><w:fldChar w:fldCharType="end"/></w:r>',
      ),
    );
    assert.deepEqual(runsOf(bytes), [[{ text: "link added field", bold: true }]]);
  });

  test("documentToBlocks without a formatting reader gives no runs", () => {
    const root = parseXml(`<w:document ${W}><w:body>${paragraph(run("x", "<w:b/>"))}</w:body></w:document>`);
    const { blocks } = documentToBlocks(root, readNumbering({}));
    assert.equal(blocks[0]?.runs, undefined);
    assert.ok(first(root, "w:body"));
  });
});
