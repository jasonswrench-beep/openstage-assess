/**
 * Export to Moodle XML, the question format Moodle reads and writes itself.
 *
 * It holds more than GIFT does: formatting in the text and in every answer, feedback for a right answer and for a wrong
 * one, spare answers in a matching question, the case rule of a short answer, and the points of each question. It has no
 * ordering, hotspot or calculated question, so those are left out and said so, and a question with no usable answer key is
 * never written.
 *
 * Text goes into CDATA as HTML, so that nothing in a question can be taken for markup of the file's own. The names and
 * numbers, which Moodle does not read as HTML, are escaped.
 */

import { hasUsableKey } from "../quality/answer-key.ts";
import { isChoice, isFillInBlank, isMultipleResponse, isShortAnswer, isTrueFalse, type Question } from "../model/question.ts";
import type { ExportResult, ReportItem } from "./types.ts";
import { buildReport, exportable, hasText, htmlText, keyProblem, lossNotes, newLosses, plainText, safeName, TYPE_NAMES } from "./text.ts";
import { escapeHtml, stripInvalidCharacters, type RichText } from "../model/richtext.ts";
import { replacePlaceholders } from "../model/markup-scan.ts";
import { sniffImage } from "../model/image.ts";

export const MOODLE_XML_ID = "moodle-xml";
export const MOODLE_XML_LABEL = "Moodle XML";

