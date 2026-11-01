/**
 * The question table importer: a list of questions kept in Excel, Google Sheets or any spreadsheet program, saved as a
 * workbook (.xlsx) or as CSV.
 *
 * The columns are the ones OpenStage Author reads, so one file works in both tools. The first row names them, in any order:
 *
 *     Type        MC multiple choice, MR several right, TF true or false, SA short answer, ES essay. Empty is worked out.
 *     Question    The words of the question.
 *     A to H      The answers to choose from. For SA, the answers that are accepted.
 *     Correct     MC and MR: the letters of the right answers (B, or A and C). TF: True or False. SA: not needed.
 *     Points, Feedback if right, Feedback if wrong, Category      Optional.
 *
 * The rules of the project apply to it as to every importer. A key is read only where the cell gives one. An empty Correct
 * cell, a letter that names an empty answer, a word that is not True or False, each leaves the question with no answer
 * marked and an error beside it; the question is kept, shown with its row, and repaired there. Nothing is dropped without
 * being said: a column that is not understood, a sheet that is not read, a cell that holds a formula with no stored result,
 * an Attempts column (which is a setting of the course, not part of a question), each is reported.
 *
 * Where it differs from Author on purpose: Author leaves out a row with a mistake, and here the row is kept, because a
 * question that has been left out is a question nobody sees again. Author makes one line of a question's words, and here a
 * line break in a cell is kept.
 */

import { addFindings, createQuestion, DEFAULT_POINTS, withRecomputedFindings } from "../model/create.ts";
import { finding, FindingCode, type Finding, type Severity } from "../model/findings.ts";
import { localId } from "../model/ids.ts";
import { plainToRich } from "../model/richtext.ts";
import type { Feedback, Question, QuestionBody } from "../model/question.ts";
import type { TableFile, TableRow, TableSheet } from "./table.ts";
import { decodeTableText, parseDelimited, readCsv } from "./table-csv.ts";
import { readXlsx } from "./table-xlsx.ts";
import { countVerdicts, type Importer, type ImportOptions, type ImportResult, type Orphan, type SourceBlock } from "./types.ts";

export const SPREADSHEET_PROFILE_ID = "spreadsheet";

const LETTERS = "ABCDEFGH";
const MAX_ANSWERS = LETTERS.length;
/** How far down a sheet the row of column names may be. Above it there may be a title. */
const HEADER_SEARCH = 10;

// ---------------------------------------------------------------------------
// The columns
// ---------------------------------------------------------------------------

type Column = "type" | "question" | "correct" | "points" | "attempts" | "right" | "wrong" | "general" | "category" | `a${number}`;

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const NAMES: Record<string, Column> = {
  type: "type", questiontype: "type", kind: "type",
  question: "question", questiontext: "question", text: "question", prompt: "question", stem: "question",
  correct: "correct", correctanswer: "correct", correctanswers: "correct", answer: "correct", key: "correct", rightanswer: "correct", answerkey: "correct",
  points: "points", score: "points", weight: "points",
  attempts: "attempts", tries: "attempts", attemptsallowed: "attempts",
  feedbackifright: "right", rightfeedback: "right", correctfeedback: "right", feedbackcorrect: "right", feedbackright: "right", ifright: "right", ifcorrect: "right", feedbackifcorrect: "right",
  feedbackifwrong: "wrong", wrongfeedback: "wrong", incorrectfeedback: "wrong", feedbackincorrect: "wrong", feedbackwrong: "wrong", ifwrong: "wrong", ifincorrect: "wrong", feedbackifincorrect: "wrong",
  explanation: "general", rationale: "general", generalfeedback: "general", feedback: "general",
  category: "category", categoryname: "category", topic: "category",
};
for (let i = 0; i < MAX_ANSWERS; i++) {
  const l = (LETTERS[i] as string).toLowerCase();
  for (const name of [l, `answer${l}`, `choice${l}`, `answerchoice${l}`, `option${l}`, `response${l}`]) NAMES[name] = `a${i}` as Column;
}

/** The order of the columns when the first row is not a row of names: the template's, with room for five answers. */
const DEFAULT_ORDER: Column[] = ["type", "question", "a0", "a1", "a2", "a3", "a4", "correct", "points", "right", "wrong"];

/** What the template calls the columns, for the lines shown beside a file that has no names of its own. */
const TEMPLATE_NAMES: Record<string, string> = { type: "Type", question: "Question", correct: "Correct", points: "Points", right: "Feedback if right", wrong: "Feedback if wrong" };

