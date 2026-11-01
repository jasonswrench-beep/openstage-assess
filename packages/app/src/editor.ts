/**
 * The question as the editing screen shows it, and back.
 *
 * The screen works in plain text and simple lists. The engine stores rich text, ids and a body for each type. This turns one
 * into the other, and is where three rules of the product are kept:
 *
 *  - Text the person did not change is kept exactly as stored, formatting and all. An editor that wrote every field back
 *    would flatten the bold in a stem the person never touched.
 *  - Text that holds a picture or an equation cannot be edited as plain text, and is refused, not rewritten without its
 *    picture.
 *  - A key is never filled in. A true or false question left unmarked stays unmarked, and the engine's own check says so.
 */

import {
  createQuestion,
  isEmptyRichText,
  localId,
  plainToRich,
  richTextToPlain,
  titleFromStem,
  verdictOf,
  withRecomputedFindings,
  type Feedback,
  type Finding,
  type Metadata,
  type Question,
  type QuestionBody,
  type QuestionEdit,
  type QuestionType,
  type RichText,
} from "./engine.ts";
import { QUESTION_TYPES } from "./engine.ts";
import { badRequest } from "./errors.ts";

const EDITABLE: readonly QuestionType[] = ["multipleChoice", "multipleResponse", "trueFalse", "fillInBlank", "shortAnswer", "matching", "ordering", "numeric", "essay"];
const STATUSES = ["draft", "reviewed", "approved", "retired"] as const;
const DIFFICULTIES = ["easy", "medium", "hard"] as const;
const BLOOM = ["remember", "understand", "apply", "analyze", "evaluate", "create"] as const;

/** More than anyone writes, so that a mistake in the screen cannot make a bank of a million rows. */
const MAX_ROWS = 200;
const MAX_TEXT = 100_000;

export interface EditorOption {
  id?: string;
  text: string;
  correct: boolean;
  feedback: string;
}

export interface EditorBody {
  options?: EditorOption[];
  shuffle?: boolean;
  partialCredit?: boolean;
  /** true, false, or null when no answer is given. */
  correct?: boolean | null;
  blanks?: Array<{ id?: string; label: string; accepted: string[] }>;
  caseSensitive?: boolean;
  accepted?: string[];
  pairs?: Array<{ id?: string; left: string; right: string }>;
  distractors?: string[];
  items?: Array<{ id?: string; text: string }>;
  mode?: "exact" | "range" | "tolerance";
  value?: number | null;
  min?: number | null;
  max?: number | null;
  tolerance?: number | null;
  units?: string;
  modelAnswer?: string;
}

export interface EditorInput {
  type: QuestionType;
  title: string;
  stem: string;
  points: number;
  feedback: { general: string; correct: string; incorrect: string };
  metadata: {
    status: (typeof STATUSES)[number];
    difficulty: string;
    bloom: string;
    objective: string;
    chapter: string;
    section: string;
    page: string;
    tags: string[];
  };
  body: EditorBody;
}

/** What the screen is given for a question: the input shape, and what it needs to know besides. */
export interface EditorQuestion extends EditorInput {
  id: string;
  version: number;
  verdict: "parsed" | "needsReview" | "failed";
  findings: Array<Finding & { index: number }>;
  /** Fields that hold formatting, which editing as plain text would flatten. */
  formatted: string[];
  /** Fields that hold a picture or an equation, which cannot be edited as plain text. */
  locked: string[];
  /** Pictures and equations the question carries. */
  media: number;
  math: number;
  /** Why the question cannot be edited here at all, when it cannot. */
  readOnly?: string;
  origin?: Question["origin"];
}

// ---------------------------------------------------------------------------
// Reading what the screen sent
// ---------------------------------------------------------------------------

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

class Reader {
  readonly errors: string[] = [];

