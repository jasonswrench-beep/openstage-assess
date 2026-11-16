/**
 * The scored sheets of a class as a `.pstat` file, which PrismStatistics opens as a project with a double-click.
 *
 * The format is the core's (`specs/pstat/PSTAT-1.md` in openstage-core, format 1, spec revision 1.1, locked), and the layout is its
 * profile `OpenAssess item results 1` (section 7.1), followed exactly, or profile 2 (section 7.2, `pstatProject2` below), which adds
 * the letters marked and the part `assessment.json` (the key, the item details and the bank's ids). Profile 1 is: one case per complete sheet in sheet-number order; the variables
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
import { isChoice, isMultipleResponse, isTrueFalse, type Question } from "../model/question.ts";
import { letterFor, versionQuestions, VERSION_LABELS, type TestRecord, type VersionLabel } from "../model/test.ts";
import { hasUsableKey } from "../quality/answer-key.ts";
import { keyOf, pointsOf, type Adjustment, type SheetScore } from "./score.ts";

export const PSTAT_EXTENSION = ".pstat";
export const PSTAT_FORMAT = "PrismStatistics project";
export const PSTAT_VERSION = 1;
export const PSTAT_PROFILE = "OpenAssess item results 1";
export const PSTAT_PROFILE_2 = "OpenAssess item results 2";
/** Profile 2's part: the second entry of the archive. */
export const PSTAT_PART = "assessment.json";
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
  profile: typeof PSTAT_PROFILE | typeof PSTAT_PROFILE_2;
  dataset: { name: string; variables: Variable[]; columns: Array<{ type: "numeric"; values: Array<number | null> } | { type: "text"; values: Array<string | null> }>; next_id: number };
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

/** Why a question counts on no sheet, in the words the core's test set uses for a dropped one, when every sheet gives one reason. */
function whyLeftOut(sheets: readonly SheetScore[], id: string): string {
  const outcomes = new Set(sheets.map((s) => s.questions.find((q) => q.questionId === id)?.outcome ?? "notOnSheet"));
  if (outcomes.size === 1) {
    const only = [...outcomes][0];
    if (only === "dropped") return "it was dropped";
    if (only === "notOnSheet") return "the sheet does not carry it";
    if (only === "notScored") return "it has no usable answer key, so it is not scored";
  }
  return "it was dropped, or the sheet does not carry it";
}

