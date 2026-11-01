/**
 * Export to Blackboard: the "Upload questions" text file.
 *
 * Blackboard documents this file, and this follows what it documents and no more. It is a tab-delimited text file with one
 * question to a row and no header row. The first field is the type (MC, MA, TF, ESS, MAT, FIB or ORD), the second is the
 * question text, and the rest depend on the type: an answer and the word correct or incorrect for each option of a multiple
 * choice or multiple answer question, true or false for a true or false one, each pair of a matching question as a left side
 * then a right side, each accepted answer of a fill in the blank, and each item of an ordering in the right order. The words
 * correct, incorrect, true and false are English whatever the language of the course.
 *
 * What the file cannot hold is the whole of the destination check. It has no points (they are one number typed at upload, for
 * every question), no feedback, no formatting, no picture, and no setting for the order of the answers. It has no numeric
 * question whose tolerance is explained, so a numeric question is left out rather than written with a guess at what its
 * tolerance would mean. A short answer is written as a fill in the blank, because that is the Blackboard question that checks
 * a typed answer against a list of accepted ones; Blackboard's own short answer is marked by hand.
 *
 * A question with no usable answer key is never written, and no key is ever guessed to fit.
 */

import { hasUsableKey } from "../quality/answer-key.ts";
import { isChoice, isFillInBlank, isMultipleResponse, isOrdering, isShortAnswer, isTrueFalse, type Question } from "../model/question.ts";
import type { ExportResult, ReportItem } from "./types.ts";
import { buildReport, hasText, keyProblem, lossNotes, newLosses, plainText, plural, safeName, TYPE_NAMES } from "./text.ts";

export const BLACKBOARD_UPLOAD_ID = "blackboard-upload";
export const BLACKBOARD_UPLOAD_LABEL = "Blackboard, Upload questions (text file)";

/** Blackboard takes at most 100 answers to a question. */
const MAX_ANSWERS = 100;

/**
 * Blackboard recommends no more than 250 questions in a file in Ultra, and 500 in Original, because a browser can time out
 * on more. The smaller number is used so that one file works in both.
 */
const FILE_SIZE = 250;

/** Whitespace of any kind, a tab and a line break included, as one space. A tab or a line break inside a field would end it. */
const flat = (text: string): string => text.replace(/\s+/g, " ").trim();

interface Planned {
  item: ReportItem;
  fields?: string[];
}

