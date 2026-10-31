/**
 * Profile one: the standard test-bank text format, read from plain text.
 *
 * The format documented in the appendix of the test-bank vendor's manual is the
 * closest thing this field has to a shared plain-text convention, and a very
 * large number of publisher test banks are already written to it. Supporting
 * it is the cheapest path to a high parse rate, and it is also what gives a
 * the test-bank vendor user a reason to try OpenAssess.
 *
 * What this reads:
 *
 *   Title: ...            a title, otherwise taken from the stem
 *   Type: E | F | S | MT | MA | MR   essay, fill in blank, short answer,
 *                         matching, multiple answer (MA and MR are the same)
 *   Type: FMB | ORD | JUM  documented by D2L and Blackboard, refused by name
 *   Points: 2.5           applies to this question and every one after it
 *   3) stem               a question number, a period or a parenthesis
 *   *b) option            an asterisk marks the correct option
 *   a. left = right       a matching pair
 *   ~ text                feedback for a correct answer
 *   @ text                feedback for an incorrect answer, or for the option above
 *   Answers:              a key list, by question number, covering the questions before it
 *   [ img: "f.jpg" "alt" ]  an image with alternative text
 *   [HTML] ... [/HTML]    a block of raw HTML
 *
 * Reading the lines into questions is `standard-text-scan.ts`. This file turns
 * what the scanner found into the question model.
 *
 * Two behaviours in the the test-bank vendor specification are defects, and are fixed
 * rather than copied. When no correct answer is marked, the test-bank vendor silently
 * selects option A; here the question is flagged and nothing is guessed. And
 * titles truncate at 20 characters on import while the editor allows 64; here
 * the full 64 are used and a word boundary is respected.
 */

import { finding, FindingCode, type Finding, type SourceRef } from "../model/findings.ts";
import { localId } from "../model/ids.ts";
import {
  escapeHtml,
  normalizeCharacters,
  mediaPlaceholder,
  plainToRich,
  richTextToPlain,
  sanitizeRichText,
  type RichText,
} from "../model/richtext.ts";
import { addFindings, createQuestion, DEFAULT_POINTS, emptyMetadata } from "../model/create.ts";
import { checkAnswerKey } from "../quality/answer-key.ts";
import { applyFormattingKey } from "./standard-text-format.ts";
import {
  MAX_POINTS,
  MAX_TITLE_LENGTH,
  titleFromStem,
  type BloomLevel,
  type Difficulty,
  type MediaRef,
  type Metadata,
  type Option,
  type Question,
  type QuestionBody,
  type QuestionType,
} from "../model/question.ts";
import {
  KEY_SPLIT,
  KEY_VALUE,
  METADATA_LABELS,
  NOTE_LABELS,
  scanStandardText,
  type RawOption,
  type RawQuestion,
} from "./standard-text-scan.ts";
import {
  countVerdicts,
  linesToBlocks,
  type Importer,
  type ImportOptions,
  type ImportResult,
  type SourceBlock,
  type SourceRun,
} from "./types.ts";

export const PROFILE_ID = "standard-text";

/**
 * The text put where the schema insists on content and the source had none.
 * Only ever beside an error finding, so that the question fails and cannot be
 * mistaken for one that was authored this way. See `STORED_KEY_PROBLEMS`.
 */
const PLACEHOLDER = "(missing)";

const IMAGE_TAG = /\[\s*img\s*:\s*"([^"]*)"(?:\s*"([^"]*)")?\s*\]/gi;
const HTML_BLOCK = /\[HTML\]([\s\S]*?)\[\/HTML\]/gi;

const DIFFICULTY_WORDS: Record<string, Difficulty> = {
  easy: "easy",
  simple: "easy",
  low: "easy",
  "1": "easy",
  moderate: "medium",
  medium: "medium",
  average: "medium",
  "2": "medium",
  hard: "hard",
  difficult: "hard",
  challenging: "hard",
  high: "hard",
  "3": "hard",
};

const BLOOM_WORDS: Record<string, BloomLevel> = {
  remember: "remember",
  remembering: "remember",
  knowledge: "remember",
  recall: "remember",
  understand: "understand",
  understanding: "understand",
  comprehension: "understand",
  apply: "apply",
  application: "apply",
  applying: "apply",
  analyze: "analyze",
  analyse: "analyze",
  analysis: "analyze",
  evaluate: "evaluate",
  evaluation: "evaluate",
  synthesis: "create",
  create: "create",
  creating: "create",
};

// ---------------------------------------------------------------------------
// Pass two: raw questions to the model
// ---------------------------------------------------------------------------

interface TextConversion {
  rich: RichText;
  media: MediaRef[];
  findings: Finding[];
}

