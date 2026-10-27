/**
 * The open question model.
 *
 * One envelope, one type-specific body. The envelope is identical across every
 * question type and only `body` changes shape, which is what makes an exporter
 * a switch over eleven bodies rather than eleven separate code paths.
 *
 * Five properties of this shape matter more than the field names:
 *
 *  1. Rich text is a fixed, documented HTML subset (see richtext.ts).
 *  2. Media and equations are referenced by placeholder, not embedded.
 *  3. Correctness lives on the option, never in a separate key list, because
 *     separate keys are how answer keys drift out of step with reordered
 *     options.
 *  4. Findings carry a dismissal flag, so an author's judgement survives the
 *     next check.
 *  5. `version` increments on every edit and `history` records what changed.
 *     The rule that editing a reviewed question returns it to draft is
 *     implemented here, not in the user interface.
 *
 * What is deliberately NOT here: attempts, time limits, feedback timing,
 * whether the key is shown, scoring weight within a test. Those are properties
 * of a course or a quiz, not of an item. They live in the consuming project,
 * keyed by question id. Getting that boundary wrong is how a bank becomes
 * unusable in a second context.
 */

import type { Finding, SourceRef } from "./findings.ts";
import type { RichText } from "./richtext.ts";

export const QUESTION_TYPES = [
  "multipleChoice",
  "multipleResponse",
  "trueFalse",
  "fillInBlank",
  "matching",
  "ordering",
  "numeric",
  "shortAnswer",
  "essay",
  "hotspot",
  "calculated",
] as const;

export type QuestionType = (typeof QUESTION_TYPES)[number];

/** The types the first release commits to. Hotspot and calculated come later. */
export const RELEASE_1_TYPES: readonly QuestionType[] = QUESTION_TYPES.filter(
  (t) => t !== "hotspot" && t !== "calculated",
);

export const BLOOM_LEVELS = [
  "remember",
  "understand",
  "apply",
  "analyze",
  "evaluate",
  "create",
] as const;
export type BloomLevel = (typeof BLOOM_LEVELS)[number];

export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const STATUSES = ["draft", "reviewed", "approved", "retired"] as const;
export type Status = (typeof STATUSES)[number];

export interface Metadata {
  objective?: string;
  chapter?: string;
  section?: string;
  page?: string;
  bloom?: BloomLevel;
  difficulty?: Difficulty;
  tags: string[];
  author?: string;
  status: Status;
  /**
   * Publisher metadata labels the engine does not recognise. Keeping them is
   * what makes "nothing is dropped" true for the metadata lines in a test
   * bank, not only for its questions.
   */
  custom?: Record<string, string>;
}

export interface Feedback {
  general?: RichText;
  correct?: RichText;
  incorrect?: RichText;
}

export interface MediaRef {
  id: string;
  /** Path inside the bank container, for example media/m_01J....png */
  file: string;
  mime: string;
  alt: string;
  /** True when the image carries no meaning and alt text is correctly empty. */
  decorative?: boolean;
  width?: number;
  height?: number;
}

export interface MathRef {
  id: string;
  latex: string;
  mathml: string;
  /** Where the equation came from, which decides whether it needs a human. */
  source?: "omml" | "typed" | "latex" | "image";
}

export interface HistoryEntry {
  at: string;
  by: string;
  change: string;
  fromVersion?: number;
  toVersion?: number;
}

