/**
 * A quiz's results report from a learning system, read into the same scored rows the answer sheets make, so the same item statistics,
 * the same item history and the same `.pstat` file come from it.
 *
 * What is taken from the report is the learning system's own points for each question of each attempt, and the words of each response
 * where the report has them. The points are never worked out again here from the bank's key: the system scored what the student saw,
 * which may differ from the bank by now, and a score made up here would be one nobody gave. A response is counted against an answer of
 * the bank only when its words are exactly that answer's (with typography folded on both sides); any other response counts as no answer
 * marked, never the nearest one.
 *
 * A report is read by the names of its columns, one layout for each system (`LMS_REPORTS`), and refused with the columns it lacks
 * when it is not that layout. Nothing about a student is read: name, email, user name, student id, section and date columns are left
 * where they are and counted, an attempt is known by its place in the file, and nothing read here can reach a bank or a file except
 * points and the counts of answers marked.
 *
 * The layouts are written from each system's documentation and from memory of its reports, and no real report from any of the three
 * has been read yet (`TESTING-TODO.md`). That is why a layout that does not match is refused rather than read loosely.
 *
 * Each question of the report is matched to a bank question by its words: the stem with markup taken off and typography folded on
 * both sides, the same in one and only one question of the bank; then, where the report gives one, by a title that one and only one
 * question has. A question matched by neither, or by two, is left out of the figures and listed with the reason.
 */

import { foldTypography, richTextToPlain } from "../model/richtext.ts";
import { isChoice, isMultipleResponse, isTrueFalse, type Question } from "../model/question.ts";
import { createTest, type TestRecord } from "../model/test.ts";
import { decodeTableText, parseDelimited } from "../import/table-csv.ts";
import type { Outcome, QuestionScore, SheetScore } from "../sheets/score.ts";
import { itemStatistics, type TestStatistics } from "../sheets/stats.ts";

export type LmsId = "canvas" | "brightspace" | "blackboard";

export interface LmsReport {
  id: LmsId;
  /** The system's name, which a person needs to pick the right report. */
  lms: string;
  /** The report, by the name the system gives it. */
  report: string;
  /** Where to find it, in a sentence. */
  how: string;
}

export const LMS_REPORTS: readonly LmsReport[] = [
  { id: "canvas", lms: "Canvas", report: "Student Analysis", how: "In the quiz, open Quiz Statistics, choose Student Analysis and download the CSV it makes." },
  { id: "brightspace", lms: "Brightspace (D2L)", report: "Attempts (quiz statistics export)", how: "In the quiz's Statistics, open Question Details or User Stats and use Export to CSV, with one row for each question of each attempt." },
  { id: "blackboard", lms: "Blackboard", report: "Download Results, by question and user", how: "In the Grade Center column of the test, choose Download Results, then the comma-separated format and By Question and User." },
];

export interface LmsQuestion {
  /** How the report names the question (its own id, or its number), for this file only. */
  key: string;
  text: string;
  title?: string;
}

export interface LmsAnswer {
  response?: string;
  earned?: number;
  possible?: number;
}

export interface LmsAttempt {
  /** From 1, the attempt's place in the file. */
  number: number;
  answers: Map<string, LmsAnswer>;
}

export type LmsRead =
  | { ok: true; lms: LmsId; questions: LmsQuestion[]; attempts: LmsAttempt[]; notes: string[] }
  | { ok: false; reason: string };

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

/** The columns of a report that hold something about a student. They are counted and never read. */
const PERSONAL = ["name", "first name", "firstname", "last name", "lastname", "surname", "username", "user name", "email", "email address", "id", "sis_id", "sis id", "org defined id", "student id", "section", "section_id", "section_sis_id", "section #", "submitted", "attempt start", "attempt end", "date", "ip address"];

/** A number as the report writes it: digits with a point, nothing else. An empty cell is undefined, and anything else is refused by the caller. */
function points(cell: string | undefined): number | undefined | "bad" {
  const t = (cell ?? "").trim();
  if (t === "" || t === "-") return undefined;
  if (!/^-?[0-9]{1,9}(\.[0-9]{1,9})?$/.test(t)) return "bad";
  return Number(t);
}

/** Markup taken off a report's text with a plain scan (no pattern that can run to the end from every start), and the five entities. */
export function plainOf(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("<", i);
    if (open < 0) {
      out += text.slice(i);
      break;
    }
    const close = text.indexOf(">", open + 1);
    // A "<" with no ">" after it is a character, not a tag.
    if (close < 0) {
      out += text.slice(i);
      break;
    }
    out += `${text.slice(i, open)} `;
    i = close + 1;
  }
  return out.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