/** Turn source text into the restricted subset, pulling out images and raw HTML. */
function toRichText(lines: string[], source: SourceRef, idPrefix: string): TextConversion {
  const media: MediaRef[] = [];
  const findings: Finding[] = [];
  let text = normalizeCharacters(lines.join("\n")).trim();

  const htmlBlocks: string[] = [];
  text = text.replace(HTML_BLOCK, (_whole, inner: string) => {
    const cleaned = sanitizeRichText(inner);
    if (cleaned.removedTags.length > 0) {
      findings.push(
        finding(
          FindingCode.MarkupRemoved,
          "warn",
          `Markup not in the supported subset was removed from a raw HTML block: ${cleaned.removedTags.join(", ")}.`,
          { source },
        ),
      );
    }
    htmlBlocks.push(cleaned.html);
    return `\u0000HTML${htmlBlocks.length - 1}\u0000`;
  });

  let imageCount = 0;
  text = text.replace(IMAGE_TAG, (_whole, fileName: string, alt?: string) => {
    const id = `${idPrefix}_m${++imageCount}`;
    const altText = (alt ?? "").trim();
    media.push({
      id,
      file: `media/${fileName}`,
      mime: guessMime(fileName),
      alt: altText,
    });
    if (altText.length === 0) {
      findings.push(
        finding(
          FindingCode.MissingAltText,
          "warn",
          `The image "${fileName}" has no alternative text. A screen reader will announce nothing for it.`,
          { source, field: "media" },
        ),
      );
    }
    return `\u0000IMG${media.length - 1}\u0000`;
  });

  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`);

  let html = paragraphs.join("");
  html = html.replace(/\u0000HTML(\d+)\u0000/g, (_w, i: string) => htmlBlocks[Number(i)] ?? "");
  html = html.replace(/\u0000IMG(\d+)\u0000/g, (_w, i: string) => {
    const ref = media[Number(i)];
    return ref ? mediaPlaceholder(ref.id) : "";
  });

  return { rich: { format: "rich", content: html }, media, findings };
}

function guessMime(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "image/jpeg";
}

/**
 * A "KEY:" line as publishers write it for a question's classification: fields with their
 * own labels, separated by bars ("KEY: Cognitive Level: Application | Client Need: Safe
 * Care"). Each field is read as a line of metadata of its own, so that "Cognitive Level"
 * becomes the Bloom level. A KEY line that is not shaped like that is left as one label,
 * which is not one this profile knows, and is reported as that.
 */
function expandKeyLine(entry: RawQuestion["metadata"][number]): Array<RawQuestion["metadata"][number] & { fromKey?: boolean }> {
  if (entry.label.toLowerCase() !== "key") return [entry];
  const parts = entry.value.split("|").map((p) => p.trim()).filter((p) => p.length > 0);
  const fields = parts.map((p) => /^([A-Za-z][A-Za-z' ]{1,40}?)\s*:\s*(\S.*)$/.exec(p));
  if (parts.length < 2 || fields.some((f) => f === null)) return [entry];
  return fields.map((f) => ({ label: (f?.[1] ?? "").trim(), value: (f?.[2] ?? "").trim(), block: entry.block, fromKey: true }));
}

function applyMetadata(raw: RawQuestion, file: string): { metadata: Metadata; findings: Finding[] } {
  const metadata: Metadata = emptyMetadata();
  const findings: Finding[] = [];
  const custom: Record<string, string> = {};

  /**
   * Keep a value under metadata.custom. A label that appears twice used to
   * overwrite itself while the warning still claimed the value had been kept,
   * so the earlier one was lost and the message said otherwise. A repeat with a
   * different value is now joined to the first and reported; an identical
   * repeat loses nothing and says nothing.
   */
  const addCustom = (label: string, value: string, source: SourceRef): "new" | "same" | "joined" => {
    const existing = custom[label];
    if (existing === undefined) {
      custom[label] = value;
      return "new";
    }
    if (existing.split("; ").includes(value)) return "same";
    custom[label] = `${existing}; ${value}`;
    findings.push(
      finding(
        FindingCode.DuplicateMetadataLabel,
        "warn",
        `"${label}" appears more than once with different values. Both were kept, joined with a semicolon, rather than the later one replacing the earlier.`,
        { source, field: `metadata.custom.${label}` },
      ),
    );
    return "joined";
  };

  for (const entry of raw.metadata.flatMap(expandKeyLine)) {
    const source: SourceRef = { file, firstBlock: entry.block, lastBlock: entry.block };
    const key = METADATA_LABELS[entry.label.toLowerCase()];
    const value = entry.value;
    // A label with nothing after it, such as `REF:` left blank in a template,
    // carries no information, and an empty string is not a valid metadata value.
    if (value.trim().length === 0) continue;

    if (key === "difficulty") {
      const parsed = DIFFICULTY_WORDS[value.trim().toLowerCase()];
      if (!parsed) {
        if (addCustom(entry.label, value, source) === "new") {
          findings.push(
            finding(FindingCode.UnknownMetadataLabel, "warn", `Difficulty "${value}" was not recognised, so it was kept as written.`, { source, field: "metadata.difficulty" }),
          );
        }
      } else if (metadata.difficulty === undefined) {
        metadata.difficulty = parsed;
      } else if (metadata.difficulty !== parsed && addCustom(entry.label, value, source) === "new") {
        findings.push(
          finding(
            FindingCode.DuplicateMetadataLabel,
            "warn",
            `Difficulty was given as ${metadata.difficulty} and again as "${value}". The first was used and the second is kept in metadata.custom.${entry.label}.`,
            { source, field: "metadata.difficulty" },
          ),
        );
      }
    } else if (key === "bloom") {
      const parsed = BLOOM_WORDS[value.trim().toLowerCase()];
      if (!parsed) {
        if (addCustom(entry.label, value, source) === "new") {
          findings.push(
            finding(FindingCode.UnknownMetadataLabel, "warn", `Bloom level "${value}" was not recognised, so it was kept as written.`, { source, field: "metadata.bloom" }),
          );
        }
      } else if (metadata.bloom === undefined) {
        metadata.bloom = parsed;
      } else if (metadata.bloom !== parsed && addCustom(entry.label, value, source) === "new") {
        findings.push(
          finding(
            FindingCode.DuplicateMetadataLabel,
            "warn",
            `Bloom level was given as ${metadata.bloom} and again as "${value}". The first was used and the second is kept in metadata.custom.${entry.label}.`,
            { source, field: "metadata.bloom" },
          ),
        );
      }
    } else if (key === "tags") {
      for (const tag of value.split(/[;,]/).map((t) => t.trim()).filter(Boolean)) {
        if (!metadata.tags.includes(tag)) metadata.tags.push(tag);
      }
    } else if (key) {
      const slot = metadata as unknown as Record<string, string | undefined>;
      const existing = slot[key];
      if (existing === undefined) {
        slot[key] = value;
      } else if (existing !== value && !existing.split("; ").includes(value)) {
        slot[key] = `${existing}; ${value}`;
        findings.push(
          finding(
            FindingCode.DuplicateMetadataLabel,
            "warn",
            `More than one value was given for ${key}: "${existing}" and "${value}". Both were kept, joined with a semicolon, rather than the later one replacing the earlier.`,
            { source, field: `metadata.${key}` },
          ),
        );
      }
    } else if (addCustom(entry.label, value, source) === "new") {
      // An explanation is a label this profile knows. A question has nowhere to put
      // it, and it is not feedback, which a student is shown, so it is kept as a
      // note. That is said, but it is information and not a warning, because a
      // whole bank of these should not need review for it.
      const note = NOTE_LABELS.has(entry.label.toLowerCase());
      const kept = note || entry.fromKey === true;
      findings.push(
        finding(
          kept ? FindingCode.MetadataKeptAsNote : FindingCode.UnknownMetadataLabel,
          kept ? "info" : "warn",
          note
            ? `"${entry.label}" is kept as a note under metadata.custom.${entry.label}. A question has no field for an explanation, and it was not made feedback, which a student is shown.`
            : entry.fromKey
              ? `"${entry.label}" is one of the fields of a KEY line, and a question has no field for it, so it is kept under metadata.custom.${entry.label}.`
              : `"${entry.label}" is not a metadata label this profile knows, so it was kept under metadata.custom rather than dropped.`,
          { source, field: `metadata.custom.${entry.label}` },
        ),
      );
    }
  }

  if (Object.keys(custom).length > 0) metadata.custom = custom;
  return { metadata, findings };
}

/**
 * The Standard Format is four dialects, not one. The generic (IMS QTI) and
 * Canvas guides give E, F, MT, MA and MC; Moodle and D2L write multiple
 * response as MR and add S for short answer; D2L and Blackboard add FMB, ORD
 * and, in Blackboard, JUM. MR and MA mean the same thing wherever either is
 * documented, so both are read. See docs/review-findings.md.
 */
const TYPE_HINTS: Record<string, QuestionType> = {
  E: "essay",
  F: "fillInBlank",
  S: "shortAnswer",
  MT: "matching",
  MA: "multipleResponse",
  MR: "multipleResponse",
  MC: "multipleChoice",
  TF: "trueFalse",
};

/**
 * Types the dialects document that this profile does not read yet. They are
 * recognised so that the question can be refused by name. Without this they
 * were read as something else: ORD and JUM came out as a multiple choice with
 * no key, and FMB as an essay, each with its Type line reported as stray text.
 */
const UNSUPPORTED_HINTS: Record<string, string> = {
  FMB: "fill in multiple blanks",
  ORD: "ordering",
  JUM: "jumbled sentence",
};

interface TypeReading {
  type: QuestionType;
  inferred: boolean;
  /** A Type line was present but is not one this profile knows. */
  unknownHint?: string;
  /** A Type line the dialects document and this profile does not read yet. */
  unsupported?: { hint: string; label: string };
}

function inferType(raw: RawQuestion): TypeReading {
  const hint = raw.typeHint;
  const unsupportedLabel = hint ? UNSUPPORTED_HINTS[hint] : undefined;
  // Kept as an essay so that the text has somewhere to live; the error beside it
  // is what keeps the question from being used as one. See hasUsableKey.
  if (hint && unsupportedLabel) {
    return { type: "essay", inferred: false, unsupported: { hint, label: unsupportedLabel } };
  }
  const stated = hint ? TYPE_HINTS[hint] : undefined;
  if (stated) return { type: stated, inferred: false };

  const guess = guessType(raw);
  // A Type line that is not on the list used to be ignored without a word, so a
  // short-answer question typed "Type: SA" came out as multiple choice with
  // nothing to say that the file had asked for something else.
  return hint ? { ...guess, inferred: true, unknownHint: hint } : guess;
}

function guessType(raw: RawQuestion): TypeReading {
  // No options and no type line could be an essay or a short answer. That is a
  // real guess, and it is flagged.
  if (raw.options.length === 0) return { type: "essay", inferred: true };

  // True or false, and only when True comes first. If False appears first the
  // the test-bank vendor specification says it is a multiple choice question, and banks
  // rely on that. This is the documented convention rather than a guess, so it
  // is not flagged.
  if (raw.options.length === 2) {
    const first = raw.options[0]?.lines.join(" ").trim().toLowerCase();
    const second = raw.options[1]?.lines.join(" ").trim().toLowerCase();
    const isTrue = first === "true" || first === "t";
    const isFalse = second === "false" || second === "f";
    if (isTrue && isFalse) return { type: "trueFalse", inferred: false };
  }

  // Matching, but only when nothing says these are answer options. Every option
  // containing "=" used to be enough, which turned `a. x = 1 / *b. x = 3` into
  // matching pairs: the asterisk was dropped, the left sides collapsed to "x",
  // and the question looked as though it had been read. An asterisk or a key
  // list entry means an answer is being marked, and pairs whose left sides
  // repeat are not a matching exercise.
  const marked = raw.options.some((o) => o.starred || o.keyedByFormat) || keyTexts(raw).length > 0 || raw.keyAmbiguous;
  if (!marked && raw.options.every((o) => o.lines.join(" ").includes("="))) {
    const lefts = raw.options.map((o) => {
      const text = o.lines.join(" ");
      return text.slice(0, text.indexOf("=")).trim().toLowerCase();
    });
    if (lefts.every((l) => l.length > 0) && new Set(lefts).size === lefts.length) {
      return { type: "matching", inferred: true };
    }
  }

  const starred = raw.options.filter((o) => o.starred || o.keyedByFormat).length;
  if (starred > 1) return { type: "multipleResponse", inferred: true };

  return { type: "multipleChoice", inferred: false };
}

/**
 * Everything the file says in words about the answer: the "Answer:" lines beside
 * the question, and what an Answers list gave for it, without repeats. For the
 * types whose answer is text this is the answer; for the choice types it is
 * letters, and resolveKey reads them one source at a time.
 */
function keyTexts(raw: RawQuestion): string[] {
  const seen = new Set<string>();
  const texts: string[] = [];
  for (const value of [...raw.answerLines, ...raw.keyValues]) {
    const key = value.trim().toLowerCase();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    texts.push(value);
  }
  return texts;
}

interface ResolvedKey {
  /** Indexes into raw.options of the options the key marks correct. */
  correct: Set<number>;
  /** The raw tokens, because t and f are ambiguous until the question type is known. */
  tokens: string[];
  /** Names the key uses that no option carries. */
  unresolved: string[];
  /** Names the key uses that more than one option carries, so none can be chosen. */
  shared: string[];
  /** Where the key was read from. */
  source?: "asterisk" | "answer line" | "answers list" | "formatting";
  /** Another source named different options from the one that was used. */
  conflicts: string[];
}

/**
 * Correct options for a question, from asterisks or from its Answers entry.
 *
 * The raw tokens come back beside the options because `t` and `f` are
 * ambiguous: they are valid option letters and they are also the usual
 * shorthand for True and False. Deciding here would be guessing, since this
 * function does not know the question type. A true or false question resolves
 * them against its own options instead; see the trueFalse branch of buildBody.
 *
 * Options are identified by position, not by letter. Two options sharing a
 * letter used to be marked together, so a key naming "A" made both correct.
 * The words True and False are looked up in the option text for the same
 * reason: a bank that lists False first would otherwise have "True" read as
 * option A, which is the False option.
 */
function resolveKey(raw: RawQuestion): ResolvedKey {
  const pointed = (indexes: readonly number[]): ResolvedKey => ({
    correct: new Set(indexes),
    tokens: indexes.map((i) => (raw.options[i] as RawOption).letter),
    unresolved: [],
    shared: [],
    conflicts: [],
  });

  /** The options that a list of key values, such as "B, D" or "True", point at. */
  const fromValues = (values: readonly string[]): ResolvedKey => {
    const correct = new Set<number>();
    const tokens: string[] = [];
    const unresolved: string[] = [];
    const shared: string[] = [];
    const where = (matches: (o: RawOption) => boolean): number[] =>
      raw.options.flatMap((o, i) => (matches(o) ? [i] : []));
    const settle = (hits: number[], name: string): void => {
      if (hits.length === 0) unresolved.push(name);
      else if (hits.length === 1) correct.add(hits[0] as number);
      else shared.push(name);
    };
    for (const entry of values) {
      for (const piece of entry.split(KEY_SPLIT)) {
        const value = piece.trim().toLowerCase();
        if (value.length === 0) continue;
        tokens.push(value);
        if (/^[a-t]$/.test(value)) {
          settle(where((o) => o.letter === value), value);
        } else if (value === "true" || value === "false") {
          settle(where((o) => o.lines.join(" ").trim().toLowerCase().replace(/\.$/, "") === value), value);
        }
      }
    }
    return { correct, tokens, unresolved, shared, conflicts: [] };
  };

  // The ways a file can say which option is right, in the order they are trusted:
  // an asterisk on the option itself; an "Answer:" line beside the question; an
  // Answers list; and last, how the options are formatted, which is a convention
  // of the whole file and not a statement about this question. The first one that
  // is there is used. The others are not discarded: where they name different
  // options, that is said, because a key that two parts of the file disagree about
  // is one the author needs to look at.
  const starred = raw.options.flatMap((o, i) => (o.starred ? [i] : []));
  const formatted = raw.options.flatMap((o, i) => (o.keyedByFormat ? [i] : []));
  const sources: Array<{ name: NonNullable<ResolvedKey["source"]>; key: ResolvedKey }> = [];
  if (starred.length > 0) sources.push({ name: "asterisk", key: pointed(starred) });
  if (raw.answerLines.length > 0) sources.push({ name: "answer line", key: fromValues(raw.answerLines) });
  if (raw.keyValues.length > 0) sources.push({ name: "answers list", key: fromValues(raw.keyValues) });
  // Formatting is the last resort for a key, but it is still compared with the others.
  const byFormat = formatted.length > 0 ? formatted : (raw.formatMarked ?? []);
  if (byFormat.length > 0) sources.push({ name: "formatting", key: pointed(byFormat) });

  const used = sources[0];
  if (!used) return { correct: new Set(), tokens: [], unresolved: [], shared: [], conflicts: [] };

  const letters = (key: ResolvedKey): string =>
    [...key.correct].sort((a, b) => a - b).map((i) => (raw.options[i] as RawOption).letter.toUpperCase()).join(", ");
  const label = (name: string): string =>
    name === "formatting"
      ? `the file's formatting (${raw.formatConvention ?? "formatting"})`
      : name === "answer line"
        ? "the Answer line"
        : name === "answers list"
          ? "the Answers list"
          : `the ${name}`;
  const upper = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
  const conflicts: string[] = [];
  for (const other of sources.slice(1)) {
    const same = other.key.correct.size === used.key.correct.size && [...other.key.correct].every((i) => used.key.correct.has(i));
    // A source that named nothing usable has not disagreed with anything; it is
    // reported in its own way (an unresolved letter, a key that cannot be used).
    if (!same && other.key.correct.size > 0 && used.key.correct.size > 0) {
      conflicts.push(`${upper(label(other.name))} marks ${letters(other.key)}, but ${label(used.name)} gives ${letters(used.key)}. ${upper(label(used.name))} was used.`);
    }
  }
  return { ...used.key, source: used.name, conflicts };
}

