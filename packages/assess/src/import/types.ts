/**
 * The importer interface.
 *
 * Every importer, including the Word parser that phase 2 builds, produces the
 * same result shape: questions, orphans, and counts. Two things are
 * non-negotiable across all of them.
 *
 * Provenance: every question records the block range it was built from, so the
 * repair preview can put the original text beside the parsed question. Without
 * it the promise that nothing is dropped silently cannot be kept.
 *
 * Orphans: text that no question claimed is reported, not discarded. A chapter
 * heading mistaken for a stem and a question the parser missed surface the
 * same way.
 */

import type { Finding, SourceRef, Verdict } from "../model/findings.ts";
import { verdictFrom } from "../model/findings.ts";
import type { Question } from "../model/question.ts";
import type { MathReading } from "./docx/omml.ts";

/**
 * One unit of source text with its position.
 *
 * For a plain-text file a block is a line. For a Word file it is a paragraph
 * or a table row, and it carries run-level formatting so that a bold or
 * highlighted option can be recognised as an answer mark.
 */
export interface SourceBlock {
  index: number;
  /**
   * The text of the block, without its list label. A block is one visual line,
   * so a soft line break in a Word paragraph starts a new block.
   */
  text: string;
  kind?: "paragraph" | "listItem" | "tableRow" | "heading";
  /** Set by the Word parser in phase 2. */
  runs?: SourceRun[];
  /**
   * The literal list label Word would render, resolved from numbering.xml. The
   * scanner reads the block as `${listLabel} ${text}`, which is what the page
   * shows, so a question numbered by Word is read like one numbered by hand.
   */
  listLabel?: string;
  /** The block is a bullet of a Word list: it shows a mark and no label, which is what tells an option from a stem in a bank that letters nothing. */
  bullet?: true;
  /** The block is a later line of a bulleted paragraph, after a soft line break: more of the same item, not another. */
  bulletMore?: true;
  /**
   * Where a block inside a table sits, counting from zero, so a preview can find it. `plain` is set when the table was none of the
   * question layouts, so its cells were read one by one, in order, as lines of text: a question that holds one has lost the table's
   * rows and columns, and is flagged for it.
   */
  table?: { table: number; row: number; cell: number; plain?: true };
}

export interface SourceRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  highlight?: string;
  color?: string;
}

export interface Orphan {
  source: SourceRef;
  text: string;
  reason: string;
}

export interface ImportCounts {
  parsed: number;
  needsReview: number;
  failed: number;
  orphans: number;
}

export interface ImportResult {
  profile: string;
  file: string;
  questions: Question[];
  orphans: Orphan[];
  counts: ImportCounts;
  /** Problems with the file as a whole rather than with one question. */
  fileFindings: Finding[];
  /**
   * For a format whose blocks are not the lines of the file (a spreadsheet's are its rows), the lines that a question's
   * source blocks point at, as they are to be shown beside it. Absent for the others, whose blocks are read from the file
   * by whoever shows them.
   */
  sourceLines?: string[];
  /**
   * The pictures the file held and the questions refer to, by the path each has inside a bank (media/p-<hash>.png), as the bytes to
   * write there. A question's `media` entry names its file by the same path. Absent when the file had none that could be kept. A
   * picture that no saved question refers to is not written to a bank.
   */
  media?: ReadonlyMap<string, Uint8Array>;
}

export interface ImportOptions {
  /** Used in provenance and messages; not a path on disk. */
  file?: string;
  /** Default point value for questions the file does not price. */
  defaultPoints?: number;
  author?: string;
  at?: string;
  /** The profile to record in each question's provenance. Defaults to the importer's own. */
  profile?: string;
  /**
   * What the file's formatting means, for files that mark the correct option by
   * making it bold, underlined, highlighted or coloured. "auto", the default,
   * decides from the file and reports what it decided. "off" reads no key from
   * formatting. A property name ("bold", "italic", "underline", "highlight",
   * "highlight:yellow", "color", "color:FF0000") says what the mark is, for a file
   * whose author has said so. Formatting only supplies a key where the file gave
   * none in words.
   */
  keyMark?: string;
  /**
   * The equations a reader found, by the name it wrote in the tag `[ eq: "name" ]` where each stood. Set by a reader that has
   * equations (the Word reader) and not by a caller; the tags are turned into the question's equations while the lines are read.
   */
  math?: ReadonlyMap<string, MathReading>;
  /**
   * The grids a reader found among the tables that are none of the question layouts, by the table's number (the `table` of a block's
   * place). A question with one inside its text keeps it as a table; one that is not here is read cell by cell, as lines of text.
   */
  tables?: ReadonlyMap<number, ReadTable>;
}

/** A table that is a grid of two or more rows and columns, as the reader found it. Cell text is lines joined by a line break. */
export interface ReadTable {
  rows: Array<{ header: boolean; cells: Array<{ text: string; span: number }> }>;
}

export interface Importer {
  id: string;
  label: string;
  /** File extensions this importer reads, including the dot. */
  extensions: string[];
  parse(input: string | SourceBlock[], options?: ImportOptions): ImportResult;
  /**
   * For a format that is not text, such as .docx. When it is present the file is
   * read as bytes and handed here, and `parse` is not used for files.
   */
  parseBytes?(bytes: Uint8Array, options?: ImportOptions): ImportResult;
}

export function verdictOf(question: Question): Verdict {
  return verdictFrom(question.findings);
}

export function countVerdicts(questions: readonly Question[], orphans: number): ImportCounts {
  const counts: ImportCounts = { parsed: 0, needsReview: 0, failed: 0, orphans };
  for (const question of questions) {
    const verdict = verdictOf(question);
    if (verdict === "parsed") counts.parsed++;
    else if (verdict === "needsReview") counts.needsReview++;
    else counts.failed++;
  }
  return counts;
}

/** Turn a plain-text file into blocks, one per line, keeping line numbers. */
export function linesToBlocks(text: string): SourceBlock[] {
  return text.replace(/\r\n?/g, "\n").split("\n").map((line, index) => ({ index, text: line }));
}
