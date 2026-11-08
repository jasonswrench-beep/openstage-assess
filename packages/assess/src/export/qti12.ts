/**
 * Export as a QTI 1.2 package: the format Brightspace's Import/Export/Copy Components reads for quizzes (the route
 * documented for QTI files), and Canvas's "QTI .zip file". Brightspace's own help for the Question Library names a CSV file and not QTI.
 *
 * A QTI package is a zip with an imsmanifest.xml that names one resource, and the resource is a questestinterop file holding an
 * assessment, one section and an item for each question. The items follow the shapes that IMS describes for QTI 1.2 and that
 * Canvas writes itself: a multiple choice question is one response_lid with a render_choice and a condition that sets SCORE
 * when the right label is chosen; a multiple answer question is the same with a Multiple cardinality and a condition that is
 * all of the right labels and none of the wrong ones; a short answer is a response_str with a render_fib and a condition for
 * each accepted answer; a matching question is a response_lid for each left side, each offering every right side; an essay is
 * a response_str with no condition that can be met, so it is marked by hand. Each item also says its kind and its points in the
 * qtimetadata that Canvas reads, and sets its SCORE to the same number of points, which is what a reader of the conditions
 * alone reads.
 *
 * What the package cannot hold is the whole of the destination check. Neither tool lists the question types it reads from QTI,
 * so an ordering, a numeric, a hotspot and a calculated question are left out and said so, not written untried. Feedback and the
 * partial credit of a multiple answer question are not carried. A question with no usable answer key is never written, and no
 * key is ever guessed to fit.
 */

import { textEntry, zipSync } from "../container/zip.ts";
import { hasUsableKey } from "../quality/answer-key.ts";
import { isChoice, isFillInBlank, isMultipleResponse, isShortAnswer, isTrueFalse, type Question } from "../model/question.ts";
import type { RichText } from "../model/richtext.ts";
import type { ExportResult, ReportItem } from "./types.ts";
import { escapeXml } from "./moodle-xml.ts";
import { buildReport, exportable, FORMATTING, hasText, htmlText, keyProblem, lossNotes, newLosses, plainText, safeName, scorable, TYPE_NAMES } from "./text.ts";

export const QTI12_ID = "qti-1.2";
export const QTI12_LABEL = "QTI 1.2 package (Brightspace and Canvas)";

/** The names the XML uses. The questestinterop namespace is the one Canvas writes its own QTI 1.2 with. */
const QTI_NAMESPACE = "http://www.imsglobal.org/xsd/ims_qtiasiv1p2";
const QTI_SCHEMA = "http://www.imsglobal.org/xsd/ims_qtiasiv1p2p1.xsd";
const CP_NAMESPACE = "http://www.imsglobal.org/xsd/imscp_v1p1";
const CP_SCHEMA = "http://www.imsglobal.org/xsd/imscp_v1p1.xsd";

/** The resource type IMS gives an assessment file in a QTI 1.2 package. */
export const QTI12_RESOURCE_TYPE = "imsqti_xmlv1p2";

/** Whitespace of any kind as one space. */
export const flat = (text: string): string => text.replace(/\s+/g, " ").trim();

/** A number as it is written in the file: no exponent, no trailing zeros. */
export const num = (value: number): string => String(Math.round(value * 100000) / 100000);

interface Planned {
  item: ReportItem;
  xml?: string;
}

/** Text that is plain text, or markup that holds nothing a plain label cannot. */
export const needsMarkup = (text: RichText): boolean => text.format === "rich" && (FORMATTING.test(text.content) || /<oa-(media|math)\b/i.test(text.content));

