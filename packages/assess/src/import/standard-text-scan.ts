/**
 * Pass one of the Standard Format profile: source lines to raw questions.
 *
 * This used to be one mutable `target` that every line was poured into, with
 * the pattern checks running before any check of context. Six data-loss bugs
 * came from that single cause: a key block that never closed swallowed the
 * question after it, an option containing `=` was taken for a matching pair, a
 * stem line that merely read "Points: 20" reset the point value, text after the
 * options was folded into the stem, repeated labels overwrote each other, and
 * repeated question numbers shared one key.
 *
 * The shape that replaces it has four rules, and each one exists because of a
 * bug that used to live here.
 *
 *   1. The scanner is in exactly one mode at a time (see `Mode`), and what a
 *      line means depends on the mode as well as on its shape. A line that
 *      looks like a question inside an answer key is judged as a key entry
 *      first; the same line inside a stem is a new question.
 *
 *   2. An answer key can close. It takes lines that are entries for the
 *      questions it covers and nothing else; the first line that is not one
 *      ends it, and is then read in the ordinary way.
 *
 *   3. Directives (Title, Type, Points) only count as directives when a
 *      question follows them. Anywhere else they are text, because a stem is
 *      allowed to contain the words "Points: 20".
 *
 *   4. Every non-blank line ends up owned: by a question, by a key, by a
 *      directive that a question used, or by an orphan. A final sweep turns
 *      anything the state machine missed into an orphan and counts it in
 *      `unattributed`, which the tests require to be zero. Nothing is
 *      swallowed, and a scanner defect shows up as a failing count rather
 *      than as a question that quietly lost a paragraph.
 */

import { finding, FindingCode, type Finding } from "../model/findings.ts";
import type { Metadata } from "../model/question.ts";
import type { Orphan, SourceBlock } from "./types.ts";

// ---------------------------------------------------------------------------
// Line patterns
// ---------------------------------------------------------------------------

export const QUESTION_START = /^\s*(\d{1,4})\s*[.)]\s+(.*)$/;
export const OPTION_START = /^\s*(\*?)\s*([a-tA-T])\s*[.)]\s+(.*)$/;
const TITLE_LINE = /^\s*Title\s*:\s*(.*)$/i;
// Up to three letters: the generic format has E, F, MT, MA and MC, and the D2L,
// Moodle and Blackboard dialects add MR, S, FMB, ORD and JUM.
const TYPE_LINE = /^\s*Type\s*:\s*([A-Za-z]{1,3})\s*$/i;
const POINTS_LINE = /^\s*Points\s*:\s*([0-9]+(?:\.[0-9]+)?)\s*$/i;
const ANSWERS_HEADER = /^\s*Answers\s*:\s*$/i;
/**
 * The key written beside the question it belongs to, as publisher banks do:
 * "Answer: C", "ANS: B, D", "Correct Answer: True". A colon is required, so that
 * a sentence that begins with the word is not a key. "Answers:" alone is the
 * heading of a list, and is read as that first.
 */
const ANSWER_LINE = /^\s*(?:correct\s+)?(?:answers?|ans)\s*:\s*(.*)$/i;
const CORRECT_FEEDBACK = /^\s*~\s*(.*)$/;
const INCORRECT_FEEDBACK = /^\s*@\s*(.*)$/;
const ANSWER_ENTRY = /^\s*(\d{1,4})\s*[.)]\s*(.*)$/;

/**
 * What a key value looks like when it is a key and not prose: option letters
 * or True and False, separated by commas, spaces, "and" and the like. Used to
 * tell `7. B` (an entry) from `7. Explain how B relates to C.` (a question)
 * inside a key block, where the two share a shape.
 */
const KEY_TOKEN = "(?:[a-t]|true|false)";
const KEY_SEPARATOR = String.raw`(?:\s*(?:,|;|&|/|\band\b)\s*|\s+)`;
export const KEY_VALUE = new RegExp(`^${KEY_TOKEN}(?:${KEY_SEPARATOR}${KEY_TOKEN})*$`, "i");
export const KEY_SPLIT = new RegExp(String.raw`\s*(?:,|;|&|/|\band\b)\s*|\s+`, "i");

