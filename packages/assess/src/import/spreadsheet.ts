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
import { isBlankText, plainToRich } from "../model/richtext.ts";
import { shuffledFor } from "../model/random.ts";
import { dependsOnPlace } from "../model/test.ts";
import type { Feedback, Metadata, Question, QuestionBody } from "../model/question.ts";
import type { TableFile, TableRow, TableSheet } from "./table.ts";
import { bloomOf, difficultyOf } from "./metadata-words.ts";
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

type Column = "type" | "question" | "id" | "chapter" | "section" | "objective" | "page" | "bloom" | "difficulty" | "tags" | "correct" | "rightText" | "points" | "attempts" | "right" | "wrong" | "general" | "category" | `a${number}` | `w${number}`;

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A table looked up by a word from the file: only its own entries, so a word that is the name of a property every object has ("constructor") is not found. */
const own = <T>(table: Record<string, T>, key: string): T | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

/**
 * A table made for two languages names a column for each ("question_english", "question_french"). The language is not part of
 * what the column is, so it is taken off the name; the second column of a kind then repeats the first, and is reported as
 * not used, which says what was left out. Only whole language names after a separator count: "Question English" is a column
 * for English, and a column called "Penguin" or "Spanish Inquisition essay" is not touched.
 */
const LANGUAGES = "english|french|spanish|german|italian|portuguese|dutch|swedish|norwegian|danish|finnish|polish|czech|russian|greek|turkish|arabic|hebrew|hindi|chinese|japanese|korean|welsh|irish|latin";
const LANGUAGE_SUFFIX = new RegExp(`(?<=[a-z0-9])[\\s_\\-.(]+(?:${LANGUAGES})\\)?\\s*$`, "i");

