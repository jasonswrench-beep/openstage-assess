/**
 * Export as a Common Cartridge 1.3 package. The rules under test are the ones every exporter keeps (a question whose key is
 * missing is never written and no key is guessed, nothing is lost without being said against the question, what cannot be
 * written is left out and why) and the ones this format has: a manifest in the Common Cartridge namespace that lists the quiz and
 * names one resource of the Common Cartridge assessment type, and a questestinterop file in the Common Cartridge profile of
 * QTI 1.2, where the assessment and each item name a `cc_profile`, an item's points are its `cc_weighting`, and a right answer
 * scores 100.
 *
 * `specProblems` is a second reading of that, and `grade` (in support/qti-reader.ts) is a small QTI 1.2 response processor that
 * scores every answer a student could give. Both were written apart from the exporter. The shape the exporter follows is the one a
 * tool that builds Brightspace quizzes writes (Brightspacosaurus 0.35.0, its source read on 1 November 2026), so these tests
 * show that the package matches that shape and that the key travels. They cannot say that Brightspace will accept it.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CC_ASSESSMENT_FILE, CC_ASSESSMENT_TYPE, CC_PROFILES, checkCommonCartridge, COMMON_CARTRIDGE_ID, exportCommonCartridge } from "../src/export/common-cartridge.ts";
import { importerForContent, runImporter } from "../src/import/registry.ts";
import { allText, elements, first, parseXml, type XmlElement } from "../src/import/docx/xml.ts";
import { createQuestion } from "../src/model/create.ts";
import { plainToRich, rich, richTextToPlain } from "../src/model/richtext.ts";
import type { Question, QuestionBody, QuestionType } from "../src/model/question.ts";
import { attr, descend, grade, itemsOf, labelsOf, mattext, readPackage, subsets, type Pack } from "./support/qti-reader.ts";

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
const MAT = make("matching", { shuffle: true, distractors: [], pairs: [{ id: "p1", left: plainToRich("Dog"), right: "Bark" }, { id: "p2", left: plainToRich("Cat"), right: "Meow" }] }, "Match the animal to its sound.");
const ORD = make("ordering", { items: [{ id: "i1", content: plainToRich("A"), position: 1 }, { id: "i2", content: plainToRich("B"), position: 2 }] }, "Order.");
const ESS = make("essay", {}, "Discuss.");

const unpack = (questions: Question[], name = "Test"): Pack => readPackage(exportCommonCartridge(questions, { name }).files[0]?.bytes, CC_ASSESSMENT_FILE);
const itemOf = (question: Question) => checkCommonCartridge([question]).items[0] as NonNullable<ReturnType<typeof checkCommonCartridge>["items"][0]>;

const NCNAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const ITEM_PROFILES: string[] = [CC_PROFILES.multipleChoice, CC_PROFILES.multipleResponse, CC_PROFILES.trueFalse, CC_PROFILES.fillInBlank, CC_PROFILES.essay];

const fieldsOf = (el: XmlElement): Map<string, string> =>
  new Map(descend(el, "qtimetadatafield").map((f) => [allText(first(f, "fieldlabel") as XmlElement), allText(first(f, "fieldentry") as XmlElement)] as const));
const profileOf = (item: XmlElement): string => fieldsOf(item).get("cc_profile") ?? "";
const weightOf = (item: XmlElement): number => Number(fieldsOf(item).get("cc_weighting"));

/** What Common Cartridge 1.3 and its QTI profile say is wrong with a package, which is nothing for one that follows them. */
function specProblems(pack: Pack): string[] {
  const problems: string[] = [];

  // The manifest: the Common Cartridge namespace and schema, an organization that lists the quiz, and one resource.
  const manifestText = pack.text("imsmanifest.xml");
  if (!manifestText.includes('xmlns="http://www.imsglobal.org/xsd/imsccv1p3/imscp_v1p1"')) problems.push("the manifest is not in the Common Cartridge 1.3 namespace");
  if (pack.manifest.name !== "manifest") problems.push(`the manifest's root is ${pack.manifest.name}`);
  if (!attr(pack.manifest, "identifier")) problems.push("the manifest has no identifier");
  const metadata = first(pack.manifest, "metadata");
  if (!metadata || allText(first(metadata, "schema") as XmlElement) !== "IMS Common Cartridge") problems.push("the schema is not IMS Common Cartridge");
  if (!metadata || allText(first(metadata, "schemaversion") as XmlElement) !== "1.3.0") problems.push("the schema version is not 1.3.0");
  const resources = descend(pack.manifest, "resource");
  if (resources.length !== 1) problems.push(`the manifest names ${resources.length} resources, not one`);
  const resource = resources[0];
  if (resource) {
    if (attr(resource, "type") !== CC_ASSESSMENT_TYPE) problems.push(`the resource's type is ${attr(resource, "type")}`);
    if (!pack.files.has(attr(resource, "href"))) problems.push(`the resource's href ${attr(resource, "href")} is not in the zip`);
    if (!descend(resource, "file").some((f) => attr(f, "href") === attr(resource, "href"))) problems.push("the resource does not list its file");
    if (!NCNAME.test(attr(resource, "identifier"))) problems.push("the resource has no valid identifier");
  }
  const organizations = descend(pack.manifest, "organization");
  if (organizations.length !== 1 || attr(organizations[0] as XmlElement, "structure") !== "rooted-hierarchy") problems.push("there is not one organization with a rooted hierarchy");
  const listed = descend(pack.manifest, "item").filter((i) => attr(i, "identifierref") !== "");
  if (listed.length !== 1 || (resource && attr(listed[0] as XmlElement, "identifierref") !== attr(resource, "identifier"))) problems.push("the organization does not list the resource once");
  for (const name of pack.files.keys()) if (name.startsWith("/") || name.includes("..") || name.includes("\\")) problems.push(`the entry name ${name} is not a plain relative path`);

  // The questions: the profile's questestinterop, one assessment named an exam, one section, items.
  if (!pack.text(CC_ASSESSMENT_FILE).includes("ccv1p3_qtiasiv1p2p1_v1p0.xsd")) problems.push("the questions are not in the Common Cartridge profile of QTI 1.2");
  if (pack.doc.name !== "questestinterop") problems.push(`the root is ${pack.doc.name}, not questestinterop`);
  const assessments = elements(pack.doc, "assessment");
  if (assessments.length !== 1) return [...problems, `${assessments.length} assessments, not one`];
  const assessment = assessments[0] as XmlElement;
  if (!NCNAME.test(attr(assessment, "ident")) || !attr(assessment, "title")) problems.push("the assessment needs an ident and a title");
  const own = first(assessment, "qtimetadata");
  const ownFields = own ? fieldsOf(own) : new Map<string, string>();
  if (ownFields.get("cc_profile") !== CC_PROFILES.exam) problems.push("the assessment's cc_profile is not cc.exam.v0p1");
  if (!ownFields.has("cc_maxattempts")) problems.push("the assessment has no cc_maxattempts");
  const sections = elements(assessment, "section");
  if (sections.length < 1) return [...problems, "no section in the assessment"];
  const idents = new Set<string>();
  for (const s of sections) for (const item of elements(s, "item")) problems.push(...itemProblems(item, idents));
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

  const profile = profileOf(item);
  if (!ITEM_PROFILES.includes(profile)) problems.push(`${where}: cc_profile ${profile} is not one the profile holds`);
  const weight = weightOf(item);
  if (!(weight > 0 && weight <= 100)) problems.push(`${where}: cc_weighting is not a number above zero`);

  const presentation = first(item, "presentation");
  if (!presentation) return [...problems, `${where}: no presentation`];
  const lead = first(presentation, "material");
  if (!lead || !first(lead, "mattext") || allText(first(lead, "mattext") as XmlElement).trim() === "") problems.push(`${where}: the presentation does not begin with the question text`);
  for (const m of descend(presentation, "mattext")) if (!["text/plain", "text/html"].includes(attr(m, "texttype"))) problems.push(`${where}: texttype ${attr(m, "texttype")}`);
  const lids = elements(presentation, "response_lid");
  const strs = elements(presentation, "response_str");
  const respidents = new Set([...lids, ...strs].map((r) => attr(r, "ident")));
  if (respidents.size !== lids.length + strs.length || respidents.size !== 1) problems.push(`${where}: a Common Cartridge question has one response`);

  const labels = new Set<string>();
  for (const l of lids) {
    const choice = first(l, "render_choice");
    const ls = choice ? elements(choice, "response_label") : [];
    if (ls.length < 2) problems.push(`${where}: fewer than two labels`);
    for (const x of ls) {
      labels.add(attr(x, "ident"));
      if (!NCNAME.test(attr(x, "ident")) || !first(x, "material")) problems.push(`${where}: a label with no valid ident or no material`);
    }
    if (labels.size !== ls.length) problems.push(`${where}: label idents are not unique`);
  }
  if (profile === CC_PROFILES.multipleChoice && !(lids.length === 1 && attr(lids[0] as XmlElement, "rcardinality") === "Single")) problems.push(`${where}: multiple choice is one Single response_lid`);
  if (profile === CC_PROFILES.multipleResponse && !(lids.length === 1 && attr(lids[0] as XmlElement, "rcardinality") === "Multiple")) problems.push(`${where}: multiple response is one Multiple response_lid`);
  if (profile === CC_PROFILES.trueFalse && !(lids.length === 1 && attr(lids[0] as XmlElement, "rcardinality") === "Single" && labels.size === 2)) problems.push(`${where}: true or false is one Single response_lid with two labels`);
  if (profile === CC_PROFILES.fillInBlank || profile === CC_PROFILES.essay) {
    const fib = strs[0] ? first(strs[0], "render_fib") : undefined;
    if (!fib || attr(fib, "fibtype") !== "String") problems.push(`${where}: a typed answer is a response_str with a String render_fib`);
    if (profile === CC_PROFILES.essay && Number(attr(fib as XmlElement, "rows")) < 2) problems.push(`${where}: an essay has more than one row`);
  }

  const processing = first(item, "resprocessing");
  if (!processing) return [...problems, `${where}: no resprocessing`];
  const decvar = descend(processing, "decvar")[0];
  if (!decvar || attr(decvar, "varname") !== "SCORE" || Number(attr(decvar, "minvalue")) !== 0 || Number(attr(decvar, "maxvalue")) !== 100) problems.push(`${where}: SCORE runs from 0 to 100`);
  const conditions = descend(processing, "respcondition");
  if (profile === CC_PROFILES.essay && conditions.length > 0) problems.push(`${where}: an essay has no condition to meet`);
  if (profile !== CC_PROFILES.essay && conditions.length === 0) problems.push(`${where}: no condition scores the right answer`);
  for (const v of descend(processing, "varequal")) {
    if (!respidents.has(attr(v, "respident"))) problems.push(`${where}: a condition refers to ${attr(v, "respident")}, which is not the response`);
    if (lids.length > 0 && !labels.has(allText(v).trim())) problems.push(`${where}: a condition refers to the label ${allText(v)}, which is not offered`);
  }
  for (const c of conditions) {
    if (attr(c, "continue") !== "No") problems.push(`${where}: a condition does not stop at the first met`);
    const sets = elements(c, "setvar");
    if (sets.length !== 1 || attr(sets[0] as XmlElement, "action") !== "Set" || attr(sets[0] as XmlElement, "varname") !== "SCORE" || allText(sets[0] as XmlElement) !== "100") problems.push(`${where}: a right answer sets SCORE to 100`);
  }
  return problems;
}

