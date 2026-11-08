/**
 * Blackboard's "Upload questions" text file, read in.
 *
 * The file is tab-delimited text with one question to a row and no header row. The first field is the type, the second is the question,
 * and the rest depend on the type: for a multiple choice (MC) or multiple answer (MA) question an answer and then the word correct or
 * incorrect, for each answer; for a true or false (TF) question the word true or false; for a fill in the blank (FIB) each accepted answer;
 * for a matching (MAT) question each pair as a left side then a right side; for an ordering (ORD) question each item in the right order; for
 * an essay (ESS) an optional sample answer. This is the shape Blackboard documents and the shape this program's own exporter writes
 * (`export/blackboard-upload.ts`), so what is exported and read again is what was exported.
 *
 * The rules of the project apply, as in every other reader. A key is what the file states in words: the word correct beside an answer, the
 * word true or false, the order the items are listed in. An answer with no word, or a word that is neither correct nor incorrect, is said
 * and the question is kept as an essay with all its words and fails, so that nothing in it is lost and nothing is guessed. A question
 * with no answer marked correct has no key and says so. A type this does not read (a numeric question, a file response, a short answer
 * that is marked by hand) is kept the same way. The file has no points, no feedback and no formatting: every question is worth the
 * default and the text is plain text, which is how the exporter wrote it.
 *
 * Only the tab and the line break are read. A double quote is a character like any other, because the file is documented with no quoting,
 * and a question that begins with one is written as it is.
 */

import { addFindings, createQuestion, DEFAULT_POINTS, withRecomputedFindings } from "../model/create.ts";
import { finding, FindingCode, type Finding, type Severity } from "../model/findings.ts";
import { localId } from "../model/ids.ts";
import type { Question, QuestionBody } from "../model/question.ts";
import { isBlankText, plainToRich } from "../model/richtext.ts";
import { unreadObjectFindings } from "../model/unread-objects.ts";
import { decodeTableText } from "./table-csv.ts";
import { countVerdicts, type Importer, type ImportOptions, type ImportResult, type Orphan, type SourceBlock } from "./types.ts";

export const BLACKBOARD_UPLOAD_PROFILE_ID = "blackboard-upload";

/** The types Blackboard's file documents. A row that begins with one of these and a tab is a question; most are read, the rest are kept. */
const READ_TYPES = new Set(["MC", "MA", "TF", "FIB", "MAT", "ORD", "ESS"]);
const KEPT_TYPES: Record<string, string> = {
  NUM: "A numeric question is not read: its tolerance is not explained in the file, so nothing is guessed about it.",
  FIL: "A file response question is not read: it has no answer to check.",
  SR: "A short answer question marked by hand is not read.",
  OPT: "An opinion scale question is not read.",
  JS: "A jumbled sentence question is not read.",
  QB: "A quiz bowl question is not read.",
};
const ALL_TYPES = new Set([...READ_TYPES, ...Object.keys(KEPT_TYPES)]);

/**
 * What a row's first field may be to be a question type at all: capital letters and underscores, as every type the file documents is
 * (FIB_PLUS, JUMBLED_SENTENCE). The reader keeps a row with a type it does not know as a failed essay, and the check for the kind of
 * file must agree with it: it asked for a listed type on every row, so a file with one row of a type that is not listed was taken for a
 * table, and the table reader marked the word "incorrect" as a right answer.
 */
const TYPE_WORD = /^[A-Z][A-Z_]{1,39}$/;
/** The reader keeps a row whose first word is made like a type, in any case, as a question of a type it does not know (a failed essay). */
const isTypeWord = (field: string): boolean => ALL_TYPES.has(field.toUpperCase()) || TYPE_WORD.test(field.toUpperCase());
/**
 * The check for the kind of file is stricter about a word that is not on the list: it has to be written in capitals, as Blackboard writes
 * them, so that the header of a table ("Type") is not one. Twelve characters was once the longest; JUMBLED_SENTENCE is 16 and
 * CALCULATED_NUMERIC is 18, and a file with either sent to the table reader marked the word "incorrect" as a right answer.
 */
const looksTyped = (field: string): boolean => ALL_TYPES.has(field.toUpperCase()) || TYPE_WORD.test(field);

const SHORT = 120;
const quoted = (s: string): string => (s.length > SHORT ? `${s.slice(0, SHORT - 1)}...` : s).replace(/\s+/g, " ").trim();
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const flat = (s: string): string => s.replace(/\s+/g, " ").trim();

