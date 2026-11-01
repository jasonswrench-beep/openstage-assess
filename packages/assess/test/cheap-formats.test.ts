/**
 * Aiken and GIFT in, GIFT and Moodle XML out. The rules under test are the ones every importer and exporter here keeps: a
 * key is read only where the file gives one and never made up, nothing is dropped without a word, a question that cannot be
 * built is kept and fails, and a question without a usable key is never exported. The text is invented.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { aikenImporter, looksLikeAiken } from "../src/import/aiken.ts";
import { giftImporter, giftUnescape, looksLikeGift } from "../src/import/gift.ts";
import { importerForContent } from "../src/import/registry.ts";
import { standardTextImporter } from "../src/import/standard-text.ts";
import { wordImporter } from "../src/import/word.ts";
import { exportGift, giftEscape } from "../src/export/gift.ts";
import { cdata, exportMoodleXml } from "../src/export/moodle-xml.ts";
import { parseXml, allText, elements, first, type XmlElement } from "../src/import/docx/xml.ts";
import { FindingCode, liveFindings, verdictFrom } from "../src/model/findings.ts";
import { createQuestion } from "../src/model/create.ts";
import { plainToRich, rich, richTextToPlain } from "../src/model/richtext.ts";
import type { Question, QuestionBody, QuestionType } from "../src/model/question.ts";

const AT = "2026-01-01T00:00:00.000Z";
const OPTIONS = { file: "t.txt", at: AT, author: "test" };
const gift = (text: string) => giftImporter.parse(text, { ...OPTIONS, file: "t.gift" });
const aiken = (text: string) => aikenImporter.parse(text, { ...OPTIONS, file: "t.aiken" });
const plain = (q: Question): string => richTextToPlain(q.stem);
const verdict = (q: Question): string => verdictFrom(q.findings);
const has = (q: Question, code: string): boolean => liveFindings(q.findings).some((f) => f.code === code);
const body = (q: Question): Record<string, unknown> => q.body as unknown as Record<string, unknown>;
const options = (q: Question): Array<{ text: string; correct: boolean; feedback?: string }> =>
  (body(q)["options"] as Array<{ content: { content: string }; correct: boolean; feedback?: { content: string } }>).map((o) => ({
    text: richTextToPlain(o.content as never),
    correct: o.correct,
    ...(o.feedback ? { feedback: richTextToPlain(o.feedback as never) } : {}),
  }));

const make = (type: QuestionType, b: QuestionBody, stem = "What is the capital of France?", extra: Partial<Parameters<typeof createQuestion>[0]> = {}): Question =>
  createQuestion({ type, stem: plainToRich(stem), body: b, by: "test", at: AT, ...extra });
const opt = (id: string, text: string, correct = false, feedback?: string) => ({ id, content: plainToRich(text), correct, ...(feedback ? { feedback: plainToRich(feedback) } : {}) });

// ---------------------------------------------------------------------------
// Aiken
// ---------------------------------------------------------------------------

describe("Aiken in", () => {
  test("reads a question, its options and its answer, and marks nothing else", () => {
    const result = aiken("What is the capital of France?\nA. Berlin\nB. Paris\nC. Rome\nANSWER: B\n");
    assert.equal(result.questions.length, 1);
    const q = result.questions[0] as Question;
    assert.equal(q.type, "multipleChoice");
    assert.equal(plain(q), "What is the capital of France?");
    assert.deepEqual(options(q).map((o) => [o.text, o.correct]), [["Berlin", false], ["Paris", true], ["Rome", false]]);
    assert.equal(verdict(q), "parsed");
    assert.deepEqual(q.origin?.source, { file: "t.aiken", firstBlock: 0, lastBlock: 4 });
  });

  test("reads A) as well as A., lower case letters and a lower case ANSWER", () => {
    const q = aiken("Which?\na) One\nb) Two\nanswer: b\n").questions[0] as Question;
    assert.deepEqual(options(q).map((o) => o.correct), [false, true]);
    assert.equal(verdict(q), "parsed");
  });

  test("keeps the line numbers of each question in a file of several", () => {
    const result = aiken("First?\nA. a\nB. b\nANSWER: A\n\nSecond?\nA. a\nB. b\nANSWER: B\n");
    assert.deepEqual(result.questions.map((q) => [q.origin?.source?.firstBlock, q.origin?.source?.lastBlock]), [[0, 3], [5, 8]]);
  });

  test("keeps a question with no ANSWER, with no answer marked, and fails it", () => {
    const q = aiken("Which?\nA. One\nB. Two\n").questions[0] as Question;
    assert.ok(options(q).every((o) => !o.correct));
    assert.equal(verdict(q), "failed");
  });

  test("marks nothing when the ANSWER names a letter that is not there", () => {
    const q = aiken("Which?\nA. One\nB. Two\nANSWER: C\n").questions[0] as Question;
    assert.ok(options(q).every((o) => !o.correct));
    assert.ok(has(q, FindingCode.KeyLetterMissing));
    assert.equal(verdict(q), "failed");
  });

  test("marks nothing when the ANSWER is not a letter, or when there are two ANSWER lines that could disagree", () => {
    const words = aiken("Which?\nA. One\nB. Two\nANSWER: Paris\n").questions[0] as Question;
    assert.ok(options(words).every((o) => !o.correct));
    assert.equal(verdict(words), "failed");
    const two = aiken("Which?\nA. One\nB. Two\nANSWER: A\nANSWER: B\n").questions[0] as Question;
    assert.ok(options(two).every((o) => !o.correct));
    assert.ok(has(two, FindingCode.KeysDisagree));
  });

  test("reads an ANSWER that names several letters as a multiple response, and says to check it", () => {
    const q = aiken("Which are even?\nA. 1\nB. 2\nC. 3\nD. 4\nANSWER: B, D\n").questions[0] as Question;
    assert.equal(q.type, "multipleResponse");
    assert.deepEqual(options(q).map((o) => o.correct), [false, true, false, true]);
    assert.ok(has(q, FindingCode.MoreThanOneRight));
    assert.equal(verdict(q), "needsReview");
  });

  test("reports text after the ANSWER line with its words, and joins a line that is more of an option", () => {
    const q = aiken("Which?\nA. One that\ngoes on\nB. Two\nANSWER: A\nSee page 4.\n").questions[0] as Question;
    assert.equal(options(q)[0]?.text, "One that goes on");
    const messages = q.findings.map((f) => f.message).join("\n");
    assert.match(messages, /Text after the ANSWER line was not read: "See page 4\."/);
    assert.match(messages, /was read as more of that option: "goes on"/);
  });

  test("lists a block with no options as text no question used, with its words", () => {
    const result = aiken("A heading\n\nWhich?\nA. One\nB. Two\nANSWER: A\n");
    assert.equal(result.questions.length, 1);
    assert.equal(result.orphans.length, 1);
    assert.equal(result.orphans[0]?.text, "A heading");
    assert.equal(result.counts.orphans, 1);
  });

  test("flags a skipped letter and a repeated letter", () => {
    const skipped = aiken("Which?\nA. One\nC. Three\nANSWER: C\n").questions[0] as Question;
    assert.ok(has(skipped, FindingCode.OptionLetterGap));
    const repeated = aiken("Which?\nA. One\nA. Again\nANSWER: A\n").questions[0] as Question;
    assert.ok(has(repeated, FindingCode.DuplicateOptionLetter));
  });

  test("says when a file holds no question", () => {
    const result = aiken("Nothing here at all.\n");
    assert.equal(result.questions.length, 0);
    const empty = aiken("");
    assert.match(empty.fileFindings.map((f) => f.message).join(), /No question was found/);
  });
});

// ---------------------------------------------------------------------------
// GIFT
// ---------------------------------------------------------------------------

describe("GIFT in", () => {
  test("reads a multiple choice question with feedback, a title and a general note", () => {
    const q = gift("::Capital:: What is the capital of France? {\n=Paris#Right!\n~Berlin#No, that is Germany.\n~Rome\n####The capital is where the government sits.\n}\n").questions[0] as Question;
    assert.equal(q.title, "Capital");
    assert.equal(q.type, "multipleChoice");
    assert.deepEqual(options(q), [
      { text: "Paris", correct: true, feedback: "Right!" },
      { text: "Berlin", correct: false, feedback: "No, that is Germany." },
      { text: "Rome", correct: false },
    ]);
    assert.equal(richTextToPlain(q.feedback.general as never), "The capital is where the government sits.");
    assert.equal(verdict(q), "parsed");
  });

  test("reads true or false, in every spelling", () => {
    for (const [spelling, expected] of [["TRUE", true], ["T", true], ["true", true], ["FALSE", false], ["F", false]] as const) {
      const q = gift(`The Sun is a star. {${spelling}}\n`).questions[0] as Question;
      assert.equal(q.type, "trueFalse", spelling);
      assert.equal((q.body as { correct: boolean }).correct, expected, spelling);
    }
  });

  test("reports feedback written after TRUE or FALSE, since its form differs between tools", () => {
    const q = gift("The Sun is a star. {TRUE#Wrong#Right}\n").questions[0] as Question;
    assert.match(q.findings.map((f) => f.message).join(), /Feedback written after TRUE or FALSE was not read: "Wrong \| Right"/);
    assert.equal(verdict(q), "needsReview");
  });

  test("reads weights as a multiple response, and warns when they do not add up to a hundred", () => {
    const fine = gift("Which are primary? {~%50%Red ~%50%Blue ~%-100%Green}\n").questions[0] as Question;
    assert.equal(fine.type, "multipleResponse");
    assert.deepEqual(options(fine).map((o) => o.correct), [true, true, false]);
    assert.equal((fine.body as { partialCredit: boolean }).partialCredit, true);
    assert.equal(verdict(fine), "parsed");
    const off = gift("Which? {~%30%Red ~%30%Blue ~%-100%Green}\n").questions[0] as Question;
    assert.ok(has(off, FindingCode.WeightsNotKept));
    assert.equal(verdict(off), "needsReview");
  });

  test("reads one answer worth everything among weighted ones as a single answer", () => {
    const q = gift("Which? {~%100%Red ~%0%Blue}\n").questions[0] as Question;
    assert.equal(q.type, "multipleChoice");
    assert.deepEqual(options(q).map((o) => o.correct), [true, false]);
  });

  test("keeps a choice question with no = in it with no answer, and fails it", () => {
    const q = gift("Which? {~Red ~Blue}\n").questions[0] as Question;
    assert.ok(options(q).every((o) => !o.correct));
    assert.equal(verdict(q), "failed");
  });

  test("reads several = among ~ as a multiple response, and says so", () => {
    const q = gift("Which? {=Red =Blue ~Green}\n").questions[0] as Question;
    assert.equal(q.type, "multipleResponse");
    assert.ok(has(q, FindingCode.MoreThanOneRight));
  });

  test("reads a short answer with every accepted answer, and reports a partial credit one instead of accepting it", () => {
    const q = gift("Name the river. {=Nile =the Nile =%50%Nil}\n").questions[0] as Question;
    assert.equal(q.type, "shortAnswer");
    assert.deepEqual((q.body as { accepted: string[] }).accepted, ["Nile", "the Nile"]);
    assert.match(q.findings.map((f) => f.message).join(), /"Nil" is worth 50 percent, which is partial credit/);
  });

  test("reads a matching question, and refuses one with a line that is not a pair", () => {
    const q = gift("Match. {\n=France -> Paris\n=Italy -> Rome\n=Spain -> Madrid\n}\n").questions[0] as Question;
    assert.equal(q.type, "matching");
    assert.deepEqual((q.body as { pairs: Array<{ right: string }> }).pairs.map((p) => p.right), ["Paris", "Rome", "Madrid"]);
    const bad = gift("Match. {\n=France -> Paris\n=Italy\n}\n").questions[0] as Question;
    assert.equal(bad.type, "essay");
    assert.ok(has(bad, FindingCode.UnsupportedType));
    assert.match(plain(bad), /France -> Paris/, "the text is kept");
    assert.equal(verdict(bad), "failed");
  });

  test("reads a number, a number with a tolerance, and a range", () => {
    const exact = gift("How many? {#10}\n").questions[0] as Question;
    assert.deepEqual(exact.body, { mode: "exact", value: 10 });
    const tolerance = gift("How many? {#9.8:0.1}\n").questions[0] as Question;
    assert.deepEqual(tolerance.body, { mode: "tolerance", value: 9.8, tolerance: 0.1 });
    const range = gift("How many? {#1..5}\n").questions[0] as Question;
    assert.deepEqual(range.body, { mode: "range", min: 1, max: 5 });
    const nonsense = gift("How many? {#lots}\n").questions[0] as Question;
    assert.ok(has(nonsense, FindingCode.UnsupportedType));
  });

  test("reads a blank in the text as a fill in the blank, and several as several blanks", () => {
    const one = gift("The capital of Italy is {=Rome =Roma}.\n").questions[0] as Question;
    assert.equal(one.type, "fillInBlank");
    assert.equal(plain(one), "The capital of Italy is _____.");
    assert.deepEqual((one.body as { blanks: Array<{ accepted: string[] }> }).blanks[0]?.accepted, ["Rome", "Roma"]);
    const two = gift("{=Rome} is the capital of {=Italy}.\n").questions[0] as Question;
    assert.equal((two.body as { blanks: unknown[] }).blanks.length, 2);
    assert.equal(plain(two), "_____ is the capital of _____.");
  });

  test("reads empty braces as an essay", () => {
    const q = gift("Explain why the sky is blue. {}\n").questions[0] as Question;
    assert.equal(q.type, "essay");
    assert.equal(verdict(q), "parsed");
  });

  test("undoes the escapes, and does not take an escaped mark for an answer", () => {
    assert.equal(giftUnescape("a\\=b\\~c\\#d\\{e\\}f\\:g\\\\h\\nj"), "a=b~c#d{e}f:g\\h\nj");
    const q = gift("What does 2 \\+ 2 \\= 4 mean\\? {=It is true\\: yes \\{really\\}}\n").questions[0] as Question;
    assert.equal(plain(q), "What does 2 + 2 = 4 mean?");
    assert.deepEqual((q.body as { accepted: string[] }).accepted, ["It is true: yes {really}"]);
  });

  test("reads a text with a marked format, and says when it did not convert Markdown", () => {
    const html = gift("[html]Which is <b>bold</b> and <blink>odd</blink>? {=Yes}\n").questions[0] as Question;
    assert.match((html.stem as { content: string }).content, /<strong>bold<\/strong>/, "b is the model's strong");
    assert.match(plain(html), /odd/, "and the words of a tag that is taken out are kept");
    assert.match(html.findings.map((f) => f.message).join(), /taken out, leaving its words: <blink>/);
    const markdown = gift("[markdown]Which is *bold*? {=Yes}\n").questions[0] as Question;
    assert.ok(has(markdown, FindingCode.MarkupRemoved));
  });

  test("keeps a category as a tag on the questions after it, and says so", () => {
    const result = gift("$CATEGORY: $course$/top/Capitals\n\nQ one. {TRUE}\n\n$CATEGORY: Other\n\nQ two. {FALSE}\n");
    assert.deepEqual(result.questions.map((q) => q.metadata.tags), [["Capitals"], ["Other"]]);
    assert.match(result.fileFindings.map((f) => f.message).join(), /2 category lines/);
  });

  test("skips comments, joins a question over several lines, and does not split at a blank line inside braces", () => {
    const result = gift("// a comment\nFirst line of the question\nsecond line. {\n=One\n\n~Two\n}\n\n// another\nNext. {TRUE}\n");
    assert.equal(result.questions.length, 2);
    assert.equal(plain(result.questions[0] as Question), "First line of the question\nsecond line.");
    assert.deepEqual(options(result.questions[0] as Question).map((o) => o.text), ["One", "Two"]);
  });

  test("lists text with no answer in it as text no question used, with its words", () => {
    const result = gift("Just a description of the course. \n\nQ. {TRUE}\n");
    assert.equal(result.orphans.length, 1);
    assert.match(result.orphans[0]?.text ?? "", /description of the course/);
    assert.match(result.orphans[0]?.reason ?? "", /description, not a question/);
  });

  test("keeps the lines of each question", () => {
    const result = gift("// c\nQ one. {TRUE}\n\nQ two\nstill two. {FALSE}\n");
    assert.deepEqual(result.questions.map((q) => [q.origin?.source?.firstBlock, q.origin?.source?.lastBlock]), [[1, 1], [3, 4]]);
  });

  test("keeps a block it cannot read as text, as a failed essay, and loses none of its words", () => {
    const q = gift("::T:: Odd one {=%50%a =%50%b ~c ~%25%d #x}\n").questions[0] as Question;
    assert.notEqual(verdict(q), "parsed");
    const all = JSON.stringify(q);
    assert.match(all, /Odd one/);
  });

  test("says when the file holds no question", () => {
    assert.match(gift("").fileFindings.map((f) => f.message).join(), /No question was found/);
  });
});

// ---------------------------------------------------------------------------
// Telling the formats apart
// ---------------------------------------------------------------------------

describe("telling a text file's format by what is in it", () => {
  const FIXTURES = fileURLToPath(new URL("../../../fixtures/standard-format/", import.meta.url));
  const bytes = (text: string): Uint8Array => Buffer.from(text, "utf8");

  test("chooses GIFT for answers in braces, Aiken for unnumbered questions with an ANSWER line, and the Standard Format for the rest", () => {
    assert.equal(importerForContent("a.txt", bytes("Q one. {TRUE}\n\nQ two. {=a =b}\n")), giftImporter);
    assert.equal(importerForContent("a.txt", bytes("One?\nA. a\nB. b\nANSWER: A\n\nTwo?\nA. a\nB. b\nANSWER: B\n")), aikenImporter);
    assert.equal(importerForContent("a.txt", bytes("1. One?\na. a\n*b. b\n\n2. Two?\n*a. a\nb. b\n")), standardTextImporter);
    assert.equal(importerForContent("a.txt", bytes("")), standardTextImporter);
    assert.equal(importerForContent("noextension", bytes("hello")), standardTextImporter);
  });

  test("believes a name that names a format", () => {
    assert.equal(importerForContent("a.docx", bytes("x")), wordImporter);
    assert.equal(importerForContent("a.gift", bytes("not gift at all")), giftImporter);
    assert.equal(importerForContent("a.aiken", bytes("not aiken")), aikenImporter);
  });

  test("never takes a file of the Standard Format for GIFT or Aiken", () => {
    for (const name of readdirSync(FIXTURES).filter((n) => n.endsWith(".txt"))) {
      const text = readFileSync(join(FIXTURES, name), "utf8");
      assert.equal(looksLikeGift(text), false, `${name} is not GIFT`);
      assert.equal(looksLikeAiken(text), false, `${name} is not Aiken`);
      assert.equal(importerForContent(name, bytes(text)), standardTextImporter, name);
    }
  });

  test("does not take a numbered file for Aiken, even when it has lettered options and ANSWER lines, because that is the Standard Format", () => {
    const numbered = "1. One?\nA. a\nB. b\nANSWER: A\n\n2. Two?\nA. a\nB. b\nANSWER: B\n";
    assert.equal(looksLikeAiken(numbered), false);
    assert.equal(importerForContent("a.txt", bytes(numbered)), standardTextImporter);
    const unnumbered = "One?\nA. a\nB. b\nANSWER: A\n\nTwo?\nA. a\nB. b\nANSWER: B\n";
    assert.equal(looksLikeAiken(unnumbered), true, "and the same file without the numbers is Aiken");
  });

  test("does not take one stray brace or one ANSWER line for a format", () => {
    assert.equal(looksLikeGift("1. A set {1, 2, 3} is what?\n*a. a thing\nb. b\n\n2. Two?\n*a. a\nb. b\n"), false);
    assert.equal(looksLikeAiken("Which?\nA. a\nB. b\nANSWER: A\n"), false, "one block is not a pattern");
  });
});

// ---------------------------------------------------------------------------
// GIFT out
// ---------------------------------------------------------------------------

const SET: Question[] = [
  make("multipleChoice", { shuffle: true, options: [opt("o1", "Berlin"), opt("o2", "Paris", true, "Right!"), opt("o3", "Rome")] }, "What is the capital of France?", { title: "Capital" }),
  make("multipleResponse", { shuffle: true, partialCredit: true, options: [opt("o1", "Red", true), opt("o2", "Green"), opt("o3", "Blue", true)] }, "Which are primary colours?"),
  make("trueFalse", { correct: true }, "The Sun is a star."),
  make("shortAnswer", { caseSensitive: false, accepted: ["Nile", "the Nile"] }, "Name the longest river in Egypt."),
  make("matching", { shuffle: true, distractors: [], pairs: [{ id: "p1", left: plainToRich("France"), right: "Paris" }, { id: "p2", left: plainToRich("Italy"), right: "Rome" }, { id: "p3", left: plainToRich("Spain"), right: "Madrid" }] }, "Match each country."),
  make("numeric", { mode: "tolerance", value: 9.8, tolerance: 0.1 }, "What is g?"),
  make("essay", {}, "Explain why the sky is blue."),
];

describe("GIFT out", () => {
  const out = exportGift(SET, { name: "Capitals" });
  const file = out.files[0]?.content ?? "";

  test("writes one file, with a category, and one block for each question", () => {
    assert.equal(out.files.length, 1);
    assert.equal(out.files[0]?.name, "Capitals.txt");
    assert.match(file, /^\/\/ Written by OpenAssess/);
    assert.match(file, /\$CATEGORY: \$course\$\/top\/Capitals/);
    assert.equal(out.report.exported + out.report.exportedWithLosses, 7);
    assert.equal(out.report.leftOut, 0);
  });

  test("writes each kind of question in GIFT's own form", () => {
    assert.match(file, /::Capital:: What is the capital of France\? \{\n~Berlin\n=Paris#Right!\n~Rome\n\}/);
    assert.match(file, /~%50%Red\n~%-50%Green\n~%50%Blue/);
    assert.match(file, /The Sun is a star\. \{\nTRUE\n\}/);
    assert.match(file, /=Nile\n=the Nile/);
    assert.match(file, /=France -> Paris\n=Italy -> Rome\n=Spain -> Madrid/);
    assert.match(file, /#9\.8:0\.1/);
    assert.match(file, /Explain why the sky is blue\. \{\}/);
  });

  test("escapes what GIFT gives a meaning to, so a stem cannot turn into an answer", () => {
    assert.equal(giftEscape("a=b~c#d{e}f:g\\h\ni"), "a\\=b\\~c\\#d\\{e\\}f\\:g\\\\h\\ni");
    const q = make("shortAnswer", { caseSensitive: false, accepted: ["x = y"] }, "Solve {x} = 2 + 2 ~ now: what is x?");
    const text = exportGift([q]).files[0]?.content ?? "";
    assert.match(text, /Solve \\\{x\\\} \\= 2 \+ 2 \\~ now\\: what is x\?/);
    const back = giftImporter.parse(text, OPTIONS).questions[0] as Question;
    assert.equal(plain(back), "Solve {x} = 2 + 2 ~ now: what is x?");
    assert.deepEqual((back.body as { accepted: string[] }).accepted, ["x = y"]);
  });

  test("says what GIFT cannot hold, against the question that lost it", () => {
    const notes = (n: number): string[] => out.report.items[n - 1]?.notes ?? [];
    assert.ok(notes(2).some((x) => /written as weights/.test(x)));
    const fixed = exportGift([make("multipleChoice", { shuffle: false, options: [opt("o1", "A", true), opt("o2", "B")] })]).report.items[0]?.notes ?? [];
    assert.ok(fixed.some((x) => /fixed order/.test(x)));
    const tf = exportGift([make("trueFalse", { correct: true }, "True?", { feedback: { correct: plainToRich("Yes") } })]).report.items[0]?.notes ?? [];
    assert.ok(tf.some((x) => /Feedback for a right or a wrong answer is not carried/.test(x)));
    const numeric = exportGift([make("numeric", { mode: "exact", value: 3, units: "m" })]).report.items[0]?.notes ?? [];
    assert.ok(numeric.some((x) => /units \(m\)/.test(x)));
  });

  test("leaves out what GIFT cannot hold, and a question with no usable key, with the reason", () => {
    const set = [
      make("ordering", { items: [{ id: "i1", content: plainToRich("A"), position: 1 }, { id: "i2", content: plainToRich("B"), position: 2 }] }, "Order."),
      make("multipleChoice", { shuffle: true, options: [opt("o1", "A"), opt("o2", "B")] }, "No key."),
      make("trueFalse", {}, "No answer."),
      make("matching", { shuffle: true, distractors: [], pairs: [{ id: "p1", left: plainToRich("a"), right: "b" }, { id: "p2", left: plainToRich("c"), right: "d" }] }, "Two pairs."),
    ];
    const result = exportGift(set);
    assert.equal(result.files.length, 0, "nothing could be written, so no file is");
    assert.deepEqual(result.report.items.map((i) => i.outcome), ["leftOut", "leftOut", "leftOut", "leftOut"]);
    assert.match(result.report.items[0]?.notes[0] ?? "", /GIFT has no ordering question/);
    assert.match(result.report.items[1]?.notes[0] ?? "", /cannot be exported until this is fixed in the bank/);
    assert.match(result.report.items[2]?.notes[0] ?? "", /cannot be exported until this is fixed|Neither True nor False/);
    assert.match(result.report.items[3]?.notes[0] ?? "", /needs at least 3/);
  });

  test("writes a question whose text has formatting as HTML, and says the answers became plain text", () => {
    const q = createQuestion({ type: "multipleChoice", stem: rich("<p>Which is <strong>bold</strong>?</p>"), body: { shuffle: true, options: [opt("o1", "Yes", true), opt("o2", "No")] }, by: "t", at: AT });
    const result = exportGift([q]);
    assert.match(result.files[0]?.content ?? "", /\[html\]/);
    assert.ok(result.report.items[0]?.notes.some((n) => /keeps its formatting/.test(n)));
  });

  test("is read back by the importer as the questions that were written", () => {
    const back = giftImporter.parse(file, OPTIONS);
    assert.deepEqual(back.questions.map((q) => q.type), SET.map((q) => q.type));
    assert.deepEqual(back.questions.map(plain), SET.map(plain));
    assert.deepEqual(options(back.questions[0] as Question).map((o) => o.correct), [false, true, false]);
    assert.deepEqual(options(back.questions[1] as Question).map((o) => o.correct), [true, false, true]);
    assert.equal((back.questions[2]?.body as { correct: boolean }).correct, true);
    assert.deepEqual((back.questions[3]?.body as { accepted: string[] }).accepted, ["Nile", "the Nile"]);
    assert.deepEqual(back.questions[5]?.body, { mode: "tolerance", value: 9.8, tolerance: 0.1 });
    assert.equal(back.counts.failed, 0);
    assert.equal(back.orphans.length, 0);
  });

  test("is chosen by the importer's own look at the text", () => {
    assert.equal(importerForContent("Capitals.txt", Buffer.from(file)), giftImporter);
  });
});

// ---------------------------------------------------------------------------
// Moodle XML out
// ---------------------------------------------------------------------------

const questionsOf = (xml: string): XmlElement[] => {
  const root = parseXml(xml);
  assert.equal(root.name, "quiz");
  return elements(root, "question");
};
const textOf = (e: XmlElement | undefined, name: string): string => {
  const child = e ? first(e, name) : undefined;
  const text = child ? first(child, "text") : undefined;
  return text ? allText(text) : "";
};

describe("Moodle XML out", () => {
  const out = exportMoodleXml(SET, { name: "Capitals" });
  const xml = out.files[0]?.content ?? "";
  const all = questionsOf(xml);

  test("writes a well formed file with a category and one question for each", () => {
    assert.equal(out.files[0]?.name, "Capitals.xml");
    assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
    assert.equal(all.length, 1 + 7);
    assert.equal(all[0]?.attrs["type"], "category");
    assert.equal(allText(first(first(all[0] as XmlElement, "category") as XmlElement, "text") as XmlElement), "$course$/top/Capitals");
    assert.deepEqual(all.slice(1).map((q) => q.attrs["type"]), ["multichoice", "multichoice", "truefalse", "shortanswer", "matching", "numerical", "essay"]);
  });

  test("writes a single answer question with its right answer worth everything, and its feedback", () => {
    const q = all[1] as XmlElement;
    assert.equal(textOf(q, "name"), "Capital");
    assert.equal(textOf(q, "questiontext"), "<p>What is the capital of France?</p>");
    assert.equal(allText(first(q, "single") as XmlElement), "true");
    const answers = elements(q, "answer");
    assert.deepEqual(answers.map((a) => [a.attrs["fraction"], allText(first(a, "text") as XmlElement)]), [["0", "<p>Berlin</p>"], ["100", "<p>Paris</p>"], ["0", "<p>Rome</p>"]]);
    assert.equal(textOf(answers[1], "feedback"), "<p>Right!</p>");
  });

  test("writes a multiple response as weights that add up to a hundred", () => {
    const q = all[2] as XmlElement;
    assert.equal(allText(first(q, "single") as XmlElement), "false");
    const fractions = elements(q, "answer").map((a) => Number(a.attrs["fraction"]));
    assert.deepEqual(fractions, [50, -50, 50]);
    assert.equal(fractions.filter((f) => f > 0).reduce((a, b) => a + b, 0), 100);
  });

  test("writes true or false, short answers, matching, a number and an essay", () => {
    const tf = all[3] as XmlElement;
    assert.deepEqual(elements(tf, "answer").map((a) => [allText(first(a, "text") as XmlElement), a.attrs["fraction"]]), [["true", "100"], ["false", "0"]]);
    const sa = all[4] as XmlElement;
    assert.equal(allText(first(sa, "usecase") as XmlElement), "0");
    assert.deepEqual(elements(sa, "answer").map((a) => allText(first(a, "text") as XmlElement)), ["Nile", "the Nile"]);
    const matching = all[5] as XmlElement;
    assert.deepEqual(elements(matching, "subquestion").map((s) => [textOf(s, "text") || allText(first(s, "text") as XmlElement), allText(first(first(s, "answer") as XmlElement, "text") as XmlElement)]), [["<p>France</p>", "Paris"], ["<p>Italy</p>", "Rome"], ["<p>Spain</p>", "Madrid"]]);
    const numeric = all[6] as XmlElement;
    const a = first(numeric, "answer") as XmlElement;
    assert.equal(allText(first(a, "text") as XmlElement), "9.8");
    assert.equal(allText(first(a, "tolerance") as XmlElement), "0.1");
    assert.equal(all[7]?.attrs["type"], "essay");
  });

  test("writes the points of each question, and no penalty, which is a delivery setting", () => {
    const q = createQuestion({ type: "trueFalse", stem: plainToRich("Is it?"), body: { correct: false }, points: 2.5, by: "t", at: AT });
    const text = exportMoodleXml([q]).files[0]?.content ?? "";
    assert.match(text, /<defaultgrade>2\.5<\/defaultgrade>/);
    assert.doesNotMatch(text, /<penalty>/);
  });

  test("carries spare answers in a matching question, and a fill in the blank as a short answer", () => {
    const m = make("matching", { shuffle: true, distractors: ["Oslo"], pairs: [{ id: "p1", left: plainToRich("a"), right: "b" }, { id: "p2", left: plainToRich("c"), right: "d" }] }, "Match.");
    const matching = questionsOf(exportMoodleXml([m]).files[0]?.content ?? "")[1] as XmlElement;
    const subs = elements(matching, "subquestion");
    assert.equal(subs.length, 3);
    assert.equal(allText(first(subs[2] as XmlElement, "text") as XmlElement), "");
    assert.equal(allText(first(first(subs[2] as XmlElement, "answer") as XmlElement, "text") as XmlElement), "Oslo");
    const f = make("fillInBlank", { caseSensitive: true, blanks: [{ id: "b1", accepted: ["Rome"] }] }, "The capital of Italy is ____.");
    const result = exportMoodleXml([f]);
    const written = questionsOf(result.files[0]?.content ?? "")[1] as XmlElement;
    assert.equal(written.attrs["type"], "shortanswer");
    assert.equal(result.report.items[0]?.asType, "short answer");
    assert.equal(allText(first(written, "usecase") as XmlElement), "1", "capital letters must match, and the file says so");
  });

  test("gives feedback for a wrong answer to a short answer by the wildcard answer Moodle uses", () => {
    const q = make("shortAnswer", { caseSensitive: false, accepted: ["Paris"] }, "Capital?", { feedback: { incorrect: plainToRich("Try again.") } });
    const answers = elements(questionsOf(exportMoodleXml([q]).files[0]?.content ?? "")[1] as XmlElement, "answer");
    assert.deepEqual(answers.map((a) => [allText(first(a, "text") as XmlElement), a.attrs["fraction"]]), [["Paris", "100"], ["*", "0"]]);
  });

  test("splits the one sequence that would end a CDATA section early", () => {
    assert.equal(cdata("a ]]> b"), "<![CDATA[a ]]]]><![CDATA[> b]]>");
    const reread = parseXml(`<t>${cdata("x ]]> y ]]> z")}</t>`);
    assert.equal(allText(reread), "x ]]> y ]]> z");
    assert.equal(allText(parseXml(`<t>${cdata("plain")}</t>`)), "plain");
  });

  test("keeps hostile text in the file as text, and the file well formed", () => {
    const q = make("shortAnswer", { caseSensitive: false, accepted: ["a & b <c> \"d\" ]]> e\u0001"] }, "Is <script>alert(1)</script> & ]]> a problem?", { title: "T <&> \"q\"" });
    const parsed = questionsOf(exportMoodleXml([q]).files[0]?.content ?? "");
    const question = parsed[1] as XmlElement;
    assert.equal(textOf(question, "name"), "T <&> \"q\"");
    assert.match(textOf(question, "questiontext"), /<p>Is &lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; \]\]&gt; a problem\?<\/p>/);
    assert.equal(allText(first(first(question, "answer") as XmlElement, "text") as XmlElement), "a & b <c> \"d\" ]]> e");
  });

  test("leaves out what Moodle XML cannot hold and a question with no usable key, with the reason", () => {
    const result = exportMoodleXml([
      make("ordering", { items: [{ id: "i1", content: plainToRich("A"), position: 1 }, { id: "i2", content: plainToRich("B"), position: 2 }] }, "Order."),
      make("multipleChoice", { shuffle: true, options: [opt("o1", "A"), opt("o2", "B")] }, "No key."),
    ]);
    assert.equal(result.files.length, 0);
    assert.match(result.report.items[0]?.notes[0] ?? "", /Moodle XML has no ordering question/);
    assert.match(result.report.items[1]?.notes[0] ?? "", /cannot be exported until this is fixed in the bank/);
  });

  test("never writes an answer key that is not in the question", () => {
    const q = make("trueFalse", {}, "No answer given.");
    const result = exportMoodleXml([q]);
    assert.equal(result.report.leftOut, 1);
    assert.doesNotMatch(result.files[0]?.content ?? "", /true|false/);
  });

  test("says in the report what every question lost, and what is true of all of them", () => {
    assert.ok(out.report.general.some((g) => /category called "Capitals"/.test(g)));
    assert.ok(out.report.items[1]?.notes.some((n) => /written as weights/.test(n)));
  });
});
