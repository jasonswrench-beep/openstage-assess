/**
 * Export as a QTI 2.1 package. The rules under test are the ones every exporter keeps (a question whose key is missing is never
 * written and no key is guessed, nothing is lost without being said against the question, what cannot be written is left out and
 * why) and the ones this format has: a zip with a manifest, a test that lists the questions, a file for each question whose markup is
 * XHTML, and response processing in the standard's own operators.
 *
 * Two readers written apart from the exporter stand behind these tests (`support/qti21-reader.ts`). `problems` reads a package
 * against the structure the standard and the IMS packaging rules describe. `grade` is a small QTI 2.1 response processor: it takes
 * the values a student could give and runs the item's own processing. A question is right when exactly its key scores its points and
 * nothing else does, for every answer a student could give where that can be counted. Neither can say that Canvas or Brightspace
 * will accept the package: only they can, and that is a check for a person with a course (TESTING-TODO.md).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { zipSync } from "../src/container/zip.ts";
import { checkQti21, exportQti21 } from "../src/export/qti21.ts";
import { importerForContent, runImporter } from "../src/import/registry.ts";
import { parseXml, type XmlElement } from "../src/import/docx/xml.ts";
import { createQuestion } from "../src/model/create.ts";
import type { MathRef, Question, QuestionBody, QuestionType } from "../src/model/question.ts";
import { mathPlaceholder, mediaPlaceholder, plainToRich, rich, richTextToPlain } from "../src/model/richtext.ts";
import { attr, choicesOf, descend, grade, pointsOf, problems, readPackage21, setsOf, subsets, wordsOf, type Pack21 } from "./support/qti21-reader.ts";
import { jpeg, png } from "./support/images.ts";

const AT = "2026-01-01T00:00:00.000Z";
const opt = (id: string, text: string, correct = false, extra: { fixedPosition?: boolean; feedback?: string } = {}) => ({
  id,
  content: plainToRich(text),
  correct,
  ...(extra.fixedPosition ? { fixedPosition: true } : {}),
  ...(extra.feedback ? { feedback: plainToRich(extra.feedback) } : {}),
});
let made = 0;
const make = (type: QuestionType, body: QuestionBody, stem: string, extra: Partial<Parameters<typeof createQuestion>[0]> = {}): Question =>
  createQuestion({ type, stem: stem.startsWith("<") ? rich(stem) : plainToRich(stem), body, by: "t", at: AT, id: `q_${String(++made).padStart(26, "0")}`, ...extra });

const MC = make("multipleChoice", { shuffle: true, options: [opt("o1", "Berlin"), opt("o2", "Paris", true), opt("o3", "Rome")] }, "What is the capital of France?");
const MA = make("multipleResponse", { shuffle: true, partialCredit: false, options: [opt("o1", "Red", true), opt("o2", "Green"), opt("o3", "Blue", true), opt("o4", "Pink")] }, "Which are primary colours?", { points: 2 });
const MAP = make("multipleResponse", { shuffle: true, partialCredit: true, options: [opt("o1", "Red", true), opt("o2", "Green"), opt("o3", "Blue", true), opt("o4", "Pink"), opt("o5", "Yellow", true)] }, "Which are primary colours, with credit for part?", { points: 3 });
const TF = make("trueFalse", { correct: false }, "A light-year is a measure of time.");
const SA = make("shortAnswer", { caseSensitive: false, accepted: ["Paris", "paris, france", "PARIS"] }, "What is the capital of France?");
const FIB = make("fillInBlank", { caseSensitive: true, blanks: [{ id: "b1", accepted: ["Quartz"] }] }, "___ is the hardest common mineral.");
const MAT = make(
  "matching",
  { shuffle: true, distractors: ["Quack"], pairs: [{ id: "p1", left: plainToRich("Dog"), right: "Bark" }, { id: "p2", left: plainToRich("Cat"), right: "Meow" }, { id: "p3", left: plainToRich("Cow"), right: "Moo" }] },
  "Match the animal to its sound.",
  { points: 2 },
);
const ESS = make("essay", {}, "Discuss.");

// ---------------------------------------------------------------------------
// Reading a package
// ---------------------------------------------------------------------------

const unpack = (questions: Question[], name = "Test", media?: Map<string, Uint8Array>): Pack21 => readPackage21(exportQti21(questions, { name, ...(media ? { media } : {}) }).files[0]?.bytes);
const itemOf = (question: Question, media?: Map<string, Uint8Array>): XmlElement => (unpack([question], "Test", media).items[0] as { doc: XmlElement }).doc;
const outcomeOf = (question: Question) => checkQti21([question]).items[0] as NonNullable<ReturnType<typeof checkQti21>["items"][0]>;
const R = (...v: string[]) => ({ RESPONSE: v });
/** Shares of the points are written to five decimals and the last is what is left, so two ways of getting the same part right can differ by a hundred-thousandth. */
const close = (actual: number, expected: number, message?: string): void => assert.ok(Math.abs(actual - expected) < 0.00003, `${message ?? ""}: ${actual} is not ${expected}`);

