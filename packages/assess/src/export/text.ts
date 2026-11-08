/**
 * What every exporter needs to turn a question's text into the text of another format, and to say what it cost.
 *
 * Each exporter has its own words for what was lost, because what is lost depends on where the question is going. What is
 * shared is the work: turning rich text into plain text without dropping a picture or an equation silently, counting what
 * could not be carried, and the one rule about keys: a question whose key is missing or broken is never exported.
 */

import { checkAnswerKey } from "../quality/answer-key.ts";
import { liveFindings } from "../model/findings.ts";
import { replacePlaceholders } from "../model/markup-scan.ts";
import { collectRefs, escapeHtml, richTextToPlain, stripInvalidCharacters, type RichText } from "../model/richtext.ts";
import type { Question, QuestionType } from "../model/question.ts";
import type { DestinationReport, ReportItem } from "./types.ts";

/**
 * The questions as they are written to a file: every string in them without the characters a file format may refuse (control
 * characters, half a surrogate pair, U+FFFE and U+FFFF). The XML formats forbid them outright, so one such character in one question
 * made Moodle, a QTI package or a Common Cartridge not well formed and an LMS refused the whole file; the text and spreadsheet
 * formats gain nothing from them either. Done once, at the door of every exporter and every destination check, so that no path to a
 * file can forget it, and so that what a check says is what the export writes. The questions are not changed: a question is copied
 * only when a string in it is cleaned, and the same list is returned when none is.
 */
export function exportable<T extends Question>(questions: readonly T[]): readonly T[] {
  const clean = (value: unknown): [unknown, boolean] => {
    if (typeof value === "string") {
      const next = stripInvalidCharacters(value);
      return [next, next !== value];
    }
    if (Array.isArray(value)) {
      let changed = false;
      const out = value.map((v) => {
        const [c, did] = clean(v);
        changed ||= did;
        return c;
      });
      return [changed ? out : value, changed];
    }
    if (value !== null && typeof value === "object") {
      let changed = false;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const [c, did] = clean(v);
        changed ||= did;
        out[k] = c;
      }
      return [changed ? out : value, changed];
    }
    return [value, false];
  };
  let any = false;
  const out = questions.map((q) => {
    const [c, did] = clean(q);
    any ||= did;
    return c as T;
  });
  return any ? out : questions;
}

export const TYPE_NAMES: Record<QuestionType, string> = {
  multipleChoice: "multiple choice",
  multipleResponse: "multiple response",
  trueFalse: "true or false",
  fillInBlank: "fill in the blank",
  matching: "matching",
  ordering: "ordering",
  numeric: "numeric",
  shortAnswer: "short answer",
  essay: "essay",
  hotspot: "hotspot",
  calculated: "calculated",
};

/** What turning rich text into a plain cell cost, counted so that it can be reported. */
export interface Losses {
  pictures: number;
  equations: number;
  formatting: boolean;
  breaks: boolean;
}

export const newLosses = (): Losses => ({ pictures: 0, equations: 0, formatting: false, breaks: false });

export const FORMATTING = /<(strong|em|u|s|sub|sup|code|pre|ul|ol|li|blockquote|table|thead|tbody|tr|th|td)[\s>/]/i;

/**
 * A picture or an equation written into the text as a marker, with what stands for it, and counted. Simply deleting one
 * would leave a question such as "What does [the chart] show?" reading "What does show?".
 */
function objectsAsText(html: string, question: Question, losses: Losses): string {
  // The placeholders are found by `replacePlaceholders`, which reads an unclosed `<oa-media` once; the pattern it replaces read to the end
  // of the text from every one of them (a stem of 40,000 took each exporter twenty seconds).
  const withPictures = replacePlaceholders(html, "media", (ref) => {
    losses.pictures++;
    const media = question.media.find((m) => m.id === ref);
    if (media?.decorative) return " ";
    const alt = media ? media.alt.trim() : "";
    return alt.length > 0 ? ` [Picture: ${escapeHtml(alt)}] ` : " [Picture] ";
  });
  return replacePlaceholders(withPictures, "math", (ref) => {
    losses.equations++;
    const math = question.math.find((m) => m.id === ref);
    const latex = math ? math.latex.trim() : "";
    return latex.length > 0 ? ` [Equation: ${escapeHtml(latex)}] ` : " [Equation] ";
  });
}

/**
 * Rich text as plain text. A picture or an equation is written into the text instead of being dropped, so the question
 * still makes sense and the author can see where to put the picture back. Every one is counted.
 */
