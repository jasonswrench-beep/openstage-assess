/**
 * Item statistics: what a class's answers say about each question and about the test.
 *
 * Computed from scored sheets, across every version, per bank question (a question has the same id on every version, so its figures are
 * one set however its answers were ordered). Only sheets that are complete are used: a sheet with a question still undecided would
 * count it as nothing and spoil every figure beside it. The number of sheets is carried with every figure, and a group of fewer than 30
 * says its figures are unstable, so a small class is not over-read.
 *
 * The figures are plain: difficulty is the share of the points earned; discrimination is the point-biserial correlation of the
 * question's score with the total score (which includes the question), and the top 27 percent against the bottom 27 percent; the options
 * are how many sheets marked each; blanks are how many left it empty; and for the whole test KR-20, or Cronbach's alpha when a question
 * gives partial credit, since KR-20 is defined for questions that are right or wrong.
 */

import { isChoice, isMultipleResponse, isTrueFalse, type Question } from "../model/question.ts";
import type { TestRecord } from "../model/test.ts";
import type { SheetScore } from "./score.ts";

export const SMALL_GROUP = 30;

export interface OptionCount {
  /** The bank's answer: an option's id, or "true" or "false". */
  answer: string;
  correct: boolean;
  /** How many sheets marked it. */
  chosen: number;
}

export interface ItemStatistics {
  questionId: string;
  /** How many complete sheets this question counted on. */
  sheets: number;
  /** The share of the points earned, 0 to 1. Undefined when no sheet counted it. */
  difficulty?: number;
  discrimination: {
    /** The correlation of the question's score with the total, from -1 to 1. Undefined when either does not vary. */
    pointBiserial?: number;
    /** The share of the points the top 27 percent earned less the bottom 27 percent's. Undefined for a class too small to split. */
    upperLower?: number;
    /** How many sheets are in each of the two groups. */
    groupSize?: number;
  };
  options: OptionCount[];
  blanks: number;
  notes: string[];
}

export interface TestStatistics {
  /** The complete sheets the figures are from, and the ones left out. */
  sheets: number;
  leftOut: number;
  mean?: number;
  sd?: number;
  possible?: number;
  reliability?: { kind: "KR-20" | "Cronbach alpha"; value: number; items: number };
  /** Whether the group is under 30. */
  unstable: boolean;
  items: ItemStatistics[];
  notes: string[];
}

const mean = (values: readonly number[]): number => values.reduce((s, v) => s + v, 0) / values.length;
/** The variance with the number of sheets as the divisor: the figures describe this class, and KR-20 is defined on it. */
const variance = (values: readonly number[]): number => {
  const m = mean(values);
  return values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length;
};

function correlation(a: readonly number[], b: readonly number[]): number | undefined {
  if (a.length < 2) return undefined;
  const va = variance(a);
  const vb = variance(b);
  if (va < 1e-12 || vb < 1e-12) return undefined;
  const ma = mean(a);
  const mb = mean(b);
  let cov = 0;
  for (let i = 0; i < a.length; i++) cov += ((a[i] as number) - ma) * ((b[i] as number) - mb);
  cov /= a.length;
  return Math.max(-1, Math.min(1, cov / Math.sqrt(va * vb)));
}

const round = (v: number, digits = 4): number => Math.round(v * 10 ** digits) / 10 ** digits;

/** The answers a question can be marked with, in the bank's order. */
function optionsOf(question: Question): Array<{ answer: string; correct: boolean }> {
  if (isTrueFalse(question)) return [{ answer: "true", correct: question.body.correct === true }, { answer: "false", correct: question.body.correct === false }];
  if (isChoice(question) || isMultipleResponse(question)) return question.body.options.map((o) => ({ answer: o.id, correct: o.correct }));
  return [];
}

