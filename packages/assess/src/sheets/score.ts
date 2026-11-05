/**
 * Scores: what each sheet earns, worked out from the readings, the test record and the adjustments, every time they are shown.
 *
 * Nothing here is kept. A reading says what was marked; a person's decision settles what the reader was not sure of; the test record says
 * what the key is; an adjustment changes how a question counts. Putting those together gives a score, and changing any of them gives
 * another score without a rescan. The key is always the test record's own copy of the question, with its answers in the order of the
 * sheet's version, and a letter on a sheet is mapped back to the bank's own answer through it.
 *
 * A question with no usable key is printed and read but never scored, and is said not to be. A question that is not settled (flagged,
 * and no one has decided it) earns nothing and is counted apart, so a total can be shown while the queue is still full and says how
 * many questions it does not yet include.
 */

import { hasUsableKey } from "../quality/answer-key.ts";
import { richTextToPlain } from "../model/richtext.ts";
import { isChoice, isMultipleResponse, isTrueFalse, type Question } from "../model/question.ts";
import { VERSION_LABELS, versionQuestions, type TestRecord, type VersionLabel } from "../model/test.ts";
import type { BatchEntry, BatchSheet } from "./batch.ts";
import { layoutFor } from "./geometry.ts";
import { decideAll, type SheetReader } from "./read.ts";

/** What a sheet says to one question, once it is settled. */
export type SettledAnswer =
  /** One or more places (from 0), marked by the student and read, or keyed in by a person. */
  | { kind: "marked"; places: number[]; by: "reader" | "person" }
  | { kind: "blank"; by: "reader" | "person" }
  /** Flagged and not yet decided. */
  | { kind: "unsettled"; why: string };

export interface SettledSheet {
  /** Its place in the batch, from 1. */
  number: number;
  /** From 1; undefined when it is not known, which leaves every question unsettled. */
  version?: number;
  /** By question number in the booklet, from 1. A question the sheet does not carry has no entry. */
  answers: Record<number, SettledAnswer>;
  /** What is missing from the sheet as a whole: a page that did not come or could not be read. */
  problems: string[];
}

/** What a person decided at review. The reader's own words are kept beside it, so that what was seen and what was decided are both on record. */
export type Decision =
  | { sheet: number; kind: "answer"; question: number; places: number[] | "blank"; readerSaw?: string; at?: string }
  | { sheet: number; kind: "version"; version: number; readerSaw?: string; at?: string };

export interface SettleOptions {
  /** Take a row the reader found blank as blank without anyone confirming it. */
  acceptBlanks?: boolean;
  /**
   * The reader of this test. It is needed when a person settles a version the reader could not: the page's questions were left undecided, and are
   * decided now from the fills it kept, with no rescan.
   */
  reader?: SheetReader;
}

/**
 * Pages put into sheets (batch.ts) and what was read from them, settled by decisions. A question is settled when the reader was sure of
 * it, or a person decided it; a blank is settled only when confirmed, or when `acceptBlanks` says to take them as read.
 */
export function settleSheets(sheets: readonly BatchSheet[], entries: readonly BatchEntry[], decisions: readonly Decision[] = [], options: SettleOptions = {}): SettledSheet[] {
  return sheets.map((sheet) => {
    const problems: string[] = [];
    const mine = decisions.filter((d) => d.sheet === sheet.number);
    const versionDecision = [...mine].reverse().find((d) => d.kind === "version");
    let version = sheet.version;
    if (versionDecision && versionDecision.kind === "version") version = versionDecision.version;

    const answers: Record<number, SettledAnswer> = {};
    sheet.pages.forEach((page, index) => {
      if (!page) {
        problems.push(`Page ${index + 1} did not come.`);
        return;
      }
      const result = (entries[page.entry] as BatchEntry).result;
      if (!result.ok) {
        problems.push(`Page ${page.page} could not be read (${result.reason}).`);
        return;
      }
      let questions = result.questions;
      if (questions.length === 0 && version !== undefined && options.reader) {
        const planned = options.reader.plan(result.code.paper, result.code.large);
        if (planned.ok) {
          const registered = new Map(result.unregistered.map((n) => [n, false] as const));
          questions = decideAll(planned.plan, version, result.code.page, layoutFor(result.code.paper, planned.plan.style), result.fills, registered, result.quality.bilevel);
        }
      }
      for (const q of questions) {
        if (q.status === "notOnSheet") continue;
        if (q.status === "answered") answers[q.number] = { kind: "marked", places: q.marked, by: "reader" };
        else if (q.status === "blank") answers[q.number] = options.acceptBlanks ? { kind: "blank", by: "reader" } : { kind: "unsettled", why: "The reader found this blank, and it has not been confirmed." };
        else answers[q.number] = { kind: "unsettled", why: q.reason ?? "The reader was not sure of this answer." };
      }
      if (questions.length === 0 && result.version === undefined && version === undefined) problems.push(`The version of page ${page.page} is not settled.`);
    });
    // A person's decision on a question replaces what the reader said, whichever it was.
    for (const d of mine) {
      if (d.kind !== "answer") continue;
      answers[d.question] = d.places === "blank" ? { kind: "blank", by: "person" } : { kind: "marked", places: [...d.places].sort((a, b) => a - b), by: "person" };
    }
    if (version === undefined) problems.push("Its version is not settled.");
    return { number: sheet.number, ...(version !== undefined ? { version } : {}), answers, problems };
  });
}

