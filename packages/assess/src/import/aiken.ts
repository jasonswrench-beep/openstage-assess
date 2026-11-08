/**
 * The Aiken importer: the smallest question format there is, and the one Moodle offers for quick multiple choice.
 *
 *     What is the capital of France?
 *     A. Berlin
 *     B. Paris
 *     C. Rome
 *     ANSWER: B
 *
 * A question is a block of lines with no blank line in it: its text, its lettered options, and one ANSWER line naming the
 * right letter. Nothing else is in the format, so nothing else is read: no title, no type, no points.
 *
 * The key is read only as the file gives it. A block with no ANSWER line is kept with no right answer and fails. An ANSWER
 * that names a letter no option has fails the same way, and so do two ANSWER lines that could disagree. Text that follows
 * the ANSWER line is reported with its words, not dropped. A block with no options is not a question and is listed as text
 * no question used.
 */

import { addFindings, createQuestion, DEFAULT_POINTS, withRecomputedFindings } from "../model/create.ts";
import { finding, FindingCode, type Finding } from "../model/findings.ts";
import { localId } from "../model/ids.ts";
import { plainToRich } from "../model/richtext.ts";
import type { Question } from "../model/question.ts";
import { countVerdicts, type Importer, type ImportOptions, type ImportResult, type Orphan, type SourceBlock } from "./types.ts";

export const AIKEN_PROFILE_ID = "aiken";

// The text a pattern captures and then trims is written as `\S(?:.*\S)?` (from the first character that shows to the last) and not as
// `\S.*?` followed by `\s*$`: the lazy form tried the end of the capture at every character, and each try read the white space after it, so a
// line with 80,000 spaces in the middle took four seconds (and one of a megabyte, twelve minutes). The captures are the same.
export const OPTION = /^\s*([A-Za-z])\s*[.)]\s+(\S(?:.*\S)?)\s*$/;
// The capture of ANSWER may be absent, and then the white space in front of it and the white space after it were two runs side by side:
// with a character that `.` stops at and `\s` reads (U+2028) the line failed at its end and the run was shared out in as many ways as it
// was long. The white space goes inside the optional part, with the capture, so a line with nothing after the colon is one run. Group 1 is
// then undefined and not "", which is why the use of it says `?? ""`.
export const ANSWER = /^\s*ANSWER\s*:(?:\s*(\S(?:.*\S)?))?\s*$/i;
/** A number in front of the question: that is the Standard Format, which has its own reader. */
const NUMBERED = /^\s*(?:Q(?:uestion)?\s*)?\d{1,4}\s*[.):]\s/i;

interface Line {
  index: number;
  text: string;
}

function blocksOf(lines: readonly string[]): Line[][] {
  const out: Line[][] = [];
  let current: Line[] = [];
  lines.forEach((raw, index) => {
    const text = raw.replace(/^﻿/, "");
    if (text.trim() === "") {
      if (current.length > 0) out.push(current);
      current = [];
    } else current.push({ index, text });
  });
  if (current.length > 0) out.push(current);
  return out;
}

/** Whether a text is Aiken: most of its blocks are an unnumbered question, lettered options and an ANSWER line. */
export function looksLikeAiken(text: string): boolean {
  const blocks = blocksOf(text.replace(/\r\n?/g, "\n").split("\n"));
  if (blocks.length < 2) return false;
  const aiken = blocks.filter((b) => {
    const first = b[0] as Line;
    return !NUMBERED.test(first.text) && !OPTION.test(first.text) && b.filter((l) => OPTION.test(l.text)).length >= 2 && b.some((l) => ANSWER.test(l.text));
  });
  return aiken.length >= 2 && aiken.length >= 0.8 * blocks.length;
}

interface Ctx {
  file: string;
  at: string;
  author: string;
}