const NAMES: Record<string, Column> = {
  type: "type", questiontype: "type", kind: "type",
  id: "id", questionid: "id", itemid: "id", qid: "id", questionidentifier: "id", itemidentifier: "id",
  question: "question", questiontext: "question", text: "question", prompt: "question", stem: "question",
  correct: "correct", correctanswer: "correct", correctanswers: "correct", answer: "correct", key: "correct", rightanswer: "correct", answerkey: "correct",
  points: "points", score: "points", weight: "points",
  attempts: "attempts", tries: "attempts", attemptsallowed: "attempts",
  feedbackifright: "right", rightfeedback: "right", correctfeedback: "right", feedbackcorrect: "right", feedbackright: "right", ifright: "right", ifcorrect: "right", feedbackifcorrect: "right",
  feedbackifwrong: "wrong", wrongfeedback: "wrong", incorrectfeedback: "wrong", feedbackincorrect: "wrong", feedbackwrong: "wrong", ifwrong: "wrong", ifincorrect: "wrong", feedbackifincorrect: "wrong",
  explanation: "general", rationale: "general", generalfeedback: "general", feedback: "general",
  category: "category", categoryname: "category", topic: "category",
  // What a bank is organised by. A column of these is the question's own field, so Coverage and a blueprint can use it.
  chapter: "chapter", chap: "chapter",
  section: "section", sec: "section",
  objective: "objective", objectives: "objective", learningobjective: "objective", learningobjectives: "objective", lo: "objective", obj: "objective",
  page: "page", pages: "page", pagereference: "page",
  bloom: "bloom", blooms: "bloom", bloomlevel: "bloom", bloomslevel: "bloom", bloomstaxonomy: "bloom", cognitivelevel: "bloom",
  difficulty: "difficulty", difficultylevel: "difficulty", diff: "difficulty",
  tags: "tags", tag: "tags", keywords: "tags",
  // Names a table is often given that mean a column already known.
  questions: "question", questionstem: "question",
  qtype: "type",
  marks: "points", mark: "points", point: "points",
  ans: "correct", correctoption: "correct", correctchoice: "correct", rightoption: "correct", rightchoice: "correct", correctresponse: "correct",
};
for (let i = 0; i < MAX_ANSWERS; i++) {
  const l = (LETTERS[i] as string).toLowerCase();
  for (const name of [l, `answer${l}`, `choice${l}`, `answerchoice${l}`, `option${l}`, `response${l}`]) NAMES[name] = `a${i}` as Column;
  // The same columns numbered from 1 ("Option 1", "Answer 3"), which is how many tables name them. A bare number is not a name.
  for (const name of [`answer${i + 1}`, `choice${i + 1}`, `answerchoice${i + 1}`, `option${i + 1}`, `answeroption${i + 1}`, `response${i + 1}`]) NAMES[name] = `a${i}` as Column;
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

/**
 * "Incorrect answer 2", "Wrong option 3", "Distractor 1": a column for one wrong answer. The numbers count from 1 and are the
 * order of the answers; a number past the last answer column is not understood (and so is reported as not used).
 */
const WRONG_ANSWER = /^(?:(?:incorrect|wrong|distractor|distracter)(?:answer|option|choice|response)?|(?:answer|option|choice|response)(?:incorrect|wrong))(\d+)$/;

/** A column named "Question #" or "Question No." numbers the questions; it is not their words. */
function columnOf(cell: string): Column | null {
  if (cell.includes("#")) return null;
  return columnNamed(nameUsed(cell));
}

/**
 * The words of a header cell that name its column. Usually the whole cell. A name with a description after it, as a template for a quiz
 * game writes its columns ("Question - max 95 characters", "Answer 1 - max 60 characters", "Correct answer(s) - choose at least one"), is
 * its name without the description, tried only when the whole of the cell is not a name, so that a name that is meant ("Feedback - if
 * right" is not "Feedback") is never cut short. A bracket of a letter or a number ("Option (A)") is not a description.
 *
 * What follows must be an instruction about filling the column in (INSTRUCTION), and nothing else is cut. A description that says
 * something about the column ("Answer - wrong", "Answer (incorrect)", "Feedback - when right", "Answer - hint") changes what it is, and
 * cutting it read the wrong-answer column as the Correct one, which marked a wrong option right in a question that read as parsed.
 * A cell that is not cut is a column that is not understood, which is said, and nothing is guessed from it.
 */
function nameUsed(cell: string): string {
  if (columnNamed(cell) !== null) return cell;
  // Plain scans only, with no pattern that can backtrack: a cell may be 32,767 characters and a table's first rows are all tried.
  const one = cell.replace(/\s+/g, " ").trim();
  // Every way of cutting a description off that leaves a name, and the longest of them, which keeps most of what the cell said:
  // "Answer - 4 - max 60 characters" is "Answer - 4" (the fourth answer) and not "Answer" (the key), which the first dash alone would give.
  let best: string | null = null;
  for (const [shorter, description] of cuts(one)) {
    const column = shorter === "" ? null : columnNamed(shorter);
    if (column === null) continue;
    // A bare "Answer" is the key, and also the words of an answer: "Answer - max 60 characters" limits a text, so it is not the key. A cut
    // that lands on the key by one of those bare words needs a description about choosing. "Correct answer" and "Right answer" are not
    // ambiguous, and were refused with it ("Correct answer - max 60 characters" read as the key before, and is the key again).
    if (column === "correct" && BARE_KEY_NAMES.has(squash(shorter.replace(LANGUAGE_SUFFIX, ""))) && !CHOOSES.test(description)) continue;
    if (best === null || shorter.length > best.length) best = shorter;
  }
  return best ?? cell;
}

const CHOOSES = /\b(?:choose|select|pick)\b/i;
/** The names of the key column that are also what a column of answer text may be called. */
const BARE_KEY_NAMES: ReadonlySet<string> = new Set(["answer", "ans", "key"]);

/**
 * The only words a description may be made of: a limit or an instruction for filling a column in, and nothing about what the column holds
 * (no right, wrong, correct, incorrect, true, false, hint, feedback, explanation). Every word of the description has to be one of these or
 * a number, and one has to be a cue that it is an instruction. "choose at least one" and "max 95 characters" are; "choose the wrong
 * answers" is not, because of one word, and a description that begins like an instruction and then says what the column holds would
 * otherwise read the column of wrong answers as the key.
 */
const INSTRUCTION_WORDS: ReadonlySet<string> = new Set([
  "max", "maximum", "min", "minimum", "up", "to", "at", "most", "least", "no", "more", "fewer", "less", "than", "between", "and", "or", "of",
  "limit", "limited", "choose", "select", "pick", "enter", "required", "optional", "one", "two", "three", "four", "five", "all", "that", "apply",
  "the", "a", "an", "only", "exactly", "per", "question", "text", "characters", "chars", "words", "letters", "digits", "answer", "answers", "option", "options",
]);
const INSTRUCTION_CUES: ReadonlySet<string> = new Set(["max", "maximum", "min", "minimum", "up", "most", "least", "between", "limit", "limited", "choose", "select", "pick", "enter", "required", "optional", "characters", "chars", "words", "letters", "digits"]);

function isInstruction(description: string): boolean {
  // A letter, a number or a symbol outside ASCII is a word the list does not hold, and splitting on what is not a letter would make it
  // vanish ("Answer - max 60 ✗" and "Answer - 错误 max 60" were instructions).
  if (/[\p{L}\p{N}\p{S}]/u.test(description.replace(/[ -~]/g, ""))) return false;
  const words = description.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w !== "");
  return words.length > 0 && words.every((w) => /^\d+$/.test(w) || INSTRUCTION_WORDS.has(w)) && words.some((w) => INSTRUCTION_CUES.has(w));
}

