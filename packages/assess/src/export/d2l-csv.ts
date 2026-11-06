/**
 * Export to Brightspace (D2L): the Question Library's CSV import.
 *
 * Brightspace documents this file, row by row, and this follows what it documents and no more. Each question is a run of rows
 * with a keyword in the first column. NewQuestion and its type start one (MC, TF, MS, SA, M, O or WR), QuestionText gives the
 * words, and the rows that follow give the answers: Option with 100 or 0 for a multiple choice question (and 1 or 0 for a
 * multiselect one, which Brightspace writes differently), TRUE and FALSE with 100 or 0, Answer with 100 for each short answer
 * that is accepted, Choice and Match with a number that joins them, and Item for each step of an ordering, in order. Points,
 * Scoring, Title and Feedback are optional. A line that begins // is a comment.
 *
 * What the file cannot hold is the whole of the destination check. Brightspace's CSV import does not take fill in the blank with
 * more than one blank, arithmetic, significant figures or multiple short answer, and it has no row for a hotspot or a
 * calculated question, so those are left out and said so. A short answer with one blank is written as a short answer. A question
 * with no usable answer key is never written, and no key is ever guessed to fit.
 *
 * Text is written as plain text. The one place the format says how to carry formatting is the question text, which takes HTML
 * when the third cell says HTML, and that is used when a stem has formatting; options and feedback become plain text and the
 * check says so. A picture or an equation cannot go in the file and is written into the text as a marker.
 */

import { hasUsableKey } from "../quality/answer-key.ts";
import { isChoice, isFillInBlank, isMultipleResponse, isOrdering, isShortAnswer, isTrueFalse, titleFromStem, type Question } from "../model/question.ts";
import { titleText } from "../model/table.ts";
import type { ExportResult, ReportItem } from "./types.ts";
import { buildReport, exportable, FORMATTING, hasText, htmlText, keyProblem, lossNotes, newLosses, plainText, plural, safeName, TYPE_NAMES } from "./text.ts";

export const D2L_CSV_ID = "d2l-csv";
export const D2L_CSV_LABEL = "Brightspace (D2L) Question Library, CSV";

/** Brightspace takes a point value of 1 to 100. */
const MIN_POINTS = 1;
const MAX_POINTS = 100;

type Row = [string, string, string];

const row = (a: string, b = "", c = ""): Row => [a, b, c];

/** Quoted whenever it holds a comma, a quote or a line break, or begins or ends with a space. A quote inside is doubled. */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) || /^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

const csvLine = (cells: readonly string[]): string => cells.map(csvCell).join(",");

interface Planned {
  item: ReportItem;
  rows?: Row[];
}

/** Whitespace of any kind, including a line break, as one space. */
const flat = (text: string): string => text.replace(/\s+/g, " ").trim();