function plan(question: Question, position: number): Planned {
  const base = { position, questionId: question.id, title: question.title };
  const leftOut = (why: string): Planned => ({ item: { ...base, outcome: "leftOut", notes: [why] } });

  const supported =
    isChoice(question) ||
    isMultipleResponse(question) ||
    isTrueFalse(question) ||
    isFillInBlank(question) ||
    isShortAnswer(question) ||
    isOrdering(question) ||
    question.type === "matching" ||
    question.type === "essay";
  if (!supported) {
    const name = TYPE_NAMES[question.type];
    const why =
      question.type === "numeric"
        ? "Blackboard's upload file takes a numeric question with a tolerance, and does not say what the tolerance means, so it is not written in it rather than guessed."
        : `Blackboard's upload file has no ${name} question, so ${/^[aeiou]/.test(name) ? "an" : "a"} ${name} question cannot be written in it.`;
    return leftOut(why);
  }
  if (!hasUsableKey(question)) return leftOut(keyProblem(question, "Blackboard"));

  const losses = newLosses();
  const notes: string[] = [];
  let asType: string | undefined;

  const text = (value: Parameters<typeof plainText>[0]): string => flat(plainText(value, question, losses, false));
  const stem = text(question.stem);
  if (stem === "") return leftOut("It has no question text once it is written as plain text.");

  let fields: string[];
  if (isChoice(question) || isMultipleResponse(question)) {
    const options = question.body.options;
    const texts = options.map((o) => text(o.content));
    if (texts.some((t) => t === "")) return leftOut("One of its answers has no text, and Blackboard needs text in every answer.");
    if (options.length < 2) return leftOut("It has fewer than two answers.");
    if (options.length > MAX_ANSWERS) return leftOut(`It has ${options.length} answers, and Blackboard takes at most ${MAX_ANSWERS}.`);
    fields = [isMultipleResponse(question) ? "MA" : "MC", stem];
    options.forEach((o, i) => fields.push(texts[i] as string, o.correct ? "correct" : "incorrect"));
    if (isMultipleResponse(question) && question.body.partialCredit) {
      notes.push("Partial credit cannot be carried: the file has no setting for it. Blackboard's own setting for a multiple answer question applies.");
    }
    if (!question.body.shuffle || options.some((o) => o.fixedPosition)) {
      notes.push("This question keeps its answers in a fixed order, and the file cannot say so. Blackboard's own setting for mixing the answers applies.");
    }
  } else if (isTrueFalse(question)) {
    if (typeof question.body.correct !== "boolean") return leftOut("Neither True nor False is marked, and nothing is guessed.");
    fields = ["TF", stem, question.body.correct ? "true" : "false"];
  } else if (isFillInBlank(question) || isShortAnswer(question)) {
    let accepted: string[];
    let caseSensitive: boolean;
    if (isFillInBlank(question)) {
      if (question.body.blanks.length !== 1) {
        return leftOut(`It has ${question.body.blanks.length} blanks, and this file is written with one blank to a question: Blackboard's file for several needs the blanks named in the text, which is not done here.`);
      }
      accepted = (question.body.blanks[0] as { accepted: string[] }).accepted;
      caseSensitive = question.body.caseSensitive;
    } else {
      accepted = question.body.accepted;
      caseSensitive = question.body.caseSensitive;
      asType = "fill in the blank";
      notes.push("A short answer is written as Blackboard's fill in the blank, because that is the question it checks a typed answer against a list of accepted answers for. Blackboard's own short answer is marked by hand.");
    }
    const cleaned = [...new Set(accepted.map(flat).filter((a) => a !== ""))];
    if (cleaned.length === 0) return leftOut("It has no accepted answer, and nothing is guessed.");
    if (cleaned.length > MAX_ANSWERS) return leftOut(`It has ${cleaned.length} accepted answers, and Blackboard takes at most ${MAX_ANSWERS}.`);
    fields = ["FIB", stem, ...cleaned];
    if (caseSensitive) notes.push("Upper and lower case count in this question, and the file cannot say so. Blackboard's own setting for a fill in the blank applies.");
  } else if (isOrdering(question)) {
    const items = [...question.body.items].sort((a, b) => a.position - b.position);
    const texts = items.map((it) => text(it.content));
    if (texts.some((t) => t === "")) return leftOut("One of its items has no text, and nothing is guessed to fill it.");
    if (items.length < 2) return leftOut("It has fewer than two items to put in order.");
    if (items.length > MAX_ANSWERS) return leftOut(`It has ${items.length} items, and Blackboard takes at most ${MAX_ANSWERS}.`);
    // The order written is the right order; Blackboard mixes them when the student sees the question.
    fields = ["ORD", stem, ...texts];
    notes.push("Blackboard's help lists an ordering question for the Original course view and does not list it for Ultra, so an Ultra course may refuse this row. The other rows still upload.");
  } else if (question.type === "matching") {
    const body = question.body as { pairs: Array<{ left: Parameters<typeof plainText>[0]; right: string }>; distractors?: string[] };
    if (body.pairs.length < 2) return leftOut(`It has ${body.pairs.length} pair${body.pairs.length === 1 ? "" : "s"}, and a matching question needs at least two.`);
    if (body.pairs.length > MAX_ANSWERS) return leftOut(`It has ${body.pairs.length} pairs, and Blackboard takes at most ${MAX_ANSWERS}.`);
    const pairs = body.pairs.map((p) => ({ left: text(p.left), right: flat(p.right) }));
    if (pairs.some((p) => p.left === "" || p.right === "")) return leftOut("One of its pairs has nothing on one side, and nothing is guessed to fill it.");
    fields = ["MAT", stem];
    for (const p of pairs) fields.push(p.left, p.right);
    const spare = (body.distractors ?? []).filter((d) => d.trim() !== "").length;
    if (spare > 0) notes.push(`${plural(spare, "spare answer", "spare answers")} cannot be carried: a match in the file belongs to a choice, and a spare one belongs to none. The question is easier without ${spare === 1 ? "it" : "them"}.`);
    const rights = pairs.map((p) => p.right.toLowerCase());
    if (new Set(rights).size < rights.length) {
      notes.push("Two pairs have the same match. Blackboard warns that a right answer may be marked wrong when more than one answer has the same value.");
    }
  } else {
    // An essay. Blackboard's file has an optional field for a sample answer, and a model answer fits it.
    fields = ["ESS", stem];
    const body = question.body as { modelAnswer?: Parameters<typeof plainText>[0]; rubric?: unknown[]; expectedWords?: number };
    if (body.modelAnswer && hasText(body.modelAnswer)) fields.push(text(body.modelAnswer));
    if ((body.rubric ?? []).length > 0) notes.push("The rubric cannot be carried: a Blackboard rubric is made in Blackboard.");
    if (typeof body.expectedWords === "number") notes.push("The expected length cannot be carried.");
  }

  if (question.points !== 1) {
    notes.push(`Its ${question.points} point${question.points === 1 ? "" : "s"} cannot be carried: Blackboard gives every question in an upload the same points, the number typed when you upload.`);
  }
  const hasFeedback =
    [question.feedback.general, question.feedback.correct, question.feedback.incorrect].some((f) => f && hasText(f)) ||
    (isChoice(question) || isMultipleResponse(question) ? question.body.options.some((o) => o.feedback && hasText(o.feedback)) : false);
  if (hasFeedback) notes.push("Feedback cannot be carried: the file has no place for it.");

  if (losses.formatting) notes.push("Bold, italics, lists or tables became plain text.");
  if (losses.breaks) notes.push("Paragraph breaks became spaces.");
  notes.push(...lossNotes(losses, "Blackboard"));

  return { item: { ...base, outcome: notes.length > 0 ? "exportedWithLosses" : "exported", ...(asType ? { asType } : {}), notes }, fields };
}