// ---------------------------------------------------------------------------------------------------------------------------
// Adjustments

interface AdjustmentBase {
  id: string;
  /** The bank's question, so that it holds for every version. */
  questionId: string;
  /** Only these versions (from 1). All of them when absent. */
  versions?: number[];
  note?: string;
  at?: string;
}

export type Adjustment =
  | (AdjustmentBase & { kind: "drop" })
  /** Another answer counts as right as well: a bank answer's id, or "true" or "false". */
  | (AdjustmentBase & { kind: "alsoRight"; answer: string })
  | (AdjustmentBase & { kind: "credit" })
  | (AdjustmentBase & { kind: "points"; points: number });

/**
 * An adjustment in words. With the test it is for, an answer that counts too is named by the letter it has in version A and what it says
 * (a bank answer's id means nothing to the person who reads it); without, it is named by what it was stored as.
 */
export const adjustmentWords = (a: Adjustment, record?: TestRecord): string => {
  switch (a.kind) {
    case "drop": return "Dropped from the total";
    case "alsoRight": return `Another answer counts as right (${record ? answerName(record, a.questionId, a.answer) : a.answer})`;
    case "credit": return "Everyone has credit";
    case "points": return `Worth ${a.points} point${a.points === 1 ? "" : "s"}`;
  }
};