function plan(question: Question, position: number): Planned {
  const base = { position, questionId: question.id, title: question.title };
  const leftOut = (why: string): Planned => ({ item: { ...base, outcome: "leftOut", notes: [why] } });

  const supported =
    isChoice(question) || isMultipleResponse(question) || isTrueFalse(question) || isFillInBlank(question) || isShortAnswer(question) || question.type === "matching" || question.type === "essay";
  if (!supported) {
    const name = TYPE_NAMES[question.type];
    const why =
      question.type === "ordering"
        ? "Neither Brightspace nor Canvas documents an ordering question in a QTI file, so it is not written untried. Brightspace's CSV export carries ordering questions."
        : question.type === "numeric"
          ? "Neither Brightspace nor Canvas documents a numeric question in a QTI file, so it is not written untried."
          : `A QTI 1.2 package from here has no ${name} question, so ${/^[aeiou]/.test(name) ? "an" : "a"} ${name} question cannot be written in it.`;
    return leftOut(why);
  }
  if (!hasUsableKey(question)) return leftOut(keyProblem(question, "the destination"));

  const losses = newLosses();
  const notes: string[] = [];
  let asType: string | undefined;

  // Text is carried as HTML where it has anything a plain label cannot carry, and as plain text where it does not.
  const mat = (text: RichText): string => {
    if (needsMarkup(text)) return `<material><mattext texttype="text/html">${escapeXml(htmlText(text, question, losses).replace(/\s*\n\s*/g, " "))}</mattext></material>`;
    return `<material><mattext texttype="text/plain">${escapeXml(flat(plainText(text, question, losses, false)))}</mattext></material>`;
  };
  const words = (text: RichText): boolean => (needsMarkup(text) ? hasText(text) : flat(plainText(text, question, newLosses(), false)) !== "");

  // The question text is HTML always, so that its paragraphs stay paragraphs.
  if (plainText(question.stem, question, newLosses(), true) === "") return leftOut("It has no question text once it is written as plain text.");
  const stem = `<material><mattext texttype="text/html">${escapeXml(htmlText(question.stem, question, losses).replace(/\s*\n\s*/g, " "))}</mattext></material>`;

  const n = position;
  const pts = num(question.points);
  const respident = "response1";
  const win = `<setvar varname="SCORE" action="Set">${pts}</setvar>`;
  const labelId = (i: number): string => `q${n}_a${i + 1}`;

  let kind: string;
  let response: string;
  let conditions: string;

  if (isChoice(question) || isMultipleResponse(question)) {
    const options = question.body.options;
    if (options.length < 2) return leftOut("It has fewer than two answers.");
    if (options.some((o) => !words(o.content))) return leftOut("One of its answers has no text, and the destination needs text in every answer.");
    const multiple = isMultipleResponse(question);
    kind = multiple ? "multiple_answers_question" : "multiple_choice_question";
    const fixed = options.filter((o) => o.fixedPosition).length;
    // The file can keep every answer where it is or mix every one, and nothing between.
    const shuffle = question.body.shuffle && fixed === 0;
    if (question.body.shuffle && fixed > 0 && fixed < options.length) {
      notes.push("Some answers of this question are fixed in place and others are mixed. The file cannot say which, so all of them stay in the order written.");
    }
    const labels = options.map((o, i) => `<response_label ident="${labelId(i)}">${mat(o.content)}</response_label>`).join("");
    response = `<response_lid ident="${respident}" rcardinality="${multiple ? "Multiple" : "Single"}"><render_choice shuffle="${shuffle ? "Yes" : "No"}">${labels}</render_choice></response_lid>`;
    if (multiple) {
      // Every right answer chosen and no wrong one: the shape Canvas writes for a multiple answer question.
      const parts = options.map((o, i) => (o.correct ? `<varequal respident="${respident}">${labelId(i)}</varequal>` : `<not><varequal respident="${respident}">${labelId(i)}</varequal></not>`));
      conditions = `<respcondition continue="No"><conditionvar><and>${parts.join("")}</and></conditionvar>${win}</respcondition>`;
      if (question.body.partialCredit) notes.push("Partial credit cannot be carried: the question is marked right only when every right answer and no wrong one is chosen.");
    } else {
      const right = options.findIndex((o) => o.correct);
      conditions = `<respcondition continue="No"><conditionvar><varequal respident="${respident}">${labelId(right)}</varequal></conditionvar>${win}</respcondition>`;
    }
    if (options.some((o) => o.feedback && hasText(o.feedback))) notes.push("Feedback on a single answer cannot be carried.");
  } else if (isTrueFalse(question)) {
    if (typeof question.body.correct !== "boolean") return leftOut("Neither True nor False is marked, and nothing is guessed.");
    kind = "true_false_question";
    const trueId = `q${n}_true`;
    const falseId = `q${n}_false`;
    response =
      `<response_lid ident="${respident}" rcardinality="Single"><render_choice shuffle="No">` +
      `<response_label ident="${trueId}"><material><mattext texttype="text/plain">True</mattext></material></response_label>` +
      `<response_label ident="${falseId}"><material><mattext texttype="text/plain">False</mattext></material></response_label>` +
      `</render_choice></response_lid>`;
    conditions = `<respcondition continue="No"><conditionvar><varequal respident="${respident}">${question.body.correct ? trueId : falseId}</varequal></conditionvar>${win}</respcondition>`;
  } else if (isFillInBlank(question) || isShortAnswer(question)) {
    let accepted: string[];
    let caseSensitive: boolean;
    if (isFillInBlank(question)) {
      if (question.body.blanks.length !== 1) {
        return leftOut(`It has ${question.body.blanks.length} blanks, and a QTI 1.2 short answer takes one answer box. Brightspace and Canvas read several blanks from their own forms of the file, which are not written here.`);
      }
      accepted = (question.body.blanks[0] as { accepted: string[] }).accepted;
      caseSensitive = question.body.caseSensitive;
      asType = "short answer";
      notes.push("A fill in the blank is written as a short answer, because the file cannot say where in the text the blank is. The text still has the blank in it.");
    } else {
      accepted = question.body.accepted;
      caseSensitive = question.body.caseSensitive;
    }
    const cleaned = [...new Set(accepted.map(flat).filter((a) => a !== ""))];
    if (cleaned.length === 0) return leftOut("It has no accepted answer, and nothing is guessed.");
    kind = "short_answer_question";
    response = `<response_str ident="${respident}" rcardinality="Single"><render_fib columns="40"><response_label ident="answer1" rshuffle="No"/></render_fib></response_str>`;
    // One condition for each accepted answer, so that a reader that takes only the first of an "or" still sees every answer.
    conditions = cleaned
      .map((a) => `<respcondition continue="No"><conditionvar><varequal respident="${respident}" case="${caseSensitive ? "Yes" : "No"}">${escapeXml(a)}</varequal></conditionvar>${win}</respcondition>`)
      .join("");
  } else if (question.type === "matching") {
    // Found by a tester of fields: a matching question that keeps its answers in a fixed order came back mixed up, and nothing said so.
    if ((question.body as { shuffle?: boolean }).shuffle === false) notes.push("This matching question keeps its answers in a fixed order, and QTI 1.2 cannot say so. Its own setting for mixing the answers applies.");
    const body = question.body as { pairs: Array<{ left: RichText; right: string }>; distractors?: string[] };
    if (body.pairs.length < 2) return leftOut(`It has ${body.pairs.length} pair${body.pairs.length === 1 ? "" : "s"}, and a matching question needs at least two.`);
    if (body.pairs.some((p) => !words(p.left) || flat(p.right) === "")) return leftOut("One of its pairs has nothing on one side, and nothing is guessed to fill it.");
    kind = "matching_question";
    // Each distinct right side is one label, offered in every list. The spare answers are labels no left side points to.
    const rights: string[] = [];
    const rightIndex = (text: string): number => {
      const at = rights.indexOf(text);
      if (at >= 0) return at;
      rights.push(text);
      return rights.length - 1;
    };
    const wanted = body.pairs.map((p) => rightIndex(flat(p.right)));
    for (const d of body.distractors ?? []) if (flat(d) !== "") rightIndex(flat(d));
    const rightId = (i: number): string => `q${n}_m${i + 1}`;
    const choices = rights.map((r, i) => `<response_label ident="${rightId(i)}"><material><mattext texttype="text/plain">${escapeXml(r)}</mattext></material></response_label>`).join("");
    response = body.pairs.map((p, i) => `<response_lid ident="response${i + 1}">${mat(p.left)}<render_choice>${choices}</render_choice></response_lid>`).join("");
    // Each right match is a share of the points, added, so that a question half right is worth half. QTI stops at the first
    // condition that is met unless it says to continue, and these are added together, so each says to.
    // The shares are rounded, and the last one is what is left, so that every match right adds up to exactly the points and not
    // to 0.99999 of them.
    const count = body.pairs.length;
    const each = Math.round((question.points / count) * 100000) / 100000;
    const share = (i: number): string => num(i < count - 1 ? each : question.points - each * (count - 1));
    conditions = body.pairs
      .map((_p, i) => `<respcondition continue="Yes"><conditionvar><varequal respident="response${i + 1}">${rightId(wanted[i] as number)}</varequal></conditionvar><setvar varname="SCORE" action="Add">${share(i)}</setvar></respcondition>`)
      .join("");
  } else {
    // An essay is a written response, marked by hand: no condition can be met.
    kind = "essay_question";
    response = `<response_str ident="${respident}" rcardinality="Single"><render_fib rows="15" columns="60"><response_label ident="answer1" rshuffle="No"/></render_fib></response_str>`;
    conditions = `<respcondition continue="No"><conditionvar><other/></conditionvar></respcondition>`;
    const body = question.body as { modelAnswer?: RichText; rubric?: unknown[]; expectedWords?: number };
    if (body.modelAnswer && hasText(body.modelAnswer)) notes.push("The model answer cannot be carried.");
    if ((body.rubric ?? []).length > 0) notes.push("The rubric cannot be carried: a rubric is made in the learning system.");
    if (typeof body.expectedWords === "number") notes.push("The expected length cannot be carried.");
  }

  if ([question.feedback.general, question.feedback.correct, question.feedback.incorrect].some((f) => f && hasText(f))) {
    notes.push("Feedback cannot be carried in this package.");
  }
  if (losses.formatting) notes.push("Bold, italics, lists or tables in the text became plain text.");
  if (losses.breaks) notes.push("Paragraph breaks became spaces.");
  notes.push(...lossNotes(losses, "the learning system"));

  const title = escapeXml(flat(question.title).slice(0, 100) || `Question ${n}`);
  const xml =
    `<item ident="q${n}" title="${title}">` +
    `<itemmetadata><qtimetadata>` +
    `<qtimetadatafield><fieldlabel>question_type</fieldlabel><fieldentry>${kind}</fieldentry></qtimetadatafield>` +
    `<qtimetadatafield><fieldlabel>points_possible</fieldlabel><fieldentry>${pts}</fieldentry></qtimetadatafield>` +
    `</qtimetadata></itemmetadata>` +
    `<presentation>${stem}${response}</presentation>` +
    `<resprocessing><outcomes><decvar maxvalue="${pts}" minvalue="0" varname="SCORE" vartype="Decimal"/></outcomes>${conditions}</resprocessing>` +
    `</item>`;

  return { item: { ...base, outcome: notes.length > 0 ? "exportedWithLosses" : "exported", ...(asType ? { asType } : {}), notes }, xml };
}