type Kind = "mc" | "mr" | "tf" | "sa" | "essay";

const TYPE_CODES: Record<string, Kind> = {
  mc: "mc", mcq: "mc", multiplechoice: "mc", choice: "mc", single: "mc",
  mr: "mr", ma: "mr", ms: "mr", mrq: "mr", multipleresponse: "mr", multipleanswer: "mr", multipleselect: "mr", selectall: "mr", checkbox: "mr",
  tf: "tf", truefalse: "tf", trueorfalse: "tf", tof: "tf",
  sa: "sa", shortanswer: "sa", fillin: "sa", fib: "sa", typed: "sa",
  es: "essay", essay: "essay", longanswer: "essay",
};

const TRUE_WORDS = new Set(["true", "t", "yes", "y", "1"]);
const FALSE_WORDS = new Set(["false", "f", "no", "n", "0"]);

/** A column named "Question #" or "Question No." numbers the questions; it is not their words. */
function columnOf(cell: string): Column | null {
  if (cell.includes("#")) return null;
  return NAMES[squash(cell)] ?? null;
}

/**
 * Does this row name the columns? It does if one of its cells names the question column. Below the first row of a sheet it
 * also has to name another column, because a note or an instruction can have the word Question in it, and a row of prose
 * that does must not be taken for the names of the columns.
 */
function isHeader(cells: readonly string[], first = true): boolean {
  const named = cells.map(columnOf);
  return named.includes("question") && (first || named.filter((c) => c !== null).length >= 2);
}

interface Header {
  order: (Column | null)[];
  /** The names of columns that were not understood, or that repeat one that was. */
  unused: string[];
  repeated: string[];
}

function readHeader(cells: readonly string[]): Header {
  const seen = new Set<Column>();
  const unused: string[] = [];
  const repeated: string[] = [];
  const order = cells.map((cell) => {
    const column = columnOf(cell);
    if (column === null) {
      if (cell !== "") unused.push(cell);
      return null;
    }
    if (seen.has(column)) {
      repeated.push(cell);
      return null;
    }
    seen.add(column);
    return column;
  });
  return { order, unused, repeated };
}

/**
 * Whether the start of a text file is a question table: its first row names a question column and a place for the answers.
 * Used to choose this importer for a file that is only called .txt, which Excel's "Unicode Text" is.
 */
export function looksLikeQuestionTable(bytes: Uint8Array): boolean {
  let text: string;
  try {
    text = decodeTableText(bytes.subarray(0, 400_000)).text;
  } catch {
    return false;
  }
  const { rows } = parseDelimited(text, 3);
  const first = rows[0];
  if (!first || !isHeader(first.cells)) return false;
  const columns = new Set(first.cells.map(columnOf));
  return columns.has("correct") || columns.has("a0") || columns.has("a1");
}

// ---------------------------------------------------------------------------
// One row to one question
// ---------------------------------------------------------------------------

interface Ctx {
  file: string;
  at: string;
  author: string;
  profile: string;
}

const isTrue = (s: string): boolean => TRUE_WORDS.has(s.trim().toLowerCase());
const isFalse = (s: string): boolean => FALSE_WORDS.has(s.trim().toLowerCase());

