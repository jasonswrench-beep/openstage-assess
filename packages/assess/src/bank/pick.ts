/**
 * Picking questions for a test: some number of the questions that have a value (this chapter, this objective, this tag), chosen at
 * random from a seed, so that the same seed gives the same questions and a different one gives others.
 *
 * It picks only what a test can use, and says what it left out and why, so a short result is never a mystery. It does not pick:
 *
 *  - a retired question (it is not in use);
 *  - a question already chosen (the ids it is told about);
 *  - a question with no usable answer key, because a test built at random should not carry one that cannot be scored (a person can
 *    still choose it by hand);
 *  - a question that is the same as, or very much alike to, one already chosen or already picked here (`findDuplicates`), so that a
 *    test built from a bank with copies in it does not ask the same thing twice.
 *
 * Nothing is guessed about a question's value: one with no chapter is picked only when asked for "(none)".
 */

import { shuffledFor } from "../model/random.ts";
import type { Question } from "../model/question.ts";
import { hasUsableKey } from "../quality/answer-key.ts";
import { findDuplicates } from "../quality/bank.ts";
import { matchesFacets, type CoverageAxis } from "./coverage.ts";

/** The most that can be asked for at once. */
export const MOST_PICKED = 1000;

export interface PickOptions {
  axis: CoverageAxis;
  /** The value the questions must have on the axis. `(none)` asks for those that have none. */
  value: string;
  /**
   * Further values the questions must have as well, each on an axis (the first is `axis` and `value`): "chapter 2 and Apply" is
   * `axis` chapter, `value` 2 and `also` one condition for the Bloom level. A question has to match every one. A blank value is
   * refused, because the question filter reads a blank as no filter, and a condition that took from the whole bank would read as
   * though it had asked for something.
   */
  also?: ReadonlyArray<{ axis: CoverageAxis; value: string }>;
  /** How many to pick, from 1 to `MOST_PICKED`. */
  count: number;
  /** Questions already in the test: not picked again, and nothing alike to them is picked. */
  chosen?: readonly string[];
  /** The same seed picks the same questions from the same bank. */
  seed?: string;
}

export interface PickResult {
  /** The questions picked, in the order they were picked. */
  ids: string[];
  wanted: number;
  /** Questions with the value that could have been picked: not retired, not chosen, with a usable key. */
  candidates: number;
  /** Questions with the value that were left out, by the reason. */
  left: { retired: number; chosen: number; noKey: number; alike: number };
}

export function pickQuestions(questions: readonly Question[], options: PickOptions): PickResult {
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > MOST_PICKED) {
    throw new RangeError(`The number of questions to pick is a whole number from 1 to ${MOST_PICKED}.`);
  }
  const also = options.also ?? [];
  for (const c of also) {
    if (c.value.trim() === "") throw new RangeError(`A condition on ${c.axis} needs a value. A blank one would match every question.`);
  }
  const taken = new Set(options.chosen ?? []);
  const left = { retired: 0, chosen: 0, noKey: 0, alike: 0 };

  // The copies in the bank, as groups: a group with a question in the test, or one picked, has no other picked.
  const groupOf = new Map<string, number>();
  findDuplicates(questions).forEach((group, g) => group.questionIds.forEach((id) => groupOf.set(id, g)));
  const usedGroups = new Set<number>();
  for (const id of taken) {
    const g = groupOf.get(id);
    if (g !== undefined) usedGroups.add(g);
  }

  const eligible: Question[] = [];
  for (const q of [...questions].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!matchesFacets(q, { [options.axis]: options.value })) continue;
    // Each further condition is tried on its own, so two on one axis (two tags) both have to hold; one record keyed by axis would keep only the last.
    if (!also.every((c) => matchesFacets(q, { [c.axis]: c.value }))) continue;
    if (q.metadata.status === "retired") left.retired++;
    else if (taken.has(q.id)) left.chosen++;
    else if (!hasUsableKey(q)) left.noKey++;
    else eligible.push(q);
  }

  const ids: string[] = [];
  const shuffled = shuffledFor(
    eligible.map((q) => q.id),
    // A pick with no further condition has the seed it always had, so what a seed took before it takes now.
    `${options.seed ?? ""}:pick:${options.axis}:${options.value}${also.map((c) => `:and:${c.axis}:${c.value}`).join("")}`,
  );
  for (const id of shuffled) {
    const g = groupOf.get(id);
    if (g !== undefined && usedGroups.has(g)) {
      left.alike++;
      continue;
    }
    if (ids.length >= options.count) continue;
    ids.push(id);
    if (g !== undefined) usedGroups.add(g);
  }
  // `alike` counts the questions left out because a copy of them was in the test or was picked first. Questions that were fine
  // and were not needed, because the count was reached, are not counted anywhere: they were never left out for a reason.
  return { ids, wanted: options.count, candidates: eligible.length, left };
}
