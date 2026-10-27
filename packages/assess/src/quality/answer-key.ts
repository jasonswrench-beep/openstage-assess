/**
 * Answer key checks.
 *
 * The first row of the item-quality table in the plan: no correct answer
 * marked, more than one marked on a single-answer item, a key letter that does
 * not exist. These are findings, not schema errors, for two reasons. A
 * question half-written in the editor has to be saveable. And a question
 * imported from a file with no key has to be storable so that it can be shown
 * beside its source text and repaired, which is the whole point of the repair
 * preview.
 *
 * The rest of the quality and accessibility checks arrive in phase 7. This one
 * is here in phase 1 because the importer needs it and because it is the check
 * that catches the mistake that actually reaches students.
 */

import { finding, FindingCode, type Finding } from "../model/findings.ts";
import { isChoice, isMultipleResponse, optionsOf, type Question } from "../model/question.ts";

export function checkAnswerKey(question: Question): Finding[] {
  const found: Finding[] = [];

  if (isChoice(question) || isMultipleResponse(question)) {
    const correct = optionsOf(question).filter((o) => o.correct).length;

    if (correct === 0) {
      found.push(
        finding(
          FindingCode.NoAnswerKey,
          "error",
          "No option is marked correct, so this question cannot be scored.",
          { field: "body.options" },
        ),
      );
    } else if (isChoice(question) && correct > 1) {
      found.push(
        finding(
          FindingCode.MultipleKeysOnSingleAnswer,
          "error",
          `${correct} options are marked correct on a single-answer question.`,
          { field: "body.options" },
        ),
      );
    }

    if (isMultipleResponse(question) && correct === optionsOf(question).length) {
      found.push(
        finding(
          FindingCode.NoAnswerKey,
          "warn",
          "Every option is marked correct, which is usually a sign that an answer key was misread.",
          { field: "body.options" },
        ),
      );
    }
  }

  if (question.type === "fillInBlank") {
    const blanks = (question.body as { blanks: Array<{ accepted: string[] }> }).blanks;
    blanks.forEach((blank, i) => {
      if (blank.accepted.every((a) => a.trim().length === 0)) {
        found.push(
          finding(FindingCode.NoAnswerKey, "error", "This blank has no accepted answer.", {
            field: `body.blanks.${i}.accepted`,
          }),
        );
      }
    });
  }

  if (question.type === "shortAnswer") {
    const accepted = (question.body as { accepted: string[] }).accepted;
    if (accepted.every((a) => a.trim().length === 0)) {
      found.push(
        finding(FindingCode.NoAnswerKey, "error", "This question has no accepted answer.", {
          field: "body.accepted",
        }),
      );
    }
  }

  if (question.type === "trueFalse") {
    if ((question.body as { correct?: boolean }).correct === undefined) {
      found.push(
        finding(FindingCode.NoAnswerKey, "error", "Neither True nor False is marked correct.", {
          field: "body.correct",
        }),
      );
    }
  }

  if (question.type === "matching") {
    const pairs = (question.body as { pairs: Array<{ left: unknown; right: string }> }).pairs;
    pairs.forEach((pair, i) => {
      if (typeof pair.right !== "string" || pair.right.trim().length === 0) {
        found.push(
          finding(FindingCode.NoAnswerKey, "error", "This pair has no right-hand match.", {
            field: `body.pairs.${i}.right`,
          }),
        );
      }
    });
  }

  if (question.type === "ordering") {
    const items = (question.body as { items: Array<{ position: number }> }).items;
    const positions = items.map((i) => i.position);
    const wanted = items.map((_, i) => i + 1);
    const sorted = [...positions].sort((a, b) => a - b);
    if (sorted.join(",") !== wanted.join(",")) {
      found.push(
        finding(
          FindingCode.NoAnswerKey,
          "error",
          `The correct order is not a complete ranking of ${items.length} item(s).`,
          { field: "body.items" },
        ),
      );
    }
  }

  if (question.type === "numeric") {
    const body = question.body as { mode: string; value?: number; min?: number; max?: number };
    const missing =
      body.mode === "range"
        ? body.min === undefined || body.max === undefined
        : body.value === undefined;
    if (missing) {
      found.push(
        finding(FindingCode.NoAnswerKey, "error", "This question has no correct value.", {
          field: "body",
        }),
      );
    } else if (body.mode === "range" && (body.min as number) > (body.max as number)) {
      found.push(
        finding(FindingCode.NoAnswerKey, "error", "The accepted range is inverted, so nothing can match.", {
          field: "body",
        }),
      );
    }
  }

  if (question.type === "calculated") {
    const body = question.body as { formula?: string; variables?: unknown[] };
    if (typeof body.formula !== "string" || body.formula.trim().length === 0) {
      found.push(
        finding(FindingCode.NoAnswerKey, "error", "This question has no formula to score against.", {
          field: "body.formula",
        }),
      );
    }
  }

  if (question.type === "hotspot") {
    const regions = (question.body as { regions: Array<{ correct: boolean }> }).regions;
    if (!regions.some((r) => r.correct)) {
      found.push(
        finding(FindingCode.NoAnswerKey, "error", "No region is marked correct, so this question cannot be scored.", {
          field: "body.regions",
        }),
      );
    }
  }

  // Essay is the one type with nothing to check. It is graded by a person, so
  // an absent model answer is a style choice rather than a missing key.

  return found;
}

/**
 * True when the question has a usable key. Used by exporters and the test
 * builder, which is why it has to be conservative.
 *
 * It consults the stored findings as well as re-running the check. An importer
 * knows things the finished question no longer shows — that the source file
 * had two keys for one number, say — and that knowledge lives in the findings.
 * Re-deriving from the body alone would quietly clear it.
 */
export function hasUsableKey(question: Question): boolean {
  if (checkAnswerKey(question).some((f) => f.severity === "error")) return false;
  return !question.findings.some(
    (f) =>
      f.severity === "error" &&
      !f.dismissed &&
      (f.code === FindingCode.NoAnswerKey || f.code === FindingCode.MultipleKeysOnSingleAnswer),
  );
}