describe("the package", () => {
  test("is a zip with a manifest, a test that lists the questions, and a file for each question", () => {
    const pack = unpack([MC, TF]);
    assert.deepEqual([...pack.files.keys()].sort(), ["assessmentTest.xml", "imsmanifest.xml", "q1.xml", "q2.xml"]);
    assert.deepEqual(problems(pack), []);
    const types = descend(pack.manifest, "resource").map((r) => attr(r, "type"));
    assert.deepEqual(types, ["imsqti_test_xmlv2p1", "imsqti_item_xmlv2p1", "imsqti_item_xmlv2p1"]);
  });

  test("has an assessment with the bank's name, and an item for each question written, keeping its place in the bank", () => {
    const pack = unpack([MC, TF, make("numeric", { mode: "exact", value: 1 }, "Number?"), SA], 'Week 1: "Planets" & <more>');
    assert.equal(attr(pack.test, "title"), 'Week 1: "Planets" & <more>');
    assert.deepEqual(pack.items.map((i) => attr(i.ref, "identifier")), ["q1", "q2", "q4"], "an item keeps its place in the bank, so a question left out leaves a gap");
    assert.deepEqual(problems(pack), []);
  });

  test("adds the scores of the questions up at the test level", () => {
    const text = unpack([MC, TF]).text("assessmentTest.xml");
    assert.match(text, /<outcomeDeclaration identifier="SCORE" cardinality="single" baseType="float"\/>/);
    assert.match(text, /<sum><testVariables variableIdentifier="SCORE"\/><\/sum>/);
  });

  test("is written as UTF-8 XML with a declaration, and the namespaces of QTI 2.1", () => {
    const pack = unpack([make("multipleChoice", { shuffle: true, options: [opt("o1", "Café", true), opt("o2", "Théâtre")] }, "Où est le café?")]);
    for (const name of ["imsmanifest.xml", "assessmentTest.xml", "q1.xml"]) assert.ok(pack.text(name).startsWith('<?xml version="1.0" encoding="UTF-8"?>'), name);
    assert.match(pack.text("q1.xml"), /xmlns="http:\/\/www\.imsglobal\.org\/xsd\/imsqti_v2p1"/);
    assert.match(pack.text("q1.xml"), /Où est le café\?/);
    assert.deepEqual(problems(pack), []);
  });
});

describe("how each question is scored (run by a QTI response processor)", () => {
  test("a multiple choice question is worth its points for the right choice and nothing for any other", () => {
    const item = itemOf(MC);
    const choices = choicesOf(item);
    assert.deepEqual(choices.map((c) => c.text), ["Berlin", "Paris", "Rome"]);
    for (const c of choices) assert.equal(grade(item, R(c.id)), c.text === "Paris" ? 1 : 0, c.text);
    assert.equal(grade(item, {}), 0, "no answer scores nothing");
    assert.equal(attr(descend(item, "choiceInteraction")[0] as XmlElement, "shuffle"), "true");
  });

  test("a multiple answer question that is all or nothing scores only for exactly the right set", () => {
    const item = itemOf(MA);
    const choices = choicesOf(item);
    assert.equal(attr(descend(item, "choiceInteraction")[0] as XmlElement, "maxChoices"), "0", "any number of choices");
    for (const chosen of subsets(choices)) {
      const exact = chosen.length === 2 && chosen.every((c) => c.text === "Red" || c.text === "Blue");
      assert.equal(grade(item, R(...chosen.map((c) => c.id))), exact ? 2 : 0, chosen.map((c) => c.text).join("+"));
    }
  });

  test("a multiple answer question with partial credit scores what the bank itself scores, for every set of choices", () => {
    const item = itemOf(MAP);
    const choices = choicesOf(item);
    const right = new Set(["Red", "Blue", "Yellow"]);
    for (const chosen of subsets(choices)) {
      const good = chosen.filter((c) => right.has(c.text)).length;
      const bad = chosen.length - good;
      const expected = good === right.size && bad === 0 ? 3 : (Math.max(0, good - bad) / right.size) * 3;
      close(grade(item, R(...chosen.map((c) => c.id))), expected, chosen.map((c) => c.text).join("+") || "(nothing)");
    }
    assert.deepEqual(outcomeOf(MAP).notes, [], "carrying partial credit is not a loss");
  });

  test("a true or false question has the choices True and False and scores the right one", () => {
    const item = itemOf(TF);
    const choices = choicesOf(item);
    assert.deepEqual(choices.map((c) => c.text), ["True", "False"]);
    for (const c of choices) assert.equal(grade(item, R(c.id)), c.text === "False" ? 1 : 0);
    const yes = itemOf(make("trueFalse", { correct: true }, "Water is wet."));
    for (const c of choicesOf(yes)) assert.equal(grade(yes, R(c.id)), c.text === "True" ? 1 : 0);
  });

  test("a short answer scores each accepted answer, ignoring case unless the question counts it, and an answer that is not accepted scores nothing", () => {
    const item = itemOf(SA);
    for (const given of ["Paris", "paris", "PARIS", "Paris, France", "paris, france"]) assert.equal(grade(item, R(given)), 1, given);
    for (const given of ["Lyon", "Pari", "Paris, Texas", ""]) assert.equal(grade(item, R(given)), 0, given);
    assert.equal(grade(item, {}), 0);
    const keys = descend(item, "mapEntry").map((e) => attr(e, "mapKey"));
    assert.deepEqual(keys, ["Paris", "paris, france"], "answers that differ only in case are one answer when case does not count");

    const strict = itemOf(FIB);
    assert.equal(grade(strict, R("Quartz")), 1);
    assert.equal(grade(strict, R("quartz")), 0, "this one counts case");
    assert.equal(grade(strict, R("QUARTZ")), 0);
  });

  test("a short answer that counts case keeps two answers that differ only in case", () => {
    const item = itemOf(make("shortAnswer", { caseSensitive: true, accepted: ["Us", "US"] }, "The country?"));
    assert.equal(grade(item, R("Us")), 1);
    assert.equal(grade(item, R("US")), 1);
    assert.equal(grade(item, R("us")), 0);
  });

  test("a matching question is a share of its points for each right match, so half right is worth half, for every way of matching", () => {
    const item = itemOf(MAT);
    const [lefts, rights] = setsOf(item) as [ReturnType<typeof setsOf>[0], ReturnType<typeof setsOf>[0]];
    assert.deepEqual(lefts.map((l) => l.text), ["Dog", "Cat", "Cow"]);
    assert.deepEqual(rights.map((r) => r.text), ["Bark", "Meow", "Moo", "Quack"], "the spare answer is offered too");
    const sound: Record<string, string> = { Dog: "Bark", Cat: "Meow", Cow: "Moo" };
    // Every way of giving each left side one right side or none: 5 x 5 x 5.
    const options = [undefined, ...rights];
    let ways = 0;
    for (const a of options) for (const b of options) for (const c of options) {
      const picks = [a, b, c];
      const given = picks.flatMap((r, i) => (r ? [`${(lefts[i] as { id: string }).id} ${r.id}`] : []));
      const right = picks.filter((r, i) => r && sound[(lefts[i] as { text: string }).text] === r.text).length;
      close(grade(item, R(...given)), (right * 2) / 3, given.join(", "));
      ways++;
    }
    assert.equal(ways, 125);
    assert.equal(grade(item, R(...lefts.map((l, i) => `${l.id} ${(rights[i] as { id: string }).id}`))), 2, "all right is exactly the points, not 1.99999");
  });

  test("a left side takes one answer and a right side may take every left side, so the shape of the question does not show", () => {
    const item = itemOf(MAT);
    const [lefts, rights] = setsOf(item) as [ReturnType<typeof setsOf>[0], ReturnType<typeof setsOf>[0]];
    assert.ok(lefts.every((l) => l.matchMax === 1));
    assert.ok(rights.every((r) => r.matchMax === 3));
    assert.equal(attr(descend(item, "matchInteraction")[0] as XmlElement, "maxAssociations"), "3");
  });

  test("two pairs with the same right side share one choice", () => {
    const item = itemOf(make("matching", { shuffle: false, distractors: [], pairs: [{ id: "p1", left: plainToRich("Lion"), right: "Mammal" }, { id: "p2", left: plainToRich("Whale"), right: "Mammal" }, { id: "p3", left: plainToRich("Trout"), right: "Fish" }] }, "Group them."));
    const [lefts, rights] = setsOf(item) as [ReturnType<typeof setsOf>[0], ReturnType<typeof setsOf>[0]];
    assert.deepEqual(rights.map((r) => r.text), ["Mammal", "Fish"]);
    const mammal = (rights[0] as { id: string }).id;
    const fish = (rights[1] as { id: string }).id;
    assert.equal(grade(item, R(`${(lefts[0] as { id: string }).id} ${mammal}`, `${(lefts[1] as { id: string }).id} ${mammal}`, `${(lefts[2] as { id: string }).id} ${fish}`)), 1);
    assert.equal(grade(item, R(`${(lefts[0] as { id: string }).id} ${fish}`)), 0);
    assert.equal(attr(descend(item, "matchInteraction")[0] as XmlElement, "shuffle"), "false");
  });

  test("an essay can score nothing by itself, so it is marked by hand: there is no response processing and no correct response", () => {
    const item = itemOf(ESS);
    assert.equal(descend(item, "responseProcessing").length, 0);
    assert.equal(descend(item, "correctResponse").length, 0);
    assert.equal(descend(item, "extendedTextInteraction").length, 1);
    assert.equal(grade(item, R("a long answer")), 0);
  });

  test("points are carried: as the top of SCORE and as what a right answer sets, fractions included", () => {
    for (const points of [1, 2, 5, 0.5, 2.5, 0.25]) {
      const q = make("multipleChoice", { shuffle: false, options: [opt("o1", "A", true), opt("o2", "B")] }, "Pick.", { points });
      const item = itemOf(q);
      assert.equal(pointsOf(item), points);
      assert.equal(grade(item, R((choicesOf(item)[0] as { id: string }).id)), points);
    }
  });

  test("an answer that stays in place when the others are mixed is said so, answer by answer", () => {
    const q = make("multipleChoice", { shuffle: true, options: [opt("o1", "Berlin"), opt("o2", "Paris", true), opt("o3", "All of the above", false, { fixedPosition: true })] }, "Capital?");
    const item = itemOf(q);
    assert.deepEqual(choicesOf(item).map((c) => c.fixed), [false, false, true]);
    assert.deepEqual(outcomeOf(q).notes, [], "this format can say it exactly, so nothing is lost");
    const unmixed = itemOf(make("multipleChoice", { shuffle: false, options: [opt("o1", "A", true, { fixedPosition: true }), opt("o2", "B")] }, "Pick."));
    assert.equal(attr(descend(unmixed, "choiceInteraction")[0] as XmlElement, "shuffle"), "false");
    assert.deepEqual(choicesOf(unmixed).map((c) => c.fixed), [false, false], "fixed means nothing in a list that is not mixed");
  });
});