function build(block: Line[], ctx: Ctx): { question?: Question; orphan?: Orphan } {
  const source = { file: ctx.file, firstBlock: (block[0] as Line).index, lastBlock: (block[block.length - 1] as Line).index };
  const answerLines = block.filter((l) => ANSWER.test(l.text));
  const firstOption = block.findIndex((l) => OPTION.test(l.text));
  const optionCount = block.filter((l) => OPTION.test(l.text)).length;

  if (firstOption <= 0 || optionCount < 2) {
    return {
      orphan: {
        source,
        text: block.map((l) => l.text.trim()).join("\n"),
        reason: "This is not an Aiken question: it needs some text, then at least two lettered options (A. and B.), then an ANSWER line.",
      },
    };
  }

  const findings: Finding[] = [];
  const stem: string[] = [];
  const options: Array<{ letter: string; text: string }> = [];
  const after: string[] = [];
  let seenAnswer = false;
  for (const line of block) {
    if (ANSWER.test(line.text)) {
      seenAnswer = true;
      continue;
    }
    if (seenAnswer) {
      after.push(line.text.trim());
      continue;
    }
    const option = OPTION.exec(line.text);
    // A lettered line is an option once the question's text has begun; before that it is the text.
    if (option && stem.length > 0) {
      options.push({ letter: (option[1] as string).toUpperCase(), text: option[2] as string });
    } else if (options.length > 0) {
      // A line that is not an option after the options began is more of the last one.
      (options[options.length - 1] as { text: string }).text += ` ${line.text.trim()}`;
      findings.push(finding(FindingCode.UnreadContent, "info", `A line after option ${(options[options.length - 1] as { letter: string }).letter} that is not an option was read as more of that option: "${line.text.trim()}".`));
    } else {
      stem.push(line.text.trim());
    }
  }
  if (after.length > 0) {
    findings.push(finding(FindingCode.UnreadContent, "warn", `Text after the ANSWER line was not read: "${after.join(" ")}".`));
  }

  const letters = options.map((o) => o.letter);
  const seen = new Set<string>();
  for (const letter of letters) {
    if (seen.has(letter)) {
      findings.push(finding(FindingCode.DuplicateOptionLetter, "warn", `The letter ${letter} labels more than one option.`));
      break;
    }
    seen.add(letter);
  }
  const expected = letters.map((_, i) => String.fromCharCode(65 + i));
  if (letters.join("") !== expected.join("") && new Set(letters).size === letters.length) {
    findings.push(finding(FindingCode.OptionLetterGap, "warn", `The options are lettered ${letters.join(", ")}, which skips a letter. They are read in the order they stand.`));
  }

  // The key. Read as the file gives it, and never made up.
  let correct = new Set<string>();
  let multiple = false;
  if (answerLines.length > 1) {
    findings.push(finding(FindingCode.KeysDisagree, "error", `The block has ${answerLines.length} ANSWER lines, and there is no telling which is meant. No answer is marked.`));
  } else if (answerLines.length === 1) {
    const given = ((ANSWER.exec((answerLines[0] as Line).text) as RegExpExecArray)[1] ?? "").toUpperCase();
    const named = given.split(/\s*(?:,|&|\/|\band\b|\s)\s*/).filter((s) => s !== "");
    const known = new Set(letters);
    if (named.length === 0 || named.some((n) => !/^[A-Z]$/.test(n))) {
      findings.push(finding(FindingCode.KeyLetterMissing, "error", `The ANSWER line says "${given}", which is not a letter or a list of letters. No answer is marked.`));
    } else if (named.some((n) => !known.has(n))) {
      findings.push(finding(FindingCode.KeyLetterMissing, "error", `The ANSWER line names ${named.join(", ")}, and the options are lettered ${letters.join(", ")}. No answer is marked.`));
    } else {
      correct = new Set(named);
      multiple = correct.size > 1;
      if (multiple) findings.push(finding(FindingCode.MoreThanOneRight, "warn", `The ANSWER line names ${[...correct].join(", ")}. Aiken holds one answer, so this is read as a multiple response. Check that it is.`));
    }
  }

  const body = {
    shuffle: true,
    ...(multiple ? { partialCredit: true } : {}),
    options: options.map((o, i) => ({ id: localId("o", i), content: plainToRich(o.text), correct: correct.has(o.letter) })),
  };
  const made = createQuestion({
    type: multiple ? "multipleResponse" : "multipleChoice",
    stem: plainToRich(stem.join("\n")),
    body,
    points: DEFAULT_POINTS,
    by: ctx.author,
    at: ctx.at,
    origin: { kind: "import", source, profile: AIKEN_PROFILE_ID, at: ctx.at },
  });
  return { question: withRecomputedFindings(addFindings(made, findings)) };
}

export const aikenImporter: Importer = {
  id: AIKEN_PROFILE_ID,
  label: "Aiken",
  extensions: [".aiken"],

  parse(input: string | SourceBlock[], options: ImportOptions = {}): ImportResult {
    const text = typeof input === "string" ? input : input.map((b) => b.text).join("\n");
    const ctx: Ctx = { file: options.file ?? "input.aiken", at: options.at ?? new Date().toISOString(), author: options.author ?? "import" };
    const questions: Question[] = [];
    const orphans: Orphan[] = [];
    for (const block of blocksOf(text.replace(/\r\n?/g, "\n").split("\n"))) {
      const built = build(block, ctx);
      if (built.question) questions.push(built.question);
      if (built.orphan) orphans.push(built.orphan);
    }
    const fileFindings: Finding[] = [];
    if (questions.length === 0 && orphans.length === 0) {
      fileFindings.push(finding(FindingCode.UnreadContent, "warn", "No question was found in this file. An Aiken question has its text, lettered options and an ANSWER line."));
    }
    return { profile: options.profile ?? AIKEN_PROFILE_ID, file: ctx.file, questions, orphans, counts: countVerdicts(questions, orphans.length), fileFindings };
  },
};