function plan(question: Question, position: number): Planned {
  const base = { position, questionId: question.id, title: question.title };
  const leftOut = (why: string): Planned => ({ item: { ...base, outcome: "leftOut", notes: [why] } });

  const supported =
    isChoice(question) ||
    isMultipleResponse(question) ||
    isTrueFalse(question) ||
    isFillInBlank(question) ||
    isShortAnswer(question) ||
    isOrdering(question) ||
    question.type === "matching" ||
    question.type === "essay";
  if (!supported) {
    const name = TYPE_NAMES[question.type];
    const why =
      question.type === "numeric"
        ? "Brightspace's CSV import cannot take an arithmetic or a numeric question, so it cannot be written in it."
        : `Brightspace's CSV import has no ${name} question, so ${/^[aeiou]/.test(name) ? "an" : "a"} ${name} question cannot be written in it.`;
    return leftOut(why);
  }
  if (!hasUsableKey(question)) return leftOut(keyProblem(question, "Brightspace"));

  const losses = newLosses();
  const notes: string[] = [];
  let asType: string | undefined;

  const formatted = question.stem.format === "rich" && FORMATTING.test(question.stem.content);
  // A stem with formatting is written as HTML, which keeps its breaks, so the plain form of it is only for the check that it
  // has words; what it would have lost is not counted. A plain stem is counted as it is written.
  const stem = plainText(question.stem, question, formatted ? newLosses() : losses, false);
  if (stem === "") return leftOut("It has no question text once it is written as plain text.");

  const rows: Row[] = [];
  const questionText = (): Row => {
    if (!formatted) return row("QuestionText", stem);
    // Brightspace reads the question text as HTML when the third cell says so. A break inside would end the cell in a
    // spreadsheet program, so the markup is written on one line. A picture or an equation in it is a marker, and counted.
    const html = htmlText(question.stem, question, losses).replace(/\s*\n\s*/g, " ");
    return row("QuestionText", html, "HTML");
  };

  // A title that is only the start of the question text, which is what an untitled question is given, says nothing the text
  // does not, and Brightspace shows the text when there is no title. Only a title someone wrote is written.
  const automatic = question.title === titleFromStem(titleText(question.stem));
  const title = automatic ? "" : flat(question.title);

  // The head of every question, in the order Brightspace's own template has it.
  const head = (type: string): void => {
    rows.push(row("NewQuestion", type));
    if (title !== "") rows.push(row("Title", title));
    rows.push(questionText());
    if (Number.isInteger(question.points) && question.points >= MIN_POINTS && question.points <= MAX_POINTS) rows.push(row("Points", String(question.points)));
    else notes.push(`Its ${question.points} point${question.points === 1 ? "" : "s"} cannot be carried: Brightspace takes a whole number from ${MIN_POINTS} to ${MAX_POINTS}. It arrives with Brightspace's own default.`);
  };

  if (isChoice(question) || isMultipleResponse(question)) {
    const options = question.body.options;
    const texts = options.map((o) => plainText(o.content, question, losses, false));
    if (texts.some((t) => t === "")) return leftOut("One of its answers has no text, and Brightspace needs text in every option.");
    if (options.length < 2) return leftOut("It has fewer than two answers.");
    if (isMultipleResponse(question)) {
      head("MS");
      // The partial credit of a multiple response is Brightspace's scoring setting for the question: a share for each right
      // answer chosen and each wrong one left alone, and the same taken away for a wrong one chosen, or nothing unless all are right.
      rows.push(row("Scoring", question.body.partialCredit ? "RightMinusWrong" : "All or nothing"));
      options.forEach((o, i) => rows.push(row("Option", o.correct ? "1" : "0", texts[i] as string)));
    } else {
      head("MC");
      options.forEach((o, i) => rows.push(row("Option", o.correct ? "100" : "0", texts[i] as string)));
    }
    if (options.some((o) => o.feedback && hasText(o.feedback))) notes.push("Feedback on a single answer cannot be carried: the file has one feedback entry for a question.");
    if (!question.body.shuffle || options.some((o) => o.fixedPosition)) {
      notes.push("This question keeps its answers in a fixed order, and the file cannot say so. Brightspace's own setting for mixing the answers applies.");
    }
  } else if (isTrueFalse(question)) {
    if (typeof question.body.correct !== "boolean") return leftOut("Neither True nor False is marked, and nothing is guessed.");
    head("TF");
    rows.push(row("TRUE", question.body.correct ? "100" : "0"));
    rows.push(row("FALSE", question.body.correct ? "0" : "100"));
  } else if (isFillInBlank(question) || isShortAnswer(question)) {
    let accepted: string[];
    let caseSensitive: boolean;
    if (isFillInBlank(question)) {
      if (question.body.blanks.length !== 1) {
        return leftOut(`It has ${question.body.blanks.length} blanks, and Brightspace's CSV import takes neither a fill in the blank nor a multiple short answer.`);
      }
      accepted = (question.body.blanks[0] as { accepted: string[] }).accepted;
      caseSensitive = question.body.caseSensitive;
      asType = "short answer";
      notes.push("A fill in the blank is written as a short answer, because the file cannot say where in the text the blank is. The text still has the blank in it.");
    } else {
      accepted = question.body.accepted;
      caseSensitive = question.body.caseSensitive;
    }
    const cleaned = [...new Set(accepted.map(flat).filter((a) => a !== ""))];
    if (cleaned.length === 0) return leftOut("It has no accepted answer, and nothing is guessed.");
    head("SA");
    for (const a of cleaned) rows.push(row("Answer", "100", a));
    if (caseSensitive) notes.push("Upper and lower case count in this question, and the file cannot say so. Brightspace's own setting for a short answer applies.");
  } else if (isOrdering(question)) {
    const items = [...question.body.items].sort((a, b) => a.position - b.position);
    const texts = items.map((it) => plainText(it.content, question, losses, false));
    if (texts.some((t) => t === "")) return leftOut("One of its items has no text, and nothing is guessed to fill it.");
    if (items.length < 2) return leftOut("It has fewer than two items to put in order.");
    head("O");
    // The items are written in the right order. The text of an item goes in the second cell, as Brightspace's guide says.
    for (const t of texts) rows.push(row("Item", t));
  } else if (question.type === "matching") {
    const body = question.body as { pairs: Array<{ left: Parameters<typeof plainText>[0]; right: string }>; distractors?: string[] };
    if (body.pairs.length < 2) return leftOut(`It has ${body.pairs.length} pair${body.pairs.length === 1 ? "" : "s"}, and a matching question needs at least two.`);
    const pairs = body.pairs.map((p) => ({ left: plainText(p.left, question, losses, false), right: flat(p.right) }));
    if (pairs.some((p) => p.left === "" || p.right === "")) return leftOut("One of its pairs has nothing on one side, and nothing is guessed to fill it.");
    head("M");
    pairs.forEach((p, i) => rows.push(row("Choice", String(i + 1), p.left)));
    pairs.forEach((p, i) => rows.push(row("Match", String(i + 1), p.right)));
    const spare = (body.distractors ?? []).filter((d) => d.trim() !== "").length;
    if (spare > 0) notes.push(`${plural(spare, "spare answer", "spare answers")} cannot be carried: a match in the file belongs to a choice, and a spare one belongs to none. The question is easier without ${spare === 1 ? "it" : "them"}.`);
  } else {
    // An essay is a written response.
    head("WR");
    const body = question.body as { modelAnswer?: Parameters<typeof plainText>[0]; rubric?: unknown[]; expectedWords?: number };
    if (body.modelAnswer && hasText(body.modelAnswer)) notes.push("The model answer cannot be carried: it is not among the entries Brightspace documents for a CSV file.");
    if ((body.rubric ?? []).length > 0) notes.push("The rubric cannot be carried: a Brightspace rubric is made in Brightspace.");
    if (typeof body.expectedWords === "number") notes.push("The expected length cannot be carried.");
  }

  // The feedback: Brightspace's file has one entry for a question, which is the general note.
  if (question.feedback.general && hasText(question.feedback.general)) {
    rows.push(row("Feedback", plainText(question.feedback.general, question, losses, false)));
  }
  if ((question.feedback.correct && hasText(question.feedback.correct)) || (question.feedback.incorrect && hasText(question.feedback.incorrect))) {
    notes.push("Feedback for a right answer and for a wrong one cannot be carried: the file has one feedback entry for a question.");
  }

  if (formatted) notes.push("The question text keeps its formatting. The answers and the feedback become plain text.");
  else if (losses.formatting) notes.push("Bold, italics, lists or tables in the answers or the feedback became plain text.");
  if (losses.breaks) notes.push("Paragraph breaks became spaces.");
  notes.push(...lossNotes(losses, "Brightspace"));

  return { item: { ...base, outcome: notes.length > 0 ? "exportedWithLosses" : "exported", ...(asType ? { asType } : {}), notes }, rows };
}