  string(value: unknown, where: string, fallback = ""): string {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== "string") {
      this.errors.push(`${where} must be text.`);
      return fallback;
    }
    if (value.length > MAX_TEXT) {
      this.errors.push(`${where} is longer than ${MAX_TEXT.toLocaleString("en-US")} characters.`);
      return fallback;
    }
    return value;
  }

  bool(value: unknown, where: string, fallback: boolean): boolean {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== "boolean") {
      this.errors.push(`${where} must be true or false.`);
      return fallback;
    }
    return value;
  }

  number(value: unknown, where: string): number | null {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      this.errors.push(`${where} must be a number.`);
      return null;
    }
    return value;
  }

  list<T>(value: unknown, where: string, each: (item: unknown, at: string) => T): T[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
      this.errors.push(`${where} must be a list.`);
      return [];
    }
    if (value.length > MAX_ROWS) {
      this.errors.push(`${where} has more than ${MAX_ROWS} rows.`);
      return [];
    }
    return value.map((item, i) => each(item, `${where} ${i + 1}`));
  }

  strings(value: unknown, where: string): string[] {
    return this.list(value, where, (item, at) => this.string(item, at));
  }

  id(value: unknown, where: string): string | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
      this.errors.push(`${where} has an id that is not allowed.`);
      return undefined;
    }
    return value;
  }
}

