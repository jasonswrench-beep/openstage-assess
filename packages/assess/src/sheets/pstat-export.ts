/**
 * The scored sheets of a class as a `.pstat` file, which PrismStatistics opens as a project with a double-click.
 *
 * The format is the core's (`specs/pstat/PSTAT-1.md` in openstage-core, format 1, spec revision 1.0, locked), and the layout is its
 * profile `OpenAssess item results 1` (section 7.1), followed exactly: one case per complete sheet in sheet-number order; the variables
 * `sheet`, `version` (labelled A, B and on), one `q` variable per question that counts on an exported sheet, holding the points
 * earned (empty where it does not count on that sheet, never 0), and `total`. The question's words are not written, because a results
 * file is shared and a test's questions are kept secure. No name, student id, file name or picture goes in.
 *
 * This is OpenAssess's own writer, not the core's `@openstage/pstat`: the engine has no runtime dependency (`CLAUDE.md`), and the
 * core's notes say a tool with that rule keeps its own writer and holds it to the core's package and test set in its tests
 * (`pstat-export.test.ts` reads every case of the test set with the core's `readPstat` and `checkPstat` when the core is here).
 *
 * The figures are what this class earned after the adjustments, and only those: `operations` and `results` are empty, as the format
 * requires of any writer but PrismStatistics, because an analysis written here would be one PrismStatistics never ran.
 */

import { zipSync } from "../container/zip.ts";
import { safeName } from "../export/text.ts";
import { versionQuestions, VERSION_LABELS, type TestRecord, type VersionLabel } from "../model/test.ts";
import type { SheetScore } from "./score.ts";

export const PSTAT_EXTENSION = ".pstat";
export const PSTAT_FORMAT = "PrismStatistics project";
export const PSTAT_VERSION = 1;
export const PSTAT_PROFILE = "OpenAssess item results 1";
/** The one entry of the archive. */
export const PSTAT_ENTRY = "project.json";

interface Variable {
  id: number;
  name: string;
  label: string;
  measure: "nominal" | "scale";
  value_labels: Array<{ value: number; label: string }>;
  missing_values: number[];
}

export interface PstatProject {
  format: typeof PSTAT_FORMAT;
  version: typeof PSTAT_VERSION;
  app_version: string;
  profile: typeof PSTAT_PROFILE;
  dataset: { name: string; variables: Variable[]; columns: Array<{ type: "numeric"; values: Array<number | null> }>; next_id: number };
  source: { file_name: string; report: { rows: number; variables: number; renamed: never[]; short_rows: 0; notes: string[] } };
  operations: never[];
  results: never[];
}

export interface PstatExport {
  project: PstatProject;
  /** How many sheets went in, and how many were left out because they are not complete. */
  sheets: number;
  leftOut: number;
  /**
   * Why the file must not be written, when it must not: the profile needs at least one sheet and one question, and a file with
   * neither is one the core's checker refuses (rule F1). Undefined when it can be written.
   */
  refused?: string;
}

/**
 * What a writer other than PrismStatistics puts in `app_version`: its own name first, then the release. The app passes the release the
 * installer recorded (the one Check for updates uses); a copy run from the source has none and says so.
 */
export function pstatAppVersion(release: string | undefined, engineVersion: string): string {
  const tag = release?.trim().replace(/^v/, "");
  return tag ? `OpenAssess ${tag}` : `OpenAssess ${engineVersion} (run from the source)`;
}

const letter = (version: number): string => VERSION_LABELS[version - 1] ?? String(version);

