/**
 * The body of a Word document as source blocks.
 *
 * A block is one visual line: a paragraph, or one line of a paragraph that has
 * soft line breaks in it. Blocks keep document order, and an empty paragraph is an
 * empty block, so that a blank line in a Word test bank is a blank line to the
 * scanner exactly as it is in a text file. That one-to-one alignment is what lets
 * the same questions, written as a text file and as a .docx, be compared line for
 * line.
 *
 * What is read: the text of runs, tabs, line breaks, and the content of
 * hyperlinks, fields, smart tags, content controls and tracked insertions. What
 * is not: deleted text (tracked deletions), field codes, and the formatting
 * properties, which later stages read for list numbering and answer marks.
 *
 * Nothing is dropped silently. Pictures, shapes and equations are not read yet, so
 * each leaves a visible marker ("[picture]", "[equation]") in the text and is
 * counted. Anything else that holds text and was not read is counted by name. The
 * caller turns those counts into findings.
 */

import type { SourceBlock } from "../types.ts";
import { DocxError } from "./package.ts";
import { allText, elements, first, hasText, type XmlElement } from "./xml.ts";

export interface DocumentStats {
  paragraphs: number;
  tables: number;
  trackedInsertions: number;
  trackedDeletions: number;
  /** Pictures, shapes, text boxes and embedded objects, each replaced by "[picture]". */
  pictures: number;
  /** Word equations, each replaced by "[equation]". */
  equations: number;
  /** Symbol characters (a font glyph by code), which are not read. */
  symbols: number;
  /** References to footnotes and endnotes. The notes themselves are not read. */
  notes: number;
  /** References to comments. The comments themselves are not read. */
  comments: number;
  /** Elements that hold text and were not read, by name. */
  unreadWithText: Record<string, number>;
}

export interface DocumentBlocks {
  blocks: SourceBlock[];
  stats: DocumentStats;
}

/** Elements that carry no text of their own and are skipped without comment. */
const SILENT = new Set([
  "w:pPr",
  "w:rPr",
  "w:sectPr",
  "w:bookmarkStart",
  "w:bookmarkEnd",
  "w:proofErr",
  "w:permStart",
  "w:permEnd",
  "w:commentRangeStart",
  "w:commentRangeEnd",
  "w:moveFromRangeStart",
  "w:moveFromRangeEnd",
  "w:moveToRangeStart",
  "w:moveToRangeEnd",
  "w:sdtPr",
  "w:sdtEndPr",
  "w:tblPr",
  "w:tblGrid",
  "w:trPr",
  "w:tcPr",
  "w:tblPrEx",
  "w:lastRenderedPageBreak",
  "w:fldChar",
  "w:instrText",
  "w:delText",
  "w:annotationRef",
  "w:separator",
  "w:continuationSeparator",
  "w:noProof",
]);

/** Inline containers whose runs are read as part of the paragraph. */
const INLINE_CONTAINERS = new Set([
  "w:hyperlink",
  "w:smartTag",
  "w:fldSimple",
  "w:sdt",
  "w:sdtContent",
  "w:customXml",
  "w:dir",
  "w:bdo",
]);

const OBJECTS = new Set(["w:drawing", "w:pict", "w:object", "mc:AlternateContent"]);

interface Location {
  table: number;
  row: number;
  cell: number;
}

