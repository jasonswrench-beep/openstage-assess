/**
 * How each question has done across the classes it was given to, read back from the class figures a bank keeps (`statistics/`), and
 * the questions those figures say are worth another look.
 *
 * The figures were written one class at a time, by Keep the class figures (from scanned sheets or a learning system's results). This
 * reads them together: for each question, every class in date order with its difficulty and discrimination, which wording of the
 * question each class saw, the change in difficulty from the first class to the last, and notes.
 *
 * The notes are advice about writing, like Check quality's, and follow its rules (`CLAUDE.md`): they are worked out each time and never
 * stored, so they cannot go stale when a question or a class changes; they never touch a question's status, version or findings; and
 * they say nothing when unsure. Only classes that saw the question as it is now are used for a note, because figures for an earlier
 * wording say little about this one, and only when those classes come to at least `SMALL_GROUP` attempts together. A question with
 * figures only from before its last change is shown with them and gets no note. The lines are judgements, in named constants, to be
 * moved on real banks and never to make a test pass.
 *
 * None of the notes can guess a key. A question that runs the wrong way is a reason to check the key and the wording, which the note
 * says, and nothing is changed.
 */

import type { Administration } from "../model/statistics.ts";
import { isChoice, isMultipleResponse, isTrueFalse, type Question } from "../model/question.ts";
import type { TestRecord } from "../model/test.ts";
import { SMALL_GROUP } from "../sheets/stats.ts";

/** A point-biserial below this, averaged over the classes, tells the strong from the weak only a little. */
export const WEAK_DISCRIMINATION = 0.15;
/** At or above this share right, nearly everyone gets it. */
export const TOO_EASY = 0.95;
/** At or below this share right, most get it wrong. */
export const TOO_HARD = 0.25;
/** A change in difficulty this large between the first class and the last, each of a stable size, is worth a look. */
export const DRIFT = 0.2;

export type HistoryNoteCode = "history.wrong-way" | "history.weak" | "history.too-easy" | "history.too-hard" | "history.unchosen" | "history.drift";

export interface HistoryNote {
  code: HistoryNoteCode;
  message: string;
}

export interface ItemRun {
  administrationId: string;
  date: string;
  testName: string;
  sheets: number;
  unstable: boolean;
  difficulty?: number;
  pointBiserial?: number;
  upperLower?: number;
  /** The question's version when the class saw it, where that can be told. */
  version?: number;
  /** True when the class saw the question as it is now. */
  current: boolean;
}

export interface ItemHistory {
  questionId: string;
  runs: ItemRun[];
  /** The classes that saw the question as it is now, together: attempts, and difficulty and point-biserial weighted by attempts. */
  pooled?: { classes: number; sheets: number; difficulty?: number; pointBiserial?: number };
  /** Difficulty from the first class to the last (of every class, whatever wording it saw). */
  trend?: { from: number; to: number; change: number; fromDate: string; toDate: string };
  notes: HistoryNote[];
}

const round = (v: number): number => Math.round(v * 10000) / 10000;

/**
 * The version of a question a class saw: what the figures recorded, which they do from 15 November 2026; for older figures, the test's
 * own copy when the bank still holds the test, otherwise the version the question's history says it had at the end of that day.
 * Undefined when none can say. The day was all there was at first, and it is wrong on the day itself: figures read in from a learning
 * system this morning and the question rewritten this afternoon counted the old figures as the new wording's.
 */
function versionSeen(question: Question, run: Administration, test: TestRecord | undefined, recorded: number | undefined): number | undefined {
  if (recorded !== undefined) return recorded;
  const copy = test?.questions.find((q) => q.id === question.id);
  if (copy) return copy.version;
  const changes = question.history.filter((h) => h.toVersion !== undefined).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  if (changes.length === 0) return question.version === 1 ? 1 : undefined;
  // The wording it started with counts from before it was made in this bank: a class given last term from a learning system, read
  // into a bank made this week, saw the words it was matched by. Each change made on or before the day of the class counts.
  const firstChange = changes[0] as (typeof changes)[number];
  let version = firstChange.fromVersion ?? (firstChange.toVersion as number);
  for (const h of changes) if (h.at.slice(0, 10) <= run.date) version = h.toVersion as number;
  return version;
}

/** The name of an answer for a person: its letter in the question as it is now, or True or False. */
function answerName(question: Question, answer: string): string | undefined {
  if (isTrueFalse(question)) return answer === "true" ? "True" : answer === "false" ? "False" : undefined;
  if (isChoice(question) || isMultipleResponse(question)) {
    const at = question.body.options.findIndex((o) => o.id === answer);
    return at < 0 ? undefined : String.fromCharCode(65 + at);
  }
  return undefined;
}

function rightAnswers(question: Question): Set<string> {
  if (isTrueFalse(question)) return new Set(question.body.correct === undefined ? [] : [question.body.correct ? "true" : "false"]);
  if (isChoice(question) || isMultipleResponse(question)) return new Set(question.body.options.filter((o) => o.correct).map((o) => o.id));
  return new Set();
}

