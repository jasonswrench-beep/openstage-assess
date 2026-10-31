/**
 * A bank that letters nothing, and numbers nothing or numbers only the stems: a stem, its options under it one to a line,
 * a blank line, the next stem. The right option is marked by how it looks, or by a word or a star after it. The scanner
 * finds a question by its number and an option by its letter, so it found no question in a file that numbers nothing, and,
 * where the stems were numbered, a stem with its options run into it.
 *
 * This step gives such a file the labels the page does not show, as Word's own list would: the stem of each group of lines
 * is numbered, unless it is already, and the lines under it are lettered, and the scanner then reads it as it reads any
 * other. Nothing is read by a new set of rules, so a key by formatting, by "(Correct)" or by a star, and every type, are
 * read as they are everywhere. What this step decides is only where a question begins and where its options are, and it
 * decides from how the whole file does it: three groups at least, and nearly every run of lines in the file one of them. A
 * file with a stray group of unlabelled lines in it is not made into questions.
 *
 * The caller reads the result and keeps it only if it found more keys than the plain scan did, so a file that was read well
 * already is never changed by this.
 */

import {
  ANSWER_LINE,
  ANSWERS_HEADER,
  CORRECT_FEEDBACK,
  INCORRECT_FEEDBACK,
  KNOWN_EMPTY_LABEL,
  PAGE_LINE,
  POINTS_LINE,
  QUESTION_START,
  TITLE_LINE,
  TYPE_LINE,
} from "./standard-text-scan.ts";
import { AT_LEAST, SHARE } from "./standard-text-format.ts";
import type { SourceBlock } from "./types.ts";

/** The most options a letter can label, and so the most lines read under a stem. */
const MAX_OPTIONS = 20;
/** At least three words, or a question mark, a colon at the end, or a blank. */
const STEM_SHAPE = /^(?:\S+\s+\S+\s+\S+|.*\?|.*:\s*$|.*_{3,})/;
/** The number a stem may begin with: "Question 4:", "4.", "Q4)". */
const QUESTION_START_PREFIX = /^\s*(?:(?:Q|Question)\s*)?\d{1,4}\s*[.):]\s*/i;
/** A line this long, and this many times the typical option, may be a paragraph of the stem. */
const LONG_LINE = 70;
const LONG_RATIO = 2.2;
/** The most lines a title and instructions may take at the head of the first run before it is no longer a preamble. */
const MAX_PREAMBLE = 3;
/** A statement that ends with its own answer, "(T)" or "(False)": a true or false question on one line. */
const STATEMENT_ANSWERED = /\(\s*(?:true|false|t|f)\s*\)\s*$/i;
/** A line that already carries an option's label: "A.", "b)", "(C)", "D:" with a star or none in front. */
const LABELLED = /^\s*\*?\s*\(?[a-tA-T]\s*[.):]\s/;
/** The lines of instructions that come before the first question and share its run of lines. */
const INSTRUCTION = /^\s*(?:instructions?|directions?|note|read|choose|answer|select|circle|name|date)\b/i;
/** A line that is not an option because it says something else about the question above it. */
const NOT_AN_OPTION = [ANSWER_LINE, ANSWERS_HEADER, TITLE_LINE, TYPE_LINE, POINTS_LINE, CORRECT_FEEDBACK, INCORRECT_FEEDBACK, PAGE_LINE, KNOWN_EMPTY_LABEL];

interface Group {
  /** The stem and each line read as an option, as the `index` of the block. */
  stem: number;
  options: number[];
  /** The stem already carries a question number. */
  numbered: boolean;
  /** The run of lines it was read from. */
  run: readonly number[];
  /** One line under the stem is so much longer than the others that it may be more of the stem, not an option. */
  suspect: boolean;
}

export interface Relabelled {
  blocks: SourceBlock[];
  groups: number;
  /** The stems had no number and were given one; when false they already had. */
  stemsLabelled: boolean;
  /** The stems of the questions in which a line read as an option may be more of the stem, as the `index` of the block. */
  suspect: number[];
  /** Lines at the head of the first run that were left as they were, because they are a title and instructions. */
  preamble: number;
}

