/**
 * A publisher's test bank as it really comes: each question a table with its number in
 * one cell and the question, and a table for each option, in the next; the questions
 * grouped under headings that name their type; and the whole bank given twice, once to
 * print for students and once, after an "Answer Key" heading, with the answers.
 *
 * Read cell by cell, in order, the first real chapter of this kind imported none of its 60
 * questions: a number alone on a line, a page reference between it and the question,
 * options in tables inside the cell, no type, no key in words. The document the tests
 * build has none of its words and all of its layout, with each part switchable.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runHarness } from "../src/harness/run.ts";
import { standardTextImporter } from "../src/import/standard-text.ts";
import { type ImportResult } from "../src/import/types.ts";
import { wordImporter, docxToBlocks } from "../src/import/word.ts";
import { FindingCode, verdictFrom } from "../src/model/findings.ts";
import type { Question } from "../src/model/question.ts";
import { richTextToPlain } from "../src/model/richtext.ts";
import { docx, paragraph, run, table } from "./support/docx-writer.ts";
import { BOLD, GREY, ITEMS, UNDERLINE, lookalike, sectioned, type Item } from "./support/publisher-layout.ts";

const OPTIONS = { file: "t.docx", at: "2026-01-01T00:00:00.000Z", author: "test" };
const read = (bytes: Uint8Array): ImportResult => wordImporter.parseBytes(bytes, OPTIONS);
const text = (lines: string[]): ImportResult => standardTextImporter.parse(lines.join("\n"), { ...OPTIONS, file: "t.txt" });

const plain = (rich: Parameters<typeof richTextToPlain>[0]): string => richTextToPlain(rich).replace(/\s+/g, " ").trim();
const body = (q: Question): Record<string, any> => q.body as Record<string, any>;
const keyOf = (q: Question): string => (body(q)["options"] as Array<{ correct?: boolean }> | undefined)?.map((o) => (o.correct ? "X" : ".")).join("") ?? "";
const has = (q: Question, code: string): boolean => q.findings.some((f) => f.code === code);
const fileHas = (result: ImportResult, code: string) => result.fileFindings.find((f) => f.code === code);
const verdicts = (result: ImportResult): string[] => result.questions.map((q) => verdictFrom(q.findings));
/** Whether the file says that a table was read as questions in the layout described by these words. */
const fileHasLayout = (result: ImportResult, words: string): boolean =>
  result.fileFindings.some((f) => f.code === FindingCode.TableLayout && f.message.includes("read as questions:") && f.message.includes(words));

/** What a question of the items should come out as. */
function check(q: Question, item: Item, where: string): void {
  assert.equal(verdictFrom(q.findings), "parsed", `${where} should have no warning or error: ${q.findings.map((f) => f.message).join(" / ")}`);
  assert.equal(plain(q.stem), item.stem, `${where} stem`);
  switch (item.kind) {
    case "fill": {
      assert.equal(q.type, "fillInBlank", where);
      const wanted = (item.stem.match(/_{3,}/g) ?? []).length >= 2 ? (item.answer ?? "").split(";").map((p) => p.trim()) : [item.answer];
      assert.deepEqual(
        (body(q)["blanks"] as Array<{ accepted: string[] }>).map((b) => b.accepted),
        wanted.map((w) => [w]),
        `${where} blanks`,
      );
      break;
    }
    case "truefalse":
      assert.equal(q.type, "trueFalse", where);
      assert.equal(body(q)["correct"], item.answer === "TRUE", `${where} key`);
      break;
    case "choice": {
      assert.equal(q.type, "multipleChoice", where);
      const options = body(q)["options"] as Array<{ content: Parameters<typeof plain>[0] }>;
      assert.deepEqual(options.map((o) => plain(o.content)), item.options, `${where} options`);
      assert.equal(keyOf(q), (item.options ?? []).map((_, i) => (i === item.correct ? "X" : ".")).join(""), `${where} key`);
      break;
    }
    case "short":
      assert.equal(q.type, "essay", where);
      assert.equal(plain(body(q)["modelAnswer"]), item.answer, `${where} model answer`);
      break;
  }
}

function checkAll(result: ImportResult, items: readonly Item[] = ITEMS): void {
  const wanted = sectioned(items);
  assert.equal(result.questions.length, wanted.length, "one question for each of the items");
  wanted.forEach((item, i) => check(result.questions[i] as Question, item, `question ${i + 1}`));
}

// ---------------------------------------------------------------------------

