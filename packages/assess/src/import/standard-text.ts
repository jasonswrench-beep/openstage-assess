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
 *   Type: E | F | MT | MA essay, fill in blank, matching, multiple answer
 *   Points: 2.5           applies to this question and every one after it
 *   3) stem               a question number, a period or a parenthesis
 *   *b) option            an asterisk marks the correct option
 *   a. left = right       a matching pair
 *   ~ text                feedback for a correct answer
 *   @ text                feedback for an incorrect answer, or for the option above
 *   Answers:              a key list at the end, by question number
 *   [ img: "f.jpg" "alt" ]  an image with alternative text
 *   [HTML] ... [/HTML]    a block of raw HTML
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
import {
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
  countVerdicts,
  linesToBlocks,
  type Importer,
  type ImportOptions,
  type ImportResult,
  type Orphan,
  type SourceBlock,
} from "./types.ts";

export const PROFILE_ID = "standard-text";

// ---------------------------------------------------------------------------
// Line patterns
// ---------------------------------------------------------------------------

const QUESTION_START = /^\s*(\d{1,4})\s*[.)]\s+(.*)$/;
const OPTION_START = /^\s*(\*?)\s*([a-tA-T])\s*[.)]\s+(.*)$/;
const TITLE_LINE = /^\s*Title\s*:\s*(.*)$/i;
const TYPE_LINE = /^\s*Type\s*:\s*([A-Za-z]{1,2})\s*$/i;
const POINTS_LINE = /^\s*Points\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*$/i;
const ANSWERS_HEADER = /^\s*Answers\s*:\s*$/i;
const CORRECT_FEEDBACK = /^\s*~\s*(.*)$/;
const INCORRECT_FEEDBACK = /^\s*@\s*(.*)$/;
const ANSWER_ENTRY = /^\s*(\d{1,4})\s*[.)]\s*(.*)$/;
const IMAGE_TAG = /\[\s*img\s*:\s*"([^"]*)"(?:\s*"([^"]*)")?\s*\]/gi;
const HTML_BLOCK = /\[HTML\]([\s\S]*?)\[\/HTML\]/gi;

/**
 * Metadata labels publishers actually use. Anything matching the shape of a
 * label but not on this list is kept in metadata.custom rather than dropped,
 * which is what makes "nothing is dropped" true of metadata lines too.
 */
const METADATA_LABELS: Record<string, keyof Metadata | "bloom" | "difficulty"> = {
  objective: "objective",
  "learning objective": "objective",
  obj: "objective",
  lo: "objective",
  chapter: "chapter",
  chap: "chapter",
  ch: "chapter",
  section: "section",
  sec: "section",
  page: "page",
  pages: "page",
  ref: "page",
  "page reference": "page",
  difficulty: "difficulty",
  dif: "difficulty",
  diff: "difficulty",
  bloom: "bloom",
  "bloom's": "bloom",
  "blooms": "bloom",
  "bloom's level": "bloom",
  "cognitive level": "bloom",
  topic: "tags",
  top: "tags",
  tags: "tags",
  keywords: "tags",
};

