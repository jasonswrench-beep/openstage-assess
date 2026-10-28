/**
 * The read contract.
 *
 * Built so that other OpenStage tools could read a bank without parsing the zip
 * themselves or needing OpenAssess installed. They do not: each OpenStage tool
 * stands alone and the link between them is a file a person carries across (see
 * docs/design-plan.md). Nothing depends on this module, so the shapes below are
 * not a promise to anyone. It is kept and tested for now and may be removed once
 * the desktop app exists. Do not build on it.
 *
 * Six operations, as written at the end of phase 1:
 *
 *   openBank           bank metadata, folders, tags, counts
 *   listQuestions      summaries for picking
 *   getQuestion        one full question
 *   resolveLink        a stored reference, with staleness handled
 *   supportedTypes     what a consumer can deliver, and the fallbacks
 *   toDeliveryPayload  a question reduced to what a consumer renders
 *
 * The version number is kept so that a real consumer, if one ever appears, has
 * something to pin. Until then the shapes may change freely.
 */

import { Bank } from "../bank/store.ts";
import { richTextToPlain, type RichText } from "../model/richtext.ts";
import { liveFindings } from "../model/findings.ts";
import { questionsUnder, type Query } from "../model/bank.ts";
import type { MediaRef, MathRef, Question, QuestionType, Status } from "../model/question.ts";
import { capabilityFor, type Consumer, type ConsumerCapability, type Fallback } from "./consumers.ts";

export const READ_CONTRACT_VERSION = "1.0.0";

export { CONSUMERS, capabilityFor, allCapabilities, typeVerdicts } from "./consumers.ts";
export type { Consumer, ConsumerCapability, Fallback, TypeVerdict } from "./consumers.ts";

// ---------------------------------------------------------------------------
// 1. openBank
// ---------------------------------------------------------------------------

export interface BankHandle {
  bankId: string;
  title: string;
  description?: string;
  questionCount: number;
  modified: string;
  folders: FolderSummary[];
  tags: string[];
  /** Opaque to the consumer; pass it back to the other operations. */
  readonly _bank: Bank;
}

export interface FolderSummary {
  id: string;
  name: string;
  questionCount: number;
  children: FolderSummary[];
}

export async function openBank(path: string): Promise<BankHandle> {
  const { bank } = await Bank.open(path);
  return handleFor(bank);
}

/** For a consumer that already holds the bytes, for example from a project file. */
export function openBankFromBytes(bytes: Uint8Array): BankHandle {
  return handleFor(Bank.fromBytes(bytes).bank);
}

function handleFor(bank: Bank): BankHandle {
  const tags = new Set<string>();
  for (const question of bank.questions.values()) {
    for (const tag of question.metadata.tags) tags.add(tag);
  }
  return {
    bankId: bank.manifest.bankId,
    title: bank.manifest.title,
    ...(bank.manifest.description ? { description: bank.manifest.description } : {}),
    questionCount: bank.questions.size,
    modified: bank.manifest.modified,
    folders: bank.folders.root.map(summariseFolder),
    tags: [...tags].sort(),
    _bank: bank,
  };
}

function summariseFolder(node: { id: string; name: string; questionIds: string[]; children: never[] | any[] }): FolderSummary {
  return {
    id: node.id,
    name: node.name,
    questionCount: questionsUnder(node as never).length,
    children: node.children.map(summariseFolder),
  };
}

// ---------------------------------------------------------------------------
// 2. listQuestions
// ---------------------------------------------------------------------------

export interface QuestionSummary {
  id: string;
  version: number;
  type: QuestionType;
  title: string;
  /** Plain text, trimmed, for a picker row. */
  stemPreview: string;
  points: number;
  status: Status;
  tags: string[];
  objective?: string;
  chapter?: string;
  findingCount: number;
  hasErrors: boolean;
}

const PREVIEW_LENGTH = 160;

export function listQuestions(handle: BankHandle, query: Query = {}): QuestionSummary[] {
  return handle._bank.list(query).map(summarise);
}

