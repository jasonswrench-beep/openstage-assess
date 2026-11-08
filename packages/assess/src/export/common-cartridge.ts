/**
 * Export as an IMS Common Cartridge 1.3 package: the other way a quiz gets into Brightspace.
 *
 * The bare QTI 1.2 zip (qti12.ts) was tried in Brightspace and was not read as a quiz. D2L's own table of what its course import
 * reads names Common Cartridge, Blackboard and others as sources, each with a version of IMS content packaging and
 * of QTI, and a bare QTI package is none of them. A Common Cartridge package is. The shape here follows what a tool that builds
 * quizzes for Brightspace writes today (Brightspacosaurus 0.35.0, whose source was read on 1 November 2026): a manifest in the
 * Common Cartridge 1.3 namespace with an organization that lists the quiz, one resource of type
 * `imsqti_xmlv1p2/imscc_xmlv1p3/assessment`, and a questestinterop file in the Common Cartridge profile of QTI 1.2, in which
 * the assessment and every item name a `cc_profile`, an item's points are its `cc_weighting`, and the score of a right answer
 * is always 100 (Common Cartridge fixes that, and the weighting says what it is worth).
 *
 * That profile holds multiple choice, multiple answer, true or false, fill in the blank and essay questions, and no others, so a
 * matching, ordering, numeric, hotspot or calculated question is left out and said so. The QTI 1.2 package carries matching,
 * and Brightspace's CSV carries matching and ordering. Feedback and the partial credit of a multiple answer question are not
 * carried. A question with no usable answer key is never written, and no key is ever guessed to fit.
 *
 * What is known and what is not: the multiple choice, multiple answer and fill in the blank shapes are the ones the tool above
 * writes. True or false and essay follow the profile's own description, and have not been seen in a package that Brightspace
 * took. Nothing here has been imported into Brightspace or Canvas yet.
 */

import { textEntry, zipSync } from "../container/zip.ts";
import { hasUsableKey } from "../quality/answer-key.ts";
import { isChoice, isFillInBlank, isMultipleResponse, isShortAnswer, isTrueFalse, type Question } from "../model/question.ts";
import type { RichText } from "../model/richtext.ts";
import type { ExportResult, ReportItem } from "./types.ts";
import { escapeXml } from "./moodle-xml.ts";
import { flat, needsMarkup, num } from "./qti12.ts";
import { buildReport, exportable, hasText, htmlText, keyProblem, lossNotes, newLosses, plainText, safeName, scorable, TYPE_NAMES } from "./text.ts";

export const COMMON_CARTRIDGE_ID = "common-cartridge";
export const COMMON_CARTRIDGE_LABEL = "Common Cartridge 1.3 package (Brightspace)";

/** The resource type Common Cartridge 1.3 gives a QTI assessment. */
export const CC_ASSESSMENT_TYPE = "imsqti_xmlv1p2/imscc_xmlv1p3/assessment";

/** Where the quiz is in the zip. */
export const CC_ASSESSMENT_FILE = "quiz/qti-assessment.xml";

const CP_NAMESPACE = "http://www.imsglobal.org/xsd/imsccv1p3/imscp_v1p1";
const LOM_RESOURCE = "http://ltsc.ieee.org/xsd/imsccv1p3/LOM/resource";
const LOM_MANIFEST = "http://ltsc.ieee.org/xsd/imsccv1p3/LOM/manifest";
const MANIFEST_SCHEMAS =
  `${LOM_RESOURCE} http://www.imsglobal.org/profile/cc/ccv1p3/LOM/ccv1p3_lomresource_v1p0.xsd ` +
  `${CP_NAMESPACE} http://www.imsglobal.org/profile/cc/ccv1p3/ccv1p3_imscp_v1p2_v1p0.xsd ` +
  `${LOM_MANIFEST} http://www.imsglobal.org/profile/cc/ccv1p3/LOM/ccv1p3_lommanifest_v1p0.xsd`;
const QTI_NAMESPACE = "http://www.imsglobal.org/xsd/ims_qtiasiv1p2";
const QTI_SCHEMA = "http://www.imsglobal.org/profile/cc/ccv1p3/ccv1p3_qtiasiv1p2p1_v1p0.xsd";

/** The `cc_profile` of each kind of question the profile holds. */
export const CC_PROFILES = {
  multipleChoice: "cc.multiple_choice.v0p1",
  multipleResponse: "cc.multiple_response.v0p1",
  trueFalse: "cc.true_false.v0p1",
  fillInBlank: "cc.fib.v0p1",
  essay: "cc.essay.v0p1",
  exam: "cc.exam.v0p1",
} as const;

interface Planned {
  item: ReportItem;
  xml?: string;
}