describe("the package", () => {
  test("is a zip with a manifest at the root and the quiz in the quiz folder, and nothing else", () => {
    const pack = unpack([MC]);
    assert.deepEqual([...pack.files.keys()].sort(), ["imsmanifest.xml", "quiz/qti-assessment.xml"]);
    assert.deepEqual(specProblems(pack), []);
  });

  test("lists the quiz in the organization under the bank's name, and names the resource of the Common Cartridge type", () => {
    const pack = unpack([MC], 'Week 1: "Planets" & <more>');
    const item = descend(pack.manifest, "item").find((i) => attr(i, "identifierref") !== "") as XmlElement;
    assert.equal(allText(first(item, "title") as XmlElement), 'Week 1: "Planets" & <more>');
    assert.equal(attr(descend(pack.manifest, "resource")[0] as XmlElement, "type"), "imsqti_xmlv1p2/imscc_xmlv1p3/assessment");
    assert.equal(attr(elements(pack.doc, "assessment")[0] as XmlElement, "title"), 'Week 1: "Planets" & <more>');
  });

  test("makes the quiz an exam with no limit on attempts, which are the course's to set", () => {
    const own = fieldsOf(first(elements(unpack([MC]).doc, "assessment")[0] as XmlElement, "qtimetadata") as XmlElement);
    assert.equal(own.get("cc_profile"), "cc.exam.v0p1");
    assert.equal(own.get("qmd_assessmenttype"), "Examination");
    assert.equal(own.get("cc_maxattempts"), "unlimited");
  });

  test("is written as UTF-8 XML with a declaration, and keeps an item at its place in the bank", () => {
    const pack = unpack([MC, make("numeric", { mode: "exact", value: 1 }, "Number?"), make("multipleChoice", { shuffle: true, options: [opt("o1", "Café", true), opt("o2", "Théâtre")] }, "Où est le café?")]);
    assert.ok(pack.text(CC_ASSESSMENT_FILE).startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(pack.text("imsmanifest.xml").startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.deepEqual(itemsOf(pack).map((i) => attr(i, "ident")), ["q1", "q3"]);
    assert.equal(mattext(itemsOf(pack)[1] as XmlElement).text, "Où est le café?");
  });
});

describe("what each kind of question becomes", () => {
  test("a multiple choice question: its profile, its points as the weighting, and 100 for the right label only", () => {
    const item = itemsOf(unpack([MC]))[0] as XmlElement;
    assert.equal(profileOf(item), "cc.multiple_choice.v0p1");
    assert.equal(weightOf(item), 1);
    const labels = labelsOf(item);
    assert.deepEqual(labels.map((l) => l.text), ["Berlin", "Paris", "Rome"]);
    for (const l of labels) assert.equal(grade(item, { q1_resp: [l.ident] }), l.text === "Paris" ? 100 : 0, l.text);
    assert.equal(grade(item, { q1_resp: [] }), 0);
  });

  test("a multiple answer question scores only for exactly the right set", () => {
    const item = itemsOf(unpack([MA]))[0] as XmlElement;
    assert.equal(profileOf(item), "cc.multiple_response.v0p1");
    const labels = labelsOf(item);
    const right = new Set(["Red", "Blue"]);
    for (const chosen of subsets(labels)) {
      const exact = chosen.length === right.size && chosen.every((l) => right.has(l.text));
      assert.equal(grade(item, { q1_resp: chosen.map((l) => l.ident) }), exact ? 100 : 0, chosen.map((l) => l.text).join("+") || "nothing");
    }
  });

  test("a true or false question has the labels True and False and scores the right one", () => {
    for (const correct of [true, false]) {
      const item = itemsOf(unpack([make("trueFalse", { correct }, `Statement ${correct}.`)]))[0] as XmlElement;
      assert.equal(profileOf(item), "cc.true_false.v0p1");
      const labels = labelsOf(item);
      assert.deepEqual(labels.map((l) => l.text), ["True", "False"]);
      for (const l of labels) assert.equal(grade(item, { q1_resp: [l.ident] }), (l.text === "True") === correct ? 100 : 0, `${correct}: ${l.text}`);
    }
  });

  test("a short answer is a fill in the blank with a condition for each accepted answer, and the case rule", () => {
    const item = itemsOf(unpack([SA]))[0] as XmlElement;
    assert.equal(profileOf(item), "cc.fib.v0p1");
    assert.equal(grade(item, { q1_resp: ["Paris"] }), 100);
    assert.equal(grade(item, { q1_resp: ["PARIS, FRANCE"] }), 100, "case does not count");
    assert.equal(grade(item, { q1_resp: ["London"] }), 0);
    assert.equal(descend(item, "varequal").length, 2, "Paris is written once");
    assert.equal(itemOf(SA).asType, "fill in the blank");
    assert.match(itemOf(SA).notes.join(" "), /only typed-answer question/);

    const exact = itemsOf(unpack([FIB]))[0] as XmlElement;
    assert.equal(grade(exact, { q1_resp: ["Quartz"] }), 100);
    assert.equal(grade(exact, { q1_resp: ["quartz"] }), 0, "a question that counts case does");
    assert.match(itemOf(FIB).notes.join(" "), /one answer box under its text/);
  });

  test("an essay has an answer box of several rows and no condition, so it is marked by hand", () => {
    const pack = unpack([ESS]);
    const item = itemsOf(pack)[0] as XmlElement;
    assert.equal(profileOf(item), "cc.essay.v0p1");
    assert.equal(grade(item, { q1_resp: ["A long answer."] }), 0);
    assert.equal(descend(item, "respcondition").length, 0);
    assert.deepEqual(specProblems(pack), []);
  });

  test("points are carried as the weighting, whole or not, and the right answer is always 100", () => {
    for (const points of [1, 2, 5, 0.5, 2.25]) {
      const q = make("multipleChoice", { shuffle: true, options: [opt("o1", "A", true), opt("o2", "B")] }, `Worth ${points}?`, { points });
      const pack = unpack([q]);
      const item = itemsOf(pack)[0] as XmlElement;
      assert.equal(weightOf(item), points);
      assert.equal(grade(item, { q1_resp: [labelsOf(item)[0]?.ident as string] }), 100);
      assert.deepEqual(specProblems(pack), []);
    }
  });

  test("the answers are mixed unless the question keeps them in order", () => {
    assert.equal(attr(descend(itemsOf(unpack([MC]))[0] as XmlElement, "render_choice")[0] as XmlElement, "shuffle"), "Yes");
    const fixed = make("multipleChoice", { shuffle: false, options: [opt("o1", "A", true), opt("o2", "B")] }, "Which?");
    assert.equal(attr(descend(itemsOf(unpack([fixed]))[0] as XmlElement, "render_choice")[0] as XmlElement, "shuffle"), "No");
    const some = make("multipleChoice", { shuffle: true, options: [opt("o1", "A", true), { ...opt("o2", "None of the above"), fixedPosition: true }] }, "Which?");
    assert.match(itemOf(some).notes.join(" "), /fixed in place and others are mixed/);
    assert.equal(attr(descend(itemsOf(unpack([some]))[0] as XmlElement, "render_choice")[0] as XmlElement, "shuffle"), "No", "none is mixed, since the file cannot keep one answer in place and mix the others");
  });
});

describe("what is left out, and why", () => {
  test("matching, ordering, numeric, hotspot and calculated questions are not written, with where to put them", () => {
    assert.equal(itemOf(MAT).outcome, "leftOut");
    assert.match(itemOf(MAT).notes.join(" "), /profile has no matching question.*QTI 1\.2 package and Brightspace's CSV carry matching/);
    assert.equal(itemOf(ORD).outcome, "leftOut");
    assert.match(itemOf(ORD).notes.join(" "), /profile has no ordering question.*CSV carries ordering/);
    for (const q of [make("numeric", { mode: "exact", value: 3 }, "How many?"), make("hotspot", {} as QuestionBody, "Where?"), make("calculated", {} as QuestionBody, "Compute.")]) {
      assert.equal(itemOf(q).outcome, "leftOut", q.type);
      assert.match(itemOf(q).notes.join(" "), /profile has no/, q.type);
    }
    assert.deepEqual(exportCommonCartridge([MAT, ORD]).files, [], "no file is written when nothing can be");
  });

  test("a question with no usable key is never written, and no key is guessed to fit", () => {
    const none = make("multipleChoice", { shuffle: true, options: [opt("o1", "A"), opt("o2", "B")] }, "Which?");
    const two = make("multipleChoice", { shuffle: true, options: [opt("o1", "A", true), opt("o2", "B", true)] }, "Which?");
    const noTf = make("trueFalse", {} as QuestionBody, "Is it?");
    const noAccepted = make("shortAnswer", { caseSensitive: false, accepted: [] }, "What?");
    const noneMA = make("multipleResponse", { shuffle: true, partialCredit: false, options: [opt("o1", "A"), opt("o2", "B")] }, "Which?");
    for (const q of [none, two, noTf, noAccepted, noneMA]) {
      assert.equal(itemOf(q).outcome, "leftOut", q.type);
      assert.equal(exportCommonCartridge([q]).files.length, 0);
    }
    const pack = unpack([none, MC, noTf]);
    assert.equal(itemsOf(pack).length, 1);
    assert.deepEqual(specProblems(pack), []);
  });

  test("a blank answer, one answer, two blanks and a question with no words are left out", () => {
    const empty = make("multipleChoice", { shuffle: true, options: [opt("o1", "A", true), opt("o2", "   ")] }, "Which?");
    const single = make("multipleChoice", { shuffle: true, options: [opt("o1", "A", true)] }, "Which?");
    const two = make("fillInBlank", { caseSensitive: false, blanks: [{ id: "b1", accepted: ["x"] }, { id: "b2", accepted: ["y"] }] }, "_ and _.");
    const nothing = make("trueFalse", { correct: true }, "<p> </p>");
    for (const q of [empty, single, two, nothing]) assert.equal(itemOf(q).outcome, "leftOut", q.stem.content);
    assert.match(itemOf(two).notes.join(" "), /2 blanks/);
  });
});

describe("what is lost on the way, said against the question", () => {
  test("partial credit, feedback, a model answer, a rubric and an expected length", () => {
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

  test("a multiple choice, multiple answer, true or false and essay question with plain text and no feedback loses nothing", () => {
    for (const q of [MC, MA, TF, ESS]) assert.deepEqual(itemOf(q).notes, [], q.stem.content);
  });

  test("a picture or an equation is a marker in the text, and counted, never dropped", () => {
    const q = make("trueFalse", { correct: true }, '<p>See <oa-media ref="m1"></oa-media> and <oa-math ref="e1"></oa-math>.</p>', {
      media: [{ id: "m1", file: "media/m1.png", mime: "image/png", alt: "the chart" }],
      math: [{ id: "e1", latex: "x^2", mathml: "<math></math>" }],
    });
    const m = mattext(itemsOf(unpack([q]))[0] as XmlElement);
    assert.match(m.text, /\[Picture: the chart\]/);
    assert.match(m.text, /\[Equation: x\^2\]/);
    assert.match(itemOf(q).notes.join(" "), /1 picture cannot be carried/);
  });
});

describe("text", () => {
  test("markup, quotes, ampersands and angle brackets in the text come back as they were written", () => {
    const stem = 'Is 5 < 7 && x > 3 "always" true? ]]> <b>no</b> \'yes\'';
    const q = make("multipleChoice", { shuffle: true, options: [opt("o1", 'a < b & "c"', true), opt("o2", "]]> <script>x</script>")] }, stem);
    const pack = unpack([q]);
    assert.deepEqual(specProblems(pack), []);
    const item = itemsOf(pack)[0] as XmlElement;
    assert.equal(mattext(item).text, stem);
    assert.deepEqual(labelsOf(item).map((l) => l.text), ['a < b & "c"', "]]> <script>x</script>"]);
    assert.doesNotMatch(pack.text(CC_ASSESSMENT_FILE), /<script>/);
  });

  test("control characters that XML cannot hold are dropped, and the rest of the text stays", () => {
    const pack = unpack([make("trueFalse", { correct: true }, "Bell\u0007 and\u0000 null\u001b? Tab\there.")]);
    assert.deepEqual(specProblems(pack), []);
    assert.match(mattext(itemsOf(pack)[0] as XmlElement).text, /^Bell and null\? Tab here\.$/);
  });

  test("a formatted question keeps its formatting in the text, and a plain answer stays plain", () => {
    const q = make("multipleChoice", { shuffle: true, options: [{ id: "o1", content: rich("<strong>Bold</strong> answer"), correct: true }, opt("o2", "Plain answer")] }, "<p>A <strong>bold</strong> claim.</p>");
    const item = itemsOf(unpack([q]))[0] as XmlElement;
    assert.match(mattext(item).raw, /<strong>bold<\/strong>/);
    const [a, b] = descend(item, "response_label");
    assert.equal(mattext(a as XmlElement).type, "text/html");
    assert.equal(mattext(b as XmlElement).type, "text/plain");
  });
});

describe("the file and the check", () => {
  test("names the file for the bank, makes the name safe, and reports every question once, in order", () => {
    const result = exportCommonCartridge([MC, MAT, TF], { name: 'Week 1: "Planets"?' });
    assert.deepEqual(result.files.map((f) => f.name), ["Week 1- -Planets-- - Common Cartridge.imscc"]);
    assert.equal(result.files[0]?.questions, 2);
    assert.equal(result.files[0]?.content, "");
    assert.deepEqual(result.report.items.map((i) => [i.position, i.outcome]), [[1, "exported"], [2, "leftOut"], [3, "exported"]]);
    assert.equal(result.report.destination, COMMON_CARTRIDGE_ID);
    assert.deepEqual([result.report.exported, result.report.exportedWithLosses, result.report.leftOut], [2, 0, 1]);
  });

  test("tells a person where to import it, that attempts are unlimited, and which questions it cannot hold", () => {
    const general = checkCommonCartridge([MC]).general.join(" ");
    assert.match(general, /Course tools, Import\/Export\/Copy Components, Import Components, from a course package/);
    assert.match(general, /Import All Components/);
    assert.match(general, /Importing twice makes two/);
    assert.match(general, /unlimited attempts/);
    assert.match(general, /Matching goes in the QTI 1\.2 package or Brightspace's CSV, and ordering in the CSV/);
  });

  test("a bank with nothing it can write, and an empty bank, give no file", () => {
    assert.deepEqual(exportCommonCartridge([MAT]).files, []);
    assert.deepEqual(exportCommonCartridge([]).files, []);
  });
});

describe("the command line", () => {
  test("`export --to common-cartridge` writes a zip a second reader can open, and says what it would do without --out", () => {
    const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
    const source = fileURLToPath(new URL("../../../fixtures/standard-format/01-clean-multiple-choice.txt", import.meta.url));
    const folder = mkdtempSync(join(tmpdir(), "oa-cc-"));
    try {
      const run = (...args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, ...args], { encoding: "utf8" });
      const bank = join(folder, "bank.openassess");
      assert.equal(run("import", source, "--out", bank).status, 0);

      const dry = run("export", bank, "--to", "common-cartridge");
      assert.equal(dry.status, 0, dry.stderr);
      assert.match(dry.stdout, /Destination check: Common Cartridge 1\.3 package/);
      assert.match(dry.stdout, /Nothing was written/);
      assert.deepEqual(readdirSync(folder), ["bank.openassess"]);

      const out = join(folder, "out");
      assert.equal(run("export", bank, "--to", "common-cartridge", "--out", out).status, 0);
      const [name] = readdirSync(out);
      assert.match(name ?? "", / - Common Cartridge\.imscc$/);
      const bytes = new Uint8Array(readFileSync(join(out, name as string)));
      assert.equal(String.fromCharCode(bytes[0] as number, bytes[1] as number), "PK");
      assert.deepEqual(specProblems(readPackage(bytes, CC_ASSESSMENT_FILE)), []);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("a package against the format's own description", () => {
  test("every kind of question it holds, together, satisfies it", () => {
    const all = [MC, MA, TF, SA, FIB, ESS, make("trueFalse", { correct: true }, "<p>A <em>formatted</em> one.</p>", { points: 7, title: "Titled" })];
    const pack = unpack(all);
    assert.deepEqual(specProblems(pack), []);
    assert.equal(itemsOf(pack).length, all.length);
  });

  test("the checker does notice what is wrong with a package (so that passing it means something)", () => {
    const pack = unpack([MC, MA, SA, ESS]);
    const mutate = (from: string | RegExp, to: string): Pack => {
      const assessment = pack.text(CC_ASSESSMENT_FILE).replace(from, to);
      assert.notEqual(assessment, pack.text(CC_ASSESSMENT_FILE), `the mutation ${String(from)} changed nothing`);
      const files = new Map(pack.files);
      files.set(CC_ASSESSMENT_FILE, new Uint8Array(Buffer.from(assessment, "utf8")));
      return { ...pack, files, doc: parseXml(assessment), text: (n: string) => (n === CC_ASSESSMENT_FILE ? assessment : pack.text(n)) };
    };
    assert.ok(specProblems(mutate("cc.multiple_choice.v0p1", "cc.invented.v0p1")).length > 0, "a profile the format does not hold");
    assert.ok(specProblems(mutate("cc.exam.v0p1", "cc.quiz.v0p1")).length > 0, "an assessment that is not an exam");
    assert.ok(specProblems(mutate(/<(\/?)section\b/g, "<$1sectionx")).length > 0, "no section");
    assert.ok(specProblems(mutate(/maxvalue="100"/, 'maxvalue="5"')).length > 0, "SCORE that does not run to 100");
    assert.ok(specProblems(mutate(/(<setvar action="Set" varname="SCORE">)100/, "$11")).length > 0, "a right answer worth one, not 100");
    assert.ok(specProblems(mutate(/<fieldlabel>cc_weighting<\/fieldlabel><fieldentry>1</, "<fieldlabel>cc_weighting</fieldlabel><fieldentry>0<")).length > 0, "no weight");
    assert.ok(specProblems(mutate(/(<varequal respident="q1_resp">)q1_a2/, "$1q1_a9")).length > 0, "a condition that names a label that is not offered");
    assert.ok(specProblems(mutate('fibtype="String" prompt="Box" rows="15"', 'fibtype="String" prompt="Box" rows="1"')).length > 0, "an essay with one row");
    const badManifest = (from: string, to: string): Pack => ({ ...pack, text: (n: string) => (n === "imsmanifest.xml" ? pack.text(n).replace(from, to) : pack.text(n)), manifest: parseXml(pack.text("imsmanifest.xml").replace(from, to)) });
    assert.ok(specProblems(badManifest("imsqti_xmlv1p2/imscc_xmlv1p3/assessment", "imsqti_xmlv1p2")).length > 0, "the plain QTI resource type");
    assert.ok(specProblems(badManifest("http://www.imsglobal.org/xsd/imsccv1p3/imscp_v1p1", "http://www.imsglobal.org/xsd/imscp_v1p1")).length > 0, "the plain content packaging namespace");
    assert.ok(specProblems(badManifest("<schemaversion>1.3.0", "<schemaversion>1.1.0")).length > 0, "the wrong cartridge version");
    assert.ok(specProblems(badManifest('identifierref="resource_1"', 'identifierref="resource_9"')).length > 0, "an organization that lists a resource that is not there");
    const missing = { ...pack, files: new Map([...pack.files].filter(([n]) => n !== CC_ASSESSMENT_FILE)) };
    assert.ok(specProblems(missing).length > 0, "the resource's file is not in the zip");
  });

  test("the response processor does notice a wrong key (so that a right key means something)", () => {
    const text = unpack([MC]).text(CC_ASSESSMENT_FILE).replace(/(<varequal respident="q1_resp">)q1_a2/, "$1q1_a1");
    const edited = itemsOf({ ...unpack([MC]), doc: parseXml(text) })[0] as XmlElement;
    const labels = labelsOf(edited);
    assert.equal(grade(edited, { q1_resp: [(labels.find((l) => l.text === "Paris") as { ident: string }).ident] }), 0);
    assert.equal(grade(edited, { q1_resp: [(labels.find((l) => l.text === "Berlin") as { ident: string }).ident] }), 100);
  });

  /** For every question that was written: the key the bank holds, found by the words of the answers, is what scores 100, and nothing else does. */
  function verifyKeys(questions: Question[], outcomes: string[], pack: Pack, name: string): number {
    const items = itemsOf(pack);
    const written = questions.filter((_q, i) => outcomes[i] !== "leftOut");
    assert.equal(items.length, written.length, name);
    const plain = (t: unknown): string => richTextToPlain(t as never).replace(/\s+/g, " ").trim();
    written.forEach((q, i) => {
      const item = items[i] as XmlElement;
      const where = `${name}: ${q.title}`;
      assert.equal(weightOf(item), q.points, where);
      const body = q.body as unknown as { options?: Array<{ content: unknown; correct: boolean }>; correct?: boolean; accepted?: string[]; blanks?: Array<{ accepted: string[] }> };
      // The response's name is read from the item, not worked out: an item keeps its place in the bank, so a question left out
      // before it leaves a gap in the numbers.
      const resp = attr((descend(item, "response_lid")[0] ?? descend(item, "response_str")[0]) as XmlElement, "ident");
      if (q.type === "multipleChoice") {
        const right = (body.options ?? []).filter((o) => o.correct).map((o) => plain(o.content));
        for (const l of labelsOf(item)) assert.equal(grade(item, { [resp]: [l.ident] }), right.includes(l.text) ? 100 : 0, `${where} / ${l.text}`);
      } else if (q.type === "multipleResponse") {
        const right = new Set((body.options ?? []).filter((o) => o.correct).map((o) => plain(o.content)));
        for (const chosen of subsets(labelsOf(item))) {
          const exact = chosen.length === right.size && chosen.every((l) => right.has(l.text));
          assert.equal(grade(item, { [resp]: chosen.map((l) => l.ident) }), exact ? 100 : 0, `${where} / ${chosen.map((l) => l.text).join("+")}`);
        }
      } else if (q.type === "trueFalse") {
        for (const l of labelsOf(item)) assert.equal(grade(item, { [resp]: [l.ident] }), (l.text === "True") === body.correct ? 100 : 0, where);
      } else if (q.type === "shortAnswer" || q.type === "fillInBlank") {
        const accepted = q.type === "shortAnswer" ? (body.accepted ?? []) : (body.blanks?.[0]?.accepted ?? []);
        for (const a of accepted.map((x) => x.replace(/\s+/g, " ").trim()).filter((x) => x !== "")) assert.equal(grade(item, { [resp]: [a] }), 100, `${where} / ${a}`);
        assert.equal(grade(item, { [resp]: ["zzz not an answer zzz"] }), 0, where);
      }
    });
    return written.length;
  }

  test("every bank in the fixtures, read by its importer and exported, satisfies it, and every key scores", () => {
    const folder = join(fileURLToPath(new URL("../../../fixtures/standard-format/", import.meta.url)));
    let files = 0;
    let questions = 0;
    for (const name of readdirSync(folder).filter((n) => /\.(txt|docx)$/.test(n))) {
      const bytes = new Uint8Array(readFileSync(join(folder, name)));
      const result = runImporter(importerForContent(name, bytes), bytes, { file: name, at: AT, author: "test" });
      const exported = exportCommonCartridge(result.questions, { name });
      if (exported.files.length === 0) continue;
      files++;
      const pack = readPackage(exported.files[0]?.bytes, CC_ASSESSMENT_FILE);
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
      const exported = exportCommonCartridge(result.questions, { name });
      if (exported.files.length === 0) continue;
      const pack = readPackage(exported.files[0]?.bytes, CC_ASSESSMENT_FILE);
      assert.deepEqual(specProblems(pack), [], name);
      questions += verifyKeys(result.questions, exported.report.items.map((i) => i.outcome), pack, name);
    }
    assert.ok(questions > 0);
  });
});