export function summarise(question: Question): QuestionSummary {
  const live = liveFindings(question.findings);
  const plain = richTextToPlain(question.stem).replace(/\s+/g, " ");
  return {
    id: question.id,
    version: question.version,
    type: question.type,
    title: question.title,
    stemPreview: plain.length > PREVIEW_LENGTH ? `${plain.slice(0, PREVIEW_LENGTH - 1)}…` : plain,
    points: question.points,
    status: question.metadata.status,
    tags: question.metadata.tags,
    ...(question.metadata.objective ? { objective: question.metadata.objective } : {}),
    ...(question.metadata.chapter ? { chapter: question.metadata.chapter } : {}),
    findingCount: live.length,
    hasErrors: live.some((f) => f.severity === "error"),
  };
}

// ---------------------------------------------------------------------------
// 3. getQuestion
// ---------------------------------------------------------------------------

export function getQuestion(handle: BankHandle, id: string): Question | undefined {
  return handle._bank.get(id);
}

// ---------------------------------------------------------------------------
// 4. resolveLink
// ---------------------------------------------------------------------------

/**
 * What a course stores when it references a bank question.
 *
 * A link keeps a shared bank authoritative, which is what a department wants
 * for a common exam. An embed keeps a course openable on a machine that does
 * not have the bank, which is what an author wants when sending a course on.
 * Both are needed, so both are here, and `snapshot` is what makes the pair
 * work: a link carries a cached copy for the day the bank is missing.
 */
export interface QuestionLink {
  bankId: string;
  questionId: string;
  /** The version the course last saw. */
  version: number;
  /** A cached copy, for when the bank cannot be found. */
  snapshot?: Question;
}

export type LinkStatus = "current" | "stale" | "question-missing" | "bank-missing" | "bank-mismatch";

export interface LinkResolution {
  status: LinkStatus;
  /** The question to render, from the bank when possible and the snapshot otherwise. */
  question?: Question;
  storedVersion: number;
  currentVersion?: number;
  /** True when the consumer is showing a cached copy rather than the live one. */
  usingSnapshot: boolean;
  /** One line a consumer can show the author as is. */
  message: string;
}

export function resolveLink(link: QuestionLink, handle?: BankHandle): LinkResolution {
  if (!handle) {
    return {
      status: "bank-missing",
      ...(link.snapshot ? { question: link.snapshot } : {}),
      storedVersion: link.version,
      usingSnapshot: link.snapshot !== undefined,
      message: link.snapshot
        ? "The bank for this question is not open, so a saved copy is being shown. Open the bank to check for changes."
        : "The bank for this question is not open and no saved copy was stored, so it cannot be shown.",
    };
  }

  if (handle.bankId !== link.bankId) {
    return {
      status: "bank-mismatch",
      ...(link.snapshot ? { question: link.snapshot } : {}),
      storedVersion: link.version,
      usingSnapshot: link.snapshot !== undefined,
      message: `This question came from a different bank (${link.bankId}), so it was not matched against "${handle.title}".`,
    };
  }

  const current = handle._bank.get(link.questionId);
  if (!current) {
    return {
      status: "question-missing",
      ...(link.snapshot ? { question: link.snapshot } : {}),
      storedVersion: link.version,
      usingSnapshot: link.snapshot !== undefined,
      message: link.snapshot
        ? "This question is no longer in the bank. A saved copy is being shown."
        : "This question is no longer in the bank and no saved copy was stored.",
    };
  }

  if (current.version === link.version) {
    return {
      status: "current",
      question: current,
      storedVersion: link.version,
      currentVersion: current.version,
      usingSnapshot: false,
      message: "Up to date with the bank.",
    };
  }

  return {
    status: "stale",
    question: current,
    storedVersion: link.version,
    currentVersion: current.version,
    usingSnapshot: false,
    message: `The bank has a newer version of this question (${current.version}, this course has ${link.version}). Refresh to take the change.`,
  };
}

/** The reference a consumer should store after picking or refreshing. */
export function linkTo(handle: BankHandle, question: Question, opts: { embed?: boolean } = {}): QuestionLink {
  return {
    bankId: handle.bankId,
    questionId: question.id,
    version: question.version,
    ...(opts.embed === false ? {} : { snapshot: question }),
  };
}

// ---------------------------------------------------------------------------
// 5. supportedTypes
// ---------------------------------------------------------------------------

export function supportedTypes(consumer: Consumer): ConsumerCapability {
  return capabilityFor(consumer);
}

