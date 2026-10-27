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
  text: string;
  kind?: "paragraph" | "listItem" | "tableRow" | "heading";
  /** Set by the Word parser in phase 2. */
  runs?: SourceRun[];
  /** The literal list label Word would render, resolved from numbering.xml. */
  listLabel?: string;
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
}

export interface Importer {
  id: string;
  label: string;
  /** File extensions this importer reads, including the dot. */
  extensions: string[];
  parse(input: string | SourceBlock[], options?: ImportOptions): ImportResult;
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