export interface Qti12Options {
  /** What to call the assessment and the file. Usually the bank's title. */
  name?: string;
}

/** The destination check on its own: what would arrive, what would be lost, what cannot go. */
export function checkQti12(questions: readonly Question[], options: Qti12Options = {}): ExportResult["report"] {
  return exportQti12(questions, options).report;
}

/** The destination check, and the package to write. */
/**
 * Plans a question as QTI can score it (see `scorable`): a question worth no points is written worth 1, and the planner's report says so. Done here and
 * not inside the planner, which narrows its question by its type.
 */
function planScored(question: Question, planIt: (q: Question) => Planned): Planned {
  const extra: string[] = [];
  const planned = planIt(scorable(question, extra));
  if (extra.length === 0 || planned.item.outcome === "leftOut") return planned;
  return { ...planned, item: { ...planned.item, outcome: "exportedWithLosses", notes: [...extra, ...planned.item.notes] } };
}

export function exportQti12(questions: readonly Question[], options: Qti12Options = {}): ExportResult {
  questions = exportable(questions);
  const items: ReportItem[] = [];
  const written: string[] = [];
  questions.forEach((question, i) => {
    const planned = planScored(question, (q) => plan(q, i + 1));
    items.push(planned.item);
    if (planned.xml) written.push(planned.xml);
  });

  const base = safeName(options.name);
  const title = escapeXml(options.name?.trim() || base);
  const assessment =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<questestinterop xmlns="${QTI_NAMESPACE}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${QTI_NAMESPACE} ${QTI_SCHEMA}">\n` +
    `<assessment ident="assessment1" title="${title}">\n` +
    `<section ident="section1" title="${title}">\n` +
    written.join("\n") +
    `\n</section>\n</assessment>\n</questestinterop>\n`;
  const manifest =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<manifest identifier="manifest1" xmlns="${CP_NAMESPACE}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${CP_NAMESPACE} ${CP_SCHEMA}">\n` +
    `<metadata><schema>IMS Content</schema><schemaversion>1.1.2</schemaversion></metadata>\n` +
    `<organizations/>\n` +
    `<resources>\n<resource identifier="resource1" type="${QTI12_RESOURCE_TYPE}" href="assessment.xml"><file href="assessment.xml"/></resource>\n</resources>\n` +
    `</manifest>\n`;

  const file = `${base} - QTI 1.2.zip`;
  const bytes = written.length > 0 ? zipSync([textEntry("imsmanifest.xml", manifest), textEntry("assessment.xml", assessment)]) : undefined;

  const general = [
    "In Brightspace: Course Admin, Import/Export/Copy Components, Import Components, from a File. Choose the zip, open Advanced Options, tick Quizzes when it asks which components, and type the exact name of the zip in the Import file to box. These are the documented steps for a QTI zip. D2L's help for the Question Library names a CSV file, not QTI, so use the Brightspace CSV for the library.",
    "In Canvas: Settings, then Import Course Content, with the content type QTI .zip file. Under the file, Create new question bank makes a question bank of the questions as well as a quiz. Canvas's guide for this is for Classic Quizzes.",
    "Neither tool lists which question types it reads from a QTI file, so a type that does not arrive says so when you import. The other questions still do.",
    "Difficulty, tags, objectives and history are not part of the file. Images are not carried.",
  ];
  const report = buildReport(QTI12_ID, QTI12_LABEL, questions.length, items, bytes ? [file] : [], general);
  return { files: bytes ? [{ name: file, content: "", bytes, questions: written.length }] : [], report };
}