interface Row {
  /** The line of the file, from 1. */
  number: number;
  fields: string[];
}

/** The rows of a file: a line is a row, a tab ends a field, and nothing else is read. A row with nothing in it is not one. */
function rowsOf(text: string): Row[] {
  const rows: Row[] = [];
  text
    .replace(/^﻿/, "")
    .split(/\r\n|\n|\r/)
    .forEach((line, i) => {
      // A field that shows nothing (only a zero width space, a control character, a soft hyphen) is an empty field. Compared as it was
      // read it was a stem, an answer or an item with no words in it, stored as an empty paragraph, and read as parsed.
      const fields = line.split("\t").map((f) => (isBlankText(f) ? "" : f.trim()));
      // A row that ends in tabs has empty fields at the end that say nothing, and a row with nothing in it is not one.
      while (fields.length > 0 && fields[fields.length - 1] === "") fields.pop();
      if (fields.length === 0) return;
      rows.push({ number: i + 1, fields });
    });
  return rows;
}

const wordOf = (field: string | undefined): string => (field ?? "").trim().toLowerCase();

/** Whether a row has the shape the file documents for its type, strictly: the words that mark a key are where they must be. */
function strictShape(fields: string[]): boolean {
  const type = (fields[0] ?? "").toUpperCase();
  if (type === "MC" || type === "MA") {
    const rest = fields.length - 2;
    // The answers are at 2, 4, 6... and the word that follows each is at 3, 5, 7...
    return rest >= 4 && rest % 2 === 0 && fields.every((f, i) => i < 3 || i % 2 === 0 || ["correct", "incorrect"].includes(wordOf(f)));
  }
  if (type === "TF") return fields.length === 3 && ["true", "false"].includes(wordOf(fields[2]));
  return false;
}

/**
 * Whether the start of a file is a Blackboard upload file. The rows begin with a type (one of the file's, or a word of capitals made like
 * one) and a tab, and at least one is a multiple choice, multiple answer or true or false row with the words correct, incorrect, true or
 * false where they belong (then a quarter of the rows may be anything else), or every row is typed and there are several of the listed
 * other types. A table with no header row whose first cells are types (the template's order) is not caught: its answers come before a
 * letter, not before the word correct.
 */
export function looksLikeBlackboardUpload(bytes: Uint8Array): boolean {
  let text: string;
  try {
    text = decodeTableText(bytes.subarray(0, 400_000)).text;
  } catch {
    return false;
  }
  const rows = rowsOf(text).slice(0, 40);
  if (rows.length === 0) return false;
  // A first row that names a Question column is the header of a table, whatever follows it.
  if (rows[0]?.fields.some((f) => ["question", "questions", "question text", "stem"].includes(wordOf(f)))) return false;
  const typed = rows.filter((r) => r.fields.length >= 2 && looksTyped(r.fields[0] as string));
  // A row with a strict shape is firm evidence, so a few stray lines among the rows (a count at the end, a lone type) do not undo it: the
  // reader keeps each as an orphan or a failed essay, which is said, and a file sent to the table reader instead marked "incorrect" as the
  // key. Without one, every row has to be typed.
  if (typed.some((r) => strictShape(r.fields))) return typed.length * 4 >= rows.length * 3;
  return typed.length === rows.length && rows.length >= 3 && rows.filter((r) => ["ESS", "FIB", "MAT", "ORD"].includes((r.fields[0] as string).toUpperCase())).length >= 3;
}

interface Ctx {
  file: string;
  at: string;
  author: string;
  profile: string;
  defaultPoints: number;
  multipleAnswer: number;
  blankless: number;
}

interface Built {
  question: Question;
}

