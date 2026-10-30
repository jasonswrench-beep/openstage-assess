/**
 * Profile two: a Word document (.docx).
 *
 * This is a front-end on the importer that already reads the Standard Format. It
 * opens the .docx, turns the body into source blocks (one per visual line, in
 * order, with the list label Word would show kept beside the text), and hands the
 * blocks to the scanner and builder that the plain-text profile uses. So a
 * question written in Word is parsed by the same code, held to the same accuracy
 * gate, and reported with the same findings and orphans as one written in a text
 * file.
 *
 * What it adds is a file-level account of what a Word file holds that a text file
 * cannot: tracked changes, pictures, equations, notes, headers and footers. None
 * of it is dropped without being counted. See docs/word-import-plan.md for the
 * stages that read more of it.
 */

import { finding, FindingCode, type Finding } from "../model/findings.ts";
import { documentToBlocks, type DocumentStats } from "./docx/document.ts";
import { readFormatting } from "./docx/formatting.ts";
import { readNumbering } from "./docx/numbering.ts";
import { DocxError, openDocx, type DocxLimits, type DocxPackage } from "./docx/package.ts";
import { hasText, type XmlElement } from "./docx/xml.ts";
import { standardTextImporter } from "./standard-text.ts";
import type { Importer, ImportOptions, ImportResult, SourceBlock } from "./types.ts";

export const WORD_PROFILE_ID = "word-docx";

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Headers and footers are not part of a question, but a question could be put in one, so they are counted. */
function headersAndFootersWithText(pkg: DocxPackage): number {
  let count = 0;
  for (const name of pkg.names) {
    if (!/^word\/(header|footer)\d*\.xml$/i.test(name)) continue;
    try {
      const part = pkg.xml(name);
      if (part && hasText(part)) count++;
    } catch {
      // A damaged header is not a reason to refuse the body of the document.
    }
  }
  return count;
}

/**
 * A part the document may or may not have, found by the document's own
 * relationships and failing that by its usual name. A part that is there and
 * cannot be read is reported and not fatal: the body of the document is still worth reading.
 */
function optionalPart(pkg: DocxPackage, kind: string, usual: string): { root?: XmlElement; damaged?: string } {
  const name = pkg.related(kind) ?? (pkg.has(usual) ? usual : undefined);
  if (name === undefined) return {};
  try {
    const root = pkg.xml(name);
    return root ? { root } : {};
  } catch (error) {
    if (error instanceof DocxError) return { damaged: error.message };
    throw error;
  }
}

