/**
 * Three banks an instructor keeps in their own projects, written in 2005, 2007 and this
 * year, each laid out differently and each imported almost nothing before:
 *
 *   - a test item file of fifteen chapters, every question numbered chapter.question on a
 *     line of its own ("1.14"), the text on the next line, the answer a lone letter, or the
 *     word true or false, on a line after it;
 *   - a chapter whose right option is the bold one, with a "(Page 3)" line after each
 *     question's options, "(T)" and "(F)" at the ends of its true or false lines, a matching
 *     exercise as a table, and its fill in the blank questions given as finished sentences
 *     with the answer in bold;
 *   - a bank numbered by Word's lists, each answer on a line of its own as
 *     "Answer: b) (Textbook reference: ...)".
 *
 * The real files are measured through the harness (fixtures/publisher, kept on the machine).
 * These tests have none of their words: each rule is tried on small invented examples, with
 * what makes it a rule and what keeps it from reading something it should not.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { standardTextImporter } from "../src/import/standard-text.ts";
import { type ImportResult } from "../src/import/types.ts";
import { wordImporter } from "../src/import/word.ts";
import { FindingCode, verdictFrom } from "../src/model/findings.ts";
import type { Question } from "../src/model/question.ts";
import { richTextToPlain } from "../src/model/richtext.ts";
import { docx, paragraph, run, table } from "./support/docx-writer.ts";

const OPTIONS = { file: "t.txt", at: "2026-01-01T00:00:00.000Z", author: "test" };
const text = (lines: string[], extra: Record<string, unknown> = {}): ImportResult =>
  standardTextImporter.parse(lines.join("\n"), { ...OPTIONS, ...extra });
const inWord = (body: string, extra: Record<string, unknown> = {}): ImportResult =>
  wordImporter.parseBytes(docx({ body }), { ...OPTIONS, file: "t.docx", ...extra });
const lines = (list: string[]): string => list.map((l) => paragraph(l === "" ? "" : run(l))).join("");

const body = (q: Question): Record<string, any> => q.body as Record<string, any>;
const plain = (rich: Parameters<typeof richTextToPlain>[0]): string => richTextToPlain(rich).replace(/\s+/g, " ").trim();
const keyOf = (q: Question): string => (body(q)["options"] as Array<{ correct?: boolean }>).map((o) => (o.correct ? "X" : ".")).join("");
const wordsOf = (q: Question): string[] => (body(q)["options"] as Array<{ content: Parameters<typeof plain>[0] }>).map((o) => plain(o.content));
const has = (q: Question, code: string): boolean => q.findings.some((f) => f.code === code);
const fileHas = (result: ImportResult, code: string) => result.fileFindings.find((f) => f.code === code);
const verdict = (q: Question): string => verdictFrom(q.findings);
const meta = (q: Question): Record<string, any> => q.metadata as unknown as Record<string, any>;

const PLANETS = ["Sirius", "Mars", "Vega", "Rigel"];

// ---------------------------------------------------------------------------
// A page, in brackets
// ---------------------------------------------------------------------------

describe("a page given in brackets is the question's page, wherever it stands", () => {
  const withPage = (page: string): string[] => ["1) Which is a planet?", "a) Sirius", "b) Mars", "c) Vega", "d) Rigel", page, "Answer: b"];

  test("alone under the options, it is not added to the last option", () => {
    for (const result of [text(withPage("(Page 3)")), inWord(lines(withPage("(Page 3)")))]) {
      const q = result.questions[0] as Question;
      assert.deepEqual(wordsOf(q), PLANETS, "the last option has only its own words");
      assert.equal(meta(q)["page"], "3");
      assert.equal(verdict(q), "parsed");
      assert.equal(result.orphans.length, 0, "nothing was left over");
    }
  });

  test("in the forms a book uses", () => {
    assert.equal(meta(text(withPage("(p. 230)")).questions[0] as Question)["page"], "230");
    assert.equal(meta(text(withPage("(pp. 12-14)")).questions[0] as Question)["page"], "12-14");
    assert.equal(meta(text(withPage("(page 5)")).questions[0] as Question)["page"], "5");
  });

  test("a bracket opened and not closed, or closed and not opened, is not a page", () => {
    for (const line of ["(Page 3", "Page 3)"]) {
      const q = text(["1) Which is a planet?", "a) Sirius", "b) Mars", line, "Answer: b"]).questions[0] as Question;
      assert.equal(meta(q)["page"], undefined, line);
    }
  });

  test("a range keeps one space round its dash, however many the file has", () => {
    assert.equal(meta(text(withPage("(pp. 12  -  14)")).questions[0] as Question)["page"], "12 - 14");
  });

  test("the same at the end of a question's line", () => {
    const q = text(["1) Explain how a star forms. (pp. 12  -  14)"]).questions[0] as Question;
    assert.equal(meta(q)["page"], "12 - 14");
  });

  test("a line of a stem that ends in a page is taken off it, as the first line is", () => {
    const q = text(["1) The first part of the stem", "and the second part (Page 5)", "a) x", "b) *y"]).questions[0] as Question;
    assert.equal(plain(q.stem), "The first part of the stem and the second part");
    assert.equal(meta(q)["page"], "5");
  });

  test("a stem that is only a page is not taken off and left empty", () => {
    const q = text(["1) (Page 3)", "a) x", "b) *y"]).questions[0] as Question;
    assert.equal(plain(q.stem), "(Page 3)");
  });

  test("it needs its brackets: a line that says page 3 is not one", () => {
    const q = text(["1) Which is a planet?", "a) Sirius", "b) Mars", "page 3", "Answer: b"]).questions[0] as Question;
    assert.deepEqual(wordsOf(q), ["Sirius", "Mars page 3"], "as it was read before");
    assert.equal(meta(q)["page"], undefined);
  });

  test("at the end of a question's line it is taken off the line, and kept", () => {
    const q = text(["1) Explain how a star forms. (Page 18)", "2) Explain how a planet forms. (pp. 20-21)"]).questions;
    assert.equal(plain((q[0] as Question).stem), "Explain how a star forms.");
    assert.equal(meta(q[0] as Question)["page"], "18");
    assert.equal(plain((q[1] as Question).stem), "Explain how a planet forms.");
    assert.equal(meta(q[1] as Question)["page"], "20-21");
  });

  test("a citation inside the sentence, with its full stop after it, is left where it is", () => {
    const q = text(["1) The author defines the term as a process (p. 24).", "2) Which is a planet?", "a) Sirius", "b) *Mars"]).questions[0] as Question;
    assert.match(plain(q.stem), /\(p\. 24\)\.$/);
    assert.equal(meta(q)["page"], undefined);
  });

  test("a bold last option is still seen to be bold when a page line follows it", () => {
    // The page line used to be the last option's second line, which was not bold, so the
    // option was not bold as a whole and seven keys in fifteen were lost.
    const question = (n: number, key: number): string =>
      paragraph(run(`${n}) Which is number ${n}?`)) +
      PLANETS.map((w, i) => paragraph(i === key ? run(`${"abcd"[i]}) `) + run(w, "<w:b/>") : run(`${"abcd"[i]}) ${w}`))).join("") +
      paragraph(run("(Page 3)"));
    const result = inWord([question(1, 3), question(2, 3), question(3, 0), question(4, 3)].join(""));
    assert.deepEqual(result.questions.map(keyOf), ["...X", "...X", "X...", "...X"]);
    assert.ok(result.questions.every((q) => verdict(q) === "parsed"));
  });
});

// ---------------------------------------------------------------------------
// The note at the end of an Answer line
// ---------------------------------------------------------------------------

describe("an Answer line with a note that says where the question comes from", () => {
  test("the key is read, and the note is kept as the question's section", () => {
    const q = text(["1) Which is a planet?", "a) Sirius", "b) Mars", "c) Vega", "Answer: b) (Textbook reference: Stars and Planets)"]).questions[0] as Question;
    assert.equal(keyOf(q), ".X.");
    assert.equal(meta(q)["section"], "Stars and Planets");
    assert.equal(verdict(q), "parsed");
  });

  test("the same for a true or false answer that ends in a full stop", () => {
    const q = text(["True/False Questions", "1) Mars is a planet.", "Answer: True. (Textbook reference: Planets)"]).questions[0] as Question;
    assert.equal(body(q)["correct"], true);
    assert.equal(meta(q)["section"], "Planets");
  });

  test("a bracket or full stop after a letter is no longer a reason to refuse it", () => {
    assert.equal(keyOf(text(["1) Which is a planet?", "a) Sirius", "b) Mars", "Answer: B)"]).questions[0] as Question), ".X");
    assert.equal(keyOf(text(["1) Which is a planet?", "a) Sirius", "b) Mars", "Answer: b."]).questions[0] as Question), ".X");
  });

  test("a page note after the key is the page", () => {
    const q = text(["1) Which is a planet?", "a) Sirius", "b) Mars", "Answer: b (Page 12)"]).questions[0] as Question;
    assert.equal(keyOf(q), ".X");
    assert.equal(meta(q)["page"], "12");
  });

  test("a note that is not a source is not taken off: the words are reported and the question is not passed", () => {
    // "(or d)" says something about the answer. It is not dropped, so the line is still reported as
    // a key with words this question cannot use, as it was before, and the question is not "parsed".
    const q = text(["1) Which is a planet?", "a) Sirius", "b) Mars", "c) Vega", "Answer: c (or d)"]).questions[0] as Question;
    assert.ok(has(q, FindingCode.KeyTextNotUsed), "the words are reported");
    assert.match(q.findings.find((f) => f.code === FindingCode.KeyTextNotUsed)?.message ?? "", /c \(or d\)/);
    assert.notEqual(verdict(q), "parsed");
  });

  test("a line that is only a note has no key to take off it", () => {
    const q = text(["1) Which is a planet?", "a) Sirius", "b) Mars", "Answer: (Page 3)"]).questions[0] as Question;
    assert.ok(has(q, FindingCode.NoAnswerKey));
    assert.ok(has(q, FindingCode.KeyTextNotUsed), "the words are reported as a key this question cannot use, as before");
    assert.equal(meta(q)["page"], undefined, "and they were not turned into a page");
  });

  test("words after the letter are not a note, and still fail as they did", () => {
    const q = text(["1) Which is a planet?", "a) Sirius", "b) Mars", "Answer: b) Because it orbits"]).questions[0] as Question;
    assert.ok(has(q, FindingCode.NoAnswerKey));
  });

  test("a note with a label this profile does not know is kept, not dropped", () => {
    const q = text(["1) Which is a planet?", "a) Sirius", "b) Mars", "Answer: b (Source: the syllabus)"]).questions[0] as Question;
    assert.equal(keyOf(q), ".X");
    assert.equal(meta(q)["custom"]?.["Source"], "the syllabus");
  });
});

// ---------------------------------------------------------------------------
// Chapter and question, alone on a line
// ---------------------------------------------------------------------------

describe("a question numbered chapter.question on a line of its own, with its text on the next", () => {
  const choice = (id: string, key: string, stem = `Question ${id}?`): string[] => [id, stem, "a. Sirius", "b. Mars", "c. Vega", "d. Rigel", "", key];

  test("reads the text, the options and a lone letter as the answer", () => {
    const result = text([
      "Chapter One Multiple Choice Questions",
      ...choice("1.1", "b"),
      ...choice("1.2", "c"),
      ...choice("1.3", "a"),
      ...choice("1.4", "d"),
    ]);
    assert.equal(result.questions.length, 4);
    assert.deepEqual(result.questions.map(keyOf), [".X..", "..X.", "X...", "...X"]);
    assert.deepEqual(result.questions.map((q) => plain(q.stem)), ["Question 1.1?", "Question 1.2?", "Question 1.3?", "Question 1.4?"]);
    assert.ok(result.questions.every((q) => verdict(q) === "parsed"));
  });

  test("the same typed in a Word file", () => {
    const rows = ["Chapter One Multiple Choice Questions", ...choice("1.1", "b"), ...choice("1.2", "c"), ...choice("1.3", "a")];
    const result = inWord(lines(rows));
    assert.deepEqual(result.questions.map(keyOf), [".X..", "..X.", "X..."]);
  });

  test("a number again in the next chapter is not a repeat", () => {
    const result = text([...choice("1.1", "a"), ...choice("1.2", "b"), ...choice("2.1", "c"), ...choice("2.2", "d")]);
    assert.equal(result.questions.length, 4);
    assert.equal(fileHas(result, FindingCode.DuplicateQuestionNumber), undefined, "1.1 and 2.1 are not the same number");
  });

  test("a number that goes back, in the same chapter, is text and not a question", () => {
    const rows = [...choice("1.5", "a"), "1.6", "What is the value", "1.2", "as measured?", "a. one", "b. two", "", "a"];
    const result = text(rows);
    assert.equal(result.questions.length, 2, "1.2 after 1.6 is not the next question");
    assert.match(plain((result.questions[1] as Question).stem), /What is the value 1\.2 as measured\?/);
  });

  test("a number with options straight under it is not a question, as the next line must be its text", () => {
    const result = text(["1.1", "a. one", "b. two"]);
    assert.equal(result.questions.length, 0);
  });

  test("numbers may skip, and may start again in each section", () => {
    const result = text([
      "Chapter One Multiple Choice Questions",
      ...choice("1.1", "a"),
      ...choice("1.4", "b"),
      "Chapter One True or False Questions",
      "1.1",
      "Mars is a planet.",
      "",
      "true",
      "1.2",
      "Vega is a planet.",
      "",
      "false",
    ]);
    assert.equal(result.questions.length, 4);
    assert.deepEqual(result.questions.map((q) => q.type), ["multipleChoice", "multipleChoice", "trueFalse", "trueFalse"]);
  });

  test("the text may come after a blank line without being flagged as spanning one", () => {
    const result = text(["Essay", "1.1", "", "Explain a star.", "1.2", "Explain a planet."]);
    assert.equal(result.questions.length, 2);
    assert.ok(result.questions.every((q) => verdict(q) === "parsed"), result.questions.flatMap((q) => q.findings.map((f) => f.message)).join(" / "));
  });

  test("a number alone, such as 3. in the middle of a stem, is not a question unless options follow", () => {
    const result = text(["1) Put these in order", "3.", "then say why", "a) one", "b) *two"]);
    assert.equal(result.questions.length, 1);
    assert.match(plain((result.questions[0] as Question).stem), /^Put these in order 3\. then say why$/);
  });

  test("a repeated number within a chapter is said, with its label", () => {
    const result = text([...choice("1.1", "a"), ...choice("1.1", "b")]);
    assert.match(fileHas(result, FindingCode.DuplicateQuestionNumber)?.message ?? "", /1\.1/);
  });

  test("a line that follows the options of a question numbered 1.3 says so, with its number", () => {
    const result = text([...choice("1.3", "a"), "Something that is not part of it."]);
    const stray = result.orphans.find((o) => o.text === "Something that is not part of it.");
    assert.match(stray?.reason ?? "", /question 1\.3\b/);
  });

  test("another number straight under a number means the first is not a question", () => {
    const result = text(["Essay", "1.1", "1.2", "Explain a planet."]);
    assert.equal(result.questions.length, 1);
    assert.ok(result.orphans.some((o) => o.text === "1.1"), "the first number is reported");
  });

  test("the numbers of questions with no options are read the same way", () => {
    const result = text(["Chapter One Short Answer/Essay Questions", "1.1", "Explain a star.", "1.2", "Explain a planet.", "1.3", "Explain a moon."]);
    assert.equal(result.questions.length, 3);
    assert.ok(result.questions.every((q) => q.type === "essay"));
    assert.deepEqual(result.questions.map((q) => plain(q.stem)), ["Explain a star.", "Explain a planet.", "Explain a moon."]);
  });

  test("a chapter title after the last question ends it and is not added to its text", () => {
    const result = text([
      "Chapter One Short Answer/Essay Questions",
      "1.1",
      "Explain a star.",
      "1.2",
      "Explain a planet.",
      "",
      "Chapter Two Test Questions",
      "",
      "Chapter Two Multiple Choice Questions",
      ...choice("2.1", "a"),
    ]);
    const last = result.questions[1] as Question;
    assert.equal(plain(last.stem), "Explain a planet.");
    assert.equal(verdict(last), "parsed", last.findings.map((f) => f.message).join(" / "));
    assert.ok(result.orphans.some((o) => o.text === "Chapter Two Test Questions"), "the title is reported, not dropped");
  });

  test("the words Chapter, at the start of a sentence in a stem, are not a title", () => {
    const result = text(["1) Why does", "Chapter four matter?", "a) x", "b) *y"]);
    assert.match(plain((result.questions[0] as Question).stem), /Chapter four matter\?/);
  });

  test("a heading with Chapter in front, and Short Answer/Essay, gives its type", () => {
    const result = text([
      "Chapter Three True or False Questions",
      "3.1",
      "Mars is a planet.",
      "",
      "true",
      "Chapter Three Short Answer/Essay Questions",
      "3.2",
      "Explain a planet.",
    ]);
    assert.deepEqual(result.questions.map((q) => q.type), ["trueFalse", "essay"]);
    assert.equal(body(result.questions[0] as Question)["correct"], true);
  });
});

// ---------------------------------------------------------------------------
// A letter alone under the options
// ---------------------------------------------------------------------------

describe("a letter alone under a question's options is its answer when the file does that throughout", () => {
  const withLetter = (n: number, letter: string): string[] => [`${n}) Which is number ${n}?`, "a) Sirius", "b) Mars", "c) Vega", "", letter];

  test("most of the choice questions have one", () => {
    const result = text([...withLetter(1, "b"), ...withLetter(2, "c"), ...withLetter(3, "a"), ...withLetter(4, "b")]);
    assert.deepEqual(result.questions.map(keyOf), [".X.", "..X", "X..", ".X."]);
    assert.equal(result.orphans.length, 0);
    const said = fileHas(result, FindingCode.AnswerFromUnlabelledLine);
    assert.ok(said, "the file says so");
    assert.match(said.message, /4 multiple choice/);
    assert.equal(said.severity, "info");
  });

  test("it works with no blank line before the letter, and in capitals", () => {
    const rows = [1, 2, 3].flatMap((n) => [`${n}) Which is number ${n}?`, "a) Sirius", "b) Mars", "B"]);
    assert.deepEqual(text(rows).questions.map(keyOf), [".X", ".X", ".X"]);
  });

  test("one or two, in a bank that does not do it, are given back and the questions fail", () => {
    // The letter was a stray cell of a table, or the last word of an option: neither is a key.
    const plainQuestion = (n: number): string[] => [`${n}) Which is number ${n}?`, "a) Sirius", "b) Mars", "Answer: b"];
    const result = text([...plainQuestion(1), ...plainQuestion(2), ...plainQuestion(3), ...withLetter(4, "b"), ...plainQuestion(5)]);
    const q = result.questions[3] as Question;
    assert.ok(has(q, FindingCode.NoAnswerKey), "no key was taken from one letter in five questions");
    assert.ok(result.orphans.some((o) => o.text === "b" && /only 1 of 5 choice questions/.test(o.reason)), "the letter is reported, with why");
    assert.equal(fileHas(result, FindingCode.AnswerFromUnlabelledLine), undefined);
  });

  test("a letter that ended an option's words goes back to the option", () => {
    // "B" names an option the question has, so it is taken as an answer at first and given back at the end.
    const rows = ["1) Which vitamin helps?", "a) Sirius", "b) Vitamin", "B", "c) Vega", "2) Which is a planet?", "a) Mars", "b) Vega"];
    const q = text(rows).questions[0] as Question;
    assert.deepEqual(wordsOf(q), ["Sirius", "Vitamin B", "Vega"]);
    assert.ok(has(q, FindingCode.NoAnswerKey));
  });

  test("a letter after feedback is more of the feedback, as it was", () => {
    const result = text(["1) Which is a planet?", "a) Sirius", "b) Mars", "~ Good.", "b"]);
    assert.equal(result.orphans.length, 0, "the letter joined the feedback and was not reported as a line left over");
  });

  test("a question with one option has no letter to name, however many questions have one", () => {
    const rows = [...withLetter(1, "b"), ...withLetter(2, "c"), ...withLetter(3, "a"), "4) Which is it?", "a) Only", "", "a"];
    const result = text(rows);
    assert.ok(result.orphans.some((o) => o.text === "a" && /question 4\b/.test(o.reason)), "the letter is reported");
    assert.ok(has(result.questions[3] as Question, FindingCode.NoAnswerKey));
  });

  test("the lettered parts of an essay are not options with an answer, even in a file that does it for choices", () => {
    const part = (n: number): string[] => [`${n}) Discuss in two parts.`, "a. Define it.", "b. Defend it.", "", "b"];
    const result = text(["Essay", ...part(1), ...part(2), ...part(3)]);
    assert.ok(result.questions.every((q) => q.type === "essay"));
    assert.equal(fileHas(result, FindingCode.AnswerFromUnlabelledLine), undefined, "nothing was read as an answer");
    assert.ok(result.orphans.filter((o) => o.text === "b").length === 3, "the letters are reported");
  });

  test("two questions are not enough to be a habit, however sure they look", () => {
    const result = text([...withLetter(1, "b"), ...withLetter(2, "c")]);
    assert.ok(result.questions.every((q) => has(q, FindingCode.NoAnswerKey)));
    assert.equal(result.orphans.length, 2, "both letters are reported");
  });

  test("three in five is three questions but not 80 percent of them", () => {
    const plainQuestion = (n: number): string[] => [`${n}) Which is number ${n}?`, "a) Sirius", "b) Mars", "Answer: b"];
    const result = text([...withLetter(1, "b"), ...withLetter(2, "c"), ...withLetter(3, "a"), ...plainQuestion(4), ...plainQuestion(5)]);
    assert.ok(has(result.questions[0] as Question, FindingCode.NoAnswerKey));
    assert.equal(fileHas(result, FindingCode.AnswerFromUnlabelledLine), undefined);
  });

  test("a letter after an Answer line is not a second answer", () => {
    const rows = [...withLetter(1, "b"), ...withLetter(2, "b"), ...withLetter(3, "b"), "4) Which is number 4?", "a) Sirius", "b) Mars", "c) Vega", "Answer: a", "", "c"];
    const q = text(rows).questions[3] as Question;
    assert.equal(keyOf(q), "X..");
  });

  test("a letter that no option has is not an answer", () => {
    const result = text([...withLetter(1, "b"), ...withLetter(2, "b"), ...withLetter(3, "b"), ...withLetter(4, "e")]);
    assert.ok(has(result.questions[3] as Question, FindingCode.NoAnswerKey));
    assert.ok(result.orphans.some((o) => o.text === "e"), "it is reported as a line that was not read, not taken as a key that cannot be used");
    assert.ok(!has(result.questions[3] as Question, FindingCode.KeyTextNotUsed));
  });

  test("a question that has a key of its own keeps it and is not given another", () => {
    const rows = [...withLetter(1, "b"), ...withLetter(2, "b"), ...withLetter(3, "b"), "4) Which is number 4?", "a) Sirius", "*b) Mars", "c) Vega", "", "c"];
    const q = text(rows).questions[3] as Question;
    assert.equal(keyOf(q), ".X.");
    assert.ok(!has(q, FindingCode.KeysDisagree), "the letter was not read as a second key to disagree with it");
  });

  test("it is not read under a true or false heading, where the answer is a word", () => {
    const result = text(["True/False Questions", "1) Mars is a planet.", "", "b"]);
    assert.ok(has(result.questions[0] as Question, FindingCode.NoAnswerKey));
  });
});

// ---------------------------------------------------------------------------
// True or false
// ---------------------------------------------------------------------------

describe("true or false answers given in the line", () => {
  test("(T) and (F) at the end, before or after a page, are the answer", () => {
    const result = text([
      "True/False",
      "1) Mars is a planet. (T) (Page 20)",
      "2) Vega is a planet. (F) (Page 21)",
      "3) The Sun is a star. (Page 22) (T)",
      "4) A moon is a star. (False)",
    ]);
    assert.deepEqual(result.questions.map((q) => body(q)["correct"]), [true, false, true, false]);
    assert.deepEqual(result.questions.map((q) => plain(q.stem)), ["Mars is a planet.", "Vega is a planet.", "The Sun is a star.", "A moon is a star."]);
    assert.deepEqual(result.questions.map((q) => meta(q)["page"]), ["20", "21", "22", undefined]);
    assert.ok(result.questions.every((q) => verdict(q) === "parsed"));
    const said = fileHas(result, FindingCode.AnswerFromUnlabelledLine);
    assert.match(said?.message ?? "", /4 true or false answers were read from a \(T\) or \(F\)/);
  });

  test("only under a true or false heading: the same letters at the end of any other question are its words", () => {
    const result = text(["1) Is a star a planet? (T)", "a) yes", "b) no"]);
    assert.match(plain((result.questions[0] as Question).stem), /\(T\)$/);
  });

  test("a word straight under the statement, with no blank line, is still part of it", () => {
    const result = text(["True/False Questions", "1) Mars is a planet", "indeed", "", "true"]);
    assert.equal(plain((result.questions[0] as Question).stem), "Mars is a planet indeed");
  });

  test("a single word after a blank line that is not true or false is an unreadable answer, not more of the statement", () => {
    const result = text(["True/False Questions", "1.1", "Mars is a planet.", "", "ture", "1.2", "Vega is a planet.", "", "false"]);
    const first = result.questions[0] as Question;
    assert.equal(plain(first.stem), "Mars is a planet.", "the word did not join the statement");
    assert.ok(has(first, FindingCode.NoAnswerKey), "no key was guessed from a misspelling");
    assert.ok(has(first, FindingCode.KeyTextNotUsed), "the word is reported");
    assert.equal(verdict(first), "failed");
    assert.equal(body(result.questions[1] as Question)["correct"], false);
  });
});

// ---------------------------------------------------------------------------
// Matching, as a table
// ---------------------------------------------------------------------------

describe("a matching exercise given as a table of rows", () => {
  const cell = (t: string): string => paragraph(t === "" ? "" : run(t));
  const rowOf = (n: number, term: string, definition: string): string[] => [cell(`${n})`), cell(term), cell(""), cell(definition)];
  const rows = [rowOf(1, "Star", "A sun that burns. (Page 4)"), rowOf(2, "Planet", "A world that orbits. (Page 8)"), rowOf(3, "Moon", "A world that orbits a world.")];

  test("is one question with a pair for each row, with the text of the heading above it", () => {
    const result = inWord(paragraph(run("Matching")) + table(rows));
    assert.equal(result.questions.length, 1);
    const q = result.questions[0] as Question;
    assert.equal(q.type, "matching");
    assert.deepEqual(
      (body(q)["pairs"] as Array<{ left: Parameters<typeof plain>[0]; right: string }>).map((p) => `${plain(p.left)} = ${p.right}`),
      ["Star = A sun that burns.", "Planet = A world that orbits.", "Moon = A world that orbits a world."],
    );
    assert.equal(plain(q.stem), "Matching");
    assert.equal(meta(q)["page"], "4; 8", "the pages are kept");
    assert.ok(has(q, FindingCode.StemFromHeading), "and it says the heading is standing for its text");
    assert.equal(verdict(q), "needsReview");
    assert.ok(result.fileFindings.some((f) => f.code === FindingCode.TableLayout && f.message.includes("a term and its definition in each row")));
  });

  test("a stem of its own is used, with no flag", () => {
    const result = inWord(paragraph(run("Matching")) + paragraph(run("1) Match each body to what it is.")) + table(rows));
    // The numbered paragraph is a question of its own, and the table follows it as pairs of a second.
    assert.ok(result.questions.length >= 1);
  });

  test("the characters of the right side follow the model's rule, as the left side's do", () => {
    const curly = [rowOf(1, "Star", "A sun’s fire."), rowOf(2, "Planet", "A world."), rowOf(3, "Moon", "A smaller one.")];
    const q = inWord(paragraph(run("Matching")) + table(curly)).questions[0] as Question;
    assert.equal((body(q)["pairs"] as Array<{ right: string }>)[0]?.right, "A sun's fire.");
  });

  test("numbers that do not count up from one row to the next are not a matching exercise", () => {
    const skipped = [rowOf(1, "Star", "A sun."), rowOf(3, "Planet", "A world."), rowOf(4, "Moon", "A smaller one.")];
    const result = inWord(paragraph(run("Matching")) + table(skipped));
    assert.ok(!result.fileFindings.some((f) => f.message.includes("a term and its definition in each row")));
  });

  test("the same page on two rows is kept once", () => {
    const same = [rowOf(1, "Star", "A sun. (Page 4)"), rowOf(2, "Planet", "A world. (Page 4)"), rowOf(3, "Moon", "A smaller one. (Page 9)")];
    const q = inWord(paragraph(run("Matching")) + table(same)).questions[0] as Question;
    assert.equal(meta(q)["page"], "4; 9");
  });

  test("more rows than a question has letters for is not read as one", () => {
    const many = Array.from({ length: 21 }, (_, i) => rowOf(i + 1, `Term ${i + 1}`, `Meaning ${i + 1}.`));
    const result = inWord(paragraph(run("Matching")) + table(many));
    assert.ok(!result.fileFindings.some((f) => f.message.includes("a term and its definition in each row")));
  });

  test("a matching question typed as lines, with a word that has no pair, keeps the word as a distractor in the model's characters", () => {
    const q = text(["Matching", "1) Match each body.", "a. Star = A sun.", "b. Planet = A world.", "c. Comet’s tail"]).questions[0] as Question;
    assert.deepEqual(body(q)["distractors"], ["Comet's tail"]);
  });

  test("two rows are too few to be an exercise", () => {
    const result = inWord(paragraph(run("Matching")) + table(rows.slice(0, 2)));
    assert.ok(!result.fileFindings.some((f) => f.message.includes("a term and its definition in each row")));
  });

  test("a row with three cells of words is not a pair", () => {
    const three = rows.map((r) => [r[0] as string, r[1] as string, cell("extra"), r[3] as string]);
    const result = inWord(paragraph(run("Matching")) + table(three));
    assert.ok(!result.fileFindings.some((f) => f.message.includes("a term and its definition in each row")));
  });

  test("a cell spread across columns is not a pair either, as what it means is not knowable", () => {
    // A row with fewer cells than the widest has its last cell spread across the rest of the width.
    const merged = [rows[0] as string[], rows[1] as string[], [cell("3)"), cell("Moon"), cell("A world that orbits a world.")]];
    const result = inWord(paragraph(run("Matching")) + table(merged));
    assert.ok(!result.fileFindings.some((f) => f.message.includes("a term and its definition in each row")));
  });

  test("the heading above it is its text only when the heading says matching", () => {
    const result = inWord(paragraph(run("Essay")) + table(rows));
    assert.ok(result.questions.every((q) => !has(q, FindingCode.StemFromHeading)));
  });
});

// ---------------------------------------------------------------------------
// Fill in the blank, as a finished sentence with the answer in bold
// ---------------------------------------------------------------------------

describe("a fill in the blank given as the finished sentence with the answer in bold", () => {
  const sentence = (n: number, before: string, answer: string, after: string): string =>
    paragraph(run(`${n}) ${before}`) + run(answer, "<w:b/>") + run(`${after} (Page ${n + 3})`));
  const section = (items: string[]): string => paragraph(run("Fill In The Blank")) + items.join("");
  const three = [
    sentence(1, "A star is a ", "sun ", "that burns."),
    sentence(2, "The nearest star to us is the ", "Sun", "."),
    sentence(3, "A world that orbits a star is a ", "planet", "."),
  ];

  test("the bold words become the answer and are replaced by a blank in the question", () => {
    const result = inWord(section(three));
    assert.equal(result.questions.length, 3);
    assert.deepEqual(result.questions.map((q) => plain(q.stem)), [
      "A star is a _____ that burns.",
      "The nearest star to us is the _____ .",
      "A world that orbits a star is a _____ .",
    ].map((s) => s.replace(" .", ".")));
    assert.deepEqual(result.questions.map((q) => (body(q)["blanks"] as Array<{ accepted: string[] }>).map((b) => b.accepted)), [[["sun"]], [["Sun"]], [["planet"]]]);
    assert.ok(result.questions.every((q) => verdict(q) === "parsed"));
    assert.deepEqual(result.questions.map((q) => meta(q)["page"]), ["4", "5", "6"]);
    const said = fileHas(result, FindingCode.FormattingKeyUsed);
    assert.ok(said);
    assert.match(said.message, /3 of 3 fill in the blank questions/);
    assert.match(said.message, /Check that bold does mean the answer/);
  });

  test("two bold parts are one answer to each of two blanks, in order", () => {
    const two = paragraph(run("4) A ") + run("moon", "<w:b/>") + run(" orbits a ") + run("planet", "<w:b/>") + run(" and shines."));
    const result = inWord(section([...three, two]));
    const q = result.questions[3] as Question;
    assert.equal(plain(q.stem), "A _____ orbits a _____ and shines.");
    assert.deepEqual((body(q)["blanks"] as Array<{ accepted: string[] }>).map((b) => b.accepted), [["moon"], ["planet"]]);
  });

  test("a bold space between words is not an answer", () => {
    // The bold space stands between two plain runs, so it is a run of its own and not part of the answer's.
    const spaced = (n: number): string =>
      paragraph(run(`${n}) A `) + run("star", "<w:b/>") + run(" is a sun, number") + run(" ", "<w:b/>") + run(`${n}.`));
    const result = inWord(section([spaced(1), spaced(2), spaced(3)]));
    assert.equal(plain((result.questions[0] as Question).stem), "A _____ is a sun, number 1.");
    assert.deepEqual((body(result.questions[0] as Question)["blanks"] as Array<{ accepted: string[] }>).map((b) => b.accepted), [["star"]]);
  });

  test("two questions in a bank of ten are not a habit, so they are left as written", () => {
    const plainSentence = (n: number): string => paragraph(run(`${n}) A plain sentence with no bold at all, number ${n}.`));
    const items = [sentence(1, "A star is a ", "sun", "."), sentence(2, "A moon is a ", "moon", "."), ...[3, 4, 5, 6, 7, 8, 9, 10].map(plainSentence)];
    const result = inWord(section(items));
    assert.match(plain((result.questions[0] as Question).stem), /A star is a sun\./, "the stem was not touched");
    assert.ok(has(result.questions[0] as Question, FindingCode.NoAnswerKey));
    assert.ok(fileHas(result, FindingCode.FormattingKeyUnclear));
    assert.equal(fileHas(result, FindingCode.FormattingKeyUsed), undefined);
  });

  test("two of two is not a habit, and three of five is not 80 percent", () => {
    const two = inWord(section([three[0] as string, three[1] as string]));
    assert.ok(fileHas(two, FindingCode.FormattingKeyUnclear));
    assert.ok(two.questions.every((q) => has(q, FindingCode.NoAnswerKey)));

    const plainSentence = (n: number): string => paragraph(run(`${n}) A plain sentence with no bold at all, number ${n}.`));
    const five = inWord(section([...three, plainSentence(4), plainSentence(5)]));
    assert.ok(fileHas(five, FindingCode.FormattingKeyUnclear));
    assert.equal(fileHas(five, FindingCode.FormattingKeyUsed), undefined);
  });

  test("a question that has an Answer line already is left alone", () => {
    const keyed = paragraph(run("4) A moon is a ") + run("rock", "<w:b/>") + run(" in orbit.")) + paragraph(run("Answer: satellite"));
    const result = inWord(section([...three, keyed]));
    const q = result.questions[3] as Question;
    assert.match(plain(q.stem), /A moon is a rock in orbit\./);
    assert.deepEqual((body(q)["blanks"] as Array<{ accepted: string[] }>).map((b) => b.accepted), [["satellite"]]);
  });

  test("a bold number is not an answer", () => {
    const boldLabel = (n: number): string => paragraph(run(`${n})`, "<w:b/>") + run(` A plain sentence with no bold words, number ${n}.`));
    const result = inWord(section([boldLabel(1), boldLabel(2), boldLabel(3)]));
    assert.ok(result.questions.every((q) => has(q, FindingCode.NoAnswerKey)));
    assert.equal(fileHas(result, FindingCode.FormattingKeyUnclear), undefined, "no words were set apart, so there is nothing to say");
  });

  test("a sentence that is bold all the way through has no answer set apart", () => {
    const allBold = (n: number): string => paragraph(run(`${n}) `) + run(`A sentence that is bold from end to end, number ${n}.`, "<w:b/>"));
    const result = inWord(section([allBold(1), allBold(2), allBold(3)]));
    assert.ok(result.questions.every((q) => has(q, FindingCode.NoAnswerKey)));
    assert.equal(fileHas(result, FindingCode.FormattingKeyUsed), undefined);
  });

  test("a question that already has a blank is left as it is", () => {
    const blank = paragraph(run("4) A ") + run("moon", "<w:b/>") + run(" orbits a ______."));
    const result = inWord(section([...three, blank]));
    assert.match(plain((result.questions[3] as Question).stem), /^A moon orbits a ______\.$/);
  });

  test("it is formatting, so asking for no key from formatting turns it off", () => {
    const result = inWord(section(three), { keyMark: "off" });
    assert.ok(result.questions.every((q) => has(q, FindingCode.NoAnswerKey)));
  });

  test("it is only for fill in the blank questions: the same sentences under another heading are not read", () => {
    const result = inWord(paragraph(run("Essay")) + three.join(""));
    assert.ok(result.questions.every((q) => q.type === "essay"));
    assert.match(plain((result.questions[0] as Question).stem), /A star is a sun that burns\./);
  });
});

// ---------------------------------------------------------------------------
// The three files together
// ---------------------------------------------------------------------------

describe("everything at once, as the real files have it", () => {
  test("a chapter with pages, inline answers and a bold key reads without a stray line", () => {
    const question = (n: number, key: number): string =>
      paragraph(run(`${n}) Which is number ${n}?`)) +
      paragraph() +
      PLANETS.map((w, i) => paragraph(i === key ? run(`${"ABCD"[i]}) `) + run(w, "<w:b/>") : run(`${"ABCD"[i]}) ${w}`))).join("") +
      paragraph(run(`(Page ${n + 2})`)) +
      paragraph();
    const tf = (n: number, answer: string): string => paragraph(run(`${n}) Mars is the ${n}th planet. (${answer}) (Page ${n + 20})`));
    const result = inWord(
      paragraph(run("Multiple Choice")) +
        [question(1, 3), question(2, 3), question(3, 1), question(4, 3)].join("") +
        paragraph(run("True/False")) +
        [tf(1, "T"), tf(2, "F"), tf(3, "F")].join(""),
    );
    assert.equal(result.questions.length, 7);
    assert.deepEqual(result.questions.slice(0, 4).map(keyOf), ["...X", "...X", ".X..", "...X"]);
    assert.deepEqual(result.questions.slice(4).map((q) => body(q)["correct"]), [true, false, false]);
    assert.equal(result.counts.failed, 0);
    assert.equal(result.orphans.length, 0);
  });
});