describe("what is left out, and why", () => {
  test("an ordering, a numeric, a hotspot and a calculated question are not written, each with its reason", () => {
    const cases: Array<[QuestionType, QuestionBody, RegExp]> = [
      ["ordering", { items: [{ id: "i1", content: plainToRich("a"), position: 1 }, { id: "i2", content: plainToRich("b"), position: 2 }] } as never, /ordering/],
      ["numeric", { mode: "exact", value: 1 } as never, /numeric/],
      ["hotspot", { regions: [] } as never, /hotspot/],
      ["calculated", {} as never, /calculated/],
    ];
    for (const [type, body, pattern] of cases) {
      const item = outcomeOf(make(type, body, "Whatever?"));
      assert.equal(item.outcome, "leftOut", type);
      assert.match(item.notes.join(" "), pattern);
    }
  });

  test("a question with no usable key is never written, and no key is guessed to fit", () => {
    const keyless = [
      make("multipleChoice", { shuffle: true, options: [opt("o1", "A"), opt("o2", "B")] }, "No key?"),
      make("multipleChoice", { shuffle: true, options: [opt("o1", "A", true), opt("o2", "B", true)] }, "Two keys on a single choice?"),
      make("trueFalse", {} as never, "Neither?"),
      make("shortAnswer", { caseSensitive: false, accepted: [] }, "Nothing accepted?"),
    ];
    const result = exportQti21(keyless);
    assert.deepEqual(result.files, []);
    assert.deepEqual(result.report.items.map((i) => i.outcome), ["leftOut", "leftOut", "leftOut", "leftOut"]);
  });

  test("a blank answer, one answer, two blanks, and a pair with a side missing are left out", () => {
    const cases = [
      make("multipleChoice", { shuffle: true, options: [opt("o1", "A", true), opt("o2", "")] }, "Blank option?"),
      make("multipleChoice", { shuffle: true, options: [opt("o1", "A", true)] }, "One option?"),
      make("fillInBlank", { caseSensitive: false, blanks: [{ id: "b1", accepted: ["a"] }, { id: "b2", accepted: ["b"] }] }, "___ and ___."),
      make("matching", { shuffle: true, distractors: [], pairs: [{ id: "p1", left: plainToRich("A"), right: "1" }, { id: "p2", left: plainToRich("B"), right: "" }] }, "Match."),
    ];
    for (const q of cases) assert.equal(outcomeOf(q).outcome, "leftOut", q.title);
    assert.match(outcomeOf(cases[2] as Question).notes.join(" "), /2 blanks/);
  });

  test("a question with no words is left out, and one that is only a picture or an equation is not", () => {
    assert.equal(outcomeOf(make("trueFalse", { correct: true }, "<p></p>")).outcome, "leftOut");
    const picture = make("trueFalse", { correct: true }, `<p>${mediaPlaceholder("m1")}</p>`, { media: [{ id: "m1", file: "media/p-1.png", mime: "image/png", alt: "A graph" }] });
    assert.notEqual(outcomeOf(picture).outcome, "leftOut");
  });
});

