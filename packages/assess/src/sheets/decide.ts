/**
 * What each question says, from how filled its bubbles are: the fixed rules, and nothing else.
 *
 * This is where the rule of the whole feature is kept: a mark the reader is not sure of is flagged, never guessed. A question is
 * recorded as answered only when every bubble is plainly filled or plainly empty and the pattern is one that means an answer. A
 * blank question is flagged for a quick confirm, since an empty row can be a left-out answer or a mark the reader missed. Anything
 * between (a faint mark, an erasure, a tick, half a fill) is flagged, and so is two marks where one answer was asked for, a mark where
 * this version of the test has no bubble, and a row whose printed circles could not be found where they should be.
 *
 * The numbers are set against a fill of 1 for ink as dark as the corner marks, and are provisional: the harness (gate.ts) measures what
 * they do on drawn sheets, and real sheets filled in by hand are what they are finally set on. On drawn sheets a firm pencil mark
 * reads 0.65 to 0.85, a hurried scribble 0.4 to 0.6, half a fill about 0.4, a cross 0.2 to 0.3, a tick 0.15 to 0.25, and an empty
 * bubble 0.00 to 0.02, so the line for a mark is set at 0.5 and the line for an empty bubble well under a tick.
 */

import type { SlotKind, SlotUse } from "./plan.ts";
import { placeName } from "./geometry.ts";

/** A bubble at or above this is filled. */
export const FILLED = 0.5;
/** A bubble at or below this is empty. Between the two is faint. */
export const BLANK = 0.1;
/**
 * The same line for a question that takes several answers. A mark missed there silently changes the set of answers, where on a
 * question with one answer it leaves the row blank or leaves another mark standing alone, so the line is drawn closer to clean paper.
 */
export const BLANK_MULTIPLE = 0.06;

export type QuestionStatus = "answered" | "blank" | "flagged" | "notOnSheet";
export type FlagKind = "blank" | "faint" | "multiple" | "beyond" | "registration" | "bilevel";

export interface QuestionDecision {
  status: QuestionStatus;
  /** The places (from 0) filled, when the question is answered. */
  marked: number[];
  kind?: FlagKind;
  /** What the reader saw, in words, for the person who has to settle it. */
  reason?: string;
}

const fmt = (fill: number): string => fill.toFixed(2);
const list = (places: number[]): string => places.map(placeName).join(", ");

/**
 * What one question says. `fills` is one number per bubble the sheet draws for it; `use` is what this version of the test holds there
 * (undefined when there is none); `registered` is false when the row's printed circles could not be found where they should be;
 * `bilevel` is true when the picture is black and white.
 */
export function decideQuestion(fills: readonly number[], use: SlotUse | undefined, registered = true, bilevel = false): QuestionDecision {
  const kind: SlotKind = use?.kind ?? "none";
  const places = kind === "none" ? 0 : (use as SlotUse).places;
  if (fills.length === 0) return { status: "notOnSheet", marked: [] };

  const beyond = fills.map((f, i) => ({ f, i })).filter(({ f, i }) => i >= places && f > BLANK);
  if (!registered) {
    return { status: "flagged", marked: [], kind: "registration", reason: "The printed circles of this row could not be found where they should be, so its marks could not be read with confidence." };
  }
  if (beyond.length > 0) {
    const where = places === 0 ? "where this version of the test has no bubbles for the question" : `in ${beyond.map(({ i }) => `bubble ${placeName(i)}`).join(", ")}, which this version's question does not have`;
    return { status: "flagged", marked: [], kind: "beyond", reason: `Something is marked ${where} (fill ${beyond.map(({ f }) => fmt(f)).join(", ")}).` };
  }
  if (places === 0) return { status: "notOnSheet", marked: [] };

  const own = fills.slice(0, places);
  const empty = kind === "multiple" ? BLANK_MULTIPLE : BLANK;
  const faint = own.map((f, i) => ({ f, i })).filter(({ f }) => f > empty && f < FILLED);
  if (faint.length > 0) {
    return { status: "flagged", marked: [], kind: "faint", reason: `${faint.map(({ i, f }) => `Bubble ${placeName(i)} is marked lightly or in part (fill ${fmt(f)})`).join("; ")}. It could be an answer, an erasure or a stray mark.` };
  }
  const filled = own.map((f, i) => ({ f, i })).filter(({ f }) => f >= FILLED).map(({ i }) => i);
  // A black and white scan keeps a mark or loses it: a pale mark is gone and a smudge can come out solid. On a question with one answer
  // that leaves the row blank or leaves two marks, both flagged; on a question with several the set itself would be wrong without a sign.
  if (bilevel && kind === "multiple") {
    return { status: "flagged", marked: [], kind: "bilevel", reason: `This picture is black and white, which loses pale pencil and can turn a smudge solid, so the set of answers on this question (${filled.length === 0 ? "none marked" : list(filled)}) cannot be relied on. Check it against the sheet, or scan in grey.` };
  }
  if (filled.length === 0) return { status: "blank", marked: [], kind: "blank", reason: "No bubble is marked." };
  if (kind !== "multiple" && filled.length > 1) {
    return { status: "flagged", marked: [], kind: "multiple", reason: `More than one bubble is marked (${list(filled)}) on a question with one answer.` };
  }
  return { status: "answered", marked: filled };
}

export interface VersionDecision {
  /** From 1 to 4, when exactly one version bubble is filled and the rest are empty. */
  version?: number;
  reason?: string;
}

/** Which version a student marked: exactly one filled bubble among the version bubbles, the rest empty. Any other pattern is a flag. */
export function decideVersion(fills: readonly number[]): VersionDecision {
  const faint = fills.filter((f) => f > BLANK && f < FILLED);
  const filled = fills.map((f, i) => ({ f, i })).filter(({ f }) => f >= FILLED).map(({ i }) => i);
  if (faint.length > 0) return { reason: `A version bubble is marked lightly or in part (fill ${faint.map(fmt).join(", ")}), so the version is not certain.` };
  if (filled.length === 0) return { reason: "No version bubble is marked, so it is not known which version this student had." };
  if (filled.length > 1) return { reason: `More than one version bubble is marked (${filled.map((i) => String.fromCharCode(65 + i)).join(", ")}).` };
  return { version: (filled[0] as number) + 1 };
}
