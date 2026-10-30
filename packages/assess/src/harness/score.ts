/**
 * The accuracy harness.
 *
 * A 95 percent parse rate only means something if it is measured the same way
 * every time, which is why this exists in phase 1, before the second importer
 * does. Improving the parser has to be a measurable activity rather than a
 * matter of impression.
 *
 * The comparison is field level, not question level, because a question whose
 * stem and options are perfect but whose page reference was missed is a
 * different failure from one where the key is wrong, and only the second is
 * dangerous. The score that governs the acceptance criterion counts a question
 * as correct only when type, stem, options and key all match.
 */

import { richTextToPlain } from "../model/richtext.ts";
import { optionsOf, type Question } from "../model/question.ts";
import { verdictOf, type ImportResult } from "../import/types.ts";
import type { Verdict } from "../model/findings.ts";

export interface ExpectedQuestion {
  type: string;
  stem: string;
  options?: string[];
  /** Zero-based indices of the correct options. */
  correct?: number[];
  title?: string;
  points?: number;
  metadata?: Record<string, string>;
  /** Feedback the question should carry. Recorded when it differs, but not counted against the score. */
  feedback?: { general?: string; correct?: string; incorrect?: string };
  /** For true or false. */
  correctBoolean?: boolean;
  /** For fill in the blank and short answer. */
  accepted?: string[];
  /** For matching: "left = right" strings, in order. */
  pairs?: string[];
  /**
   * The verdict this question is supposed to come out with. Absent means
   * "parsed", because that is what a fixture asserts unless it says otherwise.
   *
   * This is not decoration. Field agreement alone would score a question as
   * correct while it carries an error finding and cannot be used, which is the
   * opposite of what the 95 percent gate is for. A fixture that deliberately
   * withholds an answer key declares "failed" here, and then the parser
   * flagging it is the pass rather than the failure.
   */
  verdict?: Verdict;
}

export interface ExpectedFile {
  file: string;
  note?: string;
  questions: ExpectedQuestion[];
  orphans?: number;
}

export interface FieldMismatch {
  questionIndex: number;
  field: string;
  expected: string;
  actual: string;
}

export interface FileScore {
  file: string;
  expectedCount: number;
  foundCount: number;
  /** Questions where type, stem, options and key all match. */
  correct: number;
  verdicts: Record<Verdict, number>;
  orphans: number;
  expectedOrphans?: number;
  mismatches: FieldMismatch[];
  /** What `correct` is divided by: questions plus any structural failure. */
  denominator: number;
  /** correct / denominator, or 0 when nothing was expected. */
  score: number;
}