describe("what is lost on the way, said against the question", () => {
  test("a fill in the blank arrives as a short answer, and says so", () => {
    const item = outcomeOf(FIB);
    assert.equal(item.outcome, "exportedWithLosses");
    assert.equal(item.asType, "short answer");
    assert.match(item.notes.join(" "), /blank in it/);
  });

  test("feedback, a model answer, a rubric and an expected length are said", () => {
    const withFeedback = make("multipleChoice", { shuffle: true, options: [opt("o1", "A", true, { feedback: "Yes." }), opt("o2", "B")] }, "Pick.", { feedback: { general: plainToRich("Read chapter 2.") } });
    assert.match(outcomeOf(withFeedback).notes.join(" "), /Feedback on a single answer cannot be carried/);
    assert.match(outcomeOf(withFeedback).notes.join(" "), /Feedback cannot be carried in this package/);
    const essay = make("essay", { modelAnswer: plainToRich("An answer."), rubric: [{ id: "r1", criterion: "x", levels: [] }], expectedWords: 200 } as never, "Discuss.");
    const notes = outcomeOf(essay).notes.join(" ");
    assert.match(notes, /model answer/);
    assert.match(notes, /rubric/);
    assert.match(notes, /expected length/);
  });

  test("a question with plain text, one point and no feedback loses nothing", () => {
    for (const q of [MC, MA, MAP, TF, SA, MAT, ESS]) assert.deepEqual(outcomeOf(q).notes, [], q.title);
    assert.equal(checkQti21([MC, MA, MAP, TF, SA, MAT, ESS]).exported, 7);
  });
});

describe("text", () => {
  const stemOf = (q: Question): XmlElement => descend(itemOf(q), "itemBody")[0] as XmlElement;

  test("markup, quotes, ampersands and angle brackets in the text come back as they were written", () => {
    const awkward = 'Is 3 < 5 & "quoted" > \'single\'? <script>alert(1)</script>';
    const q = make("trueFalse", { correct: true }, awkward);
    const pack = unpack([q]);
    assert.deepEqual(problems(pack), []);
    assert.equal(wordsOf(stemOf(q)).startsWith(awkward), true);
    assert.doesNotMatch(pack.text("q1.xml"), /<script/);
  });

  test("control characters that XML cannot hold are dropped, and the rest of the text stays", () => {
    const q = make("trueFalse", { correct: true }, "Before\u0000\u0008\u000bAfter \ud800 end");
    const pack = unpack([q]);
    assert.doesNotThrow(() => parseXml(pack.text("q1.xml")));
    assert.match(wordsOf(stemOf(q)), /Before.*After.*end/);
  });

  test("the question text is XHTML, and a formatted one keeps its formatting as markup and not as text", () => {
    const q = make("trueFalse", { correct: true }, "<p>A <strong>bold</strong>, <em>italic</em>, x<sup>2</sup> and H<sub>2</sub>O.</p><ul><li>one</li><li>two</li></ul><pre>a\n  b</pre>");
    const pack = unpack([q]);
    assert.deepEqual(problems(pack), []);
    const body = stemOf(q);
    assert.equal(descend(body, "strong").length, 1);
    assert.equal(descend(body, "em").length, 1);
    assert.equal(descend(body, "sup").length, 1);
    assert.equal(descend(body, "sub").length, 1);
    assert.equal(descend(body, "li").length, 2);
    assert.match(pack.text("q1.xml"), /<pre>a\n {2}b<\/pre>/, "the line breaks of a preformatted block stay");
    assert.deepEqual(outcomeOf(q).notes, [], "nothing here is lost");
  });

  test("a line break is a closed element, and the file is well formed", () => {
    const q = make("trueFalse", { correct: true }, "<p>One<br>two<br/>three</p>");
    const pack = unpack([q]);
    assert.match(pack.text("q1.xml"), /One<br\/>two<br\/>three/);
    assert.deepEqual(problems(pack), []);
  });

  test("underline, strike-through and a list's start number are taken out of the markup, the words stay, and it is said", () => {
    const q = make("trueFalse", { correct: true }, "<p>An <u>underlined</u> and <s>struck</s> word.</p><ol start=\"3\"><li>third</li></ol>");
    const pack = unpack([q]);
    assert.equal(descend(stemOf(q), "u").length + descend(stemOf(q), "s").length, 0);
    assert.match(wordsOf(stemOf(q)), /An underlined and struck word\.third/);
    const notes = outcomeOf(q).notes.join(" ");
    assert.match(notes, /Underline and strike-through/);
    assert.match(notes, /starting number/);
    assert.deepEqual(problems(pack), []);
  });

  test("a table keeps its rows, its header cells and the cells that span", () => {
    const q = make("trueFalse", { correct: true }, '<table><thead><tr><th scope="col" colspan="2">Scores</th></tr></thead><tbody><tr><td>A</td><td rowspan="2">90</td></tr><tr><td>B</td></tr></tbody></table>');
    const body = stemOf(q);
    assert.equal(descend(body, "tr").length, 3);
    assert.equal(attr(descend(body, "th")[0] as XmlElement, "scope"), "col");
    assert.equal(attr(descend(body, "th")[0] as XmlElement, "colspan"), "2");
    assert.equal(attr(descend(body, "td")[1] as XmlElement, "rowspan"), "2");
    assert.deepEqual(problems(unpack([q])), []);
  });

  test("an attribute that is not a small number or a scope of the standard is not written", () => {
    const q = make("trueFalse", { correct: true }, '<table><tr><th scope="evil&quot; onclick=&quot;x" colspan="99999">H</th><td colspan="2 3">c</td></tr></table>');
    const body = stemOf(q);
    assert.equal(attr(descend(body, "th")[0] as XmlElement, "scope"), "");
    assert.equal(attr(descend(body, "th")[0] as XmlElement, "colspan"), "");
    assert.equal(attr(descend(body, "td")[0] as XmlElement, "colspan"), "");
    assert.deepEqual(problems(unpack([q])), []);
  });

  test("an answer with formatting is markup in the choice, and a plain one is just its words", () => {
    const q = make(
      "multipleChoice",
      { shuffle: true, options: [{ id: "o1", content: rich("<p>H<sub>2</sub>O</p>"), correct: true }, { id: "o2", content: plainToRich("Plain & simple"), correct: false }] },
      "Water?",
    );
    const pack = unpack([q]);
    const [a, b] = descend(pack.items[0]?.doc as XmlElement, "simpleChoice") as [XmlElement, XmlElement];
    assert.equal(descend(a, "sub").length, 1);
    assert.equal(descend(a, "p").length, 0, "a single paragraph is not needed inside a choice");
    assert.equal(wordsOf(b), "Plain & simple");
    assert.deepEqual(problems(pack), []);
  });

  test("an answer of two paragraphs keeps both", () => {
    const q = make("multipleChoice", { shuffle: true, options: [{ id: "o1", content: rich("<p>One.</p><p>Two.</p>"), correct: true }, { id: "o2", content: plainToRich("B"), correct: false }] }, "Which?");
    assert.equal(descend(descend(itemOf(q), "simpleChoice")[0] as XmlElement, "p").length, 2);
  });

  test("a title that is long or has markup in it is safe in the attribute", () => {
    const q = make("trueFalse", { correct: true }, "Whatever.", { title: `${"x".repeat(200)} <b>"&'` });
    const pack = unpack([q]);
    assert.ok(attr(pack.items[0]?.doc as XmlElement, "title").length <= 100 + 10);
    assert.deepEqual(problems(pack), []);
  });
});