describe("a bank laid out the way a publisher lays it out", () => {
  test("both copies come back as one bank, every question with its type and its own key", () => {
    const result = read(lookalike());
    checkAll(result);
    assert.deepEqual(result.counts, { parsed: 10, needsReview: 0, failed: 0, orphans: 2 });
    // Only the title lines are left over, and they are reported, not lost.
    assert.deepEqual(result.orphans.map((o) => o.text), ["Chapter 3", "Soil and Gardens"]);
  });

  test("the page a question comes from is read from under its number", () => {
    const result = read(lookalike());
    assert.deepEqual(result.questions.map((q) => q.metadata.page), sectioned().map((i) => i.page));
  });

  test("the file says what it did: the key heading, the copies folded, the answers read from lines, the mark", () => {
    const result = read(lookalike());
    assert.equal(fileHas(result, FindingCode.AnswerKeyPart)?.severity, "info");
    const folded = fileHas(result, FindingCode.RepeatedQuestionsFolded);
    assert.equal(folded?.severity, "info");
    assert.match(folded?.message ?? "", /^10 questions appear twice: once without answers, in lines 5 to \d+/);
    assert.match(folded?.message ?? "", /Nothing before the heading was left over/);
    assert.ok(folded?.source && folded.source.firstBlock < folded.source.lastBlock, "and where");
    assert.match(fileHas(result, FindingCode.AnswerFromUnlabelledLine)?.message ?? "", /6 answers were read.*2 true or false, 2 fill in the blank, 2 essay or short answer/);
    const mark = fileHas(result, FindingCode.FormattingKeyUsed);
    assert.equal(mark?.severity, "warn", "a key read from formatting is always something to confirm");
    assert.match(mark?.message ?? "", /Bold and underlining on the option letter set the correct answer apart in 4 of 4 choice questions/);
    assert.match(mark?.message ?? "", /The other options have coloured text on the option letter, which agrees/);
  });

  test("only the copy with the answers reads the same, with nothing to fold", () => {
    const result = read(lookalike({ halves: "key" }));
    checkAll(result);
    assert.equal(fileHas(result, FindingCode.RepeatedQuestionsFolded), undefined);
  });

  test("only the copy for students has no answers, and none is made up", () => {
    const result = read(lookalike({ halves: "student" }));
    assert.equal(result.questions.length, 10);
    // The types still come from the headings, so nothing is inferred.
    assert.equal(result.questions.some((q) => has(q, FindingCode.TypeInferred)), false);
    assert.deepEqual(
      result.questions.map((q) => q.type),
      ["fillInBlank", "fillInBlank", "trueFalse", "trueFalse", "multipleChoice", "multipleChoice", "multipleChoice", "multipleChoice", "essay", "essay"],
    );
    for (const q of result.questions.filter((q) => q.type !== "essay")) {
      assert.equal(verdictFrom(q.findings), "failed", `${plain(q.stem)} has no key and must say so`);
      assert.ok(has(q, FindingCode.NoAnswerKey));
    }
    for (const q of result.questions.filter((q) => q.type === "multipleChoice")) assert.doesNotMatch(keyOf(q), /X/, "no option made correct");
    for (const q of result.questions.filter((q) => q.type === "trueFalse")) assert.equal(body(q)["correct"], undefined, "neither True nor False chosen");
    // The line of choices is not part of the stem, and the line to write on is not text.
    assert.equal(plain((result.questions[2] as Question).stem), "Sandy soil drains faster than clay soil.");
    assert.equal(plain((result.questions[0] as Question).stem), "The ______ layer of a garden bed holds most of its nutrients.");
    assert.equal(result.orphans.length, 2);
  });

  test("a question whose copy for students says something different is kept, not folded into the other", () => {
    const result = read(lookalike({ student: (item, i) => (i === 4 ? { ...item, stem: item.stem.replace("improves", "worsens") } : item) }));
    // Ten from the copy with the answers, and the one that differs from the copy before it.
    assert.equal(result.questions.length, 11);
    const folded = fileHas(result, FindingCode.RepeatedQuestionsFolded);
    assert.match(folded?.message ?? "", /^9 questions appear twice/);
    assert.match(folded?.message ?? "", /1 question before the heading says something different from every question after it, and was kept as written/);
    const kept = result.questions.find((q) => plain(q.stem).includes("worsens")) as Question;
    assert.equal(verdictFrom(kept.findings), "failed", "it has no key of its own, and takes none from its lookalike");
    assert.doesNotMatch(keyOf(kept), /X/);
  });

  test("a difference in spacing or capitals between the copies is not a different question", () => {
    const result = read(lookalike({ student: (item) => ({ ...item, stem: item.stem.toUpperCase().replace(/ /g, "  ") }) }));
    checkAll(result);
    assert.match(fileHas(result, FindingCode.RepeatedQuestionsFolded)?.message ?? "", /^10 questions appear twice/);
  });

  test("two questions alike in the copy for students go to two alike in the key, in order, once each", () => {
    const twin: Item = { kind: "truefalse", stem: "Worms help aerate soil.", answer: "TRUE", page: "20" };
    const items = [twin, { ...twin, answer: "FALSE" }];
    const result = read(lookalike({ items }));
    // Each question of the copy for students goes to one of the two in the copy with the
    // answers, once, and the keys stay each their own: the bank is two questions, not one.
    assert.equal(result.questions.length, 2);
    assert.deepEqual(result.questions.map((q) => body(q)["correct"]), [true, false]);
  });

  test("two alike questions before the heading and one after fold only one, and the other is kept", () => {
    const result = text(["1. Pick", "a. x", "b. y", "", "1. Pick", "a. x", "b. y", "", "Answer Key", "", "1. Pick", "a. x", "*b. y"]);
    assert.equal(result.questions.length, 2);
    assert.match(fileHas(result, FindingCode.RepeatedQuestionsFolded)?.message ?? "", /^1 question appears twice.*1 question before the heading says something different/);
    assert.deepEqual(verdicts(result), ["failed", "parsed"], "the one with no twin left is the one that fails, and says why");
  });

  test("the options have to match as well as the stem", () => {
    const result = text(["1. Pick", "a. x", "b. y", "", "Answer Key", "", "1. Pick", "a. x", "*b. z"]);
    assert.equal(result.questions.length, 2);
    assert.equal(fileHas(result, FindingCode.RepeatedQuestionsFolded), undefined);
  });

  test("a file with an Answers list is keyed in that way, and nothing is folded in it", () => {
    const result = text([
      "Multiple Choice", "", "1. Pick", "a. one", "b. two", "",
      "Answer Key", "", "Multiple Choice", "", "1. Pick", "a. one", "b. two", "",
      "Answers:", "1. b",
    ]);
    assert.equal(result.questions.length, 2);
    assert.equal(fileHas(result, FindingCode.RepeatedQuestionsFolded), undefined);
  });

  test("a question in the copy for students that gives its own answer is not folded away", () => {
    const starred = read(
      docx({
        body:
          paragraph(run("1. Pick one.")) + paragraph(run("*a. Yes")) + paragraph(run("b. No")) + paragraph() +
          paragraph(run("Answer Key")) + paragraph() +
          paragraph(run("1. Pick one.")) + paragraph(run("a. Yes")) + paragraph(run("*b. No")),
      }),
    );
    // The first has a key of its own, so nothing is folded and nothing is taken from the other.
    assert.equal(starred.questions.length, 2);
    assert.equal(fileHas(starred, FindingCode.RepeatedQuestionsFolded), undefined);
  });
});