const isBlank = (b: SourceBlock): boolean => b.text.trim().length === 0 || b.table !== undefined;

/** A line that could be a title: short, and not a question or a sentence. */
const shortTitle = (text: string): boolean => {
  const t = text.trim();
  return t.length > 0 && t.length <= 90 && !/[?.:]$/.test(t);
};

/**
 * The file with a label put on the stem and on the options of each group of lines, or nothing when the file does not do it
 * as a habit. The blocks it returns are copies where they were labelled and the ones the caller gave where they were not.
 */
export function relabelUnlabelledGroups(blocks: readonly SourceBlock[]): Relabelled | undefined {
  const at = new Map(blocks.map((b, i) => [b.index, i]));
  const block = (index: number): SourceBlock => blocks[at.get(index) as number] as SourceBlock;

  // The runs of lines with no blank line between them. A table is a break, as a blank line is.
  const runs: number[][] = [];
  let current: number[] = [];
  for (const b of blocks) {
    if (isBlank(b)) {
      if (current.length > 0) runs.push(current);
      current = [];
    } else {
      // A bullet list under a stem is the stem's options, and the line after the last bullet begins the next question, though
      // no blank line says so.
      const before = current.length > 0 ? block(current[current.length - 1] as number) : undefined;
      if ((before?.bullet || before?.bulletMore) && !b.bullet && !b.bulletMore) {
        runs.push(current);
        current = [];
      }
      current.push(b.index);
    }
  }
  if (current.length > 0) runs.push(current);

  // A run of two lines or more, or one line that is a statement with its answer at the end.
  const multi = runs.filter((r) => r.length >= 2 || STATEMENT_ANSWERED.test(block(r[0] as number).text));
  if (multi.length === 0) return undefined;

  // The groups of every run but the first, to know how long a question is in this file.
  const read: Group[] = [];
  for (const run of multi.slice(1)) {
    const g = groupOf(run, block);
    if (g) read.push(g);
  }
  const longest = Math.max(0, ...read.map((g) => 1 + g.options.length));

  // The first run may hold a title and instructions before its first question: only when it is longer than any other, by
  // lines that look like those. Otherwise it is a first question with a long stem, and is read and flagged for a check.
  const firstRun = multi[0] as number[];
  let preamble = 0;
  let firstGroup: Group | undefined;
  if (longest > 0 && firstRun.length > longest) {
    const extra = firstRun.length - longest;
    const lines = firstRun.slice(0, extra).map((index) => block(index).text);
    const looksLikeOne = extra <= MAX_PREAMBLE && lines.every((t, k) => (k === 0 ? shortTitle(t) || INSTRUCTION.test(t) : INSTRUCTION.test(t)));
    if (looksLikeOne) {
      preamble = extra;
      firstGroup = groupOf(firstRun.slice(extra), block);
    } else {
      // Longer than the rest, and not by a title: most likely a first question with a long stem. It is read, and checked.
      firstGroup = groupOf(firstRun, block);
      if (firstGroup) firstGroup.suspect = true;
    }
  } else {
    firstGroup = groupOf(firstRun, block);
  }
  if (firstGroup) read.push(firstGroup);
  if (read.length < AT_LEAST || read.length < SHARE * multi.length) return undefined;

  // A line on its own before most of the groups is a stem set apart from its options by a blank line, and the group after it
  // would be read with its first option as the stem. The first run is left out of the count: a title stands alone.
  const apart = read.filter((g) => {
    const before = runs.findIndex((r) => r === g.run) - 1;
    return before > 0 && (runs[before] as number[]).length === 1 && !read.some((other) => other.run === runs[before]);
  }).length;
  if (apart > 0.3 * read.filter((g) => g.options.length >= 2).length) return undefined;

  // A file whose stems are numbered in some places and not in others is not one that does it as a habit.
  const numbered = read.filter((g) => g.numbered).length;
  const labelStems = numbered === 0;
  if (!labelStems && numbered < SHARE * read.length) return undefined;

  // In the order of the file.
  read.sort((a, b) => a.stem - b.stem);
  const out = new Map<number, SourceBlock>();
  const label = (index: number, text: string): void => {
    out.set(index, { ...block(index), kind: "listItem", listLabel: text });
  };
  read.forEach((group, n) => {
    if (labelStems) label(group.stem, `${n + 1}.`);
    group.options.forEach((index, k) => label(index, `${String.fromCharCode(97 + k)}.`));
  });
  return { blocks: blocks.map((b) => out.get(b.index) ?? b), groups: read.length, stemsLabelled: labelStems, suspect: read.filter((g) => g.suspect).map((g) => g.stem), preamble };
}