describe("pictures", () => {
  const BLUE = png(40, 30);
  const FILE = "media/p-aaaaaaaaaaaaaaaa.png";
  const figure = (extra: { alt?: string; decorative?: boolean; inOption?: boolean; file?: string } = {}): Question => {
    const marker = mediaPlaceholder("m1");
    return make(
      "multipleChoice",
      { shuffle: false, options: [{ id: "o0", content: extra.inOption ? rich(`<p>Blue ${marker}</p>`) : plainToRich("Blue"), correct: true }, { id: "o1", content: plainToRich("Red"), correct: false }] },
      extra.inOption ? "Which one is blue?" : `<p>What colour is the box?</p><p>${marker}</p>`,
      { media: [{ id: "m1", file: extra.file ?? FILE, mime: "image/png", alt: extra.alt ?? "A blue box", ...(extra.decorative ? { decorative: true } : {}) }] },
    );
  };

  test("a picture in the text is an img that points at a file in the package, with its description", () => {
    const pack = unpack([figure()], "Figures", new Map([[FILE, BLUE]]));
    const img = descend(pack.items[0]?.doc as XmlElement, "img")[0] as XmlElement;
    assert.equal(attr(img, "src"), "images/p-aaaaaaaaaaaaaaaa.png");
    assert.equal(attr(img, "alt"), "A blue box");
    assert.deepEqual(pack.files.get("images/p-aaaaaaaaaaaaaaaa.png"), BLUE);
    assert.deepEqual(problems(pack), []);
    const resource = descend(pack.manifest, "resource").find((r) => attr(r, "identifier") === "res_q1") as XmlElement;
    assert.deepEqual(descend(resource, "file").map((f) => attr(f, "href")), ["q1.xml", "images/p-aaaaaaaaaaaaaaaa.png"]);
    assert.equal(outcomeOf(figure()).notes.length, 1, "without the bank's files it is words");
  });

  test("the question is exported as written when the picture is carried", () => {
    const result = exportQti21([figure()], { name: "Figures", media: new Map([[FILE, BLUE]]) });
    assert.equal(result.report.items[0]?.outcome, "exported");
  });

  test("a picture in an answer is carried the same way", () => {
    const pack = unpack([figure({ inOption: true })], "Figures", new Map([[FILE, BLUE]]));
    assert.equal(descend(descend(pack.items[0]?.doc as XmlElement, "simpleChoice")[0] as XmlElement, "img").length, 1);
    assert.deepEqual(problems(pack), []);
  });

  test("a decorative picture has an empty description on purpose", () => {
    const pack = unpack([figure({ decorative: true })], "Figures", new Map([[FILE, BLUE]]));
    assert.equal(attr(descend(pack.items[0]?.doc as XmlElement, "img")[0] as XmlElement, "alt"), "");
  });

  test("a description with quotation marks and angle brackets cannot break out of the attribute", () => {
    const pack = unpack([figure({ alt: '"><script>alert(1)</script> & more' })], "Figures", new Map([[FILE, BLUE]]));
    assert.doesNotMatch(pack.text("q1.xml"), /<script/);
    assert.equal(attr(descend(pack.items[0]?.doc as XmlElement, "img")[0] as XmlElement, "alt"), '"><script>alert(1)</script> & more');
  });

  test("the file is named for what its bytes are, and a JPEG is not called a PNG", () => {
    const pack = unpack([figure()], "Figures", new Map([[FILE, jpeg(20, 20)]]));
    assert.ok(pack.files.has("images/p-aaaaaaaaaaaaaaaa.jpg"));
    assert.equal(attr(descend(pack.items[0]?.doc as XmlElement, "img")[0] as XmlElement, "src"), "images/p-aaaaaaaaaaaaaaaa.jpg");
  });

  test("a picture whose bytes are not held, or are not a picture, or whose name is unsafe is words, counted", () => {
    for (const media of [undefined, new Map<string, Uint8Array>(), new Map([[FILE, new Uint8Array([1, 2, 3])]])]) {
      const result = exportQti21([figure()], { name: "Figures", ...(media ? { media } : {}) });
      assert.equal(result.report.items[0]?.outcome, "exportedWithLosses");
      assert.match(result.report.items[0]?.notes.join(" ") ?? "", /1 picture could not be written/);
      assert.match(wordsOf(descend(readPackage21(result.files[0]?.bytes).items[0]?.doc as XmlElement, "itemBody")[0] as XmlElement), /\[Picture: A blue box\]/);
    }
    const unsafe = exportQti21([figure({ file: "media/../x y.png" })], { name: "Figures", media: new Map([["media/../x y.png", BLUE]]) });
    assert.equal(unsafe.report.items[0]?.outcome, "exportedWithLosses");
  });

  test("two different pictures never share a name in the package, and the same picture is one file", () => {
    const a = figure();
    const b = make("trueFalse", { correct: true }, `<p>${mediaPlaceholder("m2")}</p>`, { media: [{ id: "m2", file: FILE, mime: "image/png", alt: "Another" }] });
    const same = exportQti21([a, b], { name: "Figures", media: new Map([[FILE, BLUE]]) });
    assert.equal([...readPackage21(same.files[0]?.bytes).files.keys()].filter((n) => n.startsWith("images/")).length, 1);

    const c = make("trueFalse", { correct: true }, `<p>${mediaPlaceholder("m3")}</p>`, { media: [{ id: "m3", file: "media/p-aaaaaaaaaaaaaaaa.png", mime: "image/png", alt: "Third" }] });
    // Both ask for one name; the second holds different bytes, so the bank's files cannot both be right. The second is words.
    let call = 0;
    const flipping: ReadonlyMap<string, Uint8Array> = { get: () => (call++ === 0 ? BLUE : png(41, 30)), has: () => true, size: 1, forEach: () => undefined, entries: () => [][Symbol.iterator](), keys: () => [][Symbol.iterator](), values: () => [][Symbol.iterator](), [Symbol.iterator]: () => [][Symbol.iterator]() } as never;
    const clash = exportQti21([a, c], { name: "Figures", media: flipping });
    assert.deepEqual(clash.report.items.map((i) => i.outcome), ["exported", "exportedWithLosses"]);
  });

  test("a picture only a question that was left out used is not in the package", () => {
    const keyless = make("multipleChoice", { shuffle: true, options: [opt("o1", "A"), opt("o2", "B")] }, `<p>No key. ${mediaPlaceholder("m9")}</p>`, { media: [{ id: "m9", file: "media/p-bbbbbbbbbbbbbbbb.png", mime: "image/png", alt: "x" }] });
    const pack = unpack([MC, keyless], "Figures", new Map([["media/p-bbbbbbbbbbbbbbbb.png", BLUE]]));
    assert.deepEqual([...pack.files.keys()].filter((n) => n.startsWith("images/")), []);
    assert.deepEqual(problems(pack), []);
  });
});

