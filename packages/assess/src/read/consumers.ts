/**
 * What each consumer can actually deliver.
 *
 * OpenStage Author and OpenStage Scroll are not LMSs, but the question of what
 * survives where is the same question, so it uses the same mechanism: a
 * profile that lists supported types and names a fallback for the rest. When
 * the QTI exporters arrive they add destination profiles to this same table
 * rather than inventing a second mechanism.
 *
 * These tables are declarations of intent, not measurements. Each entry is a
 * hypothesis until the consumer confirms it, exactly as the LMS matrix is.
 */

import { QUESTION_TYPES, type QuestionType } from "../model/question.ts";

export const CONSUMERS = ["openstage-author", "openstage-scroll"] as const;
export type Consumer = (typeof CONSUMERS)[number];

export interface Fallback {
  /** The type the question is converted to, or "none" when it cannot go. */
  to: QuestionType | "none";
  note: string;
}

export interface ConsumerCapability {
  consumer: Consumer;
  label: string;
  /** How the consumer presents a question, for the delivery payload. */
  presentation: "slide" | "inline";
  supports: QuestionType[];
  fallbacks: Partial<Record<QuestionType, Fallback>>;
  notes: string[];
}

const AUTHOR: ConsumerCapability = {
  consumer: "openstage-author",
  label: "OpenStage Author",
  presentation: "slide",
  supports: [
    "multipleChoice",
    "multipleResponse",
    "trueFalse",
    "fillInBlank",
    "matching",
    "ordering",
    "numeric",
    "shortAnswer",
    "essay",
  ],
  fallbacks: {
    hotspot: {
      to: "none",
      note: "Hotspot ships later. Turning regions into options loses the image they refer to, so the item is withheld rather than delivered unanswerable.",
    },
    calculated: {
      to: "none",
      note: "Calculated ships later. Delivering it needs the formula evaluated over a generated variable set; anything less scores a made-up answer as correct.",
    },
  },
  notes: [
    "A slide may carry one question or several; that is the course author's choice, not the bank's.",
    "Essay items are delivered but not scored by the player, exactly as in an LMS.",
  ],
};

const SCROLL: ConsumerCapability = {
  consumer: "openstage-scroll",
  label: "OpenStage Scroll",
  presentation: "inline",
  supports: ["multipleChoice", "multipleResponse", "trueFalse", "fillInBlank", "numeric", "shortAnswer"],
  fallbacks: {
    matching: {
      to: "none",
      note: "Matching needs a design decision before it is offered inline; a long two-column interaction reads badly in a scrolling page and is hard to complete by keyboard.",
    },
    ordering: {
      to: "none",
      note: "Ordering has the same open design question as matching.",
    },
    essay: {
      to: "none",
      note: "An inline knowledge check is ungraded, so an essay prompt has nowhere to go. Use a document or an assignment instead.",
    },
    hotspot: { to: "none", note: "Hotspot ships later." },
    calculated: { to: "none", note: "Calculated ships later; see the note on the Author profile." },
  },
  notes: [
    "Knowledge checks are usually ungraded, so points are carried but may be ignored.",
    "Pools and blueprints are a test-assembly idea and are out of scope for a scrolling page.",
  ],
};

const TABLE: Record<Consumer, ConsumerCapability> = {
  "openstage-author": AUTHOR,
  "openstage-scroll": SCROLL,
};

export function capabilityFor(consumer: Consumer): ConsumerCapability {
  const found = TABLE[consumer];
  if (!found) {
    throw new Error(`Unknown consumer "${consumer}". Known consumers: ${CONSUMERS.join(", ")}.`);
  }
  return found;
}

export function allCapabilities(): ConsumerCapability[] {
  return CONSUMERS.map(capabilityFor);
}

export interface TypeVerdict {
  type: QuestionType;
  supported: boolean;
  fallback?: Fallback;
}

/** Every type with its verdict, which is what a destination check report prints. */
export function typeVerdicts(consumer: Consumer): TypeVerdict[] {
  const capability = capabilityFor(consumer);
  return QUESTION_TYPES.map((type) => {
    if (capability.supports.includes(type)) return { type, supported: true };
    const fallback = capability.fallbacks[type];
    return fallback ? { type, supported: false, fallback } : { type, supported: false };
  });
}
