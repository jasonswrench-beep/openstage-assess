/**
 * Export as a QTI 1.2 package. The rules under test are the ones every exporter keeps (a question whose key is missing is never
 * written and no key is guessed, nothing is lost without being said against the question, what cannot be written is left out and
 * why) and the ones this format has: a zip with a manifest that names the one resource, and a questestinterop file whose items
 * are built the way QTI 1.2 describes.
 *
 * Two readers written apart from the exporter stand behind these tests. `specProblems` reads a package against the structure of
 * QTI 1.2 and the IMS content packaging rules: the manifest, the nesting of assessment, section and item, the response and the
 * labels the conditions refer to, and the kinds Canvas reads from the metadata. `grade` is a small QTI 1.2 response processor,
 * which takes the answers a student could give and works out the score the way the standard says conditions are evaluated: in
 * order, stopping at the first that is met unless one says to continue. A question is right when exactly its key scores its
 * points and nothing else does. Neither can say that Brightspace or Canvas will accept the package: only they can, and that is a
 * check for a person with a course (TESTING-TODO.md).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { unzipSync } from "../src/container/zip.ts";
import { checkQti12, exportQti12, QTI12_ID } from "../src/export/qti12.ts";
import { importerForContent, runImporter } from "../src/import/registry.ts";
import { allText, elements, first, parseXml, type XmlElement } from "../src/import/docx/xml.ts";
import { createQuestion } from "../src/model/create.ts";
import { plainToRich, rich, richTextToPlain } from "../src/model/richtext.ts";
import type { Question, QuestionBody, QuestionType } from "../src/model/question.ts";

const AT = "2026-01-01T00:00:00.000Z";
const opt = (id: string, text: string, correct = false, feedback?: string) => ({ id, content: plainToRich(text), correct, ...(feedback ? { feedback: plainToRich(feedback) } : {}) });
let made = 0;
const make = (type: QuestionType, body: QuestionBody, stem: string, extra: Partial<Parameters<typeof createQuestion>[0]> = {}): Question =>
  createQuestion({ type, stem: stem.startsWith("<") ? rich(stem) : plainToRich(stem), body, by: "t", at: AT, id: `q_${String(++made).padStart(26, "0")}`, ...extra });

const MC = make("multipleChoice", { shuffle: true, options: [opt("o1", "Berlin"), opt("o2", "Paris", true), opt("o3", "Rome")] }, "What is the capital of France?");
const MA = make("multipleResponse", { shuffle: true, partialCredit: false, options: [opt("o1", "Red", true), opt("o2", "Green"), opt("o3", "Blue", true), opt("o4", "Pink")] }, "Which are primary colours?");
const TF = make("trueFalse", { correct: false }, "A light-year is a measure of time.");
const SA = make("shortAnswer", { caseSensitive: false, accepted: ["Paris", "paris, france", "Paris"] }, "What is the capital of France?");
const FIB = make("fillInBlank", { caseSensitive: true, blanks: [{ id: "b1", accepted: ["Quartz"] }] }, "___ is the hardest common mineral.");
const MAT = make("matching", { shuffle: true, distractors: [], pairs: [{ id: "p1", left: plainToRich("Dog"), right: "Bark" }, { id: "p2", left: plainToRich("Cat"), right: "Meow" }, { id: "p3", left: plainToRich("Cow"), right: "Moo" }] }, "Match the animal to its sound.");
const ESS = make("essay", {}, "Discuss.");

// ---------------------------------------------------------------------------
// Reading a package
// ---------------------------------------------------------------------------

interface Pack {
  files: Map<string, Uint8Array>;
  manifest: XmlElement;
  doc: XmlElement;
  text: (name: string) => string;
}

function unpack(questions: Question[], name = "Test"): Pack {
  const result = exportQti12(questions, { name });
  const file = result.files[0];
  assert.ok(file?.bytes, "a package has bytes");
  const files = unzipSync(file.bytes);
  const text = (n: string): string => Buffer.from(files.get(n) ?? new Uint8Array()).toString("utf8");
  return { files, manifest: parseXml(text("imsmanifest.xml")), doc: parseXml(text("assessment.xml")), text };
}

const descend = (el: XmlElement, name: string): XmlElement[] => {
  const found: XmlElement[] = [];
  const walk = (e: XmlElement): void => {
    for (const c of elements(e)) {
      if (c.name === name) found.push(c);
      walk(c);
    }
  };
  walk(el);
  return found;
};
const itemsOf = (pack: Pack): XmlElement[] => descend(pack.doc, "item");
const attr = (el: XmlElement, name: string): string => el.attrs[name] ?? "";
const itemOf = (question: Question) => checkQti12([question]).items[0] as NonNullable<ReturnType<typeof checkQti12>["items"][0]>;

/** The text of a mattext, as a person reads it: html with its tags taken out. */
function mattext(el: XmlElement): { type: string; text: string; raw: string } {
  const m = descend(el, "mattext")[0] as XmlElement;
  const raw = allText(m);
  const type = attr(m, "texttype");
  return { type, raw, text: type === "text/html" ? raw.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim() : raw };
}

