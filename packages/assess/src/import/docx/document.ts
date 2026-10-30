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
 * hyperlinks, fields, smart tags, content controls and tracked insertions, and the
 * label that Word's own lists put in front of a paragraph (kept in `listLabel`,
 * apart from the text). What is not: deleted text (tracked deletions), field
 * codes, and the formatting of runs, which a later stage reads for answer marks.
 *
 * Nothing is dropped silently. Pictures, shapes and equations are not read yet, so
 * each leaves a visible marker ("[picture]", "[equation]") in the text and is
 * counted. Anything else that holds text and was not read is counted by name. The
 * caller turns those counts into findings.
 */

import type { SourceBlock, SourceRun } from "../types.ts";
import type { Formatting, RunFormat } from "./formatting.ts";
import type { Numbering } from "./numbering.ts";
import { readTable, type Cell, type Line as TableLine } from "./tables.ts";
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
  /** Paragraphs given a label by Word's list numbering, such as "3." or "b)". */
  listItems: number;
  /** Paragraphs in a list whose number could not be worked out, by the reason. They are left unnumbered. */
  unreadLists: Record<string, number>;
  /** Tables read as a layout of questions, by the layout. */
  tableLayouts: Record<string, number>;
  /** Tables read cell by cell as plain text: no layout was recognised, or the table is too involved to trust one. */
  tablesPlain: number;
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

/** Whether the paragraph mark was deleted by a tracked change, which takes the paragraph with it if nothing else is left. */
function markDeleted(properties: XmlElement | undefined): boolean {
  const mark = properties ? first(properties, "w:rPr") : undefined;
  return mark !== undefined && (first(mark, "w:del") !== undefined || first(mark, "w:moveFrom") !== undefined);
}

/**
 * Whether a table can be read as a layout at all: no table inside a cell, no cell
 * merged down, and no row that starts late or ends early. A cell read under the wrong
 * column is a wrong answer. A cell merged across is allowed through and marked, since
 * a line of text spread over the width of a table is ordinary, and each layout says
 * whether it can live with one.
 */
function isSimple(rows: XmlElement[]): boolean {
  const merged = (cell: XmlElement): boolean => {
    const properties = first(cell, "w:tcPr");
    return properties !== undefined && first(properties, "w:vMerge") !== undefined;
  };
  const holdsTable = (element: XmlElement): boolean =>
    element.children.some((child) => typeof child !== "string" && (child.name === "w:tbl" || holdsTable(child)));
  return rows.every((tr) => {
    const properties = first(tr, "w:trPr");
    if (properties && (first(properties, "w:gridBefore") || first(properties, "w:gridAfter"))) return false;
    return elements(tr, "w:tc").every((tc) => !merged(tc) && !holdsTable(tc));
  });
}

const NO_FORMAT: RunFormat = {};

const sameFormat = (a: RunFormat, b: RunFormat): boolean =>
  a.bold === b.bold && a.italic === b.italic && a.underline === b.underline && a.highlight === b.highlight && a.color === b.color;

/**
 * The body as blocks. `numbering` supplies the labels of Word's own lists; without
 * it a numbered paragraph is read as the plain text it holds. `formatting` supplies
 * how each run looks, which is kept on the block as `runs`; without it blocks have
 * no runs.
 */
