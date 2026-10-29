/**
 * A minimal Word writer, for tests.
 *
 * It makes .docx files so that the Word importer can be measured without a
 * person typing documents. It is deliberately not Word: it writes only what the
 * tests need, in the plainest valid form, and it is NOT evidence that real Word
 * files read correctly. That evidence is the dialect pack and the real chapters
 * (see docs/word-import-plan.md). What this does give is any number of documents
 * whose right answer is known, because they are made from text fixtures that
 * already have expected files.
 *
 * The print export will need to write .docx too, and this is where that code will
 * come from.
 */

import { textEntry, zipSync, type ZipEntry } from "../../src/container/zip.ts";

const NAMESPACES = [
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"',
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
].join(" ");

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

export function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/** The text of one run. A tab in the text becomes a tab element, as Word writes it. */
export function runContent(text: string): string {
  return text
    .split("\t")
    .map((piece) => (piece === "" ? "" : `<w:t xml:space="preserve">${esc(piece)}</w:t>`))
    .reduce((out, piece, i) => out + (i > 0 ? "<w:tab/>" : "") + piece, "");
}

export function run(text: string, properties = ""): string {
  return `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ""}${runContent(text)}</w:r>`;
}

export function paragraph(inner = "", properties = "", attributes = ""): string {
  return `<w:p${attributes ? ` ${attributes}` : ""}>${properties ? `<w:pPr>${properties}</w:pPr>` : ""}${inner}</w:p>`;
}