const KINDS = ["multiple_choice_question", "multiple_answers_question", "true_false_question", "short_answer_question", "matching_question", "essay_question"];
const NCNAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** What the standard and the packaging rules say is wrong with a package, which is nothing for one that follows them. */
function specProblems(pack: Pack): string[] {
  const problems: string[] = [];

  // The package: a manifest at the root, naming a resource that is in the zip.
  if (pack.manifest.name !== "manifest") problems.push(`the manifest's root is ${pack.manifest.name}`);
  if (!attr(pack.manifest, "identifier")) problems.push("the manifest has no identifier");
  const resources = descend(pack.manifest, "resource");
  if (resources.length !== 1) problems.push(`the manifest names ${resources.length} resources, not one`);
  for (const r of resources) {
    if (attr(r, "type") !== "imsqti_xmlv1p2") problems.push(`the resource's type is ${attr(r, "type")}`);
    if (!pack.files.has(attr(r, "href"))) problems.push(`the resource's href ${attr(r, "href")} is not in the zip`);
    const listed = descend(r, "file").map((f) => attr(f, "href"));
    if (!listed.includes(attr(r, "href"))) problems.push("the resource does not list its file");
    for (const f of listed) if (!pack.files.has(f)) problems.push(`the listed file ${f} is not in the zip`);
    if (!attr(r, "identifier")) problems.push("the resource has no identifier");
  }
  for (const name of pack.files.keys()) {
    if (name.startsWith("/") || name.includes("..") || name.includes("\\")) problems.push(`the entry name ${name} is not a plain relative path`);
  }
  if (!pack.files.has("imsmanifest.xml")) problems.push("there is no imsmanifest.xml at the root");

  // The questions: questestinterop, one assessment, a section, and items.
  if (pack.doc.name !== "questestinterop") problems.push(`the root is ${pack.doc.name}, not questestinterop`);
  const assessments = elements(pack.doc, "assessment");
  if (assessments.length !== 1) return [...problems, `${assessments.length} assessments, not one`];
  const assessment = assessments[0] as XmlElement;
  if (!attr(assessment, "ident") || !NCNAME.test(attr(assessment, "ident"))) problems.push("the assessment has no valid ident");
  if (!attr(assessment, "title")) problems.push("the assessment has no title");
  const sections = elements(assessment, "section");
  if (sections.length < 1) return [...problems, "no section in the assessment, which is what a Brightspace import reports as no quizzes or sections"];
  const idents = new Set<string>();
  for (const s of sections) {
    if (!attr(s, "ident") || !NCNAME.test(attr(s, "ident"))) problems.push("a section has no valid ident");
    for (const item of elements(s, "item")) problems.push(...itemProblems(item, idents));
  }
  if (descend(pack.doc, "item").length !== sections.reduce((n, s) => n + elements(s, "item").length, 0)) problems.push("an item is outside a section");
  return problems;
}