describe("equations", () => {
  const MATHML = '<math xmlns="http://www.w3.org/1998/Math/MathML"><mfrac><mi>x</mi><mn>2</mn></mfrac><mo>=</mo><mn>3</mn></math>';
  const withMath = (math: MathRef[], ref = "e1"): Question =>
    make("multipleChoice", { shuffle: false, options: [opt("o1", "six", true), opt("o2", "five")] }, `<p>Solve ${mathPlaceholder(ref)} for x.</p>`, { math });

  test("an equation is its MathML in the text, and the question is exported as written", () => {
    const q = withMath([{ id: "e1", latex: "\\frac{x}{2}=3", mathml: MATHML, source: "omml" }]);
    const pack = unpack([q]);
    const math = descend(descend(pack.items[0]?.doc as XmlElement, "itemBody")[0] as XmlElement, "math");
    assert.equal(math.length, 1);
    assert.equal(descend(math[0] as XmlElement, "mfrac").length, 1);
    assert.match(pack.text("q1.xml"), /<math xmlns="http:\/\/www\.w3\.org\/1998\/Math\/MathML">/);
    assert.deepEqual(problems(pack), []);
    assert.equal(outcomeOf(q).outcome, "exported");
  });

  test("an equation with no MathML, or MathML that is not well formed or not MathML, is words with its LaTeX, counted", () => {
    for (const mathml of ["", "<math/>", "<math xmlns=\"http://www.w3.org/1998/Math/MathML\"><mi>x</math>", '<span xmlns="http://www.w3.org/1998/Math/MathML">x</span>']) {
      const q = withMath([{ id: "e1", latex: "a<b\\&c>d", mathml }]);
      const pack = unpack([q]);
      assert.deepEqual(problems(pack), [], mathml);
      assert.match(wordsOf(descend(pack.items[0]?.doc as XmlElement, "itemBody")[0] as XmlElement), /\[Equation: a<b\\&c>d\]/);
      assert.match(outcomeOf(q).notes.join(" "), /1 equation became text/);
    }
  });

  test("an equation the question does not hold is a marker, and the file is still well formed", () => {
    const q = withMath([], "e9");
    const pack = unpack([q]);
    assert.match(wordsOf(descend(pack.items[0]?.doc as XmlElement, "itemBody")[0] as XmlElement), /\[Equation\]/);
    assert.deepEqual(problems(pack), []);
  });

  test("an equation in an answer is MathML there too", () => {
    const q = make(
      "multipleChoice",
      { shuffle: false, options: [{ id: "o1", content: rich(`<p>${mathPlaceholder("e1")}</p>`), correct: true }, { id: "o2", content: plainToRich("no"), correct: false }] },
      "Which is it?",
      { math: [{ id: "e1", latex: "x", mathml: MATHML }] },
    );
    const pack = unpack([q]);
    assert.equal(descend(descend(pack.items[0]?.doc as XmlElement, "simpleChoice")[0] as XmlElement, "math").length, 1);
    assert.deepEqual(problems(pack), []);
  });
});