/** The screen's question, checked for shape. Nothing is read from it that is not named here. */
export function parseInput(raw: unknown): { ok: true; input: EditorInput } | { ok: false; errors: string[] } {
  if (!isObject(raw)) return { ok: false, errors: ["The question was not sent as an object."] };
  const r = new Reader();

  const type = raw["type"];
  if (typeof type !== "string" || !(QUESTION_TYPES as readonly string[]).includes(type)) {
    return { ok: false, errors: ["The question type is not one that OpenAssess knows."] };
  }
  if (!EDITABLE.includes(type as QuestionType)) {
    return { ok: false, errors: [`A ${type} question cannot be edited here yet.`] };
  }

  const feedback = isObject(raw["feedback"]) ? raw["feedback"] : {};
  const metadata = isObject(raw["metadata"]) ? raw["metadata"] : {};
  const body = isObject(raw["body"]) ? raw["body"] : {};

  const status = r.string(metadata["status"], "The status", "draft");
  if (!(STATUSES as readonly string[]).includes(status)) r.errors.push("The status is not one that OpenAssess knows.");
  const difficulty = r.string(metadata["difficulty"], "The difficulty");
  if (difficulty !== "" && !(DIFFICULTIES as readonly string[]).includes(difficulty)) r.errors.push("The difficulty is not one that OpenAssess knows.");
  const bloom = r.string(metadata["bloom"], "The Bloom level");
  if (bloom !== "" && !(BLOOM as readonly string[]).includes(bloom)) r.errors.push("The Bloom level is not one that OpenAssess knows.");

  const points = r.number(raw["points"], "The points");
  if (points !== null && (points < 0 || points > 1000)) r.errors.push("The points must be between 0 and 1000.");

  const input: EditorInput = {
    type: type as QuestionType,
    title: r.string(raw["title"], "The title"),
    stem: r.string(raw["stem"], "The question text"),
    points: points ?? 1,
    feedback: {
      general: r.string(feedback["general"], "The general feedback"),
      correct: r.string(feedback["correct"], "The feedback for a right answer"),
      incorrect: r.string(feedback["incorrect"], "The feedback for a wrong answer"),
    },
    metadata: {
      status: (STATUSES as readonly string[]).includes(status) ? (status as (typeof STATUSES)[number]) : "draft",
      difficulty,
      bloom,
      objective: r.string(metadata["objective"], "The objective"),
      chapter: r.string(metadata["chapter"], "The chapter"),
      section: r.string(metadata["section"], "The section"),
      page: r.string(metadata["page"], "The page"),
      tags: r.strings(metadata["tags"], "A tag").map((t) => t.trim()).filter((t) => t !== ""),
    },
    body: {},
  };

  const out = input.body;
  switch (input.type) {
    case "multipleChoice":
    case "multipleResponse":
      out.options = r.list(body["options"], "Option", (item, at) => {
        const o = isObject(item) ? item : {};
        const id = r.id(o["id"], at);
        return {
          ...(id ? { id } : {}),
          text: r.string(o["text"], at),
          correct: r.bool(o["correct"], `${at} (right)`, false),
          feedback: r.string(o["feedback"], `${at} (feedback)`),
        };
      });
      out.shuffle = r.bool(body["shuffle"], "Shuffle", true);
      if (input.type === "multipleResponse") out.partialCredit = r.bool(body["partialCredit"], "Partial credit", true);
      break;
    case "trueFalse": {
      const value = body["correct"];
      if (value !== undefined && value !== null && typeof value !== "boolean") r.errors.push("The answer must be True, False or empty.");
      out.correct = typeof value === "boolean" ? value : null;
      break;
    }
    case "fillInBlank":
      out.blanks = r.list(body["blanks"], "Blank", (item, at) => {
        const o = isObject(item) ? item : {};
        const id = r.id(o["id"], at);
        return { ...(id ? { id } : {}), label: r.string(o["label"], at), accepted: r.strings(o["accepted"], `${at} (answers)`) };
      });
      out.caseSensitive = r.bool(body["caseSensitive"], "Case sensitive", false);
      break;
    case "shortAnswer":
      out.accepted = r.strings(body["accepted"], "An accepted answer");
      out.caseSensitive = r.bool(body["caseSensitive"], "Case sensitive", false);
      break;
    case "matching":
      out.pairs = r.list(body["pairs"], "Pair", (item, at) => {
        const o = isObject(item) ? item : {};
        const id = r.id(o["id"], at);
        return { ...(id ? { id } : {}), left: r.string(o["left"], `${at} (left)`), right: r.string(o["right"], `${at} (right)`) };
      });
      out.distractors = r.strings(body["distractors"], "A spare answer");
      break;
    case "ordering":
      out.items = r.list(body["items"], "Item", (item, at) => {
        const o = isObject(item) ? item : {};
        const id = r.id(o["id"], at);
        return { ...(id ? { id } : {}), text: r.string(o["text"], at) };
      });
      break;
    case "numeric": {
      const mode = r.string(body["mode"], "The mode", "exact");
      if (mode !== "exact" && mode !== "range" && mode !== "tolerance") r.errors.push("The numeric mode must be exact, range or tolerance.");
      out.mode = mode === "range" || mode === "tolerance" ? mode : "exact";
      out.value = r.number(body["value"], "The value");
      out.min = r.number(body["min"], "The lowest value");
      out.max = r.number(body["max"], "The highest value");
      out.tolerance = r.number(body["tolerance"], "The tolerance");
      out.units = r.string(body["units"], "The units");
      break;
    }
    case "essay":
      out.modelAnswer = r.string(body["modelAnswer"], "The model answer");
      break;
    default:
      break;
  }

  if (r.errors.length > 0) return { ok: false, errors: r.errors };
  return { ok: true, input };
}

// ---------------------------------------------------------------------------
// The engine's question, for the screen
// ---------------------------------------------------------------------------

const FORMATTING = /<(strong|em|u|s|sub|sup|code|pre|ul|ol|li|blockquote|table|thead|tbody|tr|th|td)[\s>/]/i;
const HOLDS_OBJECT = /<oa-(media|math)\b/i;

const plain = (text: RichText | undefined): string => (text && !isEmptyRichText(text) ? richTextToPlain(text) : "");
const hasFormatting = (text: RichText | undefined): boolean => text !== undefined && text.format === "rich" && FORMATTING.test(text.content);
const holdsObject = (text: RichText | undefined): boolean => text !== undefined && HOLDS_OBJECT.test(text.content);

type Dict = Record<string, unknown>;

