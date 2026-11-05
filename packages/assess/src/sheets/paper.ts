/**
 * The paper that goes with an assembled test: the answer sheet, a booklet and an answer key for each version.
 *
 * One function makes all of it as files in memory, so that the app and the command line print the same thing and neither writes
 * anything here: the caller decides where a file goes and never writes over another. A sheet is a PDF whatever else is asked for, since
 * it has to be printed at its true size; booklets and keys are PDF or Word, as asked. The booklets say to mark the answer sheet only
 * when a sheet is printed, so that a test with no sheet is not told to use one.
 */

import { safeName } from "../export/text.ts";
import { printVersions, type PrintFormat } from "../print/index.ts";
import type { PaperName } from "./geometry.ts";
import { planSheet } from "./plan.ts";
import { printSheet } from "./print.ts";
import type { TestRecord } from "../model/test.ts";

export interface PaperOptions {
  paper: PaperName;
  large: boolean;
  /** One sheet for every version (students fill in the version's bubble), a sheet for each version, or none. */
  sheet: "shared" | "each" | "none";
  booklets: boolean;
  keys: boolean;
  nameBox: boolean;
  /** What the booklets and keys are made as. */
  formats: readonly PrintFormat[];
}

export const DEFAULT_PAPER: PaperOptions = { paper: "letter", large: false, sheet: "shared", booklets: true, keys: true, nameBox: true, formats: ["pdf"] };

export interface PaperFile {
  name: string;
  bytes: Uint8Array;
  kind: "sheet" | "booklet" | "key";
  /** The version it is for, when the test has several. */
  version?: string;
  format: PrintFormat;
  pages?: number;
}

export type PaperResult =
  | { ok: true; files: PaperFile[]; /** What to tell the person: the questions a sheet cannot carry, and what is true of the copies. */ notes: string[]; /** Questions that were left off a copy, and why. */ unprinted: string[] }
  | { ok: false; reason: string };

export function printTestPaper(record: TestRecord, given: Partial<PaperOptions> = {}, at: Date = new Date()): PaperResult {
  const options: PaperOptions = { ...DEFAULT_PAPER, ...given };
  if (options.sheet === "none" && !options.booklets && !options.keys) return { ok: false, reason: "Choose something to print." };
  const files: PaperFile[] = [];
  const notes: string[] = [];
  const title = safeName(record.name, "Test");

  if (options.sheet !== "none") {
    const planned = planSheet(record, { paper: options.paper, large: options.large });
    if (!planned.ok) return { ok: false, reason: `The answer sheet for this test cannot be made: ${planned.reason}.` };
    notes.push(...planned.plan.notes);
    const several = record.versions.length > 1;
    const input = { title: record.name, fingerprint: record.fingerprint, versions: record.versions.length, nameBox: options.nameBox };
    if (options.sheet === "each" && several) {
      for (const [index, version] of record.versions.entries()) {
        const file = printSheet(planned.plan, { ...input, version: index + 1 }, at);
        files.push({ name: `${title} - Answer sheet - Version ${version.label}.pdf`, bytes: file.bytes, kind: "sheet", version: version.label, format: "pdf", pages: file.pages });
      }
    } else {
      const file = printSheet(planned.plan, input, at);
      files.push({ name: `${title} - Answer sheet.pdf`, bytes: file.bytes, kind: "sheet", format: "pdf", pages: file.pages });
    }
  }

  const kinds = [...(options.booklets ? (["student"] as const) : []), ...(options.keys ? (["key"] as const) : [])];
  const unprinted: string[] = [];
  if (kinds.length > 0) {
    for (const format of options.formats) {
      for (const piece of printVersions(record, format, { paper: options.paper, answerOnSheet: options.sheet !== "none" }, kinds, at)) {
        const { file, report } = piece.result;
        for (const general of report.general) if (!notes.includes(general)) notes.push(general);
        for (const item of report.items) if (item.outcome === "leftOut") unprinted.push(`Version ${piece.label}: ${item.notes.join(" ")}`);
        if (file.bytes.length === 0) continue;
        files.push({
          name: file.name,
          bytes: file.bytes,
          kind: piece.kind === "student" ? "booklet" : "key",
          ...(record.versions.length > 1 ? { version: piece.label } : {}),
          format,
          ...(file.pages !== undefined ? { pages: file.pages } : {}),
        });
      }
    }
  }
  return { ok: true, files, notes, unprinted: [...new Set(unprinted)] };
}