// ---------------------------------------------------------------------------

describe("how the right option is marked in the copy with the answers", () => {
  test("a bold underlined letter alone, with no grey on the others", () => {
    const result = read(lookalike({ halves: "key", mark: "letter only" }));
    checkAll(result);
    const mark = fileHas(result, FindingCode.FormattingKeyUsed);
    assert.match(mark?.message ?? "", /^Bold and underlining on the option letter set the correct answer apart/);
    assert.doesNotMatch(mark?.message ?? "", /The other options have/);
  });

  test("the words bold, letters plain, is the old convention and is named as that", () => {
    const result = read(lookalike({ halves: "key", mark: "words bold" }));
    checkAll(result);
    assert.match(fileHas(result, FindingCode.FormattingKeyUsed)?.message ?? "", /^Bold sets the correct answer apart/);
  });

  test("no mark at all gives the choice questions no key, and the other answers are still read", () => {
    const result = read(lookalike({ halves: "key", mark: "none" }));
    const choices = result.questions.filter((q) => q.type === "multipleChoice");
    assert.equal(choices.length, 4);
    for (const q of choices) {
      assert.equal(verdictFrom(q.findings), "failed");
      assert.doesNotMatch(keyOf(q), /X/);
    }
    for (const q of result.questions.filter((q) => q.type !== "multipleChoice")) assert.equal(verdictFrom(q.findings), "parsed");
  });

  test("grey letters that do not leave out exactly the marked option mean no key from formatting at all", () => {
    // In the third question the grey falls on a different set of options from the one the bold leaves out.
    const quiz = (clash: boolean): Uint8Array => {
      const option = (letter: string, words: string, properties: string): string => table([[paragraph(run(`${letter}. `, properties)), paragraph(run(words))]]) + paragraph();
      const rows = Array.from({ length: 4 }, (_, n) => {
        const grey = (i: number): string => (clash && n === 2 && i === 2 ? "" : GREY);
        return table([[paragraph(run(`${n + 1}.`)), paragraph(run(`Question ${n + 1}?`)) + ["One", "Two", "Three", "Four"].map((w, i) => option("ABCD"[i] as string, w, i === 1 ? BOLD + UNDERLINE : grey(i))).join("")]]);
      });
      return docx({ body: rows.join("") });
    };
    const agreeing = read(quiz(false));
    assert.deepEqual(agreeing.questions.map(keyOf), [".X..", ".X..", ".X..", ".X.."]);
    const clashing = read(quiz(true));
    assert.deepEqual(clashing.questions.map(keyOf), ["....", "....", "....", "...."], "one question that disagrees is enough to trust none");
    assert.match(fileHas(clashing, FindingCode.FormattingKeyUnclear)?.message ?? "", /do not always pick the same option/);
  });

  test("a mark and its opposite on two options cannot say which is the key, and none is chosen", () => {
    // A true or false written as choices: the bold letter on one and the grey letter on the other.
    const option = (letter: string, words: string, properties: string): string => table([[paragraph(run(`${letter}. `, properties)), paragraph(run(words))]]) + paragraph();
    const rows = Array.from({ length: 4 }, (_, n) =>
      table([[paragraph(run(`${n + 1}.`)), paragraph(run(`Statement ${n + 1}.`)) + option("A", "Agree", BOLD) + option("B", "Disagree", GREY)]]),
    );
    const result = read(docx({ body: rows.join("") }));
    assert.deepEqual(result.questions.map(keyOf), ["..", "..", "..", ".."]);
    assert.ok(fileHas(result, FindingCode.FormattingKeyUnclear), "and the file says why");
  });

  test("it can be asked for by name: label:bold", () => {
    const bytes = lookalike({ halves: "key", mark: "letter only" });
    const named = wordImporter.parseBytes(bytes, { ...OPTIONS, keyMark: "label:bold" });
    assert.deepEqual(named.questions.filter((q) => q.type === "multipleChoice").map(keyOf), [".X..", "..X.", "X....", "..X."]);
    const off = wordImporter.parseBytes(bytes, { ...OPTIONS, keyMark: "off" });
    assert.deepEqual(off.questions.filter((q) => q.type === "multipleChoice").map(keyOf), ["....", "....", ".....", "...."]);
  });
});