export interface D2lCsvOptions {
  /** What to call the file. Usually the bank's title. */
  name?: string;
}

/** The destination check on its own: what would arrive, what would be lost, what cannot go. */
export function checkD2lCsv(questions: readonly Question[], options: D2lCsvOptions = {}): ExportResult["report"] {
  return exportD2lCsv(questions, options).report;
}

/** The destination check, and the file to write. */
export function exportD2lCsv(questions: readonly Question[], options: D2lCsvOptions = {}): ExportResult {
  questions = exportable(questions);
  const items: ReportItem[] = [];
  // The comment has no comma or quote in it: a cell that needed quoting would begin with a quote mark, and a reader that looks
  // for // at the start of the line would not see it.
  const rows: Row[] = [row("// Written by OpenAssess for the Brightspace Question Library (Import then Upload a File)")];
  let written = 0;
  questions.forEach((question, i) => {
    const planned = plan(question, i + 1);
    items.push(planned.item);
    if (planned.rows) {
      rows.push(...planned.rows);
      written++;
    }
  });

  const file = `${safeName(options.name)} - Brightspace.csv`;
  // UTF-8 with no byte order mark: a mark would sit in front of the first cell of the file, which is a keyword.
  const content = rows.map(csvLine).join("\r\n") + "\r\n";

  const general = [
    "In Brightspace: Quizzes (or Surveys, or Self Assessments), then Question Library, then Import, then Upload a File. The questions arrive in the library, and you move them into a section afterwards: this file cannot put them in one.",
    "Brightspace's CSV import takes multiple choice, multiselect, true or false, short answer, matching, ordering and written response questions.",
    "Difficulty, tags, objectives and history are not part of the file. Images are not carried.",
  ];
  const report = buildReport(D2L_CSV_ID, D2L_CSV_LABEL, questions.length, items, written > 0 ? [file] : [], general);
  return { files: written > 0 ? [{ name: file, content, questions: written }] : [], report };
}
