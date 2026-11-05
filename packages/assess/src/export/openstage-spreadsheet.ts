/**
 * Export to the question spreadsheet that OpenStage Author and OpenStage Scroll
 * read.
 *
 * Author's "Quiz from a file" reads a table of questions saved as CSV (its
 * documentation is docs/question-import.md in that project, and the reader is
 * editor/src/questionimport.ts). This writes the file it reads, and nothing
 * else about Author is assumed. The two programs share a file, not code.
 *
 * What the format is, as Author reads it:
 *
 *   - Four question types: MC, MR, TF and SA. Matching, ordering, numeric,
 *     essay and the rest cannot be written in a table.
 *   - Columns Type, Question, A to H, Correct, Points, Feedback if right and
 *     Feedback if wrong. Attempts is a column too, but attempts are a delivery
 *     setting and not part of a question, so it is left out and Author applies
 *     its own default.
 *   - Plain text only. Bold, pictures and links are added in Author afterwards.
 *   - At most 200 questions in a file. Author refuses a longer file whole, so a
 *     bigger bank is split.
 *   - The Question cell is read as one line: Author collapses line breaks in it
 *     into spaces. Feedback keeps its line breaks.
 *   - A short answer takes at most ten accepted answers. Up to eight go in
 *     columns A to H; nine or ten go in the Correct column, separated by bars.
 *
 * The file is UTF-8 with a byte order mark and CRLF line ends, the same as
 * Author's own template, so that Excel opens it with accents intact.
 *
 * The destination check (see ./types.ts) is built from the same pass that
 * builds the rows, so the report cannot disagree with the file.
 */

import { hasUsableKey } from "../quality/answer-key.ts";
import { isChoice, isFillInBlank, isMultipleResponse, isShortAnswer, isTrueFalse, type Question } from "../model/question.ts";
import type { DestinationReport, ExportedFile, ExportResult, ReportItem } from "./types.ts";
import { exportable, hasText, keyProblem, newLosses, plainText, plural, safeName, TYPE_NAMES } from "./text.ts";

export const DESTINATION_ID = "openstage-spreadsheet";
export const DESTINATION_LABEL = "OpenStage question spreadsheet (Author and Scroll)";

/** Author refuses a file with more questions than this, whole. */
export const MAX_QUESTIONS_PER_FILE = 200;
/** Columns A to H. */
export const MAX_ANSWERS = 8;
/** Accepted answers for a short answer, wherever they are written. */
export const MAX_ACCEPTED = 10;

const LETTERS = "ABCDEFGH";
const BYTE_ORDER_MARK = "﻿";

interface Row {
  type: "MC" | "MR" | "TF" | "SA";
  question: string;
  answers: string[];
  correct: string;
  points: number;
  right: string;
  wrong: string;
}

// ---------------------------------------------------------------------------
// One question
// ---------------------------------------------------------------------------

interface Planned {
  item: ReportItem;
  row?: Row;
}

