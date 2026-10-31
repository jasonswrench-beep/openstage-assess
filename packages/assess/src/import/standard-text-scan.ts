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
import { AT_LEAST, CHOICE_HINTS, SHARE } from "./standard-text-format.ts";
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
 * a sentence that begins with the word is not a key ("Ans." is the one
 * abbreviation that also takes a full stop). "Answers:" alone is the heading of a
 * list, and is read as that first.
 */
const ANSWER_LINE = /^\s*(?:(?:correct|accept(?:ed|able))\s+)?(?:answers?\s*:|ans\s*[:.])\s*(.*)$/i;
/**
 * "Accepted answers: 0, zero" is a key too, and one that only a typed-in answer has: no option is
 * accepted, a word is. The label is what says so. The plural names a list, which is cut at the
 * semicolons it has or, with none, at a comma followed by a space, so that 1,000 is one answer.
 * The singular is one answer however many commas it has.
 */
const ACCEPTED_LABEL = /^\s*accept(?:ed|able)\s+answers?\s*:/i;
const ACCEPTED_LIST = /^\s*accept(?:ed|able)\s+answers\s*:/i;
/**
 * A pair written on a line of its own, "Bell = Telephone": one equals sign with a space each side. The
 * spaces are what keep a sum such as x=3 out of it, and they are not asked of a lettered option.
 */
const PAIR_LINE = /^[^=]+\s=\s[^=]+$/;
/** The instruction of a matching exercise, which is what lets lines of pairs under it be read as one. */
const MATCH_INSTRUCTION = /\bmatch(?:ing)?\b/i;
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
  // The section of the book the question comes from, as a title ("Textbook reference: AI Alignment").
  "textbook reference": "section",
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

/**
 * A heading that gives a type to the questions under it, as publisher banks group
 * theirs: "Fill in the Blank Questions", "True / False Questions", "Multiple Choice".
 * The whole line has to be the heading, so a stem that mentions the words is not one,
 * and "True    False" with spaces between, which is how a true or false question lists
 * its two choices, is not either.
 */
const SECTION_HEADING =
  /^\s*(?:chapter\s+\w+(?:-\w+)?\s+)?(?:in[\s-]*depth\s+)?(fill[\s-]+in[\s-]+(?:the[\s-]+)?blanks?|true\s*(?:\/|-|or)\s*false|multiple[\s-]+choice|multiple[\s-]+(?:response|answer)s?|short[\s-]+answers?(?:\s*\/\s*essays?)?|essays?|matching)(?:\s+(?:questions?|items?))?\s*:?\s*$/i;

function sectionType(name: string): string {
  const n = name.toLowerCase();
  if (n.startsWith("fill")) return "F";
  if (n.startsWith("true")) return "TF";
  if (/^multiple[\s-]+choice/.test(n)) return "MC";
  if (n.startsWith("multiple")) return "MA";
  if (n.startsWith("short") || n.startsWith("essay")) return "E";
  return "MT";
}

/**
 * The line that says the questions after it are the copy with the answers: "Answer
 * Key", or "Chapter 7 Answer Key". A short line, so that a sentence that mentions an
 * answer key is not one.
 */
function isAnswerKeyHeading(text: string): boolean {
  return /\banswer\s+key\s*[:.]?\s*$/i.test(text) && text.split(/\s+/).length <= 8 && !text.includes("?");
}

/** The two words of a true or false question's choices on one line, apart from each other. */
const TF_CHOICES = /^true\s*(?:\/|\||-|\bor\b|\s{2,}|\t)\s*false\.?$/i;
/** A true or false question's answer, alone on a line. */
const TF_ANSWER = /^(?:true|false)\.?$/i;
/** The line of underscores a printed test leaves to write an answer on. */
const ANSWER_SPACE = /^_{3,}[_\s]*$/;

/**
 * Where in the book a question comes from, in brackets: "(Page 3)", "(p. 230)",
 * "(pp. 12-14)". Alone on a line it is the question's page; at the end of a line it is
 * taken off the text, and either way it is kept as the question's Page. Brackets are
 * required, so a stem that says "page 3" is left alone, and so is "(p. 24)." with a
 * full stop after it, which is a citation that belongs to the sentence.
 */
const PAGE_NOTE = String.raw`\(\s*(?:pp?|pages?)\.?\s*(\d+(?:\s*[-–—,&]\s*\d+)*)\s*\)`;
const PAGE_LINE = new RegExp(`^${PAGE_NOTE}$`, "i");
const PAGE_SUFFIX = new RegExp(`\\s*${PAGE_NOTE}\\s*$`, "i");
/** A true or false question's answer at the end of its line, in brackets: "(T)", "(False)". */
const TF_SUFFIX = /\s*\(\s*(true|false|t|f)\s*\)\s*$/i;
/** A bare "1.14", the chapter and the number of a question, alone on a line with the question on the next. */
const DOTTED_NUMBER = /^\s*(\d{1,3})\.(\d{1,3})\s*$/;
/** An option letter alone on a line, which is how some banks give a choice question's answer. */
const LONE_LETTER = /^\s*([a-tA-T])\s*$/;
/** One word with nothing else on the line. */
const ONE_WORD = /^[A-Za-z]{2,12}\.?$/;
/** A number alone on a line, "3." or "3)", which starts a question only when its options follow it directly. */
const NUMBER_ALONE = /^\s*(\d{1,4})\s*[.)]\s*$/;
/**
 * The title that opens a chapter of a bank given chapter by chapter: "Chapter 2",
 * "Chapter Two Test Questions". It is not part of the question above it. Only these
 * few shapes, so a stem line that begins with the word is not one.
 */
const CHAPTER_TITLE = /^\s*chapter\s+\w+(?:-\w+)?(?:\s+(?:test\s+)?(?:questions|bank|items|test))?\s*$/i;
/**
 * A note in brackets that ends an Answer line: "(Textbook reference: Chapter 3)",
 * "(Page 12)", "(Source: the syllabus)". Only a note that names where the question
 * comes from is taken off; "(or d)" is part of the answer and is left to fail.
 */
const SOURCE_NOTE = /\s*\(\s*((?:textbook\s+)?(?:reference|ref|source|section|chapter|page|pages|pp?\.?)\b[^()]*)\)\s*\.?\s*$/i;
/**
 * A note in brackets that gives a question's difficulty, objective or another label this
 * profile knows, alone on a line: "(Difficulty 3)". Like the page, it describes the question
 * above it. The label has to be a known one, so that a line of brackets that is part of the
 * text is not taken for one.
 */