describe("the file and the check", () => {
  test("names the file for the bank, makes the name safe, and reports every question once, in order", () => {
    const result = exportQti21([MC, make("numeric", { mode: "exact", value: 1 }, "N?"), TF], { name: 'Bio: "Unit" 1/2' });
    assert.equal(result.files.length, 1);
    assert.match(result.files[0]?.name ?? "", /^Bio- -Unit- 1-2 - QTI 2\.1\.zip$/);
    assert.deepEqual(result.report.items.map((i) => i.position), [1, 2, 3]);
    assert.equal(result.files[0]?.questions, 2);
    assert.equal(result.report.total, 3);
    assert.equal(result.report.leftOut, 1);
  });

  test("tells a person where to import it in Canvas and in Brightspace, and what the file cannot do", () => {
    const general = checkQti21([MC]).general.join(" ");
    assert.match(general, /Canvas: Settings, then Import Course Content, with the content type QTI \.zip file/);
    assert.match(general, /Classic Quizzes reads QTI 1\.2 and 2\.1 and New Quizzes reads QTI 1\.2 and 2\.x/);
    assert.match(general, /Brightspace: Course Admin, Import\/Export\/Copy Components, Import Components, from a File/);
    assert.match(general, /Quizzes tool reads QTI 1\.2 only/);
    assert.match(general, /not documented/);
    assert.match(general, /partial credit is scored by a mapping/);
  });

  test("a bank with nothing it can write gives no file, and an empty bank gives no file and no error", () => {
    const none = exportQti21([make("numeric", { mode: "exact", value: 1 }, "Number?")]);
    assert.deepEqual(none.files, []);
    assert.deepEqual(none.report.files, []);
    assert.deepEqual(exportQti21([]).files, []);
    assert.equal(checkQti21([]).total, 0);
  });

});