function placeholderOption(index: number): Option {
  return { id: localId("o", index), content: plainToRich(PLACEHOLDER), correct: false };
}

function buildOptions(
  raw: RawQuestion,
  correct: ReadonlySet<number>,
  file: string,
  idPrefix: string,
): { options: Option[]; media: MediaRef[]; findings: Finding[] } {
  const options: Option[] = [];
  const media: MediaRef[] = [];
  const findings: Finding[] = [];

  raw.options.forEach((option, i) => {
    const source: SourceRef = { file, firstBlock: option.firstBlock, lastBlock: option.lastBlock };
    const converted = toRichText(option.lines, source, `${idPrefix}o${i}`);
    media.push(...converted.media);
    findings.push(...converted.findings);

    // An option with a letter and no text, or only an empty block of HTML. It is
    // kept in its place, so that the key's letters still point at the right
    // options, and its content is a placeholder beside an error.
    const empty = richTextToPlain(converted.rich).length === 0 && converted.media.length === 0;
    if (empty) {
      findings.push(
        finding(FindingCode.EmptyOption, "error", `Option ${option.letter.toUpperCase()} has no text.`, {
          source,
          field: `body.options.${i}.content`,
        }),
      );
    }

    const built: Option = {
      id: localId("o", i),
      content: empty ? plainToRich(PLACEHOLDER) : converted.rich,
      correct: correct.has(i),
    };
    if (option.feedback.length > 0) {
      built.feedback = plainToRich(option.feedback.join("\n"));
    }
    options.push(built);
  });

  return { options, media, findings };
}