function findingsFrom(stats: DocumentStats, headersAndFooters: number, stylesDamaged: string | undefined): Finding[] {
  const found: Finding[] = [];

  for (const [reason, count] of Object.entries(stats.unreadLists)) {
    found.push(
      finding(
        FindingCode.UnreadContent,
        "warn",
        `${plural(count, "paragraph is", "paragraphs are")} in a numbered list whose number could not be worked out, because ${reason}. ` +
          `${count === 1 ? "It is" : "They are"} read without a number, and nothing was guessed.`,
      ),
    );
  }
  if (stylesDamaged !== undefined) {
    found.push(
      finding(
        FindingCode.UnreadContent,
        "warn",
        `The styles of this file could not be read, so a number that comes from a paragraph style may be missing. ${stylesDamaged}`,
      ),
    );
  }

  if (stats.trackedInsertions + stats.trackedDeletions > 0) {
    found.push(
      finding(
        FindingCode.TrackedChangesPresent,
        "warn",
        `This document has tracked changes (${plural(stats.trackedInsertions, "insertion", "insertions")}, ${plural(stats.trackedDeletions, "deletion", "deletions")}). ` +
          `It is read with the changes accepted: inserted text is kept and deleted text is left out.`,
      ),
    );
  }
  const layouts = Object.entries(stats.tableLayouts);
  if (layouts.length > 0) {
    const total = layouts.reduce((sum, [, n]) => sum + n, 0);
    found.push(
      finding(
        FindingCode.TableLayout,
        "info",
        `${plural(total, "table was", "tables were")} read as questions: ${layouts.map(([layout, n]) => `${n} as ${layout === "grid" ? "a grid with a header row" : layout === "answer key" ? "an answer key" : layout === "numbered cells" ? "a number in one cell and the question in the next" : layout === "matching rows" ? "a term and its definition in each row" : "labelled rows"}`).join(", ")}.`,
      ),
    );
  }
  if (stats.tablesPlain > 0) {
    found.push(
      finding(
        FindingCode.TableLayout,
        "info",
        `${plural(stats.tablesPlain, "table was", "tables were")} read cell by cell, in order, as plain text. A table is read as questions when it is a grid headed Question and A, B, C, a table of rows that begin with a label such as 1. or b., an answer key, or a number in one cell with the question in the next, and has no cells merged down.`,
      ),
    );
  }
  if (stats.pictures > 0) {
    found.push(
      finding(
        FindingCode.UnreadContent,
        "warn",
        `${plural(stats.pictures, "picture, shape or text box was", "pictures, shapes or text boxes were")} not read. Each is marked [picture] in the text where it stood.`,
      ),
    );
  }
  if (stats.equations > 0) {
    found.push(
      finding(
        FindingCode.UnreadContent,
        "warn",
        `${plural(stats.equations, "equation was", "equations were")} not read. Each is marked [equation] in the text where it stood.`,
      ),
    );
  }
  if (stats.symbols > 0) {
    found.push(
      finding(FindingCode.UnreadContent, "warn", `${plural(stats.symbols, "symbol character was", "symbol characters were")} not read.`),
    );
  }
  if (stats.notes > 0) {
    found.push(
      finding(
        FindingCode.UnreadContent,
        "warn",
        `${plural(stats.notes, "footnote or endnote is", "footnotes or endnotes are")} referred to, and the notes themselves are not read.`,
      ),
    );
  }
  for (const [name, count] of Object.entries(stats.unreadWithText)) {
    found.push(finding(FindingCode.UnreadContent, "warn", `Text in ${name} was not read (${plural(count, "place", "places")}).`));
  }
  if (stats.comments > 0) {
    found.push(
      finding(FindingCode.UnreadContent, "info", `${plural(stats.comments, "comment is", "comments are")} attached to the text, and comments are not read.`),
    );
  }
  if (headersAndFooters > 0) {
    found.push(
      finding(
        FindingCode.UnreadContent,
        "info",
        `${plural(headersAndFooters, "header or footer has", "headers or footers have")} text, which is not read. Headers and footers are not part of a question.`,
      ),
    );
  }
  return found;
}

/** A .docx as source blocks, and what the file holds that the blocks do not. */
export function docxToBlocks(bytes: Uint8Array, limits?: DocxLimits): { blocks: SourceBlock[]; findings: Finding[] } {
  const pkg = openDocx(bytes, limits);
  const root = pkg.xml(pkg.mainDocument);
  if (!root) throw new DocxError(`The main document part "${pkg.mainDocument}" could not be read.`);
  const numberingPart = optionalPart(pkg, "numbering", "word/numbering.xml");
  const stylesPart = optionalPart(pkg, "styles", "word/styles.xml");
  const numbering = readNumbering({ numbering: numberingPart.root, styles: stylesPart.root, numberingDamaged: numberingPart.damaged });
  const { blocks, stats } = documentToBlocks(root, numbering, readFormatting(stylesPart.root));
  return { blocks, findings: findingsFrom(stats, headersAndFootersWithText(pkg), stylesPart.damaged) };
}

/** An importer whose bytes entry point is always there, which is what a caller of this one relies on. */
export const wordImporter: Importer & { parseBytes: NonNullable<Importer["parseBytes"]> } = {
  id: WORD_PROFILE_ID,
  label: "Word document (.docx)",
  extensions: [".docx"],

  /** Blocks already made from a Word file. Text is not accepted: a .docx is bytes. */
  parse(input: string | SourceBlock[], options: ImportOptions = {}): ImportResult {
    if (typeof input === "string") {
      throw new Error("The Word importer reads a .docx file as bytes. Use parseBytes, or pass source blocks.");
    }
    return standardTextImporter.parse(input, { ...options, profile: WORD_PROFILE_ID, file: options.file ?? "input.docx" });
  },

  parseBytes(bytes: Uint8Array, options: ImportOptions = {}): ImportResult {
    const { blocks, findings } = docxToBlocks(bytes);
    const result = standardTextImporter.parse(blocks, { ...options, profile: WORD_PROFILE_ID, file: options.file ?? "input.docx" });
    return { ...result, fileFindings: [...findings, ...result.fileFindings] };
  },
};
