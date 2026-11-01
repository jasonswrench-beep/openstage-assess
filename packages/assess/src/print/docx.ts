/**
 * A printed test as a Word file.
 *
 * It writes what the layout says and decides nothing: the numbers and letters are typed text with a tab and a hanging
 * indent, as the test-bank vendor's own handout asks and as OpenAssess's importer reads them, so a test printed from a bank can be
 * edited in Word and read back. Writing lines are paragraphs with a leader that draws a line to the margin, which Word does
 * not merge into one box as it would adjacent bordered paragraphs. The page number is a field.
 *
 * The package is the smallest Word will open without a repair: the content types, the relationships, the document, its
 * styles, a footer and the document properties. It is checked by asking Word itself (test/tools/word-print-check.ts).
 */

import { textEntry, zipSync } from "../container/zip.ts";
import type { Block, Para, PrintDocument, Run } from "./layout.ts";

const NUMBER_INDENT = 28;

const esc = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

const tw = (points: number): number => Math.round(points * 20);

function runXml(run: Run, size: number, bold: boolean): string {
  const props =
    (run.mono ? '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>' : "") +
    (bold || run.bold ? "<w:b/>" : "") +
    (run.italic ? "<w:i/>" : "") +
    `<w:sz w:val="${Math.round(size * 2)}"/><w:szCs w:val="${Math.round(size * 2)}"/>` +
    (run.underline ? '<w:u w:val="single"/>' : "");
  // A line break inside a run is a break element, not a character the reader would see as a box.
  return run.text
    .split("\n")
    .map((piece, i) => `<w:r><w:rPr>${props}</w:rPr>${i > 0 ? "<w:br/>" : ""}<w:t xml:space="preserve">${esc(piece)}</w:t></w:r>`)
    .join("");
}

function paraXml(p: Para): string {
  const hang = p.hang ?? NUMBER_INDENT;
  const properties =
    (p.rule ? '<w:pStyle w:val="Title"/>' : "") +
    (p.keepNext ? "<w:keepNext/>" : "") +
    (p.rule ? '<w:pBdr><w:bottom w:val="single" w:sz="8" w:space="3" w:color="404040"/></w:pBdr>' : "") +
    (p.marker ? `<w:tabs><w:tab w:val="left" w:pos="${tw(p.indent)}"/></w:tabs>` : "") +
    `<w:spacing w:before="${tw(p.before)}" w:after="${tw(p.after)}"/>` +
    `<w:ind w:left="${tw(p.indent)}"${p.marker ? ` w:hanging="${tw(hang)}"` : ""}/>` +
    (p.align === "center" ? '<w:jc w:val="center"/>' : "");
  const marker = p.marker ? `<w:r><w:rPr><w:sz w:val="${Math.round(p.size * 2)}"/></w:rPr><w:t xml:space="preserve">${esc(p.marker)}</w:t></w:r><w:r><w:tab/></w:r>` : "";
  return `<w:p><w:pPr>${properties}</w:pPr>${marker}${p.runs.map((r) => runXml(r, p.size, p.bold === true)).join("")}</w:p>`;
}

function blockXml(block: Block, textWidth: number, fontSize: number): string {
  if (block.kind === "para") return paraXml(block);
  if (block.kind === "pagebreak") return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  // A line to write on: a tab that is drawn as an underscore to the right margin.
  const line = `<w:p><w:pPr><w:tabs><w:tab w:val="right" w:leader="underscore" w:pos="${tw(textWidth)}"/></w:tabs><w:spacing w:before="${tw(fontSize * 1.9)}" w:after="0"/><w:ind w:left="${tw(NUMBER_INDENT)}"/></w:pPr><w:r><w:tab/></w:r></w:p>`;
  return line.repeat(Math.max(0, block.count));
}

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function documentXml(doc: PrintDocument): string {
  const { paper } = doc;
  const textWidth = paper.width - 2 * paper.margin;
  const body = doc.blocks.map((b) => blockXml(b, textWidth, doc.fontSize)).join("");
  const section =
    `<w:sectPr><w:footerReference w:type="default" r:id="rId2"/>` +
    `<w:pgSz w:w="${tw(paper.width)}" w:h="${tw(paper.height)}"/>` +
    `<w:pgMar w:top="${tw(paper.margin)}" w:right="${tw(paper.margin)}" w:bottom="${tw(paper.margin)}" w:left="${tw(paper.margin)}" w:header="720" w:footer="${tw(paper.margin / 2)}" w:gutter="0"/></w:sectPr>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body}${section}</w:body></w:document>`;
}

function stylesXml(doc: PrintDocument): string {
  const size = Math.round(doc.fontSize * 2);
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${NS}>` +
    `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>` +
    `<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="260" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:rPr><w:b/><w:sz w:val="${size + 14}"/><w:szCs w:val="${size + 14}"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>` +
    `</w:styles>`
  );
}

function footerXml(doc: PrintDocument): string {
  const textWidth = doc.paper.width - 2 * doc.paper.margin;
  const small = '<w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>';
  const field = (instruction: string, shown: string): string =>
    `<w:r>${small}<w:fldChar w:fldCharType="begin"/></w:r><w:r>${small}<w:instrText xml:space="preserve"> ${instruction} </w:instrText></w:r><w:r>${small}<w:fldChar w:fldCharType="separate"/></w:r><w:r>${small}<w:t>${shown}</w:t></w:r><w:r>${small}<w:fldChar w:fldCharType="end"/></w:r>`;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${NS}><w:p><w:pPr><w:pStyle w:val="Footer"/><w:tabs><w:tab w:val="right" w:pos="${tw(textWidth)}"/></w:tabs></w:pPr>` +
    `<w:r>${small}<w:t xml:space="preserve">${esc(doc.footer)}</w:t></w:r><w:r>${small}<w:tab/></w:r><w:r>${small}<w:t xml:space="preserve">Page </w:t></w:r>${field("PAGE", "1")}<w:r>${small}<w:t xml:space="preserve"> of </w:t></w:r>${field("NUMPAGES", "1")}</w:p></w:ftr>`
  );
}

/** The test as a Word document, as bytes. `at` is the time written into its properties. */
export function writeDocx(doc: PrintDocument, at: Date = new Date()): Uint8Array {
  const stamp = at.toISOString().replace(/\.\d+Z$/, "Z");
  const types =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
    `<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>` +
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
    `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
    `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
  const documentRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`;
  const core =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${esc(doc.title)}</dc:title><dc:creator>OpenAssess</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified></cp:coreProperties>`;
  const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>OpenAssess</Application></Properties>`;

  return zipSync([
    textEntry("[Content_Types].xml", types),
    textEntry("_rels/.rels", rels),
    textEntry("word/document.xml", documentXml(doc)),
    textEntry("word/_rels/document.xml.rels", documentRels),
    textEntry("word/styles.xml", stylesXml(doc)),
    textEntry("word/footer1.xml", footerXml(doc)),
    textEntry("docProps/core.xml", core),
    textEntry("docProps/app.xml", app),
  ]);
}