function buildBody(
  raw: RawQuestion,
  type: QuestionType,
  key: ResolvedKey,
  file: string,
  idPrefix: string,
): { body: QuestionBody; media: MediaRef[]; findings: Finding[] } {
  const media: MediaRef[] = [];
  const findings: Finding[] = [];
  const source: SourceRef = { file, firstBlock: raw.firstBlock, lastBlock: raw.lastBlock };

  switch (type) {
    case "trueFalse": {
      // Which option says True is read from the options themselves, never
      // assumed to be the first one: a bank that lists False first would
      // otherwise have every answer inverted, and the question would look
      // perfectly clean afterwards.
      const saysTrue = (text: string) => /^\s*(t|true)\b/i.test(text);
      const saysFalse = (text: string) => /^\s*(f|false)\b/i.test(text);
      const letterFor = (match: (text: string) => boolean): string | undefined =>
        raw.options.find((o) => match(o.lines.join(" ")))?.letter;

      const trueLetter = letterFor(saysTrue);
      const falseLetter = letterFor(saysFalse);

      let resolved: boolean | undefined;
      for (const token of key.tokens) {
        if (token === "true" || (token === "t" && trueLetter !== "t")) resolved = true;
        else if (token === "false" || (token === "f" && falseLetter !== "f")) resolved = false;
        else if (trueLetter !== undefined && token === trueLetter) resolved = true;
        else if (falseLetter !== undefined && token === falseLetter) resolved = false;
        else continue;
        break;
      }

      // The body of a true or false question is its answer and nothing else, so
      // options saying anything but True or False have nowhere to go. They used
      // to vanish; now the words are in the message.
      // Only an option that is exactly True or False is redundant. One that begins
      // with the word and carries more, such as a wrapped line of other text,
      // would lose the rest.
      const justTrueOrFalse = /^(t|true|f|false)\s*[.!]?$/i;
      const unkeptOptions = raw.options
        .map((o) => o.lines.join(" ").trim())
        .filter((text) => text.length > 0 && !justTrueOrFalse.test(text));
      if (unkeptOptions.length > 0) {
        findings.push(
          finding(
            FindingCode.OptionNotKept,
            "warn",
            `A true or false question keeps only its answer, so these options were not kept: "${unkeptOptions.join(" / ")}".`,
            { source, field: "body" },
          ),
        );
      }

      if (resolved === undefined) {
        // Left unset on purpose. Storing False here would be a guessed answer
        // key that nothing downstream could tell apart from an authored one.
        findings.push(
          finding(FindingCode.NoAnswerKey, "error", "No answer is marked for this true or false question.", { source, field: "body.correct" }),
        );
        return { body: {}, media, findings };
      }

      return { body: { correct: resolved }, media, findings };
    }

    case "essay": {
      const inline = raw.options.map((o) => o.lines.join("\n"));
      const answerText = [...inline, ...keyTexts(raw)].filter((a) => a.trim().length > 0).join("\n\n");
      const body: QuestionBody = answerText.length > 0 ? { modelAnswer: plainToRich(answerText) } : {};
      return { body, media, findings };
    }

    case "fillInBlank":
    case "shortAnswer": {
      // The two types are written the same way: every option, and every form in
      // the Answers list, is an accepted answer. They differ in where the model
      // keeps the list.
      const accepted = [
        ...raw.options.map((o) => richTextToPlain(plainToRich(o.lines.join(" ")))),
        ...keyTexts(raw),
      ]
        .map((a) => a.trim())
        .filter((a) => a.length > 0);
      const blank = type === "fillInBlank";
      const field = blank ? "body.blanks" : "body.accepted";

      if (accepted.length === 0) {
        findings.push(
          finding(
            FindingCode.NoAnswerKey,
            "error",
            `No accepted answer was given for this ${blank ? "fill in the blank" : "short answer"} question.`,
            { source, field },
          ),
        );
        // Empty on purpose. The schema stores an unkeyed blank as an empty
        // answer, and the answer-key check re-derives the error from it. Text
        // such as "(missing)" would read as a real answer and clear the error.
        return {
          body: blank ? { caseSensitive: false, blanks: [{ id: "b1", accepted: [""] }] } : { caseSensitive: false, accepted: [""] },
          media,
          findings,
        };
      }
      // A stem with several blanks and one answer written "channels; media" is one
      // answer to each blank, when the semicolons make exactly as many parts as there
      // are blanks. Any other count is not split: which part belongs to which blank
      // would be a guess, so the answers are kept as one blank's accepted forms, as they
      // always were, and the question says that it has more blanks than that.
      if (blank) {
        const places = (raw.stemLines.join(" ").match(/_{3,}/g) ?? []).length;
        if (places >= 2) {
          const parts = accepted.length === 1 ? (accepted[0] as string).split(";").map((p) => p.trim()) : [];
          if (parts.length === places && parts.every((p) => p.length > 0)) {
            return {
              body: { caseSensitive: false, blanks: parts.map((p, i) => ({ id: `b${i + 1}`, accepted: [p] })) },
              media,
              findings,
            };
          }
          findings.push(
            finding(
              FindingCode.BlankCountMismatch,
              "warn",
              `The stem has ${places} blanks, but the answer is not one part for each of them (${accepted.length === 1 ? `it has ${parts.length} between semicolons` : `${accepted.length} answers were given`}), so which answer belongs to which blank was not guessed. All of it is kept as the accepted forms of one blank. Check it.`,
              { source, field },
            ),
          );
        }
      }
      return {
        body: blank ? { caseSensitive: false, blanks: [{ id: "b1", accepted }] } : { caseSensitive: false, accepted },
        media,
        findings,
      };
    }

    case "matching": {
      const pairs: Array<{ id: string; left: RichText; right: string }> = [];
      const distractors: string[] = [];
      raw.options.forEach((option, i) => {
        const text = option.lines.join(" ");
        const at = text.indexOf("=");
        if (at === -1) {
          // A distractor with no text has nothing to keep, and the schema refuses
          // an empty one. It is reported, so the gap is not silent.
          if (text.trim().length === 0) {
            findings.push(
              finding(FindingCode.EmptyOption, "warn", `Matching entry ${i + 1} has no text, so it was left out.`, { source, field: `body.distractors` }),
            );
            return;
          }
          distractors.push(normalizeCharacters(text.trim()));
          return;
        }
        const left = text.slice(0, at).trim();
        const right = text.slice(at + 1).trim();
        if (left.length === 0 || right.length === 0) {
          findings.push(
            finding(
              FindingCode.OptionWithoutLetter,
              "warn",
              `Matching entry ${i + 1} is missing one side of the pair, so it was left out. It said: "${text.trim()}".`,
              { source, field: `body.pairs.${i}` },
            ),
          );
          return;
        }
        // The right side is a plain string, which the rich text the left side becomes is not, so
        // the model's one character rule has to be applied to it here or it would be the only
        // text of a question that kept its curly quotes.
        pairs.push({ id: localId("p", pairs.length), left: plainToRich(left), right: normalizeCharacters(right) });
      });

      if (pairs.length < 2) {
        findings.push(
          finding(FindingCode.NoAnswerKey, "error", "A matching question needs at least two complete pairs.", { source, field: "body.pairs" }),
        );
        while (pairs.length < 2) {
          pairs.push({ id: localId("p", pairs.length), left: plainToRich(PLACEHOLDER), right: PLACEHOLDER });
        }
      }
      return { body: { pairs, distractors, shuffle: true }, media, findings };
    }

    case "multipleResponse":
    case "multipleChoice": {
      if (raw.options.length === 0) {
        findings.push(
          finding(FindingCode.NoOptions, "error", "This question has no answer options.", { source, field: "body.options" }),
        );
        const placeholders = [0, 1].map((i) => placeholderOption(i));
        return {
          body:
            type === "multipleResponse"
              ? { shuffle: true, partialCredit: true, options: placeholders }
              : { shuffle: true, options: placeholders },
          media,
          findings,
        };
      }

      const built = buildOptions(raw, key.correct, file, idPrefix);
      media.push(...built.media);
      findings.push(...built.findings);

      // The schema wants two options at least, and one is not a question. The
      // real option stays as it was; a placeholder takes the second place and the
      // error says so, rather than the question being dropped or stored invalid.
      if (built.options.length === 1) {
        built.options.push(placeholderOption(1));
        findings.push(
          finding(
            FindingCode.TooFewOptions,
            "error",
            "This question has only one answer option, and a choice question needs at least two. A placeholder option was added so the question could be stored. Replace it.",
            { source, field: "body.options" },
          ),
        );
      }

      for (const name of key.unresolved) {
        findings.push(
          finding(
            FindingCode.KeyLetterMissing,
            "error",
            `The answer key names option "${name.toUpperCase()}", which this question does not have.`,
            { source, field: "body.options" },
          ),
        );
      }
      for (const name of key.shared) {
        findings.push(
          finding(
            FindingCode.KeyLetterMissing,
            "error",
            `The answer key names option "${name.toUpperCase()}", but more than one option carries that name, so it was not applied.`,
            { source, field: "body.options" },
          ),
        );
      }

      const markedCorrect = built.options.filter((o) => o.correct).length;
      if (markedCorrect === 0) {
        // the test-bank vendor silently picks option A here. That is the defect; this
        // flags the question and guesses nothing.
        findings.push(
          finding(
            FindingCode.NoAnswerKey,
            "error",
            "No correct answer is marked, and none was found in an Answers list. Nothing was guessed.",
            { source, field: "body.options" },
          ),
        );
      } else if (type === "multipleChoice" && markedCorrect > 1) {
        findings.push(
          finding(
            FindingCode.MultipleKeysOnSingleAnswer,
            "error",
            `${markedCorrect} options are marked correct on a single-answer question.`,
            { source, field: "body.options" },
          ),
        );
      }

      if (type === "multipleResponse") {
        return { body: { shuffle: true, partialCredit: true, options: built.options }, media, findings };
      }
      return { body: { shuffle: true, options: built.options }, media, findings };
    }

    default: {
      findings.push(
        finding(FindingCode.TypeInferred, "warn", `This profile does not produce ${type} questions.`, { source }),
      );
      return { body: { modelAnswer: plainToRich("") }, media, findings };
    }
  }
}