const field = (label: string, entry: string): string => `<qtimetadatafield><fieldlabel>${label}</fieldlabel><fieldentry>${entry}</fieldentry></qtimetadatafield>`;

function plan(question: Question, position: number): Planned {
  const base = { position, questionId: question.id, title: question.title };
  const leftOut = (why: string): Planned => ({ item: { ...base, outcome: "leftOut", notes: [why] } });

  const supported = isChoice(question) || isMultipleResponse(question) || isTrueFalse(question) || isFillInBlank(question) || isShortAnswer(question) || question.type === "essay";
  if (!supported) {
    const name = TYPE_NAMES[question.type];
    const where =
      question.type === "matching"
        ? " The QTI 1.2 package and Brightspace's CSV carry matching questions."
        : question.type === "ordering"
          ? " Brightspace's CSV carries ordering questions."
          : "";
    return leftOut(`Common Cartridge's QTI profile has no ${name} question, so ${/^[aeiou]/.test(name) ? "an" : "a"} ${name} question cannot be written in it.${where}`);
  }
  if (!hasUsableKey(question)) return leftOut(keyProblem(question, "the destination"));

  const losses = newLosses();
  const notes: string[] = [];
  let asType: string | undefined;

  const mat = (text: RichText): string => {
    if (needsMarkup(text)) return `<material><mattext texttype="text/html">${escapeXml(htmlText(text, question, losses).replace(/(?<!\s)\s*\n\s*/g, " "))}</mattext></material>`;
    return `<material><mattext texttype="text/plain">${escapeXml(flat(plainText(text, question, losses, false)))}</mattext></material>`;
  };
  const words = (text: RichText): boolean => (needsMarkup(text) ? hasText(text) : flat(plainText(text, question, newLosses(), false)) !== "");

  if (plainText(question.stem, question, newLosses(), true) === "") return leftOut("It has no question text once it is written as plain text.");
  const stem = `<material><mattext texttype="text/html">${escapeXml(htmlText(question.stem, question, losses).replace(/(?<!\s)\s*\n\s*/g, " "))}</mattext></material>`;

  const n = position;
  const respident = `q${n}_resp`;
  // Common Cartridge fixes the score of a right answer at 100; what the question is worth is its weighting.
  const win = `<setvar action="Set" varname="SCORE">100</setvar>`;
  const labelId = (i: number): string => `q${n}_a${i + 1}`;

  let profile: string;
  let response: string;
  let conditions: string;

  if (isChoice(question) || isMultipleResponse(question)) {
    const options = question.body.options;
    if (options.length < 2) return leftOut("It has fewer than two answers.");
    if (options.some((o) => !words(o.content))) return leftOut("One of its answers has no text, and the destination needs text in every answer.");
    const multiple = isMultipleResponse(question);
    profile = multiple ? CC_PROFILES.multipleResponse : CC_PROFILES.multipleChoice;
    const fixed = options.filter((o) => o.fixedPosition).length;
    const shuffle = question.body.shuffle && fixed === 0;
    if (question.body.shuffle && fixed > 0 && fixed < options.length) {
      notes.push("Some answers of this question are fixed in place and others are mixed. The file cannot say which, so all of them stay in the order written.");
    }
    const labels = options.map((o, i) => `<response_label ident="${labelId(i)}">${mat(o.content)}</response_label>`).join("");
    response = `<response_lid ident="${respident}" rcardinality="${multiple ? "Multiple" : "Single"}"><render_choice shuffle="${shuffle ? "Yes" : "No"}">${labels}</render_choice></response_lid>`;
    if (multiple) {
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
    profile = CC_PROFILES.trueFalse;
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
        return leftOut(`It has ${question.body.blanks.length} blanks, and this file writes one answer box to a question.`);
      }
      accepted = (question.body.blanks[0] as { accepted: string[] }).accepted;
      caseSensitive = question.body.caseSensitive;
      notes.push("A fill in the blank arrives with one answer box under its text, because the file cannot say where in the text the blank is. The text still has the blank in it.");
    } else {
      accepted = question.body.accepted;
      caseSensitive = question.body.caseSensitive;
      asType = "fill in the blank";
      notes.push("Common Cartridge's only typed-answer question is its fill in the blank, so a short answer is written as one. What Brightspace makes of it is Brightspace's to say.");
    }
    const cleaned = [...new Set(accepted.map(flat).filter((a) => a !== ""))];
    if (cleaned.length === 0) return leftOut("It has no accepted answer, and nothing is guessed.");
    profile = CC_PROFILES.fillInBlank;
    response = `<response_str ident="${respident}" rcardinality="Single"><render_fib fibtype="String" prompt="Box" /></response_str>`;
    conditions = cleaned
      .map((a) => `<respcondition continue="No"><conditionvar><varequal respident="${respident}" case="${caseSensitive ? "Yes" : "No"}">${escapeXml(a)}</varequal></conditionvar>${win}</respcondition>`)
      .join("");
  } else {
    // An essay is a written response, marked by hand: it has an answer box and no condition to meet.
    profile = CC_PROFILES.essay;
    response = `<response_str ident="${respident}" rcardinality="Single"><render_fib fibtype="String" prompt="Box" rows="15" columns="60" /></response_str>`;
    conditions = "";
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
    `<itemmetadata><qtimetadata>${field("cc_profile", profile)}${field("cc_weighting", num(question.points))}</qtimetadata></itemmetadata>` +
    `<presentation>${stem}${response}</presentation>` +
    `<resprocessing><outcomes><decvar minvalue="0" maxvalue="100" varname="SCORE" vartype="Decimal" /></outcomes>${conditions}</resprocessing>` +
    `</item>`;

  return { item: { ...base, outcome: notes.length > 0 ? "exportedWithLosses" : "exported", ...(asType ? { asType } : {}), notes }, xml };
}

