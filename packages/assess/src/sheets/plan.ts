/**
 * What goes on the answer sheet for a test: which numbered place holds which kind of question, and how many bubbles each needs.
 *
 * A sheet carries the questions a bubble can carry: multiple choice, multiple response and true or false. Every other question
 * keeps its number and its row, with no bubbles, so the numbers on the sheet are the numbers in the booklet. A question with no
 * usable answer key is still carried (it is read, and never scored); nothing is guessed to make it count.
 *
 * One sheet serves every version of a test, so what a place holds can differ from one version to the next when the questions are
 * shuffled. The plan therefore says, for each version, what each place holds, and for the sheet itself the most bubbles any version
 * needs in each place. A place is labelled T and F only when it is a true or false question in every version; otherwise its bubbles
 * are lettered, and the sheet says that for a true or false question A is True and B is False.
 */

import { isChoice, isMultipleResponse, isTrueFalse, type Question } from "../model/question.ts";
import { versionQuestions, type TestRecord, type VersionLabel } from "../model/test.ts";
import { MAX_SHEET_PAGES, layoutFor, pagesNeeded, placeName, type PaperName, type SheetStyle } from "./geometry.ts";

export type SlotKind = "choice" | "multiple" | "trueFalse" | "none";

export interface SlotUse {
  kind: SlotKind;
  /** How many bubbles the question in this place has. 0 when it has none. */
  places: number;
  questionId: string;
  /** Why a question has no bubbles. */
  why?: string;
}

export interface DrawnSlot {
  /** How many bubbles the shared sheet prints in this place: the most any version needs. */
  places: number;
  labels: string[];
}

export interface SheetPlan {
  paper: PaperName;
  style: SheetStyle;
  large: boolean;
  /** How many pages of answer sheet the test takes. */
  pages: number;
  /** For each version, what each numbered place holds. */
  uses: Partial<Record<VersionLabel, SlotUse[]>>;
  /** What the shared sheet prints in each numbered place. */
  drawn: DrawnSlot[];
  /** True when some place is a true or false question in one version and something else in another, so its bubbles are lettered. */
  lettersForTrueFalse: boolean;
  /** Things to say about the plan: the questions a sheet cannot carry, and why. */
  notes: string[];
}

export type PlanResult = { ok: true; plan: SheetPlan } | { ok: false; reason: string };

const MOST_PLACES = 8;
const MOST_PLACES_LARGE = 5;

/** What one question needs of a sheet. */
export function useOf(question: Question): SlotUse {
  const base = { questionId: question.id };
  if (isTrueFalse(question)) return { ...base, kind: "trueFalse", places: 2 };
  if (isChoice(question) || isMultipleResponse(question)) {
    const count = question.body.options.length;
    if (count < 2) return { ...base, kind: "none", places: 0, why: "it has fewer than two answers" };
    if (count > MOST_PLACES) return { ...base, kind: "none", places: 0, why: `it has ${count} answers, and a sheet holds at most ${MOST_PLACES}` };
    return { ...base, kind: isMultipleResponse(question) ? "multiple" : "choice", places: count };
  }
  return { ...base, kind: "none", places: 0, why: "a bubble sheet cannot carry this kind of question" };
}

export interface PlanOptions {
  paper?: PaperName;
  /** Large print: 7 mm bubbles, five to a question. */
  large?: boolean;
}

export function planSheet(record: TestRecord, options: PlanOptions = {}): PlanResult {
  const paper = options.paper ?? "letter";
  const large = options.large ?? false;
  const slots = record.questions.length;

  const uses: SheetPlan["uses"] = {};
  for (const version of record.versions) uses[version.label] = versionQuestions(record, version.label).map(useOf);
  const all = Object.values(uses) as SlotUse[][];

  // A loop and not `Math.max(m, ...)`: a test record of 130,000 questions is more arguments than a call can take, and is to be refused below
  // in words (too many pages), not by a RangeError.
  let most = 0;
  for (const list of all) for (const use of list) most = Math.max(most, use.places);
  const style: SheetStyle = large ? "large" : most > 5 ? "wide" : "standard";
  if (large && most > MOST_PLACES_LARGE) return { ok: false, reason: `a large print sheet has ${MOST_PLACES_LARGE} bubbles to a question, and this test has a question of ${most} answers` };

  const layout = layoutFor(paper, style);
  const pages = pagesNeeded(layout, slots);
  if (pages > MAX_SHEET_PAGES) return { ok: false, reason: `this test has ${slots} questions, which is ${pages} pages of answer sheet, and a test has at most ${MAX_SHEET_PAGES}` };

  let lettersForTrueFalse = false;
  const drawn: DrawnSlot[] = [];
  for (let i = 0; i < slots; i++) {
    const here = all.map((list) => list[i] as SlotUse);
    const places = Math.max(...here.map((u) => u.places));
    const everyTrueFalse = here.every((u) => u.kind === "trueFalse");
    if (!everyTrueFalse && here.some((u) => u.kind === "trueFalse")) lettersForTrueFalse = true;
    drawn.push({ places, labels: everyTrueFalse ? ["T", "F"] : Array.from({ length: places }, (_x, p) => placeName(p)) });
  }

  const notes: string[] = [];
  // Every version is walked, not only the first: with shuffled questions the one that cannot be carried is at another number in each.
  for (const version of record.versions) {
    (uses[version.label] ?? []).forEach((u, i) => {
      if (u.kind !== "none") return;
      const where = record.versions.length > 1 ? `In version ${version.label}, question` : "Question";
      notes.push(`${where} ${i + 1} has no bubbles: ${u.why}. It keeps its number, and the sheet says to answer it in the booklet.`);
    });
  }
  return { ok: true, plan: { paper, style, large, pages, uses, drawn, lettersForTrueFalse, notes } };
}