/** Findings about how the scanner had to read the layout, as opposed to what the question says. */
function layoutFindings(raw: RawQuestion, type: QuestionType, source: SourceRef): Finding[] {
  const found: Finding[] = [];

  if (raw.keyAmbiguous) {
    const said = raw.ambiguousKeyValues.length > 0 ? ` It said: "${raw.ambiguousKeyValues.join(" ")}".` : "";
    found.push(
      finding(
        FindingCode.DuplicateQuestionNumber,
        "warn",
        `Another question in the same part of the file is also numbered ${raw.number}, so the Answers entry for ${raw.number} was not applied to this one. Nothing was guessed.${said}`,
        { source, field: "origin" },
      ),
    );
  }

  // Key text that this type of question has no use for. Letters and the words
  // True and False are read by the choice types; essay and fill in the blank
  // take the whole entry as an answer; nothing else reads a key at all. What is
  // left over used to vanish, including the case where a question had been
  // mistaken for a key entry and its words were all that was in it.
  const writtenKey = keyTexts(raw);
  const unusedKey =
    type === "essay" || type === "fillInBlank" || type === "shortAnswer"
      ? []
      : type === "matching"
        ? writtenKey
        : writtenKey.filter((value) => !KEY_VALUE.test(value));
  if (unusedKey.length > 0) {
    found.push(
      finding(
        FindingCode.KeyTextNotUsed,
        "warn",
        `The ${raw.answerLines.length > 0 ? "Answer line" : "Answers list"} gave "${unusedKey.join(" / ")}" for this question, which a ${type} question cannot use as a key, so it was not applied.`,
        { source, field: "origin" },
      ),
    );
  }

  const letters = new Map<string, number>();
  for (const option of raw.options) letters.set(option.letter, (letters.get(option.letter) ?? 0) + 1);
  const repeated = [...letters].filter(([, n]) => n > 1).map(([letter]) => letter.toUpperCase());
  if (repeated.length > 0) {
    found.push(
      finding(
        FindingCode.DuplicateOptionLetter,
        "warn",
        `More than one option is lettered ${repeated.join(", ")}, so an answer key that names ${repeated.length === 1 ? "that letter" : "those letters"} cannot say which option it means.`,
        { source, field: "body.options" },
      ),
    );
  }

  // Only the two choice types have feedback for each option. On any other type
  // the options become something else (a model answer, accepted answers, pairs)
  // and the feedback beneath them has nowhere to go. It used to disappear with
  // no trace, which is the one thing this importer is not allowed to do.
  // The words are quoted in the message so that they are not lost with it.
  const unkept = raw.options.flatMap((o) => o.feedback);
  if (type !== "multipleChoice" && type !== "multipleResponse" && unkept.length > 0) {
    found.push(
      finding(
        FindingCode.OptionFeedbackNotKept,
        "warn",
        `Feedback written under an option was not kept, because a ${type} question has no feedback for each option: "${unkept.join(" / ")}".`,
        { source, field: "body.options" },
      ),
    );
  }

  // The same line means two things. The generic format, Canvas and Blackboard
  // write feedback for a correct answer with ~ and for an incorrect one with @,
  // both before the options. D2L and Moodle write general feedback, shown
  // whatever the answer, with a single @ and no ~. A lone @ is read here the
  // first way, which is the only way this profile can store it without a
  // general field, so the reading is a guess and it is said to be one.
  if (raw.incorrectFeedbackBeforeOptions && raw.correctFeedback.length === 0) {
    found.push(
      finding(
        FindingCode.AmbiguousFeedback,
        "warn",
        "A line starting with @ comes straight after the question, with no ~ line beside it. Most files mean feedback for an incorrect answer, but D2L and Moodle files use it for general feedback shown whatever the answer. It was kept as feedback for an incorrect answer. Check which was meant.",
        { source, field: "feedback.incorrect" },
      ),
    );
  }

  // Without options there is nothing to close the stem, so text after a blank
  // line is taken as more of it. That is right for a long essay prompt and
  // wrong for a heading that follows the question; the two look the same.
  if (raw.options.length === 0 && raw.stemAfterBlank) {
    found.push(
      finding(
        FindingCode.StemSpansBlankLine,
        "warn",
        "This question has no options, and its stem continues after a blank line. If the later text is a heading or belongs to the next section, it has been read as part of the stem. Check it.",
        { source, field: "stem" },
      ),
    );
  }

  return found;
}