const NOTE_LINE = /^\(\s*([A-Za-z][A-Za-z' ]{1,24}?)\s*:?\s+([^()]{1,40}?)\s*\)$/;

/**
 * An answer at the end of a line that has other words before it: "D. Affect ANS: C". Only
 * the spellings of the label that publishers use, so that "answer:" in the middle of a
 * sentence is not one, and only when what follows is a key and not more words.
 */
const INLINE_ANSWER = /\s+(?:ANS|Ans|Answers?|Correct Answers?)\s*:\s*(\S.*)$/;

/** Capital letters and a full stop in a line, where the next option of a line that runs several together starts. */
const RUN_ON_MARK = /(?:^|\s)([A-T])\.\s+(?=[^\sa-z])/g;

/** A matching exercise written as a numbered term, then its definition, then sometimes a wrong answer to go with it. */
/**
 * The type of a question alone on a line, or at the start of the line that has its stem: "MC",
 * with the options under the stem having no numbers or letters. Capitals only, and only the
 * choice types, which are the ones whose options can be told apart by a star. A bare "MA" or
 * "MC" is also a thing an option can say, so it is only read where the file does this as a habit
 * and only at the start of a paragraph run: see `typeLineLayout`.
 */
const TYPE_LINE_START = /^(MC|MA|MR)(?:\s+(\S.*))?$/;

const TERM_LINE = /^\s*term\s*:\s*(\S.*)$/i;
const DEFINITION_LINE = /^\s*definition\s*:\s*(\S.*)$/i;
const FOIL_LINE = /^\s*(?:foil|distractor)\s*:\s*(\S.*)$/i;

/** The letter after this one. */
const nextLetter = (letter: string): string => String.fromCharCode(letter.charCodeAt(0) + 1);

/** The answer a line ends with, and the line without it. */
function peelInlineAnswer(text: string): { text: string; answer?: string } {
  const found = INLINE_ANSWER.exec(text);
  if (!found || found.index === 0) return { text };
  const answer = (found[1] as string).trim();
  if (!KEY_VALUE.test(answer.replace(/[.)]\s*$/, "").trim())) return { text };
  return { text: text.slice(0, found.index).trimEnd(), answer: answer.replace(/[.)]\s*$/, "").trim() };
}

/**
 * Where the options that a line runs together start. Each is a capital letter and a full
 * stop, and they have to come in order from `first`: "B. SOLER C. DAR" is two options, and a
 * "C." in the middle of option B's words is not one, because B has not been followed by C.
 * What comes after the full stop must not begin with a lower case letter, so "C. difficile" is
 * left alone.
 */
function runOnMarks(text: string, first: string): Array<{ at: number; end: number; letter: string }> {
  const marks: Array<{ at: number; end: number; letter: string }> = [];
  let expect = first.toUpperCase();
  for (const m of text.matchAll(RUN_ON_MARK)) {
    if (m[1] !== expect) continue;
    const at = (m.index ?? 0) + (m[0].length - m[0].trimStart().length);
    marks.push({ at, end: (m.index ?? 0) + m[0].length, letter: expect });
    expect = nextLetter(expect);
  }
  return marks;
}

/** An all-capital short code such as NOT, MSC or NAT that a bank may invent. */
const UNKNOWN_LABEL = /^\s*([A-Za-z][A-Za-z'\- ]{0,28})\s*:\s*(.+)$/;
const CODE_LABEL = /^[A-Z]{2,6}$/;

/**
 * Words a publisher puts before what it has to say about a question's answer.
 * "Feedback" is what the student is told, and a question has a place for that.
 * The others are explanations, and a question has no place for them, so they are
 * kept as notes. Both are recognised wherever they appear, which is the point: with
 * no rule for them they were added to whatever came just above, and a rationale
 * under the correct option became part of the option.
 */
export const GENERAL_FEEDBACK_LABELS = new Set(["feedback", "general feedback"]);
export const NOTE_LABELS = new Set(["rationale", "explanation", "solution"]);
const KNOWN_EMPTY_LABEL = /^\s*(feedback|general feedback|rationale|explanation|solution)\s*:\s*$/i;

/**
 * A line that has the shape of a label, a few words and a colon and something
 * after it, in a place where only a continuation of the text above would otherwise
 * be read. It is not added to that text. The writer of the file put a label there,
 * not more of the answer, and a label this profile does not know is reported as
 * stray text, where it can be seen, and not joined to an answer where it cannot.
 */
const LABEL_SHAPE = /^\s*[A-Za-z][A-Za-z'\-]*(?: [A-Za-z'\-]+){0,2}\s*:\s*\S/;

function labelReason(number: number | string, after: string): string {
  return `has the shape of a label that this profile does not know, and follows ${after} of question ${number}, so it was not added to it`;
}

/** The page a line of text ends with, and the line without it. */
function takePage(text: string): { text: string; page?: string } {
  const found = PAGE_SUFFIX.exec(text);
  if (!found || found.index === 0) return { text };
  return { text: text.slice(0, found.index).trimEnd(), page: (found[1] as string).replace(/\s+/g, " ") };
}

/**
 * The forms of an "Accepted answers" line. A semicolon cuts it, and without one a comma and a space do:
 * "mitochondria, mitochondrion" is two, "1,000, one thousand" is two, and "Paris, France" is two as
 * well, which is the one reading here that can be wrong, so the cut is reported with the question.
 */
function splitAcceptedList(value: string): string[] {
  return (value.includes(";") ? value.split(";") : value.split(/,\s+/)).map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * An Answer line's value without the note that says where the question comes from, and
 * without the bracket or full stop that closes a letter or a word ("b)", "False."), which
 * is dropped only when what is left reads as a key. The note is not lost: it comes back
 * as the label and value of a line of metadata ("Textbook reference: ...", "Page: 3").
 */
function splitAnswerNote(value: string): { key: string; notes: Array<{ label: string; value: string }> } {
  const tidy = (s: string): string => {
    const t = s.trim();
    const bare = t.replace(/[.)]\s*$/, "").trim();
    return bare !== t && KEY_VALUE.test(bare) ? bare : t;
  };
  const found = SOURCE_NOTE.exec(value);
  const head = found ? value.slice(0, found.index).trim() : "";
  if (!found || head === "") return { key: tidy(value), notes: [] };

  const inner = (found[1] as string).trim();
  const labelled = /^([^:]{2,30}):\s*(.+)$/.exec(inner);
  const paged = /^(?:pp?|pages?)\.?\s*(\d.*)$/i.exec(inner);
  const note = labelled
    ? { label: (labelled[1] as string).trim(), value: (labelled[2] as string).trim() }
    : paged
      ? { label: "Page", value: (paged[1] as string).trim() }
      : { label: "Source", value: inner };
  return { key: tidy(head), notes: [note] };
}

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
  /**
   * Its line holds other options too ("B. SOLER C. DAR"), so the formatting of the line says
   * nothing about this one option and is not read for it.
   */
  shared?: boolean;
}

export interface RawQuestion {
  number: number;
  /** The number as the file wrote it when that was more than one integer: "1.14", chapter and question. */
  label?: string;
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
  /** What "Feedback:" lines said: feedback shown whatever the answer. */
  generalFeedback: string[];
  /** What "Answer:" lines beside the question said. They are the question's own key, so they come before a list. */
  answerLines: string[];
  /** One of those lines was labelled "Accepted answers", which only a typed-in answer has. */
  acceptedLabel?: boolean;
  /** Its options are lines of "left = right" with no letters, read under an instruction that says to match. */
  pairLines?: boolean;
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
  /** The question stands after a heading that says the questions below it are the copy with the answers. */
  keyed: boolean;
  /** Its answer was a line under the question with no label, which a true or false, fill in the blank or essay question has in such a copy. */
  answeredBelow: boolean;
  /** Its answer was "(T)" or "(F)" at the end of its first line. */
  answeredInline: boolean;
  /** The block of its Answer line, whether on a line of its own or at the end of another. */
  answerBlock?: number;
  /**
   * Text under its Answer line that has no label, taken for now as the explanation of the
   * answer; settled at the end of the scan, when it is known whether the file does this as a habit.
   */
  rationale?: Array<{ block: SourceBlock; text: string }>;
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
  /** The lines under a fill in the blank or essay question, in a copy that gives the answers. */
  | { kind: "answer"; question: RawQuestion }
  | { kind: "key"; block: KeyBlock; current?: KeyEntry };

/** A question laid out as its type, its stem and then its options one to a line, found by `typeLineAt`. */
interface TypedRun {
  /** The type the line named. Absent when the question has no such line and is read for being laid out like the rest. */
  tag?: string;
  stemAt: number;
  stem: string;
  /** The blocks of the options, in order. Lines after them that are labels are left for the scan to read. */
  options: number[];
}

type DirectiveKind = "title" | "type" | "points";
type Pending = Partial<Record<DirectiveKind, { value: string; block: SourceBlock }>>;

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

export function scanStandardText(blocks: SourceBlock[], file: string, defaultPoints: number, readBoldAnswers = true): ScanResult {
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
  /**
   * What starts a question at block `i`: a number and its text on one line ("12) Why?"), or
   * a chapter and question number alone on a line ("1.14") with the question on the next.
   * The second is only a number when it follows on from the question before it, the next
   * one in the chapter or the start of a later chapter, or when no question is open, so
   * that a lone "3.14" inside a stem or an option is not taken for one.
   */
  const questionStartAt = (i: number): { number: number; label?: string; rest: string } | undefined => {
    const text = textAt(i);
    const typed = QUESTION_START.exec(text);
    if (typed) return { number: Number(typed[1]), rest: typed[2] ?? "" };
    // A number with nothing after it and an option straight under it: a question whose
    // text is its options, as a table of matching pairs is.
    const alone = NUMBER_ALONE.exec(text);
    if (alone) {
      const under = nextContent(i);
      return under !== -1 && OPTION_START.test(textAt(under)) ? { number: Number(alone[1]), rest: "" } : undefined;
    }
    const bare = DOTTED_NUMBER.exec(text);
    if (!bare) return undefined;
    const next = nextContent(i);
    if (next === -1) return undefined;
    const after = textAt(next);
    if (QUESTION_START.test(after) || DOTTED_NUMBER.test(after) || OPTION_START.test(after)) return undefined;

    const chapter = Number(bare[1]);
    const number = Number(bare[2]);
    // Between questions, after a heading or after a question's last line and a blank, a
    // number and text under it is a question, whatever its number, because a bank may start
    // the numbers again in each section. Inside a stem or an option it has to be the number
    // that comes next, so that a "3.14" that is part of the words is not one.
    const lastLabel = DOTTED_NUMBER.exec(questions[questions.length - 1]?.label ?? "");
    const next_ =
      lastLabel !== null && (chapter > Number(lastLabel[1]) || (chapter === Number(lastLabel[1]) && number > Number(lastLabel[2])));
    const follows = mode.kind === "outside" || mode.kind === "tail" || next_;
    return follows ? { number, label: `${chapter}.${number}`, rest: "" } : undefined;
  };

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

  /** The next option of a line that has several, when the line after this one begins with it. */
  const optionBFollows = (i: number): boolean => {
    const j = nextContent(i);
    return j !== -1 && OPTION_START.exec(textAt(j))?.[2]?.toLowerCase() === "b";
  };

  /** What this layout did, counted for the findings that say so once for the file. */
  const done = { runOn: 0, answersAtEnd: 0, labelsContinued: 0, typeLines: 0 };

  const takeAnswer = (question: RawQuestion, block: SourceBlock, answer: string): void => {
    question.answerLines.push(answer);
    question.answerBlock = block.index;
    done.answersAtEnd++;
  };

  /**
   * The options that follow `option`'s own words on its line: "B. SOLER C. DAR" is B and C. Each
   * is made an option of its own, in order, and the last is returned, because the lines that
   * follow belong to it. An answer at the end of the line is taken off first. The options that
   * share a line are marked, because how the line looks says nothing about one of them.
   */
  const splitOptionLine = (question: RawQuestion, block: SourceBlock, option: RawOption, at: number): RawOption => {
    let text = option.lines[at] ?? "";
    const peeled = peelInlineAnswer(text);
    if (peeled.answer !== undefined) {
      takeAnswer(question, block, peeled.answer);
      text = peeled.text;
    }
    const marks = runOnMarks(text, nextLetter(option.letter));
    if (marks.length === 0) {
      option.lines[at] = text;
      return option;
    }
    option.lines[at] = text.slice(0, marks[0]?.at).trimEnd();
    option.shared = true;
    let last = option;
    marks.forEach((mark, k) => {
      last = {
        letter: mark.letter.toLowerCase(),
        starred: false,
        lines: [text.slice(mark.end, marks[k + 1]?.at ?? text.length).trim()],
        feedback: [],
        firstBlock: block.index,
        lastBlock: block.index,
        textOffset: 0,
        textBlocks: [block.index],
        keyedByFormat: false,
        shared: true,
      };
      question.options.push(last);
    });
    done.runOn++;
    return last;
  };

  /**
   * The first option of a question, written at the end of the last line of its stem: "Which
   * is right? A. This B. That". Only when the letters then go on in order, from A, and B is
   * on the same line or begins the next one, so that a stem that ends in "vitamin A." is not
   * read as having an option. Returns the last option made, or nothing if the line was left as it was.
   */
  const splitStemLine = (question: RawQuestion, block: SourceBlock, i: number): RawOption | undefined => {
    const at = question.stemLines.length - 1;
    if (at < 0) return undefined;
    let text = question.stemLines[at] ?? "";
    const peeled = peelInlineAnswer(text);
    if (peeled.answer !== undefined) {
      takeAnswer(question, block, peeled.answer);
      text = peeled.text;
    }
    const marks = runOnMarks(text, "a");
    const first = marks[0];
    if (!first || first.at === 0 || (marks.length < 2 && !optionBFollows(i))) {
      question.stemLines[at] = text;
      return undefined;
    }
    question.stemLines[at] = text.slice(0, first.at).trimEnd();
    let last: RawOption | undefined;
    marks.forEach((mark, k) => {
      last = {
        letter: mark.letter.toLowerCase(),
        starred: false,
        lines: [text.slice(mark.end, marks[k + 1]?.at ?? text.length).trim()],
        feedback: [],
        firstBlock: block.index,
        lastBlock: block.index,
        textOffset: 0,
        textBlocks: [block.index],
        keyedByFormat: false,
        shared: true,
      };
      question.options.push(last);
    });
    done.runOn++;
    return last;
  };

  /** The label whose value the line above may go on into, until a line of anything else comes between. */
  let lastLabel: { question: RawQuestion; entry: { label: string; value: string; block: number }; block: number } | undefined;
  /** The last line that had anything on it, so that "directly under" can be told from "after a blank line". */
  let prevContent = -1;
  let points = defaultPoints;
  let pending: Pending = {};
  let mode: Mode = { kind: "outside", why: "before the first question" };
  let sawBlank = false;
  /** The type a section heading gave, until the next heading. `used` says whether a question has had it. */
  let section: { type: string; block: SourceBlock; used: boolean; title: string } | undefined;
  /** The matching exercise that numbered terms and their definitions are being gathered into, and the heading it is under. */
  let termGroup: { question: RawQuestion; section: typeof section } | undefined;
  /** Whether a heading has said that the questions from here on are the copy with the answers. */
  let keyed = false;
  /** Letters alone under a question's options that were taken as its answer, until the file shows it does that as a habit. */
  const looseLetters: Array<{ question: RawQuestion; block: SourceBlock; text: string; option?: RawOption }> = [];

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

  // --- a layout with no numbers and no letters ------------------------------------------
  // "MC" alone on a line, the stem under it, the options under that one to a line, the right
  // one with a star in front, and a blank line before the next. Some instructors write a bank
  // this way. The type line is all that says where a question begins, so it is read only when the
  // file does it at least AT_LEAST times, and only at the start of a run of lines.

  /** The last block of the run of lines with no blank line between them, from `i`. */
  const runEnd = (i: number): number => {
    let j = i;
    while (j + 1 < count && !blankAt(j + 1)) j++;
    return j;
  };

  /** A line under the options that is the question's answer, page or a label, and is read in the ordinary way. */
  const isTrailer = (text: string): boolean => {
    const t = text.trim();
    if (ANSWER_LINE.test(t) || PAGE_LINE.test(t) || CORRECT_FEEDBACK.test(t) || INCORRECT_FEEDBACK.test(t) || KNOWN_EMPTY_LABEL.test(t)) {
      return true;
    }
    const note = NOTE_LINE.exec(t);
    if (note && METADATA_LABELS[(note[1] as string).trim().toLowerCase()]) return true;
    const name = UNKNOWN_LABEL.exec(t)?.[1]?.trim().toLowerCase();
    return name !== undefined && (GENERAL_FEEDBACK_LABELS.has(name) || NOTE_LABELS.has(name) || METADATA_LABELS[name] !== undefined);
  };

  /** The options from `from` to the end of the run, stopping at the first trailer once there are two. */
  const typedOptions = (from: number, end: number): number[] => {
    const found: number[] = [];
    for (let j = from; j <= end; j++) {
      if (found.length >= 2 && isTrailer(textAt(j))) break;
      found.push(j);
    }
    return found;
  };

  /**
   * Whether a question begins at `i` with its type: "MC" alone, or "MC" and the stem on one line. It
   * needs a stem and at least two options under it, so a line that says only "MA" above a short list
   * of other things is not one.
   */
  const typeLineAt = (i: number): TypedRun | undefined => {
    const m = TYPE_LINE_START.exec(textAt(i).trim());
    if (!m) return undefined;
    const end = runEnd(i);
    const stemAt = m[2] === undefined ? i + 1 : i;
    const options = typedOptions(stemAt + 1, end);
    if (options.length < 2) return undefined;
    return { tag: m[1] as string, stemAt, stem: (m[2] ?? textAt(stemAt)).trim(), options };
  };

  const typeLines = ((): number => {
    let n = 0;
    // The start of a run is also the line under a heading, as the loop below reads it.
    for (let i = 0; i < count; i++) if ((i === 0 || blankAt(i - 1) || SECTION_HEADING.test(textAt(i - 1))) && typeLineAt(i)) n++;
    return n;
  })();
  const typeLineLayout = typeLines >= AT_LEAST;

  /**
   * A run laid out like those, with its type line missing: a stem, then two or more options, exactly
   * one with a star in front. The star is what makes it a question; a run of lines that merely
   * has the shape is not. Read only under a file that has type lines, and flagged.
   */
  const untypedAt = (i: number): TypedRun | undefined => {
    // A type line that has too little under it to be a question is not the stem of one.
    if (TYPE_LINE_START.test(textAt(i).trim())) return undefined;
    const end = runEnd(i);
    const options = typedOptions(i + 1, end);
    if (options.length < 2) return undefined;
    const starred = options.filter((j) => textAt(j).trim().startsWith("*")).length;
    const lines = [i, ...options];
    if (starred !== 1 || textAt(i).trim().startsWith("*")) return undefined;
    if (lines.some((j) => QUESTION_START.test(textAt(j)) || OPTION_START.test(textAt(j)) || isDirective(textAt(j)))) return undefined;
    return { stemAt: i, stem: textAt(i).trim(), options };
  };

  /**
   * The lines from `from` that are pairs written "left = right", to the first line that is not. A left side
   * that comes twice is not a matching exercise (the same rule the lettered kind has), so it is no run.
   */
  const pairRunAt = (from: number): number[] => {
    const run: number[] = [];
    const lefts = new Set<string>();
    for (let j = from; j < count; j++) {
      const t = textAt(j).trim();
      if (!PAIR_LINE.test(t) || t.startsWith("*") || QUESTION_START.test(t) || OPTION_START.test(t) || isDirective(t) || isTrailer(t)) break;
      const left = t.slice(0, t.indexOf("=")).trim().toLowerCase();
      if (lefts.has(left)) return [];
      lefts.add(left);
      run.push(j);
    }
    return run;
  };

  /** Make the question of a run and return the last block it used. */
  const readTypedRun =(run: TypedRun, first: number): number => {
    const stemBlock = blocks[run.stemAt] as SourceBlock;
    const taken = takePage(run.stem);
    if (section) section.used = true;
    const question: RawQuestion = {
      number: questions.length + 1,
      ...(run.tag ? { typeHint: run.tag } : {}),
      ...(pending.title && pending.title.value.length > 0 ? { title: pending.title.value } : {}),
      points,
      stemLines: [taken.text],
      options: [],
      correctFeedback: [],
      incorrectFeedback: [],
      metadata: [],
      firstBlock: first,
      lastBlock: first,
      segment: keyBlocks.length,
      keyValues: [],
      answerLines: [],
      generalFeedback: [],
      notes: [],
      keyAmbiguous: false,
      ambiguousKeyValues: [],
      stemAfterBlank: false,
      keyed,
      answeredBelow: false,
      answeredInline: false,
      incorrectFeedbackBeforeOptions: false,
    };
    if (taken.page) question.metadata.push({ label: "Page", value: taken.page, block: stemBlock.index });
    pending = {};
    questions.push(question);
    for (let j = first; j <= run.stemAt; j++) claim(blocks[j] as SourceBlock, question);
    run.options.forEach((at, k) => {
      const optionBlock = blocks[at] as SourceBlock;
      // The star is the file's mark for the right option, and is not part of its words.
      const prefix = /^\s*\*?\s*/.exec(optionBlock.text)?.[0] ?? "";
      question.options.push({
        letter: k < 26 ? String.fromCharCode(97 + k) : "?",
        starred: prefix.includes("*"),
        lines: [optionBlock.text.slice(prefix.length).trim()],
        feedback: [],
        firstBlock: optionBlock.index,
        lastBlock: optionBlock.index,
        textOffset: prefix.length,
        textBlocks: [optionBlock.index],
        keyedByFormat: false,
      });
      claim(optionBlock, question);
    });
    // The next question with no blank line before it reads as more options of this one, and if this one has
    // no star of its own, the other's would be taken for its key. An option that is only "MA" can be real, so
    // this is a warning, not a split.
    if (run.options.some((at) => TYPE_LINE_START.test(textAt(at).trim()))) {
      question.notes.push(
        finding(
          FindingCode.TypeLineAmongOptions,
          "warn",
          `A line among this question's options is a type line. If it is the start of the next question and the blank line before it is missing, two questions were read as one, and the star that was taken for the key may belong to the other. Check it.`,
          { field: "body.options", source: { file, firstBlock: first, lastBlock: run.options[run.options.length - 1] ?? first } },
        ),
      );
    }
    if (run.tag === undefined) {
      question.notes.push(
        finding(
          FindingCode.TypeLineMissing,
          "warn",
          `This question has no type line above it, as the others in the file have. It was read as a question because its options are laid out like theirs and one of them has a star in front, so the start of the question was guessed. Check it.`,
          { field: "stem", source: { file, firstBlock: first, lastBlock: run.options[run.options.length - 1] ?? first } },
        ),
      );
    }
    return run.options[run.options.length - 1] ?? run.stemAt;
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
    const before = prevContent;
    prevContent = i;

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

    // --- a chapter title -----------------------------------------------------------
    // After the last line of a question, and a blank, it used to be added to that
    // question's stem. It is the start of something else, so the question ends here.
    if (CHAPTER_TITLE.test(trimmed) && mode.kind !== "outside") {
      orphan(block, "a chapter title, which is not part of the question above it");
      mode = { kind: "outside", why: "after a chapter title" };
      continue;
    }

    // --- headings: a type for the section, and the copy with the answers ----------
    // These come before everything else in a question, because a heading after the
    // last option used to be added to that option, or to the stem, and the section
    // it began was read as more of the question above it.
    // "True / False" under a true or false question is the list of its two choices, not
    // the heading of a section, though the two are the same words.
    const choicesLine = mode.kind === "stem" && mode.question.typeHint === "TF" && TF_CHOICES.test(trimmed);
    const heading = choicesLine ? null : SECTION_HEADING.exec(line);
    if (heading) {
      if (section && !section.used) orphan(section.block, "a section heading that no question used before the next heading");
      section = { type: sectionType(heading[1] as string), block, used: false, title: trimmed };
      claim(block);
      mode = { kind: "outside", why: "after a section heading" };
      continue;
    }
    if (isAnswerKeyHeading(trimmed)) {
      if (!keyed) {
        fileFindings.push(
          finding(
            FindingCode.AnswerKeyPart,
            "info",
            `"${trimmed}" was read as the heading of a copy of the questions that has their answers. From there, a line under a fill in the blank or essay question is its answer.`,
            { source: { file, firstBlock: block.index, lastBlock: block.index } },
          ),
        );
      }
      keyed = true;
      claim(block);
      mode = { kind: "outside", why: "after the answer key heading" };
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

    // --- a number out of sequence, in the middle of a stem --------------------------
    // A line wrapped in Word can break a sentence before a number: "...by the end of day" and
    // then "1. Which diagnosis...". Directly under a stem that has no options yet, a number
    // that is not the next one but the same or an earlier one is the rest of that sentence, not
    // a question that starts the numbers again. A number that goes on from the last is a question.
    // (The scanner is in stem mode only until the first option, so there are none to look for.)
    if (mode.kind === "stem" && !afterBlank && mode.question.stemLines.length > 0 && mode.question.label === undefined) {
      const typed = QUESTION_START.exec(line);
      if (typed && Number(typed[1]) <= mode.question.number) {
        const q = mode.question;
        q.stemLines.push(trimmed);
        q.notes.push(
          finding(
            FindingCode.NumberOutOfSequence,
            "warn",
            `A line that begins with the number ${typed[1]} came straight under the text of question ${q.number}, which is a number that does not go on from it, so it was read as part of that question's text and not as a question of its own. Check where the question ends.`,
            { field: "stem", source: { file, firstBlock: block.index, lastBlock: block.index } },
          ),
        );
        claim(block, q);
        continue;
      }
    }

    // --- a question that begins with its type ------------------------------------------
    if (typeLineLayout && (afterBlank || mode.kind === "outside")) {
      const typed = typeLineAt(i);
      if (typed) {
        done.typeLines++;
        i = readTypedRun(typed, i);
        prevContent = i;
        mode = { kind: "tail", question: questions[questions.length - 1] as RawQuestion };
        continue;
      }
    }

    // --- a new question ---------------------------------------------------------
    const start = questionStartAt(i);
    if (start) {
      // A Type line is the file's own word for this question, and it comes before the
      // heading of the section the question is in.
      let typeHint = pending.type?.value ?? section?.type;
      if (!pending.type && section) section.used = true;

      // A matching exercise written as "1) Term: ...", "Definition: ..." and "Foil: ...": each
      // numbered item is one pair and a wrong answer to go with it, and the items of a section
      // are one exercise, as the rows of a table of pairs are.
      const termItem = ((): { term: string; definition: string; foil?: string; defAt: number; foilAt?: number } | undefined => {
        if (start.label !== undefined || (typeHint !== undefined && typeHint !== "MT")) return undefined;
        const term = TERM_LINE.exec(start.rest);
        if (!term) return undefined;
        const defAt = nextContent(i);
        const definition = defAt === -1 ? null : DEFINITION_LINE.exec(textAt(defAt));
        if (defAt === -1 || !definition) return undefined;
        const foilAt = nextContent(defAt);
        const foil = foilAt === -1 ? null : FOIL_LINE.exec(textAt(foilAt));
        return {
          term: (term[1] as string).trim(),
          definition: (definition[1] as string).trim(),
          ...(foil && foilAt !== -1 ? { foil: (foil[1] as string).trim(), foilAt } : {}),
          defAt,
        };
      })();
      if (termItem) {
        typeHint = "MT";
        const group = termGroup && termGroup.section === section && questions[questions.length - 1] === termGroup.question ? termGroup : undefined;
        const into: RawQuestion = group?.question ?? {
          number: start.number,
          typeHint: "MT",
          ...(pending.title && pending.title.value.length > 0 ? { title: pending.title.value } : {}),
          points,
          stemLines: [],
          options: [],
          correctFeedback: [],
          incorrectFeedback: [],
          metadata: [],
          firstBlock: block.index,
          lastBlock: block.index,
          segment: keyBlocks.length,
          keyValues: [],
          answerLines: [],
          generalFeedback: [],
          notes: [],
          keyAmbiguous: false,
          ambiguousKeyValues: [],
          stemAfterBlank: false,
          keyed,
          answeredBelow: false,
          answeredInline: false,
          incorrectFeedbackBeforeOptions: false,
        };
        if (!group) {
          pending = {};
          questions.push(into);
          termGroup = { question: into, section };
          if (section) {
            into.stemLines.push(section.title);
            into.notes.push(
              finding(
                FindingCode.StemFromHeading,
                "warn",
                `These matching items have no instruction of their own, so the heading "${section.title}" was used as the question's text. Check that it says what the student is to do.`,
                { field: "stem" },
              ),
            );
          }
        }
        const letterFor = (n: number): string => (n < 26 ? String.fromCharCode(97 + n) : "?");
        const pair: RawOption = {
          letter: letterFor(into.options.length),
          starred: false,
          lines: [`${termItem.term} = ${termItem.definition}`],
          feedback: [],
          firstBlock: block.index,
          lastBlock: termItem.defAt,
          textOffset: 0,
          textBlocks: [block.index, termItem.defAt],
          keyedByFormat: false,
          shared: true,
        };
        into.options.push(pair);
        claim(block, into);
        claim(blocks[termItem.defAt] as SourceBlock, into);
        if (termItem.foil !== undefined && termItem.foilAt !== undefined) {
          into.options.push({
            letter: letterFor(into.options.length),
            starred: false,
            lines: [termItem.foil],
            feedback: [],
            firstBlock: termItem.foilAt,
            lastBlock: termItem.foilAt,
            textOffset: 0,
            textBlocks: [termItem.foilAt],
            keyedByFormat: false,
            shared: true,
          });
          claim(blocks[termItem.foilAt] as SourceBlock, into);
        }
        // The lines under the item up to the next one are read with it, so that the page and
        // the difficulty written under each are kept, and the next item is found by its number.
        i = termItem.foilAt ?? termItem.defAt;
        prevContent = i;
        mode = { kind: "tail", question: into };
        continue;
      }

      // The end of the first line can carry the page the question comes from and, in a
      // true or false section, its answer: "Communication is a process. (T) (Page 20)".
      let first = start.rest.trim();
      let page = takePage(first);
      first = page.text;
      let inline: string | undefined;
      const tf = typeHint === "TF" ? TF_SUFFIX.exec(first) : null;
      if (tf) {
        inline = /^t/i.test(tf[1] as string) ? "true" : "false";
        first = first.slice(0, tf.index).trimEnd();
      }
      if (!page.page) {
        page = takePage(first);
        first = page.text;
      }

      const question: RawQuestion = {
        number: start.number,
        ...(start.label ? { label: start.label } : {}),
        ...(typeHint ? { typeHint } : {}),
        ...(pending.title && pending.title.value.length > 0 ? { title: pending.title.value } : {}),
        points,
        stemLines: first.length > 0 ? [first] : [],
        options: [],
        correctFeedback: [],
        incorrectFeedback: [],
        metadata: [],
        firstBlock: block.index,
        lastBlock: block.index,
        segment: keyBlocks.length,
        keyValues: [],
        answerLines: [],
        generalFeedback: [],
        notes: [],
        keyAmbiguous: false,
        ambiguousKeyValues: [],
        stemAfterBlank: false,
        keyed,
        answeredBelow: false,
        answeredInline: inline !== undefined,
        incorrectFeedbackBeforeOptions: false,
      };
      if (page.page) question.metadata.push({ label: "Page", value: page.page, block: block.index });
      if (inline) question.answerLines.push(inline);
      pending = {};
      questions.push(question);
      claim(block, question);
      const runOn = splitStemLine(question, block, i);
      mode = question.answerBlock === block.index ? { kind: "tail", question } : runOn ? { kind: "option", question, option: runOn } : { kind: "stem", question };
      continue;
    }

    // --- the same layout with its type line missing --------------------------------------
    // The last question of a file whose type line was left off. Only after a question that had one.
    if (typeLineLayout && afterBlank && questions.length > 0 && (mode.kind === "tail" || mode.kind === "outside")) {
      const untyped = untypedAt(i);
      if (untyped) {
        i = readTypedRun(untyped, i);
        prevContent = i;
        mode = { kind: "tail", question: questions[questions.length - 1] as RawQuestion };
        continue;
      }
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
      // A matching exercise given as a table of pairs has no text of its own. Its section
      // heading is the nearest thing the file says about it, and it is used, and flagged.
      if (question.options.length === 0 && question.stemLines.length === 0 && question.typeHint === "MT" && section) {
        question.stemLines.push(section.title);
        question.notes.push(
          finding(
            FindingCode.StemFromHeading,
            "warn",
            `This matching question has no text of its own, so the heading "${section.title}" was used as its text. Check that it says what the student is to do.`,
            { field: "stem" },
          ),
        );
      }
      question.options.push(option);
      claim(block, question);
      const last = splitOptionLine(question, block, option, 0);
      // An answer at the end of the line closes the question: what is under it is not more of the option.
      mode = question.answerBlock === block.index ? { kind: "tail", question } : { kind: "option", question, option: last };
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
      // "Answer: b) (Textbook reference: Chapter 3)": the key, and where the question comes from.
      const { key, notes } = splitAnswerNote((answerMatch[1] ?? "").trim());
      if (key.length > 0 && ACCEPTED_LABEL.test(line)) {
        question.acceptedLabel = true;
        const forms = ACCEPTED_LIST.test(line) ? splitAcceptedList(key) : [key];
        question.answerLines.push(...forms);
        if (forms.length > 1) {
          question.notes.push(
            finding(
              FindingCode.AcceptedAnswersSplit,
              "info",
              `"${key}" was read as ${forms.length} accepted answers (${forms.map((f) => `"${f}"`).join(", ")}), cut where the line has a semicolon or, with none, a comma and a space. If one of them is a single answer that has a comma in it, join them again.`,
              { field: "body" },
            ),
          );
        }
      } else if (key.length > 0) {
        question.answerLines.push(key);
      }
      question.answerBlock = block.index;
      for (const note of notes) question.metadata.push({ ...note, block: block.index });
      claim(block, question);
      mode = { kind: "tail", question };
      continue;
    }

    // --- the page, alone on a line ------------------------------------------------
    // "(Page 3)" under the options used to be added to the last option, which hid
    // whether that option was bold and put a page number into its words.
    const pageLine = PAGE_LINE.exec(trimmed);
    if (pageLine) {
      question.metadata.push({ label: "Page", value: (pageLine[1] as string).replace(/\s+/g, " "), block: block.index });
      claim(block, question);
      mode = { kind: "tail", question };
      continue;
    }

    // --- another note in brackets, alone on a line: "(Difficulty 3)" ----------------
    const noteLine = NOTE_LINE.exec(trimmed);
    if (noteLine && METADATA_LABELS[(noteLine[1] as string).trim().toLowerCase()]) {
      question.metadata.push({ label: (noteLine[1] as string).trim(), value: (noteLine[2] as string).trim(), block: block.index });
      claim(block, question);
      mode = { kind: "tail", question };
      continue;
    }

    // --- a label -----------------------------------------------------------------
    // Recognised wherever it appears, because publisher banks put these lines
    // after the options as often as before them. The label has to be one this
    // profile knows, or an all-capital short code, so that an ordinary colon
    // inside a stem or an option is not mistaken for one.
    // A known label with nothing after it, such as a blank "Feedback:" left in a
    // template, is still a label. It would otherwise be added to the text above.
    if (KNOWN_EMPTY_LABEL.test(line)) {
      claim(block, question);
      mode = { kind: "tail", question };
      continue;
    }
    const labelMatch = UNKNOWN_LABEL.exec(line);
    if (labelMatch) {
      const label = (labelMatch[1] ?? "").trim();
      const value = (labelMatch[2] ?? "").trim();
      const known = label.toLowerCase();
      if (GENERAL_FEEDBACK_LABELS.has(known)) {
        question.generalFeedback.push(value);
        claim(block, question);
        mode = { kind: "tail", question };
        continue;
      }
      if (METADATA_LABELS[known] || NOTE_LABELS.has(known) || CODE_LABEL.test(label)) {
        const entry = { label, value, block: block.index };
        question.metadata.push(entry);
        lastLabel = { question, entry, block: block.index };
        claim(block, question);
        mode = { kind: "tail", question };
        continue;
      }
    }

    // --- a letter alone under the options --------------------------------------------
    // Some banks give a choice question's answer as the letter on a line of its own
    // after the last option: "e. manager", then "d". It has to name an option the
    // question has, and the question has to have none of its own marks, so a letter
    // that happens to end a wrapped option is not the first thing read as a key.
    const lone = LONE_LETTER.exec(trimmed);
    if (
      lone &&
      (mode.kind === "option" || mode.kind === "tail") &&
      question.options.length >= 2 &&
      question.answerLines.length === 0 &&
      !question.options.some((o) => o.starred) &&
      (question.typeHint === undefined || CHOICE_HINTS.has(question.typeHint)) &&
      question.options.some((o) => o.letter === (lone[1] as string).toLowerCase())
    ) {
      // Taken for now, and given back at the end if the file does not do this as a habit.
      question.answerLines.push((lone[1] as string).toLowerCase());
      question.answeredBelow = true;
      looseLetters.push({ question, block, text: trimmed, ...(mode.kind === "option" ? { option: mode.option } : {}) });
      claim(block, question);
      mode = { kind: "tail", question };
      continue;
    }

    // --- anything else -------------------------------------------------------------
    switch (mode.kind) {
      case "stem": {
        const hint = question.typeHint;
        // A printed true or false question lists its two choices on a line, and a
        // fill in the blank leaves a line to write on. They say what the question is
        // and carry no words of its own, so they are not added to the stem.
        if (hint === "TF" && TF_CHOICES.test(trimmed)) {
          claim(block, question);
          break;
        }
        if (hint === "F" && ANSWER_SPACE.test(trimmed)) {
          claim(block, question);
          break;
        }
        // The word True or False alone under a true or false question can only be its
        // answer. Under a fill in the blank or an essay, a line after a blank is the
        // answer only in the copy that has the answers; in any other file it is more
        // of the question, as it always was.
        // A single word after a blank line is an answer too, even when it is not one the
        // question can use ("fasle"): it must not become the second line of the statement,
        // and as an answer it is reported as one that could not be read.
        if (hint === "TF" && (TF_ANSWER.test(trimmed) || (afterBlank && ONE_WORD.test(trimmed)))) {
          question.answerLines.push(trimmed.replace(/\.$/, ""));
          question.answeredBelow = true;
          claim(block, question);
          mode = { kind: "tail", question };
          break;
        }
        if ((hint === "F" || hint === "E") && question.keyed && afterBlank) {
          question.answerLines.push(trimmed);
          question.answeredBelow = true;
          claim(block, question);
          mode = { kind: "answer", question };
          break;
        }
        // A matching exercise with no letters: an instruction that says to match, then a line for each
        // pair, "Bell = Telephone". Both are asked for. A line with an equals sign is far more often a
        // sum in a stem, and a stem that says match is not otherwise followed by lines of pairs.
        // The run has to begin right after the instruction. One that begins after a pair line was
        // refused (a left side that comes twice, a star) would be the rest of that exercise with its
        // first pair left in the stem, a matching question that looks complete and is not.
        if (
          hint === undefined &&
          question.options.length === 0 &&
          question.stemLines.length > 0 &&
          MATCH_INSTRUCTION.test(question.stemLines.join(" ")) &&
          !question.stemLines.some((l) => PAIR_LINE.test(l.trim()))
        ) {
          const pairs = pairRunAt(i);
          if (pairs.length >= 2) {
            pairs.forEach((at, k) => {
              const pairBlock = blocks[at] as SourceBlock;
              question.options.push({
                letter: k < 26 ? String.fromCharCode(97 + k) : "?",
                starred: false,
                lines: [pairBlock.text.trim()],
                feedback: [],
                firstBlock: pairBlock.index,
                lastBlock: pairBlock.index,
                textOffset: 0,
                textBlocks: [pairBlock.index],
                keyedByFormat: false,
              });
              claim(pairBlock, question);
            });
            question.pairLines = true;
            i = pairs[pairs.length - 1] as number;
            prevContent = i;
            mode = { kind: "tail", question };
            break;
          }
        }
        // A stem whose first line was the number alone has no earlier line to span a blank from.
        if (afterBlank && question.stemLines.length > 0) question.stemAfterBlank = true;
        const taken = takePage(trimmed);
        if (taken.page) question.metadata.push({ label: "Page", value: taken.page, block: block.index });
        question.stemLines.push(taken.text);
        claim(block, question);
        const runOn = splitStemLine(question, block, i);
        if (question.answerBlock === block.index) mode = { kind: "tail", question };
        else if (runOn) mode = { kind: "option", question, option: runOn };
        break;
      }
      case "answer":
        question.answerLines.push(trimmed);
        claim(block, question);
        break;
      case "option":
        if (LABEL_SHAPE.test(line)) {
          orphan(block, labelReason(question.label ?? question.number,"an option"));
          mode = { kind: "tail", question };
          break;
        }
        {
          const current: RawOption = mode.option;
          current.lines.push(trimmed);
          current.textBlocks.push(block.index);
          current.lastBlock = block.index;
          claim(block, question);
          const last = splitOptionLine(question, block, current, current.lines.length - 1);
          mode = question.answerBlock === block.index ? { kind: "tail", question } : { kind: "option", question, option: last };
        }
        break;
      case "optionFeedback":
        if (LABEL_SHAPE.test(line)) {
          orphan(block, labelReason(question.label ?? question.number,"an option's feedback"));
          mode = { kind: "tail", question };
          break;
        }
        mode.option.feedback.push(trimmed);
        mode.option.lastBlock = block.index;
        claim(block, question);
        break;
      case "questionFeedback":
        if (LABEL_SHAPE.test(line)) {
          orphan(block, labelReason(question.label ?? question.number,"the feedback"));
          mode = { kind: "tail", question };
          break;
        }
        (mode.which === "correct" ? question.correctFeedback : question.incorrectFeedback).push(trimmed);
        claim(block, question);
        break;
      case "tail": {
        // A KEY line that Word broke across paragraphs: "KEY: Cognitive Level: ... | Client" and then
        // "Need: Safe Care". Only a label whose value is a list of fields separated by bars, so that a
        // line of stray text under "DIF: Easy" is still stray text, and only directly under it, with
        // no blank line between. A line that is a label, an option or a question of its own is read above.
        const open = lastLabel;
        if (open && open.question === question && !afterBlank && before === open.block && open.entry.value.includes("|")) {
          open.entry.value = `${open.entry.value} ${trimmed}`.trim();
          open.block = i;
          done.labelsContinued++;
          claim(block, question);
          break;
        }
        // The explanation of the answer, in a paragraph or two under the Answer line and with no
        // label of its own. It is taken for now and settled at the end of the scan, when it is
        // known whether the file does this in most of its questions.
        const lastRationale = question.rationale?.[question.rationale.length - 1];
        if (question.answerBlock !== undefined && !afterBlank && (before === question.answerBlock || (lastRationale !== undefined && lastRationale.block.index === before))) {
          (question.rationale ??= []).push({ block, text: trimmed });
          claim(block, question);
          break;
        }
        // A pair that comes after the pairs, past a blank line or a line of other text. The run
        // stopped, so it is not one of them, but a matching question that looks complete with a pair
        // missing is worse than one that is flagged.
        if (question.pairLines && PAIR_LINE.test(trimmed)) {
          question.notes.push(
            finding(
              FindingCode.PairLeftOut,
              "warn",
              `"${trimmed}" looks like a pair, but it comes after a blank line or other text that ended this question's pairs, so it was not read as one of them. Check that no pair is missing.`,
              { field: "body.pairs" },
            ),
          );
        }
        // This is where text used to be quietly folded into the stem. A heading
        // after the options, or the start of the next section, is not part of
        // this question, and it is reported as what it is.
        orphan(
          block,
          `follows the options, feedback or labels of question ${question.label ?? question.number} but is not another option, a feedback line or a label, so it was not added to the question`,
        );
        break;
      }
    }
  }

  // --- the end of the file -----------------------------------------------------
  for (const kind of ["title", "type", "points"] as const) {
    const left = pending[kind];
    if (left) orphan(left.block, `a ${kind} line at the end of the file with no question after it`);
  }

  if (section && !section.used) orphan(section.block, "a section heading with no question after it");

  // A letter alone under the options is an answer only if the file gives its answers that
  // way in most of its choice questions. One in a file that does not, such as a stray cell
  // of a table after the last question, is given back as what it was before: stray text, or
  // the end of the option above it. This is the same bar a mark made with formatting has.
  if (looseLetters.length > 0) {
    const eligible = questions.filter((q) => q.options.length >= 2 && (q.typeHint === undefined || CHOICE_HINTS.has(q.typeHint)));
    const showing = new Set(looseLetters.map((l) => l.question)).size;
    if (showing < AT_LEAST || showing < SHARE * eligible.length) {
      for (const loose of looseLetters) {
        const at = loose.question.answerLines.lastIndexOf(loose.text.toLowerCase());
        if (at !== -1) loose.question.answerLines.splice(at, 1);
        loose.question.answeredBelow = false;
        if (loose.option) {
          loose.option.lines.push(loose.text);
          loose.option.textBlocks.push(loose.block.index);
          loose.option.lastBlock = loose.block.index;
        } else {
          orphan(
            loose.block,
            `follows the options of question ${loose.question.label ?? loose.question.number} but is not another option, a feedback line or a label, so it was not added to the question. It is a letter that names one of its options, but only ${showing} of ${eligible.length} choice questions in the file have one, which is not enough to read it as the answer`,
          );
        }
      }
    }
  }

  // Text directly under an Answer line, with no label, is the explanation of the answer, but only
  // if the file does it in most of the questions that have an Answer line. A paragraph that
  // follows one now and then is stray text, as it always was, and is given back as that.
  const explained = questions.filter((q) => (q.rationale?.length ?? 0) > 0);
  if (explained.length > 0) {
    const answered = questions.filter((q) => q.answerBlock !== undefined);
    if (explained.length >= AT_LEAST && explained.length >= SHARE * answered.length) {
      for (const q of explained) {
        const lines = q.rationale ?? [];
        q.metadata.push({ label: "Rationale", value: lines.map((l) => l.text).join(" "), block: lines[0]?.block.index ?? q.firstBlock });
      }
      fileFindings.push(
        finding(
          FindingCode.RationaleRead,
          "info",
          `${explained.length} of ${answered.length} questions that give their answer on an Answer line have text under it with no label, which was read as the explanation of the answer and kept as a note. A question has no field for an explanation, and it was not made feedback, which a student is shown.`,
        ),
      );
    } else {
      for (const q of explained) {
        for (const line of q.rationale ?? []) {
          orphan(
            line.block,
            `follows the options, feedback or labels of question ${q.label ?? q.number} but is not another option, a feedback line or a label, so it was not added to the question. It is directly under an Answer line, but only ${explained.length} of ${answered.length} questions that have one have text there, which is not enough to read it as the explanation of the answer`,
          );
        }
      }
    }
  }

  if (done.typeLines > 0) {
    fileFindings.push(
      finding(
        FindingCode.TypeLineQuestions,
        "info",
        `${done.typeLines === 1 ? "One question" : `${done.typeLines} questions`} began with a line that is only their type (MC), with the question under it and the options under that, one to a line and with no numbers or letters. The option with a star in front was taken as the answer.`,
      ),
    );
  }

  if (done.runOn > 0) {
    fileFindings.push(
      finding(
        FindingCode.OptionsSplitFromLine,
        "info",
        `${done.runOn === 1 ? "A line that held" : `${done.runOn} lines that held`} several options, or the first option at the end of the question's text, ${done.runOn === 1 ? "was" : "were"} split at their letters, taken in order from A. Check that each option was cut in the right place.`,
      ),
    );
  }
  if (done.answersAtEnd > 0) {
    fileFindings.push(
      finding(
        FindingCode.AnswerEndsLine,
        "info",
        `${done.answersAtEnd === 1 ? "One answer was" : `${done.answersAtEnd} answers were`} read from an Answer label at the end of a line that also has the question's words on it, such as "ANS: C" after the last option.`,
      ),
    );
  }
  if (done.labelsContinued > 0) {
    fileFindings.push(
      finding(
        FindingCode.MetadataLineContinued,
        "info",
        `${done.labelsContinued === 1 ? "One line" : `${done.labelsContinued} lines`} directly under a KEY line, which is a list of fields separated by bars, ${done.labelsContinued === 1 ? "was" : "were"} read as the rest of it, where Word had broken the line across paragraphs.`,
      ),
    );
  }

  // Before the fold, which asks whether a copy gives an answer of its own.
  readStarsAfterLetters(questions, fileFindings);
  if (readBoldAnswers) readBoldBlanks(blocks, questions, fileFindings);

  // A file with an Answers list is keyed in a way this does not touch.
  if (keyBlocks.length === 0) foldCopiesWithoutAnswers(questions, file, fileFindings);

  const below = questions.filter((q) => q.answeredBelow);
  if (below.length > 0) {
    const count = (types: string[]): number => below.filter((q) => types.includes(q.typeHint ?? "")).length;
    const parts = [
      [count(["TF"]), "true or false"],
      [count(["F"]), "fill in the blank"],
      [count(["E"]), "essay or short answer"],
      [below.filter((q) => q.options.length >= 2 && !["TF", "F", "E"].includes(q.typeHint ?? "")).length, "multiple choice"],
    ]
      .filter(([n]) => (n as number) > 0)
      .map(([n, what]) => `${n} ${what}`);
    fileFindings.push(
      finding(
        FindingCode.AnswerFromUnlabelledLine,
        "info",
        `${below.length === 1 ? "One answer was" : `${below.length} answers were`} read from a line under its question that has no Answer label (${parts.join(", ")}). A true or false answer is the word True or False alone on a line, a multiple choice answer is the letter of one of its options alone on a line after them, and the others are read only in the copy that follows an answer key heading.`,
      ),
    );
  }

  const inline = questions.filter((q) => q.answeredInline);
  if (inline.length > 0) {
    fileFindings.push(
      finding(
        FindingCode.AnswerFromUnlabelledLine,
        "info",
        `${inline.length === 1 ? "One true or false answer was" : `${inline.length} true or false answers were`} read from a (T) or (F) at the end of the question. Check that this is how the file gives its answers.`,
      ),
    );
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

const same = (lines: readonly string[]): string => lines.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
/** What a question says, apart from how it is keyed: its stem and its options. */
const contentOf = (q: RawQuestion): string => `${same(q.stemLines)}\u0000${q.options.map((o) => same(o.lines)).join("\u0001")}`;

/**
 * A test bank often holds each question twice: a copy to print for students, with no
 * answers, and a copy for the instructor, after a heading such as "Answer Key", with
 * them. Imported as they stand, that is every question twice and the first copy
 * without a key, so half the bank fails and the other half repeats it.
 *
 * A question before the heading is folded into the question after it that says exactly
 * the same, stem and options, when it gives no answer of its own. The copy with the
 * answers is the one kept, and its answer is its own: nothing is taken from the copy
 * that was folded away, and a question that has no twin is kept as it is. What was
 * folded is reported with where it was, so that nothing goes without a word.
 */
function foldCopiesWithoutAnswers(questions: RawQuestion[], file: string, fileFindings: Finding[]): void {
  const withAnswers = new Map<string, RawQuestion[]>();
  for (const q of questions) {
    if (!q.keyed) continue;
    const content = contentOf(q);
    withAnswers.set(content, [...(withAnswers.get(content) ?? []), q]);
  }
  if (withAnswers.size === 0) return;

  const taken = new Set<RawQuestion>();
  const folded: RawQuestion[] = [];
  let kept = 0;
  for (const q of questions) {
    if (q.keyed) continue;
    const gives = q.answerLines.length > 0 || q.options.some((o) => o.starred);
    const twin = gives ? undefined : withAnswers.get(contentOf(q))?.find((k) => !taken.has(k));
    if (twin) {
      taken.add(twin);
      folded.push(q);
    } else kept++;
  }
  if (folded.length === 0) return;

  for (const q of folded) questions.splice(questions.indexOf(q), 1);
  const first = Math.min(...folded.map((q) => q.firstBlock));
  const last = Math.max(...folded.map((q) => q.lastBlock));
  fileFindings.push(
    finding(
      FindingCode.RepeatedQuestionsFolded,
      "info",
      `${folded.length} ${folded.length === 1 ? "question appears" : "questions appear"} twice: once without answers, in lines ${first + 1} to ${last + 1}, and again after the answer key heading, with them. ` +
        `Each was imported once, from the copy with the answers, and the copy without them was not imported. ` +
        (kept > 0 ? `${kept} ${kept === 1 ? "question before the heading says" : "questions before the heading say"} something different from every question after ${kept === 1 ? "it" : "them"}, and ${kept === 1 ? "was" : "were"} kept as written.` : "Nothing before the heading was left over."),
      { source: { file, firstBlock: first, lastBlock: last } },
    ),
  );
}

/**
 * An asterisk typed after an option's letter ("c. *Mars"), which is how many
 * instructors mark the right option in a bank they type by hand. The Standard Format
 * has it before the letter ("*c. Mars"), and that is read wherever it is. After the
 * letter an asterisk can also be the first character of the option's own words
 * ("*args"), so it is taken as the key only as a habit of the whole file, on the same
 * terms as a mark made with formatting: it sets some options of a question apart
 * from the others in at least three choice questions and 80 percent of them. Then it
 * is moved where the format has it. A file that has one now and then keeps its
 * asterisks as text, and the questions are flagged for having no key, as they always
 * were: a lone "*Mars" is not enough to know what it means.
 *
 * A question that has an asterisk in front of every option says nothing, as a bold
 * letter on every option says nothing, and one that already has the format's own
 * asterisk is left as it is. Two asterisks in a row are not a mark ("**kwargs").
 */
const STAR_AFTER_LETTER = /^\*\s*(?=[^*\s])/;

function readStarsAfterLetters(questions: RawQuestion[], fileFindings: Finding[]): void {
  const eligible = questions.filter((q) => q.options.length >= 2 && (q.typeHint === undefined || CHOICE_HINTS.has(q.typeHint)));
  const starred = (o: RawOption): boolean => STAR_AFTER_LETTER.test(o.lines[0] ?? "");
  const showing = eligible.filter((q) => {
    if (q.options.some((o) => o.starred)) return false;
    const n = q.options.filter(starred).length;
    return n > 0 && n < q.options.length;
  });
  if (showing.length === 0) return;

  const of = `${showing.length} of ${eligible.length} choice questions`;
  if (showing.length < AT_LEAST || showing.length < SHARE * eligible.length) {
    fileFindings.push(
      finding(
        FindingCode.StarAfterLetterKeyUnclear,
        "warn",
        `An asterisk after the option letter sets one option apart from the others in ${of}, which is not often enough to read as marking the correct answer (it takes at least ${AT_LEAST} questions and ${Math.round(SHARE * 100)} percent of them), so no answer was taken from it and the asterisks were left in the text of the options. Nothing was guessed.`,
      ),
    );
    return;
  }

  for (const q of showing) {
    for (const option of q.options) {
      const match = STAR_AFTER_LETTER.exec(option.lines[0] ?? "");
      if (!match) continue;
      option.lines[0] = (option.lines[0] ?? "").slice(match[0].length);
      // The formatting reader looks at the option's own words from here, so it must not count the asterisk.
      option.textOffset += match[0].length;
      option.starred = true;
    }
  }
  fileFindings.push(
    finding(
      FindingCode.StarAfterLetterKeyUsed,
      "warn",
      `An asterisk after the option letter sets the correct answer apart in ${of}, so it was read as the answer key and taken out of the text of the options. Check that the asterisk does mean the correct answer in this file.`,
    ),
  );
}

/** What a blank is written as when the answer's words are taken out of a finished sentence. */
const BLANK_MARK = "_____";

/**
 * A fill in the blank given as the finished sentence, with the answer in bold: "Danny is
 * the **source** of the message." There is no blank and no Answer line, so such a question
 * had its answer in its stem and no key. The bold words are the answer, and in the question
 * they become a blank.
 *
 * Like any mark made with formatting, this is only a habit of the whole file: the bold
 * sets part of the sentence apart in at least three of these questions and 80 percent of
 * them. A sentence that is bold all through has no part set apart. Only a single line is
 * read, from a question under a fill in the blank heading or Type line, and a question
 * that already has a blank or an answer is left as it is.
 */
function readBoldBlanks(blocks: readonly SourceBlock[], questions: RawQuestion[], fileFindings: Finding[]): void {
  const candidates = questions.filter(
    (q) =>
      q.typeHint === "F" &&
      q.options.length === 0 &&
      q.answerLines.length === 0 &&
      q.keyValues.length === 0 &&
      q.stemLines.length === 1 &&
      !/_{3,}/.test(q.stemLines[0] ?? ""),
  );
  if (candidates.length === 0) return;

  const readings = new Map<RawQuestion, { stem: string; answers: string[]; page?: string }>();
  for (const q of candidates) {
    const block = blocks[q.firstBlock];
    if (!block?.runs || block.runs.length === 0) continue;
    const label = /^\s*\d{1,4}\s*[.)]\s+/.exec(block.text)?.[0].length ?? 0;
    let at = 0;
    let rebuilt = "";
    const answers: string[] = [];
    for (const run of block.runs) {
      const from = at;
      at += run.text.length;
      const words = run.text.trim();
      if (run.bold && words !== "" && from >= label) {
        answers.push(words);
        rebuilt += run.text.replace(words, BLANK_MARK);
      } else rebuilt += run.text;
    }
    if (answers.length === 0) continue;
    const taken = takePage(rebuilt.replace(/^\s*\d{1,4}\s*[.)]\s+/, "").trim());
    // A sentence with nothing left outside the bold has no part set apart.
    if (taken.text.replace(new RegExp(BLANK_MARK, "g"), "").replace(/[\s\W_]/g, "").length < 3) continue;
    readings.set(q, { stem: taken.text, answers, ...(taken.page ? { page: taken.page } : {}) });
  }
  if (readings.size === 0) return;

  const of = `${readings.size} of ${candidates.length} fill in the blank questions`;
  if (readings.size < AT_LEAST || readings.size < SHARE * candidates.length) {
    fileFindings.push(
      finding(
        FindingCode.FormattingKeyUnclear,
        "warn",
        `Bold sets some words of the sentence apart in ${of}, which is not often enough to read as the answers (it takes at least ${AT_LEAST} questions and ${Math.round(SHARE * 100)} percent of them), so no answer was taken from it. Nothing was guessed.`,
      ),
    );
    return;
  }
  for (const [q, reading] of readings) {
    q.stemLines[0] = reading.stem;
    // More than one bold part is one answer to each blank, in order, as "one; two" is.
    q.answerLines.push(reading.answers.join("; "));
    if (reading.page && !q.metadata.some((m) => m.label === "Page")) q.metadata.push({ label: "Page", value: reading.page, block: q.firstBlock });
  }
  fileFindings.push(
    finding(
      FindingCode.FormattingKeyUsed,
      "warn",
      `Bold set words of the sentence apart in ${of}, which were given as finished sentences. The bold words were read as the answers and each was replaced by a blank in the question. Check that bold does mean the answer in this file.`,
    ),
  );
}

/**
 * Repeated numbers are normal when numbering restarts after an Answers list, so
 * only a repeat inside one stretch is reported. It matters most to the key, but
 * it is also the first sign that two chapters were pasted together.
 */
function reportRepeatedNumbers(questions: RawQuestion[], fileFindings: Finding[]): void {
  const repeated = new Set<number | string>();
  const seen = new Set<string>();
  for (const q of questions) {
    // "1.14" and "2.14" are different questions, though both are number 14.
    const id = `${q.segment}:${q.label ?? q.number}`;
    if (seen.has(id)) repeated.add(q.label ?? q.number);
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