function build(row: Row, ctx: Ctx): Built {
  const source = { file: ctx.file, firstBlock: row.number - 1, lastBlock: row.number - 1 };
  const type = (row.fields[0] ?? "").toUpperCase();
  const stemText = row.fields[1] ?? "";
  const rest = row.fields.slice(2);
  const findings: Finding[] = [];
  const note = (code: string, severity: Severity, message: string): void => void findings.push(finding(code, severity, message));
  const stem = plainToRich(stemText === "" ? "(no question text in the source)" : stemText);
  if (stemText === "") note(FindingCode.EmptyStem, "error", "The row has no question text. It is kept as (no question text in the source), and the question needs fixing.");

  const finish = (kind: Question["type"], body: QuestionBody, more: Finding[] = []): Built => {
    const made = createQuestion({
      type: kind,
      stem,
      body,
      points: ctx.defaultPoints,
      by: ctx.author,
      at: ctx.at,
      origin: { kind: "import", source, profile: ctx.profile, at: ctx.at },
      findings: [...more, ...findings],
    });
    return { question: withRecomputedFindings(addFindings(made, unreadObjectFindings(made, source))) };
  };

  // A type this does not read, or a row whose key cannot be read: every word of it is kept, as an essay, and it fails so that someone looks.
  const unsupported = (why: string): Built => {
    const words = rest.filter((w) => w !== "");
    const kept = words.length > 0 ? plainToRich(`${stemText}\n${words.join("\n")}`) : stem;
    const made = createQuestion({
      type: "essay",
      stem: words.length > 0 ? kept : stem,
      body: {},
      points: ctx.defaultPoints,
      by: ctx.author,
      at: ctx.at,
      origin: { kind: "import", source, profile: ctx.profile, at: ctx.at },
      findings: [...findings, finding(FindingCode.UnsupportedType, "error", `${why} The row's words are kept, as an essay, so that nothing in it is lost.`)],
    });
    return { question: withRecomputedFindings(addFindings(made, unreadObjectFindings(made, source))) };
  };

  if (type === "MC" || type === "MA") {
    if (rest.length % 2 !== 0) return unsupported("An answer has no word after it: each answer is followed by correct or incorrect, and this row ends on an answer.");
    const pairs: Array<{ text: string; word: string }> = [];
    for (let i = 0; i < rest.length; i += 2) pairs.push({ text: rest[i] as string, word: wordOf(rest[i + 1]) });
    if (pairs.length < 2) return unsupported(`A ${type === "MC" ? "multiple choice" : "multiple answer"} question needs at least two answers.`);
    const bad = pairs.find((p) => p.word !== "correct" && p.word !== "incorrect");
    if (bad) return unsupported(`The word after the answer "${quoted(bad.text)}" is "${quoted(bad.word)}", which is neither correct nor incorrect, and nothing is guessed about which answers are right.`);
    if (pairs.some((p) => p.text === "")) note(FindingCode.EmptyOption, "error", "An answer has no text. It is kept as (missing), and the question needs fixing.");
    const options = pairs.map((p, i) => ({ id: localId("o", i), content: plainToRich(p.text === "" ? "(missing)" : p.text), correct: p.word === "correct" }));
    const right = options.filter((o) => o.correct).length;
    if (right === 0) note(FindingCode.UnreadContent, "warn", "No answer is marked correct, so no answer is read as the key. Nothing was guessed.");
    if (type === "MC") {
      if (right > 1) note(FindingCode.MoreThanOneRight, "warn", `${right} answers are marked correct, and a multiple choice question has one right answer. Every one is marked right as the file has it, and the question needs fixing.`);
      return finish("multipleChoice", { shuffle: true, options });
    }
    ctx.multipleAnswer++;
    return finish("multipleResponse", { shuffle: true, partialCredit: false, options });
  }

  if (type === "TF") {
    const word = wordOf(rest[0]);
    if (rest.length !== 1 || (word !== "true" && word !== "false")) return unsupported("A true or false question has the word true or false after its text, and nothing else.");
    return finish("trueFalse", { correct: word === "true" });
  }

  if (type === "FIB") {
    const accepted = [...new Set(rest.map(flat).filter((a) => a !== ""))];
    if (accepted.length === 0) return unsupported("A fill in the blank question has at least one accepted answer after its text.");
    ctx.blankless++;
    return finish("shortAnswer", { caseSensitive: false, accepted });
  }

  if (type === "MAT") {
    if (rest.length % 2 !== 0 || rest.length < 4) return unsupported("A matching question has at least two pairs, each a left side and a right side, and this row does not.");
    const pairs: Array<{ left: string; right: string }> = [];
    for (let i = 0; i < rest.length; i += 2) pairs.push({ left: rest[i] as string, right: flat(rest[i + 1] as string) });
    if (pairs.some((p) => p.left === "" || p.right === "")) return unsupported("A pair has nothing on one side, and nothing is guessed to fill it.");
    return finish("matching", { shuffle: true, distractors: [], pairs: pairs.map((p, i) => ({ id: localId("p", i), left: plainToRich(p.left), right: p.right })) });
  }

  if (type === "ORD") {
    const items = rest.filter((w) => w !== "");
    if (items.length < 2) return unsupported("An ordering question has at least two items, in the right order.");
    if (items.length !== rest.length) return unsupported("An item has no text, and nothing is guessed to fill it.");
    return finish("ordering", { items: items.map((w, n) => ({ id: localId("i", n), content: plainToRich(w), position: n + 1 })) });
  }

  if (type === "ESS") {
    const sample = rest[0] ?? "";
    if (rest.length > 1) note(FindingCode.UnreadContent, "warn", `${plural(rest.length - 1, "field after the sample answer was", "fields after the sample answer were")} not read: "${quoted(rest.slice(1).join(" | "))}".`);
    return finish("essay", sample !== "" ? { modelAnswer: plainToRich(sample) } : {});
  }

  return unsupported(KEPT_TYPES[type] ?? `A question of the type "${quoted(type)}" is not one this reads.`);
}