/** An all-capital short code such as NOT, MSC or NAT that a bank may invent. */
const UNKNOWN_LABEL = /^\s*([A-Za-z][A-Za-z'\- ]{0,28})\s*:\s*(.+)$/;
const CODE_LABEL = /^[A-Z]{2,6}$/;

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
// Intermediate shapes
// ---------------------------------------------------------------------------

interface RawOption {
  letter: string;
  starred: boolean;
  lines: string[];
  feedback: string[];
  firstBlock: number;
  lastBlock: number;
}

interface RawQuestion {
  number: number;
  typeHint?: string;
  title?: string;
  points: number;
  stemLines: string[];
  options: RawOption[];
  correctFeedback: string[];
  incorrectFeedback: string[];
  metadata: Array<{ label: string; value: string; block: number }>;
  firstBlock: number;
  lastBlock: number;
}

type Target =
  | { kind: "stem"; question: RawQuestion }
  | { kind: "option"; option: RawOption }
  | { kind: "optionFeedback"; option: RawOption }
  | { kind: "correctFeedback"; question: RawQuestion }
  | { kind: "incorrectFeedback"; question: RawQuestion }
  | { kind: "none" };

// ---------------------------------------------------------------------------
// Pass one: text to raw questions
// ---------------------------------------------------------------------------

interface ScanResult {
  questions: RawQuestion[];
  answerKey: Map<number, string[]>;
  orphans: Orphan[];
  fileFindings: Finding[];
}

function scan(blocks: SourceBlock[], file: string, defaultPoints: number): ScanResult {
  const questions: RawQuestion[] = [];
  const answerKey = new Map<number, string[]>();
  const orphans: Orphan[] = [];
  const fileFindings: Finding[] = [];

  let points = defaultPoints;
  let pendingType: string | undefined;
  let pendingTitle: string | undefined;
  let current: RawQuestion | undefined;
  let target: Target = { kind: "none" };
  let inAnswers = false;
  let lastAnswerNumber: number | undefined;

  const orphan = (block: SourceBlock, reason: string) => {
    orphans.push({
      source: { file, firstBlock: block.index, lastBlock: block.index },
      text: block.text.trim(),
      reason,
    });
  };

  for (const block of blocks) {
    const line = block.text;
    const trimmed = line.trim();

    if (ANSWERS_HEADER.test(line)) {
      inAnswers = true;
      current = undefined;
      target = { kind: "none" };
      continue;
    }

    if (inAnswers) {
      if (trimmed.length === 0) continue;
      const entry = ANSWER_ENTRY.exec(line);
      if (entry) {
        const number = Number(entry[1]);
        const value = (entry[2] ?? "").trim();
        const existing = answerKey.get(number) ?? [];
        if (value.length > 0) existing.push(value);
        answerKey.set(number, existing);
        lastAnswerNumber = number;
      } else if (lastAnswerNumber !== undefined) {
        // A multi-line essay answer continues the previous entry.
        const existing = answerKey.get(lastAnswerNumber) ?? [];
        if (existing.length === 0) existing.push(trimmed);
        else existing[existing.length - 1] = `${existing[existing.length - 1]} ${trimmed}`;
        answerKey.set(lastAnswerNumber, existing);
      } else {
        orphan(block, "after the Answers heading but not an answer entry");
      }
      continue;
    }

    if (trimmed.length === 0) {
      // A blank line ends the current paragraph but not the question, so a
      // stem and its options can be separated by blank lines.
      if (target.kind === "option" || target.kind === "optionFeedback") target = { kind: "none" };
      continue;
    }

    const titleMatch = TITLE_LINE.exec(line);
    if (titleMatch) {
      pendingTitle = (titleMatch[1] ?? "").trim();
      continue;
    }

    const typeMatch = TYPE_LINE.exec(line);
    if (typeMatch) {
      pendingType = (typeMatch[1] ?? "").toUpperCase();
      continue;
    }

    const pointsMatch = POINTS_LINE.exec(line);
    if (pointsMatch) {
      points = Number(pointsMatch[1]);
      continue;
    }

    const questionMatch = QUESTION_START.exec(line);
    if (questionMatch) {
      current = {
        number: Number(questionMatch[1]),
        ...(pendingType ? { typeHint: pendingType } : {}),
        ...(pendingTitle ? { title: pendingTitle } : {}),
        points,
        stemLines: [(questionMatch[2] ?? "").trim()],
        options: [],
        correctFeedback: [],
        incorrectFeedback: [],
        metadata: [],
        firstBlock: block.index,
        lastBlock: block.index,
      };
      questions.push(current);
      pendingType = undefined;
      pendingTitle = undefined;
      target = { kind: "stem", question: current };
      continue;
    }

    if (!current) {
      orphan(block, "before the first question");
      continue;
    }
    current.lastBlock = block.index;

    const optionMatch = OPTION_START.exec(line);
    if (optionMatch) {
      const option: RawOption = {
        letter: (optionMatch[2] ?? "").toLowerCase(),
        starred: optionMatch[1] === "*",
        lines: [(optionMatch[3] ?? "").trim()],
        feedback: [],
        firstBlock: block.index,
        lastBlock: block.index,
      };
      current.options.push(option);
      target = { kind: "option", option };
      continue;
    }

    const correctMatch = CORRECT_FEEDBACK.exec(line);
    if (correctMatch) {
      current.correctFeedback.push((correctMatch[1] ?? "").trim());
      target = { kind: "correctFeedback", question: current };
      continue;
    }

    const incorrectMatch = INCORRECT_FEEDBACK.exec(line);
    if (incorrectMatch) {
      const value = (incorrectMatch[1] ?? "").trim();
      // An @ line straight after an option is that option's feedback; an @
      // line before any option is the question's incorrect-answer feedback.
      if (target.kind === "option" || target.kind === "optionFeedback") {
        const attached: RawOption = target.option;
        attached.feedback.push(value);
        attached.lastBlock = block.index;
        target = { kind: "optionFeedback", option: attached };
      } else {
        current.incorrectFeedback.push(value);
        target = { kind: "incorrectFeedback", question: current };
      }
      continue;
    }

    // A metadata line is recognised wherever it appears, because publisher
    // banks put these lines after the options as often as before them. The
    // label has to be one this profile knows, or an all-capital short code, so
    // that an ordinary colon inside a stem or an option is not mistaken for
    // one.
    const labelMatch = UNKNOWN_LABEL.exec(line);
    if (labelMatch) {
      const label = (labelMatch[1] ?? "").trim();
      const value = (labelMatch[2] ?? "").trim();
      if (METADATA_LABELS[label.toLowerCase()] || CODE_LABEL.test(label)) {
        current.metadata.push({ label, value, block: block.index });
        target = { kind: "none" };
        continue;
      }
    }

    // Anything else continues whatever is open.
    switch (target.kind) {
      case "stem":
        target.question.stemLines.push(trimmed);
        break;
      case "option":
        target.option.lines.push(trimmed);
        target.option.lastBlock = block.index;
        break;
      case "optionFeedback":
        target.option.feedback.push(trimmed);
        target.option.lastBlock = block.index;
        break;
      case "correctFeedback":
        target.question.correctFeedback.push(trimmed);
        break;
      case "incorrectFeedback":
        target.question.incorrectFeedback.push(trimmed);
        break;
      case "none":
        current.stemLines.push(trimmed);
        break;
    }
  }

  if (questions.length === 0) {
    fileFindings.push(
      finding(
        FindingCode.UnparsedBlock,
        "error",
        "No questions were found. The file may use a layout this profile does not read, or the question numbers may be automatic list numbers rather than typed text.",
      ),
    );
  }

  return { questions, answerKey, orphans, fileFindings };
}

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

function applyMetadata(raw: RawQuestion, file: string): { metadata: Metadata; findings: Finding[] } {
  const metadata: Metadata = emptyMetadata();
  const findings: Finding[] = [];
  const custom: Record<string, string> = {};

  for (const entry of raw.metadata) {
    const source: SourceRef = { file, firstBlock: entry.block, lastBlock: entry.block };
    const key = METADATA_LABELS[entry.label.toLowerCase()];
    if (key === "difficulty") {
      const value = DIFFICULTY_WORDS[entry.value.trim().toLowerCase()];
      if (value) metadata.difficulty = value;
      else {
        custom[entry.label] = entry.value;
        findings.push(
          finding(FindingCode.UnknownMetadataLabel, "warn", `Difficulty "${entry.value}" was not recognised, so it was kept as written.`, { source, field: "metadata.difficulty" }),
        );
      }
    } else if (key === "bloom") {
      const value = BLOOM_WORDS[entry.value.trim().toLowerCase()];
      if (value) metadata.bloom = value;
      else {
        custom[entry.label] = entry.value;
        findings.push(
          finding(FindingCode.UnknownMetadataLabel, "warn", `Bloom level "${entry.value}" was not recognised, so it was kept as written.`, { source, field: "metadata.bloom" }),
        );
      }
    } else if (key === "tags") {
      for (const tag of entry.value.split(/[;,]/).map((t) => t.trim()).filter(Boolean)) {
        if (!metadata.tags.includes(tag)) metadata.tags.push(tag);
      }
    } else if (key) {
      (metadata as unknown as Record<string, unknown>)[key] = entry.value;
    } else {
      custom[entry.label] = entry.value;
      findings.push(
        finding(
          FindingCode.UnknownMetadataLabel,
          "warn",
          `"${entry.label}" is not a metadata label this profile knows, so it was kept under metadata.custom rather than dropped.`,
          { source, field: `metadata.custom.${entry.label}` },
        ),
      );
    }
  }

  if (Object.keys(custom).length > 0) metadata.custom = custom;
  return { metadata, findings };
}

function inferType(raw: RawQuestion): { type: QuestionType; inferred: boolean } {
  const hint = raw.typeHint;
  if (hint === "E") return { type: "essay", inferred: false };
  if (hint === "F") return { type: "fillInBlank", inferred: false };
  if (hint === "MT") return { type: "matching", inferred: false };
  if (hint === "MA") return { type: "multipleResponse", inferred: false };
  if (hint === "MC") return { type: "multipleChoice", inferred: false };
  if (hint === "TF") return { type: "trueFalse", inferred: false };

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

  if (raw.options.every((o) => o.lines.join(" ").includes("="))) {
    return { type: "matching", inferred: true };
  }

  const starred = raw.options.filter((o) => o.starred).length;
  if (starred > 1) return { type: "multipleResponse", inferred: true };

  return { type: "multipleChoice", inferred: false };
}

/**
 * Correct letters for a question, from asterisks or from the Answers list.
 *
 * The raw tokens come back beside the letters because `t` and `f` are
 * ambiguous: they are valid option letters and they are also the usual
 * shorthand for True and False. Deciding here would be guessing, since this
 * function does not know the question type. A true or false question resolves
 * them against its own options instead; see the trueFalse branch of buildBody.
 */
function correctLetters(
  raw: RawQuestion,
  answerKey: Map<number, string[]>,
): { letters: Set<string>; tokens: string[]; fromKeyList: boolean } {
  const starred = raw.options.filter((o) => o.starred).map((o) => o.letter);
  if (starred.length > 0) return { letters: new Set(starred), tokens: [...starred], fromKeyList: false };

  const entries = answerKey.get(raw.number) ?? [];
  const letters = new Set<string>();
  const tokens: string[] = [];
  for (const entry of entries) {
    for (const piece of entry.split(/[\s,]+/).filter(Boolean)) {
      const value = piece.trim().toLowerCase();
      tokens.push(value);
      if (/^[a-t]$/.test(value)) letters.add(value);
      else if (value === "true") letters.add("a");
      else if (value === "false") letters.add("b");
    }
  }
  return { letters, tokens, fromKeyList: letters.size > 0 };
}

function buildOptions(
  raw: RawQuestion,
  correct: Set<string>,
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

    const built: Option = {
      id: localId("o", i),
      content: converted.rich,
      correct: correct.has(option.letter),
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
  correct: Set<string>,
  tokens: readonly string[],
  answerKey: Map<number, string[]>,
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
      for (const token of tokens) {
        if (token === "true" || (token === "t" && trueLetter !== "t")) resolved = true;
        else if (token === "false" || (token === "f" && falseLetter !== "f")) resolved = false;
        else if (trueLetter !== undefined && token === trueLetter) resolved = true;
        else if (falseLetter !== undefined && token === falseLetter) resolved = false;
        else continue;
        break;
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
      const answers = answerKey.get(raw.number) ?? [];
      const inline = raw.options.map((o) => o.lines.join("\n"));
      const answerText = [...inline, ...answers].filter((a) => a.trim().length > 0).join("\n\n");
      const body: QuestionBody = answerText.length > 0 ? { modelAnswer: plainToRich(answerText) } : {};
      return { body, media, findings };
    }

    case "fillInBlank": {
      const accepted = [
        ...raw.options.map((o) => richTextToPlain(plainToRich(o.lines.join(" ")))),
        ...(answerKey.get(raw.number) ?? []),
      ]
        .map((a) => a.trim())
        .filter((a) => a.length > 0);

      if (accepted.length === 0) {
        findings.push(
          finding(FindingCode.NoAnswerKey, "error", "No accepted answer was given for this fill in the blank question.", { source, field: "body.blanks" }),
        );
        return { body: { caseSensitive: false, blanks: [{ id: "b1", accepted: [""] }] }, media, findings };
      }
      return { body: { caseSensitive: false, blanks: [{ id: "b1", accepted }] }, media, findings };
    }

    case "matching": {
      const pairs: Array<{ id: string; left: RichText; right: string }> = [];
      const distractors: string[] = [];
      raw.options.forEach((option, i) => {
        const text = option.lines.join(" ");
        const at = text.indexOf("=");
        if (at === -1) {
          distractors.push(text.trim());
          return;
        }
        const left = text.slice(0, at).trim();
        const right = text.slice(at + 1).trim();
        if (left.length === 0 || right.length === 0) {
          findings.push(
            finding(FindingCode.OptionWithoutLetter, "warn", `Matching entry ${i + 1} is missing one side of the pair.`, { source, field: `body.pairs.${i}` }),
          );
          return;
        }
        pairs.push({ id: localId("p", pairs.length), left: plainToRich(left), right });
      });

      if (pairs.length < 2) {
        findings.push(
          finding(FindingCode.NoAnswerKey, "error", "A matching question needs at least two complete pairs.", { source, field: "body.pairs" }),
        );
        while (pairs.length < 2) {
          pairs.push({ id: localId("p", pairs.length), left: plainToRich("(missing)"), right: "(missing)" });
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
        return {
          body: {
            shuffle: true,
            options: [
              { id: "o1", content: plainToRich("(missing)"), correct: false },
              { id: "o2", content: plainToRich("(missing)"), correct: false },
            ],
          },
          media,
          findings,
        };
      }

      const built = buildOptions(raw, correct, file, idPrefix);
      media.push(...built.media);
      findings.push(...built.findings);

      const letters = new Set(raw.options.map((o) => o.letter));
      for (const letter of correct) {
        if (!letters.has(letter)) {
          findings.push(
            finding(
              FindingCode.KeyLetterMissing,
              "error",
              `The answer key names option "${letter.toUpperCase()}", which this question does not have.`,
              { source, field: "body.options" },
            ),
          );
        }
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

/**
 * The model requires a valid question even when the source was broken, so a
 * failed item still opens in the editor beside its original text. The findings
 * are what say it failed; the placeholders are only so it can be shown.
 */
function buildQuestion(
  raw: RawQuestion,
  answerKey: Map<number, string[]>,
  file: string,
  options: Required<Pick<ImportOptions, "author" | "at">>,
): Question {
  const source: SourceRef = { file, firstBlock: raw.firstBlock, lastBlock: raw.lastBlock };
  const findings: Finding[] = [];
  const idPrefix = `q${raw.number}`;

  const { type, inferred } = inferType(raw);
  if (inferred) {
    findings.push(
      finding(
        FindingCode.TypeInferred,
        "warn",
        `The file did not say what kind of question this is, so it was read as ${type}. Check it.`,
        { source, field: "type" },
      ),
    );
  }

  const key = correctLetters(raw, answerKey);
  const stem = toRichText(raw.stemLines, source, idPrefix);
  const body = buildBody(raw, type, key.letters, key.tokens, answerKey, file, idPrefix);
  const meta = applyMetadata(raw, file);

  findings.push(...stem.findings, ...body.findings, ...meta.findings);

  if (richTextToPlain(stem.rich).length === 0) {
    findings.push(finding(FindingCode.EmptyStem, "error", "This question has no stem text.", { source, field: "stem" }));
  }

  let title = raw.title?.trim();
  if (title && title.length > MAX_TITLE_LENGTH) {
    findings.push(
      finding(FindingCode.TitleTruncated, "warn", `The title was longer than ${MAX_TITLE_LENGTH} characters and was shortened.`, { source, field: "title" }),
    );
    title = title.slice(0, MAX_TITLE_LENGTH);
  }

  const media = [...stem.media, ...body.media];

  const question = createQuestion({
    type,
    stem: richTextToPlain(stem.rich).length > 0 ? stem.rich : plainToRich("(no stem text in the source)"),
    body: body.body,
    ...(title ? { title } : { title: titleFromStem(richTextToPlain(stem.rich)) }),
    points: raw.points,
    feedback: {
      ...(raw.correctFeedback.length > 0 ? { correct: plainToRich(raw.correctFeedback.join("\n")) } : {}),
      ...(raw.incorrectFeedback.length > 0 ? { incorrect: plainToRich(raw.incorrectFeedback.join("\n")) } : {}),
    },
    metadata: meta.metadata,
    media,
    findings,
    origin: { kind: "import", source, profile: PROFILE_ID, at: options.at },
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

export const standardTextImporter: Importer = {
  id: PROFILE_ID,
  label: "standard test-bank text format (plain text)",
  extensions: [".txt", ".rtf", ".md"],

  parse(input: string | SourceBlock[], options: ImportOptions = {}): ImportResult {
    const file = options.file ?? "input.txt";
    const blocks = typeof input === "string" ? linesToBlocks(input) : input;
    const at = options.at ?? new Date().toISOString();
    const author = options.author ?? "import";

    const scanned = scan(blocks, file, options.defaultPoints ?? DEFAULT_POINTS);
    const questions = scanned.questions.map((raw) => buildQuestion(raw, scanned.answerKey, file, { author, at }));

    const usedNumbers = new Set(scanned.questions.map((q) => q.number));
    for (const number of scanned.answerKey.keys()) {
      if (!usedNumbers.has(number)) {
        scanned.fileFindings.push(
          finding(
            FindingCode.KeyLetterMissing,
            "warn",
            `The Answers list has an entry for question ${number}, but no question ${number} was found in the file.`,
          ),
        );
      }
    }

    return {
      profile: PROFILE_ID,
      file,
      questions,
      orphans: scanned.orphans,
      counts: countVerdicts(questions, scanned.orphans.length),
      fileFindings: scanned.fileFindings,
    };
  },
};