export function documentToBlocks(root: XmlElement): DocumentBlocks {
  if (root.name !== "w:document") {
    throw new DocxError(`The main document part starts with <${root.name}>, not <w:document>, so it is not a Word document.`);
  }
  const body = first(root, "w:body");
  if (!body) throw new DocxError("The main document part has no body.");

  const blocks: SourceBlock[] = [];
  const stats: DocumentStats = {
    paragraphs: 0,
    tables: 0,
    trackedInsertions: 0,
    trackedDeletions: 0,
    pictures: 0,
    equations: 0,
    symbols: 0,
    notes: 0,
    comments: 0,
    unreadWithText: {},
  };

  const unread = (name: string): void => {
    stats.unreadWithText[name] = (stats.unreadWithText[name] ?? 0) + 1;
  };

  /** The lines of the paragraph being read. A soft break starts a new one. */
  interface Lines {
    lines: string[];
  }
  const add = (b: Lines, text: string): void => {
    b.lines[b.lines.length - 1] += text;
  };
  const newLine = (b: Lines): void => {
    b.lines.push("");
  };

  function run(r: XmlElement, b: Lines): void {
    for (const child of r.children) {
      if (typeof child === "string") continue;
      switch (child.name) {
        case "w:t":
          add(b, allText(child));
          break;
        case "w:tab":
        case "w:ptab":
          add(b, "\t");
          break;
        case "w:br": {
          // A page or column break moves the text on the page but is not a line
          // of its own, so it must not turn a paragraph into two lines.
          const type = child.attrs["w:type"];
          if (type !== "page" && type !== "column") newLine(b);
          break;
        }
        case "w:cr":
          newLine(b);
          break;
        case "w:noBreakHyphen":
          add(b, "-");
          break;
        case "w:softHyphen":
          break;
        case "w:sym":
          stats.symbols++;
          break;
        case "w:footnoteReference":
        case "w:endnoteReference":
          stats.notes++;
          break;
        case "w:commentReference":
          stats.comments++;
          break;
        default:
          if (OBJECTS.has(child.name)) {
            stats.pictures++;
            add(b, "[picture]");
            if (hasText(child)) unread("text inside a picture, shape or text box");
          } else if (!SILENT.has(child.name) && hasText(child)) {
            unread(child.name);
          }
      }
    }
  }

  function inline(parent: XmlElement, b: Lines): void {
    for (const child of parent.children) {
      if (typeof child === "string") continue;
      const name = child.name;
      if (name === "w:r") run(child, b);
      else if (name === "w:ins" || name === "w:moveTo") {
        stats.trackedInsertions++;
        inline(child, b);
      } else if (name === "w:del" || name === "w:moveFrom") {
        // Deleted text is what the author removed, so the text read is the
        // document with the changes accepted. The count says that this happened.
        stats.trackedDeletions++;
      } else if (INLINE_CONTAINERS.has(name)) inline(child, b);
      else if (name === "m:oMath" || name === "m:oMathPara") {
        stats.equations++;
        add(b, "[equation]");
      } else if (OBJECTS.has(name)) {
        stats.pictures++;
        add(b, "[picture]");
        if (hasText(child)) unread("text inside a picture, shape or text box");
      } else if (!SILENT.has(name) && hasText(child)) unread(name);
    }
  }

  function paragraph(p: XmlElement, where: Location | undefined): void {
    stats.paragraphs++;
    const b: Lines = { lines: [""] };
    inline(p, b);
    // A line break at the very end of a paragraph is not a blank line after it.
    while (b.lines.length > 1 && b.lines[b.lines.length - 1] === "") b.lines.pop();
    for (const text of b.lines) {
      blocks.push({ index: blocks.length, text, ...(where ? { table: where } : {}) });
    }
  }

  function table(tbl: XmlElement): void {
    const number = stats.tables++;
    elements(tbl, "w:tr").forEach((tr, row) => {
      elements(tr, "w:tc").forEach((tc, cell) => container(tc, { table: number, row, cell }));
    });
  }

  function container(parent: XmlElement, where: Location | undefined): void {
    for (const child of parent.children) {
      if (typeof child === "string") continue;
      const name = child.name;
      if (name === "w:p") paragraph(child, where);
      else if (name === "w:tbl") table(child);
      else if (name === "w:sdt" || name === "w:sdtContent" || name === "w:customXml") container(child, where);
      else if (name === "w:ins" || name === "w:moveTo") {
        stats.trackedInsertions++;
        container(child, where);
      } else if (name === "w:del" || name === "w:moveFrom") stats.trackedDeletions++;
      else if (!SILENT.has(name) && hasText(child)) unread(name);
    }
  }

  container(body, undefined);
  return { blocks, stats };
}
