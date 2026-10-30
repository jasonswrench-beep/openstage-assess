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
  /** Where a block inside a table sits, counting from zero, so a preview can find it. */
  table?: { table: number; row: number; cell: number };
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