/** A bank answer as a person reads it: its letter in version A and its words, or True or False. */
function answerName(record: TestRecord, questionId: string, answer: string): string {
  const question = record.questions.find((q) => q.id === questionId);
  if (!question) return answer;
  if (isTrueFalse(question)) return answer === "true" ? "True" : answer === "false" ? "False" : answer;
  if (!isChoice(question) && !isMultipleResponse(question)) return answer;
  const first = versionQuestions(record, "A").find((q) => q.id === questionId);
  const options = first && (isChoice(first) || isMultipleResponse(first)) ? first.body.options : [];
  const at = options.findIndex((o) => o.id === answer);
  if (at < 0) return answer;
  const words = richTextToPlain(options[at]!.content).replace(/\s+/g, " ").trim();
  return `${String.fromCharCode(65 + at)}: ${words.length > 40 ? `${words.slice(0, 37).trimEnd()}...` : words}`;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Scoring

export type Outcome = "right" | "partial" | "wrong" | "blank" | "credited" | "unsettled" | "notScored" | "dropped" | "notOnSheet";

export interface QuestionScore {
  /** From 1, as the booklet numbers it. */
  number: number;
  questionId: string;
  outcome: Outcome;
  earned: number;
  /** What the question is worth in this total: 0 for a question that does not count in it. */
  possible: number;
  /** What the student marked, as the bank's own answers (an id, or "true" or "false"). */
  marked: string[];
  /** Why the question does not count, when it does not. */
  why?: string;
}

export interface SheetScore {
  number: number;
  version?: number;
  earned: number;
  possible: number;
  /** 0 to 100, or undefined when nothing counts. */
  percent?: number;
  /** How many questions count and are settled. */
  settled: number;
  /** How many questions count and are not: flagged and undecided. */
  unsettled: number;
  /** True when every question that counts is settled and nothing is missing from the sheet. */
  complete: boolean;
  problems: string[];
  questions: QuestionScore[];
}

const round = (value: number): number => Math.round(value * 1e6) / 1e6;

export const pointsOf = (question: Question): number => (Number.isFinite(question.points) && question.points >= 0 ? question.points : 1);

/** The bank's answers a set of marked places stand for, in one version. */
function answersFor(question: Question, places: readonly number[]): string[] {
  if (isTrueFalse(question)) return places.flatMap((p) => (p === 0 ? ["true"] : p === 1 ? ["false"] : []));
  if (isChoice(question) || isMultipleResponse(question)) return places.flatMap((p) => (question.body.options[p] ? [question.body.options[p].id] : []));
  return [];
}

/** What the key of a question is, as bank answers. TF is "true" or "false". */
export function keyOf(question: Question): string[] {
  if (isTrueFalse(question)) return question.body.correct === undefined ? [] : [question.body.correct ? "true" : "false"];
  if (isChoice(question) || isMultipleResponse(question)) return question.body.options.filter((o) => o.correct).map((o) => o.id);
  return [];
}

function scoreQuestion(question: Question, number: number, answer: SettledAnswer | undefined, adjustments: readonly Adjustment[], version: number): QuestionScore {
  const base = { number, questionId: question.id, marked: [] as string[] };
  const mine = adjustments.filter((a) => a.questionId === question.id && (a.versions === undefined || a.versions.includes(version)));
  const carried = isChoice(question) || isMultipleResponse(question) || isTrueFalse(question);
  if (!carried) return { ...base, outcome: "notOnSheet", earned: 0, possible: 0, why: "A bubble sheet cannot carry this kind of question." };
  if (!hasUsableKey(question)) return { ...base, outcome: "notScored", earned: 0, possible: 0, why: "This question has no usable answer key, so it is not scored." };
  if (mine.some((a) => a.kind === "drop")) return { ...base, outcome: "dropped", earned: 0, possible: 0, why: "Dropped from the total." };

  const points = [...mine].reverse().find((a): a is Adjustment & { kind: "points" } => a.kind === "points")?.points ?? pointsOf(question);
  if (mine.some((a) => a.kind === "credit")) return { ...base, outcome: "credited", earned: round(points), possible: round(points), marked: answer?.kind === "marked" ? answersFor(question, answer.places) : [] };
  if (!answer || answer.kind === "unsettled") return { ...base, outcome: "unsettled", earned: 0, possible: round(points), why: answer?.kind === "unsettled" ? answer.why : "The sheet has nothing for this question." };
  if (answer.kind === "blank") return { ...base, outcome: "blank", earned: 0, possible: round(points) };

  const marked = answersFor(question, answer.places);
  const key = new Set(keyOf(question));
  for (const a of mine) if (a.kind === "alsoRight") key.add(a.answer);
  if (isMultipleResponse(question)) {
    const right = marked.filter((m) => key.has(m)).length;
    const wrong = marked.length - right;
    const exact = right === key.size && wrong === 0;
    if (exact) return { ...base, outcome: "right", earned: round(points), possible: round(points), marked };
    if (question.body.partialCredit && key.size > 0) {
      const share = Math.max(0, right - wrong) / key.size;
      return { ...base, outcome: share > 0 ? "partial" : "wrong", earned: round(points * share), possible: round(points), marked };
    }
    return { ...base, outcome: "wrong", earned: 0, possible: round(points), marked };
  }
  // One answer: exactly one place marked, and it is a right one.
  const right = marked.length === 1 && key.has(marked[0] as string);
  return { ...base, outcome: right ? "right" : "wrong", earned: right ? round(points) : 0, possible: round(points), marked };
}

/** The score of every settled sheet. */
export function scoreSheets(record: TestRecord, sheets: readonly SettledSheet[], adjustments: readonly Adjustment[] = []): SheetScore[] {
  const lists = new Map<number, Question[]>();
  return sheets.map((sheet) => {
    if (sheet.version === undefined || sheet.version < 1 || sheet.version > record.versions.length) {
      return { number: sheet.number, earned: 0, possible: 0, settled: 0, unsettled: 0, complete: false, problems: sheet.problems.length ? sheet.problems : ["Its version is not settled."], questions: [] };
    }
    let list = lists.get(sheet.version);
    if (!list) {
      list = versionQuestions(record, VERSION_LABELS[sheet.version - 1] as VersionLabel);
      lists.set(sheet.version, list);
    }
    const questions = list.map((question, i) => scoreQuestion(question, i + 1, sheet.answers[i + 1], adjustments, sheet.version as number));
    const counted = questions.filter((q) => q.possible > 0);
    const earned = round(questions.reduce((s, q) => s + q.earned, 0));
    const possible = round(questions.reduce((s, q) => s + q.possible, 0));
    const unsettled = questions.filter((q) => q.outcome === "unsettled").length;
    return {
      number: sheet.number,
      version: sheet.version,
      earned,
      possible,
      ...(possible > 0 ? { percent: round((100 * earned) / possible) } : {}),
      settled: counted.length - unsettled,
      unsettled,
      complete: unsettled === 0 && sheet.problems.length === 0,
      problems: sheet.problems,
      questions,
    };
  });
}

/** How many sheets an adjustment changes, before it is applied, and by how much for each. */
export function adjustmentEffect(record: TestRecord, sheets: readonly SettledSheet[], adjustments: readonly Adjustment[], candidate: Adjustment): { changed: Array<{ sheet: number; from: number; to: number }>; sheets: number } {
  const before = scoreSheets(record, sheets, adjustments);
  const after = scoreSheets(record, sheets, [...adjustments, candidate]);
  const changed = before.flatMap((b, i) => {
    const a = after[i] as SheetScore;
    return a.earned !== b.earned || a.possible !== b.possible ? [{ sheet: b.number, from: b.earned, to: a.earned }] : [];
  });
  return { changed, sheets: before.length };
}