function lineOf(row: Row): string {
  return `Row ${row.number}: ${row.fields.filter((c) => c !== "").join(" | ")}`;
}

function parseBlackboard(bytes: Uint8Array, options: ImportOptions): ImportResult {
  const ctx: Ctx = {
    file: options.file ?? "questions.txt",
    at: options.at ?? new Date().toISOString(),
    author: options.author ?? "import",
    profile: options.profile ?? BLACKBOARD_UPLOAD_PROFILE_ID,
    defaultPoints: options.defaultPoints ?? DEFAULT_POINTS,
    multipleAnswer: 0,
    blankless: 0,
  };
  const { text, encoding } = decodeTableText(bytes);
  const fileFindings: Finding[] = [];
  const say = (severity: Severity, message: string): void => void fileFindings.push(finding(FindingCode.UnreadContent, severity, message));
  if (encoding) say("info", `The file was read as ${encoding}.`);

  const rows = rowsOf(text);
  const lines = text.split(/\r\n|\n|\r/).map((l, i) => (l.trim() === "" ? "" : lineOf({ number: i + 1, fields: l.split("\t").map((f) => f.trim()) })));
  const questions: Question[] = [];
  const orphans: Orphan[] = [];
  for (const row of rows) {
    const type = (row.fields[0] ?? "").toUpperCase();
    if (!isTypeWord(type)) {
      orphans.push({ source: { file: ctx.file, firstBlock: row.number - 1, lastBlock: row.number - 1 }, text: row.fields.filter((c) => c !== "").join(" | "), reason: "This row does not begin with a question type (MC, MA, TF, FIB, MAT, ORD or ESS), so it was not read as a question." });
      continue;
    }
    questions.push(build(row, ctx).question);
  }

  say("info", "The file has no points: Blackboard asks for them when it is uploaded, so every question is worth 1 here, and it has no feedback or formatting.");
  if (ctx.multipleAnswer > 0) say("info", `${plural(ctx.multipleAnswer, "multiple answer question", "multiple answer questions")} ${ctx.multipleAnswer === 1 ? "is" : "are"} read as all or nothing: the file has no setting for partial credit.`);
  if (ctx.blankless > 0) say("info", `${plural(ctx.blankless, "fill in the blank row has", "fill in the blank rows have")} no blank marked in its text, so ${ctx.blankless === 1 ? "it is" : "they are"} read as short answer questions with the accepted answers the row lists.`);
  if (questions.length === 0 && orphans.length === 0) say("warn", "No question was found in this file. A Blackboard upload file has one question to a row, beginning with its type and a tab.");

  return { profile: ctx.profile, file: ctx.file, questions, orphans, counts: countVerdicts(questions, orphans.length), fileFindings, sourceLines: lines };
}

export const blackboardUploadImporter: Importer = {
  id: BLACKBOARD_UPLOAD_PROFILE_ID,
  label: "Blackboard upload questions (text)",
  // A .txt or .tsv is chosen by what is in it (see the registry), so the extension is not claimed here and a plain table is still a table.
  extensions: [],
  parse(input: string | SourceBlock[], options: ImportOptions = {}): ImportResult {
    const text = typeof input === "string" ? input : input.map((b) => b.text).join("\n");
    return parseBlackboard(new Uint8Array(Buffer.from(text, "utf8")), options);
  },
  parseBytes: parseBlackboard,
};