export interface CommonCartridgeOptions {
  /** What to call the quiz and the file. Usually the bank's title. */
  name?: string;
}

/** The destination check on its own: what would arrive, what would be lost, what cannot go. */
export function checkCommonCartridge(questions: readonly Question[], options: CommonCartridgeOptions = {}): ExportResult["report"] {
  return exportCommonCartridge(questions, options).report;
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

export function exportCommonCartridge(questions: readonly Question[], options: CommonCartridgeOptions = {}): ExportResult {
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
  // Common Cartridge asks for a number of attempts, and attempts belong to the course and not to the questions, so the quiz is
  // made with no limit and the person sets it in Brightspace.
  const assessment =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<questestinterop xmlns="${QTI_NAMESPACE}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${QTI_NAMESPACE} ${QTI_SCHEMA}">\n` +
    `<assessment ident="assessment1" title="${title}">\n` +
    `<qtimetadata>${field("cc_profile", CC_PROFILES.exam)}${field("qmd_assessmenttype", "Examination")}${field("cc_maxattempts", "unlimited")}</qtimetadata>\n` +
    `<section ident="section1">\n` +
    written.join("\n") +
    `\n</section>\n</assessment>\n</questestinterop>\n`;
  const manifest =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<manifest identifier="manifest1" xmlns="${CP_NAMESPACE}" xmlns:lomr="${LOM_RESOURCE}" xmlns:lomimscc="${LOM_MANIFEST}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="${MANIFEST_SCHEMAS}">\n` +
    `<metadata><schema>IMS Common Cartridge</schema><schemaversion>1.3.0</schemaversion>` +
    `<lomimscc:lom><lomimscc:general><lomimscc:title><lomimscc:string language="en">${title}</lomimscc:string></lomimscc:title></lomimscc:general></lomimscc:lom></metadata>\n` +
    `<organizations>\n<organization identifier="org_1" structure="rooted-hierarchy">\n<item identifier="root">\n` +
    `<item identifier="item_1" identifierref="resource_1"><title>${title}</title></item>\n` +
    `</item>\n</organization>\n</organizations>\n` +
    `<resources>\n<resource identifier="resource_1" type="${CC_ASSESSMENT_TYPE}" href="${CC_ASSESSMENT_FILE}"><file href="${CC_ASSESSMENT_FILE}"/></resource>\n</resources>\n` +
    `</manifest>\n`;

  const file = `${base} - Common Cartridge.imscc`;
  const bytes = written.length > 0 ? zipSync([textEntry("imsmanifest.xml", manifest), textEntry(CC_ASSESSMENT_FILE, assessment)]) : undefined;

  const general = [
    "In Brightspace: Course tools, Import/Export/Copy Components, Import Components, from a course package, Start. Drag in the .imscc file and choose Import All Components. The quiz arrives in Quizzes, and a topic for it arrives in Content. Importing twice makes two.",
    "The quiz is made with unlimited attempts, because the format asks for a number and attempts belong to the course. Set attempts and the other quiz settings in Brightspace.",
    "Common Cartridge's QTI profile holds multiple choice, multiple answer, true or false, fill in the blank and essay questions and no others. Matching goes in the QTI 1.2 package or Brightspace's CSV, and ordering in the CSV.",
    "Canvas reads Common Cartridge packages too (Import Course Content, content type Common Cartridge 1.x Package). That has not been tried.",
    "Difficulty, tags, objectives and history are not part of the file. Images are not carried.",
  ];
  const report = buildReport(COMMON_CARTRIDGE_ID, COMMON_CARTRIDGE_LABEL, questions.length, items, bytes ? [file] : [], general);
  return { files: bytes ? [{ name: file, content: "", bytes, questions: written.length }] : [], report };
}