/** Whitespace and case are not what a parser gets wrong; content is. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function same(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}

function actualOptions(question: Question): string[] {
  const options = optionsOf(question);
  if (options.length > 0) return options.map((o) => richTextToPlain(o.content));

  const body = question.body as Record<string, any>;
  if (Array.isArray(body["items"])) {
    return (body["items"] as Array<Record<string, any>>).map((i) => richTextToPlain(i["content"]));
  }
  return [];
}

function actualCorrect(question: Question): number[] {
  return optionsOf(question)
    .map((o, i) => (o.correct ? i : -1))
    .filter((i) => i >= 0);
}

function actualAccepted(question: Question): string[] {
  const body = question.body as Record<string, any>;
  if (Array.isArray(body["accepted"])) return body["accepted"] as string[];
  if (Array.isArray(body["blanks"])) {
    return (body["blanks"] as Array<{ accepted: string[] }>).flatMap((b) => b.accepted);
  }
  return [];
}

function actualPairs(question: Question): string[] {
  const body = question.body as Record<string, any>;
  if (!Array.isArray(body["pairs"])) return [];
  return (body["pairs"] as Array<Record<string, any>>).map(
    (p) => `${richTextToPlain(p["left"])} = ${p["right"]}`,
  );
}

function compareQuestion(
  index: number,
  expected: ExpectedQuestion,
  actual: Question | undefined,
  mismatches: FieldMismatch[],
): boolean {
  const add = (field: string, want: unknown, got: unknown) => {
    mismatches.push({
      questionIndex: index,
      field,
      expected: typeof want === "string" ? want : JSON.stringify(want),
      actual: typeof got === "string" ? got : JSON.stringify(got),
    });
  };

  if (!actual) {
    add("question", expected.stem, "(not found)");
    return false;
  }

  // The four fields that decide correctness.
  let core = true;

  if (actual.type !== expected.type) {
    add("type", expected.type, actual.type);
    core = false;
  }
  if (!same(richTextToPlain(actual.stem), expected.stem)) {
    add("stem", expected.stem, richTextToPlain(actual.stem));
    core = false;
  }

  if (expected.options) {
    const got = actualOptions(actual);
    if (got.length !== expected.options.length) {
      add("options.length", String(expected.options.length), String(got.length));
      core = false;
    } else {
      expected.options.forEach((want, i) => {
        if (!same(want, got[i] ?? "")) {
          add(`options.${i}`, want, got[i] ?? "");
          core = false;
        }
      });
    }
  }

  if (expected.correct) {
    const got = actualCorrect(actual);
    if (JSON.stringify(got) !== JSON.stringify(expected.correct)) {
      add("correct", JSON.stringify(expected.correct), JSON.stringify(got));
      core = false;
    }
  }

  // The verdict is one of the fields that decides correctness. A question whose
  // text is perfect but which carries an error finding is not a question anyone
  // can put on a test, and counting it as correct is how a parser reports 95
  // percent while every item it produced needs a human.
  const wantVerdict: Verdict = expected.verdict ?? "parsed";
  const gotVerdict = verdictOf(actual);
  if (gotVerdict !== wantVerdict) {
    add("verdict", wantVerdict, gotVerdict);
    core = false;
  }

  if (expected.correctBoolean !== undefined) {
    const got = (actual.body as Record<string, unknown>)["correct"];
    if (got !== expected.correctBoolean) {
      add("correct", String(expected.correctBoolean), String(got));
      core = false;
    }
  }

  if (expected.accepted) {
    const got = actualAccepted(actual).map(normalize);
    const want = expected.accepted.map(normalize);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      add("accepted", JSON.stringify(expected.accepted), JSON.stringify(actualAccepted(actual)));
      core = false;
    }
  }

  if (expected.pairs) {
    const got = actualPairs(actual).map(normalize);
    const want = expected.pairs.map(normalize);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      add("pairs", JSON.stringify(expected.pairs), JSON.stringify(actualPairs(actual)));
      core = false;
    }
  }

  // Fields recorded as mismatches but not counted against the score, because
  // a missed page reference is a different kind of failure from a wrong key.
  if (expected.title !== undefined && !same(actual.title, expected.title)) {
    add("title", expected.title, actual.title);
  }
  if (expected.points !== undefined && actual.points !== expected.points) {
    add("points", String(expected.points), String(actual.points));
  }
  if (expected.feedback) {
    for (const kind of ["general", "correct", "incorrect"] as const) {
      const want = expected.feedback[kind];
      if (want === undefined) continue;
      const got = actual.feedback[kind];
      const text = got === undefined ? undefined : richTextToPlain(got);
      if (text === undefined || !same(text, want)) add(`feedback.${kind}`, want, text ?? "(missing)");
    }
  }
  if (expected.metadata) {
    for (const [key, want] of Object.entries(expected.metadata)) {
      const got =
        (actual.metadata as unknown as Record<string, unknown>)[key] ??
        actual.metadata.custom?.[key];
      if (got === undefined || !same(String(got), want)) {
        add(`metadata.${key}`, want, got === undefined ? "(missing)" : String(got));
      }
    }
  }

  return core;
}

export function scoreFile(expected: ExpectedFile, result: ImportResult): FileScore {
  const mismatches: FieldMismatch[] = [];
  const verdicts: Record<Verdict, number> = { parsed: 0, needsReview: 0, failed: 0 };
  for (const question of result.questions) verdicts[verdictOf(question)]++;

  let correct = 0;
  expected.questions.forEach((want, i) => {
    if (compareQuestion(i, want, result.questions[i], mismatches)) correct++;
  });

  // An orphan count is part of the expectation, not a note: a parser that
  // quietly swallows a chapter heading into a stem has failed even if every
  // question it produced is right.
  if (expected.orphans !== undefined && result.orphans.length !== expected.orphans) {
    mismatches.push({
      questionIndex: -1,
      field: "orphans",
      expected: String(expected.orphans),
      actual: String(result.orphans.length),
    });
  }

  // Extra questions the parser invented are a failure too.
  if (result.questions.length > expected.questions.length) {
    for (let i = expected.questions.length; i < result.questions.length; i++) {
      const extra = result.questions[i] as Question;
      mismatches.push({
        questionIndex: i,
        field: "question",
        expected: "(nothing)",
        actual: richTextToPlain(extra.stem).slice(0, 60),
      });
    }
  }

  // The denominator has to carry the structural failures too, or they are
  // recorded as mismatches that nothing acts on. Inventing questions dilutes
  // the score through max(); swallowing or inventing orphan text adds one unit
  // of failure, because text that went missing is a defect of the file even
  // when every question that survived is right.
  const orphansWrong =
    expected.orphans !== undefined && result.orphans.length !== expected.orphans;
  const denominator =
    Math.max(expected.questions.length, result.questions.length) + (orphansWrong ? 1 : 0);

  return {
    file: expected.file,
    expectedCount: expected.questions.length,
    foundCount: result.questions.length,
    correct,
    verdicts,
    orphans: result.orphans.length,
    ...(expected.orphans !== undefined ? { expectedOrphans: expected.orphans } : {}),
    mismatches,
    denominator,
    score: denominator === 0 ? 0 : correct / denominator,
  };
}

export interface HarnessSummary {
  files: FileScore[];
  expectedTotal: number;
  correctTotal: number;
  denominatorTotal: number;
  score: number;
  verdicts: Record<Verdict, number>;
}

export function summarise(files: readonly FileScore[]): HarnessSummary {
  const verdicts: Record<Verdict, number> = { parsed: 0, needsReview: 0, failed: 0 };
  let expectedTotal = 0;
  let correctTotal = 0;
  let denominatorTotal = 0;
  for (const file of files) {
    expectedTotal += file.expectedCount;
    correctTotal += file.correct;
    denominatorTotal += file.denominator;
    verdicts.parsed += file.verdicts.parsed;
    verdicts.needsReview += file.verdicts.needsReview;
    verdicts.failed += file.verdicts.failed;
  }
  return {
    files: [...files],
    expectedTotal,
    correctTotal,
    denominatorTotal,
    score: denominatorTotal === 0 ? 0 : correctTotal / denominatorTotal,
    verdicts,
  };
}

export function formatSummary(summary: HarnessSummary, options: { showMismatches?: boolean } = {}): string {
  const lines: string[] = [];
  const pad = (text: string, width: number) => text.padEnd(width);
  const padLeft = (text: string, width: number) => text.padStart(width);

  lines.push(
    pad("file", 34) + padLeft("found", 7) + padLeft("want", 6) + padLeft("ok", 5) +
      padLeft("review", 8) + padLeft("failed", 8) + padLeft("score", 8),
  );
  lines.push("-".repeat(76));
  for (const file of summary.files) {
    lines.push(
      pad(file.file, 34) +
        padLeft(String(file.foundCount), 7) +
        padLeft(String(file.expectedCount), 6) +
        padLeft(String(file.correct), 5) +
        padLeft(String(file.verdicts.needsReview), 8) +
        padLeft(String(file.verdicts.failed), 8) +
        padLeft(`${(file.score * 100).toFixed(1)}%`, 8),
    );
  }
  lines.push("-".repeat(76));
  lines.push(
    pad("total", 34) +
      padLeft("", 7) +
      padLeft(String(summary.expectedTotal), 6) +
      padLeft(String(summary.correctTotal), 5) +
      padLeft(String(summary.verdicts.needsReview), 8) +
      padLeft(String(summary.verdicts.failed), 8) +
      padLeft(`${(summary.score * 100).toFixed(1)}%`, 8),
  );

  if (options.showMismatches) {
    for (const file of summary.files) {
      if (file.mismatches.length === 0) continue;
      lines.push("", `${file.file}:`);
      for (const m of file.mismatches) {
        lines.push(m.questionIndex < 0 ? `  ${m.field}` : `  question ${m.questionIndex + 1}, ${m.field}`);
        lines.push(`    expected: ${m.expected}`);
        lines.push(`    actual:   ${m.actual}`);
      }
    }
  }
  return lines.join("\n");
}