function plan(question: Question, position: number): Planned {
  const base = { position, questionId: question.id, title: question.title };
  const leftOut = (why: string): Planned => ({ item: { ...base, outcome: "leftOut", notes: [why] } });

  const supported =
    isChoice(question) ||
    isMultipleResponse(question) ||
    isTrueFalse(question) ||
    isFillInBlank(question) ||
    isShortAnswer(question);
  if (!supported) {
    const name = TYPE_NAMES[question.type];
    return leftOut(
      `The spreadsheet holds multiple choice, multiple response, true or false and short answer questions. ${/^[aeiou]/.test(name) ? "An" : "A"} ${name} question cannot be written in it.`,
    );
  }
  // Never export a question whose key is missing or broken: the row would be
  // refused by Author, or worse, read as if it were keyed.
  if (!hasUsableKey(question)) return leftOut(keyProblem(question, "the spreadsheet"));

  const losses = newLosses();
  const notes: string[] = [];

  const stem = plainText(question.stem, question, losses, false);
  if (stem === "") return leftOut("It has no question text once it is written as plain text.");

  let type: Row["type"];
  let answers: string[];
  let correct: string;
  let asType: string | undefined;

  if (isChoice(question) || isMultipleResponse(question)) {
    const options = question.body.options;
    if (options.length > MAX_ANSWERS) {
      return leftOut(`It has ${options.length} answers and the spreadsheet holds ${MAX_ANSWERS}.`);
    }
    answers = options.map((option) => plainText(option.content, question, losses, false));
    if (answers.some((answer) => answer === "")) {
      return leftOut("One of its answers has no text, and an empty answer would shift the letters of the ones after it.");
    }
    const right = options.flatMap((option, i) => (option.correct ? [i] : []));
    const multiple = isMultipleResponse(question);
    if (multiple && right.length === options.length) {
      return leftOut("Every answer is marked right. Author refuses that, because there is nothing to choose.");
    }
    if (!multiple && right.length !== 1) {
      return leftOut(`It marks ${right.length} answers right, and a multiple choice question has one.`);
    }
    type = multiple ? "MR" : "MC";
    correct = right.map((i) => LETTERS.charAt(i)).join(", ");

    const withFeedback = options.filter((option) => option.feedback && hasText(option.feedback)).length;
    if (withFeedback > 0) {
      notes.push(
        `Feedback written under individual answers is not carried (${plural(withFeedback, "answer has", "answers have")} it). The spreadsheet has feedback for a right answer and for a wrong one only.`,
      );
    }
    if (!question.body.shuffle || options.some((option) => option.fixedPosition)) {
      notes.push(
        "This question keeps its answers in a fixed order, and the spreadsheet cannot say so. Author's setting for mixing answers applies to the whole file.",
      );
    }
    // Author scores every multiple response as a share: the right answers ticked,
    // less the wrong ones, over the number that are right. That is partial credit,
    // so a question with partial credit on arrives as it was meant. One marked all
    // or nothing is the one that does not.
    if (isMultipleResponse(question) && !question.body.partialCredit) {
      notes.push(
        "This question is all or nothing, and Author always gives a share of the points: the right answers ticked, less the wrong ones.",
      );
    }
  } else if (isTrueFalse(question)) {
    // The key is never guessed. hasUsableKey has already refused an unset one,
    // so this is a second lock on the same door.
    if (typeof question.body.correct !== "boolean") return leftOut("Neither True nor False is marked, and nothing is guessed.");
    type = "TF";
    answers = [];
    correct = question.body.correct ? "True" : "False";
  } else {
    let accepted: string[];
    let caseSensitive: boolean;
    if (isFillInBlank(question)) {
      const blank = question.body.blanks[0];
      if (!blank || question.body.blanks.length !== 1) {
        return leftOut(`It has ${question.body.blanks.length} blanks, and a short answer holds one.`);
      }
      accepted = blank.accepted;
      caseSensitive = question.body.caseSensitive;
      asType = "short answer";
      notes.push("A fill in the blank is written as a short answer.");
    } else if (isShortAnswer(question)) {
      accepted = question.body.accepted;
      caseSensitive = question.body.caseSensitive;
    } else {
      return leftOut("This kind of question cannot be written in the spreadsheet.");
    }

    const cleaned = accepted.map((a) => a.replace(/\s+/g, " ").trim()).filter((a) => a !== "");
    if (cleaned.length === 0) return leftOut("It has no accepted answer, and nothing is guessed.");
    if (cleaned.length > MAX_ACCEPTED) {
      return leftOut(`It has ${cleaned.length} accepted answers and Author takes at most ${MAX_ACCEPTED}.`);
    }
    type = "SA";
    if (cleaned.length <= MAX_ANSWERS) {
      answers = cleaned;
      correct = "";
    } else if (cleaned.some((a) => a.includes("|"))) {
      return leftOut(
        `It has ${cleaned.length} accepted answers, more than the ${MAX_ANSWERS} answer columns, and one contains a bar, which is how the Correct column separates them.`,
      );
    } else {
      answers = [];
      correct = cleaned.join("|");
    }
    if (caseSensitive) notes.push("Upper and lower case count in this question, and the spreadsheet cannot say so.");
  }

  const right = question.feedback.correct ? plainText(question.feedback.correct, question, losses, true) : "";
  const wrong = question.feedback.incorrect ? plainText(question.feedback.incorrect, question, losses, true) : "";
  if (question.feedback.general && hasText(question.feedback.general)) {
    notes.push("General feedback is not carried: the spreadsheet has feedback for a right answer and for a wrong one only.");
  }

  if (losses.pictures > 0) {
    notes.push(
      `${plural(losses.pictures, "picture", "pictures")} cannot be carried. Each appears in the text as [Picture: its alternative text]; add the picture again in Author.`,
    );
  }
  if (losses.equations > 0) {
    notes.push(
      `${plural(losses.equations, "equation", "equations")} became text, written as [Equation: LaTeX]. Check how it reads in Author.`,
    );
  }
  if (losses.formatting) notes.push("Bold, italics, lists or tables became plain text.");
  if (losses.breaks) {
    notes.push("Paragraph breaks in the wording or the answers became spaces, because Author reads each as one line.");
  }

  const row: Row = { type, question: stem, answers, correct, points: question.points, right, wrong };
  const item: ReportItem = {
    ...base,
    outcome: notes.length > 0 ? "exportedWithLosses" : "exported",
    ...(asType ? { asType } : {}),
    notes,
  };
  return { item, row };
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

/**
 * Quoted whenever it holds a comma, quote, semicolon or line break. Content is
 * never altered to defend against spreadsheet formulas: the cell would no
 * longer be the question, and Author reads the file directly.
 */
function csvCell(value: string): string {
  return /[",;\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function renderCsv(rows: readonly Row[]): string {
  const width = Math.max(2, ...rows.map((row) => row.answers.length));
  const letters = Array.from({ length: width }, (_, i) => LETTERS.charAt(i));
  const header = ["Type", "Question", ...letters, "Correct", "Points", "Feedback if right", "Feedback if wrong"];
  const lines = rows.map((row) => [
    row.type,
    row.question,
    ...letters.map((_, i) => row.answers[i] ?? ""),
    row.correct,
    String(row.points),
    row.right,
    row.wrong,
  ]);
  return BYTE_ORDER_MARK + [header, ...lines].map((line) => line.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export interface SpreadsheetOptions {
  /** What to call the file, usually the bank's title. Split files get -1, -2 and so on. */
  name?: string;
}

interface Plan {
  chunks: Row[][];
  names: string[];
  report: DestinationReport;
}

function buildPlan(questions: readonly Question[], options: SpreadsheetOptions): Plan {
  questions = exportable(questions);
  const items: ReportItem[] = [];
  const rows: Row[] = [];
  questions.forEach((question, i) => {
    const planned = plan(question, i + 1);
    items.push(planned.item);
    if (planned.row) rows.push(planned.row);
  });

  const chunks: Row[][] = [];
  for (let i = 0; i < rows.length; i += MAX_QUESTIONS_PER_FILE) chunks.push(rows.slice(i, i + MAX_QUESTIONS_PER_FILE));

  const base = safeName(options.name);
  const names = chunks.length <= 1 ? chunks.map(() => `${base}.csv`) : chunks.map((_, i) => `${base}-${i + 1}.csv`);

  const general = [
    "The spreadsheet is plain text. Titles, tags, objectives, difficulty and history are not part of it.",
    "Attempts is a delivery setting, not part of a question, so there is no Attempts column and Author applies its own default.",
  ];
  if (chunks.length > 1) {
    general.push(
      `Author reads at most ${MAX_QUESTIONS_PER_FILE} questions from one file, so these are in ${chunks.length} files. Add them to Author one file at a time.`,
    );
  }

  const count = (outcome: ReportItem["outcome"]): number => items.filter((item) => item.outcome === outcome).length;
  const report: DestinationReport = {
    destination: DESTINATION_ID,
    label: DESTINATION_LABEL,
    total: questions.length,
    exported: count("exported"),
    exportedWithLosses: count("exportedWithLosses"),
    leftOut: count("leftOut"),
    files: names,
    general,
    items,
  };
  return { chunks, names, report };
}

/** The destination check on its own: what would arrive, what would be lost, what cannot go. */
export function checkOpenStageSpreadsheet(
  questions: readonly Question[],
  options: SpreadsheetOptions = {},
): DestinationReport {
  return buildPlan(questions, options).report;
}

/** The destination check, and the file or files to write. */
export function exportOpenStageSpreadsheet(
  questions: readonly Question[],
  options: SpreadsheetOptions = {},
): ExportResult {
  const { chunks, names, report } = buildPlan(questions, options);
  const files: ExportedFile[] = chunks.map((rows, i) => ({
    name: names[i] as string,
    content: renderCsv(rows),
    questions: rows.length,
  }));
  return { files, report };
}
