/**
 * The QTI importer, for versions 1.2 and 2.1, as a package or a bare file. The rules under test are the ones every importer keeps and
 * this one most needs: a key is read only from a scoring shape this reader knows (the file states it in its conditions, or in its
 * declared correct response), a question whose scoring cannot be read gets no guessed key and is kept with its words as an essay that
 * fails, credit for part of a question that cannot be kept is said and never turned into a key, and nothing is dropped without being
 * said.
 *
 * Three kinds of file stand behind the tests. This program's own two exporters are read back (what is exported and imported again is
 * what was exported). Files in the shape Canvas writes its quizzes in, and files in the shape the standard's own templates give, are
 * written by hand from memory of those shapes, because no real export from either has been read; the test says so where it matters.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { textEntry, unzipSync, zipSync, type ZipEntry } from "../src/container/zip.ts";
import { exportCommonCartridge } from "../src/export/common-cartridge.ts";
import { exportQti12 } from "../src/export/qti12.ts";
import { exportQti21 } from "../src/export/qti21.ts";
import { looksLikeQtiXml, qtiImporter } from "../src/import/qti.ts";
import { importerForContent, runImporter } from "../src/import/registry.ts";
import { verdictOf } from "../src/import/types.ts";
import { hasUsableKey } from "../src/quality/answer-key.ts";
import type { Question } from "../src/model/question.ts";
import { richTextToPlain } from "../src/model/richtext.ts";
import { png } from "./support/images.ts";

const AT = "2026-01-01T00:00:00.000Z";
const read = (bytes: Uint8Array | string, file = "quiz.zip") => qtiImporter.parseBytes?.(typeof bytes === "string" ? new Uint8Array(Buffer.from(bytes, "utf8")) : bytes, { file, at: AT, author: "test" }) as ReturnType<NonNullable<typeof qtiImporter.parseBytes>>;
const plainOf = (t: unknown): string => richTextToPlain(t as never).replace(/\s+/g, " ").trim();
const codes = (q: Question): string[] => q.findings.map((f) => f.code);
const said = (q: Question): string => q.findings.map((f) => f.message).join(" | ");
const options = (q: Question): Array<{ text: string; correct: boolean }> => (q.body as unknown as { options: Array<{ content: unknown; correct: boolean }> }).options.map((o) => ({ text: plainOf(o.content), correct: o.correct }));
const zipOf = (files: Record<string, string | Uint8Array>): Uint8Array => zipSync(Object.entries(files).map(([name, data]): ZipEntry => (typeof data === "string" ? textEntry(name, data) : { name, data })));

// ---------------------------------------------------------------------------
// QTI 1.2, in the shape Canvas writes
// ---------------------------------------------------------------------------

const html = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const mat = (value: string, type = "text/plain"): string => `<material><mattext texttype="${type}">${html(value)}</mattext></material>`;
const label = (id: string, text: string): string => `<response_label ident="${id}">${mat(text)}</response_label>`;
const when = (cond: string, set: number | string, action = "Set"): string => `<respcondition continue="No"><conditionvar>${cond}</conditionvar><setvar varname="SCORE" action="${action}">${set}</setvar></respcondition>`;
const eq = (resp: string, value: string, extra = ""): string => `<varequal respident="${resp}"${extra}>${value}</varequal>`;
const outcomes = (max = 100): string => `<outcomes><decvar maxvalue="${max}" minvalue="0" varname="SCORE" vartype="Decimal"/></outcomes>`;

function item12(kind: string, presentation: string, processing: string, extra = "", title = "Question", points = "1.0"): string {
  return (
    `<item ident="g${Math.random().toString(36).slice(2, 8)}" title="${title}"><itemmetadata><qtimetadata>` +
    `<qtimetadatafield><fieldlabel>question_type</fieldlabel><fieldentry>${kind}</fieldentry></qtimetadatafield>` +
    `<qtimetadatafield><fieldlabel>points_possible</fieldlabel><fieldentry>${points}</fieldentry></qtimetadatafield></qtimetadata></itemmetadata>` +
    `<presentation>${presentation}</presentation><resprocessing>${outcomes()}${processing}</resprocessing>${extra}</item>`
  );
}
const assessment12 = (items: string[], title = "Unit 1 quiz"): string =>
  `<?xml version="1.0" encoding="UTF-8"?><questestinterop xmlns="http://www.imsglobal.org/xsd/ims_qtiasiv1p2"><assessment ident="a1" title="${title}"><section ident="root_section">${items.join("")}</section></assessment></questestinterop>`;
const mc12 = (right: string | undefined, texts = ["Berlin", "Paris", "Rome"], extraCond = ""): string =>
  item12(
    "multiple_choice_question",
    `${mat("<p>What is the capital of France?</p>", "text/html")}<response_lid ident="response1" rcardinality="Single"><render_choice>${texts.map((t, i) => label(String(i + 1), t)).join("")}</render_choice></response_lid>`,
    (right ? when(eq("response1", right), 100) : "") + extraCond,
  );

describe("QTI 1.2 in the shape Canvas writes", () => {
  test("a multiple choice question: the label whose condition sets the whole of the points is the key", () => {
    const q = read(assessment12([mc12("2")]), "quiz.xml").questions[0] as Question;
    assert.equal(q.type, "multipleChoice");
    assert.deepEqual(options(q), [{ text: "Berlin", correct: false }, { text: "Paris", correct: true }, { text: "Rome", correct: false }]);
    assert.equal(plainOf(q.stem), "What is the capital of France?");
    assert.equal(q.points, 1);
    assert.deepEqual(q.metadata.tags, ["Unit 1 quiz"]);
    assert.ok(hasUsableKey(q));
    assert.equal(verdictOf(q), "parsed");
  });

  test("a question with no condition that sets the whole of the points has no key, and says so", () => {
    const q = read(assessment12([mc12(undefined)]), "quiz.xml").questions[0] as Question;
    assert.deepEqual(options(q).map((o) => o.correct), [false, false, false]);
    assert.ok(codes(q).includes("import.no-answer-key"));
    assert.match(said(q), /Nothing was guessed/);
    assert.equal(verdictOf(q), "failed");
  });

  test("two labels that each set the whole of the points are both marked as the file has them, and flagged", () => {
    const q = read(assessment12([mc12("1", undefined, when(eq("response1", "3"), 100))]), "quiz.xml").questions[0] as Question;
    assert.deepEqual(options(q).map((o) => o.correct), [true, false, true]);
    assert.ok(codes(q).includes("import.more-than-one-right"));
    assert.equal(hasUsableKey(q), false);
  });

  test("a label worth part of the points is not the key, and is said", () => {
    const q = read(assessment12([mc12("2", undefined, when(eq("response1", "1"), 50))]), "quiz.xml").questions[0] as Question;
    assert.deepEqual(options(q).map((o) => o.correct), [false, true, false]);
    assert.ok(codes(q).includes("import.weights-not-kept"));
  });

  test("a scoring rule this reader does not understand is said, and not taken for a key", () => {
    const rule = `<respcondition continue="No"><conditionvar><vargte respident="response1">5</vargte></conditionvar><setvar varname="SCORE" action="Set">100</setvar></respcondition>`;
    const q = read(assessment12([mc12(undefined, undefined, rule)]), "quiz.xml").questions[0] as Question;
    assert.deepEqual(options(q).map((o) => o.correct), [false, false, false]);
    assert.match(said(q), /scoring rule of this question was not read/);
  });

  test("true or false: the label reading True or False that is scored decides, and neither or both leaves no key", () => {
    const tf = (right: string[]): Question =>
      read(
        assessment12([
          item12(
            "true_false_question",
            `${mat("A light-year is a measure of time.")}<response_lid ident="response1" rcardinality="Single"><render_choice>${label("t", "True")}${label("f", "False")}</render_choice></response_lid>`,
            right.map((r) => when(eq("response1", r), 100)).join(""),
          ),
        ]),
        "quiz.xml",
      ).questions[0] as Question;
    assert.deepEqual(tf(["f"]).body, { correct: false });
    assert.deepEqual(tf(["t"]).body, { correct: true });
    for (const none of [[], ["t", "f"]]) {
      const q = tf(none);
      assert.equal(q.type, "trueFalse");
      assert.deepEqual(q.body, {});
      assert.equal(hasUsableKey(q), false);
    }
  });

  test("multiple answers: every right label chosen and no wrong one is all or nothing, and shares added up are partial credit", () => {
    const pres = `${mat("Which are primary?")}<response_lid ident="response1" rcardinality="Multiple"><render_choice>${["Red", "Green", "Blue", "Pink"].map((t, i) => label(`c${i}`, t)).join("")}</render_choice></response_lid>`;
    const all = read(assessment12([item12("multiple_answers_question", pres, when(`<and>${eq("response1", "c0")}<not>${eq("response1", "c1")}</not>${eq("response1", "c2")}<not>${eq("response1", "c3")}</not></and>`, 100))]), "q.xml").questions[0] as Question;
    assert.equal(all.type, "multipleResponse");
    assert.deepEqual(options(all).filter((o) => o.correct).map((o) => o.text), ["Red", "Blue"]);
    assert.equal((all.body as { partialCredit: boolean }).partialCredit, false);

    const shared = read(assessment12([item12("multiple_answers_question", pres, when(eq("response1", "c0"), 50, "Add") + when(eq("response1", "c2"), 50, "Add"))]), "q.xml").questions[0] as Question;
    assert.deepEqual(options(shared).filter((o) => o.correct).map((o) => o.text), ["Red", "Blue"]);
    assert.equal((shared.body as { partialCredit: boolean }).partialCredit, true);
  });

  test("short answer: the conditions that set the whole of the points are the accepted answers, with their case rule", () => {
    const pres = `${mat("Capital?")}<response_str ident="response1" rcardinality="Single"><render_fib><response_label ident="answer1"/></render_fib></response_str>`;
    const q = read(assessment12([item12("short_answer_question", pres, when(eq("response1", "Paris", ' case="No"'), 100) + when(eq("response1", "paris, france", ' case="No"'), 100) + when(eq("response1", "Lyon", ' case="No"'), 40))]), "q.xml").questions[0] as Question;
    assert.deepEqual(q.body, { caseSensitive: false, accepted: ["Paris", "paris, france"] });
    assert.match(said(q), /"Lyon" is worth part of the points/);
    const cs = read(assessment12([item12("short_answer_question", pres, when(eq("response1", "Paris", ' case="Yes"'), 100))]), "q.xml").questions[0] as Question;
    assert.equal((cs.body as { caseSensitive: boolean }).caseSensitive, true);
  });

  test("a text box with nothing scored is an essay, and one that says it is a short answer with nothing accepted is flagged", () => {
    const pres = `${mat("Discuss.")}<response_str ident="response1" rcardinality="Single"><render_fib rows="15"><response_label ident="answer1"/></render_fib></response_str>`;
    const essay = read(assessment12([item12("essay_question", pres, `<respcondition continue="No"><conditionvar><other/></conditionvar></respcondition>`)]), "q.xml").questions[0] as Question;
    assert.equal(essay.type, "essay");
    assert.equal(verdictOf(essay), "parsed");
    const empty = read(assessment12([item12("short_answer_question", pres, "")]), "q.xml").questions[0] as Question;
    assert.equal(empty.type, "shortAnswer");
    assert.equal(hasUsableKey(empty), false);
  });

  test("matching: a response for each left side, and the right side each scores for", () => {
    const lid = (n: number, left: string): string => `<response_lid ident="response${n}">${mat(left)}<render_choice>${label("m1", "Bark")}${label("m2", "Meow")}${label("m3", "Moo")}${label("m4", "Quack")}</render_choice></response_lid>`;
    const q = read(
      assessment12([
        item12("matching_question", `${mat("Match.")}${lid(1, "Dog")}${lid(2, "Cat")}${lid(3, "Cow")}`, when(eq("response1", "m1"), 33.33, "Add") + when(eq("response2", "m2"), 33.33, "Add") + when(eq("response3", "m3"), 33.34, "Add")),
      ]),
      "q.xml",
    ).questions[0] as Question;
    const body = q.body as { pairs: Array<{ left: unknown; right: string }>; distractors: string[] };
    assert.deepEqual(body.pairs.map((p) => [plainOf(p.left), p.right]), [["Dog", "Bark"], ["Cat", "Meow"], ["Cow", "Moo"]]);
    assert.deepEqual(body.distractors, ["Quack"]);
    assert.equal(verdictOf(q), "parsed");
  });

  test("matching where a left side has no scored match is kept as text, because the pair would be a guess", () => {
    const lid = (n: number, left: string): string => `<response_lid ident="response${n}">${mat(left)}<render_choice>${label("m1", "Bark")}${label("m2", "Meow")}</render_choice></response_lid>`;
    const q = read(assessment12([item12("matching_question", `${mat("Match.")}${lid(1, "Dog")}${lid(2, "Cat")}`, when(eq("response1", "m1"), 50, "Add"))]), "q.xml").questions[0] as Question;
    assert.equal(q.type, "essay");
    assert.equal(verdictOf(q), "failed");
    assert.match(said(q), /no right match in the scoring/);
    const both = read(assessment12([item12("matching_question", `${mat("Match.")}${lid(1, "Dog")}${lid(2, "Cat")}`, when(eq("response1", "m1"), 25, "Add") + when(eq("response1", "m2"), 25, "Add") + when(eq("response2", "m2"), 50, "Add"))]), "q.xml").questions[0] as Question;
    assert.equal(both.type, "essay", "a left side scored for two right sides is not given the first");
    assert.match(said(both), /more than one right side/);
  });

  test("feedback by the identifiers Canvas gives it, and feedback on a single answer is kept with the answer", () => {
    const fb = (id: string, text: string): string => `<itemfeedback ident="${id}"><flow_mat><material><mattext texttype="text/html">${html(`<p>${text}</p>`)}</mattext></material></flow_mat></itemfeedback>`;
    const q = read(assessment12([mc12("2", undefined)].map((x) => x.replace("</item>", `${fb("general_fb", "General.")}${fb("correct_fb", "Well done.")}${fb("general_incorrect_fb", "Try again.")}${fb("2_fb", "Because it is.")}${fb("odd_fb", "Odd.")}</item>`))), "q.xml").questions[0] as Question;
    assert.equal(plainOf(q.feedback.general), "General.");
    assert.equal(plainOf(q.feedback.correct), "Well done.");
    assert.equal(plainOf(q.feedback.incorrect), "Try again.");
    assert.equal(plainOf((q.body as { options: Array<{ feedback?: unknown }> }).options[1]?.feedback), "Because it is.");
    assert.match(said(q), /Feedback "odd_fb" was not read: "Odd\."/);
  });

  test("kinds this reader does not know are kept as text with their answers, and fail", () => {
    for (const kind of ["fill_in_multiple_blanks_question", "multiple_dropdowns_question", "numerical_question", "calculated_question", "file_upload_question", "text_only_question"]) {
      const q = read(assessment12([item12(kind, `${mat("Odd one.")}<response_lid ident="response1" rcardinality="Single"><render_choice>${label("1", "Alpha")}${label("2", "Beta")}</render_choice></response_lid>`, when(eq("response1", "1"), 100))]), "q.xml").questions[0] as Question;
      assert.equal(q.type, "essay", kind);
      assert.equal(verdictOf(q), "failed", kind);
      assert.match(plainOf(q.stem), /Odd one\. Alpha Beta/, `${kind}: its words are all kept`);
    }
  });

  test("a picture from the cartridge's file base is found in web_resources, and one that is not there stays as [picture]", () => {
    const PNG = png(10, 10);
    const stem = (src: string): string => item12("essay_question", `${mat(`<p>Look <img src="${src}" alt="A box"></p>`, "text/html")}<response_str ident="response1"><render_fib><response_label ident="a"/></render_fib></response_str>`, "");
    const ok = read(zipOf({ "g1/quiz.xml": assessment12([stem("%24IMS-CC-FILEBASE%24/Uploaded%20Media/box.png")]), "web_resources/Uploaded Media/box.png": PNG })).questions[0] as Question;
    assert.equal(ok.media.length, 1);
    assert.equal(ok.media[0]?.alt, "A box");
    assert.equal(verdictOf(ok), "parsed");
    const gone = read(zipOf({ "g1/quiz.xml": assessment12([stem("$IMS-CC-FILEBASE$/Uploaded Media/missing.png")]) })).questions[0] as Question;
    assert.match(plainOf(gone.stem), /\[picture\]/);
    assert.ok(codes(gone).includes("import.unread-object"));
    assert.match(said(gone), /does not hold a file named/);
  });
});

// ---------------------------------------------------------------------------
// QTI 2.1, in the shapes the standard describes
// ---------------------------------------------------------------------------

const NS = 'xmlns="http://www.imsglobal.org/xsd/imsqti_v2p1"';
function item21(id: string, declaration: string, body: string, processing = '<responseProcessing template="http://www.imsglobal.org/question/qti_v2p1/rptemplates/match_correct"/>', extra = "", title = "Item", normalMaximum = ""): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><assessmentItem ${NS} identifier="${id}" title="${title}" adaptive="false" timeDependent="false">${declaration}` +
    `<outcomeDeclaration identifier="SCORE" cardinality="single" baseType="float"${normalMaximum}/><itemBody>${body}</itemBody>${processing}${extra}</assessmentItem>`
  );
}
const decl = (card: string, base: string, correct: string[], mapping = ""): string =>
  `<responseDeclaration identifier="RESPONSE" cardinality="${card}" baseType="${base}"><correctResponse>${correct.map((v) => `<value>${v}</value>`).join("")}</correctResponse>${mapping}</responseDeclaration>`;
const choices = (...texts: string[]): string => texts.map((t, i) => `<simpleChoice identifier="c${i + 1}">${t}</simpleChoice>`).join("");

describe("QTI 2.1 in the shapes the standard describes", () => {
  test("a choice question with the standard template: the declared correct response is the key", () => {
    const q = read(item21("i1", decl("single", "identifier", ["c2"]), `<p>Capital?</p><choiceInteraction responseIdentifier="RESPONSE" shuffle="true" maxChoices="1">${choices("Berlin", "Paris", "Rome")}</choiceInteraction>`), "i1.xml").questions[0] as Question;
    assert.equal(q.type, "multipleChoice");
    assert.deepEqual(options(q).map((o) => o.correct), [false, true, false]);
    assert.equal((q.body as { shuffle: boolean }).shuffle, true);
    assert.equal(verdictOf(q), "parsed");
  });

  test("a prompt inside the interaction is the question's own words, and the prompt's place is kept", () => {
    const q = read(item21("i1", decl("single", "identifier", ["c1"]), `<choiceInteraction responseIdentifier="RESPONSE" maxChoices="1"><prompt>Which one?</prompt>${choices("A", "B")}</choiceInteraction>`), "i1.xml").questions[0] as Question;
    assert.equal(plainOf(q.stem), "Which one?");
  });

  test("no correct response declared means no key, and a response that names an answer not offered is not a key either", () => {
    const none = read(item21("i1", `<responseDeclaration identifier="RESPONSE" cardinality="single" baseType="identifier"/>`, `<choiceInteraction responseIdentifier="RESPONSE" maxChoices="1">${choices("A", "B")}</choiceInteraction>`), "i1.xml").questions[0] as Question;
    assert.deepEqual(options(none).map((o) => o.correct), [false, false]);
    assert.ok(codes(none).includes("import.no-answer-key"));
    const stray = read(item21("i1", decl("single", "identifier", ["zzz"]), `<choiceInteraction responseIdentifier="RESPONSE" maxChoices="1">${choices("A", "B")}</choiceInteraction>`), "i1.xml").questions[0] as Question;
    assert.deepEqual(options(stray).map((o) => o.correct), [false, false]);
    assert.match(said(stray), /names an answer the question does not offer/);
  });

  test("true and false labels make a true or false question", () => {
    const q = read(item21("i1", decl("single", "identifier", ["f"]), `<choiceInteraction responseIdentifier="RESPONSE" maxChoices="1"><simpleChoice identifier="t">True</simpleChoice><simpleChoice identifier="f">False</simpleChoice></choiceInteraction>`), "i1.xml").questions[0] as Question;
    assert.deepEqual([q.type, q.body], ["trueFalse", { correct: false }]);
  });

  test("a multiple response is all or nothing under match_correct and partial credit under a response map; an answer fixed in place is kept", () => {
    const body = `<choiceInteraction responseIdentifier="RESPONSE" shuffle="true" maxChoices="0">${choices("Red", "Green", "Blue").replace('identifier="c3"', 'identifier="c3" fixed="true"')}</choiceInteraction>`;
    const exact = read(item21("i1", decl("multiple", "identifier", ["c1", "c3"]), body), "i1.xml").questions[0] as Question;
    assert.equal(exact.type, "multipleResponse");
    assert.equal((exact.body as { partialCredit: boolean }).partialCredit, false);
    assert.deepEqual(options(exact).filter((o) => o.correct).map((o) => o.text), ["Red", "Blue"]);
    assert.equal((exact.body as { options: Array<{ fixedPosition?: boolean }> }).options[2]?.fixedPosition, true);
    const map = `<mapping defaultValue="0"><mapEntry mapKey="c1" mappedValue="1"/><mapEntry mapKey="c2" mappedValue="-1"/><mapEntry mapKey="c3" mappedValue="1"/></mapping>`;
    const partial = read(item21("i1", decl("multiple", "identifier", ["c1", "c3"], map), body, '<responseProcessing template="http://www.imsglobal.org/question/qti_v2p1/rptemplates/map_response"/>'), "i1.xml").questions[0] as Question;
    assert.equal((partial.body as { partialCredit: boolean }).partialCredit, true);
  });

  test("a text box alone is a short answer, taking the entries worth the most, with the case rule of the standard (counted, unless it says not)", () => {
    const map = `<mapping defaultValue="0"><mapEntry mapKey="Paris" mappedValue="1" caseSensitive="false"/><mapEntry mapKey="paris, france" mappedValue="1" caseSensitive="false"/><mapEntry mapKey="Lyon" mappedValue="0.5" caseSensitive="false"/></mapping>`;
    const q = read(item21("i1", decl("single", "string", ["Paris"], map), `<p>Capital?</p><p><textEntryInteraction responseIdentifier="RESPONSE"/></p>`, '<responseProcessing template="http://www.imsglobal.org/question/qti_v2p1/rptemplates/map_response"/>'), "i1.xml").questions[0] as Question;
    assert.deepEqual(q.body, { caseSensitive: false, accepted: ["Paris", "paris, france"] });
    assert.match(said(q), /"Lyon" is worth part of the points/);
    const plainCase = read(item21("i1", decl("single", "string", ["Paris"]), `<p><textEntryInteraction responseIdentifier="RESPONSE"/></p>`), "i1.xml").questions[0] as Question;
    assert.deepEqual(plainCase.body, { caseSensitive: true, accepted: ["Paris"] });
  });

  test("a text box in the middle of a sentence is a fill in the blank, with the blank where the box stood", () => {
    const q = read(item21("i1", decl("single", "string", ["Quartz"]), `<p><textEntryInteraction responseIdentifier="RESPONSE"/> is the hardest common mineral.</p>`), "i1.xml").questions[0] as Question;
    assert.equal(q.type, "fillInBlank");
    assert.equal(plainOf(q.stem), "_____ is the hardest common mineral.");
    assert.deepEqual(q.body, { caseSensitive: true, blanks: [{ id: "b1", accepted: ["Quartz"] }] });
  });

  test("several text boxes in a sentence are several blanks; several with no sentence are kept as text", () => {
    const two = `<responseDeclaration identifier="R1" cardinality="single" baseType="string"><correctResponse><value>a</value></correctResponse></responseDeclaration><responseDeclaration identifier="R2" cardinality="single" baseType="string"><correctResponse><value>b</value></correctResponse></responseDeclaration>`;
    const sentence = read(item21("i1", two, `<p>X <textEntryInteraction responseIdentifier="R1"/> and <textEntryInteraction responseIdentifier="R2"/>.</p>`), "i1.xml").questions[0] as Question;
    assert.deepEqual((sentence.body as { blanks: Array<{ accepted: string[] }> }).blanks.map((b) => b.accepted), [["a"], ["b"]]);
    const bare = read(item21("i1", two, `<p><textEntryInteraction responseIdentifier="R1"/></p><p><textEntryInteraction responseIdentifier="R2"/></p>`), "i1.xml").questions[0] as Question;
    assert.equal(bare.type, "essay");
    assert.equal(verdictOf(bare), "failed");
  });

  test("an extended text box is an essay", () => {
    const q = read(item21("i1", `<responseDeclaration identifier="RESPONSE" cardinality="single" baseType="string"/>`, `<p>Discuss.</p><extendedTextInteraction responseIdentifier="RESPONSE"/>`, ""), "i1.xml").questions[0] as Question;
    assert.equal(q.type, "essay");
    assert.equal(verdictOf(q), "parsed");
  });

  test("matching from the declared pairs, with the spare answers kept", () => {
    const body = `<matchInteraction responseIdentifier="RESPONSE" shuffle="true" maxAssociations="3"><simpleMatchSet><simpleAssociableChoice identifier="l1" matchMax="1">Dog</simpleAssociableChoice><simpleAssociableChoice identifier="l2" matchMax="1">Cat</simpleAssociableChoice></simpleMatchSet><simpleMatchSet><simpleAssociableChoice identifier="r1" matchMax="2">Bark</simpleAssociableChoice><simpleAssociableChoice identifier="r2" matchMax="2">Meow</simpleAssociableChoice><simpleAssociableChoice identifier="r3" matchMax="2">Quack</simpleAssociableChoice></simpleMatchSet></matchInteraction>`;
    const q = read(item21("i1", decl("multiple", "directedPair", ["l1 r1", "l2 r2"]), body), "i1.xml").questions[0] as Question;
    const b = q.body as { pairs: Array<{ left: unknown; right: string }>; distractors: string[] };
    assert.deepEqual(b.pairs.map((p) => [plainOf(p.left), p.right]), [["Dog", "Bark"], ["Cat", "Meow"]]);
    assert.deepEqual(b.distractors, ["Quack"]);
    const lacking = read(item21("i1", decl("multiple", "directedPair", ["l1 r1"]), body), "i1.xml").questions[0] as Question;
    assert.equal(lacking.type, "essay");
    assert.match(said(lacking), /no right match declared/);
    const twice = read(item21("i1", decl("multiple", "directedPair", ["l1 r1", "l1 r2", "l2 r2"]), body), "i1.xml").questions[0] as Question;
    assert.equal(twice.type, "essay", "a left side declared as matching two right sides is not given the first");
    assert.match(said(twice), /more than one right side/);
  });

  test("ordering from the declared order", () => {
    const body = `<orderInteraction responseIdentifier="RESPONSE" shuffle="true">${choices("Third", "First", "Second")}</orderInteraction>`;
    const q = read(item21("i1", decl("ordered", "identifier", ["c2", "c3", "c1"]), body), "i1.xml").questions[0] as Question;
    assert.equal(q.type, "ordering");
    assert.deepEqual((q.body as { items: Array<{ content: unknown; position: number }> }).items.map((i) => [plainOf(i.content), i.position]), [["First", 1], ["Second", 2], ["Third", 3]]);
    const missing = read(item21("i1", decl("ordered", "identifier", ["c2", "c3"]), body), "i1.xml").questions[0] as Question;
    assert.equal(missing.type, "essay");
  });

  test("an interaction this reader does not know is kept as text with its choices, and fails", () => {
    const q = read(item21("i1", decl("single", "identifier", ["c1"]), `<p>Pick the hot spot.</p><hotspotInteraction responseIdentifier="RESPONSE" maxChoices="1"><hotspotChoice identifier="c1" shape="rect" coords="0,0,5,5"/></hotspotInteraction>`), "i1.xml").questions[0] as Question;
    assert.equal(q.type, "essay");
    assert.match(said(q), /hotspot question is not read/);
    assert.equal(verdictOf(q), "failed");
  });

  test("the points come from the top of SCORE, and feedback shown on a condition is said, not guessed into the right place", () => {
    const q = read(
      item21("i1", decl("single", "identifier", ["c1"]), `<choiceInteraction responseIdentifier="RESPONSE" maxChoices="1">${choices("A", "B")}</choiceInteraction>`, undefined, '<modalFeedback outcomeIdentifier="FEEDBACK" identifier="wrong" showHide="show"><p>Look again.</p></modalFeedback>', "I", ' normalMaximum="3"'),
      "i1.xml",
    ).questions[0] as Question;
    assert.equal(q.points, 3);
    assert.match(said(q), /Feedback that is shown on a condition was not read: "Look again\."/);
  });

  test("MathML is not turned into LaTeX: it stays as [equation] and the question is flagged", () => {
    const q = read(item21("i1", decl("single", "identifier", ["c1"]), `<p>Solve <math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi></math>.</p><choiceInteraction responseIdentifier="RESPONSE" maxChoices="1">${choices("1", "2")}</choiceInteraction>`), "i1.xml").questions[0] as Question;
    assert.match(plainOf(q.stem), /Solve \[equation\]/);
    assert.ok(codes(q).includes("import.unread-object"));
  });

  test("a picture beside the item in the package is kept; one outside the package, or climbing out of it, is not", () => {
    const PNG = png(12, 12);
    const item = (src: string): string => item21("i1", decl("single", "identifier", ["c1"]), `<p>Look <img src="${src}" alt="A box"/></p><choiceInteraction responseIdentifier="RESPONSE" maxChoices="1">${choices("A", "B")}</choiceInteraction>`);
    const ok = read(zipOf({ "items/i1.xml": item("../images/box.png"), "images/box.png": PNG })).questions[0] as Question;
    assert.equal(ok.media[0]?.alt, "A box");
    for (const src of ["../../../secret.png", "https://example.org/x.png", "data:image/png;base64,AAAA", "nothere.png"]) {
      const q = read(zipOf({ "items/i1.xml": item(src), "secret.png": PNG })).questions[0] as Question;
      assert.equal(q.media.length, 0, src);
      assert.match(plainOf(q.stem), /\[picture\]/, src);
    }
  });
});

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

describe("a package", () => {
  const choiceItem = (id: string, text: string): string => item21(id, decl("single", "identifier", ["c1"]), `<p>${text}</p><choiceInteraction responseIdentifier="RESPONSE" maxChoices="1">${choices("A", "B")}</choiceInteraction>`);
  const test21 = (refs: string[], title = "The test"): string => `<?xml version="1.0"?><assessmentTest ${NS} identifier="t1" title="${title}"><testPart identifier="p" navigationMode="nonlinear" submissionMode="simultaneous"><assessmentSection identifier="s" title="S" visible="true">${refs.map((r) => `<assessmentItemRef identifier="${r}" href="${r}.xml"/>`).join("")}</assessmentSection></testPart></assessmentTest>`;

  test("the questions are in the order the test lists them, those it does not list follow, and a reference to a missing item is said", () => {
    const result = read(zipOf({ "imsmanifest.xml": "<manifest/>", "a.xml": choiceItem("a", "Alpha"), "b.xml": choiceItem("b", "Bravo"), "c.xml": choiceItem("c", "Charlie"), "test.xml": test21(["c", "a", "gone"]) }));
    assert.deepEqual(result.questions.map((q) => plainOf(q.stem)), ["Charlie", "Alpha", "Bravo"]);
    assert.ok(result.questions.slice(0, 2).every((q) => q.metadata.tags[0] === "The test"));
    assert.deepEqual(result.questions[2]?.metadata.tags, []);
    assert.match(result.fileFindings.map((f) => f.message).join(" "), /names the item gone\.xml, which is not in the package/);
  });

  test("an XML file that is not a question is counted and said, and one that is not well formed is said with the file", () => {
    const result = read(zipOf({ "a.xml": choiceItem("a", "Alpha"), "assessment_meta.xml": "<quiz><title>x</title></quiz>", "settings.xml": "<course/>", "bad.xml": "<assessmentItem><oops" }));
    assert.equal(result.questions.length, 1);
    const said = result.fileFindings.map((f) => f.message).join(" | ");
    assert.match(said, /2 XML files of the package are not questions or a test/);
    assert.match(said, /bad\.xml is not well formed XML and was not read/);
  });

  test("a package from a Canvas export holds one file of items, with its own settings files beside it", () => {
    const result = read(zipOf({ "imsmanifest.xml": "<manifest/>", "g1/g1.xml": assessment12([mc12("2"), mc12("1", ["X", "Y"])], "Unit 1"), "g1/assessment_meta.xml": "<quiz/>", "course_settings/course_settings.xml": "<course/>" }));
    assert.equal(result.questions.length, 2);
    assert.ok(result.questions.every((q) => q.metadata.tags[0] === "Unit 1"));
    assert.match(result.fileFindings.map((f) => f.message).join(" "), /2 XML files of the package are not questions/);
  });

  test("the lines beside each question are its own XML", () => {
    const result = read(zipOf({ "a.xml": choiceItem("a", "Alpha"), "b.xml": choiceItem("b", "Bravo") }));
    const lines = result.sourceLines ?? [];
    const second = result.questions[1]?.origin?.source as { firstBlock: number; lastBlock: number };
    const shown = lines.slice(second.firstBlock, second.lastBlock + 1).join("\n");
    assert.match(shown, /^<!-- b\.xml -->/);
    assert.match(shown, /Bravo/);
    assert.doesNotMatch(shown, /Alpha/);
  });

  test("a package of more than five thousand items is read, which a publisher's bank can be, in a reasonable time", () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 5001; i++) files[`i${i}.xml`] = choiceItem(`i${i}`, `Question ${i}`);
    const started = Date.now();
    const result = read(zipOf(files));
    assert.equal(result.questions.length, 5001);
    assert.equal(result.counts.parsed, 5001);
    assert.ok(Date.now() - started < 20000, "it takes seconds, not minutes");
  });

  test("a zip that holds no QTI says that no question was found", () => {
    const result = read(zipOf({ "readme.txt": "hello", "data.xml": "<root/>" }));
    assert.deepEqual(result.questions, []);
    assert.match(result.fileFindings.map((f) => f.message).join(" "), /No question was found/);
  });

  test("something that is not a zip or XML, a zip cut short, and an empty file are refused in a sentence", () => {
    for (const bytes of [new Uint8Array(Buffer.from("not anything")), new Uint8Array(0), zipOf({ "a.xml": choiceItem("a", "Alpha") }).slice(0, 80)]) {
      const result = read(bytes);
      assert.deepEqual(result.questions, []);
      assert.equal(result.fileFindings[0]?.severity, "error");
      assert.ok((result.fileFindings[0]?.message ?? "").length > 20);
    }
  });
});

// ---------------------------------------------------------------------------
// Telling the format, the command line, and damage
// ---------------------------------------------------------------------------

describe("telling the format, the command line, and damage", () => {
  const sample = zipOf({ "imsmanifest.xml": "<manifest/>", "g1/g1.xml": assessment12([mc12("2"), mc12("1", ["X", "Y"])], "Unit 1") });

  test("a .zip is a package, an .xml is told by its first element, and Moodle XML is still Moodle XML", () => {
    assert.equal(importerForContent("export.zip", sample).id, "qti");
    assert.equal(importerForContent("quiz.xml", new Uint8Array(Buffer.from(assessment12([mc12("2")])))).id, "qti");
    assert.equal(importerForContent("renamed.txt", new Uint8Array(Buffer.from(assessment12([mc12("2")])))).id, "qti");
    assert.equal(importerForContent("quiz.xml", new Uint8Array(Buffer.from("<quiz></quiz>"))).id, "moodle-xml");
    assert.equal(looksLikeQtiXml('<?xml version="1.0"?><!-- c --><questestinterop>'), true);
    assert.equal(looksLikeQtiXml("<assessmentItem "), true);
    assert.equal(looksLikeQtiXml("<quiz>"), false);
  });

  test("a package cut at many lengths, and one with bytes changed, is read or refused and never throws", () => {
    for (let at = 0; at < sample.length; at += Math.ceil(sample.length / 150)) {
      const result = read(sample.slice(0, at));
      for (const f of result.fileFindings) assert.ok(f.message.length > 0);
    }
    let state = 99;
    const next = (): number => (state = (state * 1103515245 + 12345) & 0x7fffffff);
    for (let run = 0; run < 200; run++) {
      const copy = sample.slice();
      for (let k = 0; k < 3; k++) copy[next() % copy.length] = next() & 0xff;
      assert.doesNotThrow(() => read(copy), `run ${run}`);
    }
    // The XML inside, damaged on its way in as well.
    const text = assessment12([mc12("2")]);
    for (let run = 0; run < 200; run++) {
      const chars = [...text];
      for (let k = 0; k < 4; k++) chars[next() % chars.length] = String.fromCharCode(32 + (next() % 95));
      assert.doesNotThrow(() => read(chars.join(""), "quiz.xml"), `xml run ${run}`);
    }
  });

  test("`import` reads a package and a bare file from the command line", () => {
    const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
    const folder = mkdtempSync(join(tmpdir(), "oa-qti-in-"));
    try {
      const run = (...args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, ...args], { encoding: "utf8" });
      writeFileSync(join(folder, "export.zip"), sample);
      const imported = run("import", join(folder, "export.zip"), "--out", join(folder, "bank.openassess"));
      assert.equal(imported.status, 0, imported.stderr);
      assert.match(imported.stdout, /profile qti/);
      assert.match(imported.stdout, /parsed\s+2/);
      writeFileSync(join(folder, "bare.xml"), assessment12([mc12("2")]));
      const bare = run("import", join(folder, "bare.xml"));
      assert.match(bare.stdout, /profile qti/);
      const written = run("export", join(folder, "bank.openassess"), "--to", "qti-2.1", "--out", join(folder, "out"));
      assert.equal(written.status, 0, written.stderr);
      assert.ok(readdirSync(join(folder, "out")).some((n) => n.endsWith(".zip")));
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// This program's own packages, read back
// ---------------------------------------------------------------------------

describe("what this program exports, read back", () => {
  const fixtures = join(fileURLToPath(new URL("../../../fixtures/standard-format/", import.meta.url)));

  function facts(q: Question, withPartial: boolean): unknown {
    const body = q.body as unknown as Record<string, unknown>;
    return {
      type: q.type,
      title: q.title,
      points: q.points,
      stem: plainOf(q.stem),
      options: (body["options"] as Array<{ content: unknown; correct: boolean }> | undefined)?.map((o) => [plainOf(o.content), o.correct]),
      partial: withPartial ? body["partialCredit"] : undefined,
      correct: body["correct"],
      accepted: body["accepted"],
      caseSensitive: body["caseSensitive"],
      pairs: (body["pairs"] as Array<{ left: unknown; right: string }> | undefined)?.map((p) => [plainOf(p.left), p.right]),
      distractors: body["distractors"],
    };
  }

  for (const [label, run, partial] of [
    ["QTI 1.2", exportQti12, false],
    ["QTI 2.1", exportQti21, true],
    ["Common Cartridge", exportCommonCartridge, false],
  ] as const) {
    test(`every question of every fixture bank that ${label} can hold comes back as what it was`, () => {
      let checked = 0;
      let questions = 0;
      for (const name of readdirSync(fixtures).filter((n) => /\.(txt|docx)$/.test(n))) {
        const bytes = new Uint8Array(readFileSync(join(fixtures, name)));
        const source = runImporter(importerForContent(name, bytes), bytes, { file: name, at: AT, author: "test" });
        const out = run(source.questions, { name: "Bank" });
        if (out.files.length === 0) continue;
        const zip = out.files[0]?.bytes as Uint8Array;
        const back = runImporter(importerForContent(out.files[0]?.name ?? "", zip), zip, { file: "Bank.zip", at: AT, author: "test" });
        const written = source.questions.filter((_q, i) => out.report.items[i]?.outcome !== "leftOut");
        assert.equal(back.questions.length, written.length, name);
        written.forEach((q, i) => {
          const got = back.questions[i] as Question;
          if (q.type === "fillInBlank") {
            assert.equal(got.type, "shortAnswer", `${name}: ${q.title}`);
            return;
          }
          // A picture the file named and nothing supplied goes out as words.
          if (q.media.length > 0) return;
          // Only what the format carries: a multiple answer question's credit is not carried by 1.2, and the shuffle is on or off for all.
          assert.deepEqual(facts(got, partial), facts(q, partial), `${name}: ${q.title}`);
          questions++;
        });
        checked++;
      }
      assert.ok(checked >= 15, `only ${checked} fixtures were exported`);
      assert.ok(questions >= 40, `only ${questions} questions were compared`);
    });
  }

  const real = join(fileURLToPath(new URL("../../../fixtures/publisher/", import.meta.url)));
  const hasReal = existsSync(real) && readdirSync(real).some((n) => n.endsWith(".expected.json"));
  for (const [label, run, partial] of [
    ["QTI 1.2", exportQti12, false],
    ["QTI 2.1", exportQti21, true],
    ["Common Cartridge", exportCommonCartridge, false],
  ] as const) {
    test(`every real bank in fixtures/publisher, when there are some, comes back from ${label} as what it was`, { skip: hasReal ? false : "none there; the folder is git-ignored and local" }, () => {
      let questions = 0;
      for (const name of readdirSync(real).filter((n) => /\.(txt|docx|xlsx|csv)$/.test(n))) {
        const bytes = new Uint8Array(readFileSync(join(real, name)));
        const source = runImporter(importerForContent(name, bytes), bytes, { file: name, at: AT, author: "test" });
        const out = run(source.questions, { name: "Bank", ...(source.media ? { media: source.media } : {}) });
        if (out.files.length === 0) continue;
        const zip = out.files[0]?.bytes as Uint8Array;
        const back = runImporter(importerForContent(out.files[0]?.name ?? "", zip), zip, { file: "Bank.zip", at: AT, author: "test" });
        const written = source.questions.filter((_q, i) => out.report.items[i]?.outcome !== "leftOut");
        assert.equal(back.questions.length, written.length, name);
        written.forEach((q, i) => {
          if (q.type === "fillInBlank") return;
          assert.deepEqual(facts(back.questions[i] as Question, partial), facts(q, partial), `${name}: ${q.title}`);
          const errors = (back.questions[i] as Question).findings.filter((f) => f.severity === "error" && !q.findings.some((x) => x.code === f.code));
          assert.deepEqual(errors, [], `${name}: ${q.title}`);
          questions++;
        });
      }
      assert.ok(questions > 0);
    });
  }

  test("the QTI 2.1 package is read to the same bank when it is exported again (for the questions it holds)", () => {
    const bytes = new Uint8Array(readFileSync(join(fixtures, "03-mixed-types.txt")));
    const source = runImporter(importerForContent("a.txt", bytes), bytes, { file: "a.txt", at: AT, author: "test" });
    const first = exportQti21(source.questions, { name: "Bank" });
    const back = runImporter(importerForContent("Bank.zip", first.files[0]?.bytes as Uint8Array), first.files[0]?.bytes as Uint8Array, { file: "Bank.zip", at: AT, author: "test" });
    const second = exportQti21(back.questions, { name: "Bank" });
    const a = readPackageTexts(first.files[0]?.bytes as Uint8Array);
    const b = readPackageTexts(second.files[0]?.bytes as Uint8Array);
    assert.deepEqual(b, a);
  });

  test("a picture goes out in the QTI 2.1 package and comes back as the same picture with the same description", () => {
    const PNG = png(16, 16);
    const FILE = "media/p-aaaaaaaaaaaaaaaa.png";
    const source = runImporter(importerForContent("a.txt", new Uint8Array(0)), new Uint8Array(Buffer.from("1. Look at the figure. Which colour?\na) Blue\nb) Red\nAnswer: a\n")), { file: "a.txt", at: AT, author: "test" });
    const q = { ...(source.questions[0] as Question), stem: { format: "rich" as const, content: '<p>Look: <oa-media ref="m1"></oa-media></p>' }, media: [{ id: "m1", file: FILE, mime: "image/png", alt: "A blue box" }] };
    const out = exportQti21([q], { name: "Pictures", media: new Map([[FILE, PNG]]) });
    const back = read(out.files[0]?.bytes as Uint8Array);
    const m = back.questions[0]?.media[0] as Question["media"][number];
    assert.equal(m.alt, "A blue box");
    assert.deepEqual(back.media?.get(m.file), PNG);
    assert.equal(verdictOf(back.questions[0] as Question), "parsed");
  });
});

// ---------------------------------------------------------------------------
// A Common Cartridge package (.imscc), and the files of a course export that end in .qti
// ---------------------------------------------------------------------------

describe("a Common Cartridge package", () => {
  const quiz = assessment12([mc12("2"), mc12("1", ["X", "Y"])], "Unit 1");

  test("a .imscc is read as a package, as the .zip it is, and the importer is told by the name", () => {
    const sample = zipOf({ "imsmanifest.xml": "<manifest/>", "quiz/qti-assessment.xml": quiz });
    assert.equal(importerForContent("course-export.imscc", sample).id, "qti");
    assert.equal(importerForContent("COURSE.IMSCC", sample).id, "qti", "whatever the case of the extension");
    const result = read(sample, "course-export.imscc");
    assert.equal(result.questions.length, 2);
    assert.deepEqual(result.fileFindings.filter((f) => f.severity !== "info"), []);
  });

  test("this program's own Common Cartridge file is read back with each question's points, which the format keeps as a weighting", () => {
    const source = read(zipOf({ "imsmanifest.xml": "<manifest/>", "quiz/qti-assessment.xml": assessment12([item12("multiple_choice_question", `${mat("Which?")}<response_lid ident="response1" rcardinality="Single"><render_choice>${label("1", "A")}${label("2", "B")}</render_choice></response_lid>`, when(eq("response1", "2"), 100), "", "Weighted", "2.5")]) }));
    const out = exportCommonCartridge(source.questions, { name: "Weighted" });
    const name = out.files[0]?.name ?? "";
    assert.match(name, /\.imscc$/);
    const back = runImporter(importerForContent(name, out.files[0]?.bytes as Uint8Array), out.files[0]?.bytes as Uint8Array, { file: name, at: AT, author: "test" });
    assert.equal(back.questions.length, 1);
    assert.equal(back.questions[0]?.points, 2.5, "the weighting, and not the 100 that a right answer scores");
    assert.deepEqual(options(back.questions[0] as Question), [{ text: "A", correct: false }, { text: "B", correct: true }]);
  });

  test("a points_possible still wins where there is one, and an item with neither is worth the default", () => {
    const both = item12("multiple_choice_question", `${mat("Which?")}<response_lid ident="response1" rcardinality="Single"><render_choice>${label("1", "A")}${label("2", "B")}</render_choice></response_lid>`, when(eq("response1", "1"), 100), "", "Both", "4.0").replace("</qtimetadata>", "<qtimetadatafield><fieldlabel>cc_weighting</fieldlabel><fieldentry>9</fieldentry></qtimetadatafield></qtimetadata>");
    assert.equal(read(assessment12([both]), "quiz.xml").questions[0]?.points, 4);
    assert.equal(read(assessment12([mc12("2")].map((x) => x.replace("points_possible", "something_else"))), "quiz.xml").questions[0]?.points, 1, "neither: the default");
  });

  test("files that end in .qti are counted and said, never read as a second copy of the questions", () => {
    const withBoth = zipOf({ "imsmanifest.xml": "<manifest/>", "g1/assessment_qti.xml": quiz, "non_cc_assessments/g1.xml.qti": quiz, "non_cc_assessments/g2.xml.qti": quiz });
    const result = read(withBoth, "course.imscc");
    assert.equal(result.questions.length, 2, "the two questions of the XML file, and none again from the copies");
    const said = result.fileFindings.find((f) => /end in \.qti/.test(f.message));
    assert.ok(said, result.fileFindings.map((f) => f.message).join(" | "));
    assert.equal(said.severity, "info");
    assert.match(said.message, /2 files of the package end in \.qti and were not read, so a question that is only in them is not here/);

    const only = read(zipOf({ "imsmanifest.xml": "<manifest/>", "non_cc_assessments/g1.xml.qti": quiz }), "bank.imscc");
    assert.equal(only.questions.length, 0);
    const warned = only.fileFindings.find((f) => /ends in \.qti/.test(f.message));
    assert.equal(warned?.severity, "warn", "a package that holds nothing else is warned, because it came in empty");
    assert.match(warned?.message ?? "", /One file of the package ends in \.qti and was not read/);
    assert.ok(only.fileFindings.some((f) => /No question was found/.test(f.message)));
  });

  test("a zip that only wraps a question table or a text file says which files to unzip and import, and reads none of them", () => {
    const one = read(zipOf({ "bank/questions.txt": "Question;Correct;Wrong\nWhich?;A;B", "__MACOSX/bank/._questions.txt": "x" }), "download.zip");
    assert.equal(one.questions.length, 0);
    const said = one.fileFindings.map((f) => f.message).join(" | ");
    assert.match(said, /No question was found/);
    assert.match(said, /This zip holds bank\/questions\.txt, which is a file of another kind\. Unzip it and import that file on its own\./);
    assert.ok(!/MACOSX/.test(said), "the Mac's own litter is not offered as a file to import");

    const many = read(zipOf({ "a.csv": "x", "b.xlsx": "x", "c.docx": "x", "d.pdf": "x", "e.txt": "x", "f.gift": "x", "g/readme.html": "x" }), "download.zip");
    const list = many.fileFindings.map((f) => f.message).join(" | ");
    assert.match(list, /This zip holds a\.csv, b\.xlsx, c\.docx, d\.pdf, e\.txt and 1 more, which are files of another kind\. Unzip it and import those files on their own\./);

    const none = read(zipOf({ "notes.html": "x" }), "download.zip");
    assert.ok(!/another kind/.test(none.fileFindings.map((f) => f.message).join(" | ")), "nothing is offered when the zip holds nothing this program reads");
  });

  describe("a package Blackboard exports for its own use (questions in .dat files)", () => {
    const manifest = `<manifest xmlns:bb="http://www.blackboard.com/content-packaging/"><resources><resource bb:file="res00001.dat" type="assessment/x-bb-pool" identifier="res00001"/></resources></manifest>`;
    const dat = `<?xml version="1.0"?><POOL><QUESTIONLIST/></POOL>`;
    const said = (files: Record<string, string>): { questions: number; text: string } => {
      const got = read(zipOf(files), "export.zip");
      return { questions: got.questions.length, text: got.fileFindings.map((f) => `[${f.severity}] ${f.message}`).join(" | ") };
    };

    test("is called what it is, with what this program does read from Blackboard, and none of its files are read", () => {
      const one = said({ "imsmanifest.xml": manifest, "res00001.dat": dat });
      assert.equal(one.questions, 0);
      assert.match(one.text, /\[warn\] No question was found in this file\. It is a package that Blackboard exports for its own use, with its questions in \.dat files \(one \.dat file in all\), and this program does not read that form\./);
      assert.match(one.text, /It does read the tab delimited file that Blackboard takes in \(one question to a row, beginning with its type\), and a Word, Excel or text file of the questions\./);
      assert.ok(!/A QTI file holds/.test(one.text), "the words about QTI do not say what the person has");
    });

    test("is known by a resource that is an assessment of Blackboard's kinds, in a manifest anywhere in the zip", () => {
      const pool = `<manifest><resources><resource type="assessment/x-bb-qti-pool" href="res00001.dat"/></resources></manifest>`;
      const testType = `<manifest><resources><resource type='assessment/x-bb-qti-test' href="res00001.dat"/></resources></manifest>`;
      const cases: Record<string, Record<string, string>> = { "a pool": { "imsmanifest.xml": pool, "res00001.dat": dat }, "a test": { "imsmanifest.xml": testType, "res00001.dat": dat }, "a manifest in a folder": { "export/imsmanifest.xml": manifest, "export/res00001.dat": dat } };
      for (const [name, files] of Object.entries(cases)) {
        assert.match(said(files).text, /package that Blackboard exports for its own use/, name);
      }
    });

    test("counts its .dat files, and counts none of the Mac's own litter", () => {
      assert.match(said({ "imsmanifest.xml": manifest, "res00001.dat": dat, "res00002.dat": dat, "__MACOSX/._res00001.dat": "x" }).text, /\(2 \.dat files in all\),/);
      assert.match(said({ "imsmanifest.xml": manifest, "res00001.dat": dat, "sub/RES00002.DAT": dat }).text, /\(2 \.dat files in all\),/,"by the end of the name, whatever its case or folder");
    });

    test("is not claimed for a zip whose manifest does not name Blackboard, or that has no .dat file, or no manifest", () => {
      const plain = `<manifest><resources><resource type="webcontent" href="a.dat"/></resources></manifest>`;
      // A name that only has ".dat" inside it is not a .dat file, and a file that is only named like the manifest is not the manifest.
      const lookalikes: Array<Record<string, string>> = [{ "imsmanifest.xml": manifest, "notes.dat.txt": "x", "res.data": "x" }, { "my-imsmanifest.xml": manifest, "res00001.dat": dat }, { "imsmanifest.xml.bak": manifest, "res00001.dat": dat }];
      const unclaimed: Array<Record<string, string>> = [{ "imsmanifest.xml": plain, "a.dat": dat }, { "imsmanifest.xml": manifest, "res.txt": "x" }, { "res00001.dat": dat }, { "__MACOSX/._res.dat": "x", "imsmanifest.xml": manifest }, ...lookalikes];
      for (const files of unclaimed) {
        const got = said(files);
        assert.ok(!/Blackboard/.test(got.text), `no claim for ${Object.keys(files).join(", ")}`);
        assert.match(got.text, /A QTI file holds item elements/);
      }
    });

    // Found by a second reviewer: a course export with only documents and announcements has .dat files too and names Blackboard, and was
    // told it held questions; and a manifest that only mentions the company, with a file to import beside it, lost the advice to import it.
    test("is not claimed for a course export that holds no assessment, or a manifest that only mentions the company", () => {
      const course = `<manifest xmlns:bb="http://www.blackboard.com/content-packaging/"><resources><resource type="resource/x-bb-document" bb:file="res00001.dat"/><resource type="resource/x-bb-announcement" bb:file="res00002.dat"/></resources></manifest>`;
      const got = said({ "imsmanifest.xml": course, "res00001.dat": dat, "res00002.dat": dat });
      assert.ok(!/Blackboard exports/.test(got.text), got.text);
      assert.match(got.text, /A QTI file holds item elements/);
      const mention = `<!-- exported from www.blackboard.com --><manifest><resources/></manifest>`;
      const beside = said({ "imsmanifest.xml": mention, "res00001.dat": dat, "bank.txt": "x" });
      assert.ok(!/Blackboard exports/.test(beside.text));
      assert.match(beside.text, /This zip holds bank\.txt, which is a file of another kind\. Unzip it and import that file on its own\./);
      // A name in an attribute that is not the type does not count either.
      const titled = `<manifest><resources><resource title="assessment/x-bb-pool" type="webcontent"/></resources></manifest>`;
      assert.ok(!/Blackboard exports/.test(said({ "imsmanifest.xml": titled, "a.dat": dat }).text));
    });

    // Found by a third reviewer: the manifest was matched as text in its first 200,000 characters, so words in a comment or another attribute
    // counted, a long export lost the message, only the first manifest was looked at, and a manifest saved as UTF-16 was not read.
    test("is read from the manifest's resources as XML: a comment, another attribute or a long manifest make no difference", () => {
      const pool = (type: string, extra = ""): string => `<manifest xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><resources>${extra}<resource ${type} href="res00001.dat"/></resources></manifest>`;
      const claimed = (files: Record<string, string | Uint8Array>): boolean => /package that Blackboard exports for its own use/.test(read(zipOf(files), "export.zip").fileFindings.map((f) => f.message).join(" | "));
      // The words are in a comment, in an attribute that is not the type, or on an element that is not a resource.
      assert.ok(!claimed({ "imsmanifest.xml": `<manifest><!-- <resource type="assessment/x-bb-pool"/> --><resources/></manifest>`, "a.dat": dat }));
      assert.ok(!claimed({ "imsmanifest.xml": pool('xsi:type="assessment/x-bb-pool" type="webcontent"'), "a.dat": dat }));
      assert.ok(!claimed({ "imsmanifest.xml": pool('data-type="assessment/x-bb-test" type="webcontent"'), "a.dat": dat }));
      assert.ok(!claimed({ "imsmanifest.xml": `<manifest><resources><item type="assessment/x-bb-test"/></resources></manifest>`, "a.dat": dat }));
      // A prefix on the element is still a resource, and a type in either kind of quote counts.
      assert.ok(claimed({ "imsmanifest.xml": `<imscp:manifest xmlns:imscp="x"><imscp:resources><imscp:resource type='assessment/x-bb-qti-pool'/></imscp:resources></imscp:manifest>`, "a.dat": dat }));
      // A thousand and more documents come first, in more than 200,000 characters of manifest, and the pool is last.
      const documents = Array.from({ length: 2500 }, (_, i) => `<resource type="resource/x-bb-document" identifier="res${i}" href="res${i}.dat" title="${"d".repeat(60)}"/>`).join("");
      assert.ok(documents.length > 200000);
      assert.ok(claimed({ "imsmanifest.xml": pool('type="assessment/x-bb-qti-pool"', documents), "a.dat": dat }), "the pool is last");
      // Another manifest of the package, not the first one found, names the pool.
      assert.ok(claimed({ "imsmanifest.xml": `<manifest><resources/></manifest>`, "export/imsmanifest.xml": pool('type="assessment/x-bb-qti-test"'), "a.dat": dat }));
      // A manifest saved as UTF-16 is read as that, and one that is not XML at all names nothing and does not stop the import.
      const utf16 = new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(pool('type="assessment/x-bb-qti-pool"'), "utf16le")]));
      assert.ok(claimed({ "imsmanifest.xml": utf16, "a.dat": dat }));
      assert.ok(!claimed({ "imsmanifest.xml": "this is not xml <<<", "a.dat": dat }));
      assert.ok(!claimed({ "imsmanifest.xml": "", "a.dat": dat }));
    });

    // Found by a fourth reviewer: a manifest with 125,000 children threw a RangeError out of the importer (children were spread into push()),
    // and a manifest the strict reader refuses lost the message the old text match gave.
    test("a manifest of a hundred and thirty thousand resources is read, and the import does not throw", () => {
      const documents = Array.from({ length: 130000 }, (_, i) => `<resource type="resource/x-bb-document" identifier="r${i}"/>`).join("");
      const big = `<manifest><resources>${documents}<resource type="assessment/x-bb-qti-pool" href="a.dat"/></resources></manifest>`;
      const got = said({ "imsmanifest.xml": big, "a.dat": dat });
      assert.match(got.text, /package that Blackboard exports for its own use/);
    });

    test("a manifest the strict reader refuses is looked at as text, for the start tag of a resource only", () => {
      const refused: Record<string, string> = {
        "an undeclared prefix": `<manifest><resources><bb:thing/><resource type="assessment/x-bb-pool" href="a.dat"/></resources></manifest>`,
        "a document type": `<!DOCTYPE manifest><manifest><resources><resource type="assessment/x-bb-pool" href="a.dat"/></resources></manifest>`,
        "an entity": `<manifest><title>caf&eacute;</title><resources><resource type='assessment/x-bb-qti-test' href="a.dat"/></resources></manifest>`,
        "a prefix on the element": `<manifest><resources><imscp:resource type="assessment/x-bb-pool" href="a.dat"/></resources></manifest>`,
        "a space before the value": `<manifest><resources><resource type=" assessment/x-bb-pool" href="a.dat"/></resources></manifest>`,
      };
      for (const [name, manifestText] of Object.entries(refused)) {
        assert.match(said({ "imsmanifest.xml": manifestText, "a.dat": dat }).text, /package that Blackboard exports for its own use/, name);
      }
      // The same words in another attribute, or on another element, are still nothing when the manifest is one the strict reader refuses.
      const nothing: Record<string, string> = {
        "xsi:type": `<manifest><resources><bb:thing/><resource xsi:type="assessment/x-bb-pool" type="webcontent" href="a.dat"/></resources></manifest>`,
        "data-type": `<manifest><resources><bb:thing/><resource data-type="assessment/x-bb-pool" type="webcontent" href="a.dat"/></resources></manifest>`,
        "an item": `<manifest><resources><bb:thing/><item type="assessment/x-bb-pool"/></resources></manifest>`,
      };
      for (const [name, manifestText] of Object.entries(nothing)) {
        assert.ok(!/Blackboard exports/.test(said({ "imsmanifest.xml": manifestText, "a.dat": dat }).text), name);
      }
    });

    test("a manifest of thousands of start tags that are never closed is not slow", () => {
      const hostile = "<manifest><bb:thing/>" + "<resource ".repeat(200000);
      const start = performance.now();
      const got = said({ "imsmanifest.xml": hostile, "a.dat": dat });
      // 1.4 seconds on a quiet machine, and the quadratic way of looking took minutes: the line is far from both, since the first line
      // (1.5 seconds) failed on a machine that was doing other work.
      assert.ok(performance.now() - start < 6000, `${Math.round(performance.now() - start)} ms`);
      assert.ok(!/Blackboard exports/.test(got.text));
    });

    test("keeps the advice to import a file that is beside it, after what it says it is", () => {
      const got = said({ "imsmanifest.xml": manifest, "res00001.dat": dat, "bank.txt": "x" });
      assert.match(got.text, /package that Blackboard exports for its own use/);
      assert.match(got.text, /This zip holds bank\.txt, which is a file of another kind\. Unzip it and import that file on its own\./);
    });

    test("says nothing about Blackboard when questions were found, whatever else the package holds", () => {
      const got = read(zipOf({ "imsmanifest.xml": manifest, "res00001.dat": dat, "quiz.xml": quiz }), "export.zip");
      assert.equal(got.questions.length, 2);
      assert.ok(!got.fileFindings.some((f) => /Blackboard exports/.test(f.message)));
    });
  });
});

/** Every file of a zip as text, by name, for comparing two packages. */
function readPackageTexts(bytes: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const files = unzipSync(bytes);
  for (const [name, data] of files) out[name] = Buffer.from(data).toString("utf8");
  return out;
}