/**
 * The model requires a valid question even when the source was broken, so a
 * failed item still opens in the editor beside its original text. The findings
 * are what say it failed; the placeholders are only so it can be shown.
 */
function buildQuestion(
  raw: RawQuestion,
  file: string,
  options: Required<Pick<ImportOptions, "author" | "at" | "defaultPoints" | "profile">>,
): Question {
  const source: SourceRef = { file, firstBlock: raw.firstBlock, lastBlock: raw.lastBlock };
  const findings: Finding[] = [];
  const idPrefix = `q${raw.number}`;

  // A value the schema would refuse, such as `Points: 5000`, used to get as far
  // as saving the bank and then abort it. The default is used instead, and the
  // value the file gave is in the message so that it is not lost.
  let points = raw.points;
  if (!(points >= 0 && points <= MAX_POINTS)) {
    points = options.defaultPoints;
    findings.push(
      finding(
        FindingCode.PointsAssumed,
        "warn",
        `The file gave ${raw.points} points, which is more than the ${MAX_POINTS} a question may be worth, so ${points} was used. Check it.`,
        { source, field: "points" },
      ),
    );
  }

  const { type, inferred, unknownHint, unsupported } = inferType(raw);
  if (unsupported) {
    findings.push(
      finding(
        FindingCode.UnsupportedType,
        "error",
        `This question is marked Type: ${unsupported.hint} (${unsupported.label}), a type this profile cannot read yet. It was kept as an essay, with the options as its model answer, so that none of its text is lost, and it fails so that it is not used as one. Its original wording is in the source file.`,
        { source, field: "type" },
      ),
    );
  }
  if (inferred) {
    findings.push(
      finding(
        FindingCode.TypeInferred,
        "warn",
        unknownHint
          ? `The Type line said "${unknownHint}", which this profile does not know, so the type was worked out from the question and read as ${type}. Check it.`
          : `The file did not say what kind of question this is, so it was read as ${type}. Check it.`,
        { source, field: "type" },
      ),
    );
  }

  const key = resolveKey(raw);
  const stem = toRichText(raw.stemLines, source, idPrefix);
  const body = buildBody(raw, type, key, file, idPrefix);
  const meta = applyMetadata(raw, file);

  findings.push(...stem.findings, ...body.findings, ...meta.findings, ...layoutFindings(raw, type, source));
  for (const disagreement of key.conflicts) {
    findings.push(finding(FindingCode.KeysDisagree, "warn", disagreement, { source, field: "body.options" }));
  }
  for (const note of raw.notes) findings.push({ ...note, source });

  if (richTextToPlain(stem.rich).length === 0) {
    findings.push(finding(FindingCode.EmptyStem, "error", "This question has no stem text.", { source, field: "stem" }));
  }

  let title = raw.title?.trim();
  if (title && title.length > MAX_TITLE_LENGTH) {
    findings.push(
      finding(
        FindingCode.TitleTruncated,
        "warn",
        `The title was longer than ${MAX_TITLE_LENGTH} characters and was shortened. The file gave: "${title}".`,
        { source, field: "title" },
      ),
    );
    title = title.slice(0, MAX_TITLE_LENGTH);
  }

  const media = [...stem.media, ...body.media];

  const question = createQuestion({
    type,
    stem: richTextToPlain(stem.rich).length > 0 ? stem.rich : plainToRich("(no stem text in the source)"),
    body: body.body,
    ...(title ? { title } : { title: titleFromStem(richTextToPlain(stem.rich)) }),
    points,
    feedback: {
      ...(raw.generalFeedback.length > 0 ? { general: plainToRich(raw.generalFeedback.join("\n")) } : {}),
      ...(raw.correctFeedback.length > 0 ? { correct: plainToRich(raw.correctFeedback.join("\n")) } : {}),
      ...(raw.incorrectFeedback.length > 0 ? { incorrect: plainToRich(raw.incorrectFeedback.join("\n")) } : {}),
    },
    metadata: meta.metadata,
    media,
    findings,
    origin: { kind: "import", source, profile: options.profile, at: options.at },
    by: options.author,
    at: options.at,
  });

  // The quality checker is the single source of truth for what a bad answer
  // key is. The importer raises the import-specific wording first, so this
  // only adds what the import path did not already notice.
  return addFindings(
    question,
    checkAnswerKey(question).filter((f) => !findings.some((existing) => existing.code === f.code)),
  );
}