// ---------------------------------------------------------------------------
// 6. toDeliveryPayload
// ---------------------------------------------------------------------------

/**
 * A question reduced to what a consumer renders.
 *
 * No metadata, no history, no findings, no origin, no status. A player has no
 * business knowing a question's Bloom level or who last edited it, and leaving
 * those out means a published course carries no instructor-facing data.
 */
export interface DeliveryPayload {
  id: string;
  version: number;
  type: QuestionType;
  stem: string;
  points: number;
  interaction: DeliveryInteraction;
  feedback: { general?: string; correct?: string; incorrect?: string };
  media: Array<Pick<MediaRef, "id" | "file" | "mime" | "alt" | "decorative">>;
  math: Array<Pick<MathRef, "id" | "latex" | "mathml">>;
}

export type DeliveryInteraction =
  | { kind: "choice"; multiple: boolean; shuffle: boolean; options: Array<{ id: string; content: string; correct: boolean; feedback?: string }> }
  | { kind: "trueFalse"; correct: boolean }
  | { kind: "text"; caseSensitive: boolean; blanks: Array<{ id: string; accepted: string[] }> }
  | { kind: "matching"; shuffle: boolean; pairs: Array<{ id: string; left: string; right: string }>; distractors: string[] }
  | { kind: "ordering"; items: Array<{ id: string; content: string; position: number }> }
  | { kind: "numeric"; mode: "exact" | "range" | "tolerance"; value?: number; min?: number; max?: number; tolerance?: number; units?: string }
  | { kind: "openResponse"; expectedWords?: number };

export interface DeliveryResult {
  delivered: boolean;
  payload?: DeliveryPayload;
  /** Set when a fallback was applied, so the consumer can say so. */
  usedFallback?: { from: QuestionType; to: QuestionType; note: string };
  /** Set when the question cannot be delivered at all. */
  reason?: string;
}

function text(value: RichText | undefined): string | undefined {
  return value ? value.content : undefined;
}

function interactionFor(question: Question): DeliveryInteraction | undefined {
  const body = question.body as Record<string, any>;
  switch (question.type) {
    case "multipleChoice":
    case "multipleResponse":
      return {
        kind: "choice",
        multiple: question.type === "multipleResponse",
        shuffle: Boolean(body["shuffle"]),
        options: (body["options"] as Array<Record<string, any>>).map((o) => ({
          id: o["id"] as string,
          content: (o["content"] as RichText).content,
          correct: Boolean(o["correct"]),
          ...(o["feedback"] ? { feedback: (o["feedback"] as RichText).content } : {}),
        })),
      };
    case "trueFalse": {
      // An unkeyed item is not deliverable. Coercing undefined to false here
      // would hand a player a guessed answer that looks authored.
      const correct = body["correct"];
      if (typeof correct !== "boolean") return undefined;
      return { kind: "trueFalse", correct };
    }
    case "fillInBlank":
      return {
        kind: "text",
        caseSensitive: Boolean(body["caseSensitive"]),
        blanks: (body["blanks"] as Array<Record<string, any>>).map((b) => ({
          id: b["id"] as string,
          accepted: b["accepted"] as string[],
        })),
      };
    case "shortAnswer":
      return {
        kind: "text",
        caseSensitive: Boolean(body["caseSensitive"]),
        blanks: [{ id: "answer", accepted: body["accepted"] as string[] }],
      };
    case "matching":
      return {
        kind: "matching",
        shuffle: Boolean(body["shuffle"]),
        pairs: (body["pairs"] as Array<Record<string, any>>).map((p) => ({
          id: p["id"] as string,
          left: (p["left"] as RichText).content,
          right: p["right"] as string,
        })),
        distractors: (body["distractors"] as string[]) ?? [],
      };
    case "ordering":
      return {
        kind: "ordering",
        items: (body["items"] as Array<Record<string, any>>).map((i) => ({
          id: i["id"] as string,
          content: (i["content"] as RichText).content,
          position: i["position"] as number,
        })),
      };
    case "numeric":
      return {
        kind: "numeric",
        mode: body["mode"] as "exact" | "range" | "tolerance",
        ...(body["value"] !== undefined ? { value: body["value"] as number } : {}),
        ...(body["min"] !== undefined ? { min: body["min"] as number } : {}),
        ...(body["max"] !== undefined ? { max: body["max"] as number } : {}),
        ...(body["tolerance"] !== undefined ? { tolerance: body["tolerance"] as number } : {}),
        ...(body["units"] !== undefined ? { units: body["units"] as string } : {}),
      };
    case "essay":
      return {
        kind: "openResponse",
        ...(body["expectedWords"] !== undefined ? { expectedWords: body["expectedWords"] as number } : {}),
      };
    default:
      return undefined;
  }
}