describe("the command line", () => {
  test("`export --to qti-2.1` writes a zip a second reader can open, and says what it would do without --out", () => {
    const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
    const source = fileURLToPath(new URL("../../../fixtures/standard-format/01-clean-multiple-choice.txt", import.meta.url));
    const folder = mkdtempSync(join(tmpdir(), "oa-qti21-"));
    try {
      const run = (...args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, ...args], { encoding: "utf8" });
      const bank = join(folder, "bank.openassess");
      assert.equal(run("import", source, "--out", bank).status, 0);

      const dry = run("export", bank, "--to", "qti-2.1");
      assert.equal(dry.status, 0, dry.stderr);
      assert.match(dry.stdout, /Destination check: QTI 2\.1 package/);
      assert.match(dry.stdout, /Nothing was written/);
      assert.deepEqual(readdirSync(folder), ["bank.openassess"]);

      const out = join(folder, "out");
      const written = run("export", bank, "--to", "qti-2.1", "--out", out);
      assert.equal(written.status, 0, written.stderr);
      const [name] = readdirSync(out);
      assert.match(name ?? "", / - QTI 2\.1\.zip$/);
      const bytes = new Uint8Array(readFileSync(join(out, name as string)));
      assert.equal(bytes[0], 0x50, "a zip begins with PK");
      assert.deepEqual(problems(readPackage21(bytes)), []);

      assert.match(run("help").stdout + run("--help").stdout, /qti-2\.1/);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("a package against the standard's own description", () => {
  test("every kind of question, together, satisfies it", () => {
    const all = [MC, MA, MAP, TF, SA, FIB, MAT, ESS, make("trueFalse", { correct: true }, "<p>A <em>formatted</em> one.</p>", { points: 7, title: "Titled" })];
    const pack = unpack(all);
    assert.deepEqual(problems(pack), []);
    assert.equal(pack.items.length, all.length);
  });

  test("the checker does notice what is wrong with a package (so that passing it means something)", () => {
    const pack = unpack([MC, MA, MAT, SA, ESS]);
    const edit = (file: string, from: string | RegExp, to: string, base: Pack21 = pack): Pack21 => {
      const files = new Map(base.files);
      const before = base.text(file);
      const after = before.replace(from, to);
      assert.notEqual(after, before, `the mutation ${String(from)} changed nothing in ${file}`);
      files.set(file, new Uint8Array(Buffer.from(after, "utf8")));
      return readPackage21(zipOf(files));
    };
    assert.ok(problems(edit("q1.xml", 'identifier="q1"', 'identifier="q9"')).length > 0, "an item whose identifier is not what the test refers to");
    assert.ok(problems(edit("q1.xml", "<value>c2</value>", "<value>c9</value>")).length > 0, "a correct response that is not offered");
    assert.ok(problems(edit("q1.xml", 'maxChoices="1"', 'maxChoices="0"')).length > 0, "a multiple choice that takes several");
    assert.ok(problems(edit("q1.xml", /<itemBody>/, "<itemBody><u>x</u>")).length > 0, "markup the standard does not allow");
    assert.ok(problems(edit("q1.xml", /<\/?responseProcessing>/g, "")).length > 0, "an item that has no processing");
    assert.ok(problems(edit("q1.xml", /<(\/?)match>/g, "<$1equalx>")).length > 0, "an operator the standard does not have");
    assert.ok(problems(edit("q1.xml", 'normalMaximum="1"', 'normalMaximum="0"')).length > 0, "no points");
    const twice = edit("q3.xml", "<value>l2 r2</value>", "<value>l2 r1</value>");
    assert.deepEqual(problems(twice).filter((p) => /more often than its matchMax/.test(p)), [], "three places for a right choice that is used twice is fine");
    assert.ok(problems(edit("q3.xml", 'identifier="r1" matchMax="3"', 'identifier="r1" matchMax="1"', twice)).some((p) => /more often than its matchMax/.test(p)), "a right choice used more than it can be");
    assert.ok(problems(edit("q3.xml", 'mapKey="l1 r1"', 'mapKey="l1 r9"')).length > 0, "a mapping key that is not a pair offered");
    assert.ok(problems(edit("q5.xml", "<extendedTextInteraction", "<responseDeclarationX /><extendedTextInteraction")).length > 0, "an unknown element in an essay");
    assert.ok(problems(edit("assessmentTest.xml", 'href="q2.xml"', 'href="q9.xml"')).length > 0, "a reference to a file that is not there");
    assert.ok(problems(edit("assessmentTest.xml", /<outcomeProcessing>[\s\S]*<\/outcomeProcessing>/, "")).length > 0, "a test that does not add the scores");
    assert.ok(problems(edit("imsmanifest.xml", 'type="imsqti_item_xmlv2p1"', 'type="webcontent"')).length > 0, "the wrong resource type");
    assert.ok(problems(edit("imsmanifest.xml", /<dependency identifierref="res_q2"\/>/, "")).length > 0, "an item the test does not depend on");
    const missing = { ...pack, files: new Map([...pack.files].filter(([n]) => n !== "q4.xml")) };
    assert.ok(problems(missing).length > 0, "a listed file that is not in the zip");
    const stray = { ...pack, files: new Map([...pack.files, ["extra.bin", new Uint8Array(1)] as const]) };
    assert.ok(problems(stray).length > 0, "a file no resource lists");
  });

  test("the response processor does notice a wrong key (so that a right key means something)", () => {
    const pack = unpack([MC]);
    const swapped = pack.text("q1.xml").replace("<value>c2</value>", "<value>c1</value>");
    const item = parseXml(swapped);
    assert.equal(grade(item, R("c2")), 0);
    assert.equal(grade(item, R("c1")), 1);
    assert.throws(() => grade(parseXml(swapped.replace("<match>", "<inside>").replace("</match>", "</inside>")), R("c1")), /does not know/);
  });

  // For every question that was written: the key the bank holds, found in the package by the words of the answers and not by the
  // exporter's identifiers, is exactly what scores the points, and nothing else does.
  function verifyKeys(questions: Question[], outcomes: string[], pack: Pack21, name: string): number {
    const written = questions.filter((_q, i) => outcomes[i] !== "leftOut");
    assert.equal(pack.items.length, written.length, name);
    const plain = (t: unknown): string => richTextToPlain(t as never).replace(/\s+/g, " ").trim();
    written.forEach((q, i) => {
      const item = (pack.items[i] as { doc: XmlElement }).doc;
      const where = `${name}: ${q.title}`;
      assert.equal(pointsOf(item), q.points, where);
      const body = q.body as unknown as { options?: Array<{ content: unknown; correct: boolean }>; correct?: boolean; accepted?: string[]; blanks?: Array<{ accepted: string[] }>; caseSensitive?: boolean; partialCredit?: boolean };
      if (q.type === "multipleChoice") {
        const right = (body.options ?? []).filter((o) => o.correct).map((o) => plain(o.content));
        for (const c of choicesOf(item)) assert.equal(grade(item, R(c.id)), right.includes(c.text) ? q.points : 0, `${where} / ${c.text}`);
      } else if (q.type === "multipleResponse") {
        const right = new Set((body.options ?? []).filter((o) => o.correct).map((o) => plain(o.content)));
        for (const chosen of subsets(choicesOf(item))) {
          const good = chosen.filter((c) => right.has(c.text)).length;
          const bad = chosen.length - good;
          const exact = good === right.size && bad === 0;
          const expected = exact ? q.points : body.partialCredit ? (Math.max(0, good - bad) / right.size) * q.points : 0;
          close(grade(item, R(...chosen.map((c) => c.id))), expected, `${where} / ${chosen.map((c) => c.text).join("+")}`);
        }
      } else if (q.type === "trueFalse") {
        for (const c of choicesOf(item)) assert.equal(grade(item, R(c.id)), (c.text === "True") === body.correct ? q.points : 0, where);
      } else if (q.type === "shortAnswer" || q.type === "fillInBlank") {
        const accepted = q.type === "shortAnswer" ? (body.accepted ?? []) : (body.blanks?.[0]?.accepted ?? []);
        for (const a of accepted.map((x) => x.replace(/\s+/g, " ").trim()).filter((x) => x !== "")) assert.equal(grade(item, R(a)), q.points, `${where} / ${a}`);
        assert.equal(grade(item, R("zzz not an answer zzz")), 0, where);
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
      const exported = exportQti21(result.questions, { name });
      if (exported.files.length === 0) continue;
      files++;
      const pack = readPackage21(exported.files[0]?.bytes);
      assert.deepEqual(problems(pack), [], name);
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
      const exported = exportQti21(result.questions, { name, ...(result.media ? { media: result.media } : {}) });
      if (exported.files.length === 0) continue;
      const pack = readPackage21(exported.files[0]?.bytes);
      assert.deepEqual(problems(pack), [], name);
      questions += verifyKeys(result.questions, exported.report.items.map((i) => i.outcome), pack, name);
    }
    assert.ok(questions > 0);
  });
});

/** A zip of the given files, in the order they are held. */
function zipOf(files: Map<string, Uint8Array>): Uint8Array {
  return zipSync([...files].map(([name, data]) => ({ name, data })));
}