/** How many dashes of a header cell are tried as the start of a description. A name has none or one or two; a cell of thousands is not one. */
const MOST_DASHES = 8;

/**
 * Each way of cutting a description off a header cell: at a dash with a space each side after which only an instruction follows (a dash
 * that is part of the name, "Feedback - if right - max 100 characters", is one more way, not the end of the search), or at the first
 * bracket when what is inside it is an instruction. Each is the name that is left and the description that was cut.
 */
function cuts(one: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let tried = 0;
  for (let i = nextDash(one, 1); i !== -1 && i < one.length - 1 && tried < MOST_DASHES; i = nextDash(one, i + 1)) {
    if (one[i - 1] !== " " || one[i + 1] !== " ") continue;
    tried++;
    const description = one.slice(i + 2);
    if (isInstruction(description)) out.push([one.slice(0, i - 1).trim(), description]);
  }
  const bracket = beforeBracket(one);
  if (bracket !== null) out.push(bracket);
  return out;
}

function nextDash(one: string, from: number): number {
  for (let i = from; i < one.length; i++) if (one[i] === "-" || one[i] === "\u2013" || one[i] === "\u2014") return i;
  return -1;
}

/** The name before the first bracket and what was cut, when what is inside it is an instruction, and so is what follows it if anything does. */
function beforeBracket(one: string): [string, string] | null {
  const at = one.indexOf("(");
  if (at <= 0) return null;
  const close = one.indexOf(")", at);
  const inside = close === -1 ? one.slice(at + 1) : one.slice(at + 1, close);
  const after = close === -1 ? "" : one.slice(close + 1).trim();
  // What follows the bracket may be a dash and a further instruction ("Question (required) - max 95 characters") and nothing else.
  const afterIsFine = after === "" || (nextDash(after, 0) === 0 && after[1] === " " && isInstruction(after.slice(2)));
  return isInstruction(inside) && afterIsFine ? [one.slice(0, at).trim(), one.slice(at + 1)] : null;
}

function columnNamed(cell: string): Column | null {
  const name = squash(cell.replace(LANGUAGE_SUFFIX, ""));
  const wrong = WRONG_ANSWER.exec(name);
  if (wrong) {
    const n = Number(wrong[1]);
    return n >= 1 && n < MAX_ANSWERS ? (`w${n - 1}` as Column) : null;
  }
  return own(NAMES, name) ?? null;
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
  /** Columns that were understood but cannot be used with the others (see below). */
  conflicting: string[];
  /** Every answer column is named by a number ("Option 1"), so a number in the Correct cell names one, and a letter names none. */
  numbered: boolean;
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
  // A table can say which answer is right in two ways, and they do not mix. With answer columns (A, B, C...) the Correct column
  // names a letter, or the words of one answer. With columns for the wrong answers ("Incorrect answer 1"...), the column called
  // Correct (or Correct answer) holds the words of the right answer itself, and the key is which column it stands in. If a file
  // has both kinds of answer column the wrong-answer columns are the ones left out, and said, because the letters are the
  // key the file gave. If it has wrong-answer columns and no column for the right answer, there is no key to read them with.
  const wrongAt = order.map((c, i) => (c !== null && /^w\d$/.test(c) ? i : -1)).filter((i) => i !== -1);
  const conflicting: string[] = [];
  if (wrongAt.length > 0) {
    const lettered = order.some((c) => c !== null && /^a\d$/.test(c));
    const correctAt = order.indexOf("correct");
    if (lettered || correctAt === -1) {
      for (const i of wrongAt) {
        conflicting.push(cells[i] as string);
        order[i] = null;
      }
    } else order[correctAt] = "rightText";
  }
  // Numbered only when every answer column is. A table that mixes the two ("A" and "Option 2") has no one way to say which column
  // a cell means, so its numbers are not read as places.
  const answerAt = order.map((c, i) => (c !== null && /^a\d$/.test(c) ? i : -1)).filter((i) => i !== -1);
  const numbered = answerAt.length > 0 && answerAt.every((i) => /\d$/.test(squash(nameUsed(cells[i] as string).replace(LANGUAGE_SUFFIX, ""))));
  return { order, unused, repeated, conflicting, numbered };
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
  return columns.has("correct") || columns.has("a0") || columns.has("a1") || columns.has("w0");
}

// ---------------------------------------------------------------------------
// One row to one question
// ---------------------------------------------------------------------------

interface Ctx {
  file: string;
  at: string;
  author: string;
  profile: string;
  /** In a table that puts the right answer first: how many questions had their answers mixed, and how many kept the file's order. */
  mixed: number;
  kept: number;
}

const isTrue = (s: string): boolean => TRUE_WORDS.has(s.trim().toLowerCase());
const isFalse = (s: string): boolean => FALSE_WORDS.has(s.trim().toLowerCase());