// ---------------------------------------------------------------------------

describe("a heading gives its questions a type", () => {
  const QUESTIONS: Array<[string, string, string[]]> = [
    ["fillInBlank", "Fill in the Blank", ["1. The sky is ____.", "Answer: blue"]],
    ["trueFalse", "True / False", ["1. The sky is blue.", "Answer: True"]],
    ["multipleChoice", "Multiple Choice", ["1. The sky is", "a. green", "*b. blue"]],
    ["multipleResponse", "Multiple Response", ["1. Which are colours?", "*a. blue", "*b. green", "c. loud"]],
    ["essay", "Essay", ["1. Describe the sky."]],
  ];
  const SPELLINGS: Record<string, string[]> = {
    "Fill in the Blank": ["Fill in the Blank", "Fill-in-the-Blank Questions", "FILL IN THE BLANKS:", "Fill in the blank questions"],
    "True / False": ["True / False", "True/False Questions", "TRUE OR FALSE", "True-False Questions", "True or False:"],
    "Multiple Choice": ["Multiple Choice", "Multiple Choice Questions:", "MULTIPLE-CHOICE QUESTIONS"],
    "Multiple Response": ["Multiple Response", "Multiple Answer Questions", "Multiple Responses"],
    Essay: ["Essay", "Essay Questions", "Short Answer", "Short Answer Questions", "SHORT ANSWERS:"],
  };

  for (const [type, name, lines] of QUESTIONS) {
    test(`${name}, however it is spelled, makes its questions ${type} and is not part of them`, () => {
      for (const spelling of SPELLINGS[name] as string[]) {
        const result = text([spelling, "", ...lines]);
        const q = result.questions[0] as Question;
        assert.equal(q.type, type, spelling);
        assert.equal(has(q, FindingCode.TypeInferred), false, `${spelling}: the type was stated, not inferred`);
        assert.equal(result.orphans.length, 0, `${spelling}: a heading is read, not reported as stray text`);
        assert.equal(plain(q.stem).includes("Question"), false, spelling);
        assert.equal(verdictFrom(q.findings), "parsed", `${spelling}: ${q.findings.map((f) => f.message).join(" / ")}`);
      }
    });
  }

  test("each section has its own type, and a heading after the last option is not that option's text", () => {
    const result = text([
      "Multiple Choice Questions", "", "1. Pick", "a. one", "*b. two", "", "True / False Questions", "", "2. It is so.", "Answer: True", "",
      "Short Answer Questions", "", "3. Say why.",
    ]);
    assert.deepEqual(result.questions.map((q) => q.type), ["multipleChoice", "trueFalse", "essay"]);
    assert.equal(plain((body(result.questions[0] as Question)["options"] as Array<{ content: Parameters<typeof plain>[0] }>)[1]?.content as never), "two");
    assert.equal(result.orphans.length, 0);
  });

  test("a heading directly after the last option, with no blank line, is still a heading", () => {
    const result = text(["1. Pick", "a. one", "*b. two", "True / False Questions", "2. It is so.", "Answer: True"]);
    assert.deepEqual(result.questions.map((q) => q.type), ["multipleChoice", "trueFalse"]);
    assert.equal(plain((body(result.questions[0] as Question)["options"] as Array<{ content: Parameters<typeof plain>[0] }>)[1]?.content as never), "two");
  });

  test("a Type line is the file's own word and beats the heading", () => {
    const result = text(["Multiple Choice Questions", "", "Type: TF", "1. It is so.", "Answer: True"]);
    assert.equal((result.questions[0] as Question).type, "trueFalse");
  });

  test("a line that only mentions the words, or lists the two choices, is not a heading", () => {
    const result = text(["True / False Questions", "", "1. Which of these is a multiple choice question?", "True    False", "True / False answers are scored by hand.", ""]);
    const q = result.questions[0] as Question;
    // The choices line is said by the type, and the sentence that merely contains the words is the question's own.
    assert.equal(plain(q.stem), "Which of these is a multiple choice question? True / False answers are scored by hand.");
    assert.equal(q.type, "trueFalse");
  });

  test("the choices of a printed true or false question are not added to its stem, whichever way they are written", () => {
    for (const choices of ["True    False", "True / False", "True | False", "True\tFalse", "TRUE or FALSE"]) {
      const result = text(["True / False Questions", "", "1. The sky is blue.", choices, "Answer: True"]);
      const q = result.questions[0] as Question;
      assert.equal(plain(q.stem), "The sky is blue.", choices);
      assert.equal(body(q)["correct"], true, choices);
    }
  });

  test("a heading no question uses is reported, so that it is not lost", () => {
    const result = text(["1. Pick", "a. one", "*b. two", "", "Essay Questions"]);
    assert.deepEqual(result.orphans.map((o) => o.text), ["Essay Questions"]);
    const again = text(["Essay Questions", "", "True / False Questions", "", "1. It is so.", "Answer: True"]);
    assert.deepEqual(again.orphans.map((o) => o.text), ["Essay Questions"]);
    assert.equal((again.questions[0] as Question).type, "trueFalse");
  });

  test("a file with no headings is read as it always was", () => {
    const result = text(["1. Pick", "a. one", "*b. two", "", "2. Is it so?", "a. True", "*b. False"]);
    assert.deepEqual(result.questions.map((q) => q.type), ["multipleChoice", "trueFalse"]);
  });
});