/** Text for an XML element or attribute: nothing XML 1.0 forbids (see `stripInvalidCharacters`), and the four characters that mean markup written out. */
export const escapeXml = (text: string): string =>
  stripInvalidCharacters(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** HTML inside CDATA, with the one sequence that would end it split in two, and nothing XML 1.0 forbids. */
export const cdata = (html: string): string => `<![CDATA[${stripInvalidCharacters(html).replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>`;

/** The weight of one right answer out of several, in the form Moodle reads. */
const share = (n: number): number => Math.round((100 / n) * 100000) / 100000;

interface Planned {
  item: ReportItem;
  xml?: string;
  /** How many equations were written as LaTeX in the text of the question. */
  equations?: number;
}

/**
 * The equations in a text, written the way Moodle reads them: LaTeX between \( and \), which its MathJax filter turns into the
 * equation. Nothing is lost, since the LaTeX is what the equation is. An equation with no LaTeX, or LaTeX that holds the characters
 * that would end the delimiters early, is left where it is and written as words by the usual path, and counted.
 */
function carryEquations(text: RichText, question: Question, carried: { count: number }): RichText {
  if (text.format === "plain") return text;
  const content = replacePlaceholders(text.content, "math", (ref, whole) => {
    const latex = question.math.find((m) => m.id === ref)?.latex.trim() ?? "";
    if (latex === "" || latex.includes("\\)") || latex.includes("$$")) return whole;
    carried.count++;
    return ` \\(${escapeHtml(latex)}\\) `;
  });
  return { ...text, content };
}

/** A name Moodle can keep a file under, and that is safe inside a file name and an attribute. */
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

/**
 * The pictures in the text of a question, written the way Moodle XML carries them: an image tag that points at `@@PLUGINFILE@@/name`
 * and the file itself, in base64, beside the text. A picture whose bytes are not offered, or are not a PNG, JPEG or GIF, or whose
 * name Moodle could not keep, is left where it is and is written as words by the usual path, and counted. The file is named for
 * what its bytes are, whatever the bank called it, so Moodle does not take a JPEG for a PNG.
 */
function carryPictures(text: RichText, question: Question, media: ReadonlyMap<string, Uint8Array> | undefined): { text: RichText; files: Array<{ name: string; bytes: Uint8Array }> } {
  if (media === undefined || text.format === "plain") return { text, files: [] };
  const files = new Map<string, Uint8Array>();
  const content = replacePlaceholders(text.content, "media", (ref, whole) => {
    const entry = question.media.find((m) => m.id === ref);
    const bytes = entry ? media.get(entry.file) : undefined;
    const info = bytes ? sniffImage(bytes) : undefined;
    if (!entry || !bytes || !info || !entry.file.startsWith("media/")) return whole;
    const base = entry.file.slice("media/".length).replace(/\.[A-Za-z0-9]+$/, "");
    const name = `${base}.${info.ext}`;
    if (!SAFE_FILE.test(name)) return whole;
    const held = files.get(name);
    if (held !== undefined && held !== bytes && Buffer.compare(Buffer.from(held), Buffer.from(bytes)) !== 0) return whole; // two different pictures under one name
    files.set(name, bytes);
    const alt = entry.decorative ? "" : entry.alt.trim();
    return `<img src="@@PLUGINFILE@@/${name}" alt="${escapeHtml(alt)}" />`;
  });
  return { text: { ...text, content }, files: [...files].map(([name, bytes]) => ({ name, bytes })) };
}

function plan(question: Question, position: number, media?: ReadonlyMap<string, Uint8Array>): Planned {
  const base = { position, questionId: question.id, title: question.title };
  const leftOut = (why: string): Planned => ({ item: { ...base, outcome: "leftOut", notes: [why] } });

  const supported =
    isChoice(question) || isMultipleResponse(question) || isTrueFalse(question) || isFillInBlank(question) || isShortAnswer(question) || question.type === "matching" || question.type === "numeric" || question.type === "essay";
  if (!supported) {
    const name = TYPE_NAMES[question.type];
    return leftOut(`Moodle XML has no ${name} question, so ${/^[aeiou]/.test(name) ? "an" : "a"} ${name} question cannot be written in it.`);
  }
  if (!hasUsableKey(question)) return leftOut(keyProblem(question, "Moodle"));

  const losses = newLosses();
  const notes: string[] = [];
  let asType: string | undefined;

  const equations = { count: 0 };
  const html = (text: RichText): string => htmlText(carryEquations(text, question, equations), question, losses);
  const text = (value: RichText | undefined, tag: string): string =>
    `<${tag} format="html"><text>${value && hasText(value) ? cdata(html(value)) : ""}</text></${tag}>`;
  const carried = carryPictures(question.stem, question, media);
  const stem = html(carried.text);
  if (plainText(question.stem, question, newLosses(), true) === "") return leftOut("It has no question text.");

  const fb = (value: RichText | undefined): string => (value && hasText(value) ? `<feedback format="html"><text>${cdata(html(value))}</text></feedback>` : "<feedback format=\"html\"><text></text></feedback>");
  const answer = (fraction: number, body: string, feedback = ""): string => `<answer fraction="${fraction}" format="html"><text>${body}</text>${feedback || "<feedback format=\"html\"><text></text></feedback>"}</answer>`;

  let type: string;
  let body = "";

  if (isChoice(question) || isMultipleResponse(question)) {
    const options = question.body.options;
    if (options.some((o) => !hasText(o.content))) return leftOut("One of its answers has no text, and Moodle cannot hold an empty answer.");
    const multiple = isMultipleResponse(question);
    const right = options.filter((o) => o.correct).length;
    if (multiple && right === options.length) return leftOut("Every answer is marked right, so there is nothing to choose, and Moodle would score nothing.");
    type = "multichoice";
    const wrong = multiple ? (question.body as { partialCredit: boolean }).partialCredit ? share(right) : 100 : 0;
    body =
      `<single>${multiple ? "false" : "true"}</single><shuffleanswers>${question.body.shuffle ? "true" : "false"}</shuffleanswers><answernumbering>abc</answernumbering>` +
      text(question.feedback.correct, "correctfeedback") +
      text(undefined, "partiallycorrectfeedback") +
      text(question.feedback.incorrect, "incorrectfeedback") +
      options
        .map((o) => answer(o.correct ? (multiple ? share(right) : 100) : multiple ? -wrong : 0, cdata(html(o.content)), fb(o.feedback)))
        .join("");
    if (multiple) {
      notes.push(
        (question.body as { partialCredit: boolean }).partialCredit
          ? "A multiple response is written as weights: each right answer is worth an equal share, and each wrong one takes the same share away."
          : "A multiple response is written as weights. This one is all or nothing, so a wrong answer takes away everything.",
      );
    }
    if (options.some((o) => o.fixedPosition)) notes.push("An answer that stays in place when the others are mixed up cannot be said in Moodle XML.");
  } else if (isTrueFalse(question)) {
    if (typeof question.body.correct !== "boolean") return leftOut("Neither True nor False is marked, and nothing is guessed.");
    type = "truefalse";
    const yes = question.body.correct;
    body = answer(yes ? 100 : 0, "true", fb(yes ? question.feedback.correct : question.feedback.incorrect)) + answer(yes ? 0 : 100, "false", fb(yes ? question.feedback.incorrect : question.feedback.correct));
  } else if (isFillInBlank(question) || isShortAnswer(question)) {
    let accepted: string[];
    let caseSensitive: boolean;
    if (isFillInBlank(question)) {
      if (question.body.blanks.length !== 1) return leftOut(`It has ${question.body.blanks.length} blanks, and a Moodle short answer holds one.`);
      accepted = (question.body.blanks[0] as { accepted: string[] }).accepted;
      caseSensitive = question.body.caseSensitive;
      asType = "short answer";
      notes.push("A fill in the blank is written as a short answer, because Moodle XML does not know where in the text the blank is.");
    } else {
      accepted = question.body.accepted;
      caseSensitive = question.body.caseSensitive;
    }
    const cleaned = accepted.map((a) => a.replace(/\s+/g, " ").trim()).filter((a) => a !== "");
    if (cleaned.length === 0) return leftOut("It has no accepted answer, and nothing is guessed.");
    type = "shortanswer";
    body =
      `<usecase>${caseSensitive ? 1 : 0}</usecase>` +
      cleaned.map((a, i) => `<answer fraction="100" format="plain_text"><text>${escapeXml(a)}</text>${i === 0 ? fb(question.feedback.correct) : "<feedback format=\"html\"><text></text></feedback>"}</answer>`).join("") +
      // Moodle's way of giving feedback to every answer that was not one of the accepted ones.
      (question.feedback.incorrect && hasText(question.feedback.incorrect) ? `<answer fraction="0" format="plain_text"><text>*</text>${fb(question.feedback.incorrect)}</answer>` : "");
  } else if (question.type === "matching") {
    const matching = question.body as { pairs: Array<{ left: RichText; right: string }>; distractors?: string[]; shuffle?: boolean };
    if (matching.pairs.length < 2) return leftOut(`It has ${matching.pairs.length} pair, and Moodle needs at least two in a matching question.`);
    if (matching.pairs.some((p) => !hasText(p.left) || p.right.trim() === "")) return leftOut("One of its pairs has nothing on one side, and nothing is guessed to fill it.");
    type = "matching";
    body =
      // Its own setting is carried: the reader reads this element, and a literal true turned a question that keeps its order into one that mixes.
      `<shuffleanswers>${matching.shuffle === false ? "false" : "true"}</shuffleanswers>` +
      text(question.feedback.correct, "correctfeedback") +
      text(undefined, "partiallycorrectfeedback") +
      text(question.feedback.incorrect, "incorrectfeedback") +
      matching.pairs.map((p) => `<subquestion format="html"><text>${cdata(html(p.left))}</text><answer format="plain_text"><text>${escapeXml(p.right.trim())}</text></answer></subquestion>`).join("") +
      // A spare answer is a right-hand side with no left-hand side.
      (matching.distractors ?? []).filter((d) => d.trim() !== "").map((d) => `<subquestion format="html"><text></text><answer format="plain_text"><text>${escapeXml(d.trim())}</text></answer></subquestion>`).join("");
  } else if (question.type === "numeric") {
    const numeric = question.body as { mode: string; value?: number; min?: number; max?: number; tolerance?: number; units?: string };
    let value: number;
    let tolerance = 0;
    if (numeric.mode === "range" && typeof numeric.min === "number" && typeof numeric.max === "number") {
      value = (numeric.min + numeric.max) / 2;
      tolerance = (numeric.max - numeric.min) / 2;
      notes.push("A range is written as its middle value, give or take half its width.");
    } else if (typeof numeric.value === "number") {
      value = numeric.value;
      tolerance = numeric.mode === "tolerance" && typeof numeric.tolerance === "number" ? numeric.tolerance : 0;
    } else return leftOut("It has no value to score against, and nothing is guessed.");
    type = "numerical";
    body =
      `<answer fraction="100" format="plain_text"><text>${value}</text><tolerance>${tolerance}</tolerance>${fb(question.feedback.correct)}</answer>` +
      (numeric.units && numeric.units.trim() !== "" ? `<unitgradingtype>0</unitgradingtype><unitpenalty>0.1</unitpenalty><showunits>3</showunits><unitsleft>0</unitsleft><units><unit><multiplier>1</multiplier><unit_name>${escapeXml(numeric.units.trim())}</unit_name></unit></units>` : "");
  } else {
    type = "essay";
    const model = (question.body as { modelAnswer?: RichText }).modelAnswer;
    body =
      `<responseformat>editor</responseformat><responserequired>1</responserequired><responsefieldlines>15</responsefieldlines><attachments>0</attachments>` +
      `<graderinfo format="html"><text>${model && hasText(model) ? cdata(html(model)) : ""}</text></graderinfo>`;
    if (model && hasText(model)) notes.push("The model answer is written as the note for the person who marks it.");
    // What the other exporters say and this one did not: a rubric and an expected length have no place in a Moodle essay.
    const essay = question.body as { rubric?: unknown[]; expectedWords?: number };
    if ((essay.rubric ?? []).length > 0) notes.push("The rubric cannot be carried: a rubric is made in Moodle.");
    if (typeof essay.expectedWords === "number") notes.push("The expected length cannot be carried.");
  }

  const hasOutcomeFeedback = (question.feedback.correct && hasText(question.feedback.correct)) || (question.feedback.incorrect && hasText(question.feedback.incorrect));
  if (type === "essay" && hasOutcomeFeedback) notes.push("Feedback for a right answer and for a wrong one is not carried to an essay, which is marked by a person.");
  if (type === "numerical" && question.feedback.incorrect && hasText(question.feedback.incorrect)) notes.push("Feedback for a wrong answer is not carried to a numeric question.");
  // The general feedback is written before the losses are counted: a picture or an equation in it became words, and the question was
  // reported as exported with no note, because the notes had been made before this text was rendered.
  const generalFeedback = text(question.feedback.general, "generalfeedback");
  notes.push(...lossNotes(losses, "Moodle"));

  const xml =
    `<question type="${type}"><name><text>${escapeXml(question.title)}</text></name>` +
    `<questiontext format="html"><text>${cdata(stem)}</text>${carried.files.map((f) => `<file name="${escapeXml(f.name)}" path="/" encoding="base64">${Buffer.from(f.bytes).toString("base64")}</file>`).join("")}</questiontext>` +
    generalFeedback +
    `<defaultgrade>${question.points}</defaultgrade><hidden>0</hidden>${body}</question>`;
  return { item: { ...base, outcome: notes.length > 0 ? "exportedWithLosses" : "exported", ...(asType ? { asType } : {}), notes }, xml, equations: equations.count };
}

export interface MoodleXmlOptions {
  /** What to call the file, and the category the questions go into. Usually the bank's title. */
  name?: string;
  /** The bank's pictures by path (`Bank.media`). With it, a picture in a question's text is written into the file; without it, as words. */
  media?: ReadonlyMap<string, Uint8Array>;
}

export function checkMoodleXml(questions: readonly Question[], options: MoodleXmlOptions = {}): ExportResult["report"] {
  return exportMoodleXml(questions, options).report;
}

export function exportMoodleXml(questions: readonly Question[], options: MoodleXmlOptions = {}): ExportResult {
  questions = exportable(questions);
  const items: ReportItem[] = [];
  const blocks: string[] = [];
  let equations = 0;
  questions.forEach((question, i) => {
    const planned = plan(question, i + 1, options.media);
    items.push(planned.item);
    if (planned.xml) {
      blocks.push(planned.xml);
      equations += planned.equations ?? 0;
    }
  });

  const name = safeName(options.name);
  const file = `${name}.xml`;
  const category = `<question type="category"><category><text>${escapeXml(`$course$/top/${name}`)}</text></category></question>`;
  const content = `<?xml version="1.0" encoding="UTF-8"?>\n<quiz>\n${[category, ...blocks].join("\n")}\n</quiz>\n`;

  const general = [
    `The questions go into a category called "${name}" in the course, which Moodle makes if it is not there.`,
    "Titles, tags, objectives, difficulty and history are not part of Moodle XML.",
    ...(options.media ? ["A picture in the text of a question is written into the file with it. A picture in an answer, in feedback or in a matching question is written as words."] : []),
    ...(equations > 0
      ? [`${equations === 1 ? "1 equation is" : `${equations} equations are`} written as LaTeX between \\( and \\), which Moodle shows as an equation when its MathJax filter is on and as that text when it is off. Check how one reads after the import.`]
      : []),
    "Attempts and penalties are delivery settings, not part of a question, so none is written and Moodle applies its own.",
  ];
  const report = buildReport(MOODLE_XML_ID, MOODLE_XML_LABEL, questions.length, items, blocks.length > 0 ? [file] : [], general);
  return { files: blocks.length > 0 ? [{ name: file, content, questions: blocks.length }] : [], report };
}