export function plainText(text: RichText, question: Question, losses: Losses, keepBreaks: boolean): string {
  let plain: string;
  if (text.format === "plain") {
    // Not markup, so no tag handling: a stem reading "x < y" must not lose text.
    plain = text.content.trim();
  } else {
    if (FORMATTING.test(text.content)) losses.formatting = true;
    // The space after a cell keeps the cells of a table from running together into one word.
    plain = richTextToPlain(objectsAsText(text.content, question, losses).replace(/<\/(td|th)\s*>/gi, " "));
  }

  if (!keepBreaks && plain.includes("\n")) {
    losses.breaks = true;
    plain = plain.replace(/(?<!\s)\s*\n\s*/g, " ");
  }
  return plain.trim();
}

/**
 * Rich text as HTML for a format that carries it. A picture or an equation is written into the text as a marker, as in
 * `plainText`, and counted.
 */
export function htmlText(text: RichText, question: Question, losses: Losses): string {
  if (text.format === "plain") {
    const body = text.content
      .trim()
      .split(/\n{2,}/)
      .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
      .join("");
    return body;
  }
  return objectsAsText(text.content, question, losses).trim();
}

/** The report for a set of planned questions: the counts are worked out from the items, so they cannot disagree with them. */
export function buildReport(
  destination: string,
  label: string,
  total: number,
  items: ReportItem[],
  files: string[],
  general: string[],
): DestinationReport {
  const count = (outcome: ReportItem["outcome"]): number => items.filter((item) => item.outcome === outcome).length;
  return {
    destination,
    label,
    total,
    exported: count("exported"),
    exportedWithLosses: count("exportedWithLosses"),
    leftOut: count("leftOut"),
    files,
    general,
    items,
  };
}

/** The notes about what a plain-text conversion lost, in the words every exporter that is plain text uses. */
export function lossNotes(losses: Losses, where: string): string[] {
  const notes: string[] = [];
  if (losses.pictures > 0) {
    notes.push(`${plural(losses.pictures, "picture", "pictures")} cannot be carried. Each appears in the text as [Picture: its alternative text]; add the picture again in ${where}.`);
  }
  if (losses.equations > 0) {
    notes.push(`${plural(losses.equations, "equation", "equations")} became text, written as [Equation: LaTeX]. Check how it reads in ${where}.`);
  }
  return notes;
}

/**
 * Whether there is something to write. An equation counts: it is written out (as LaTeX, or as the words [Equation: LaTeX]), so an
 * answer that is only an equation is an answer and not an empty one.
 */
export function hasText(text: RichText): boolean {
  if (text.format === "plain") return text.content.trim().length > 0;
  return richTextToPlain(text).length > 0 || collectRefs(text).math.length > 0;
}

/**
 * The question as a QTI file can score it. QTI states the right answer by its score, so a question worth no points has no right answer to
 * state: it was written with a score of 0, and its key was lost on the way back (QTI 1.2 read it as a question with no answer, and QTI 2.1
 * read a short answer's accepted answers as empty). It is written worth 1 and says so. Points are written to five decimal places, and a
 * question whose points need more is said to have been rounded.
 */
export function scorable(question: Question, notes: string[]): Question {
  if (!(question.points > 0)) {
    notes.push("A question worth no points is written worth 1 point, because QTI states the right answer by its score and a score of 0 states nothing. Set its points in the learning system.");
    return { ...question, points: 1 } as Question;
  }
  if (Math.round(question.points * 100000) / 100000 !== question.points) notes.push("The points are written to five decimal places.");
  return question;
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Why a question has no usable key, in the words the bank already uses for it. */
export function keyProblem(question: Question, destination = "the destination"): string {
  const messages = new Set<string>();
  for (const found of [...checkAnswerKey(question), ...liveFindings(question.findings)]) {
    if (found.severity === "error") messages.add(found.message);
  }
  const list = [...messages].slice(0, 3);
  return list.length > 0
    ? `It cannot be exported until this is fixed in the bank: ${list.join(" ")}`
    : `It has no usable answer key, and ${destination} needs one.`;
}

/** A name that is safe as a file name on Windows. */
export function safeName(name: string | undefined, fallback = "questions"): string {
  const cleaned = stripInvalidCharacters(name ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "");
  return cleaned.length > 0 ? cleaned.slice(0, 80) : fallback;
}