export function documentToBlocks(root: XmlElement, numbering?: Numbering, formatting?: Formatting): DocumentBlocks {
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
    listItems: 0,
    unreadLists: {},
    tableLayouts: {},
    tablesPlain: 0,
  };

  const unread = (name: string): void => {
    stats.unreadWithText[name] = (stats.unreadWithText[name] ?? 0) + 1;
  };

  /** While a table's cells are being read, their lines are gathered here and not yet blocks. */
  let collecting: TableLine[] | undefined;
  const emit = (line: TableLine): void => {
    if (collecting) collecting.push(line);
    else blocks.push({ index: blocks.length, ...line });
  };

  /**
   * The lines of the paragraph being read. A soft break starts a new one. Each line
   * keeps its text as runs of one format, which always add up to the text.
   */
  interface Line {
    text: string;
    runs: SourceRun[];
  }
  interface Lines {
    lines: Line[];
    /** The id of the paragraph's style, which a run's format can depend on. */
    style: string | undefined;
  }
  const add = (b: Lines, text: string, format: RunFormat = NO_FORMAT): void => {
    if (text === "") return;
    const line = b.lines[b.lines.length - 1] as Line;
    line.text += text;
    const last = line.runs[line.runs.length - 1];
    if (last && sameFormat(last, format)) last.text += text;
    else line.runs.push({ text, ...format });
  };
  const newLine = (b: Lines): void => {
    b.lines.push({ text: "", runs: [] });
  };

  function run(r: XmlElement, b: Lines): void {
    const format = formatting ? formatting.run(first(r, "w:rPr"), b.style) : NO_FORMAT;
    for (const child of r.children) {
      if (typeof child === "string") continue;
      switch (child.name) {
        case "w:t":
          add(b, allText(child), format);
          break;
        case "w:tab":
        case "w:ptab":
          add(b, "\t", format);
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
          add(b, "-", format);
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
            add(b, "[picture]", format);
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
    const properties = first(p, "w:pPr");
    const b: Lines = { lines: [{ text: "", runs: [] }], style: properties ? first(properties, "w:pStyle")?.attrs["w:val"] : undefined };
    inline(p, b);
    // A line break at the very end of a paragraph is not a blank line after it.
    while (b.lines.length > 1 && (b.lines[b.lines.length - 1] as Line).text === "") b.lines.pop();

    // A paragraph whose mark was deleted and whose text was deleted with it is gone
    // once the changes are accepted, and so is its number. Leaving it would count it
    // in its list and put every number after it out by one.
    if (markDeleted(properties) && b.lines.every((line) => line.text === "")) return;

    // The label belongs on the first line only: a soft break inside a numbered
    // paragraph does not start another item.
    const listed = numbering?.label(properties);
    if (listed?.unread !== undefined) stats.unreadLists[listed.unread] = (stats.unreadLists[listed.unread] ?? 0) + 1;
    const label = listed?.label;
    if (label !== undefined) stats.listItems++;

    b.lines.forEach((line, k) => {
      emit({
        text: line.text,
        ...(formatting ? { runs: line.runs } : {}),
        ...(k === 0 && label !== undefined ? { kind: "listItem" as const, listLabel: label } : {}),
        ...(where ? { table: where } : {}),
      });
    });
  }

  /**
   * A table is first read into its cells, because what a row means depends on the
   * cells beside it. Counting, numbering and formatting all happen as the cells are
   * read, in document order, exactly as they did when each cell became blocks at
   * once. Then the table is either one of the layouts, and stands for the lines of
   * questions it holds, or it is not, and its cells become blocks cell by cell as
   * they always did.
   */
  function table(tbl: XmlElement): void {
    const number = stats.tables++;
    const rows = elements(tbl, "w:tr");

    if (!isSimple(rows)) {
      stats.tablesPlain++;
      rows.forEach((tr, row) => {
        elements(tr, "w:tc").forEach((tc, cell) => container(tc, { table: number, row, cell }));
      });
      return;
    }

    const cells: Cell[][] = rows.map((tr, row) =>
      elements(tr, "w:tc").map((tc, cell) => {
        const lines: TableLine[] = [];
        collecting = lines;
        container(tc, { table: number, row, cell });
        collecting = undefined;
        const properties = first(tc, "w:tcPr");
        const span = properties ? first(properties, "w:gridSpan")?.attrs["w:val"] : undefined;
        const across = (span !== undefined && Number(span) > 1) || (properties !== undefined && first(properties, "w:hMerge") !== undefined);
        return { lines, ...(across ? { merged: true } : {}) };
      }),
    );

    const reading = readTable(cells, { runs: formatting !== undefined, previous: blocks[blocks.length - 1]?.text ?? "" });
    if (reading.layout) {
      stats.tableLayouts[reading.layout] = (stats.tableLayouts[reading.layout] ?? 0) + 1;
      for (const line of reading.lines) emit(line);
    } else {
      stats.tablesPlain++;
      for (const row of cells) for (const cell of row) for (const line of cell.lines) emit(line);
    }
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