// ---------------------------------------------------------------------------
// The importer
// ---------------------------------------------------------------------------

/**
 * The block as the page shows it: the label Word's list put there, then the text.
 *
 * Two things differ from joining them with a space. Word writes a label as "(a)"
 * as readily as "a)", and the Standard Format knows only the second, so the opening
 * bracket is dropped; it is the same letter. And an author who letters the options
 * with Word's list can only put the key's asterisk after the letter, as "b. *Mars",
 * where the format wants "*b. Mars". An asterisk at the start of a lettered item is
 * the author's mark, so it is moved where the scanner looks for it. It is moved
 * only for a label that looks like an option letter, and only when Word made the
 * label: a typed "b. *Mars" is read as it always was.
 */
export function withListLabel(block: SourceBlock): SourceBlock {
  if (!block.listLabel) return block;
  const label = block.listLabel.replace(/^\((.+)\)$/, "$1)");
  const mark = /^\s*\*\s*/.exec(block.text);
  const moved = mark !== null && /^[a-tA-T][.)]$/.test(label);
  const prefix = moved ? `*${label} ` : `${label} `;
  const dropped = moved ? mark[0].length : 0;
  const text = prefix + block.text.slice(dropped);
  if (!block.runs) return { ...block, text };

  // The runs have to keep adding up to the text, so the label is a run of its own
  // and whatever was cut from the front comes off the first runs.
  const runs: SourceRun[] = [{ text: prefix }];
  let toDrop = dropped;
  for (const run of block.runs) {
    if (toDrop >= run.text.length) {
      toDrop -= run.text.length;
      continue;
    }
    runs.push(toDrop > 0 ? { ...run, text: run.text.slice(toDrop) } : run);
    toDrop = 0;
  }
  return { ...block, text, runs };
}