// ---------------------------------------------------------------------------

describe("an answer on a line of its own under the question", () => {
  test("True or False alone under a true or false question is its answer, with or without a heading", () => {
    for (const lines of [["True / False", "", "1. It is so.", "TRUE"], ["Type: TF", "1. It is so.", "True."], ["Type: TF", "1. It is not so.", "false"]]) {
      const result = text(lines);
      const q = result.questions[0] as Question;
      assert.equal(body(q)["correct"], lines.at(-1)?.toLowerCase().startsWith("t"), lines.join(" | "));
      assert.equal(verdictFrom(q.findings), "parsed");
    }
  });

  test("a fill in the blank's line to write on is not part of its stem", () => {
    const result = text(["Fill in the Blank", "", "1. The sky is ____.", "________________________________________", "Answer: blue"]);
    const q = result.questions[0] as Question;
    assert.equal(plain(q.stem), "The sky is ____.");
    assert.deepEqual(body(q)["blanks"], [{ id: "b1", accepted: ["blue"] }]);
  });

  test("after an answer key heading, a line after a blank under a fill in the blank or an essay is its answer", () => {
    const result = text([
      "Chapter 2 Answer Key", "",
      "Fill in the Blank", "", "1. The sky is ____.", "", "blue", "",
      "Essay", "", "2. Describe the sky.", "", "It is blue because of scattering.", "", "Red light passes through.",
    ]);
    const [fill, essay] = result.questions as [Question, Question];
    assert.deepEqual(body(fill)["blanks"], [{ id: "b1", accepted: ["blue"] }]);
    assert.equal(plain(fill.stem), "The sky is ____.");
    assert.equal(plain(body(essay)["modelAnswer"]), "It is blue because of scattering. Red light passes through.");
    assert.equal(plain(essay.stem), "Describe the sky.");
    assert.deepEqual(verdicts(result), ["parsed", "parsed"]);
    assert.match(fileHas(result, FindingCode.AnswerFromUnlabelledLine)?.message ?? "", /2 answers were read.*1 fill in the blank, 1 essay or short answer/);
  });

  test("without that heading the same lines are more of the question, as they always were", () => {
    const result = text(["Fill in the Blank", "", "1. The sky is ____.", "", "blue", "", "Essay", "", "2. Describe the sky.", "", "Be brief."]);
    const [fill, essay] = result.questions as [Question, Question];
    assert.equal(plain(fill.stem), "The sky is ____. blue");
    assert.equal(verdictFrom(fill.findings), "failed", "so it has no answer, and says so");
    assert.equal(plain(essay.stem), "Describe the sky. Be brief.", "an essay's second paragraph is not an answer");
    assert.equal(fileHas(result, FindingCode.AnswerFromUnlabelledLine), undefined);
  });

  test("a line straight under the stem, with no blank between, is not taken for an answer", () => {
    const result = text(["Answer Key", "", "Essay", "", "1. Describe the sky.", "with care.", "", "A long answer."]);
    assert.equal(plain((result.questions[0] as Question).stem), "Describe the sky. with care.");
    assert.equal(plain(body(result.questions[0] as Question)["modelAnswer"]), "A long answer.");
  });

  test("which lines are a heading for the answer key", () => {
    const keyed = (heading: string): boolean => {
      const result = text([heading, "", "Essay", "", "1. Describe the sky.", "", "Blue."]);
      return Boolean(fileHas(result, FindingCode.AnswerKeyPart));
    };
    for (const heading of ["Answer Key", "Chapter 4 Answer Key:", "Instructor's Answer Key", "ANSWER KEY", "Test Bank Answer Key."]) assert.equal(keyed(heading), true, heading);
    for (const heading of ["Which answer key is right?", "Please see the last page of this document for the complete answer key", "Answers", "Key"]) assert.equal(keyed(heading), false, heading);
  });
});

