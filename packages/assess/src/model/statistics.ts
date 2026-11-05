/**
 * What a bank keeps of a test that was given to a class: figures for each question, and nothing else.
 *
 * A bank is a file that is shared, so it must never hold what a student did. An administration (one test given to one class) is kept as
 * the test's name, the date, how many sheets, and for each bank question its difficulty, its discrimination, how many sheets marked each
 * answer and how many left it blank. There is no field that could hold a sheet number, a name, a mark or a file name, and a file with
 * any other field is refused when it is read, so that a bank written by anything else cannot smuggle one in.
 *
 * Counts are of sheets, and every figure carries the number of sheets it is from.
 */

import type { Issue } from "./schema.ts";
import { isId, newAdministrationId } from "./ids.ts";
import type { TestRecord } from "./test.ts";
import type { TestStatistics } from "../sheets/stats.ts";

export const ADMINISTRATION_VERSION = 1;

export interface AdministrationItem {
  /** The bank question's id. */
  questionId: string;
  /** How many sheets this question counted on. */
  sheets: number;
  difficulty?: number;
  pointBiserial?: number;
  upperLower?: number;
  /** For each answer the question can be marked with (an option's id, or "true" or "false"): how many sheets marked it. */
  options: Array<{ answer: string; chosen: number }>;
  blanks: number;
}

export interface Administration {
  recordVersion: typeof ADMINISTRATION_VERSION;
  id: string;
  /** The test's name and id, so that the figures say what was given. */
  testId: string;
  testName: string;
  /** The day it was given or scored, as YYYY-MM-DD. */
  date: string;
  /** How many complete sheets the figures are from. */
  sheets: number;
  /** True when that is fewer than 30. */
  unstable: boolean;
  reliability?: { kind: "KR-20" | "Cronbach alpha"; value: number };
  items: AdministrationItem[];
}

/** The figures of a scored class, as an administration to keep in the bank. Nothing about any one sheet goes into it. */
export function administrationFrom(record: TestRecord, stats: TestStatistics, date: string, id: string = newAdministrationId()): Administration {
  return {
    recordVersion: ADMINISTRATION_VERSION,
    id,
    testId: record.id,
    testName: record.name,
    date,
    sheets: stats.sheets,
    unstable: stats.unstable,
    ...(stats.reliability ? { reliability: { kind: stats.reliability.kind, value: stats.reliability.value } } : {}),
    items: stats.items.map((i) => ({
      questionId: i.questionId,
      sheets: i.sheets,
      ...(i.difficulty !== undefined ? { difficulty: i.difficulty } : {}),
      ...(i.discrimination.pointBiserial !== undefined ? { pointBiserial: i.discrimination.pointBiserial } : {}),
      ...(i.discrimination.upperLower !== undefined ? { upperLower: i.discrimination.upperLower } : {}),
      options: i.options.map((o) => ({ answer: o.answer, chosen: o.chosen })),
      blanks: i.blanks,
    })),
  };
}

export type AdministrationCheck = { ok: true; administration: Administration } | { ok: false; issues: Issue[] };

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

/** Every key an object has must be one of these: a field this program does not know is refused, since it could be a response. */
function onlyKnown(obj: Record<string, unknown>, known: readonly string[], path: string, bad: (path: string, message: string) => void): void {
  for (const key of Object.keys(obj)) if (!known.includes(key)) bad(path ? `${path}.${key}` : key, `${key} is not a field of the figures a bank keeps. A bank holds class-level figures only, and never a response, a name or a file name.`);
}

export function validateAdministration(value: unknown): AdministrationCheck {
  const issues: Issue[] = [];
  const bad = (path: string, message: string): void => void issues.push({ path, message });
  if (!isObject(value)) return { ok: false, issues: [{ path: "", message: "The figures of a test given to a class are an object." }] };
  onlyKnown(value, ["recordVersion", "id", "testId", "testName", "date", "sheets", "unstable", "reliability", "items"], "", bad);
  if (value["recordVersion"] !== ADMINISTRATION_VERSION) bad("recordVersion", `This record is version ${String(value["recordVersion"])}, and this program reads version ${ADMINISTRATION_VERSION}.`);
  if (!isId(value["id"], "adm")) bad("id", "The id is not an administration id.");
  if (!isId(value["testId"], "t")) bad("testId", "The test id is not a test id.");
  if (typeof value["testName"] !== "string" || value["testName"].trim() === "") bad("testName", "The figures need the test's name.");
  if (typeof value["date"] !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value["date"])) bad("date", "The date is a day, as YYYY-MM-DD.");
  if (!isCount(value["sheets"])) bad("sheets", "The number of sheets is a whole number.");
  if (typeof value["unstable"] !== "boolean") bad("unstable", "Whether the group was small is true or false.");
  const reliability = value["reliability"];
  if (reliability !== undefined) {
    if (!isObject(reliability)) bad("reliability", "The reliability is an object.");
    else {
      onlyKnown(reliability, ["kind", "value"], "reliability", bad);
      if (reliability["kind"] !== "KR-20" && reliability["kind"] !== "Cronbach alpha") bad("reliability.kind", 'The kind is "KR-20" or "Cronbach alpha".');
      if (typeof reliability["value"] !== "number" || !Number.isFinite(reliability["value"])) bad("reliability.value", "The value is a number.");
    }
  }
  const sheets = isCount(value["sheets"]) ? value["sheets"] : 0;
  const items = value["items"];
  if (!Array.isArray(items)) bad("items", "The items are a list.");
  else {
    const seen = new Set<string>();
    items.forEach((raw, i) => {
      const at = `items.${i}`;
      if (!isObject(raw)) return bad(at, "An item is an object.");
      onlyKnown(raw, ["questionId", "sheets", "difficulty", "pointBiserial", "upperLower", "options", "blanks"], at, bad);
      if (!isId(raw["questionId"], "q")) bad(`${at}.questionId`, "The question id is not a question id.");
      else if (seen.has(raw["questionId"])) bad(`${at}.questionId`, "A question is in these figures twice.");
      else seen.add(raw["questionId"]);
      if (!isCount(raw["sheets"]) || raw["sheets"] > sheets) bad(`${at}.sheets`, "The sheets a question counted on are a whole number, no more than the sheets in all.");
      for (const [key, low, high] of [["difficulty", 0, 1], ["pointBiserial", -1, 1], ["upperLower", -1, 1]] as const) {
        const v = raw[key];
        if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < low || v > high)) bad(`${at}.${key}`, `${key} is a number from ${low} to ${high}.`);
      }
      if (!isCount(raw["blanks"]) || (isCount(raw["sheets"]) && raw["blanks"] > raw["sheets"])) bad(`${at}.blanks`, "The blanks are a whole number, no more than the sheets the question counted on.");
      const options = raw["options"];
      if (!Array.isArray(options)) bad(`${at}.options`, "The options are a list.");
      else
        options.forEach((o, k) => {
          if (!isObject(o)) return bad(`${at}.options.${k}`, "An option is an object.");
          onlyKnown(o, ["answer", "chosen"], `${at}.options.${k}`, bad);
          if (typeof o["answer"] !== "string" || o["answer"] === "") bad(`${at}.options.${k}.answer`, "An answer is an option's id, or true or false.");
          if (!isCount(o["chosen"]) || (isCount(raw["sheets"]) && o["chosen"] > raw["sheets"])) bad(`${at}.options.${k}.chosen`, "How many sheets marked an answer is a whole number, no more than the sheets the question counted on.");
        });
    });
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, administration: value as unknown as Administration };
}