/**
 * A cell's words with its line breaks kept and the spaces on each line tidied. A cell that shows nothing (only a zero width space, a
 * control character, a soft hyphen) is an empty cell: it was kept as a stem or an answer with no words, read as parsed.
 */
function words(cell: string): string {
  const tidy = cell
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .trim();
  return isBlankText(tidy) ? "" : tidy;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * The answers a Correct cell names, as positions among the answers that are filled in. The cell may hold letters ("B",
 * "A, C", "A and C", "A/C") or the text of an answer. A letter that names an empty answer is a mistake, and so is anything
 * else: nothing is guessed at.
 */
function positionsNamed(
  cell: string,
  letterOf: readonly number[],
  answers: readonly string[],
  numbered = false,
  emptyColumns: ReadonlySet<number> = new Set(),
): { positions: number[] } | { bad: string; ambiguous?: true; empty?: true; list?: true } {
  const whole = cell.trim();
  // In a table whose answer columns are numbered ("Option 1" to "Option 4") a number names the column with that number, and a
  // letter names nothing, because no column is called by one. In a table with lettered columns it is the other way about, and a
  // number is only ever the words of an answer.
  const single = numbered ? /^\d{1,2}$/.test(whole) : /^[A-Ha-h]$/.test(whole);
  const listed = positionsListed(whole, letterOf, answers, numbered, emptyColumns);
  if (single && !numbered) {
    // A letter names the column with that letter, and it may be the words of another answer: with the answers D, A, C and B, "A" is the
    // second answer by its words and the first by its letter. The letter always won, and column A, "D", was marked without a word.
    const wordsAt = answers.findIndex((a) => a.toLowerCase() === whole.toLowerCase());
    const letterAt = letterOf.indexOf(whole.toUpperCase().charCodeAt(0) - 65);
    if (wordsAt !== -1 && letterAt !== -1 && wordsAt !== letterAt) return { bad: whole, ambiguous: true };
  }
  if (!single) {
    // The whole cell may be the words of one answer, which may have spaces and commas in it.
    const exact = answers.findIndex((a) => a.toLowerCase() === whole.toLowerCase());
    if (exact !== -1) {
      // And it may also read as a list of answers by their letters or numbers: "A, B" is the words of the second answer in a question
      // whose options are "A", "A, B" and "B", and is also the first and the third. Either could be meant, and nothing in the file says
      // which, so no answer is marked. It was read as the words, and the exporter wrote exactly this cell for a question with two right
      // answers, so one of them was lost. A list of words ("Sodium Chloride" as "Sodium" and "Chloride") is not a second reading: the
      // cell is the whole of an answer, and that is the plain one. A list that cannot be read at all because a number in it is itself
      // both a column and words, or names an empty column, is a list too, and the more ambiguous the cell the less it may be guessed.
      const listAmbiguous = "positions" in listed ? listed.positional === true && (listed.positions.length !== 1 || listed.positions[0] !== exact) : listed.ambiguous === true || listed.empty === true;
      if (listAmbiguous) return { bad: whole, ambiguous: true, list: true };
      return { positions: [exact] };
    }
  }
  return listed;
}

/** The answers a cell names when it is read as a list of letters or numbers, or of the words of answers. */
function positionsListed(
  whole: string,
  letterOf: readonly number[],
  answers: readonly string[],
  numbered: boolean,
  emptyColumns: ReadonlySet<number>,
): { positions: number[]; positional?: true } | { bad: string; ambiguous?: true; empty?: true } {
  const positions: number[] = [];
  /** Whether any token named an answer by a letter or a column number, and not by its words. */
  let positional = false;
  for (const token of whole.split(/[,;|/]|\s+and\s+|\s+/i).map((t) => t.trim()).filter((t) => t !== "")) {
    const byText = /^[A-Ha-h]$/.test(token) && !numbered ? -1 : answers.findIndex((a) => a.toLowerCase() === token.toLowerCase());
    let at = byText;
    if (numbered && /^\d{1,2}$/.test(token)) {
      // A number that names a column of the sheet which has no answer in this row says an answer that is not there. It is the same
      // mistake as a letter that names an empty answer, and it is not read as the words of another answer.
      if (emptyColumns.has(Number(token) - 1)) return { bad: token, empty: true };
      const byNumber = letterOf.indexOf(Number(token) - 1);
      // A number that is both the column's number and the words of another answer ("2" in a table of sums) could be either, and
      // nothing in the file says which: it is not guessed.
      if (byNumber !== -1 && byText !== -1 && byNumber !== byText) return { bad: token, ambiguous: true };
      at = byNumber !== -1 ? byNumber : byText;
      if (byNumber !== -1) positional = true;
    } else if (!numbered && /^[A-Ha-h]$/.test(token)) {
      at = letterOf.indexOf(token.toUpperCase().charCodeAt(0) - 65);
      positional = true;
    }
    if (at === -1) return { bad: token };
    if (!positions.includes(at)) positions.push(at);
  }
  return { positions: positions.sort((x, y) => x - y), ...(positional ? { positional: true as const } : {}) };
}

function build(row: TableRow, order: readonly (Column | null)[], line: number, ctx: Ctx, numbered = false): { question?: Question; orphan?: Orphan } {
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

  // Text in cells past the last column that has a name (or past the last column of the template's order) belongs to no column, and the
  // file-level note about columns that were not used cannot name it, because it has no header. It was dropped without a word: a data row
  // of `MC,What is 2+2?,3,4,B,SECRET EXTRA,MORE` under a header of five columns read as parsed, and a Blackboard row under a short header
  // lost every answer after the first.
  const beyond = row.cells.slice(order.length).map((c) => c.replace(/\s+/g, " ").trim()).filter((c) => !isBlankText(c));
  if (beyond.length > 0) {
    const shown = beyond.slice(0, 3).map((c) => `"${c.length > 60 ? `${c.slice(0, 59)}...` : c}"`).join(", ") + (beyond.length > 3 ? ` and ${beyond.length - 3} more` : "");
    note(FindingCode.UnreadContent, "warn", `${beyond.length === 1 ? "One cell" : `${beyond.length} cells`} after the last column that has a name hold${beyond.length === 1 ? "s" : ""} text that was not read: ${shown}. Name the column, or move the text, if it belongs in the question.`);
  }

  const typeCell = get("type").trim();
  // In a table with columns for the wrong answers, the right answer's words are in one column of its own and the key is that
  // column. It is put first among the answers, and the other columns follow in their order; there is no letter to read.
  const rightFirst = order.includes("rightText");
  const rightWords = rightFirst ? words(get("rightText")) : "";
  const correctCell = get("correct").trim(); // empty when the Correct column was read as the right answer's words (see readHeader)
  const answerCells = rightFirst
    ? [rightWords, ...Array.from({ length: MAX_ANSWERS - 1 }, (_, i) => words(get(`w${i}` as Column)))]
    : Array.from({ length: MAX_ANSWERS }, (_, i) => words(get(`a${i}` as Column)));
  const letterOf: number[] = [];
  const answers: string[] = [];
  answerCells.forEach((a, i) => {
    if (a === "") return;
    // With no letters to keep to, the answers that are filled in are A, B, C in turn, so a message names the one a person will see.
    letterOf.push(rightFirst ? answers.length : i);
    answers.push(a);
  });
  // What a message calls an answer's column: its letter, or its number when the columns are numbered.
  const nameOf = (slot: number): string => (numbered ? String(slot + 1) : (LETTERS[slot] as string));
  const quotedAnswers = (): string => answers.map((a, i) => `${nameOf(letterOf[i] as number)}: ${a}`).join("; ");
  const rightIsFirst = rightFirst && rightWords !== "";
  // A row of Blackboard's upload file read as a table: each answer is followed by the word correct or incorrect, and the words land in
  // the answer cells while the key is taken from the wrong place. The check for that file is meant to catch it first; this says so when it
  // did not, because the question would otherwise read as parsed with the word "incorrect" marked right.
  // Found by two readers: Blackboard puts its word in the second, fourth and sixth cell after the stem, whatever the answers say. Exact
  // alternation of the answers was missed when an answer was itself the word ("Correct", "Incorrect") or a gap shifted them, and the
  // option named "Incorrect" was marked right; so the cells are looked at where the file puts them, and so is a Correct cell that is only
  // the word.
  const isWord = (cell: string): boolean => /^(?:in)?correct$/i.test(cell.trim());
  if ((isWord(get("a1")) && isWord(get("a3"))) || isWord(correctCell) || (answers.length >= 4 && answers.every((a, i) => (i % 2 === 1) === isWord(a)))) {
    note(FindingCode.UnreadContent, "warn", 'This row looks like one of Blackboard\'s upload rows, whose answers are followed by the word correct or incorrect. If it is one of that file\'s rows read as a table, the key is not read from it: check it.');
  }

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
  } else if (own(TYPE_CODES, code)) kind = own(TYPE_CODES, code) as Kind;
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
    if (rightFirst) {
      if (rightIsFirst) marked = [0];
      else note(FindingCode.KeyLetterMissing, "info", "The cell for the right answer is empty, so no answer is marked.");
      if (kind === "mr") {
        note(FindingCode.UnreadContent, "warn", "This table has one column for the right answer, so only that answer is marked. If another is also right, mark it in the editor.");
      }
    } else if (correctCell !== "") {
      // The answer columns that the sheet has and this row leaves empty, by their place.
      const emptyColumns = new Set<number>();
      for (let i = 0; i < MAX_ANSWERS; i++) if (order.includes(`a${i}` as Column) && answerCells[i] === "") emptyColumns.add(i);
      const named = positionsNamed(correctCell, letterOf, answers, numbered, emptyColumns);
      if ("bad" in named && named.empty) {
        note(FindingCode.KeyLetterMissing, "error", `"${named.bad}" in the Correct cell names answer ${named.bad}, which is empty in this row. No answer is marked.`);
      } else if ("bad" in named && named.ambiguous && named.list) {
        note(FindingCode.KeyLetterMissing, "error", `"${named.bad}" in the Correct cell is the words of one of the answers and is also a list of answers, and the file does not say which is meant. No answer is marked.`);
      } else if ("bad" in named && named.ambiguous) {
        note(FindingCode.KeyLetterMissing, "error", `"${named.bad}" in the Correct cell could be the answer in column ${named.bad} or the answer whose words are "${named.bad}", and the file does not say which. No answer is marked.`);
      } else if ("bad" in named) {
        const filled = letterOf.map((i) => nameOf(i)).join(", ");
        note(FindingCode.KeyLetterMissing, "error", `"${named.bad}" in the Correct cell is not one of the answers${filled ? ` (the answers filled in are ${filled})` : ""}. No answer is marked.`);
      } else marked = named.positions;
    } else note(FindingCode.KeyLetterMissing, "info", "The Correct cell is empty, so no answer is marked.");
    if (kind === "mc" && code === "" && marked.length > 1) {
      kind = "mr";
      note(FindingCode.MoreThanOneRight, "warn", `The Correct cell names ${marked.map((p) => nameOf(letterOf[p] as number)).join(", ")}, and the Type cell is empty, so this is read as a multiple response. Check that it is.`);
    }
    // A gap between filled answers: the Correct letters still mean the columns, and the gap is said.
    const gaps = LETTERS.slice(0, letterOf.length === 0 ? 0 : (letterOf[letterOf.length - 1] as number) + 1)
      .split("")
      .map((_, i) => i)
      .filter((i) => !letterOf.includes(i))
      .map((i) => nameOf(i));
    if (gaps.length > 0) {
      note(FindingCode.OptionLetterGap, "warn", `${gaps.length === 1 ? `Answer ${gaps[0]} is` : `Answers ${gaps.join(", ")} are`} empty, so ${gaps.length === 1 ? "it was" : "they were"} left out. The ${numbered ? "numbers" : "letters"} in the Correct cell still mean the columns.`);
    }
    let texts = [...answers];
    if (texts.length < 2) {
      note(FindingCode.TooFewOptions, "error", `A ${kind === "mr" ? "multiple response" : "multiple choice"} question needs at least two answers, and this has ${texts.length}. A placeholder was added; write the answers in.`);
      while (texts.length < 2) texts.push("(missing)");
    }
    // The right answer's column comes first in every row of such a table, so left as it is the key of the whole bank would be A,
    // and so would version A of every printed test (a printed version A keeps the bank's order). The order is not something the
    // author chose; it is where the column stood. So the answers are mixed, the same way every time for the same question, and the
    // right answer goes with its own words. An answer that depends on its place ("None of the above") keeps the order of the file.
    if (rightIsFirst && answers.length > 1) {
      if (texts.some((t) => dependsOnPlace(t))) ctx.kept++;
      else {
        const was = shuffledFor(
          texts.map((_, i) => i),
          `right answer first:${stem}`,
        );
        texts = was.map((i) => texts[i] as string);
        marked = marked.map((m) => was.indexOf(m));
        ctx.mixed++;
      }
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
    let said = rightFirst ? rightWords : correctCell;
    // True and False written in the answer columns, and the Correct cell naming one by its letter: the answer is the word.
    if (/^[A-Ha-h]$/.test(correctCell)) {
      const at = letterOf.indexOf(correctCell.toUpperCase().charCodeAt(0) - 65);
      if (at !== -1 && (isTrue(answers[at] as string) || isFalse(answers[at] as string))) said = answers[at] as string;
    }
    // In a table with numbered answer columns a number in the Correct cell names a column, and it is also what 1 and 0 mean as yes and
    // no, so it is read as the column when that column holds True or False, and is otherwise not read: nothing says which was meant.
    let numberedAmbiguous = false;
    if (numbered && /^\d{1,2}$/.test(correctCell)) {
      const at = letterOf.indexOf(Number(correctCell) - 1);
      if (at !== -1 && (isTrue(answers[at] as string) || isFalse(answers[at] as string))) said = answers[at] as string;
      else numberedAmbiguous = true;
    }
    if (numberedAmbiguous) {
      note(FindingCode.KeyLetterMissing, "error", `The Correct cell says "${correctCell}", which in a table with numbered answer columns names a column, and that column does not hold True or False. It is not read as yes or no. No answer is marked.`);
    } else if (isTrue(said)) value = true;
    else if (isFalse(said)) value = false;
    else if (said !== "") note(FindingCode.KeyLetterMissing, "error", `The ${rightFirst ? "right answer" : "Correct"} cell says "${said}", which is not True or False. No answer is marked.`);
    else note(FindingCode.KeyLetterMissing, "info", `The ${rightFirst ? "cell for the right answer" : "Correct cell"} is empty, so neither True nor False is marked.`);
    const plain = answers.every((a) => isTrue(a) || isFalse(a)) && answers.length <= 2;
    if (answers.length > 0 && !plain) note(FindingCode.UnreadContent, "warn", `A true or false question has no answers of its own, so the answer cells were not used (${quotedAnswers()}).`);
    body = value === undefined ? {} : { correct: value };
  } else if (kind === "sa") {
    type = "shortAnswer";
    let accepted = answers;
    if (rightFirst) {
      // The right answer's column holds what is accepted (several, with a bar between them); the wrong answers are not accepted.
      accepted = rightWords.split("|").map((s) => s.trim()).filter((s) => s !== "");
      if (answers.length > (rightIsFirst ? 1 : 0)) {
        note(FindingCode.UnreadContent, "warn", `A short answer takes what is typed, so the wrong answers were not used (${answers.slice(rightIsFirst ? 1 : 0).map((a) => `"${a}"`).join("; ")}).`);
      }
    } else if (accepted.length === 0) accepted = correctCell.split("|").map((s) => s.trim()).filter((s) => s !== "");
    else if (correctCell !== "") note(FindingCode.UnreadContent, "warn", `The answers that are accepted are in the answer cells, so the Correct cell was not used ("${correctCell}").`);
    if (accepted.length === 0) note(FindingCode.KeyLetterMissing, "info", "The answer cells and the Correct cell are all empty, so no answer is accepted.");
    body = { caseSensitive: false, accepted };
  } else {
    type = "essay";
    body = {};
    if (code !== "" && own(TYPE_CODES, code) === "essay" && (answers.length > 0 || correctCell !== "")) {
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
  // A question's number in the list it came from (an official bank's "A-001-001-001") is the thing a person looks a question
  // up by, so it is kept where the bank can search it, and not dropped as an unknown column.
  const sourceId = words(get("id")).replace(/\s+/g, " ");
  const tidy = (column: Column): string => words(get(column)).replace(/\s+/g, " ");
  const metadata: Metadata = { status: "draft", tags: category !== "" ? [category] : [] };
  const custom: Record<string, string> = {};
  if (sourceId !== "") custom["Question ID"] = sourceId;
  // The columns a bank is organised by. A value that is a word this knows (the same words the text reader knows) is the field; a
  // difficulty or a Bloom level that is not one is kept as written, under its own name, and said, and never turned into a guess.
  for (const column of ["chapter", "section", "objective", "page"] as const) {
    const value = tidy(column);
    if (value !== "") metadata[column] = value;
  }
  for (const tag of tidy("tags").split(/[;,]/).map((t) => t.trim()).filter((t) => t !== "")) {
    if (!metadata.tags.includes(tag)) metadata.tags.push(tag);
  }
  const difficulty = tidy("difficulty");
  if (difficulty !== "") {
    // A number could be a place on any scale (1 to 3, or Brightspace's 1 to 5), so it is not turned into easy, medium or hard here, even
    // though the text reader reads 1, 2 and 3 that way for a line that says "Difficulty: 2". Only the words are read.
    const level = /^\d+$/.test(difficulty) ? undefined : difficultyOf(difficulty.toLowerCase());
    if (level) metadata.difficulty = level;
    else {
      custom["Difficulty"] = difficulty;
      note(
        FindingCode.UnknownMetadataLabel,
        "warn",
        /^\d+$/.test(difficulty)
          ? `Difficulty "${difficulty}" is a number, and a number could be a place on any scale (1 to 3, 1 to 5), so it was kept as written under Difficulty in the question's notes and not turned into easy, medium or hard.`
          : `Difficulty "${difficulty}" was not recognised (easy, medium or hard), so it was kept as written under Difficulty in the question's notes.`,
      );
    }
  }
  const bloom = tidy("bloom");
  if (bloom !== "") {
    const level = bloomOf(bloom.toLowerCase());
    if (level) metadata.bloom = level;
    else {
      custom["Bloom level"] = bloom;
      note(FindingCode.UnknownMetadataLabel, "warn", `Bloom level "${bloom}" was not recognised (remember, understand, apply, analyze, evaluate or create), so it was kept as written under Bloom level in the question's notes.`);
    }
  }
  if (Object.keys(custom).length > 0) metadata.custom = custom;
  const made = createQuestion({
    type,
    stem: plainToRich(stem),
    body,
    feedback,
    points,
    metadata,
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
    // The row that names the columns is the first that names two or more known ones. A first row that names only the question
    // column is the row of names only when no row below it names more: a lone "Questions" in A1 is a title above the real names.
    const rows = sheet.rows.slice(0, HEADER_SEARCH);
    const known = (r: TableRow): number => r.cells.filter((c) => columnOf(c) !== null).length;
    const strong = rows.findIndex((r, i) => isHeader(r.cells, i === 0) && known(r) >= 2);
    const at = strong !== -1 ? strong : rows.findIndex((r, i) => isHeader(r.cells, i === 0));
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
  if (!first.rows.slice(0, 3).some((r) => own(TYPE_CODES, squash(r.cells[0] ?? "")) !== undefined)) {
    return { read: [], skipped: withRows, headerless: true };
  }
  return {
    read: [{ sheet: first, headerAt: -1, order: DEFAULT_ORDER, names: DEFAULT_ORDER.map((c) => (/^a\d$/.test(c) ? (LETTERS[Number(c.slice(1))] as string) : (TEMPLATE_NAMES[c] ?? c))) }],
    skipped: withRows.slice(1),
    headerless: true,
  };
}

function importTable(file: TableFile, options: ImportOptions): ImportResult {
  const ctx: Ctx = { file: options.file ?? "questions.xlsx", at: options.at ?? new Date().toISOString(), author: options.author ?? "import", profile: options.profile ?? SPREADSHEET_PROFILE_ID, mixed: 0, kept: 0 };
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
  const conflicting: string[] = [];
  const rightColumns: string[] = [];
  const boardValues = new Set<string>();
  let attemptsColumn = false;
  let hiddenRows = 0;
  let hiddenSheets = 0;

  for (const p of read) {
    const label = file.kind === "xlsx" && p.sheet.name !== "" ? p.sheet.name : "";
    if (label !== "" && read.length > 1) lines.push(`Sheet: ${label}`);
    for (const u of p.header?.unused ?? []) {
      // The games' own file has a Category beside a Value, which is what a question is worth on the board (100, 200, 300): a setting
      // of the game and not of the question, said as such. A column called Value in any other table might mean anything, so it stays
      // an unused column with the warning.
      if (p.order.includes("category") && u.trim().toLowerCase() === "value") boardValues.add(u);
      else unused.add(u);
    }
    for (const r of p.header?.repeated ?? []) repeated.push(r);
    for (const c of p.header?.conflicting ?? []) conflicting.push(c);
    if (p.order.includes("rightText")) rightColumns.push(p.names[p.order.indexOf("rightText")] as string);
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
      const built = build(row, p.order, lineIndex, ctx, p.header?.numbered ?? false);
      if (built.question) questions.push(built.question);
      if (built.orphan) orphans.push(built.orphan);
    });
  }

  if (unused.size > 0) say("warn", `These columns were not used: ${[...unused].join(", ")}. ${unused.size === 1 ? "Its" : "Their"} contents are not in the questions.`);
  if (repeated.length > 0) say("warn", `${repeated.length === 1 ? "A column" : "Columns"} named ${repeated.join(", ")} repeat${repeated.length === 1 ? "s" : ""} one already read, and ${repeated.length === 1 ? "was" : "were"} not used.`);
  if (conflicting.length > 0) {
    say("warn", `${conflicting.length === 1 ? "A column that names" : "Columns that name"} wrong answers (${conflicting.join(", ")}) ${conflicting.length === 1 ? "was" : "were"} not used. The right answer cannot be told from them when the table also has answer columns A, B, C, or has no column called Correct or Correct answer for the right answer itself.`);
  }
  if (rightColumns.length > 0 && (ctx.mixed > 0 || ctx.kept > 0)) {
    const where = [...new Set(rightColumns)].map((c) => `"${c}"`).join(" and ");
    say(
      "info",
      `The right answer is in a column of its own (${where}) and the wrong answers are in the columns after it, so it is first in every row. The answers of ${plural(ctx.mixed, "question", "questions")} were mixed, the same way each time this file is read and with the right answer kept with its own words, so that the key is not A throughout${
        ctx.kept > 0 ? `; ${plural(ctx.kept, "question keeps", "questions keep")} the order of the file, because an answer depends on its place (such as None of the above)` : ""
      }.`,
    );
  }
  if (attemptsColumn) say("info", "The Attempts column was not used. Attempts are set by the course that uses a question, not stored in the question.");
  if (boardValues.size > 0) say("info", `The ${[...boardValues].map((v) => `"${v}"`).join(" and ")} column was not used. Beside a Category column it is what a question is worth on a game board (100, 200, 300), which belongs to the game that uses the question and not to the question. The Category was read as a tag.`);
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
