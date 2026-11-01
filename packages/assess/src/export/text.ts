/**
 * What every exporter needs to turn a question's text into the text of another format, and to say what it cost.
 *
 * Each exporter has its own words for what was lost, because what is lost depends on where the question is going. What is
 * shared is the work: turning rich text into plain text without dropping a picture or an equation silently, counting what
 * could not be carried, and the one rule about keys: a question whose key is missing or broken is never exported.
 */

import { checkAnswerKey } from "../quality/answer-key.ts";
import { liveFindings } from "../model/findings.ts";
import { escapeHtml, richTextToPlain, type RichText } from "../model/richtext.ts";
import type { Question, QuestionType } from "../model/question.ts";
import type { DestinationReport, ReportItem } from "./types.ts";

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
  return html
    .replace(/<oa-media\b[^>]*\bref\s*=\s*"([^"]*)"[^>]*>\s*<\/oa-media>/gi, (_whole, ref: string) => {
      losses.pictures++;
      const media = question.media.find((m) => m.id === ref);
      if (media?.decorative) return " ";
      const alt = media ? media.alt.trim() : "";
      return alt.length > 0 ? ` [Picture: ${escapeHtml(alt)}] ` : " [Picture] ";
    })
    .replace(/<oa-math\b[^>]*\bref\s*=\s*"([^"]*)"[^>]*>\s*<\/oa-math>/gi, (_whole, ref: string) => {
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
    plain = plain.replace(/\s*\n\s*/g, " ");
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

export function hasText(text: RichText): boolean {
  return text.format === "plain" ? text.content.trim().length > 0 : richTextToPlain(text).length > 0;
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
  const cleaned = (name ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "");
  return cleaned.length > 0 ? cleaned.slice(0, 80) : fallback;
}