/**
 * The stem and options of a run of lines, or nothing when the run is not a question with unlabelled options: a stem, then
 * at least two lines that no label has been put on, and after them only lines that say something about the answer.
 */
function groupOf(run: readonly number[], block: (index: number) => SourceBlock): Group | undefined {
  const labelled = (index: number): boolean => {
    const b = block(index);
    return b.listLabel !== undefined || LABELLED.test(b.text) || QUESTION_START.test(b.text);
  };

  const stem = block(run[0] as number);
  // A stem a list numbered is the question's number; any other label on it, a bullet or a letter, means this is not one.
  const numbered = QUESTION_START.test(stem.text) || (stem.listLabel !== undefined && QUESTION_START.test(`${stem.listLabel} x`));
  if (stem.listLabel !== undefined && !numbered) return undefined;
  if (NOT_AN_OPTION.some((re) => re.test(stem.text)) || LABELLED.test(stem.text)) return undefined;
  // A stem is a sentence or a question: a word or two on a line, such as a type tag, is not one, and the lines under it are
  // then not its options.
  if (!STEM_SHAPE.test(stem.text.replace(QUESTION_START_PREFIX, ""))) return undefined;

  // One line that ends with its answer is a true or false question with nothing under it.
  if (run.length === 1) return STATEMENT_ANSWERED.test(stem.text) ? { stem: run[0] as number, options: [], numbered, run, suspect: false } : undefined;

  const options: number[] = [];
  let k = 1;
  for (; k < run.length; k++) {
    const index = run[k] as number;
    if (NOT_AN_OPTION.some((re) => re.test(block(index).text))) break;
    if (labelled(index)) return undefined;
    // The rest of a bulleted option after a soft line break is part of it, and takes no label of its own.
    if (block(index).bulletMore) continue;
    options.push(index);
  }
  // A stem may run to a second or third paragraph: "A person feels tired. / They want steady energy. Which is best?". The
  // line that ends in a question mark or a colon, one only and among the first two under the stem, closes it, and the options
  // are the lines after it. Where several lines end that way they are options that do, and the lines are left as they are.
  const closing = options.flatMap((index, k) => (/[?:]\s*$/.test(block(index).text) ? [k] : []));
  let lettered = options;
  if (closing.length === 1 && (closing[0] as number) <= 1 && options.length - (closing[0] as number) - 1 >= 2) {
    lettered = options.slice((closing[0] as number) + 1);
  }
  if (lettered.length === 1 || lettered.length > MAX_OPTIONS) return undefined;
  // A stem with no options is a question only when the lines under it say what its answer is: a true or false statement, a
  // blank or a short answer, each with its "Answer:" line.
  if (lettered.length === 0 && !run.slice(1).some((index) => ANSWER_LINE.test(block(index).text))) return undefined;
  // What is left is the question's tail, and none of it may look like another option or another question.
  for (; k < run.length; k++) if (labelled(run[k] as number)) return undefined;
  // An option is a phrase or a sentence like the ones beside it. One that is far longer than the rest is more likely the
  // second paragraph of a long stem, which a blank line did not set apart, and the question is then checked. So is one whose
  // stem ends in a colon, which promises more, when the line under it is a full sentence.
  const lengths = lettered.map((index) => block(index).text.trim().length).sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)] ?? 0;
  const long = lettered.length >= 3 && lengths.some((n) => n >= LONG_LINE && n >= LONG_RATIO * median);
  const promised = /:\s*$/.test(stem.text) && /[.?!]\s*$/.test(block(lettered[0] as number).text);
  return { stem: run[0] as number, options: lettered, numbered, run, suspect: long || promised };
}