// ---------------------------------------------------------------------------

describe("a stem with several blanks", () => {
  const blanks = (stem: string, answers: string[]): Question => {
    const result = text(["Fill in the Blank", "", `1. ${stem}`, ...answers.map((a) => `a. ${a}`)]);
    return result.questions[0] as Question;
  };

  test("one answer for each blank, between semicolons, is read as that", () => {
    const q = blanks("A ____ and a ____.", ["cat; dog"]);
    assert.deepEqual(body(q)["blanks"], [{ id: "b1", accepted: ["cat"] }, { id: "b2", accepted: ["dog"] }]);
    assert.equal(verdictFrom(q.findings), "parsed");
    assert.deepEqual((body(blanks("A ____, a ____ and a ____.", ["cat;dog ; bird"]))["blanks"] as Array<{ accepted: string[] }>).map((b) => b.accepted[0]), ["cat", "dog", "bird"]);
  });

  test("any other count is not split, because which answer is for which blank would be a guess", () => {
    for (const [stem, answers] of [["A ____ and a ____.", ["cat"]], ["A ____, a ____ and a ____.", ["cat; dog"]], ["A ____ and a ____.", ["cat", "dog"]], ["A ____ and a ____.", ["cat; "]]] as Array<[string, string[]]>) {
      const q = blanks(stem, answers);
      assert.equal(body(q)["blanks"].length, 1, `${stem} ${answers.join(" / ")}`);
      assert.ok(has(q, FindingCode.BlankCountMismatch), `${stem} ${answers.join(" / ")}`);
      assert.equal(verdictFrom(q.findings), "needsReview");
    }
  });

  test("one blank, or a semicolon in an answer that has one blank, is left alone", () => {
    const q = blanks("A ____.", ["cat; dog"]);
    assert.deepEqual(body(q)["blanks"], [{ id: "b1", accepted: ["cat; dog"] }]);
    assert.equal(verdictFrom(q.findings), "parsed");
    assert.equal(has(blanks("A __ and a __.", ["cat"]), FindingCode.BlankCountMismatch), false, "two underscores is not a blank");
  });
});

// ---------------------------------------------------------------------------