/** The history of every question that has figures, by question id. */
export function itemHistory(questions: readonly Question[], administrations: readonly Administration[], testOf: (id: string) => TestRecord | undefined): Map<string, ItemHistory> {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const sorted = [...administrations].sort((a, b) => (a.date === b.date ? (a.id < b.id ? -1 : 1) : a.date < b.date ? -1 : 1));
  const out = new Map<string, ItemHistory>();
  for (const run of sorted) {
    const test = testOf(run.testId);
    for (const item of run.items) {
      const question = byId.get(item.questionId);
      if (!question) continue;
      const version = versionSeen(question, run, test, item.version);
      const history = out.get(question.id) ?? { questionId: question.id, runs: [], notes: [] };
      history.runs.push({
        administrationId: run.id,
        date: run.date,
        testName: run.testName,
        sheets: item.sheets,
        unstable: item.sheets < SMALL_GROUP,
        ...(item.difficulty !== undefined ? { difficulty: item.difficulty } : {}),
        ...(item.pointBiserial !== undefined ? { pointBiserial: item.pointBiserial } : {}),
        ...(item.upperLower !== undefined ? { upperLower: item.upperLower } : {}),
        ...(version !== undefined ? { version } : {}),
        current: version === question.version,
      });
      out.set(question.id, history);
    }
  }

  for (const history of out.values()) {
    const question = byId.get(history.questionId) as Question;
    const withDifficulty = history.runs.filter((r) => r.difficulty !== undefined);
    const first = withDifficulty[0];
    const last = withDifficulty[withDifficulty.length - 1];
    if (first && last && first !== last) history.trend = { from: first.difficulty as number, to: last.difficulty as number, change: round((last.difficulty as number) - (first.difficulty as number)), fromDate: first.date, toDate: last.date };

    const now = history.runs.filter((r) => r.current);
    const sheets = now.reduce((s, r) => s + r.sheets, 0);
    if (now.length === 0) continue;
    // Each figure pooled from the classes that have it, with the classes and attempts behind it: a class where everyone was right has
    // no point-biserial, and a note on the pooled one once rested on 5 attempts while it said 45.
    const weighted = (key: "difficulty" | "pointBiserial"): { value: number; classes: number; sheets: number } | undefined => {
      const have = now.filter((r) => r[key] !== undefined);
      const n = have.reduce((s, r) => s + r.sheets, 0);
      return n === 0 ? undefined : { value: round(have.reduce((s, r) => s + (r[key] as number) * r.sheets, 0) / n), classes: have.length, sheets: n };
    };
    const pd = weighted("difficulty");
    const pp = weighted("pointBiserial");
    history.pooled = { classes: now.length, sheets, ...(pd ? { difficulty: pd.value } : {}), ...(pp ? { pointBiserial: pp.value } : {}) };
    // Say nothing on too few attempts: the line is held to the attempts behind each figure, and the note names them.
    const over = (f: { classes: number; sheets: number }): string => `${f.classes} class${f.classes === 1 ? "" : "es"} (${f.sheets} attempts)`;
    if (pp && pp.sheets >= SMALL_GROUP) {
      const pb = pp.value;
      if (pb < 0) history.notes.push({ code: "history.wrong-way", message: `Over ${over(pp)} the students who did better on the whole test did worse on this question (point-biserial ${pb.toFixed(2)}). Check that the key is right and the wording is not misleading.` });
      else if (pb < WEAK_DISCRIMINATION) history.notes.push({ code: "history.weak", message: `Over ${over(pp)} this question told the stronger students from the weaker only a little (point-biserial ${pb.toFixed(2)}, under ${WEAK_DISCRIMINATION}).` });
    }
    if (pd && pd.sheets >= SMALL_GROUP) {
      const d = pd.value;
      if (d >= TOO_EASY) history.notes.push({ code: "history.too-easy", message: `Over ${over(pd)}, ${Math.round(d * 100)} percent got this right: it may not be telling you much.` });
      if (d <= TOO_HARD) history.notes.push({ code: "history.too-hard", message: `Over ${over(pd)}, only ${Math.round(d * 100)} percent got this right. Check the key, the wording and whether it was taught.` });
    }
    if (sheets < SMALL_GROUP) continue;

    // A wrong answer nobody chose, over every class that saw the question as it is now.
    const right = rightAnswers(question);
    const chosen = new Map<string, number>();
    for (const r of now) {
      const item = administrations.find((a) => a.id === r.administrationId)?.items.find((i) => i.questionId === question.id);
      for (const o of item?.options ?? []) chosen.set(o.answer, (chosen.get(o.answer) ?? 0) + o.chosen);
    }
    const unchosen = [...chosen.entries()].filter(([answer, n]) => n === 0 && !right.has(answer) && answerName(question, answer) !== undefined).map(([answer]) => answerName(question, answer) as string);
    if (unchosen.length > 0 && right.size > 0) {
      history.notes.push({ code: "history.unchosen", message: `Nobody chose ${unchosen.length === 1 ? `answer ${unchosen[0]}` : `answers ${unchosen.join(", ")}`} in ${sheets} attempts, so ${unchosen.length === 1 ? "it is" : "they are"} not drawing anyone away from the right answer.` });
    }

    const stable = now.filter((r) => !r.unstable && r.difficulty !== undefined);
    const a = stable[0];
    const b = stable[stable.length - 1];
    if (a && b && a !== b && Math.abs((b.difficulty as number) - (a.difficulty as number)) > DRIFT) {
      const up = (b.difficulty as number) > (a.difficulty as number);
      history.notes.push({ code: "history.drift", message: `It got ${up ? "easier" : "harder"} between ${a.date} (${Math.round((a.difficulty as number) * 100)} percent right) and ${b.date} (${Math.round((b.difficulty as number) * 100)} percent), with the same wording.${up ? " The question may be known to students." : ""}` });
    }
  }
  return out;
}