/** Every text field of a question with its place, so that formatting and objects can be found in one walk. */
function textFields(q: Question): Array<[string, RichText | undefined]> {
  const fields: Array<[string, RichText | undefined]> = [
    ["stem", q.stem],
    ["feedback.general", q.feedback.general],
    ["feedback.correct", q.feedback.correct],
    ["feedback.incorrect", q.feedback.incorrect],
  ];
  const body = q.body as unknown as Dict;
  const options = body["options"];
  if (Array.isArray(options)) (options as Array<{ content?: RichText; feedback?: RichText }>).forEach((o, i) => {
    fields.push([`options.${i}`, o.content], [`options.${i}.feedback`, o.feedback]);
  });
  const pairs = body["pairs"];
  if (Array.isArray(pairs)) (pairs as Array<{ left?: RichText }>).forEach((p, i) => fields.push([`pairs.${i}.left`, p.left]));
  const items = body["items"];
  if (Array.isArray(items)) (items as Array<{ content?: RichText }>).forEach((it, i) => fields.push([`items.${i}`, it.content]));
  return fields;
}

function bodyToEditor(q: Question): EditorBody {
  const body = q.body as unknown as Dict;
  switch (q.type) {
    case "multipleChoice":
    case "multipleResponse":
      return {
        options: (body["options"] as Array<{ id: string; content: RichText; correct: boolean; feedback?: RichText }>).map((o) => ({
          id: o.id,
          text: plain(o.content),
          correct: o.correct,
          feedback: plain(o.feedback),
        })),
        shuffle: body["shuffle"] !== false,
        ...(q.type === "multipleResponse" ? { partialCredit: body["partialCredit"] !== false } : {}),
      };
    case "trueFalse":
      return { correct: typeof body["correct"] === "boolean" ? (body["correct"] as boolean) : null };
    case "fillInBlank":
      return {
        blanks: (body["blanks"] as Array<{ id: string; label?: string; accepted: string[] }>).map((b) => ({ id: b.id, label: b.label ?? "", accepted: [...b.accepted] })),
        caseSensitive: body["caseSensitive"] === true,
      };
    case "shortAnswer":
      return { accepted: [...(body["accepted"] as string[])], caseSensitive: body["caseSensitive"] === true };
    case "matching":
      return {
        pairs: (body["pairs"] as Array<{ id: string; left: RichText; right: string }>).map((p) => ({ id: p.id, left: plain(p.left), right: p.right })),
        distractors: [...((body["distractors"] as string[] | undefined) ?? [])],
      };
    case "ordering":
      return {
        items: [...(body["items"] as Array<{ id: string; content: RichText; position: number }>)]
          .sort((a, b) => a.position - b.position)
          .map((it) => ({ id: it.id, text: plain(it.content) })),
      };
    case "numeric":
      return {
        mode: body["mode"] as "exact" | "range" | "tolerance",
        value: typeof body["value"] === "number" ? (body["value"] as number) : null,
        min: typeof body["min"] === "number" ? (body["min"] as number) : null,
        max: typeof body["max"] === "number" ? (body["max"] as number) : null,
        tolerance: typeof body["tolerance"] === "number" ? (body["tolerance"] as number) : null,
        units: typeof body["units"] === "string" ? (body["units"] as string) : "",
      };
    case "essay":
      return { modelAnswer: plain(body["modelAnswer"] as RichText | undefined) };
    default:
      return {};
  }
}

export function toEditor(q: Question): EditorQuestion {
  const fields = textFields(q);
  const readOnly = EDITABLE.includes(q.type) ? undefined : `A ${q.type} question cannot be edited here yet. It is shown as it is stored, and nothing about it is changed.`;
  return {
    id: q.id,
    version: q.version,
    type: q.type,
    title: q.title,
    stem: plain(q.stem),
    points: q.points,
    feedback: { general: plain(q.feedback.general), correct: plain(q.feedback.correct), incorrect: plain(q.feedback.incorrect) },
    metadata: {
      status: q.metadata.status,
      difficulty: q.metadata.difficulty ?? "",
      bloom: q.metadata.bloom ?? "",
      objective: q.metadata.objective ?? "",
      chapter: q.metadata.chapter ?? "",
      section: q.metadata.section ?? "",
      page: q.metadata.page ?? "",
      tags: [...q.metadata.tags],
    },
    body: readOnly ? {} : bodyToEditor(q),
    verdict: verdictOf(q),
    findings: q.findings.map((f, index) => ({ ...f, index })),
    formatted: fields.filter(([, t]) => hasFormatting(t)).map(([where]) => where),
    locked: fields.filter(([, t]) => holdsObject(t)).map(([where]) => where),
    media: q.media.length,
    math: q.math.length,
    ...(readOnly ? { readOnly } : {}),
    ...(q.origin ? { origin: q.origin } : {}),
  };
}

