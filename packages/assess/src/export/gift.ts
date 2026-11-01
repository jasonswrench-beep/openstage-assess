/**
 * Export to GIFT, the plain-text question format that Moodle reads (and several other tools).
 *
 * GIFT holds multiple choice, multiple response (as weights), true or false, short answer, matching, numeric and essay
 * questions. It has nowhere to put an ordering, a hotspot or a calculated question, so those are left out and said so. A
 * question with no usable answer key is never written, because a GIFT question with a wrong or missing key looks
 * finished to the person who imports it.
 *
 * The characters that mean something in GIFT (~ = # { } and :) are escaped wherever they occur in the text, so a stem
 * that contains an equals sign cannot turn into an answer. Line breaks are written as \n, so one question is one block.
 *
 * What GIFT cannot say is reported against each question, not left to be found: partial credit for a short answer,
 * feedback for a right or a wrong answer, spare answers in a matching question, units, the case rule.
 */

import { hasUsableKey } from "../quality/answer-key.ts";
import { isChoice, isFillInBlank, isMultipleResponse, isShortAnswer, isTrueFalse, type Question } from "../model/question.ts";
import type { ExportResult, ReportItem } from "./types.ts";
import { buildReport, FORMATTING, hasText, htmlText, keyProblem, lossNotes, newLosses, plainText, plural, safeName, TYPE_NAMES } from "./text.ts";

export const GIFT_ID = "gift";
export const GIFT_LABEL = "GIFT (Moodle and other tools)";

/** Moodle takes at least three pairs in a matching question and refuses fewer. */
const MIN_PAIRS = 3;