/** A cell's words with its line breaks kept and the spaces on each line tidied. */
function words(cell: string): string {
  return cell
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .trim();
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * The answers a Correct cell names, as positions among the answers that are filled in. The cell may hold letters ("B",
 * "A, C", "A and C", "A/C") or the text of an answer. A letter that names an empty answer is a mistake, and so is anything
 * else: nothing is guessed at.
 */
function positionsNamed(cell: string, letterOf: readonly number[], answers: readonly string[]): { positions: number[] } | { bad: string } {
  const whole = cell.trim();
  const single = /^[A-Ha-h]$/.test(whole);
  if (!single) {
    // The whole cell may be the words of one answer, which may have spaces and commas in it.
    const exact = answers.findIndex((a) => a.toLowerCase() === whole.toLowerCase());
    if (exact !== -1) return { positions: [exact] };
  }
  const positions: number[] = [];
  for (const token of whole.split(/[,;|/]|\s+and\s+|\s+/i).map((t) => t.trim()).filter((t) => t !== "")) {
    let at = -1;
    if (/^[A-Ha-h]$/.test(token)) at = letterOf.indexOf(token.toUpperCase().charCodeAt(0) - 65);
    if (at === -1 && !/^[A-Ha-h]$/.test(token)) at = answers.findIndex((a) => a.toLowerCase() === token.toLowerCase());
    if (at === -1) return { bad: token };
    if (!positions.includes(at)) positions.push(at);
  }
  return { positions: positions.sort((x, y) => x - y) };
}

function build(row: TableRow, order: readonly (Column | null)[], line: number, ctx: Ctx): { question?: Question; orphan?: Orphan } {
  const source = { file: ctx.file, firstBlock: line, lastBlock: line };
  const get = (column: Column): string => {
    const at = order.indexOf(column);
    return at === -1 ? "" : (row.cells[at] ?? "");
  };

  const stem = words(get("question"));
  if (stem === "") {
    return {
      orphan: {
        source,
        text: row.cells.filter((c) => c !== "").join(" | "),
        reason: "This row has no question text, so it was not read as a question.",
      },
    };
  }

  const findings: Finding[] = [];
  const note = (code: string, severity: Severity, message: string): void => void findings.push(finding(code, severity, message));

  const typeCell = get("type").trim();
  const correctCell = get("correct").trim();
  const answerCells = Array.from({ length: MAX_ANSWERS }, (_, i) => words(get(`a${i}` as Column)));
  const letterOf: number[] = [];
  const answers: string[] = [];
  answerCells.forEach((a, i) => {
    if (a === "") return;
    letterOf.push(i);
    answers.push(a);
  });
  const quotedAnswers = (): string => answers.map((a, i) => `${LETTERS[letterOf[i] as number]}: ${a}`).join("; ");

  // The type: as the cell says, or from what the row holds when it says nothing. A type that is stated is believed.
  const code = squash(typeCell);
  let kind: Kind;
  if (code === "") {
    if (answers.length >= 2) kind = "mc";
    else if (answers.length === 0 && correctCell !== "" && (isTrue(correctCell) || isFalse(correctCell))) {
      kind = "tf";
      note(FindingCode.TypeInferred, "info", `The Type cell is empty, and the Correct cell says ${correctCell}, so this was read as a true or false question.`);
    } else {
      kind = "essay";
      note(
        FindingCode.TypeInferred,
        "warn",
        `The Type cell is empty and there are fewer than two answers, so this was kept as an essay. Give it a Type (MC, MR, TF, SA) if it is something else.${
          correctCell !== "" || answers.length > 0 ? ` Nothing was used from the Correct cell${correctCell !== "" ? ` ("${correctCell}")` : ""}${answers.length > 0 ? ` or the answer ${quotedAnswers()}` : ""}.` : ""
        }`,
      );
    }
  } else if (TYPE_CODES[code]) kind = TYPE_CODES[code] as Kind;
  else {
    kind = "essay";
    note(
      FindingCode.UnsupportedType,
      "error",
      `The type "${typeCell}" is not one OpenAssess reads from a table. Use MC (multiple choice), MR (several right), TF (true or false), SA (short answer) or ES (essay). The question is kept as an essay so that its text is not lost${
        answers.length > 0 || correctCell !== "" ? `; the answers and the Correct cell were not used (${[quotedAnswers(), correctCell !== "" ? `Correct: ${correctCell}` : ""].filter((s) => s !== "").join("; ")})` : ""
      }.`,
    );
  }

  let type: Question["type"];
  let body: QuestionBody;

  if (kind === "mc" || kind === "mr") {
    let marked: number[] = [];
    if (correctCell !== "") {
      const named = positionsNamed(correctCell, letterOf, answers);
      if ("bad" in named) {
        const filled = letterOf.map((i) => LETTERS[i]).join(", ");
        note(FindingCode.KeyLetterMissing, "error", `"${named.bad}" in the Correct cell is not one of the answers${filled ? ` (the answers filled in are ${filled})` : ""}. No answer is marked.`);
      } else marked = named.positions;
    } else note(FindingCode.KeyLetterMissing, "info", "The Correct cell is empty, so no answer is marked.");
    if (kind === "mc" && code === "" && marked.length > 1) {
      kind = "mr";
      note(FindingCode.MoreThanOneRight, "warn", `The Correct cell names ${marked.map((p) => LETTERS[letterOf[p] as number]).join(", ")}, and the Type cell is empty, so this is read as a multiple response. Check that it is.`);
    }
    // A gap between filled answers: the Correct letters still mean the columns, and the gap is said.
    const gaps = LETTERS.slice(0, letterOf.length === 0 ? 0 : (letterOf[letterOf.length - 1] as number) + 1)
      .split("")
      .filter((_, i) => !letterOf.includes(i));
    if (gaps.length > 0) {
      note(FindingCode.OptionLetterGap, "warn", `${gaps.length === 1 ? `Answer ${gaps[0]} is` : `Answers ${gaps.join(", ")} are`} empty, so ${gaps.length === 1 ? "it was" : "they were"} left out. The letters in the Correct cell still mean the columns.`);
    }
    const texts = [...answers];
    if (texts.length < 2) {
      note(FindingCode.TooFewOptions, "error", `A ${kind === "mr" ? "multiple response" : "multiple choice"} question needs at least two answers, and this has ${texts.length}. A placeholder was added; write the answers in.`);
      while (texts.length < 2) texts.push("(missing)");
    }
    const options = texts.map((text, i) => ({ id: localId("o", i), content: plainToRich(text), correct: marked.includes(i) }));
    if (kind === "mr") {
      type = "multipleResponse";
      body = { shuffle: true, partialCredit: true, options };
    } else {
      type = "multipleChoice";
      body = { shuffle: true, options };
    }
  } else if (kind === "tf") {
    type = "trueFalse";
    let value: boolean | undefined;
    let said = correctCell;
    // True and False written in the answer columns, and the Correct cell naming one by its letter: the answer is the word.
    if (/^[A-Ha-h]$/.test(correctCell)) {
      const at = letterOf.indexOf(correctCell.toUpperCase().charCodeAt(0) - 65);
      if (at !== -1 && (isTrue(answers[at] as string) || isFalse(answers[at] as string))) said = answers[at] as string;
    }
    if (isTrue(said)) value = true;
    else if (isFalse(said)) value = false;
    else if (correctCell !== "") note(FindingCode.KeyLetterMissing, "error", `The Correct cell says "${correctCell}", which is not True or False. No answer is marked.`);
    else note(FindingCode.KeyLetterMissing, "info", "The Correct cell is empty, so neither True nor False is marked.");
    const plain = answers.every((a) => isTrue(a) || isFalse(a)) && answers.length <= 2;
    if (answers.length > 0 && !plain) note(FindingCode.UnreadContent, "warn", `A true or false question has no answers of its own, so the answer cells were not used (${quotedAnswers()}).`);
    body = value === undefined ? {} : { correct: value };
  } else if (kind === "sa") {
    type = "shortAnswer";
    let accepted = answers;
    if (accepted.length === 0) accepted = correctCell.split("|").map((s) => s.trim()).filter((s) => s !== "");
    else if (correctCell !== "") note(FindingCode.UnreadContent, "warn", `The answers that are accepted are in the answer cells, so the Correct cell was not used ("${correctCell}").`);
    if (accepted.length === 0) note(FindingCode.KeyLetterMissing, "info", "The answer cells and the Correct cell are all empty, so no answer is accepted.");
    body = { caseSensitive: false, accepted };
  } else {
    type = "essay";
    body = {};
    if (code !== "" && TYPE_CODES[code] === "essay" && (answers.length > 0 || correctCell !== "")) {
      note(FindingCode.UnreadContent, "warn", `An essay has no key, so the answer and Correct cells were not used (${[quotedAnswers(), correctCell !== "" ? `Correct: ${correctCell}` : ""].filter((s) => s !== "").join("; ")}).`);
    }
  }

  // Points, the one number in a row that belongs to the question.
  let points = DEFAULT_POINTS;
  const pointsCell = get("points").trim();
  if (pointsCell !== "") {
    const n = Number(pointsCell.replace(",", "."));
    if (Number.isFinite(n) && n >= 0) points = n;
    else note(FindingCode.PointsAssumed, "warn", `The Points cell says "${pointsCell}", which is not a number from 0, so ${DEFAULT_POINTS} point was used.`);
  }

  const feedback: Feedback = {};
  if (get("right").trim() !== "") feedback.correct = plainToRich(words(get("right")));
  if (get("wrong").trim() !== "") feedback.incorrect = plainToRich(words(get("wrong")));
  if (get("general").trim() !== "") feedback.general = plainToRich(words(get("general")));

  const category = words(get("category")).replace(/\s+/g, " ");
  const made = createQuestion({
    type,
    stem: plainToRich(stem),
    body,
    feedback,
    points,
    metadata: { status: "draft", tags: category !== "" ? [category] : [] },
    by: ctx.author,
    at: ctx.at,
    origin: { kind: "import", source, profile: ctx.profile, at: ctx.at },
  });
  return { question: withRecomputedFindings(addFindings(made, findings)) };
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

/** A line of the source shown beside a question: the row, with each cell under its column's name. */
function lineOf(row: TableRow, names: readonly string[]): string {
  const parts = row.cells.map((cell, i) => (cell === "" ? "" : `${names[i] || columnName(i)}: ${cell.replace(/\n/g, " ↵ ")}`)).filter((p) => p !== "");
  return `Row ${row.number}: ${parts.join(" | ")}`;
}

/** The name a spreadsheet gives the column in this position: A, B, ... Z, AA. */
function columnName(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

interface SheetPlan {
  sheet: TableSheet;
  headerAt: number;
  order: (Column | null)[];
  names: string[];
  header?: Header;
}

/** Which sheets hold questions, and where each one's row of names is. */
function plan(file: TableFile): { read: SheetPlan[]; skipped: TableSheet[]; headerless: boolean } {
  const withRows = file.sheets.filter((s) => s.rows.length > 0);
  const named: SheetPlan[] = [];
  for (const sheet of withRows) {
    const at = sheet.rows.slice(0, HEADER_SEARCH).findIndex((r, i) => isHeader(r.cells, i === 0));
    if (at !== -1) {
      const header = readHeader((sheet.rows[at] as TableRow).cells);
      named.push({ sheet, headerAt: at, order: header.order, names: (sheet.rows[at] as TableRow).cells, header });
    }
  }
  if (named.length > 0) return { read: named, skipped: withRows.filter((s) => !named.some((p) => p.sheet === s)), headerless: false };
  const first = withRows[0];
  if (!first) return { read: [], skipped: [], headerless: false };
  // No row names the columns. The template's order is assumed only for a file that starts the way the template's rows do, with
  // a type in the first cell. Any other table is a layout nobody has told this, and reading it in the template's order would
  // put one column's words in another's place, and perhaps a key where there was none.
  if (!first.rows.slice(0, 3).some((r) => TYPE_CODES[squash(r.cells[0] ?? "")] !== undefined)) {
    return { read: [], skipped: withRows, headerless: true };
  }
  return {
    read: [{ sheet: first, headerAt: -1, order: DEFAULT_ORDER, names: DEFAULT_ORDER.map((c) => (/^a\d$/.test(c) ? (LETTERS[Number(c.slice(1))] as string) : (TEMPLATE_NAMES[c] ?? c))) }],
    skipped: withRows.slice(1),
    headerless: true,
  };
}

function importTable(file: TableFile, options: ImportOptions): ImportResult {
  const ctx: Ctx = { file: options.file ?? "questions.xlsx", at: options.at ?? new Date().toISOString(), author: options.author ?? "import", profile: options.profile ?? SPREADSHEET_PROFILE_ID };
  const questions: Question[] = [];
  const orphans: Orphan[] = [];
  const fileFindings: Finding[] = file.notes.map((n) => finding(FindingCode.UnreadContent, n.severity, n.message));
  const lines: string[] = [];
  const say = (severity: Severity, message: string): void => void fileFindings.push(finding(FindingCode.UnreadContent, severity, message));

  const { read, skipped, headerless } = plan(file);
  if (headerless && read.length > 0) {
    say("warn", "No row names the columns (none has a cell called Question), so they were read in the order of the template: Type, Question, A to E, Correct, Points, Feedback if right, Feedback if wrong. Check that this is your order.");
  } else if (headerless) {
    say("warn", "No row names the columns, and the first cells are not question types, so the layout is not known and nothing was read. Put a first row in with a cell called Question and the names of the other columns (Type, A, B, C, D, Correct), as in the blank table.");
  }
  for (const sheet of headerless && read.length === 0 ? [] : skipped) {
    const start = (sheet.rows[0] as TableRow).cells.filter((c) => c !== "").slice(0, 3).join(" | ");
    // A sheet of notes (a line or two of prose, as the blank table's "How to fill it in") is said and not warned about; one that
    // is laid out as a table might hold questions under names that were not understood, so it is a warning.
    const tableLike = sheet.rows.length >= 3 && sheet.rows.some((r) => r.cells.filter((c) => c !== "").length >= 3);
    say(tableLike ? "warn" : "info", `The sheet "${sheet.name}" was not read: it has ${plural(sheet.rows.length, "row", "rows")}, and none of its first rows names a Question column. It starts: ${start}`);
  }

  const unused = new Set<string>();
  const repeated: string[] = [];
  let attemptsColumn = false;
  let hiddenRows = 0;
  let hiddenSheets = 0;

  for (const p of read) {
    const label = file.kind === "xlsx" && p.sheet.name !== "" ? p.sheet.name : "";
    if (label !== "" && read.length > 1) lines.push(`Sheet: ${label}`);
    for (const u of p.header?.unused ?? []) unused.add(u);
    for (const r of p.header?.repeated ?? []) repeated.push(r);
    if (p.order.includes("attempts")) attemptsColumn = true;
    hiddenRows += p.sheet.hiddenRows;
    if (p.sheet.hidden) hiddenSheets++;

    p.sheet.rows.forEach((row, i) => {
      const lineIndex = lines.length;
      // The row of names is shown as the file wrote it, and a data row under the names it falls under.
      lines.push(i === p.headerAt ? `Row ${row.number}: ${row.cells.filter((c) => c !== "").join(" | ")}` : lineOf(row, p.names));
      if (i === p.headerAt) return;
      if (i < p.headerAt) {
        orphans.push({ source: { file: ctx.file, firstBlock: lineIndex, lastBlock: lineIndex }, text: row.cells.filter((c) => c !== "").join(" | "), reason: "This row is above the row that names the columns, so it was not read as a question." });
        return;
      }
      const built = build(row, p.order, lineIndex, ctx);
      if (built.question) questions.push(built.question);
      if (built.orphan) orphans.push(built.orphan);
    });
  }

  if (unused.size > 0) say("warn", `These columns were not used: ${[...unused].join(", ")}. ${unused.size === 1 ? "Its" : "Their"} contents are not in the questions.`);
  if (repeated.length > 0) say("warn", `${repeated.length === 1 ? "A column" : "Columns"} named ${repeated.join(", ")} repeat${repeated.length === 1 ? "s" : ""} one already read, and ${repeated.length === 1 ? "was" : "were"} not used.`);
  if (attemptsColumn) say("info", "The Attempts column was not used. Attempts are set by the course that uses a question, not stored in the question.");
  if (hiddenRows > 0) say("info", `${plural(hiddenRows, "row is", "rows are")} hidden in the workbook (by a filter or by hand). ${hiddenRows === 1 ? "It was" : "They were"} read all the same.`);
  if (hiddenSheets > 0) say("info", `${plural(hiddenSheets, "sheet is", "sheets are")} hidden in the workbook. ${hiddenSheets === 1 ? "It was" : "They were"} read all the same.`);
  if (questions.length === 0 && orphans.length === 0) {
    say("warn", "No question was found in this file. A question table has a row of column names, with one called Question, and a row for each question.");
  }

  return { profile: ctx.profile, file: ctx.file, questions, orphans, counts: countVerdicts(questions, orphans.length), fileFindings, sourceLines: lines };
}

function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

/** Whether the start of a file reads as text, so that a CSV given an .xlsx name is read as the CSV it is. */
function looksTextual(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 2000);
  return head.length > 0 && !head.includes(0);
}

function parseTable(bytes: Uint8Array, options: ImportOptions): ImportResult {
  // A workbook is told by what is in it, not by its name: a zip is a workbook, and a file called .xlsx that is plain text is a
  // CSV that someone renamed. What is neither (an old .xls, a PDF) is refused with a message that says what to do.
  const workbook = isZip(bytes) || (/\.xls[xm]$/i.test(options.file ?? "") && !looksTextual(bytes));
  return importTable(workbook ? readXlsx(bytes) : readCsv(bytes), options);
}

export const spreadsheetImporter: Importer = {
  id: SPREADSHEET_PROFILE_ID,
  label: "Question table (Excel or CSV)",
  extensions: [".xlsx", ".xlsm", ".csv", ".tsv"],

  /** Text is read as a CSV. */
  parse(input: string | SourceBlock[], options: ImportOptions = {}): ImportResult {
    const text = typeof input === "string" ? input : input.map((b) => b.text).join("\n");
    return parseTable(Buffer.from(text, "utf8"), { file: "questions.csv", ...options });
  },

  parseBytes: parseTable,
};