// ---------------------------------------------------------------------------
// What the screen sent, for the engine
// ---------------------------------------------------------------------------

interface Built {
  /** Fields whose formatting was flattened because the person changed their text. */
  flattened: string[];
}

/** The stored text if the person left it alone, and plain text made rich if they changed it. */
function textFor(next: string, previous: RichText | undefined, where: string, built: Built): RichText {
  if (previous !== undefined) {
    if (holdsObject(previous)) {
      if (next === plain(previous)) return previous;
      throw badRequest(`The text in ${where} holds a picture or an equation, which cannot be edited as plain text yet, so nothing was changed.`);
    }
    if (next === plain(previous)) return previous;
    if (hasFormatting(previous)) built.flattened.push(where);
  }
  return plainToRich(next);
}

const optionalText = (next: string, previous: RichText | undefined, where: string, built: Built): RichText | undefined =>
  next.trim() === "" ? undefined : textFor(next, previous, where, built);

/** The first `prefix` + n id not already used, so that a new row never takes the id of one that is kept. */
function freshId(prefix: string, taken: Set<string>): string {
  for (let n = 0; ; n++) {
    const id = localId(prefix, n);
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

function buildBody(input: EditorInput, base: Question | undefined, built: Built): QuestionBody {
  const b = input.body;
  const old = base && base.type === input.type ? (base.body as unknown as Dict) : undefined;

  switch (input.type) {
    case "multipleChoice":
    case "multipleResponse": {
      const previous = new Map((((old?.["options"]) as Array<{ id: string; content: RichText; feedback?: RichText }> | undefined) ?? []).map((o) => [o.id, o]));
      const taken = new Set((b.options ?? []).flatMap((o) => (o.id ? [o.id] : [])));
      const options = (b.options ?? []).map((o, i) => {
        const id = o.id ?? freshId("o", taken);
        const was = o.id ? previous.get(o.id) : undefined;
        const feedback = optionalText(o.feedback, was?.feedback, `option ${i + 1}'s feedback`, built);
        return {
          id,
          content: textFor(o.text, was?.content, `option ${i + 1}`, built),
          correct: o.correct,
          ...(feedback ? { feedback } : {}),
        };
      });
      const shuffle = b.shuffle !== false;
      return input.type === "multipleResponse" ? { shuffle, partialCredit: b.partialCredit !== false, options } : { shuffle, options };
    }
    case "trueFalse":
      // Unset stays unset. A question with no answer is a question with no answer.
      return typeof b.correct === "boolean" ? { correct: b.correct } : {};
    case "fillInBlank": {
      const taken = new Set((b.blanks ?? []).flatMap((x) => (x.id ? [x.id] : [])));
      return {
        caseSensitive: b.caseSensitive === true,
        blanks: (b.blanks ?? []).map((x) => ({
          id: x.id ?? freshId("b", taken),
          ...(x.label.trim() !== "" ? { label: x.label.trim() } : {}),
          accepted: x.accepted.map((a) => a.trim()).filter((a) => a !== ""),
        })),
      };
    }
    case "shortAnswer":
      return { caseSensitive: b.caseSensitive === true, accepted: (b.accepted ?? []).map((a) => a.trim()).filter((a) => a !== "") };
    case "matching": {
      const previous = new Map((((old?.["pairs"]) as Array<{ id: string; left: RichText }> | undefined) ?? []).map((p) => [p.id, p]));
      const taken = new Set((b.pairs ?? []).flatMap((p) => (p.id ? [p.id] : [])));
      return {
        shuffle: true,
        distractors: (b.distractors ?? []).map((d) => d.trim()).filter((d) => d !== ""),
        pairs: (b.pairs ?? []).map((p, i) => ({
          id: p.id ?? freshId("p", taken),
          left: textFor(p.left, p.id ? previous.get(p.id)?.left : undefined, `pair ${i + 1}`, built),
          right: p.right.trim(),
        })),
      };
    }
    case "ordering": {
      const previous = new Map((((old?.["items"]) as Array<{ id: string; content: RichText }> | undefined) ?? []).map((it) => [it.id, it]));
      const taken = new Set((b.items ?? []).flatMap((it) => (it.id ? [it.id] : [])));
      return {
        items: (b.items ?? []).map((it, i) => ({
          id: it.id ?? freshId("i", taken),
          content: textFor(it.text, it.id ? previous.get(it.id)?.content : undefined, `item ${i + 1}`, built),
          position: i + 1,
        })),
      };
    }
    case "numeric": {
      const mode = b.mode ?? "exact";
      return {
        mode,
        ...(typeof b.value === "number" ? { value: b.value } : {}),
        ...(typeof b.min === "number" ? { min: b.min } : {}),
        ...(typeof b.max === "number" ? { max: b.max } : {}),
        ...(typeof b.tolerance === "number" ? { tolerance: b.tolerance } : {}),
        ...((b.units ?? "").trim() !== "" ? { units: (b.units ?? "").trim() } : {}),
      };
    }
    case "essay": {
      const text = (b.modelAnswer ?? "").trim() === "" ? undefined : textFor(b.modelAnswer ?? "", (old?.["modelAnswer"]) as RichText | undefined, "the model answer", built);
      return text ? { modelAnswer: text } : {};
    }
    default:
      throw badRequest(`A ${input.type} question cannot be edited here yet.`);
  }
}

function buildFeedback(input: EditorInput, base: Question | undefined, built: Built): Feedback {
  const general = optionalText(input.feedback.general, base?.feedback.general, "the general feedback", built);
  const correct = optionalText(input.feedback.correct, base?.feedback.correct, "the feedback for a right answer", built);
  const incorrect = optionalText(input.feedback.incorrect, base?.feedback.incorrect, "the feedback for a wrong answer", built);
  return { ...(general ? { general } : {}), ...(correct ? { correct } : {}), ...(incorrect ? { incorrect } : {}) };
}

function buildMetadata(input: EditorInput, base: Metadata | undefined): Metadata {
  const m = input.metadata;
  const text = (value: string): string | undefined => (value.trim() === "" ? undefined : value.trim());
  const next: Metadata = { ...(base ?? { tags: [], status: "draft" }), tags: [...new Set(m.tags)], status: m.status };
  // A field the person emptied is set to undefined, not deleted: the engine merges an edit's metadata over the stored
  // metadata, so a key that is simply absent from the edit would leave the old value in place.
  const set = <K extends "objective" | "chapter" | "section" | "page">(key: K, value: string): void => {
    next[key] = text(value);
  };
  set("objective", m.objective);
  set("chapter", m.chapter);
  set("section", m.section);
  set("page", m.page);
  next.difficulty = m.difficulty === "" ? undefined : (m.difficulty as NonNullable<Metadata["difficulty"]>);
  next.bloom = m.bloom === "" ? undefined : (m.bloom as NonNullable<Metadata["bloom"]>);
  return next;
}

export interface BuiltEdit {
  edit: QuestionEdit;
  /** Places where the person's change turned formatted text into plain text, said back to them. */
  flattened: string[];
}

/** The change the screen asks for, as an engine edit. A title the person has not touched follows the question text. */
export function editFromInput(base: Question, input: EditorInput): BuiltEdit {
  if (!EDITABLE.includes(base.type)) throw badRequest(`A ${base.type} question cannot be edited here yet, so nothing was changed.`);
  const built: Built = { flattened: [] };
  const stem = textFor(input.stem, base.stem, "the question text", built);
  const titleWasAutomatic = base.title === titleFromStem(plain(base.stem));
  const title = input.title.trim() !== "" && input.title !== base.title ? input.title.trim() : titleWasAutomatic ? titleFromStem(plain(stem)) : base.title;
  return {
    edit: {
      type: input.type,
      title: title === "" ? base.title : title,
      stem,
      points: input.points,
      body: buildBody(input, base, built),
      feedback: buildFeedback(input, base, built),
      metadata: buildMetadata(input, base.metadata),
    },
    flattened: built.flattened,
  };
}

/**
 * What is missing that the bank cannot do without, in words for the person. The model refuses a question or an option with
 * no text at all, and its own message says so in terms of its fields. A key is not on this list: a question with no right
 * answer marked is kept, and the engine's check says so.
 */
export function missingText(input: EditorInput): string[] {
  const problems: string[] = [];
  if (input.stem.trim() === "") problems.push("The question needs some text.");
  const b = input.body;
  (b.options ?? []).forEach((o, i) => {
    if (o.text.trim() === "") problems.push(`Option ${i + 1} has no text. Write something, or remove it.`);
  });
  (b.pairs ?? []).forEach((p, i) => {
    if (p.left.trim() === "") problems.push(`Pair ${i + 1} has nothing on the left. Write something, or remove it.`);
  });
  (b.items ?? []).forEach((it, i) => {
    if (it.text.trim() === "") problems.push(`Item ${i + 1} has no text. Write something, or remove it.`);
  });
  return problems;
}

/**
 * A new question from the screen. By whom is recorded in its history; nothing else about it is assumed. Its answer key is
 * checked before it is kept: a question made here with no right answer marked has to say so from the first moment, not
 * only after it has been edited.
 */
export function questionFromInput(input: EditorInput, by: string, at?: string): Question {
  const built: Built = { flattened: [] };
  return withRecomputedFindings(
    createQuestion({
      type: input.type,
      stem: plainToRich(input.stem),
      ...(input.title.trim() !== "" ? { title: input.title.trim() } : {}),
      points: input.points,
      body: buildBody(input, undefined, built),
      feedback: buildFeedback(input, undefined, built),
      metadata: buildMetadata(input, undefined),
      origin: { kind: "authored", at: at ?? new Date().toISOString() },
      by,
      ...(at ? { at } : {}),
    }),
  );
}

/** An empty question of a type, for the screen to start from. It has no key, and says so once it is checked. */
export function blankInput(type: QuestionType): EditorInput {
  const body: EditorBody = {};
  switch (type) {
    case "multipleChoice":
    case "multipleResponse":
      body.options = ["", "", "", ""].map((text) => ({ text, correct: false, feedback: "" }));
      body.shuffle = true;
      if (type === "multipleResponse") body.partialCredit = true;
      break;
    case "trueFalse":
      body.correct = null;
      break;
    case "fillInBlank":
      body.blanks = [{ label: "", accepted: [] }];
      body.caseSensitive = false;
      break;
    case "shortAnswer":
      body.accepted = [];
      body.caseSensitive = false;
      break;
    case "matching":
      body.pairs = [{ left: "", right: "" }, { left: "", right: "" }];
      body.distractors = [];
      break;
    case "ordering":
      body.items = [{ text: "" }, { text: "" }];
      break;
    case "numeric":
      body.mode = "exact";
      body.value = null;
      body.units = "";
      break;
    case "essay":
      body.modelAnswer = "";
      break;
    default:
      break;
  }
  return {
    type,
    title: "",
    stem: "",
    points: 1,
    feedback: { general: "", correct: "", incorrect: "" },
    metadata: { status: "draft", difficulty: "", bloom: "", objective: "", chapter: "", section: "", page: "", tags: [] },
    body,
  };
}

export const EDITABLE_TYPES = EDITABLE;