function payloadFor(question: Question, type: QuestionType, interaction: DeliveryInteraction): DeliveryPayload {
  const feedback: DeliveryPayload["feedback"] = {};
  const general = text(question.feedback.general);
  const correct = text(question.feedback.correct);
  const incorrect = text(question.feedback.incorrect);
  if (general) feedback.general = general;
  if (correct) feedback.correct = correct;
  if (incorrect) feedback.incorrect = incorrect;

  return {
    id: question.id,
    version: question.version,
    type,
    stem: question.stem.content,
    points: question.points,
    interaction,
    feedback,
    media: question.media.map((m) => ({
      id: m.id,
      file: m.file,
      mime: m.mime,
      alt: m.alt,
      ...(m.decorative !== undefined ? { decorative: m.decorative } : {}),
    })),
    math: question.math.map((m) => ({ id: m.id, latex: m.latex, mathml: m.mathml })),
  };
}

export function toDeliveryPayload(question: Question, consumer: Consumer): DeliveryResult {
  const capability = capabilityFor(consumer);

  if (capability.supports.includes(question.type)) {
    const interaction = interactionFor(question);
    if (!interaction) {
      return {
        delivered: false,
        reason: `${capability.label} lists ${question.type} as supported but the engine has no delivery shape for it yet.`,
      };
    }
    return { delivered: true, payload: payloadFor(question, question.type, interaction) };
  }

  const fallback: Fallback | undefined = capability.fallbacks[question.type];
  if (!fallback || fallback.to === "none") {
    return {
      delivered: false,
      reason: fallback?.note ?? `${capability.label} cannot deliver a ${question.type} question.`,
    };
  }

  const converted = convert(question, fallback.to);
  if (!converted) {
    return { delivered: false, reason: `No conversion from ${question.type} to ${fallback.to} is implemented yet.` };
  }
  const interaction = interactionFor(converted);
  if (!interaction) {
    return { delivered: false, reason: `No delivery shape for ${fallback.to}.` };
  }
  return {
    delivered: true,
    payload: payloadFor(converted, fallback.to, interaction),
    usedFallback: { from: question.type, to: fallback.to, note: fallback.note },
  };
}

/**
 * Fallback conversions. Kept deliberately small: a conversion that changes
 * what a question asks is worse than a refusal, so anything that cannot be
 * done honestly returns undefined and the destination check says so.
 */
function convert(question: Question, to: QuestionType): Question | undefined {
  const body = question.body as Record<string, any>;

  void body;
  void to;

  // Calculated to numeric was here, and it was dishonest: it discarded the
  // formula and the variables and wrote value 0, so the delivered item asked
  // an unsubstituted question and scored a fabricated answer as correct. Doing
  // it properly means evaluating the formula over a generated variable set,
  // which is a feature of the calculated type rather than a fallback, and it
  // arrives with that type. Until then the destination check says the type
  // cannot be delivered, which is true.
  //
  // Hotspot to multiple choice was here for the same reason. It labelled the
  // options "Region 1", "Region 2" and so on, which mean nothing once the
  // image is gone, and a single-region item produced a one-option question
  // that the model itself rejects. The accessible alternative is the path
  // forward, and it needs authored region labels before it is worth anything.

  return undefined;
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

/**
 * A contract check a consumer can run in its own tests. If this throws, the
 * consumer is depending on something this version does not promise.
 */
export function assertContract(version: string): void {
  const [major] = version.split(".");
  const [ourMajor] = READ_CONTRACT_VERSION.split(".");
  if (major !== ourMajor) {
    throw new Error(
      `This build provides read contract ${READ_CONTRACT_VERSION} and the caller asked for ${version}. ` +
        `A major version difference means the shapes changed.`,
    );
  }
}