const said = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function personalNote(header: readonly string[]): string[] {
  const count = header.filter((h) => PERSONAL.includes(norm(h))).length;
  return count > 0 ? [`${said(count, "column about students (a name, an id, a section or a date) was", "columns about students (names, ids, sections, dates) were")} not read. Attempts are known only by their place in the file.`] : [];
}

/**
 * Canvas's Student Analysis: one row an attempt; each question is a column headed with Canvas's id for it, a colon and its text, holding
 * the response, followed by a column headed with the points it is worth, holding the points earned.
 */
function readCanvas(rows: readonly (readonly string[])[]): LmsRead {
  const [header, ...body] = rows;
  if (!header) return { ok: false, reason: "The file is empty." };
  const questions: Array<LmsQuestion & { column: number; possible: number }> = [];
  for (let c = 0; c < header.length; c++) {
    const h = header[c] ?? "";
    const colon = h.indexOf(":");
    const id = colon > 0 ? h.slice(0, colon).trim() : "";
    if (!/^[0-9]{1,12}$/.test(id)) continue;
    const next = points(header[c + 1]);
    if (typeof next !== "number") return { ok: false, reason: `The column "${h.slice(0, 60)}" names a question, and the column after it should be headed with its points, as Canvas's Student Analysis has them; it is headed "${(header[c + 1] ?? "").slice(0, 30)}". Download the Student Analysis report again, without changing it.` };
    questions.push({ key: id, text: plainOf(h.slice(colon + 1)).trim(), column: c, possible: next });
    c++;
  }
  if (questions.length === 0) return { ok: false, reason: 'This is not Canvas\'s Student Analysis report: no column is headed with a question\'s id and text ("1234: What is..."). In Canvas, open Quiz Statistics, choose Student Analysis and download that CSV.' };
  const attempts: LmsAttempt[] = [];
  for (const [r, row] of body.entries()) {
    if (row.every((c) => c.trim() === "")) continue;
    const answers = new Map<string, LmsAnswer>();
    for (const q of questions) {
      const earned = points(row[q.column + 1]);
      if (earned === "bad") return { ok: false, reason: `Row ${r + 2} has "${(row[q.column + 1] ?? "").slice(0, 20)}" where the points earned on question ${q.key} should be.` };
      answers.set(q.key, { response: row[q.column] ?? "", ...(earned !== undefined ? { earned } : {}), possible: q.possible });
    }
    attempts.push({ number: attempts.length + 1, answers });
  }
  return { ok: true, lms: "canvas", questions: questions.map(({ key, text }) => ({ key, text })), attempts, notes: personalNote(header) };
}

/** A report with one row for each question of each attempt, read by the names of the columns it must have. */
function readLong(lms: LmsId, rows: readonly (readonly string[])[], columns: { attempt: string[]; question: string[]; text: string[]; title?: string[]; response: string[]; earned: string[]; possible: string[] }, name: string): LmsRead {
  const [header, ...body] = rows;
  if (!header) return { ok: false, reason: "The file is empty." };
  const names = header.map(norm);
  const find = (options: readonly string[]): number => names.findIndex((n) => options.includes(n));
  const at = { attempt: find(columns.attempt), question: find(columns.question), text: find(columns.text), title: columns.title ? find(columns.title) : -1, response: find(columns.response), earned: find(columns.earned), possible: find(columns.possible) };
  const missing = (["question", "text", "earned", "possible"] as const).filter((k) => at[k] < 0).map((k) => `"${columns[k][0]}"`);
  if (missing.length > 0) return { ok: false, reason: `This is not ${name}: it has no ${missing.join(", ")} column. Make that report again, as the import menu says, and do not change its columns.` };
  // An attempt is the student's rows taken together. The report says who, and the person is never read: a change of the user columns
  // (or of the attempt number) starts the next attempt, known only by its place.
  const who = names.map((n, i) => (PERSONAL.includes(n) && !["section", "section #", "date", "attempt start", "attempt end", "submitted"].includes(n) ? i : -1)).filter((i) => i >= 0);
  const questions = new Map<string, LmsQuestion>();
  const attempts: LmsAttempt[] = [];
  let lastKey = "";
  for (const [r, row] of body.entries()) {
    if (row.every((c) => c.trim() === "")) continue;
    const attemptKey = [...who.map((i) => row[i] ?? ""), at.attempt >= 0 ? (row[at.attempt] ?? "") : ""].join("\u0000");
    const key = (row[at.question] ?? "").trim();
    let current = attempts[attempts.length - 1];
    if (!current || attemptKey !== lastKey || current.answers.has(key)) {
      current = { number: attempts.length + 1, answers: new Map() };
      attempts.push(current);
      lastKey = attemptKey;
    }
    if (key === "") return { ok: false, reason: `Row ${r + 2} has no question number or id.` };
    const text = plainOf(row[at.text] ?? "").trim();
    const title = at.title >= 0 ? (row[at.title] ?? "").trim() : "";
    const known = questions.get(key);
    if (!known) questions.set(key, { key, text, ...(title ? { title } : {}) });
    else if (known.text !== text) return { ok: false, reason: `Question ${key} has different words in row ${r + 2} than earlier in the file, so the report mixes two quizzes or two versions of a question. Export one quiz at a time.` };
    const earned = points(row[at.earned]);
    const possible = points(row[at.possible]);
    if (earned === "bad" || possible === "bad") return { ok: false, reason: `Row ${r + 2} has "${(row[earned === "bad" ? at.earned : at.possible] ?? "").slice(0, 20)}" where a number of points should be.` };
    current.answers.set(key, { response: at.response >= 0 ? (row[at.response] ?? "") : undefined, ...(earned !== undefined ? { earned } : {}), ...(possible !== undefined ? { possible } : {}) });
  }
  return { ok: true, lms, questions: [...questions.values()], attempts, notes: personalNote(header) };
}

