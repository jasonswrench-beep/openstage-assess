/**
 * Printing a test: the questions laid out once, and written as a Word file or a PDF.
 */

import type { DestinationReport } from "../export/types.ts";
import { plural, safeName } from "../export/text.ts";
import type { Question } from "../model/question.ts";
import { versionQuestions, type TestRecord, type VersionLabel } from "../model/test.ts";
import { writeDocx } from "./docx.ts";
import { DEFAULT_OPTIONS, layoutTest, type PrintOptions } from "./layout.ts";
import { writePdf } from "./pdf.ts";

export { DEFAULT_OPTIONS, layoutTest, PAPERS, paragraphsOf, PRINT_ID, PRINT_LABEL, shuffledFor } from "./layout.ts";
export type { Block, Layout, Paper, Para, PictureBlock, PrintDocument, PrintedPicture, PrintOptions, Run } from "./layout.ts";
export { writeDocx } from "./docx.ts";
export { writePdf } from "./pdf.ts";
export type { PdfResult } from "./pdf.ts";

export type PrintFormat = "docx" | "pdf";

export interface PrintedFile {
  name: string;
  bytes: Uint8Array;
  pages?: number;
}

export interface PrintResult {
  file: PrintedFile;
  report: DestinationReport;
}

/** The options a caller gave, with what it did not give filled in, and the ones that must be sane made so. */
export function printOptions(given: Partial<PrintOptions> & { title: string }): PrintOptions {
  const merged: PrintOptions = { ...DEFAULT_OPTIONS, ...given };
  return {
    ...merged,
    fontSize: Math.min(14, Math.max(9, merged.fontSize)),
    shortAnswerLines: Math.min(10, Math.max(0, Math.round(merged.shortAnswerLines))),
    essayLines: Math.min(40, Math.max(0, Math.round(merged.essayLines))),
  };
}

export interface VersionPrint {
  label: VersionLabel;
  kind: "student" | "key";
  result: PrintResult;
}

/**
 * Every version of an assembled test as a student booklet and an answer key. The questions are the record's own copies in each
 * version's order, so the booklets and keys come out the same on every printing and do not move when the bank is edited. A test of
 * one version is printed without a version, since there is nothing to tell apart.
 */
export function printVersions(
  record: TestRecord,
  format: PrintFormat,
  more: Partial<Omit<PrintOptions, "title" | "kind" | "versionLabel">> = {},
  kinds: ReadonlyArray<"student" | "key"> = ["student", "key"],
  at: Date = new Date(),
): VersionPrint[] {
  const several = record.versions.length > 1;
  const out: VersionPrint[] = [];
  for (const version of record.versions) {
    const questions = versionQuestions(record, version.label);
    for (const kind of kinds) {
      const options = printOptions({
        ...more,
        title: record.name,
        kind,
        ...(several ? { versionLabel: version.label } : {}),
        ...(kind === "student" ? { answerOnSheet: more.answerOnSheet ?? true } : { keyStrip: more.keyStrip ?? true }),
      });
      out.push({ label: version.label, kind, result: printTest(questions, options, format, at) });
    }
  }
  return out;
}

/** A student copy or an answer key, as a file, and the report of what it holds. */
export function printTest(questions: readonly Question[], options: PrintOptions, format: PrintFormat, at: Date = new Date()): PrintResult {
  const { document, report } = layoutTest(questions, { ...options, format });
  const kind = options.kind === "key" ? "Answer key" : "Student copy";
  const version = options.versionLabel && options.versionLabel.trim() !== "" ? ` - Version ${safeName(options.versionLabel, "")}` : "";
  const name = `${safeName(options.title, "Test")}${version} - ${kind}.${format}`;
  const printable = report.items.filter((item) => item.outcome !== "leftOut").length;

  if (printable === 0) return { file: { name, bytes: new Uint8Array(0) }, report: { ...report, files: [] } };

  if (format === "docx") {
    return { file: { name, bytes: writeDocx(document, at) }, report: { ...report, files: [name] } };
  }

  const pdf = writePdf(document, at);
  const general = [...report.general];
  if (pdf.replaced.length > 0) {
    const total = pdf.replaced.reduce((sum, r) => sum + r.count, 0);
    const shown = pdf.replaced.slice(0, 6).map((r) => `${r.char} (${plural(r.count, "time", "times")})`).join(", ");
    general.push(`${plural(total, "character", "characters")} cannot be drawn in a PDF's built-in fonts and were printed as ?: ${shown}. The Word file can hold any text.`);
  }
  general.push("The PDF is not tagged for screen readers. The Word file reads better with one.");
  return { file: { name, bytes: pdf.bytes, pages: pdf.pages }, report: { ...report, general, files: [name] } };
}