/** The project for the scored sheets of a test, in the item results profile. */
export function pstatProject(record: TestRecord, scores: readonly SheetScore[], appVersion: string): PstatExport {
  const sheets = scores.filter((s): s is SheetScore & { version: number } => s.complete && s.version !== undefined).sort((a, b) => a.number - b.number);
  const leftOut = scores.length - sheets.length;
  const notes: string[] = [];
  if (leftOut > 0) notes.push(`${leftOut} sheet${leftOut === 1 ? " was" : "s were"} left out because ${leftOut === 1 ? "it is" : "they are"} not complete: a question that counts is not settled, a page is missing, or the version is not known.`);

  // The questions in the order the test was assembled, which is version A's order, each named and labelled by its number there, with
  // the digits version A's count of questions needs. A question that counts on no sheet is left out and its number is not used, so
  // the names may skip (q01, q03), as PSTAT-1 revision 1.1 settles. For a few hours of 15 November 2026 the kept questions were
  // numbered in a row instead, to satisfy the core's 1.0 checker, which wrongly demanded it; the 1.1 checker refuses that.
  const first = versionQuestions(record, "A" as VersionLabel);
  const width = Math.max(2, String(first.length).length);
  const items: Array<{ id: string; name: string; label: string; cells: Array<number | null> }> = [];
  first.forEach((question, i) => {
    const cells = sheets.map((s) => {
      const q = s.questions.find((x) => x.questionId === question.id);
      return q && q.possible > 0 ? q.earned : null;
    });
    const name = `q${String(i + 1).padStart(width, "0")}`;
    if (cells.every((c) => c === null)) {
      if (sheets.length > 0) notes.push(`Question ${i + 1} counts on none of the sheets written (${whyLeftOut(sheets, question.id)}), so it is left out.`);
      return;
    }
    items.push({ id: question.id, name, label: `Question ${i + 1}`, cells });
    // Where a question does not count on some sheets, say on which: by version when it is empty on every sheet of those versions.
    const empty = sheets.filter((_s, j) => cells[j] === null);
    if (empty.length > 0) {
      const versions = [...new Set(empty.map((s) => s.version))].sort((a, b) => a - b);
      const byVersion = versions.every((v) => sheets.filter((s) => s.version === v).every((s) => cells[sheets.indexOf(s)] === null));
      notes.push(byVersion ? `${name} does not count on version ${versions.map(letter).join(", ")}, so its cells there are empty.` : `${name} does not count on ${empty.length} of the sheets, so its cells there are empty.`);
    }
  });

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
export function writePstatFile(project: PstatProject, part?: AssessmentPart): Uint8Array {
  const at = new Date(1980, 0, 1);
  return zipSync([
    { name: PSTAT_ENTRY, data: new TextEncoder().encode(JSON.stringify(project)), date: at },
    // Profile 2's part, after project.json, as the format orders them.
    ...(part ? [{ name: PSTAT_PART, data: new TextEncoder().encode(JSON.stringify(part)), date: at }] : []),
  ]);
}

/** The file's name: the test's title and the date, cut and cleaned as every other file the program names itself. */
export function pstatFileName(testName: string, date: string): string {
  return `${safeName(testName, "Test")} - Results for statistics ${date}${PSTAT_EXTENSION}`;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Profile 2: the letters marked, and the key and details of every question (PSTAT-1 section 7.2)

type PartType = "multiple_choice" | "select_all" | "true_false" | "other";

export interface KeyEntry {
  versions?: number[];
  correct: string[];
  points: number;
  adjustment: "none" | "dropped" | "credit_all";
  partial_credit: boolean;
}

export interface AssessmentPart {
  part: "OpenAssess assessment";
  version: 1;
  test: { id: string; name: string; given: string | null; source: "scanned sheets" | "learning system report"; versions: string[]; questions: number; sheets_left_out: number };
  questions: Array<{
    number: number;
    bank_id: string;
    revision: number;
    points_variable: number | null;
    answer_variable: number | null;
    type: PartType;
    options: string[];
    option_ids: string[];
    option_labels: { A: "True"; B: "False" } | null;
    key: KeyEntry[];
    details: { objective: string | null; chapter: string | null; section: string | null; page: string | null; bloom: string | null; difficulty: string | null; tags: string[] };
  }>;
}

export interface Pstat2Export extends PstatExport {
  part?: AssessmentPart;
}

export interface Pstat2Options {
  /** The adjustments the scores were worked out with: the key written must give every point written. */
  adjustments?: readonly Adjustment[];
  /** The day the test was given, YYYY-MM-DD, when the person said; otherwise null. */
  given?: string;
  source: "scanned sheets" | "learning system report";
}

/** Letters of version A for bank answers, sorted, as one answer cell. */
const lettersOf = (record: TestRecord, id: string, answers: readonly string[]): string =>
  [...new Set(answers.map((a) => letterFor(record, "A" as VersionLabel, id, a)).filter((l): l is string => l !== undefined))].sort().join("");

/** What profile 2 calls a question: a learning system's report gives points and no letters, so every question there is `other`. */
function typeOf(question: Question, source: Pstat2Options["source"]): PartType {
  if (source === "learning system report") return "other";
  if (isTrueFalse(question)) return "true_false";
  if (isMultipleResponse(question) && question.body.options.length >= 2 && question.body.options.length <= 26) return "select_all";
  if (isChoice(question) && question.body.options.length >= 2 && question.body.options.length <= 26) return "multiple_choice";
  return "other";
}

/**
 * The key entry for one version: the scoring of score.ts, said in the spec's words. A question the sheet does not count (it cannot carry
 * it, it has no usable key, it is worth nothing, or it was dropped) is `dropped`, so its cells are empty as they are in the file; a
 * question credited to everyone is `credit_all`; otherwise the letters of version A that earn the points, with an answer also accepted
 * added (one letter more for a one-answer question, one more letter in the string for select-all).
 */
function entryFor(record: TestRecord, question: Question, type: PartType, adjustments: readonly Adjustment[], version: number, possible: number | undefined): Omit<KeyEntry, "versions"> {
  const mine = adjustments.filter((a) => a.questionId === question.id && (a.versions === undefined || a.versions.includes(version)));
  const partial = type === "select_all" && isMultipleResponse(question) && question.body.partialCredit === true;
  const stated = [...mine].reverse().find((a): a is Adjustment & { kind: "points" } => a.kind === "points")?.points ?? pointsOf(question);
  const points = possible ?? stated;
  // A dropped entry still needs a number above 0; the question counts on none of its versions' sheets, so the number earns nothing.
  const dropped: Omit<KeyEntry, "versions"> = { correct: [], points: points > 0 ? points : 1, adjustment: "dropped", partial_credit: false };
  if (type === "other") return possible !== undefined && possible > 0 ? { correct: [], points: possible, adjustment: "none", partial_credit: false } : dropped;
  if (!hasUsableKey(question) || mine.some((a) => a.kind === "drop") || !(points > 0)) return dropped;
  if (mine.some((a) => a.kind === "credit")) return { correct: [], points, adjustment: "credit_all", partial_credit: partial };
  const key = [...keyOf(question), ...mine.flatMap((a) => (a.kind === "alsoRight" ? [a.answer] : []))];
  const correct = type === "select_all" ? [lettersOf(record, question.id, key)] : [...new Set(key.map((k) => letterFor(record, "A" as VersionLabel, question.id, k)).filter((l): l is string => l !== undefined))].sort();
  return { correct, points, adjustment: "none", partial_credit: partial };
}

const nullable = (v: string | undefined): string | null => (v === undefined || v.trim() === "" ? null : v);

/**
 * The project and its part in profile 2. Everything profile 1 writes is written the same way; then, for scanned sheets, one answer
 * variable per question variable with the letters marked in version A's lettering ("" for blank, null exactly where the points are
 * null); then `assessment.json` with every question of version A, those left out among them. No student id or name is written:
 * OpenAssess holds none (the spec lets a writer that holds them leave them out, and one that holds none writes no such variable).
 */
export function pstatProject2(record: TestRecord, scores: readonly SheetScore[], appVersion: string, options: Pstat2Options): Pstat2Export {
  const one = pstatProject(record, scores, appVersion);
  if (one.refused) return one;
  const project = one.project;
  project.profile = PSTAT_PROFILE_2;
  const adjustments = options.adjustments ?? [];
  const sheets = scores.filter((s): s is SheetScore & { version: number } => s.complete && s.version !== undefined).sort((a, b) => a.number - b.number);
  const first = versionQuestions(record, "A" as VersionLabel);
  const byName = new Map(project.dataset.variables.map((v) => [v.name, v.id]));
  const width = Math.max(2, String(first.length).length);
  const tag = (i: number): string => String(i + 1).padStart(width, "0");

  // The answer variables, for scanned sheets only: a learning system's report gives points and no letters.
  if (options.source === "scanned sheets") {
    first.forEach((question, i) => {
      const points = project.dataset.columns[project.dataset.variables.findIndex((v) => v.name === `q${tag(i)}`)];
      if (!points) return;
      const values = sheets.map((s, r) => {
        if (points.values[r] === null) return null;
        const q = s.questions.find((x) => x.questionId === question.id);
        return q && q.outcome !== "blank" ? lettersOf(record, question.id, q.marked) : "";
      });
      const id = project.dataset.next_id++;
      project.dataset.variables.push({ id, name: `r${tag(i)}`, label: `Question ${i + 1} answer`, measure: "nominal", value_labels: [], missing_values: [] });
      project.dataset.columns.push({ type: "text", values });
      byName.set(`r${tag(i)}`, id);
    });
    project.source.report.variables = project.dataset.variables.length;
  }

  const versions = record.versions.map((_v, k) => letter(k + 1));
  const part: AssessmentPart = {
    part: "OpenAssess assessment",
    version: 1,
    test: { id: record.id, name: record.name, given: options.given ?? null, source: options.source, versions, questions: first.length, sheets_left_out: one.leftOut },
    questions: first.map((question, i) => {
      const type = typeOf(question, options.source);
      // A learning system's points: what the question was worth there, the most any attempt was out of.
      const possible = options.source === "learning system report" ? sheets.reduce((most, s) => Math.max(most, s.questions.find((q) => q.questionId === question.id)?.possible ?? 0), 0) : undefined;
      const perVersion = versions.map((_l, k) => entryFor(record, question, type, adjustments, k + 1, possible));
      const same = perVersion.every((e) => JSON.stringify(e) === JSON.stringify(perVersion[0]));
      const key: KeyEntry[] = same ? [perVersion[0] as KeyEntry] : groupByEntry(perVersion);
      const order = type === "true_false" ? ["true", "false"] : type === "other" ? [] : record.versions[0]?.options[question.id] ?? (isChoice(question) || isMultipleResponse(question) ? question.body.options.map((o) => o.id) : []);
      const m = question.metadata;
      return {
        number: i + 1,
        bank_id: question.id,
        revision: question.version,
        points_variable: byName.get(`q${tag(i)}`) ?? null,
        answer_variable: byName.get(`r${tag(i)}`) ?? null,
        type,
        options: order.map((_o, k) => String.fromCharCode(65 + k)),
        option_ids: [...order],
        option_labels: type === "true_false" ? { A: "True", B: "False" } : null,
        key,
        details: { objective: nullable(m.objective), chapter: nullable(m.chapter), section: nullable(m.section), page: nullable(m.page), bloom: m.bloom ?? null, difficulty: m.difficulty ?? null, tags: [...m.tags] },
      };
    }),
  };
  return { ...one, project, part };
}

/** Key entries that differ by version, each naming its versions, in the order their first version comes. */
function groupByEntry(perVersion: ReadonlyArray<Omit<KeyEntry, "versions">>): KeyEntry[] {
  const groups = new Map<string, KeyEntry>();
  perVersion.forEach((e, k) => {
    const id = JSON.stringify(e);
    const g = groups.get(id);
    if (g) g.versions?.push(k + 1);
    else groups.set(id, { versions: [k + 1], ...e });
  });
  return [...groups.values()];
}