/** A table whose cells are given as the XML of the paragraphs in them. */
export function table(rows: string[][]): string {
  const body = rows
    .map((cells) => `<w:tr>${cells.map((cell) => `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>${cell}</w:tc>`).join("")}</w:tr>`)
    .join("");
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid/>${body}</w:tbl>`;
}

// ---------------------------------------------------------------------------
// The package
// ---------------------------------------------------------------------------

export interface DocxParts {
  /** The XML of the body, without the section properties. */
  body: string;
  /** The text of each header and footer, to check that they are never read as content. */
  headers?: string[];
  footers?: string[];
  /** Further parts, such as media, written as they are. */
  extra?: ZipEntry[];
  /** Part names and bytes to leave out, for tests of damaged packages. */
  omit?: string[];
}

export function docx(parts: DocxParts): Uint8Array {
  const headers = parts.headers ?? [];
  const footers = parts.footers ?? [];

  const overrides = [
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    ...headers.map((_, i) => `<Override PartName="/word/header${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>`),
    ...footers.map((_, i) => `<Override PartName="/word/footer${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>`),
  ].join("");

  const relationships = [
    ...headers.map((_, i) => `<Relationship Id="rIdH${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header${i + 1}.xml"/>`),
    ...footers.map((_, i) => `<Relationship Id="rIdF${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer${i + 1}.xml"/>`),
  ].join("");

  const references = [
    ...headers.map((_, i) => `<w:headerReference w:type="default" r:id="rIdH${i + 1}"/>`),
    ...footers.map((_, i) => `<w:footerReference w:type="default" r:id="rIdF${i + 1}"/>`),
  ].join("");

  const section = `<w:sectPr>${references}<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`;

  const entries: ZipEntry[] = [
    textEntry(
      "[Content_Types].xml",
      `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides}</Types>`,
    ),
    textEntry(
      "_rels/.rels",
      `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    textEntry("word/document.xml", `${XML_DECLARATION}<w:document ${NAMESPACES}><w:body>${parts.body}${section}</w:body></w:document>`),
    textEntry(
      "word/_rels/document.xml.rels",
      `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`,
    ),
    ...headers.map((text, i) => textEntry(`word/header${i + 1}.xml`, `${XML_DECLARATION}<w:hdr ${NAMESPACES}>${paragraph(run(text))}</w:hdr>`)),
    ...footers.map((text, i) => textEntry(`word/footer${i + 1}.xml`, `${XML_DECLARATION}<w:ftr ${NAMESPACES}>${paragraph(run(text))}</w:ftr>`)),
    ...(parts.extra ?? []),
  ].filter((entry) => !(parts.omit ?? []).includes(entry.name));

  return zipSync(entries);
}

// ---------------------------------------------------------------------------
// From lines of text
// ---------------------------------------------------------------------------

/** A small deterministic generator, so a failure can be reproduced from its seed. */
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    chance: (p: number) => next() < p,
    below: (n: number) => Math.floor(next() * n),
    hex: () => Math.floor(next() * 0xffffffff).toString(16).toUpperCase().padStart(8, "0"),
  };
}

export interface LinesOptions {
  /**
   * Scatter what real Word leaves in a file: each line split into several runs at
   * arbitrary points (even inside "1."), spelling and bookmark marks, empty runs,
   * revision ids, paragraph properties, a hyperlink or a field around some text,
   * deleted text that must never appear, an inserted run that must, and a header
   * and a footer whose text must never be read as content.
   */
  noise?: boolean;
  seed?: number;
}

export const HEADER_TEXT = "RUNNING HEADER MUST NOT BE READ";
export const FOOTER_TEXT = "RUNNING FOOTER MUST NOT BE READ";
export const DELETED_TEXT = "DELETED WORDS MUST NOT BE READ";

/**
 * One paragraph for each line, so that line n of the text is block n of the
 * document. An empty line is an empty paragraph, which is what makes a blank line
 * mean the same in both.
 */
export function docxFromLines(lines: readonly string[], options: LinesOptions = {}): Uint8Array {
  if (!options.noise) {
    return docx({ body: lines.map((line) => (line === "" ? paragraph() : paragraph(run(line)))).join("") });
  }

  const rng = random(options.seed ?? 1);
  let mark = 0;

  const wrap = (chunk: string): string => {
    const text = run(chunk, rng.chance(0.3) ? '<w:lang w:val="en-US"/>' : rng.chance(0.2) ? "<w:noProof/>" : "");
    const roll = rng.below(14);
    switch (roll) {
      case 0:
        return `<w:hyperlink w:anchor="_Ref${++mark}">${text}</w:hyperlink>`;
      case 1:
        return `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> REF _Ref${++mark} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${text}<w:r><w:fldChar w:fldCharType="end"/></w:r>`;
      case 2:
        return `<w:ins w:id="${++mark}" w:author="A Reviewer" w:date="2026-01-01T00:00:00Z">${text}</w:ins>`;
      case 3:
        return `<w:proofErr w:type="spellStart"/>${text}<w:proofErr w:type="spellEnd"/>`;
      case 4:
        return `<w:bookmarkStart w:id="${++mark}" w:name="_Toc${mark}"/>${text}<w:bookmarkEnd w:id="${mark}"/>`;
      default:
        return text;
    }
  };

  const noisyLine = (line: string): string => {
    const attributes = `w:rsidR="${rng.hex()}" w:rsidRDefault="${rng.hex()}"`;
    const properties = rng.chance(0.5) ? '<w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="left"/>' : "";
    if (line === "") {
      return paragraph(rng.chance(0.5) ? '<w:r><w:rPr><w:noProof/></w:rPr></w:r>' : "", properties, attributes);
    }
    // Cut the line at up to three arbitrary points. A cut inside "1." or inside a
    // word is what real Word does when someone edits partway through.
    const cuts = new Set<number>();
    for (let k = rng.below(4); k > 0 && line.length > 1; k--) cuts.add(1 + rng.below(line.length - 1));
    const edges = [0, ...[...cuts].sort((a, b) => a - b), line.length];
    let inner = "";
    for (let k = 0; k + 1 < edges.length; k++) {
      inner += wrap(line.slice(edges[k] as number, edges[k + 1] as number));
      if (rng.chance(0.2)) inner += '<w:r><w:lastRenderedPageBreak/></w:r>';
      if (rng.chance(0.15)) inner += "<w:r/>";
      if (rng.chance(0.1)) {
        inner += `<w:del w:id="${++mark}" w:author="A Reviewer" w:date="2026-01-01T00:00:00Z"><w:r><w:delText xml:space="preserve">${DELETED_TEXT}</w:delText></w:r></w:del>`;
      }
    }
    return paragraph(inner, properties, attributes);
  };

  return docx({ body: lines.map(noisyLine).join(""), headers: [HEADER_TEXT], footers: [FOOTER_TEXT] });
}