/** Escapes what GIFT gives a meaning to. Line breaks become \n so that a question stays in one block. */
export function giftEscape(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[\\~=#{}:]/g, (c) => `\\${c}`).replace(/\n/g, "\\n");
}

/** The weight of one right answer out of several, in the form Moodle reads. */
const share = (n: number): string => String(Math.round((100 / n) * 100000) / 100000);

interface Planned {
  item: ReportItem;
  block?: string;
}

function plan(question: Question, position: number): Planned {
  const base = { position, questionId: question.id, title: question.title };
  const leftOut = (why: string): Planned => ({ item: { ...base, outcome: "leftOut", notes: [why] } });

  const supported =
    isChoice(question) || isMultipleResponse(question) || isTrueFalse(question) || isFillInBlank(question) || isShortAnswer(question) || question.type === "matching" || question.type === "numeric" || question.type === "essay";
  if (!supported) {
    const name = TYPE_NAMES[question.type];
    return leftOut(`GIFT has no ${name} question, so ${/^[aeiou]/.test(name) ? "an" : "a"} ${name} question cannot be written in it.`);
  }
  if (!hasUsableKey(question)) return leftOut(keyProblem(question, "GIFT"));

  const losses = newLosses();
  const notes: string[] = [];
  let asType: string | undefined;

  const stem = plainText(question.stem, question, losses, true);
  if (stem === "") return leftOut("It has no question text once it is written as plain text.");
  // A stem with formatting keeps it, by being marked as HTML. The answers cannot be marked, so theirs becomes plain text.
  const formatted = question.stem.format === "rich" && FORMATTING.test(question.stem.content);
  const stemText = formatted ? `[html]${giftEscape(htmlText(question.stem, question, newLosses()).replace(/\n/g, ""))}` : giftEscape(stem);
  const title = question.title.replace(/::/g, ":").replace(/\s+/g, " ").trim();

  const lines: string[] = [];
  const answer = (marker: "=" | "~", text: string, feedback?: string, weight?: string): string =>
    `${marker}${weight ? `%${weight}%` : ""}${giftEscape(text)}${feedback ? `#${giftEscape(feedback)}` : ""}`;

  if (isChoice(question) || isMultipleResponse(question)) {
    const options = question.body.options;
    const texts = options.map((o) => plainText(o.content, question, losses, false));
    if (texts.some((t) => t === "")) return leftOut("One of its answers has no text, and GIFT cannot hold an empty answer.");
    const feedbacks = options.map((o) => (o.feedback && hasText(o.feedback) ? plainText(o.feedback, question, losses, false) : ""));
    const right = options.filter((o) => o.correct).length;
    if (isMultipleResponse(question)) {
      if (right === options.length) return leftOut("Every answer is marked right, so there is nothing to choose, and GIFT would score nothing.");
      const wrong = question.body.partialCredit ? share(right) : "100";
      options.forEach((o, i) => lines.push(answer("~", texts[i] as string, feedbacks[i] || undefined, o.correct ? share(right) : `-${wrong}`)));
      notes.push(
        question.body.partialCredit
          ? "A multiple response is written as weights: each right answer is worth an equal share, and each wrong one takes the same share away."
          : "A multiple response is written as weights. This one is all or nothing, so a wrong answer takes away everything: GIFT has no all-or-nothing switch.",
      );
    } else {
      options.forEach((o, i) => lines.push(answer(o.correct ? "=" : "~", texts[i] as string, feedbacks[i] || undefined)));
    }
    if (!question.body.shuffle || options.some((o) => o.fixedPosition)) {
      notes.push("This question keeps its answers in a fixed order, and GIFT cannot say so. Moodle's own setting for mixing answers applies.");
    }
  } else if (isTrueFalse(question)) {
    if (typeof question.body.correct !== "boolean") return leftOut("Neither True nor False is marked, and nothing is guessed.");
    lines.push(question.body.correct ? "TRUE" : "FALSE");
    if ((question.feedback.correct && hasText(question.feedback.correct)) || (question.feedback.incorrect && hasText(question.feedback.incorrect))) {
      notes.push("Feedback for a right or a wrong answer is not carried to a true or false question, because GIFT's form for it is not the same in every tool.");
    }
  } else if (isFillInBlank(question) || isShortAnswer(question)) {
    let accepted: string[];
    let caseSensitive: boolean;
    if (isFillInBlank(question)) {
      if (question.body.blanks.length !== 1) return leftOut(`It has ${question.body.blanks.length} blanks, and a GIFT short answer holds one.`);
      accepted = (question.body.blanks[0] as { accepted: string[] }).accepted;
      caseSensitive = question.body.caseSensitive;
      asType = "short answer";
      notes.push("A fill in the blank is written as a short answer, because GIFT does not know where in the text the blank is.");
    } else {
      accepted = question.body.accepted;
      caseSensitive = question.body.caseSensitive;
    }
    const cleaned = accepted.map((a) => a.replace(/\s+/g, " ").trim()).filter((a) => a !== "");
    if (cleaned.length === 0) return leftOut("It has no accepted answer, and nothing is guessed.");
    for (const a of cleaned) lines.push(answer("=", a));
    if (caseSensitive) notes.push("Upper and lower case count in this question, and GIFT cannot say so.");
  } else if (question.type === "matching") {
    const body = question.body as { pairs: Array<{ left: Parameters<typeof plainText>[0]; right: string }>; distractors?: string[] };
    if (body.pairs.length < MIN_PAIRS) return leftOut(`It has ${body.pairs.length} pairs and Moodle needs at least ${MIN_PAIRS} in a matching question.`);
    const pairs = body.pairs.map((p) => ({ left: plainText(p.left, question, losses, false), right: p.right.replace(/\s+/g, " ").trim() }));
    if (pairs.some((p) => p.left === "" || p.right === "")) return leftOut("One of its pairs has nothing on one side, and nothing is guessed to fill it.");
    for (const p of pairs) lines.push(`=${giftEscape(p.left)} -> ${giftEscape(p.right)}`);
    if ((body.distractors ?? []).length > 0) notes.push(`${plural((body.distractors ?? []).length, "spare answer", "spare answers")} cannot be carried: GIFT matching has none.`);
  } else if (question.type === "numeric") {
    const body = question.body as { mode: string; value?: number; min?: number; max?: number; tolerance?: number; units?: string };
    if (body.mode === "range" && typeof body.min === "number" && typeof body.max === "number") lines.push(`#${body.min}..${body.max}`);
    else if (typeof body.value === "number") lines.push(`#${body.value}${body.mode === "tolerance" && typeof body.tolerance === "number" ? `:${body.tolerance}` : ""}`);
    else return leftOut("It has no value to score against, and nothing is guessed.");
    if (body.units && body.units.trim() !== "") notes.push(`The units (${body.units.trim()}) cannot be carried. Put them in the question text.`);
  } else {
    // An essay: GIFT writes it as empty braces.
    const model = (question.body as { modelAnswer?: Parameters<typeof plainText>[0] }).modelAnswer;
    if (model && hasText(model)) notes.push("The model answer cannot be carried: GIFT writes an essay as an empty answer.");
  }

  // Feedback for a right or a wrong answer has no place in the other types.
  const wantsOutcomeFeedback = !isTrueFalse(question) && ((question.feedback.correct && hasText(question.feedback.correct)) || (question.feedback.incorrect && hasText(question.feedback.incorrect)));
  if (wantsOutcomeFeedback) notes.push("Feedback for a right answer and for a wrong one is not carried: GIFT keeps feedback with each answer, and a general note.");
  if (question.feedback.general && hasText(question.feedback.general)) {
    lines.push(`####${giftEscape(plainText(question.feedback.general, question, losses, true))}`);
  }

  if (formatted) notes.push("The question text keeps its formatting. The answers and the feedback become plain text.");
  else if (losses.formatting) notes.push("Bold, italics, lists or tables in the answers or the feedback became plain text.");
  if (losses.breaks) notes.push("Paragraph breaks in an answer became spaces.");
  notes.push(...lossNotes(losses, "Moodle"));

  const head = `${title === "" ? "" : `::${giftEscape(title)}:: `}${stemText} `;
  const block = lines.length === 0 ? `${head}{}` : `${head}{\n${lines.join("\n")}\n}`;
  return { item: { ...base, outcome: notes.length > 0 ? "exportedWithLosses" : "exported", ...(asType ? { asType } : {}), notes }, block };
}

export interface GiftOptions {
  /** What to call the file, and the category the questions go into in Moodle. Usually the bank's title. */
  name?: string;
}

/** The destination check on its own: what would arrive, what would be lost, what cannot go. */
export function checkGift(questions: readonly Question[], options: GiftOptions = {}): ExportResult["report"] {
  return exportGift(questions, options).report;
}

/** The destination check, and the file to write. */
export function exportGift(questions: readonly Question[], options: GiftOptions = {}): ExportResult {
  const items: ReportItem[] = [];
  const blocks: string[] = [];
  questions.forEach((question, i) => {
    const planned = plan(question, i + 1);
    items.push(planned.item);
    if (planned.block) blocks.push(planned.block);
  });

  const name = safeName(options.name);
  const file = `${name}.txt`;
  const head = [`// Written by OpenAssess. One question to a block; a blank line ends it.`, `$CATEGORY: $course$/top/${name.replace(/[\r\n]/g, " ")}`];
  const content = `${head.join("\n")}\n\n${blocks.join("\n\n")}${blocks.length > 0 ? "\n" : ""}`;

  const general = [
    `The questions go into a category called "${name}" in the course, which Moodle makes if it is not there.`,
    "GIFT is plain text with a few marks. Titles, tags, objectives, difficulty and history are not part of it.",
    "Points are not part of GIFT: Moodle gives each question its own default.",
  ];
  const report = buildReport(GIFT_ID, GIFT_LABEL, questions.length, items, blocks.length > 0 ? [file] : [], general);
  return { files: blocks.length > 0 ? [{ name: file, content, questions: blocks.length }] : [], report };
}