describe("a number in one cell and the question in the next", () => {
  /** One question as a table, with `numberLines` in the first cell and `content` (paragraph XML) in the second. */
  const question = (numberLines: string[], content: string): string => table([[numberLines.map((l) => paragraph(run(l))).join(""), content]]);
  const stem = (words: string): string => paragraph(run(words));

  test("a page reference below the number, however it is written, is the page", () => {
    const cases: Array<[string, string]> = [
      ["(p. 12)", "12"], ["(pp. 12-14)", "12-14"], ["p. 12", "12"], ["(p. 12, 15)", "12, 15"], ["Page 3", "3"], ["(pages 7 - 9)", "7 - 9"],
    ];
    for (const [ref, page] of cases) {
      const result = read(docx({ body: question(["1.", ref], stem("Describe it.")) }));
      assert.equal((result.questions[0] as Question).metadata.page, page, ref);
      assert.equal(result.orphans.length, 0, ref);
    }
  });

  test("another label below the number is read as that label, and a line that is none is reported", () => {
    const options = paragraph(run("a. Yes")) + paragraph(run("*b. No"));
    const labelled = read(docx({ body: question(["1.", "Difficulty: Hard"], stem("Pick one.") + options) }));
    assert.equal((labelled.questions[0] as Question).metadata.difficulty, "hard");
    const loose = read(docx({ body: question(["1.", "Easy"], stem("Pick one.") + options) }));
    assert.deepEqual(loose.orphans.map((o) => o.text), ["Easy"]);
    assert.equal(loose.questions.length, 1);
    assert.equal(keyOf(loose.questions[0] as Question), ".X", "and the question is whole");
  });

  test("the blank lines inside the cell stay, because a blank line ends an option", () => {
    const content = stem("Pick one.") + paragraph() + paragraph(run("a. Yes")) + paragraph() + paragraph(run("*b. No")) + paragraph();
    const result = read(docx({ body: question(["1."], content) + question(["2."], stem("Describe it.")) }));
    assert.deepEqual(result.questions.map((q) => q.type), ["multipleChoice", "essay"]);
    assert.equal(keyOf(result.questions[0] as Question), ".X");
  });

  test("a table whose first cell is not a number, or has more than two cells, is no such layout", () => {
    const notNumber = read(docx({ body: table([[paragraph(run("Notes")), paragraph(run("1. Pick one.")) + paragraph(run("*a. Yes")) + paragraph(run("b. No"))]]) }));
    assert.equal(notNumber.questions.length, 1, "its words are still read, cell by cell, in order");
    assert.equal(fileHasLayout(notNumber, "number in one cell"), false);
    const three = read(docx({ body: table([[paragraph(run("1.")), paragraph(run("Describe it.")), paragraph(run("Hard"))]]) }));
    assert.equal(fileHasLayout(three, "number in one cell"), false, "three cells are not this layout");
  });

  test("the padding a cell has above and below its words is not part of the question", () => {
    const padded = table([[paragraph(run("1.")) + paragraph(run("(p. 4)")), paragraph() + stem("Describe it.") + paragraph() + paragraph()]]);
    const { blocks } = docxToBlocks(docx({ body: padded }));
    assert.deepEqual(blocks.map((b) => b.text), ["1. Describe it.", "Page: 4", ""]);
  });

  test("one row with nothing in its question cell stops the table being read as questions, and nothing of it is lost", () => {
    const rows = table([
      [paragraph(run("1.")) + paragraph(run("(p. 1)")), stem("Describe it.")],
      [paragraph(run("2.")) + paragraph(run("(p. 2)")), paragraph()],
    ]);
    const { blocks } = docxToBlocks(docx({ body: rows }));
    const texts = blocks.map((b) => b.text);
    assert.ok(texts.includes("2.") && texts.includes("(p. 2)") && texts.includes("Describe it."), texts.join(" | "));
  });

  test("a cell merged across makes it no layout, as it does for a grid, because what it means is not knowable", () => {
    const cell = (inner: string, extra = ""): string => `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/>${extra}</w:tcPr>${inner}</w:tc>`;
    const merged = `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="2400"/></w:tblGrid><w:tr>${cell(paragraph(run("1.")) + paragraph(run("(p. 4)")))}${cell(stem("Describe it."), '<w:gridSpan w:val="2"/>')}</w:tr></w:tbl>`;
    const result = read(docx({ body: merged }));
    assert.equal(fileHasLayout(result, "number in one cell"), false);
    assert.ok(result.orphans.some((o) => o.text === "(p. 4)") || result.questions.length > 0, "its words are read, cell by cell, not lost");
  });

  test("the layouts that were there first still take what they took", () => {
    // A number and its words, nothing under the number: labelled rows, as before.
    const result = read(docx({ body: question(["1."], stem("Describe it.")) }));
    assert.equal(fileHasLayout(result, "labelled rows"), true);
    assert.equal(fileHasLayout(result, "number in one cell"), false);
    // The same with a page reference under the number is what labelled rows refused, and this one reads.
    const withPage = read(docx({ body: question(["1.", "(p. 4)"], stem("Describe it.")) }));
    assert.equal(fileHasLayout(withPage, "number in one cell"), true);
  });

  test("several questions in one table, a row for each", () => {
    const result = read(docx({ body: table([[paragraph(run("1.")), stem("Describe it.")], [paragraph(run("2.") ) + paragraph(run("(p. 4)")), stem("Explain it.")]]) }));
    assert.deepEqual(result.questions.map((q) => plain(q.stem)), ["Describe it.", "Explain it."]);
    assert.equal((result.questions[1] as Question).metadata.page, "4");
  });
});