function itemProblems(item: XmlElement, idents: Set<string>): string[] {
  const problems: string[] = [];
  const id = attr(item, "ident");
  const where = `item ${id}`;
  if (!NCNAME.test(id)) problems.push(`${where}: not a valid ident`);
  if (idents.has(id)) problems.push(`${where}: ident used twice`);
  idents.add(id);
  if (attr(item, "title") === "") problems.push(`${where}: no title`);

  const fields = new Map(descend(item, "qtimetadatafield").map((f) => [allText(first(f, "fieldlabel") as XmlElement), allText(first(f, "fieldentry") as XmlElement)] as const));
  const kind = fields.get("question_type") ?? "";
  if (!KINDS.includes(kind)) problems.push(`${where}: question_type ${kind} is not one Canvas reads`);
  const points = Number(fields.get("points_possible"));
  if (!(points > 0)) problems.push(`${where}: points_possible is not a number above zero`);

  const presentation = first(item, "presentation");
  if (!presentation) return [...problems, `${where}: no presentation`];
  const lead = first(presentation, "material");
  if (!lead || !first(lead, "mattext") || allText(first(lead, "mattext") as XmlElement).trim() === "") problems.push(`${where}: the presentation does not begin with the question text`);
  for (const m of descend(presentation, "mattext")) if (!["text/plain", "text/html"].includes(attr(m, "texttype"))) problems.push(`${where}: texttype ${attr(m, "texttype")}`);

  const lids = elements(presentation, "response_lid");
  const strs = elements(presentation, "response_str");
  const responses = [...lids, ...strs];
  const respidents = new Set(responses.map((r) => attr(r, "ident")));
  if (responses.length === 0 || respidents.size !== responses.length) problems.push(`${where}: each response needs its own ident`);
  const labels = new Map<string, Set<string>>();
  for (const l of lids) {
    const choice = first(l, "render_choice");
    if (!choice) {
      problems.push(`${where}: a response_lid with no render_choice`);
      continue;
    }
    const ls = elements(choice, "response_label");
    if (ls.length < 2) problems.push(`${where}: fewer than two labels`);
    const set = new Set(ls.map((x) => attr(x, "ident")));
    if (set.size !== ls.length || [...set].some((x) => !NCNAME.test(x))) problems.push(`${where}: label idents are not unique valid idents`);
    for (const x of ls) if (!first(x, "material")) problems.push(`${where}: a label with no material`);
    labels.set(attr(l, "ident"), set);
    if (!["Single", "Multiple", ""].includes(attr(l, "rcardinality"))) problems.push(`${where}: rcardinality ${attr(l, "rcardinality")}`);
  }
  for (const s of strs) if (!first(s, "render_fib")) problems.push(`${where}: a response_str with no render_fib`);

  // The kind says what the structure has to be.
  if (kind === "multiple_choice_question" || kind === "true_false_question") {
    if (lids.length !== 1 || attr(lids[0] as XmlElement, "rcardinality") !== "Single") problems.push(`${where}: ${kind} is one Single response_lid`);
    if (kind === "true_false_question" && (labels.get(attr(lids[0] as XmlElement, "ident"))?.size ?? 0) !== 2) problems.push(`${where}: true or false has two labels`);
  }
  if (kind === "multiple_answers_question" && (lids.length !== 1 || attr(lids[0] as XmlElement, "rcardinality") !== "Multiple")) problems.push(`${where}: multiple answers is one Multiple response_lid`);
  if (kind === "matching_question" && (lids.length < 2 || strs.length > 0)) problems.push(`${where}: matching is a response_lid for each left side`);
  if ((kind === "short_answer_question" || kind === "essay_question") && (strs.length !== 1 || lids.length > 0)) problems.push(`${where}: ${kind} is one response_str`);

  const processing = first(item, "resprocessing");
  if (!processing) return [...problems, `${where}: no resprocessing`];
  const decvar = descend(processing, "decvar")[0];
  if (!decvar || attr(decvar, "varname") !== "SCORE") problems.push(`${where}: no SCORE decvar`);
  else if (Number(attr(decvar, "maxvalue")) !== points) problems.push(`${where}: SCORE's maxvalue is not the points`);
  for (const v of descend(processing, "varequal")) {
    const ref = attr(v, "respident");
    if (!respidents.has(ref)) problems.push(`${where}: a condition refers to ${ref}, which is not a response`);
    const set = labels.get(ref);
    if (set && !set.has(allText(v).trim())) problems.push(`${where}: a condition refers to the label ${allText(v)}, which ${ref} does not offer`);
  }
  for (const c of descend(processing, "respcondition")) {
    if (!["Yes", "No", ""].includes(attr(c, "continue"))) problems.push(`${where}: continue ${attr(c, "continue")}`);
    if (!first(c, "conditionvar")) problems.push(`${where}: a respcondition with no conditionvar`);
    for (const sv of elements(c, "setvar")) if (!["Set", "Add"].includes(attr(sv, "action")) || attr(sv, "varname") !== "SCORE" || Number.isNaN(Number(allText(sv)))) problems.push(`${where}: a setvar that is not a Set or Add of a number to SCORE`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// A QTI 1.2 response processor, for the answers a student could give
// ---------------------------------------------------------------------------

/** What a student chose: for a response_lid the labels, for a response_str the typed words. */
type Answers = Record<string, string[]>;

function holds(node: XmlElement, answers: Answers): boolean {
  switch (node.name) {
    case "varequal": {
      const given = answers[attr(node, "respident")] ?? [];
      const want = allText(node).trim();
      if (attr(node, "case") === "Yes") return given.includes(want);
      return given.some((g) => g.trim().toLowerCase() === want.toLowerCase());
    }
    case "and":
      return elements(node).every((c) => holds(c, answers));
    case "or":
      return elements(node).some((c) => holds(c, answers));
    case "not":
      return !holds(elements(node)[0] as XmlElement, answers);
    case "other":
      return true;
    default:
      throw new Error(`a condition this grader does not know: ${node.name}`);
  }
}

/** The score of a set of answers: conditions in order, stopping at the first met unless it says to continue. */
function grade(item: XmlElement, answers: Answers): number {
  const processing = first(item, "resprocessing") as XmlElement;
  let score = Number(attr(descend(processing, "decvar")[0] as XmlElement, "defaultval") || 0);
  for (const c of elements(processing, "respcondition")) {
    if (!elements(first(c, "conditionvar") as XmlElement).every((n) => holds(n, answers))) continue;
    for (const sv of elements(c, "setvar")) score = attr(sv, "action") === "Add" ? score + Number(allText(sv)) : Number(allText(sv));
    if (attr(c, "continue") !== "Yes") break;
  }
  return Math.round(score * 100000) / 100000;
}

const pointsOf = (item: XmlElement): number => Number(attr(descend(item, "decvar")[0] as XmlElement, "maxvalue"));
const labelsOf = (item: XmlElement, respident?: string): Array<{ ident: string; text: string }> => {
  const lid = elements(first(item, "presentation") as XmlElement, "response_lid").find((l) => respident === undefined || attr(l, "ident") === respident) as XmlElement;
  return elements(first(lid, "render_choice") as XmlElement, "response_label").map((l) => ({ ident: attr(l, "ident"), text: mattext(l).text }));
};
const subsets = <T,>(xs: T[]): T[][] => xs.reduce<T[][]>((acc, x) => acc.concat(acc.map((s) => [...s, x])), [[]]);

describe("the package", () => {
  test("is a zip with a manifest at the root that names one resource, and the file it names", () => {
    const pack = unpack([MC]);
    assert.deepEqual([...pack.files.keys()].sort(), ["assessment.xml", "imsmanifest.xml"]);
    assert.deepEqual(specProblems(pack), []);
    const resource = descend(pack.manifest, "resource")[0] as XmlElement;
    assert.equal(attr(resource, "type"), "imsqti_xmlv1p2");
    assert.equal(attr(resource, "href"), "assessment.xml");
  });

  test("has an assessment with the bank's name, one section, and an item for each question written", () => {
    const pack = unpack([MC, TF, make("numeric", { mode: "exact", value: 1 }, "Number?"), SA], 'Week 1: "Planets" & <more>');
    assert.equal(attr(elements(pack.doc, "assessment")[0] as XmlElement, "title"), 'Week 1: "Planets" & <more>');
    assert.equal(descend(pack.doc, "section").length, 1);
    assert.deepEqual(itemsOf(pack).map((i) => attr(i, "ident")), ["q1", "q2", "q4"], "an item keeps its place in the bank, so a question left out leaves a gap");
  });

  test("is written as UTF-8 XML with a declaration", () => {
    const pack = unpack([make("multipleChoice", { shuffle: true, options: [opt("o1", "Café", true), opt("o2", "Théâtre")] }, "Où est le café?")]);
    assert.ok(pack.text("assessment.xml").startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(pack.text("imsmanifest.xml").startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.match(pack.text("assessment.xml"), /Où est le café\?/);
    assert.equal(mattext(itemsOf(pack)[0] as XmlElement).text, "Où est le café?");
  });
});

describe("how each question is scored (read back by a QTI response processor)", () => {
  test("a multiple choice question is worth its points for the right label and nothing for any other", () => {
    const item = itemsOf(unpack([MC]))[0] as XmlElement;
    const labels = labelsOf(item);
    assert.deepEqual(labels.map((l) => l.text), ["Berlin", "Paris", "Rome"]);
    for (const l of labels) assert.equal(grade(item, { response1: [l.ident] }), l.text === "Paris" ? 1 : 0, l.text);
    assert.equal(grade(item, { response1: [] }), 0, "no answer");
  });

  test("a multiple answer question scores only for exactly the right set, and for no other set", () => {
    const item = itemsOf(unpack([MA]))[0] as XmlElement;
    const labels = labelsOf(item);
    const right = new Set(["Red", "Blue"]);
    for (const chosen of subsets(labels)) {
      const exact = chosen.length === right.size && chosen.every((l) => right.has(l.text));
      assert.equal(grade(item, { response1: chosen.map((l) => l.ident) }), exact ? 1 : 0, chosen.map((l) => l.text).join("+") || "nothing");
    }
    assert.match(attr(descend(item, "response_lid")[0] as XmlElement, "rcardinality"), /Multiple/);
  });

  test("a true or false question has the labels True and False and scores the right one", () => {
    for (const correct of [true, false]) {
      const q = make("trueFalse", { correct }, `Statement ${correct}.`);
      const item = itemsOf(unpack([q]))[0] as XmlElement;
      const labels = labelsOf(item);
      assert.deepEqual(labels.map((l) => l.text), ["True", "False"]);
      for (const l of labels) assert.equal(grade(item, { response1: [l.ident] }), (l.text === "True") === correct ? 1 : 0, `${correct}: ${l.text}`);
    }
  });

  test("a short answer scores each accepted answer once, ignoring case unless the question counts it", () => {
    const item = itemsOf(unpack([SA]))[0] as XmlElement;
    assert.equal(grade(item, { response1: ["Paris"] }), 1);
    assert.equal(grade(item, { response1: ["paris"] }), 1, "case does not count");
    assert.equal(grade(item, { response1: ["PARIS, FRANCE"] }), 1);
    assert.equal(grade(item, { response1: ["London"] }), 0);
    assert.equal(grade(item, { response1: [""] }), 0);
    assert.equal(descend(item, "varequal").length, 2, "Paris is written once");

    const exact = itemsOf(unpack([FIB]))[0] as XmlElement;
    assert.equal(grade(exact, { response1: ["Quartz"] }), 1);
    assert.equal(grade(exact, { response1: ["quartz"] }), 0, "a question that counts case does");
  });

  test("a matching question is a share of its points for each right match, so half right is worth half", () => {
    const item = itemsOf(unpack([MAT]))[0] as XmlElement;
    const lids = elements(first(item, "presentation") as XmlElement, "response_lid");
    assert.equal(lids.length, 3);
    // The left side is the material before the render_choice, which is the first material in the response_lid.
    const leftText = (l: XmlElement): string => allText(first(first(l, "material") as XmlElement, "mattext") as XmlElement);
    const lefts = lids.map((l) => ({ ident: attr(l, "ident"), text: leftText(l), labels: labelsOf(item, attr(l, "ident")) }));
    assert.deepEqual(lefts.map((l) => l.text), ["Dog", "Cat", "Cow"]);
    const sound: Record<string, string> = { Dog: "Bark", Cat: "Meow", Cow: "Moo" };
    const pick = (l: (typeof lefts)[0], word: string): string => (l.labels.find((x) => x.text === word) as { ident: string }).ident;
    const allRight: Answers = Object.fromEntries(lefts.map((l) => [l.ident, [pick(l, sound[l.text] as string)]]));
    assert.equal(grade(item, allRight), 1, "all right");
    const oneWrong: Answers = { ...allRight, [lefts[0]?.ident as string]: [pick(lefts[0] as (typeof lefts)[0], "Meow")] };
    assert.equal(grade(item, oneWrong), Math.round((2 / 3) * 100000) / 100000, "two of three");
    assert.equal(grade(item, {}), 0, "nothing chosen");
    // Every list offers every right side.
    for (const l of lefts) assert.deepEqual(l.labels.map((x) => x.text).sort(), ["Bark", "Meow", "Moo"]);
  });

  test("spare matching answers are offered in every list and are right for none", () => {
    const q = make("matching", { shuffle: true, distractors: ["Oink"], pairs: [{ id: "p1", left: plainToRich("Dog"), right: "Bark" }, { id: "p2", left: plainToRich("Cat"), right: "Meow" }] }, "Match.");
    const item = itemsOf(unpack([q]))[0] as XmlElement;
    const lids = elements(first(item, "presentation") as XmlElement, "response_lid");
    for (const l of lids) assert.deepEqual(labelsOf(item, attr(l, "ident")).map((x) => x.text), ["Bark", "Meow", "Oink"]);
    const oink = (labelsOf(item, attr(lids[0] as XmlElement, "ident")).find((x) => x.text === "Oink") as { ident: string }).ident;
    assert.equal(grade(item, { [attr(lids[0] as XmlElement, "ident")]: [oink], [attr(lids[1] as XmlElement, "ident")]: [oink] }), 0);
    assert.deepEqual(itemOf(q).notes, [], "nothing is lost");
  });

  test("two pairs with the same right side share one label", () => {
    const q = make("matching", { shuffle: true, distractors: [], pairs: [{ id: "p1", left: plainToRich("Dog"), right: "Pet" }, { id: "p2", left: plainToRich("Cat"), right: "Pet" }, { id: "p3", left: plainToRich("Cow"), right: "Farm" }] }, "Match.");
    const item = itemsOf(unpack([q]))[0] as XmlElement;
    const lids = elements(first(item, "presentation") as XmlElement, "response_lid");
    assert.deepEqual(labelsOf(item, attr(lids[0] as XmlElement, "ident")).map((x) => x.text), ["Pet", "Farm"]);
    const ident = (word: string): string => (labelsOf(item).find((x) => x.text === word) as { ident: string }).ident;
    assert.equal(grade(item, { [attr(lids[0] as XmlElement, "ident")]: [ident("Pet")], [attr(lids[1] as XmlElement, "ident")]: [ident("Pet")], [attr(lids[2] as XmlElement, "ident")]: [ident("Farm")] }), 1);
  });

  test("an essay can score nothing by itself, so it is marked by hand, and it is an essay for Canvas", () => {
    const item = itemsOf(unpack([ESS]))[0] as XmlElement;
    assert.equal(grade(item, { response1: ["A long answer."] }), 0);
    assert.deepEqual(specProblems(unpack([ESS])), []);
    assert.equal(allText(descend(item, "fieldentry")[0] as XmlElement), "essay_question");
    assert.equal(attr(descend(item, "render_fib")[0] as XmlElement, "rows"), "15", "more than one row, which is what makes it a written response");
  });

  test("points are carried: in the metadata, the top of SCORE and the score a right answer sets, fractions included", () => {
    for (const points of [1, 2, 5, 0.5, 2.25]) {
      const q = make("multipleChoice", { shuffle: true, options: [opt("o1", "A", true), opt("o2", "B")] }, `Worth ${points}?`, { points });
      const pack = unpack([q]);
      const item = itemsOf(pack)[0] as XmlElement;
      assert.equal(pointsOf(item), points);
      assert.equal(grade(item, { response1: [labelsOf(item)[0]?.ident as string] }), points, `${points} for the right label`);
      assert.equal(grade(item, { response1: [labelsOf(item)[1]?.ident as string] }), 0);
      const fields = descend(item, "qtimetadatafield").map((f) => [allText(first(f, "fieldlabel") as XmlElement), allText(first(f, "fieldentry") as XmlElement)]);
      assert.deepEqual(fields.find((f) => f[0] === "points_possible"), ["points_possible", String(points)]);
      assert.deepEqual(specProblems(pack), []);
    }
    const matching = make("matching", { shuffle: true, distractors: [], pairs: [{ id: "p1", left: plainToRich("a"), right: "1" }, { id: "p2", left: plainToRich("b"), right: "2" }, { id: "p3", left: plainToRich("c"), right: "3" }] }, "Match.", { points: 3 });
    const item = itemsOf(unpack([matching]))[0] as XmlElement;
    const lids = elements(first(item, "presentation") as XmlElement, "response_lid");
    const right = Object.fromEntries(lids.map((l, i) => [attr(l, "ident"), [(labelsOf(item, attr(l, "ident")).find((x) => x.text === String(i + 1)) as { ident: string }).ident]]));
    assert.equal(grade(item, right), 3);
  });

  test("the answers are mixed unless the question keeps them in order", () => {
    const shuffled = itemsOf(unpack([MC]))[0] as XmlElement;
    assert.equal(attr(descend(shuffled, "render_choice")[0] as XmlElement, "shuffle"), "Yes");
    const fixed = make("multipleChoice", { shuffle: false, options: [opt("o1", "A", true), opt("o2", "B")] }, "Which?");
    assert.equal(attr(descend(itemsOf(unpack([fixed]))[0] as XmlElement, "render_choice")[0] as XmlElement, "shuffle"), "No");
    assert.deepEqual(itemOf(fixed).notes, [], "the file can say so, so nothing is lost");
    const some = make("multipleChoice", { shuffle: true, options: [opt("o1", "A", true), { ...opt("o2", "None of the above"), fixedPosition: true }] }, "Which?");
    assert.match(itemOf(some).notes.join(" "), /fixed in place and others are mixed/);
    assert.equal(attr(descend(itemsOf(unpack([some]))[0] as XmlElement, "render_choice")[0] as XmlElement, "shuffle"), "No");
  });
});

describe("what is left out, and why", () => {
  test("an ordering, a numeric, a hotspot and a calculated question are not written, each with its reason", () => {
    const ordering = make("ordering", { items: [{ id: "i1", content: plainToRich("A"), position: 1 }, { id: "i2", content: plainToRich("B"), position: 2 }] }, "Order.");
    const numeric = make("numeric", { mode: "exact", value: 3 }, "How many?");
    assert.match(itemOf(ordering).notes.join(" "), /Brightspace's CSV export carries ordering/);
    assert.match(itemOf(numeric).notes.join(" "), /numeric question in a QTI file/);
    for (const q of [ordering, numeric, make("hotspot", {} as QuestionBody, "Where?"), make("calculated", {} as QuestionBody, "Compute.")]) {
      assert.equal(itemOf(q).outcome, "leftOut", q.type);
    }
    assert.deepEqual(exportQti12([ordering, numeric]).files, [], "no file is written when nothing can be");
  });

  test("a question with no usable key is never written, and no key is guessed to fit", () => {
    const none = make("multipleChoice", { shuffle: true, options: [opt("o1", "A"), opt("o2", "B")] }, "Which?");
    const two = make("multipleChoice", { shuffle: true, options: [opt("o1", "A", true), opt("o2", "B", true)] }, "Which?");
    const noTf = make("trueFalse", {} as QuestionBody, "Is it?");
    const noAccepted = make("shortAnswer", { caseSensitive: false, accepted: [] }, "What?");
    const noneMA = make("multipleResponse", { shuffle: true, partialCredit: false, options: [opt("o1", "A"), opt("o2", "B")] }, "Which?");
    for (const q of [none, two, noTf, noAccepted, noneMA]) {
      assert.equal(itemOf(q).outcome, "leftOut", q.type);
      assert.equal(exportQti12([q]).files.length, 0);
    }
    const pack = unpack([none, MC, noTf]);
    assert.equal(itemsOf(pack).length, 1, "the file holds the good question only");
    assert.deepEqual(specProblems(pack), []);
  });

  test("a blank answer, one answer, two blanks, and a pair with a side missing are left out", () => {
    const empty = make("multipleChoice", { shuffle: true, options: [opt("o1", "A", true), opt("o2", "   ")] }, "Which?");
    const single = make("multipleChoice", { shuffle: true, options: [opt("o1", "A", true)] }, "Which?");
    const two = make("fillInBlank", { caseSensitive: false, blanks: [{ id: "b1", accepted: ["x"] }, { id: "b2", accepted: ["y"] }] }, "_ and _.");
    const one = make("matching", { shuffle: true, distractors: [], pairs: [{ id: "p1", left: plainToRich("x"), right: "1" }] }, "Match.");
    const hole = make("matching", { shuffle: true, distractors: [], pairs: [{ id: "p1", left: plainToRich("x"), right: "1" }, { id: "p2", left: plainToRich("y"), right: " " }] }, "Match.");
    const holeLeft = make("matching", { shuffle: true, distractors: [], pairs: [{ id: "p1", left: plainToRich(" "), right: "1" }, { id: "p2", left: plainToRich("y"), right: "2" }] }, "Match.");
    for (const q of [empty, single, two, one, hole, holeLeft]) assert.equal(itemOf(q).outcome, "leftOut", q.stem.content);
    assert.match(itemOf(two).notes.join(" "), /2 blanks/);
  });

  test("a question with no words is left out", () => {
    assert.equal(itemOf(make("trueFalse", { correct: true }, "<p> </p>")).outcome, "leftOut");
  });
});

describe("what is lost on the way, said against the question", () => {
  test("a fill in the blank arrives as a short answer, and says so", () => {
    assert.equal(itemOf(FIB).asType, "short answer");
    assert.match(itemOf(FIB).notes.join(" "), /written as a short answer/);
    assert.equal(allText(descend(itemsOf(unpack([FIB]))[0] as XmlElement, "fieldentry")[0] as XmlElement), "short_answer_question");
  });

  test("partial credit, feedback, a model answer and a rubric are said", () => {
    const partial = make("multipleResponse", { shuffle: true, partialCredit: true, options: [opt("o1", "A", true), opt("o2", "B", true, "Yes."), opt("o3", "C")] }, "Which?", { feedback: { general: plainToRich("Well done.") } });
    const notes = itemOf(partial).notes.join(" ");
    assert.match(notes, /Partial credit cannot be carried/);
    assert.match(notes, /Feedback on a single answer cannot be carried/);
    assert.match(notes, /Feedback cannot be carried in this package/);
    const essay = make("essay", { modelAnswer: plainToRich("X."), rubric: [{ id: "r1", criterion: "Clarity", levels: [] }], expectedWords: 200 } as unknown as QuestionBody, "Discuss.");
    const e = itemOf(essay).notes.join(" ");
    assert.match(e, /model answer cannot be carried/);
    assert.match(e, /rubric cannot be carried/);
    assert.match(e, /expected length cannot be carried/);
  });

  test("a question with plain text, one point and no feedback loses nothing", () => {
    for (const q of [MC, MA, TF, SA, MAT, ESS]) {
      assert.equal(itemOf(q).outcome, "exported", q.stem.content);
      assert.deepEqual(itemOf(q).notes, [], q.stem.content);
    }
  });
});

describe("text", () => {
  test("markup, quotes, ampersands and angle brackets in the text come back as they were written", () => {
    const stem = 'Is 5 < 7 && x > 3 "always" true? ]]> <b>no</b> \'yes\'';
    const q = make("multipleChoice", { shuffle: true, options: [opt("o1", 'a < b & "c"', true), opt("o2", "]]> <script>x</script>")] }, stem);
    const pack = unpack([q]);
    assert.deepEqual(specProblems(pack), []);
    const item = itemsOf(pack)[0] as XmlElement;
    assert.equal(mattext(item).text, stem, "the stem, with its angle brackets");
    assert.deepEqual(labelsOf(item).map((l) => l.text), ['a < b & "c"', "]]> <script>x</script>"]);
    assert.doesNotMatch(pack.text("assessment.xml"), /<script>/, "nothing in a question is markup of the file's own");
  });

  test("control characters that XML cannot hold are dropped, and the rest of the text stays", () => {
    const q = make("trueFalse", { correct: true }, "Bell\u0007 and\u0000 null\u001b? Tab\there.");
    const pack = unpack([q]);
    assert.deepEqual(specProblems(pack), []);
    assert.match(mattext(itemsOf(pack)[0] as XmlElement).text, /^Bell and null\? Tab here\.$/);
  });

  test("the question text is html, and a formatted one keeps its formatting", () => {
    const q = make("trueFalse", { correct: true }, "<p>A <strong>bold</strong> claim.</p><p>Second paragraph.</p>");
    const item = itemsOf(unpack([q]))[0] as XmlElement;
    const m = mattext(item);
    assert.equal(m.type, "text/html");
    assert.match(m.raw, /<strong>bold<\/strong>/);
    assert.match(m.raw, /<p>Second paragraph\.<\/p>/);
    const plain = itemsOf(unpack([TF]))[0] as XmlElement;
    assert.equal(mattext(plain).type, "text/html");
    assert.equal(mattext(plain).raw, "<p>A light-year is a measure of time.</p>");
  });

  test("an answer with formatting is html, and a plain one is plain text", () => {
    const q = make("multipleChoice", { shuffle: true, options: [{ id: "o1", content: rich("<strong>Bold</strong> answer"), correct: true }, opt("o2", "Plain answer")] }, "Which?");
    const item = itemsOf(unpack([q]))[0] as XmlElement;
    const [first1, second] = descend(item, "response_label");
    assert.equal(mattext(first1 as XmlElement).type, "text/html");
    assert.match(mattext(first1 as XmlElement).raw, /<strong>Bold<\/strong>/);
    assert.equal(mattext(second as XmlElement).type, "text/plain");
    assert.equal(itemOf(q).outcome, "exported");
  });

  test("a picture or an equation is a marker in the text, and counted, never dropped", () => {
    const q = make("trueFalse", { correct: true }, '<p>See <oa-media ref="m1"></oa-media> and <oa-math ref="e1"></oa-math>.</p>', {
      media: [{ id: "m1", file: "media/m1.png", mime: "image/png", alt: "the chart" }],
      math: [{ id: "e1", latex: "x^2", mathml: "<math></math>" }],
    });
    const m = mattext(itemsOf(unpack([q]))[0] as XmlElement);
    assert.match(m.text, /\[Picture: the chart\]/);
    assert.match(m.text, /\[Equation: x\^2\]/);
    const notes = itemOf(q).notes.join(" ");
    assert.match(notes, /1 picture cannot be carried/);
    assert.match(notes, /1 equation became text/);
  });

  test("paragraph breaks inside an answer become spaces and are said", () => {
    const q = make("multipleChoice", { shuffle: true, options: [opt("o1", "one\n\ntwo", true), opt("o2", "three")] }, "Which?");
    assert.deepEqual(labelsOf(itemsOf(unpack([q]))[0] as XmlElement).map((l) => l.text), ["one two", "three"]);
    assert.match(itemOf(q).notes.join(" "), /Paragraph breaks became spaces/);
  });

  test("a title that is long or has markup in it is safe in the attribute", () => {
    const q = make("trueFalse", { correct: true }, "Plain.", { title: `A "quoted" <title> & ${"long ".repeat(40)}` });
    const pack = unpack([q]);
    assert.deepEqual(specProblems(pack), []);
    const title = attr(itemsOf(pack)[0] as XmlElement, "title");
    assert.ok(title.length <= 100);
    assert.match(title, /^A "quoted" <title> & long/);
  });
});

describe("the file and the check", () => {
  test("names the file for the bank, makes the name safe, and reports every question once, in order", () => {
    const result = exportQti12([MC, make("numeric", { mode: "exact", value: 1 }, "Number?"), TF], { name: 'Week 1: "Planets"?' });
    assert.deepEqual(result.files.map((f) => f.name), ["Week 1- -Planets-- - QTI 1.2.zip"]);
    assert.equal(result.files[0]?.questions, 2);
    assert.equal(result.files[0]?.content, "", "the file is bytes, and its text is empty");
    assert.deepEqual(result.report.items.map((i) => [i.position, i.outcome]), [[1, "exported"], [2, "leftOut"], [3, "exported"]]);
    assert.equal(result.report.destination, QTI12_ID);
    assert.equal(result.report.total, 3);
    assert.deepEqual([result.report.exported, result.report.exportedWithLosses, result.report.leftOut], [2, 0, 1]);
    assert.deepEqual(result.report.files, result.files.map((f) => f.name));
  });

  test("tells a person where to import it in Brightspace and in Canvas, and what the file cannot do", () => {
    const general = checkQti12([MC]).general.join(" ");
    assert.match(general, /Brightspace: Course Admin, Import\/Export\/Copy Components, Import Components, from a File/);
    assert.match(general, /tick Quizzes/);
    assert.match(general, /exact name of the zip in the Import file to box/);
    assert.match(general, /Question Library names a CSV file, not QTI/);
    assert.doesNotMatch(general, /Question Library, then Import/, "the Question Library's own help does not list QTI, so the note must not send a person there for it");
    assert.match(general, /Canvas: Settings, then Import Course Content, with the content type QTI \.zip file/);
    assert.match(general, /Create new question bank/);
    assert.match(general, /Images are not carried/);
  });

  test("a bank with nothing it can write gives no file", () => {
    const result = exportQti12([make("numeric", { mode: "exact", value: 1 }, "Number?")]);
    assert.deepEqual(result.files, []);
    assert.deepEqual(result.report.files, []);
  });

  test("an empty bank gives no file and no error", () => {
    assert.deepEqual(exportQti12([]).files, []);
    assert.equal(checkQti12([]).total, 0);
  });
});

describe("the command line", () => {
  test("`export --to qti-1.2` writes a zip a second reader can open, and says what it would do without --out", () => {
    const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
    const source = fileURLToPath(new URL("../../../fixtures/standard-format/01-clean-multiple-choice.txt", import.meta.url));
    const folder = mkdtempSync(join(tmpdir(), "oa-qti-"));
    try {
      const run = (...args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, ...args], { encoding: "utf8" });
      const bank = join(folder, "bank.openassess");
      assert.equal(run("import", source, "--out", bank).status, 0);

      const dry = run("export", bank, "--to", "qti-1.2");
      assert.equal(dry.status, 0, dry.stderr);
      assert.match(dry.stdout, /Destination check: QTI 1\.2 package/);
      assert.match(dry.stdout, /Nothing was written/);
      assert.deepEqual(readdirSync(folder), ["bank.openassess"]);

      const out = join(folder, "out");
      const written = run("export", bank, "--to", "qti-1.2", "--out", out);
      assert.equal(written.status, 0, written.stderr);
      const [name] = readdirSync(out);
      assert.match(name ?? "", / - QTI 1\.2\.zip$/);
      const bytes = new Uint8Array(readFileSync(join(out, name as string)));
      assert.equal(bytes[0], 0x50, "a zip begins with PK");
      assert.equal(bytes[1], 0x4b);
      const files = unzipSync(bytes);
      const text = (n: string): string => Buffer.from(files.get(n) ?? new Uint8Array()).toString("utf8");
      assert.deepEqual(specProblems({ files, manifest: parseXml(text("imsmanifest.xml")), doc: parseXml(text("assessment.xml")), text }), []);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("a package against the format's own description", () => {
  test("every kind of question, together, satisfies it", () => {
    const all = [MC, MA, TF, SA, FIB, MAT, ESS, make("trueFalse", { correct: true }, "<p>A <em>formatted</em> one.</p>", { points: 7, title: "Titled" })];
    const pack = unpack(all);
    assert.deepEqual(specProblems(pack), []);
    assert.equal(itemsOf(pack).length, all.length);
  });

  test("the checker does notice what is wrong with a package (so that passing it means something)", () => {
    const pack = unpack([MC, MA, MAT]);
    const mutate = (from: string | RegExp, to: string): Pack => {
      const assessment = pack.text("assessment.xml").replace(from, to);
      assert.notEqual(assessment, pack.text("assessment.xml"), `the mutation ${String(from)} changed nothing`);
      return { ...pack, doc: parseXml(assessment) };
    };
    assert.ok(specProblems(mutate(/<(\/?)section\b/g, "<$1sectionx")).length > 0, "no section, the Brightspace 'no quizzes or sections'");
    assert.ok(specProblems(mutate('ident="q2"', 'ident="q1"')).length > 0, "two items with one ident");
    assert.ok(specProblems(mutate("multiple_choice_question", "invented_question")).length > 0, "a kind Canvas does not read");
    assert.ok(specProblems(mutate('rcardinality="Single"', 'rcardinality="Multiple"')).length > 0, "a multiple choice that takes several");
    assert.ok(specProblems(mutate(/<varequal respident="response1">q1_a2/, '<varequal respident="response1">q1_a9')).length > 0, "a condition that names a label that is not offered");
    assert.ok(specProblems(mutate(/<varequal respident="response1">q1_a2/, '<varequal respident="response9">q1_a2')).length > 0, "a condition that names a response that is not there");
    assert.ok(specProblems(mutate(/maxvalue="1"/, 'maxvalue="5"')).length > 0, "SCORE's top is not the points");
    assert.ok(specProblems(mutate(/<(\/?)resprocessing\b/g, "<$1resprocessingx")).length > 0, "an item that has no processing");
    const badManifest = { ...pack, manifest: parseXml(pack.text("imsmanifest.xml").replace('type="imsqti_xmlv1p2"', 'type="webcontent"')) };
    assert.ok(specProblems(badManifest).length > 0, "the wrong resource type");
    const missing = { ...pack, files: new Map([...pack.files].filter(([n]) => n !== "assessment.xml")) };
    assert.ok(specProblems(missing).length > 0, "the resource's file is not in the zip");
  });

  test("the response processor does notice a wrong key (so that a right key means something)", () => {
    // Point the one condition at the wrong label by editing the text of the package, and the right label stops scoring.
    const text = unpack([MC]).text("assessment.xml").replace(/(<varequal respident="response1">)q1_a2/, "$1q1_a1");
    const edited = itemsOf({ ...unpack([MC]), doc: parseXml(text) })[0] as XmlElement;
    const labels = labelsOf(edited);
    assert.equal(grade(edited, { response1: [(labels.find((l) => l.text === "Paris") as { ident: string }).ident] }), 0);
    assert.equal(grade(edited, { response1: [(labels.find((l) => l.text === "Berlin") as { ident: string }).ident] }), 1);
  });

  test("every bank in the fixtures, read by its importer and exported, satisfies it, and every key scores", () => {
    const folder = join(fileURLToPath(new URL("../../../fixtures/standard-format/", import.meta.url)));
    let files = 0;
    let questions = 0;
    for (const name of readdirSync(folder).filter((n) => /\.(txt|docx)$/.test(n))) {
      const bytes = new Uint8Array(readFileSync(join(folder, name)));
      const result = runImporter(importerForContent(name, bytes), bytes, { file: name, at: AT, author: "test" });
      const exported = exportQti12(result.questions, { name });
      if (exported.files.length === 0) continue;
      files++;
      const pack = unpackFile(exported.files[0]?.bytes as Uint8Array);
      assert.deepEqual(specProblems(pack), [], name);
      questions += verifyKeys(result.questions, exported.report.items.map((i) => i.outcome), pack, name);
    }
    assert.ok(files >= 15, `only ${files} fixtures exported`);
    assert.ok(questions >= 40, `only ${questions} questions exported`);
  });

  const real = join(fileURLToPath(new URL("../../../fixtures/publisher/", import.meta.url)));
  const hasReal = existsSync(real) && readdirSync(real).some((n) => n.endsWith(".expected.json"));
  test("every real bank in fixtures/publisher, when there are some, exports to a package that satisfies it and scores its keys", { skip: hasReal ? false : "none there; the folder is git-ignored and local" }, () => {
    let questions = 0;
    for (const name of readdirSync(real).filter((n) => /\.(txt|docx|xlsx|csv)$/.test(n))) {
      const bytes = new Uint8Array(readFileSync(join(real, name)));
      const result = runImporter(importerForContent(name, bytes), bytes, { file: name, at: AT, author: "test" });
      const exported = exportQti12(result.questions, { name });
      if (exported.files.length === 0) continue;
      const pack = unpackFile(exported.files[0]?.bytes as Uint8Array);
      assert.deepEqual(specProblems(pack), [], name);
      questions += verifyKeys(result.questions, exported.report.items.map((i) => i.outcome), pack, name);
    }
    assert.ok(questions > 0);
  });
});

function unpackFile(bytes: Uint8Array): Pack {
  const files = unzipSync(bytes);
  const text = (n: string): string => Buffer.from(files.get(n) ?? new Uint8Array()).toString("utf8");
  return { files, manifest: parseXml(text("imsmanifest.xml")), doc: parseXml(text("assessment.xml")), text };
}

/**
 * For every question that was written: the key the bank holds, found in the package by the words of the answers and not by the
 * exporter's idents, is exactly what scores the points, and nothing else among the single answers does.
 */
function verifyKeys(questions: Question[], outcomes: string[], pack: Pack, name: string): number {
  const items = itemsOf(pack);
  const written = questions.filter((_q, i) => outcomes[i] !== "leftOut");
  assert.equal(items.length, written.length, name);
  const plain = (t: unknown): string => richTextToPlain(t as never).replace(/\s+/g, " ").trim();
  written.forEach((q, i) => {
    const item = items[i] as XmlElement;
    const where = `${name}: ${q.title}`;
    const points = pointsOf(item);
    assert.equal(points, q.points, where);
    const body = q.body as unknown as { options?: Array<{ content: unknown; correct: boolean }>; correct?: boolean; accepted?: string[]; blanks?: Array<{ accepted: string[] }>; caseSensitive?: boolean };
    if (q.type === "multipleChoice") {
      const labels = labelsOf(item);
      const right = (body.options ?? []).filter((o) => o.correct).map((o) => plain(o.content));
      assert.equal(right.length, 1, where);
      for (const l of labels) assert.equal(grade(item, { response1: [l.ident] }), right.includes(l.text) ? points : 0, `${where} / ${l.text}`);
    } else if (q.type === "multipleResponse") {
      const labels = labelsOf(item);
      const right = new Set((body.options ?? []).filter((o) => o.correct).map((o) => plain(o.content)));
      for (const chosen of subsets(labels)) {
        const exact = chosen.length === right.size && chosen.every((l) => right.has(l.text));
        assert.equal(grade(item, { response1: chosen.map((l) => l.ident) }), exact ? points : 0, `${where} / ${chosen.map((l) => l.text).join("+")}`);
      }
    } else if (q.type === "trueFalse") {
      for (const l of labelsOf(item)) assert.equal(grade(item, { response1: [l.ident] }), (l.text === "True") === body.correct ? points : 0, where);
    } else if (q.type === "shortAnswer" || q.type === "fillInBlank") {
      const accepted = q.type === "shortAnswer" ? (body.accepted ?? []) : (body.blanks?.[0]?.accepted ?? []);
      for (const a of accepted.map((x) => x.replace(/\s+/g, " ").trim()).filter((x) => x !== "")) assert.equal(grade(item, { response1: [a] }), points, `${where} / ${a}`);
      assert.equal(grade(item, { response1: ["zzz not an answer zzz"] }), 0, where);
    }
  });
  return written.length;
}