/** The project for the scored sheets of a test, in the item results profile. */
export function pstatProject(record: TestRecord, scores: readonly SheetScore[], appVersion: string): PstatExport {
  const sheets = scores.filter((s): s is SheetScore & { version: number } => s.complete && s.version !== undefined).sort((a, b) => a.number - b.number);
  const leftOut = scores.length - sheets.length;
  const notes: string[] = [];
  if (leftOut > 0) notes.push(`${leftOut} sheet${leftOut === 1 ? " was" : "s were"} left out because ${leftOut === 1 ? "it is" : "they are"} not complete: a question that counts is not settled, a page is missing, or the version is not known.`);

  // The questions in the order the test was assembled, which is version A's order. The ones kept are numbered q01, q02 and on with no
  // gap and labelled Question 1, Question 2 and on, as the core's checker holds the profile to (rule F1); when a question counts on no
  // sheet and is left out, the numbers after it are not version A's any more, and a note says which question each is. Named by the
  // version A number instead, the file was refused by the checker whenever a question was dropped or the sheet could not carry it.
  const first = versionQuestions(record, "A" as VersionLabel);
  const kept = first.map((question, i) => ({ question, number: i + 1, cells: sheets.map((s) => {
    const q = s.questions.find((x) => x.questionId === question.id);
    return q && q.possible > 0 ? q.earned : null;
  }) }));
  for (const k of kept) if (sheets.length > 0 && k.cells.every((c) => c === null)) notes.push(`Question ${k.number} counts on none of the sheets written (it was dropped, or the sheet does not carry it), so it is left out.`);
  const counted = kept.filter((k) => k.cells.some((c) => c !== null));
  const width = Math.max(2, String(counted.length).length);
  const items: Array<{ id: string; name: string; label: string; cells: Array<number | null> }> = [];
  const renumbered: string[] = [];
  counted.forEach(({ question, number, cells }, j) => {
    const name = `q${String(j + 1).padStart(width, "0")}`;
    if (j + 1 !== number) renumbered.push(`${name} is question ${number}`);
    items.push({ id: question.id, name, label: `Question ${j + 1}`, cells });
    // Where a question does not count on some sheets, say on which: by version when it is empty on every sheet of those versions.
    const empty = sheets.filter((_s, j) => cells[j] === null);
    if (empty.length > 0) {
      const versions = [...new Set(empty.map((s) => s.version))].sort((a, b) => a - b);
      const byVersion = versions.every((v) => sheets.filter((s) => s.version === v).every((s) => cells[sheets.indexOf(s)] === null));
      notes.push(byVersion ? `${name} does not count on version ${versions.map(letter).join(", ")}, so its cells there are empty.` : `${name} does not count on ${empty.length} of the sheets, so its cells there are empty.`);
    }
  });

  if (renumbered.length > 0) notes.push(`Because a question is left out, the questions after it are numbered in order here and not as on version A: ${renumbered.join(", ")} of version A.`);

  const used = [...new Set(sheets.map((s) => s.version))].sort((a, b) => a - b);
  const variables: Variable[] = [
    { id: 1, name: "sheet", label: "Sheet number", measure: "nominal", value_labels: [], missing_values: [] },
    { id: 2, name: "version", label: "Version", measure: "nominal", value_labels: used.map((v) => ({ value: v, label: letter(v) })), missing_values: [] },
    ...items.map((it, j) => ({ id: 3 + j, name: it.name, label: it.label, measure: "scale" as const, value_labels: [], missing_values: [] })),
    { id: 3 + items.length, name: "total", label: "Total score", measure: "scale", value_labels: [], missing_values: [] },
  ];
  // The total is the sum of the cells written, added in the order of the columns and not rounded, so a reader that adds the question
  // columns gets the same number to the last digit. Rounded to six places, a total of three cells of 0.3333333 was 1 and the cells
  // added to 0.9999999, which the core's checker refused.
  const totals = sheets.map((_s, j) => items.reduce((sum, it) => sum + (it.cells[j] ?? 0), 0));
  const columns = [
    { type: "numeric" as const, values: sheets.map((s) => s.number) },
    { type: "numeric" as const, values: sheets.map((s) => s.version) },
    ...items.map((it) => ({ type: "numeric" as const, values: it.cells })),
    { type: "numeric" as const, values: totals },
  ];
  return {
    project: {
      format: PSTAT_FORMAT,
      version: PSTAT_VERSION,
      app_version: appVersion,
      profile: PSTAT_PROFILE,
      dataset: { name: record.name, variables, columns, next_id: variables.length + 1 },
      source: { file_name: `${record.name} results`, report: { rows: sheets.length, variables: variables.length, renamed: [], short_rows: 0, notes } },
      operations: [],
      results: [],
    },
    sheets: sheets.length,
    leftOut,
    ...(sheets.length === 0 ? { refused: "No sheet is complete, so there is nothing to send for statistics: settle the flagged questions first." } : items.length === 0 ? { refused: "No question counts on the sheets, so there is nothing to send for statistics." } : {}),
  };
}

/**
 * The bytes of the file: `project.json` alone, deflated, as UTF-8 with no byte-order mark, under a fixed date so the same sheets make
 * the same file. JSON.stringify writes a whole number as an integer (`3`, never `3.0`), which the format requires, and every number
 * here is finite.
 */
export function writePstatFile(project: PstatProject): Uint8Array {
  return zipSync([{ name: PSTAT_ENTRY, data: new TextEncoder().encode(JSON.stringify(project)), date: new Date(1980, 0, 1) }]);
}

/** The file's name: the test's title and the date, cut and cleaned as every other file the program names itself. */
export function pstatFileName(testName: string, date: string): string {
  return `${safeName(testName, "Test")} - Results for statistics ${date}${PSTAT_EXTENSION}`;
}