describe("a table inside a cell of a table", () => {
  const inner = (words: string[]): string => table([words.map((w) => paragraph(run(w)))]);

  test("what is read from the inner table comes in the order it stands in, between the paragraphs around it", () => {
    const outer = table([[paragraph(run("Notes")), paragraph(run("before")) + inner(["one", "two"]) + paragraph(run("after"))]]);
    const { blocks } = docxToBlocks(docx({ body: outer }));
    assert.deepEqual(blocks.map((b) => b.text), ["Notes", "before", "one", "two", "after"]);
  });

  test("a table that is not a layout is read cell by cell, tables inside it included, as before", () => {
    const outer = table([[paragraph(run("1.")) + inner(["a", "b"]), paragraph(run("x"))], [paragraph(run("2.")), inner(["c"])]]);
    const { blocks, findings } = docxToBlocks(docx({ body: outer }));
    assert.deepEqual(blocks.map((b) => b.text), ["1.", "a", "b", "x", "2.", "c"]);
    assert.equal(findings.some((f) => /read cell by cell/.test(f.message)), true);
  });

  test("the layouts that never read a cell with a table in it still do not", () => {
    // A row that begins with a label is labelled rows, and is not once there is a table in its second cell.
    const plainRow = table([[paragraph(run("a.")), paragraph(run("Yes"))]]);
    assert.equal(docxToBlocks(docx({ body: plainRow })).findings.some((f) => /1 as labelled rows/.test(f.message)), true);
    const withTable = table([[paragraph(run("a.")), paragraph(run("Yes")) + inner(["no"])]]);
    const { blocks, findings } = docxToBlocks(docx({ body: withTable }));
    assert.equal(findings.some((f) => /as labelled rows/.test(f.message)), false);
    assert.deepEqual(blocks.map((b) => b.text), ["a.", "Yes", "no"]);
  });

  test("a table inside a table inside a table keeps every line, in order", () => {
    const deepest = table([[paragraph(run("deep"))]]);
    const middle = table([[paragraph(run("mid")) + deepest + paragraph(run("mid again"))]]);
    const outer = table([[paragraph(run("top")) + middle + paragraph(run("end"))]]);
    const { blocks } = docxToBlocks(docx({ body: outer }));
    assert.deepEqual(blocks.map((b) => b.text), ["top", "mid", "deep", "mid again", "end"]);
  });
});

// ---------------------------------------------------------------------------

describe("speed", () => {
  test("500 questions in this layout, each given twice, import within the 3 second budget and none is lost", () => {
    const items = Array.from({ length: 50 }, (_, k) => ITEMS.map((i) => ({ ...i, stem: `${i.stem} (${k})` }))).flat();
    const bytes = lookalike({ items });
    const started = performance.now();
    const result = read(bytes);
    assert.ok(performance.now() - started < 3000, "within the budget");
    assert.equal(result.questions.length, 500);
    assert.deepEqual(result.counts, { parsed: 500, needsReview: 0, failed: 0, orphans: 2 });
  });
});

describe("a real publisher chapter, when there is one", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const folder = join(here, "..", "..", "..", "fixtures", "publisher");
  const present = existsSync(folder) && readdirSync(folder).some((n) => n.endsWith(".expected.json"));

  test("every chapter in fixtures/publisher with an expected file scores in full", { skip: present ? false : "none there; the folder is git-ignored and local" }, async () => {
    const scored = await runHarness(folder);
    for (const file of scored.files) {
      assert.deepEqual(file.mismatches, [], `${file.file}: ${file.mismatches.map((m) => `${m.field} ${m.expected} vs ${m.actual}`).join("; ")}`);
      assert.equal(file.correct, file.expectedCount, file.file);
    }
  });
});