export const standardTextImporter: Importer = {
  id: PROFILE_ID,
  label: "standard test-bank text format (plain text)",
  extensions: [".txt", ".rtf", ".md"],

  parse(input: string | SourceBlock[], options: ImportOptions = {}): ImportResult {
    const file = options.file ?? "input.txt";
    // A block from a Word file keeps its list label apart from its text. The scanner
    // reads what the page shows, which is the label then the text, so a question
    // numbered by Word is read like one numbered by hand.
    const blocks = (typeof input === "string" ? linesToBlocks(input) : input).map(withListLabel);
    const at = options.at ?? new Date().toISOString();
    const author = options.author ?? "import";
    const profile = options.profile ?? PROFILE_ID;

    const defaultPoints = options.defaultPoints ?? DEFAULT_POINTS;
    const scanned = scanStandardText(blocks, file, defaultPoints, (options.keyMark ?? "auto") !== "off");
    // Formatting can supply a key where the file gave none in words. It is decided
    // once for the whole file, after every question is known and before any is built.
    const formatting = applyFormattingKey(blocks, scanned.questions, options.keyMark ?? "auto");
    const questions = scanned.questions.map((raw) => buildQuestion(raw, file, { author, at, defaultPoints, profile }));

    return {
      profile,
      file,
      questions,
      orphans: scanned.orphans,
      counts: countVerdicts(questions, scanned.orphans.length),
      fileFindings: [...scanned.fileFindings, ...formatting.fileFindings],
    };
  },
};