export interface Origin {
  kind: "authored" | "import" | "copy" | "link";
  /** For copies and links: where this question came from. */
  bankId?: string;
  questionId?: string;
  /** For imports: the file and the blocks it was built from. */
  source?: SourceRef;
  profile?: string;
  at?: string;
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

export interface Option {
  id: string;
  content: RichText;
  correct: boolean;
  feedback?: RichText;
  /** Keeps this option in place when the rest are shuffled. */
  fixedPosition?: boolean;
}

export interface MultipleChoiceBody {
  shuffle: boolean;
  options: Option[];
}

export interface MultipleResponseBody {
  shuffle: boolean;
  /** False means all or nothing. */
  partialCredit: boolean;
  options: Option[];
}

export interface TrueFalseBody {
  /**
   * Undefined means no key was given, which is not the same as False.
   *
   * A required boolean here cannot tell "the answer is False" from "nobody
   * said", so an import with a missing key had to invent one, and the invented
   * answer was indistinguishable from an authored one. Leaving it undefined is
   * what lets the answer-key check see that the key is missing.
   */
  correct?: boolean;
}

export interface Blank {
  id: string;
  /** Shown to the author to tell blanks apart; not shown to a learner. */
  label?: string;
  accepted: string[];
}

export interface FillInBlankBody {
  caseSensitive: boolean;
  blanks: Blank[];
}

export interface MatchPair {
  id: string;
  left: RichText;
  right: string;
}

export interface MatchingBody {
  pairs: MatchPair[];
  /** Extra right-hand entries that match nothing. */
  distractors: string[];
  shuffle: boolean;
}

export interface OrderItem {
  id: string;
  content: RichText;
  /** One-based position in the correct order. */
  position: number;
}

export interface OrderingBody {
  items: OrderItem[];
}

export interface NumericBody {
  mode: "exact" | "range" | "tolerance";
  value?: number;
  min?: number;
  max?: number;
  tolerance?: number;
  units?: string;
}

export interface ShortAnswerBody {
  caseSensitive: boolean;
  accepted: string[];
}

export interface RubricRow {
  criterion: string;
  points: number;
  description?: string;
}

export interface EssayBody {
  modelAnswer?: RichText;
  rubric?: RubricRow[];
  expectedWords?: number;
}

export interface HotspotRegion {
  id: string;
  shape: "rect" | "circle" | "poly";
  coords: number[];
  correct: boolean;
}

export interface HotspotBody {
  mediaRef: string;
  regions: HotspotRegion[];
  /**
   * The accessible alternative. Hotspot does not ship until this is required,
   * which is why it is not optional here.
   */
  alternative: RichText;
}

export interface CalculatedVariable {
  name: string;
  min: number;
  max: number;
  decimals: number;
}

export interface CalculatedBody {
  formula: string;
  variables: CalculatedVariable[];
  tolerance: number;
  toleranceIsPercent: boolean;
}

export type QuestionBody =
  | MultipleChoiceBody
  | MultipleResponseBody
  | TrueFalseBody
  | FillInBlankBody
  | MatchingBody
  | OrderingBody
  | NumericBody
  | ShortAnswerBody
  | EssayBody
  | HotspotBody
  | CalculatedBody;

export interface Question {
  id: string;
  version: number;
  type: QuestionType;
  title: string;
  stem: RichText;
  points: number;
  body: QuestionBody;
  feedback: Feedback;
  metadata: Metadata;
  media: MediaRef[];
  math: MathRef[];
  findings: Finding[];
  history: HistoryEntry[];
  origin?: Origin;
}

/** Narrowing helpers, so call sites do not cast. */
export function isChoice(q: Question): q is Question & { body: MultipleChoiceBody } {
  return q.type === "multipleChoice";
}
export function isMultipleResponse(q: Question): q is Question & { body: MultipleResponseBody } {
  return q.type === "multipleResponse";
}
export function isTrueFalse(q: Question): q is Question & { body: TrueFalseBody } {
  return q.type === "trueFalse";
}
export function isMatching(q: Question): q is Question & { body: MatchingBody } {
  return q.type === "matching";
}
export function isOrdering(q: Question): q is Question & { body: OrderingBody } {
  return q.type === "ordering";
}
export function isFillInBlank(q: Question): q is Question & { body: FillInBlankBody } {
  return q.type === "fillInBlank";
}
export function isNumeric(q: Question): q is Question & { body: NumericBody } {
  return q.type === "numeric";
}
export function isShortAnswer(q: Question): q is Question & { body: ShortAnswerBody } {
  return q.type === "shortAnswer";
}
export function isEssay(q: Question): q is Question & { body: EssayBody } {
  return q.type === "essay";
}

/** The options of any question that has them, or an empty list. */
export function optionsOf(q: Question): Option[] {
  if (isChoice(q) || isMultipleResponse(q)) return q.body.options;
  return [];
}

/** Titles cap at 64 characters, the same ceiling the test-bank vendor uses. */
export const MAX_TITLE_LENGTH = 64;

/**
 * A title derived from the stem when the source gave none. the test-bank vendor truncates
 * at 20 characters on import while allowing 64 in the editor, which quietly
 * destroys information; this uses the full 64 and breaks on a word boundary.
 */
export function titleFromStem(stemPlain: string): string {
  const flat = stemPlain.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_TITLE_LENGTH) return flat;
  const cut = flat.slice(0, MAX_TITLE_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trim();
}
