/**
 * A printed test as a Word file.
 *
 * It writes what the layout says and decides nothing: the numbers and letters are typed text with a tab and a hanging
 * indent, as the format's own guidance asks and as OpenAssess's importer reads them, so a test printed from a bank can be
 * edited in Word and read back. Writing lines are paragraphs with a leader that draws a line to the margin, which Word does
 * not merge into one box as it would adjacent bordered paragraphs. The page number is a field.
 *
 * The package is the smallest Word will open without a repair: the content types, the relationships, the document, its
 * styles, a footer and the document properties. It is checked by asking Word itself (test/tools/word-print-check.ts).
 */

import { textEntry, zipSync } from "../container/zip.ts";
import { stripInvalidCharacters } from "../model/richtext.ts";
import type { Block, Para, PictureBlock, PrintDocument, Run, TableBlock } from "./layout.ts";

const NUMBER_INDENT = 28;

const esc = (text: string): string =>
  // Nothing XML 1.0 forbids, which is more than the control characters: half a surrogate pair, U+FFFE and U+FFFF made Word say a
  // printed test had unreadable content. A vertical tab and a form feed become a space and not nothing, so two words are not joined.
  stripInvalidCharacters(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const tw = (points: number): number => Math.round(points * 20);

function runXml(run: Run, size: number, bold: boolean): string {
  // An equation is written as the equation it is. The layout has already read it again and kept only what it understands.
  if (run.equation !== undefined) return run.equation;
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

/** The pictures a document holds, each file once, with the relationship it is reached by and the name it has in the package. */
class Pictures {
  readonly files = new Map<string, { rId: string; name: string; bytes: Uint8Array; mime: string }>();
  private drawings = 0;

  fileFor(block: PictureBlock): { rId: string; name: string; id: number } {
    let held = this.files.get(block.picture.file);
    if (held === undefined) {
      const n = this.files.size + 1;
      held = { rId: `rIdPic${n}`, name: `image${n}.${block.picture.info.ext === "jpg" ? "jpeg" : block.picture.info.ext}`, bytes: block.picture.bytes, mime: block.picture.info.mime };
      this.files.set(block.picture.file, held);
    }
    // Word wants every drawing in a document to have an id of its own, even when the same picture is drawn twice.
    return { rId: held.rId, name: held.name, id: ++this.drawings };
  }
}

const EMU_PER_POINT = 12700;

/** A picture on a line of its own, drawn in the text at the size it is printed, with its description for a screen reader. */
function pictureXml(block: PictureBlock, pictures: Pictures): string {
  const { rId, name, id } = pictures.fileFor(block);
  const cx = Math.round(block.w * EMU_PER_POINT);
  const cy = Math.round(block.h * EMU_PER_POINT);
  const descr = esc(block.picture.alt);
  const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
  const properties = (block.keepNext ? "<w:keepNext/>" : "") + `<w:spacing w:before="${tw(block.before)}" w:after="${tw(block.after)}"/><w:ind w:left="${tw(block.indent)}"/>`;
  return (
    `<w:p><w:pPr>${properties}</w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:docPr id="${id}" name="Picture ${id}" descr="${descr}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks ${A} noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic ${A}><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="${esc(name)}" descr="${descr}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
  );
}

/**
 * A table of the question, as a table: a thin grey rule round every cell, columns of equal width across the room the text has, a
 * header row (marked to repeat at the top of a page, which is what makes it a header in Word) in bold, and a row that is never split
 * across a page. A row with fewer cells than the widest has its last cell spread over the rest, as Word writes a ragged row. A table
 * must be followed by a paragraph in Word, so a small one ends it, which also keeps two tables from running into one.
 */
function tableXml(block: TableBlock, textWidth: number, fontSize: number): string {
  // A loop and not `Math.max(1, ...rows)`: a stem table of 130,000 rows is more arguments than a call can take.
  let columns = 1;
  for (const row of block.table.rows) columns = Math.max(columns, row.reduce((sum, c) => sum + c.colspan, 0));
  const room = Math.max(72, textWidth - block.indent);
  const width = tw(room / columns);
  const rule = (side: string): string => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="808080"/>`;
  const properties =
    `<w:tblPr><w:tblW w:w="${width * columns}" w:type="dxa"/><w:tblInd w:w="${tw(block.indent)}" w:type="dxa"/>` +
    `<w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(rule).join("")}</w:tblBorders>` +
    `<w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>`;
  const keep = block.keepNext ? "<w:keepNext/>" : "";
  const rows = block.table.rows
    .map((row) => {
      const used = row.reduce((sum, c) => sum + c.colspan, 0);
      const header = row.length > 0 && row.every((c) => c.header);
      const cells = row
        .map((cell, i) => {
          const span = cell.colspan + (i === row.length - 1 ? Math.max(0, columns - used) : 0);
          return (
            `<w:tc><w:tcPr><w:tcW w:w="${width * span}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ""}</w:tcPr>` +
            `<w:p><w:pPr>${keep}<w:spacing w:before="20" w:after="20"/></w:pPr>${runXml({ text: cell.text, ...(cell.header ? { bold: true } : {}) }, fontSize, false)}</w:p></w:tc>`
          );
        })
        .join("");
      return `<w:tr><w:trPr><w:cantSplit/>${header ? "<w:tblHeader/>" : ""}</w:trPr>${cells}</w:tr>`;
    })
    .join("");
  const grid = `<w:tblGrid>${`<w:gridCol w:w="${width}"/>`.repeat(columns)}</w:tblGrid>`;
  const gap = `<w:p><w:pPr>${keep}<w:spacing w:before="0" w:after="${tw(block.after)}" w:line="120" w:lineRule="exact"/><w:rPr><w:sz w:val="4"/><w:szCs w:val="4"/></w:rPr></w:pPr></w:p>`;
  return `<w:tbl>${properties}${grid}${rows}</w:tbl>${gap}`;
}

function blockXml(block: Block, textWidth: number, fontSize: number, pictures: Pictures): string {
  if (block.kind === "para") return paraXml(block);
  if (block.kind === "picture") return pictureXml(block, pictures);
  if (block.kind === "table") return tableXml(block, textWidth, fontSize);
  if (block.kind === "pagebreak") return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  // A line to write on: a tab that is drawn as an underscore to the right margin.
  const line = `<w:p><w:pPr><w:tabs><w:tab w:val="right" w:leader="underscore" w:pos="${tw(textWidth)}"/></w:tabs><w:spacing w:before="${tw(fontSize * 1.9)}" w:after="0"/><w:ind w:left="${tw(NUMBER_INDENT)}"/></w:pPr><w:r><w:tab/></w:r></w:p>`;
  return line.repeat(Math.max(0, block.count));
}

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';

function documentXml(doc: PrintDocument, pictures: Pictures): string {
  const { paper } = doc;
  const textWidth = paper.width - 2 * paper.margin;
  const body = doc.blocks.map((b) => blockXml(b, textWidth, doc.fontSize, pictures)).join("");
  const section =
    `<w:sectPr>${doc.header ? '<w:headerReference w:type="default" r:id="rId3"/>' : ""}<w:footerReference w:type="default" r:id="rId2"/>` +
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
    (doc.header ? `<w:style w:type="paragraph" w:styleId="Header"><w:name w:val="header"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>` : "") +
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

function headerXml(doc: PrintDocument): string {
  const small = "<w:rPr><w:b/><w:sz w:val=\"18\"/><w:szCs w:val=\"18\"/></w:rPr>";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${NS}><w:p><w:pPr><w:pStyle w:val="Header"/></w:pPr><w:r>${small}<w:t xml:space="preserve">${esc(doc.header ?? "")}</w:t></w:r></w:p></w:hdr>`;
}

/** The test as a Word document, as bytes. `at` is the time written into its properties. */
export function writeDocx(doc: PrintDocument, at: Date = new Date()): Uint8Array {
  const stamp = at.toISOString().replace(/\.\d+Z$/, "Z");
  // The body is written first, since writing it is what finds the pictures the package has to carry.
  const pictures = new Pictures();
  const documentPart = documentXml(doc, pictures);
  const defaults = [...new Set([...pictures.files.values()].map((f) => f.mime))]
    .map((m) => (m === "image/png" ? '<Default Extension="png" ContentType="image/png"/>' : m === "image/gif" ? '<Default Extension="gif" ContentType="image/gif"/>' : '<Default Extension="jpeg" ContentType="image/jpeg"/>'))
    .join("");
  const types =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${defaults}` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
    `<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>` +
    (doc.header ? `<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>` : "") +
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
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>` +
    (doc.header ? `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>` : "") +
    [...pictures.files.values()].map((f) => `<Relationship Id="${f.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${f.name}"/>`).join("") +
    `</Relationships>`;
  const core =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${esc(doc.title)}</dc:title><dc:creator>OpenAssess</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified></cp:coreProperties>`;
  const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>OpenAssess</Application></Properties>`;

  return zipSync([
    textEntry("[Content_Types].xml", types),
    textEntry("_rels/.rels", rels),
    textEntry("word/document.xml", documentPart),
    textEntry("word/_rels/document.xml.rels", documentRels),
    textEntry("word/styles.xml", stylesXml(doc)),
    textEntry("word/footer1.xml", footerXml(doc)),
    ...(doc.header ? [textEntry("word/header1.xml", headerXml(doc))] : []),
    ...[...pictures.files.values()].map((f) => ({ name: `word/media/${f.name}`, data: f.bytes, store: true })),
    textEntry("docProps/core.xml", core),
    textEntry("docProps/app.xml", app),
  ]);
}
