/**
 * The scores file: what a class's scoring is kept in, apart from the bank.
 *
 *   <test> - Scores <date>.openassess-scores    a zip of JSON, like the bank
 *     manifest.json       what test it is for, how many pages a sheet has, when it was made
 *     sheets/<n>.json     one sheet: each page's reading (every bubble's fill, and what the reader made of each question), or why it was refused
 *     decisions.json      what a person decided at review, with what the reader saw beside it
 *     adjustments.json    each change to the scoring, with a note and when
 *
 * It holds the readings, so that a different key or a settled version needs no rescan; the decisions and adjustments, so that a score can
 * be explained later; and for each page the sheet number, the page number and a fingerprint of the picture. It holds no file name (a scan
 * named by student would put names into a file this program writes), no picture, and no crop of one. The pictures are shown again by
 * opening the same files. A field this program does not know is refused when the file is read, for the same reason as in a bank.
 */

import { jsonEntry, readJson, unzipSync, zipSync, type ZipEntry } from "../container/zip.ts";
import { safeName } from "../export/text.ts";
import { codeProblem, styleOf, type SheetCode } from "./code.ts";
import { layoutFor, placeOf, slotRow } from "./geometry.ts";
import type { Batch, BatchEntry, BatchSheet } from "./batch.ts";
import type { Adjustment, Decision } from "./score.ts";
import type { SheetReading } from "./read.ts";
import type { QuestionStatus } from "./decide.ts";
import type { TestRecord } from "../model/test.ts";
import { newUlid } from "../model/ids.ts";

export const SCORES_EXTENSION = ".openassess-scores";
export const SCORES_FORMAT = "openassess-scores";
export const SCORES_VERSION = 1;
const MANIFEST = "manifest.json";
const DECISIONS = "decisions.json";
const ADJUSTMENTS = "adjustments.json";
const sheetPath = (n: number): string => `sheets/${n}.json`;

export interface StoredQuestion {
  number: number;
  status: QuestionStatus;
  marked: number[];
  kind?: string;
  reason?: string;
}

export interface StoredReading {
  code: SheetCode;
  version?: number;
  versionSource: "code" | "bubble" | "single";
  versionFills?: number[];
  /** By question number, three decimals. */
  fills: Record<string, number[]>;
  unregistered: number[];
  questions: StoredQuestion[];
  quality: SheetReading["quality"];
  notes: string[];
}

export interface StoredPage {
  /** From 1. */
  page: number;
  /** Of the picture, so that the same one is known again. */
  fingerprint: string;
  reading?: StoredReading;
  refused?: { cause: string; reason: string };
}

export interface StoredSheet {
  number: number;
  /** By page of the sheet; a page that never came is null. */
  pages: Array<StoredPage | null>;
}

