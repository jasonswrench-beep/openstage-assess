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
import { isChoice, isFillInBlank, isMultipleResponse, isShortAnswer, isTrueFalse, titleFromStem, type Question } from "../model/question.ts";
import { escapeHtml } from "../model/richtext.ts";
import { titleText } from "../model/table.ts";
import type { ExportResult, ReportItem } from "./types.ts";
import { buildReport, exportable, FORMATTING, hasText, htmlText, keyProblem, lossNotes, newLosses, plainText, plural, safeName, TYPE_NAMES } from "./text.ts";

export const GIFT_ID = "gift";
export const GIFT_LABEL = "GIFT (Moodle and other tools)";

/** Moodle takes at least three pairs in a matching question and refuses fewer. */
const MIN_PAIRS = 3;

/** Escapes what GIFT gives a meaning to. Line breaks become \n so that a question stays in one block. */
export function giftEscape(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[\\~=#{}:]/g, (c) => `\\${c}`).replace(/\n/g, "\\n");
}

/**
 * A newline next to a block tag is nothing, and is taken out so that the block tags stay together; a newline anywhere else is whitespace in
 * HTML, or a line of a code block, and stays (giftEscape writes it as \n). Every newline between two tags was deleted before, and between
 * two inline tags it was the space between two words: `<strong>following</strong>\n<code>code</code>` was written with no gap.
 * Each pattern starts at a tag or at the newline itself, so a long run of white space is not scanned again for every place in it.
 */
const BLOCK = "(?:p|div|ul|ol|li|table|thead|tbody|tfoot|tr|td|th|pre|blockquote|h[1-6]|hr|br)";
const AFTER_BLOCK_TAG = new RegExp(`(</?${BLOCK}\\b[^>]*>)[ \\t]*\\n`, "gi");
const BEFORE_BLOCK_TAG = new RegExp(`\\n[ \\t]*(?=</?${BLOCK}\\b)`, "gi");
export function withoutBlockBreaks(html: string): string {
  return html.replace(AFTER_BLOCK_TAG, "$1").replace(BEFORE_BLOCK_TAG, "");
}

/** The weight of one right answer out of several, in the form Moodle reads. */
const share = (n: number): string => String(Math.round((100 / n) * 100000) / 100000);

/**
 * What GIFT reads as its own marks inside an answer and gives no way to escape: "->" is the sign of a matching pair, and a percentage
 * between percent signs at the start of an answer is its weight. A question with either in an answer is left out and said so. Written
 * as it was, an answer that held an arrow made the whole question a failed essay on the way back, a matching pair "p -> q" with
 * "Implication" came back as "p" with "q -> Implication", and an answer that began %50% was read as a weight and the wrong option
 * came back right.
 */
const ARROW = "->";
const WEIGHT_AT_START = /^\s*%-?\d+(?:\.\d+)?%/;
const ARROW_REASON = `One of its answers contains "${ARROW}", which GIFT reads as the mark for a matching pair, and it cannot be written another way.`;
const WEIGHT_REASON = "One of its answers begins with a percentage between percent signs (for example %50%), which GIFT reads as a weight, and it cannot be written another way.";

/** A number as plain digits. An exponent ("6.67e-11", "1e+21") is not something the numeric answer of every tool reads, and this one did not. */
export function plainNumber(n: number): string {
  const text = String(n);
  if (!/e/i.test(text)) return text;
  const sign = n < 0 ? "-" : "";
  const [mantissa = "", exponentText = "0"] = Math.abs(n).toExponential().toLowerCase().split("e");
  const exponent = Number(exponentText);
  const digits = mantissa.replace(".", "");
  const point = (mantissa.indexOf(".") === -1 ? mantissa.length : mantissa.indexOf(".")) + exponent;
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

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
  // A newline between two blocks is nothing, and a newline inside a block is a space (or a line of a code block): giftEscape writes it as \n,
  // which Moodle reads back as a newline in HTML. It was deleted, so "following\nis" was written "followingis".
  const stemText = formatted ? `[html]${giftEscape(withoutBlockBreaks(htmlText(question.stem, question, newLosses())))}` : giftEscape(stem);
  // Text that GIFT would read as something else at the start of a block: a line that begins // is a comment, so a question with that stem
  // vanished from the file and its answers were left as a block with no question; and a text that begins [html], [plain], [moodle] or
  // [markdown] has the tag taken for the format and lost. A [plain] tag in front is read as the format, and the text keeps what it had.
  const needsFormatTag = !formatted && /^\s*(?:\/\/|\[(?:html|plain|markdown|moodle)\])/i.test(stemText);
  const stemWritten = needsFormatTag ? `[plain]${stemText}` : stemText;
  // A title that is only the start of the question text, which is what an untitled question is given, says nothing the text
  // does not, and Moodle makes the same name from the text. Only a title someone wrote is written.
  const automatic = question.title === titleFromStem(titleText(question.stem));
  // The title sits between two pairs of colons, so it holds none: a run of them is one, and one at either end would run into the pair that
  // closes or opens it (a title ending in a colon put ": " at the start of the stem and changed the title).
  const wantedTitle = automatic ? "" : question.title.replace(/\s+/g, " ").trim();
  // Colons and spaces together at either end: "Part 2: :" is "Part 2", and stripping the colons alone left "Part 2:" to run into the pair that closes.
  const title = wantedTitle.replace(/:+/g, ":").replace(/^[\s:]+|[\s:]+$/g, "");
  if (title !== wantedTitle && wantedTitle !== "") {
    notes.push(`The title had colons in it that GIFT cannot hold next to its own marks. ${title === "" ? "It is left out" : `It is written as "${title}"`}.`);
  }

  const lines: string[] = [];
  const answer = (marker: "=" | "~", text: string, feedback?: string, weight?: string): string =>
    `${marker}${weight ? `%${weight}%` : ""}${giftEscape(text)}${feedback ? `#${giftEscape(feedback)}` : ""}`;

  if (isChoice(question) || isMultipleResponse(question)) {
    const options = question.body.options;
    const texts = options.map((o) => plainText(o.content, question, losses, false));
    if (texts.some((t) => t === "")) return leftOut("One of its answers has no text, and GIFT cannot hold an empty answer.");
    if (texts.some((t) => t.includes(ARROW))) return leftOut(ARROW_REASON);
    // A multiple response writes a weight in front of every answer, so a weight in the words that follow it is only words.
    if (isChoice(question) && texts.some((t) => WEIGHT_AT_START.test(t))) return leftOut(WEIGHT_REASON);
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
    if (cleaned.some((a) => a.includes(ARROW))) return leftOut(ARROW_REASON);
    if (cleaned.some((a) => WEIGHT_AT_START.test(a))) return leftOut(WEIGHT_REASON);
    for (const a of cleaned) lines.push(answer("=", a));
    if (caseSensitive) notes.push("Upper and lower case count in this question, and GIFT cannot say so.");
  } else if (question.type === "matching") {
    // Found by a tester of fields: a matching question that keeps its answers in a fixed order came back mixed up, and nothing said so.
    if ((question.body as { shuffle?: boolean }).shuffle === false) notes.push("This matching question keeps its answers in a fixed order, and GIFT cannot say so. Its own setting for mixing the answers applies.");
    const body = question.body as { pairs: Array<{ left: Parameters<typeof plainText>[0]; right: string }>; distractors?: string[] };
    if (body.pairs.length < MIN_PAIRS) return leftOut(`It has ${body.pairs.length} pairs and Moodle needs at least ${MIN_PAIRS} in a matching question.`);
    const pairs = body.pairs.map((p) => ({ left: plainText(p.left, question, losses, false), right: p.right.replace(/\s+/g, " ").trim() }));
    if (pairs.some((p) => p.left === "" || p.right === "")) return leftOut("One of its pairs has nothing on one side, and nothing is guessed to fill it.");
    if (pairs.some((p) => p.left.includes(ARROW) || p.right.includes(ARROW))) return leftOut(ARROW_REASON);
    if (pairs.some((p) => WEIGHT_AT_START.test(p.left))) return leftOut(WEIGHT_REASON);
    for (const p of pairs) lines.push(`=${giftEscape(p.left)} -> ${giftEscape(p.right)}`);
    if ((body.distractors ?? []).length > 0) notes.push(`${plural((body.distractors ?? []).length, "spare answer", "spare answers")} cannot be carried: GIFT matching has none.`);
  } else if (question.type === "numeric") {
    const body = question.body as { mode: string; value?: number; min?: number; max?: number; tolerance?: number; units?: string };
    if (body.mode === "range" && typeof body.min === "number" && typeof body.max === "number") lines.push(`#${plainNumber(body.min)}..${plainNumber(body.max)}`);
    else if (typeof body.value === "number") lines.push(`#${plainNumber(body.value)}${body.mode === "tolerance" && typeof body.tolerance === "number" ? `:${plainNumber(body.tolerance)}` : ""}`);
    else return leftOut("It has no value to score against, and nothing is guessed.");
    if (body.units && body.units.trim() !== "") notes.push(`The units (${body.units.trim()}) cannot be carried. Put them in the question text.`);
  } else {
    // An essay: GIFT writes it as empty braces.
    const model = (question.body as { modelAnswer?: Parameters<typeof plainText>[0] }).modelAnswer;
    if (model && hasText(model)) notes.push("The model answer cannot be carried: GIFT writes an essay as an empty answer.");
    const essay = question.body as { rubric?: unknown[]; expectedWords?: number };
    if ((essay.rubric ?? []).length > 0) notes.push("The rubric cannot be carried: GIFT has no place for one.");
    if (typeof essay.expectedWords === "number") notes.push("The expected length cannot be carried.");
  }

  // Feedback for a right or a wrong answer has no place in the other types.
  const wantsOutcomeFeedback = !isTrueFalse(question) && ((question.feedback.correct && hasText(question.feedback.correct)) || (question.feedback.incorrect && hasText(question.feedback.incorrect)));
  if (wantsOutcomeFeedback) notes.push("Feedback for a right answer and for a wrong one is not carried: GIFT keeps feedback with each answer, and a general note.");
  if (question.feedback.general && hasText(question.feedback.general)) {
    // The format tag of the question text applies to its feedback too, and the importer reads it so: a plain note written beside an HTML stem
    // was read as HTML ("Use the <script> tag" came back "Use the"). It is escaped as the HTML it will be read as.
    const general = plainText(question.feedback.general, question, losses, true);
    lines.push(`####${giftEscape(formatted ? escapeHtml(general) : general)}`);
  }

  if (formatted) notes.push("The question text keeps its formatting. The answers and the feedback become plain text.");
  else if (losses.formatting) notes.push("Bold, italics, lists or tables in the answers or the feedback became plain text.");
  if (losses.breaks) notes.push("Paragraph breaks in an answer became spaces.");
  notes.push(...lossNotes(losses, "Moodle"));

  const head = `${title === "" ? "" : `::${giftEscape(title)}:: `}${stemWritten} `;
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
  questions = exportable(questions);
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