export function itemStatistics(record: TestRecord, scores: readonly SheetScore[]): TestStatistics {
  const complete = scores.filter((s) => s.complete && s.version !== undefined);
  const notes: string[] = [];
  const leftOut = scores.length - complete.length;
  if (leftOut > 0) notes.push(`${leftOut} sheet${leftOut === 1 ? " was" : "s were"} left out because ${leftOut === 1 ? "it has" : "they have"} a question not yet settled, a page missing, or no version.`);
  const unstable = complete.length < SMALL_GROUP;
  if (unstable) notes.push(`Only ${complete.length} sheet${complete.length === 1 ? "" : "s"}: fewer than ${SMALL_GROUP}, so these figures are unstable and should not be over-read.`);
  if (complete.length === 0) return { sheets: 0, leftOut, unstable, items: [], notes };

  const totals = complete.map((s) => s.earned);
  const ordered = complete.map((s, i) => ({ s, i })).sort((a, b) => b.s.earned - a.s.earned || a.s.number - b.s.number);
  const group = Math.round(0.27 * complete.length);
  const canSplit = group >= 2 && group * 2 <= complete.length;
  const upper = new Set(canSplit ? ordered.slice(0, group).map((x) => x.i) : []);
  const lower = new Set(canSplit ? ordered.slice(-group).map((x) => x.i) : []);

  const items: ItemStatistics[] = [];
  const reliabilityItems: Array<{ id: string; scores: number[]; partial: boolean }> = [];
  for (const question of record.questions) {
    const rows = complete.map((s) => (s.questions.find((q) => q.questionId === question.id) ?? undefined));
    const counted = rows.map((q, i) => ({ q, i })).filter((x) => x.q !== undefined && x.q.possible > 0);
    if (counted.length === 0) continue;
    const fractions = counted.map((x) => (x.q as NonNullable<typeof x.q>).earned / (x.q as NonNullable<typeof x.q>).possible);
    const notesHere: string[] = [];
    if (counted.length < SMALL_GROUP) notesHere.push(`Only ${counted.length} sheet${counted.length === 1 ? "" : "s"}: the figures for this question are unstable.`);
    const counts = new Map<string, OptionCount>(optionsOf(question).map((o): [string, OptionCount] => [o.answer, { ...o, chosen: 0 }]));
    let blanks = 0;
    for (const { q } of counted) {
      if (!q) continue;
      if (q.outcome === "blank") blanks++;
      for (const m of q.marked) {
        const c = counts.get(m);
        if (c) c.chosen++;
      }
    }
    const pb = correlation(fractions, counted.map((x) => totals[x.i] as number));
    const topRows = counted.filter((x) => upper.has(x.i));
    const bottomRows = counted.filter((x) => lower.has(x.i));
    const frac = (x: (typeof counted)[number]): number => (x.q as NonNullable<typeof x.q>).earned / (x.q as NonNullable<typeof x.q>).possible;
    const ul = canSplit && topRows.length > 0 && bottomRows.length > 0 ? mean(topRows.map(frac)) - mean(bottomRows.map(frac)) : undefined;
    items.push({
      questionId: question.id,
      sheets: counted.length,
      difficulty: round(mean(fractions)),
      discrimination: { ...(pb !== undefined ? { pointBiserial: round(pb) } : {}), ...(ul !== undefined ? { upperLower: round(ul), groupSize: group } : {}) },
      options: [...counts.values()],
      blanks,
      notes: notesHere,
    });
    // Reliability uses a question only if it counts, with its points, on every sheet used.
    if (counted.length === complete.length) {
      reliabilityItems.push({ id: question.id, scores: counted.map((x) => (x.q as NonNullable<typeof x.q>).earned), partial: isMultipleResponse(question) && question.body.partialCredit });
    }
  }

  const sd = Math.sqrt(variance(totals));
  const out: TestStatistics = { sheets: complete.length, leftOut, mean: round(mean(totals)), sd: round(sd), possible: complete[0]?.possible, unstable, items, notes };
  if (reliabilityItems.length < items.length) notes.push("Some question counts on only some sheets (an adjustment for one version), and is left out of the reliability figure.");
  const k = reliabilityItems.length;
  const varianceOfTotals = variance(totals);
  if (k >= 2 && complete.length >= 2 && varianceOfTotals > 1e-12) {
    // The total of the questions used, which is the whole total unless some were left out above.
    const sumOfItems = reliabilityItems.reduce((s, it) => s + variance(it.scores), 0);
    const itemTotals = complete.map((_s, j) => reliabilityItems.reduce((s, it) => s + (it.scores[j] as number), 0));
    const vt = variance(itemTotals);
    if (vt > 1e-12) {
      const alpha = (k / (k - 1)) * (1 - sumOfItems / vt);
      const partial = reliabilityItems.some((it) => it.partial);
      out.reliability = { kind: partial ? "Cronbach alpha" : "KR-20", value: round(alpha), items: k };
      if (partial) notes.push("A question with several answers gives partial credit, and KR-20 is defined for questions that are right or wrong, so Cronbach's alpha is shown instead.");
    }
  }
  return out;
}