export interface BlackboardUploadOptions {
  /** What to call the file. Usually the bank's title. */
  name?: string;
}

/** The destination check on its own: what would arrive, what would be lost, what cannot go. */
export function checkBlackboardUpload(questions: readonly Question[], options: BlackboardUploadOptions = {}): ExportResult["report"] {
  return exportBlackboardUpload(questions, options).report;
}

/** The destination check, and the file or files to write. */
export function exportBlackboardUpload(questions: readonly Question[], options: BlackboardUploadOptions = {}): ExportResult {
  const items: ReportItem[] = [];
  const rows: string[][] = [];
  questions.forEach((question, i) => {
    const planned = plan(question, i + 1);
    items.push(planned.item);
    if (planned.fields) rows.push(planned.fields);
  });

  // A file for every 250 questions, each named for its place, so a long bank does not time out the browser. One file keeps the plain name.
  const groups: string[][][] = [];
  for (let at = 0; at < rows.length; at += FILE_SIZE) groups.push(rows.slice(at, at + FILE_SIZE));
  const base = safeName(options.name);
  const files = groups.map((group, i) => ({
    name: groups.length === 1 ? `${base} - Blackboard.txt` : `${base} - Blackboard ${i + 1}.txt`,
    // Tab between fields and a line break between rows, with no header row and no blank line, which Blackboard names as an error.
    // UTF-8 with no byte order mark. The file's encoding is not stated by Blackboard.
    content: group.map((fields) => fields.join("\t")).join("\r\n") + "\r\n",
    questions: group.length,
  }));

  const general = [
    "In Blackboard: from the test, Ultra: the plus sign, then Upload questions from file. Original: Upload Questions. Choose the file and submit. Set the points per question first (the default point value in Ultra, the Points per question box in Original), or every question arrives worth zero.",
    "Blackboard's upload takes multiple choice, multiple answer, true or false, fill in the blank, matching, ordering and essay questions. Questions with an error fail to upload and the rest still do.",
    "Difficulty, tags, objectives and history are not part of the file. Images are not carried.",
    ...(files.length > 1 ? [`There are ${files.length} files, because Blackboard recommends no more than ${FILE_SIZE} questions in one. Upload them one after another.`] : []),
  ];
  return { files, report: buildReport(BLACKBOARD_UPLOAD_ID, BLACKBOARD_UPLOAD_LABEL, questions.length, items, files.map((f) => f.name), general) };
}