/** A report, read as the layout of the system named. */
export function readLmsResults(lms: LmsId, rows: readonly (readonly string[])[]): LmsRead {
  if (lms === "canvas") return readCanvas(rows);
  if (lms === "brightspace") {
    return readLong("brightspace", rows, { attempt: ["attempt #", "attempt"], question: ["q #", "q#", "question #"], text: ["q text", "question text"], title: ["q title", "question title"], response: ["answer", "response"], earned: ["score", "points"], possible: ["out of", "points possible"] }, "the Brightspace quiz statistics export");
  }
  return readLong("blackboard", rows, { attempt: ["attempt"], question: ["question id", "question number"], text: ["question"], response: ["answer", "given answer"], earned: ["auto score", "score"], possible: ["possible points", "points possible"] }, "Blackboard's Download Results, by question and user");
}

// ---------------------------------------------------------------------------------------------------------------------------
// Matching the report's questions to the bank's

export interface Match {
  key: string;
  questionId?: string;
  by?: "words" | "title";
  /** Why a question was not matched. */
  reason?: string;
}

const compare = (text: string): string => foldTypography(text).replace(/\s+/g, " ").trim();

export function matchQuestions(questions: readonly LmsQuestion[], bank: readonly Question[]): Match[] {
  const byWords = new Map<string, string[]>();
  const byTitle = new Map<string, string[]>();
  for (const q of bank) {
    const words = compare(richTextToPlain(q.stem));
    if (words) byWords.set(words, [...(byWords.get(words) ?? []), q.id]);
    const title = compare(q.title ?? "");
    if (title) byTitle.set(title, [...(byTitle.get(title) ?? []), q.id]);
  }
  const taken = new Map<string, string>();
  const out: Match[] = questions.map((lq) => {
    const words = byWords.get(compare(lq.text)) ?? [];
    if (words.length === 1) return { key: lq.key, questionId: words[0] as string, by: "words" as const };
    const titled = lq.title ? (byTitle.get(compare(lq.title)) ?? []) : [];
    if (words.length === 0 && titled.length === 1) return { key: lq.key, questionId: titled[0] as string, by: "title" as const };
    if (words.length > 1) return { key: lq.key, reason: `${words.length} questions of the bank have these words, so which one it is is not known.` };
    return { key: lq.key, reason: "No question of the bank has these words. It may have been changed in the learning system, or after the export." };
  });
  // Two questions of the report matched to one of the bank is a sign that one of them is not it: neither is used.
  for (const m of out) if (m.questionId) taken.set(m.questionId, taken.has(m.questionId) ? "twice" : m.key);
  for (const m of out) {
    if (m.questionId && taken.get(m.questionId) === "twice") {
      delete m.questionId;
      delete m.by;
      m.reason = "Another question of the report matched the same question of the bank, so neither is used.";
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Scored rows

/** The bank's answers a response's words are exactly. Several answers are taken apart only where every piece is an answer. */
function answersOf(question: Question, response: string): string[] {
  const words = compare(plainOf(response));
  if (words === "") return [];
  if (isTrueFalse(question)) return /^true$/i.test(words) ? ["true"] : /^false$/i.test(words) ? ["false"] : [];
  if (!isChoice(question) && !isMultipleResponse(question)) return [];
  const options = question.body.options.map((o) => ({ id: o.id, words: compare(richTextToPlain(o.content)) }));
  const whole = options.filter((o) => o.words === words);
  if (whole.length === 1) return [(whole[0] as { id: string }).id];
  if (!isMultipleResponse(question)) return [];
  for (const sep of [";", ",", "|"]) {
    const parts = words.split(sep).map((p) => p.trim()).filter((p) => p !== "");
    if (parts.length < 2) continue;
    const ids = parts.map((p) => options.filter((o) => o.words === p));
    if (ids.every((m) => m.length === 1)) return [...new Set(ids.map((m) => (m[0] as { id: string }).id))];
  }
  return [];
}

export type LmsResults =
  | { ok: false; reason: string }
  | { ok: true; report: LmsReport; read: Extract<LmsRead, { ok: true }>; matches: Match[]; record: TestRecord; scores: SheetScore[]; stats: TestStatistics };

/**
 * A report file, read, matched against the bank's questions and scored, with its figures: what the command line and the app both do.
 * The record is made for these figures only (one version, the questions matched, in the report's order) and is not kept as a test.
 */
export function lmsResults(lms: LmsId, bytes: Uint8Array, bank: readonly Question[], options: { name: string; date: string }): LmsResults {
  const report = LMS_REPORTS.find((r) => r.id === lms);
  if (!report) return { ok: false, reason: `"${lms}" is not one of the learning systems this reads.` };
  const read = readLmsResults(lms, parseDelimited(decodeTableText(bytes).text).rows.map((r) => r.cells));
  if (!read.ok) return read;
  const matches = matchQuestions(read.questions, bank);
  const byId = new Map(bank.map((q) => [q.id, q]));
  const used = matches.flatMap((m) => (m.questionId ? [byId.get(m.questionId) as Question] : []));
  if (used.length === 0) return { ok: false, reason: `None of the ${read.questions.length} questions of the report is in this bank, by its words or its title. Open the bank the quiz was exported from.` };
  const record = createTest({ name: options.name, questions: used, versions: 1, seed: "lms-results", at: `${options.date}T00:00:00.000Z` });
  const scores = scoresFromLms(read, matches, bank);
  return { ok: true, report, read, matches, record, scores, stats: itemStatistics(record, scores) };
}

/**
 * The attempts as scored rows for the bank questions matched. An attempt is complete when the system gave points for every matched
 * question; one it did not (a question still to be marked by hand) leaves the attempt out of the figures, as an unsettled sheet is.
 */
export function scoresFromLms(read: Extract<LmsRead, { ok: true }>, matches: readonly Match[], bank: readonly Question[]): SheetScore[] {
  const used = matches.filter((m): m is Match & { questionId: string } => m.questionId !== undefined);
  const byId = new Map(bank.map((q) => [q.id, q]));
  return read.attempts.map((a) => {
    let unsettled = 0;
    const questions: QuestionScore[] = used.map((m, j) => {
      const q = byId.get(m.questionId) as Question;
      const answer = a.answers.get(m.key);
      const possible = answer?.possible;
      const earned = answer?.earned;
      const marked = answer?.response !== undefined ? answersOf(q, answer.response) : [];
      if (possible === undefined || earned === undefined || possible <= 0) {
        unsettled++;
        return { number: j + 1, questionId: q.id, outcome: "unsettled" as Outcome, earned: 0, possible: possible && possible > 0 ? possible : 0, marked, why: "The learning system gave no points for it in this attempt." };
      }
      const blank = answer?.response !== undefined && compare(plainOf(answer.response)) === "";
      const outcome: Outcome = blank && earned === 0 ? "blank" : earned >= possible ? "right" : earned <= 0 ? "wrong" : "partial";
      return { number: j + 1, questionId: q.id, outcome, earned, possible, marked };
    });
    const earned = questions.reduce((s, q) => s + q.earned, 0);
    const possible = questions.reduce((s, q) => s + q.possible, 0);
    return { number: a.number, version: 1, earned: Math.round(earned * 1e6) / 1e6, possible, ...(possible > 0 ? { percent: Math.round((1000 * earned) / possible) / 10 } : {}), settled: questions.length - unsettled, unsettled, complete: unsettled === 0, problems: unsettled ? [`${said(unsettled, "question has", "questions have")} no points from the learning system.`] : [], questions };
  });
}