export interface ScoresFile {
  format: typeof SCORES_FORMAT;
  version: typeof SCORES_VERSION;
  id: string;
  created: string;
  updated: string;
  testId: string;
  testName: string;
  testFingerprint: number;
  pagesPerSheet: number;
  /** Take a row the reader found blank as blank without anyone confirming it. */
  acceptBlanks: boolean;
  sheets: StoredSheet[];
  decisions: Decision[];
  adjustments: Adjustment[];
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

function storedReading(r: SheetReading): StoredReading {
  return {
    code: r.code,
    ...(r.version !== undefined ? { version: r.version } : {}),
    versionSource: r.versionSource,
    ...(r.versionFills ? { versionFills: r.versionFills.map(round3) } : {}),
    fills: Object.fromEntries(Object.entries(r.fills).map(([q, f]) => [q, f.map(round3)])),
    unregistered: r.unregistered,
    questions: r.questions.map((q) => ({ number: q.number, status: q.status, marked: q.marked, ...(q.kind ? { kind: q.kind } : {}), ...(q.reason ? { reason: q.reason } : {}) })),
    quality: r.quality,
    notes: r.notes,
  };
}

/** A scores file from a batch of pages that were read. */
export function newScoresFile(record: TestRecord, batch: Batch, entries: readonly BatchEntry[], more: { decisions?: Decision[]; adjustments?: Adjustment[]; acceptBlanks?: boolean; pagesPerSheet: number; now?: string; id?: string }): ScoresFile {
  const now = more.now ?? new Date().toISOString();
  return {
    format: SCORES_FORMAT,
    version: SCORES_VERSION,
    id: more.id ?? `s_${newUlid()}`,
    created: now,
    updated: now,
    testId: record.id,
    testName: record.name,
    testFingerprint: record.fingerprint,
    pagesPerSheet: more.pagesPerSheet,
    acceptBlanks: more.acceptBlanks ?? false,
    sheets: batch.sheets.map((sheet) => ({
      number: sheet.number,
      pages: sheet.pages.map((p) => {
        if (!p) return null;
        const entry = entries[p.entry] as BatchEntry;
        return entry.result.ok
          ? { page: p.page, fingerprint: entry.fingerprint, reading: storedReading(entry.result) }
          : { page: p.page, fingerprint: entry.fingerprint, refused: { cause: entry.result.cause, reason: entry.result.reason } };
      }),
    })),
    decisions: more.decisions ?? [],
    adjustments: more.adjustments ?? [],
  };
}

/** The name a scores file is saved under: the test's name and the day. */
export function scoresFileName(testName: string, date: string): string {
  return `${safeName(testName, "Test")} - Scores ${date}${SCORES_EXTENSION}`;
}

export function writeScoresFile(file: ScoresFile): Uint8Array {
  const entries: ZipEntry[] = [
    jsonEntry(MANIFEST, {
      format: file.format,
      version: file.version,
      id: file.id,
      created: file.created,
      updated: file.updated,
      testId: file.testId,
      testName: file.testName,
      testFingerprint: file.testFingerprint,
      pagesPerSheet: file.pagesPerSheet,
      acceptBlanks: file.acceptBlanks,
      sheets: file.sheets.length,
    }),
    jsonEntry(DECISIONS, file.decisions),
    jsonEntry(ADJUSTMENTS, file.adjustments),
    ...file.sheets.map((sheet) => jsonEntry(sheetPath(sheet.number), sheet)),
  ];
  return zipSync(entries);
}

// ---------------------------------------------------------------------------------------------------------------------------
// Reading one back

export type ScoresRead = { ok: true; file: ScoresFile } | { ok: false; reason: string };

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isString = (v: unknown): v is string => typeof v === "string";

/** Every key must be one this program writes: a scores file holds no name, no file name and no picture, and one that does is refused. */
function known(obj: Record<string, unknown>, keys: readonly string[], where: string): string | undefined {
  for (const k of Object.keys(obj)) if (!keys.includes(k)) return `${where} has a field, ${k}, that a scores file does not hold (it holds no names, no file names and no pictures)`;
  return undefined;
}

function checkReading(r: unknown, where: string): string | undefined {
  if (!isObject(r)) return `${where} is not an object`;
  const unknownKey = known(r, ["code", "version", "versionSource", "versionFills", "fills", "unregistered", "questions", "quality", "notes"], where);
  if (unknownKey) return unknownKey;
  if (!isObject(r["code"])) return `${where} has no code`;
  const c = r["code"] as unknown as SheetCode;
  const keyProblem = known(r["code"], ["layout", "paper", "large", "test", "page", "pages", "version"], `${where}.code`);
  if (keyProblem) return keyProblem;
  if (typeof c.large !== "boolean" || (c.paper !== "letter" && c.paper !== "a4")) return `${where}.code is not a sheet's code`;
  const problem = codeProblem(c);
  if (problem) return `${where}.code is not a sheet's code: ${problem}`;
  if (!["code", "bubble", "single"].includes(String(r["versionSource"]))) return `${where}.versionSource is not one of code, bubble or single`;
  if (r["version"] !== undefined && !(Number.isInteger(r["version"]) && (r["version"] as number) >= 1 && (r["version"] as number) <= 4)) return `${where}.version is not 1 to 4`;
  if (!isObject(r["fills"])) return `${where}.fills is not an object`;
  for (const [q, f] of Object.entries(r["fills"])) {
    if (!/^\d+$/.test(q) || !Array.isArray(f) || !f.every((x) => typeof x === "number" && x >= 0 && x <= 1)) return `${where}.fills.${q} is not a list of fills from 0 to 1`;
  }
  if (!Array.isArray(r["questions"])) return `${where}.questions is not a list`;
  for (const [i, q] of (r["questions"] as unknown[]).entries()) {
    if (!isObject(q)) return `${where}.questions.${i} is not an object`;
    const bad = known(q, ["number", "status", "marked", "kind", "reason"], `${where}.questions.${i}`);
    if (bad) return bad;
    if (!isCount(q["number"]) || !["answered", "blank", "flagged", "notOnSheet"].includes(String(q["status"])) || !Array.isArray(q["marked"])) return `${where}.questions.${i} is not a question's reading`;
  }
  if (!Array.isArray(r["unregistered"]) || !Array.isArray(r["notes"])) return `${where} lacks unregistered or notes`;
  if (!isObject(r["quality"])) return `${where}.quality is not an object`;
  return known(r["quality"], ["dpi", "markSidePx", "ring", "ringExpected", "blurMm", "shiftMedianMm", "shiftMaxMm", "blankLevel", "quarterTurns", "bilevel"], `${where}.quality`);
}

function checkSheet(raw: unknown, n: number): string | undefined {
  const where = `sheets/${n}.json`;
  if (!isObject(raw)) return `${where} is not an object`;
  const bad = known(raw, ["number", "pages"], where);
  if (bad) return bad;
  if (raw["number"] !== n || !Array.isArray(raw["pages"])) return `${where} is not sheet ${n}`;
  for (const [i, p] of (raw["pages"] as unknown[]).entries()) {
    if (p === null) continue;
    if (!isObject(p)) return `${where}: page ${i + 1} is not an object`;
    const k = known(p, ["page", "fingerprint", "reading", "refused"], `${where}: page ${i + 1}`);
    if (k) return k;
    if (!isCount(p["page"]) || !isString(p["fingerprint"])) return `${where}: page ${i + 1} lacks its number or its fingerprint`;
    if (p["reading"] !== undefined) {
      const r = checkReading(p["reading"], `${where}: page ${i + 1}.reading`);
      if (r) return r;
    } else if (!isObject(p["refused"]) || known(p["refused"], ["cause", "reason"], `${where}: page ${i + 1}.refused`)) return `${where}: page ${i + 1} has neither a reading nor a reason it was refused`;
  }
  return undefined;
}

function checkDecisions(raw: unknown): string | undefined {
  if (!Array.isArray(raw)) return `${DECISIONS} is not a list`;
  for (const [i, d] of raw.entries()) {
    if (!isObject(d)) return `${DECISIONS}: ${i} is not an object`;
    const k = known(d, ["sheet", "kind", "question", "places", "version", "readerSaw", "at"], `${DECISIONS}: ${i}`);
    if (k) return k;
    if (!isCount(d["sheet"])) return `${DECISIONS}: ${i} has no sheet`;
    if (d["kind"] === "answer") {
      if (!isCount(d["question"]) || !(d["places"] === "blank" || (Array.isArray(d["places"]) && d["places"].every(isCount)))) return `${DECISIONS}: ${i} is not an answer`;
    } else if (d["kind"] === "version") {
      if (!(Number.isInteger(d["version"]) && (d["version"] as number) >= 1 && (d["version"] as number) <= 4)) return `${DECISIONS}: ${i} is not a version`;
    } else return `${DECISIONS}: ${i} is neither an answer nor a version`;
  }
  return undefined;
}

function checkAdjustments(raw: unknown): string | undefined {
  if (!Array.isArray(raw)) return `${ADJUSTMENTS} is not a list`;
  for (const [i, a] of raw.entries()) {
    if (!isObject(a)) return `${ADJUSTMENTS}: ${i} is not an object`;
    const k = known(a, ["id", "kind", "questionId", "versions", "note", "at", "answer", "points"], `${ADJUSTMENTS}: ${i}`);
    if (k) return k;
    if (!isString(a["id"]) || !isString(a["questionId"]) || !["drop", "alsoRight", "credit", "points"].includes(String(a["kind"]))) return `${ADJUSTMENTS}: ${i} is not an adjustment`;
    if (a["kind"] === "alsoRight" && !isString(a["answer"])) return `${ADJUSTMENTS}: ${i} gives no answer`;
    if (a["kind"] === "points" && !(typeof a["points"] === "number" && a["points"] >= 0)) return `${ADJUSTMENTS}: ${i} gives no points`;
  }
  return undefined;
}

export function readScoresFile(bytes: Uint8Array): ScoresRead {
  let entries: Map<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (error) {
    return { ok: false, reason: `This is not a scores file: ${error instanceof Error ? error.message : "it could not be opened"}.` };
  }
  const read = (name: string): { ok: true; value: unknown } | { ok: false; reason: string } => {
    if (!entries.has(name)) return { ok: false, reason: `This scores file has no ${name}.` };
    try {
      return { ok: true, value: readJson<unknown>(entries, name) };
    } catch {
      return { ok: false, reason: `${name} in this scores file is damaged: it is not valid JSON.` };
    }
  };
  const m = read(MANIFEST);
  if (!m.ok) return m;
  const manifest = m.value;
  if (!isObject(manifest)) return { ok: false, reason: "manifest.json in this scores file is not an object." };
  const bad = known(manifest, ["format", "version", "id", "created", "updated", "testId", "testName", "testFingerprint", "pagesPerSheet", "acceptBlanks", "sheets"], MANIFEST);
  if (bad) return { ok: false, reason: bad };
  if (manifest["format"] !== SCORES_FORMAT) return { ok: false, reason: "This is not an OpenAssess scores file." };
  if (manifest["version"] !== SCORES_VERSION) return { ok: false, reason: `This scores file is version ${String(manifest["version"])}, and this program reads version ${SCORES_VERSION}.` };
  if (![manifest["id"], manifest["created"], manifest["updated"], manifest["testId"], manifest["testName"]].every(isString) || !isCount(manifest["testFingerprint"]) || !isCount(manifest["pagesPerSheet"]) || !isCount(manifest["sheets"]) || typeof manifest["acceptBlanks"] !== "boolean") {
    return { ok: false, reason: "manifest.json in this scores file is missing something it should have." };
  }
  const count = manifest["sheets"] as number;
  const sheets: StoredSheet[] = [];
  for (let n = 1; n <= count; n++) {
    const s = read(sheetPath(n));
    if (!s.ok) return s;
    const problem = checkSheet(s.value, n);
    if (problem) return { ok: false, reason: `Sheet ${n} in this scores file is damaged: ${problem}.` };
    sheets.push(s.value as StoredSheet);
  }
  const d = read(DECISIONS);
  if (!d.ok) return d;
  const dp = checkDecisions(d.value);
  if (dp) return { ok: false, reason: `${dp}.` };
  const a = read(ADJUSTMENTS);
  if (!a.ok) return a;
  const ap = checkAdjustments(a.value);
  if (ap) return { ok: false, reason: `${ap}.` };
  return {
    ok: true,
    file: {
      format: SCORES_FORMAT,
      version: SCORES_VERSION,
      id: manifest["id"] as string,
      created: manifest["created"] as string,
      updated: manifest["updated"] as string,
      testId: manifest["testId"] as string,
      testName: manifest["testName"] as string,
      testFingerprint: manifest["testFingerprint"] as number,
      pagesPerSheet: manifest["pagesPerSheet"] as number,
      acceptBlanks: manifest["acceptBlanks"] as boolean,
      sheets,
      decisions: d.value as Decision[],
      adjustments: a.value as Adjustment[],
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Back to readings

/** The pages of a saved scores file as the batch and entries that scoring works on. The pictures are not in it, so each entry's file is named for its place. */
export function restore(file: ScoresFile): { sheets: BatchSheet[]; entries: BatchEntry[] } {
  const entries: BatchEntry[] = [];
  const sheets: BatchSheet[] = file.sheets.map((sheet) => {
    const pages = sheet.pages.map((p) => {
      if (!p) return undefined;
      const entry: BatchEntry = {
        source: { file: `sheet ${sheet.number}`, page: p.page },
        fingerprint: p.fingerprint,
        result: p.reading ? restoreReading(p.reading) : { ok: false, cause: (p.refused?.cause ?? "quality") as "quality", reason: p.refused?.reason ?? "This page was not read." },
      };
      entries.push(entry);
      return { entry: entries.length - 1, page: p.page, refused: p.refused !== undefined };
    });
    const versions = new Set<number>();
    for (const p of pages) {
      const r = p ? (entries[p.entry] as BatchEntry).result : undefined;
      if (r?.ok && r.version !== undefined) versions.add(r.version);
    }
    return { number: sheet.number, pages, ...(versions.size === 1 ? { version: [...versions][0] as number } : {}) };
  });
  return { sheets, entries };
}

function restoreReading(s: StoredReading): SheetReading {
  const style = styleOf(s.code);
  const layout = layoutFor(s.code.paper, style ?? "standard");
  const questions = s.questions.map((q) => ({
    number: q.number,
    status: q.status,
    marked: q.marked,
    fills: s.fills[String(q.number)] ?? [],
    ...(q.kind ? { kind: q.kind as NonNullable<SheetReading["questions"][number]["kind"]> } : {}),
    ...(q.reason ? { reason: q.reason } : {}),
    rect: slotRow(layout, placeOf(layout, q.number).slot),
  }));
  const flags: SheetReading["flags"] = [];
  for (const q of questions) if (q.status === "blank" || q.status === "flagged") flags.push({ kind: q.kind as NonNullable<typeof q.kind>, question: q.number, page: s.code.page, reason: q.reason ?? "", rect: q.rect });
  return {
    ok: true,
    code: s.code,
    ...(s.version !== undefined ? { version: s.version } : {}),
    versionSource: s.versionSource,
    ...(s.versionFills ? { versionFills: s.versionFills } : {}),
    questions,
    fills: Object.fromEntries(Object.entries(s.fills).map(([q, f]) => [Number(q), f])),
    unregistered: s.unregistered,
    flags,
    quality: s.quality,
    notes: s.notes,
  };
}