/**
 * Metadata labels publishers actually use. Anything matching the shape of a
 * label but not on this list is kept in metadata.custom rather than dropped,
 * which is what makes "nothing is dropped" true of metadata lines too.
 */
export const METADATA_LABELS: Record<string, keyof Metadata | "bloom" | "difficulty"> = {
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

/** The orphan reason for a line the state machine did not own. Should never appear. */
export const UNATTRIBUTED_REASON =
  "the scanner did not attribute this line to anything, which is a defect in the scanner; it is reported here so that it is not lost";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface RawOption {
  letter: string;
  starred: boolean;
  lines: string[];
  feedback: string[];
  firstBlock: number;
  lastBlock: number;
  /** Where the option's own text starts in its first block, after the label. */
  textOffset: number;
  /** The blocks that hold the option's own text: the first, and any line that continues it. Not its feedback. */
  textBlocks: number[];
  /** The file's formatting convention marks this option as correct. Set after the scan; see standard-text-format.ts. */
  keyedByFormat: boolean;
}

export interface RawQuestion {
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
  /**
   * Which stretch of the file this question sits in: the number of Answers
   * lists that appeared before it. A key covers the questions of its own
   * stretch, which is what lets numbering restart after every key.
   */
  segment: number;
  /** The Answers values for this question, once the lists have been matched up. */
  keyValues: string[];
  /** What "Answer:" lines beside the question said. They are the question's own key, so they come before a list. */
  answerLines: string[];
  /**
   * Things found about this question outside the builder, such as how it sits
   * with the file's formatting convention. The builder gives them the question's source.
   */
  notes: Finding[];
  /** The options the file's formatting convention marks, when one was found. Undefined when there is no convention. */
  formatMarked?: number[];
  /** What the convention is, in words such as "bold", for the messages that mention it. */
  formatConvention?: string;
  /** An Answers entry named this number, but another question in the stretch has it too. */
  keyAmbiguous: boolean;
  /** What that entry said, kept so the words are not lost along with the key. */
  ambiguousKeyValues: string[];
  /** Stem text continued after a blank line. */
  stemAfterBlank: boolean;
  /**
   * An @ line came straight after the stem, before any option. The generic
   * format reads that as feedback for an incorrect answer; D2L and Moodle read
   * it as general feedback. The scanner cannot tell which the file meant.
   */
  incorrectFeedbackBeforeOptions: boolean;
}

export interface KeyEntry {
  number: number;
  values: string[];
  firstBlock: number;
  lastBlock: number;
}

export interface KeyBlock {
  segment: number;
  firstBlock: number;
  lastBlock: number;
  entries: Map<number, KeyEntry>;
}

export interface ScanResult {
  questions: RawQuestion[];
  keyBlocks: KeyBlock[];
  orphans: Orphan[];
  fileFindings: Finding[];
  /** Non-blank lines the state machine failed to own. Zero unless the scanner has a defect. */
  unattributed: number;
}

type Mode =
  | { kind: "outside"; why: string }
  | { kind: "stem"; question: RawQuestion }
  | { kind: "option"; question: RawQuestion; option: RawOption }
  | { kind: "optionFeedback"; question: RawQuestion; option: RawOption }
  | { kind: "questionFeedback"; question: RawQuestion; which: "correct" | "incorrect" }
  /** After a blank line or a label: only structure may follow, never loose text. */
  | { kind: "tail"; question: RawQuestion }
  | { kind: "key"; block: KeyBlock; current?: KeyEntry };

type DirectiveKind = "title" | "type" | "points";
type Pending = Partial<Record<DirectiveKind, { value: string; block: SourceBlock }>>;

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

export function scanStandardText(blocks: SourceBlock[], file: string, defaultPoints: number): ScanResult {
  const questions: RawQuestion[] = [];
  const keyBlocks: KeyBlock[] = [];
  const orphans: Orphan[] = [];
  const fileFindings: Finding[] = [];
  const owned = new Set<number>();

  const count = blocks.length;
  const textAt = (i: number): string => blocks[i]?.text ?? "";
  const blankAt = (i: number): boolean => textAt(i).trim().length === 0;
  const isDirective = (text: string): boolean =>
    TITLE_LINE.test(text) || TYPE_LINE.test(text) || POINTS_LINE.test(text);

  const nextContent = (i: number): number => {
    let j = i + 1;
    while (j < count && blankAt(j)) j++;
    return j < count ? j : -1;
  };

  /**
   * Whether the directive at `i`, and any directives that follow it, lead
   * straight into a question. This is what separates a real Points line from a
   * stem line that happens to read "Points: 20".
   */
  const directiveRunLeadsToQuestion = (i: number): boolean => {
    let j = nextContent(i);
    while (j !== -1 && isDirective(textAt(j))) j = nextContent(j);
    return j !== -1 && QUESTION_START.test(textAt(j));
  };

  /** The line after this one is an option or a feedback line: a question has begun. */
  const bodyFollows = (i: number): boolean => {
    const j = nextContent(i);
    if (j === -1) return false;
    const text = textAt(j);
    return OPTION_START.test(text) || CORRECT_FEEDBACK.test(text) || INCORRECT_FEEDBACK.test(text);
  };

  const claim = (block: SourceBlock, question?: RawQuestion): void => {
    owned.add(block.index);
    if (question && block.index > question.lastBlock) question.lastBlock = block.index;
  };

  const orphan = (block: SourceBlock, reason: string): void => {
    owned.add(block.index);
    orphans.push({
      source: { file, firstBlock: block.index, lastBlock: block.index },
      text: block.text.trim(),
      reason,
    });
  };

  let points = defaultPoints;
  let pending: Pending = {};
  let mode: Mode = { kind: "outside", why: "before the first question" };
  let sawBlank = false;

  const setDirective = (kind: DirectiveKind, value: string, block: SourceBlock): void => {
    const earlier = pending[kind];
    // A directive that a later one replaces before any question used it would
    // otherwise vanish. Reporting it is cheap and it is a real lost instruction.
    if (earlier) orphan(earlier.block, `a ${kind} line that a later ${kind} line replaced before any question used it`);
    pending[kind] = { value, block };
    claim(block);
  };

  /**
   * Whether a line inside a key block is another entry of it. The same shape
   * is also a question, so the test is what surrounds and what is on the line.
   */
  const belongsToKey = (i: number, number: number, value: string, block: KeyBlock): boolean => {
    if (bodyFollows(i)) return false;
    if (value.length === 0 || KEY_VALUE.test(value)) return true;
    const covered = questions.filter((q) => q.segment === block.segment && q.number === number);
    if (covered.length === 0) return false;
    if (!block.entries.has(number)) return true;

    // A number the list has already answered. the test-bank vendor repeats the number to
    // give several accepted forms of one answer ("1. Van Hook" then "1. Dr. Van
    // Hook"), but only for a fill in the blank or short answer. For any other
    // type a repeat is the next chapter's question 1, so it stays a question.
    // A value ending in a question mark is a question whatever the type. This
    // case was lost when the key started closing: the old scanner never closed
    // one, so every repeat was swallowed, and so was everything after it.
    return covered.some((q) => q.typeHint === "F" || q.typeHint === "S") && !value.endsWith("?");
  };

  for (let i = 0; i < count; i++) {
    const block = blocks[i] as SourceBlock;
    const line = block.text;
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      sawBlank = true;
      // A blank line ends a paragraph of option or feedback text, but not a
      // stem: a long stem can have several paragraphs before its options.
      if (mode.kind === "option" || mode.kind === "optionFeedback" || mode.kind === "questionFeedback") {
        mode = { kind: "tail", question: mode.question };
      }
      continue;
    }
    const afterBlank = sawBlank;
    sawBlank = false;

    // --- inside an answer key -------------------------------------------------
    if (mode.kind === "key") {
      const entry = ANSWER_ENTRY.exec(line);
      if (entry && belongsToKey(i, Number(entry[1]), (entry[2] ?? "").trim(), mode.block)) {
        const number = Number(entry[1]);
        const value = (entry[2] ?? "").trim();
        let target = mode.block.entries.get(number);
        if (!target) {
          target = { number, values: [], firstBlock: block.index, lastBlock: block.index };
          mode.block.entries.set(number, target);
        }
        if (value.length > 0) target.values.push(value);
        target.lastBlock = block.index;
        mode.block.lastBlock = block.index;
        mode.current = target;
        claim(block);
        continue;
      }

      // A model answer for an essay or a fill in the blank can run onto the next
      // line. That is only a continuation when it follows directly, when the
      // value so far is prose rather than a letter key, and when the line is not
      // itself a heading of some other kind.
      const current = mode.current;
      const lastValue = current?.values[current.values.length - 1];
      if (
        current &&
        !entry &&
        !afterBlank &&
        (lastValue === undefined || !KEY_VALUE.test(lastValue)) &&
        !isDirective(line) &&
        !ANSWERS_HEADER.test(line)
      ) {
        if (lastValue === undefined) current.values.push(trimmed);
        else current.values[current.values.length - 1] = `${lastValue} ${trimmed}`;
        current.lastBlock = block.index;
        mode.block.lastBlock = block.index;
        claim(block);
        continue;
      }

      // The key ends here. This line is read as ordinary text below.
      mode = { kind: "outside", why: "after an Answers list and before the next question" };
    }

    // --- the start of an answer key --------------------------------------------
    if (ANSWERS_HEADER.test(line)) {
      // Always a key, even when nothing usable follows. A heading that is not
      // followed by an entry closes an empty key and says so, which is better
      // than treating the word "Answers:" as text that belongs to the question
      // above it.
      const keyBlock: KeyBlock = {
        segment: keyBlocks.length,
        firstBlock: block.index,
        lastBlock: block.index,
        entries: new Map(),
      };
      keyBlocks.push(keyBlock);
      mode = { kind: "key", block: keyBlock };
      claim(block);
      continue;
    }

    // --- Title, Type and Points ------------------------------------------------
    if (isDirective(line) && (mode.kind === "outside" || directiveRunLeadsToQuestion(i))) {
      const title = TITLE_LINE.exec(line);
      const type = TYPE_LINE.exec(line);
      const pointsMatch = POINTS_LINE.exec(line);
      if (title) setDirective("title", (title[1] ?? "").trim(), block);
      else if (type) setDirective("type", (type[1] ?? "").toUpperCase(), block);
      else if (pointsMatch) {
        points = Number(pointsMatch[1]);
        setDirective("points", String(points), block);
      }
      if (mode.kind !== "outside") mode = { kind: "outside", why: "between questions" };
      continue;
    }

    // --- a new question ---------------------------------------------------------
    const start = QUESTION_START.exec(line);
    if (start) {
      const question: RawQuestion = {
        number: Number(start[1]),
        ...(pending.type ? { typeHint: pending.type.value } : {}),
        ...(pending.title && pending.title.value.length > 0 ? { title: pending.title.value } : {}),
        points,
        stemLines: [(start[2] ?? "").trim()],
        options: [],
        correctFeedback: [],
        incorrectFeedback: [],
        metadata: [],
        firstBlock: block.index,
        lastBlock: block.index,
        segment: keyBlocks.length,
        keyValues: [],
        answerLines: [],
        notes: [],
        keyAmbiguous: false,
        ambiguousKeyValues: [],
        stemAfterBlank: false,
        incorrectFeedbackBeforeOptions: false,
      };
      pending = {};
      questions.push(question);
      claim(block, question);
      mode = { kind: "stem", question };
      continue;
    }

    if (mode.kind === "outside") {
      orphan(block, mode.why);
      continue;
    }
    const question: RawQuestion = mode.question;

    // --- an option ---------------------------------------------------------------
    const optionMatch = OPTION_START.exec(line);
    if (optionMatch) {
      const option: RawOption = {
        letter: (optionMatch[2] ?? "").toLowerCase(),
        starred: optionMatch[1] === "*",
        lines: [(optionMatch[3] ?? "").trim()],
        feedback: [],
        firstBlock: block.index,
        lastBlock: block.index,
        textOffset: line.length - (optionMatch[3] ?? "").length,
        textBlocks: [block.index],
        keyedByFormat: false,
      };
      question.options.push(option);
      claim(block, question);
      mode = { kind: "option", question, option };
      continue;
    }

    // --- feedback ----------------------------------------------------------------
    const correctMatch = CORRECT_FEEDBACK.exec(line);
    if (correctMatch) {
      question.correctFeedback.push((correctMatch[1] ?? "").trim());
      claim(block, question);
      mode = { kind: "questionFeedback", question, which: "correct" };
      continue;
    }

    const incorrectMatch = INCORRECT_FEEDBACK.exec(line);
    if (incorrectMatch) {
      const value = (incorrectMatch[1] ?? "").trim();
      claim(block, question);
      // An @ line straight after an option is that option's feedback; an @
      // line anywhere else is the question's incorrect-answer feedback.
      if (mode.kind === "option" || mode.kind === "optionFeedback") {
        mode.option.feedback.push(value);
        mode.option.lastBlock = block.index;
        mode = { kind: "optionFeedback", question, option: mode.option };
      } else {
        if (question.options.length === 0) question.incorrectFeedbackBeforeOptions = true;
        question.incorrectFeedback.push(value);
        mode = { kind: "questionFeedback", question, which: "incorrect" };
      }
      continue;
    }

    // --- the key, beside the question --------------------------------------------
    // Publisher banks give each question's answer on a line of its own after the
    // options. Without this the line was folded into the last option's text, or
    // reported as stray text, or kept as a custom label, and the question had no key.
    const answerMatch = ANSWER_LINE.exec(line);
    if (answerMatch) {
      const value = (answerMatch[1] ?? "").trim();
      if (value.length > 0) question.answerLines.push(value);
      claim(block, question);
      mode = { kind: "tail", question };
      continue;
    }

    // --- a label -----------------------------------------------------------------
    // Recognised wherever it appears, because publisher banks put these lines
    // after the options as often as before them. The label has to be one this
    // profile knows, or an all-capital short code, so that an ordinary colon
    // inside a stem or an option is not mistaken for one.
    const labelMatch = UNKNOWN_LABEL.exec(line);
    if (labelMatch) {
      const label = (labelMatch[1] ?? "").trim();
      const value = (labelMatch[2] ?? "").trim();
      if (METADATA_LABELS[label.toLowerCase()] || CODE_LABEL.test(label)) {
        question.metadata.push({ label, value, block: block.index });
        claim(block, question);
        mode = { kind: "tail", question };
        continue;
      }
    }

    // --- anything else -------------------------------------------------------------
    switch (mode.kind) {
      case "stem":
        if (afterBlank) question.stemAfterBlank = true;
        question.stemLines.push(trimmed);
        claim(block, question);
        break;
      case "option":
        mode.option.lines.push(trimmed);
        mode.option.textBlocks.push(block.index);
        mode.option.lastBlock = block.index;
        claim(block, question);
        break;
      case "optionFeedback":
        mode.option.feedback.push(trimmed);
        mode.option.lastBlock = block.index;
        claim(block, question);
        break;
      case "questionFeedback":
        (mode.which === "correct" ? question.correctFeedback : question.incorrectFeedback).push(trimmed);
        claim(block, question);
        break;
      case "tail":
        // This is where text used to be quietly folded into the stem. A heading
        // after the options, or the start of the next section, is not part of
        // this question, and it is reported as what it is.
        orphan(
          block,
          `follows the options, feedback or labels of question ${question.number} but is not another option, a feedback line or a label, so it was not added to the question`,
        );
        break;
    }
  }

  // --- the end of the file -----------------------------------------------------
  for (const kind of ["title", "type", "points"] as const) {
    const left = pending[kind];
    if (left) orphan(left.block, `a ${kind} line at the end of the file with no question after it`);
  }

  for (const key of keyBlocks) {
    if (key.entries.size === 0) {
      fileFindings.push(
        finding(FindingCode.UnparsedBlock, "warn", "An Answers heading was found with no entries after it.", {
          source: { file, firstBlock: key.firstBlock, lastBlock: key.lastBlock },
        }),
      );
    }
  }

  resolveKeys(questions, keyBlocks, file, fileFindings);
  reportRepeatedNumbers(questions, fileFindings);

  // The last line of defence for the rule that nothing is dropped silently.
  let unattributed = 0;
  for (const block of blocks) {
    if (block.text.trim().length > 0 && !owned.has(block.index)) {
      unattributed++;
      orphan(block, UNATTRIBUTED_REASON);
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

  orphans.sort((a, b) => a.source.firstBlock - b.source.firstBlock);
  return { questions, keyBlocks, orphans, fileFindings, unattributed };
}

// ---------------------------------------------------------------------------
// Matching key lists to questions
// ---------------------------------------------------------------------------

/**
 * Give each question the entry of its own Answers list.
 *
 * An entry belongs to the questions between the previous Answers list and this
 * one, which is why numbering can restart in every chapter. The old code kept
 * one table by number for the whole file, so a repeated number silently took
 * another question's key. Here a number that two questions of one stretch share
 * is not assigned to either: the entry is ambiguous, and assigning it would be
 * a guess that looks authored.
 */
function resolveKeys(
  questions: RawQuestion[],
  keyBlocks: KeyBlock[],
  file: string,
  fileFindings: Finding[],
): void {
  const unmatched: Array<{ block: KeyBlock; entry: KeyEntry }> = [];

  for (const block of keyBlocks) {
    for (const entry of block.entries.values()) {
      const covered = questions.filter((q) => q.segment === block.segment && q.number === entry.number);
      if (covered.length === 1) {
        (covered[0] as RawQuestion).keyValues = [...entry.values];
      } else if (covered.length > 1) {
        for (const q of covered) {
          q.keyAmbiguous = true;
          q.ambiguousKeyValues.push(...entry.values);
        }
      } else {
        unmatched.push({ block, entry });
      }
    }
  }

  // A list placed before its questions, which some banks do, still works when
  // the number picks out exactly one later question.
  for (const { block, entry } of unmatched) {
    const later = questions.filter((q) => q.segment > block.segment && q.number === entry.number);
    const open = later.filter((q) => q.keyValues.length === 0 && !q.keyAmbiguous);
    if (later.length === 1 && open.length === 1) {
      (open[0] as RawQuestion).keyValues = [...entry.values];
      continue;
    }

    const exists = questions.some((q) => q.number === entry.number);
    // The entry's words are quoted so that they survive in the finding. If the
    // line was really a question that looked like an entry, this is where its
    // text ends up.
    const said = entry.values.length > 0 ? ` It said: "${entry.values.join(" ")}".` : "";
    fileFindings.push(
      finding(
        FindingCode.KeyLetterMissing,
        "warn",
        (exists
          ? `The Answers list has an entry for question ${entry.number}, but no question numbered ${entry.number} is in the part of the file that list covers, so the entry was not applied.`
          : `The Answers list has an entry for question ${entry.number}, but no question ${entry.number} was found in the file.`) + said,
        { source: { file, firstBlock: entry.firstBlock, lastBlock: entry.lastBlock } },
      ),
    );
  }
}

/**
 * Repeated numbers are normal when numbering restarts after an Answers list, so
 * only a repeat inside one stretch is reported. It matters most to the key, but
 * it is also the first sign that two chapters were pasted together.
 */
function reportRepeatedNumbers(questions: RawQuestion[], fileFindings: Finding[]): void {
  const repeated = new Set<number>();
  const seen = new Set<string>();
  for (const q of questions) {
    const id = `${q.segment}:${q.number}`;
    if (seen.has(id)) repeated.add(q.number);
    seen.add(id);
  }
  if (repeated.size === 0) return;

  const listed = [...repeated].slice(0, 10).join(", ");
  fileFindings.push(
    finding(
      FindingCode.DuplicateQuestionNumber,
      "warn",
      `Question numbers repeat with no Answers list between them: ${listed}${repeated.size > 10 ? ", and more" : ""}. An Answers entry cannot tell repeated numbers apart, so it is not applied to them. Answers marked with an asterisk are still read.`,
    ),
  );
}
