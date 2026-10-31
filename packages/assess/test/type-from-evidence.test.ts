/**
 * Questions whose type the file never names but whose answer gives it away. Three readings, found when
 * a batch of generated banks was run before anything was changed and 29 of 72 questions came out as
 * essays with the answer in the stem or no key at all:
 *
 * - a statement with no options whose answer is the word True or False is a true or false question;
 * - an answer labelled "Accepted answers" is a typed-in answer, a fill in the blank when the stem has a
 *   blank and a short answer when it has none;
 * - an instruction that says to match, with a line of "left = right" under it for each pair, is a
 *   matching question.
 *
 * None of these guesses a key. The key is the file's own word or pair, and the type only says where
 * it goes. What would be a guess is left alone: an essay with no answer, a stem with a blank whose
 * answer is True, a sum under a stem that says nothing about matching. These tests use invented text.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { standardTextImporter } from "../src/import/standard-text.ts";
import { type ImportResult } from "../src/import/types.ts";
import { wordImporter } from "../src/import/word.ts";
import { FindingCode, verdictFrom } from "../src/model/findings.ts";
import type { Question } from "../src/model/question.ts";
import { richTextToPlain } from "../src/model/richtext.ts";
import { docx, paragraph, run } from "./support/docx-writer.ts";

const OPTIONS = { file: "t.txt", at: "2026-01-01T00:00:00.000Z", author: "test" };
const text = (lines: string[]): ImportResult => standardTextImporter.parse(lines.join("\n"), OPTIONS);
const inWord = (lines: string[]): ImportResult =>
  wordImporter.parseBytes(docx({ body: lines.map((l) => paragraph(l === "" ? "" : run(l))).join("") }), { ...OPTIONS, file: "t.docx" });
const both = (lines: string[]): ImportResult[] => [text(lines), inWord(lines)];

const body = (q: Question): Record<string, any> => q.body as Record<string, any>;
const plain = (rich: Parameters<typeof richTextToPlain>[0]): string => richTextToPlain(rich).replace(/\s+/g, " ").trim();
const stemOf = (q: Question): string => plain(q.stem);
const has = (q: Question, code: string): boolean => q.findings.some((f) => f.code === code);
const verdict = (q: Question): string => verdictFrom(q.findings);
const at = (result: ImportResult, n: number): Question => result.questions[n] as Question;
const blanksOf = (q: Question): string[] => (body(q)["blanks"] as Array<{ accepted: string[] }>)[0]?.accepted ?? [];
const pairsOf = (q: Question): string[] =>
  (body(q)["pairs"] as Array<{ left: Parameters<typeof plain>[0]; right: string }>).map((p) => `${plain(p.left)} = ${p.right}`);

describe("a statement with no options whose answer is True or False", () => {
  test("is a true or false question, and the answer is the key", () => {
    for (const result of both(["1. Photosynthesis produces oxygen.", "Answer: True", "", "2. The moon is made of cheese.", "Answer: False"])) {
      assert.equal(result.questions.length, 2);
      const [yes, no] = result.questions as [Question, Question];
      assert.equal(yes.type, "trueFalse");
      assert.equal(stemOf(yes), "Photosynthesis produces oxygen.");
      assert.equal(body(yes)["correct"], true);
      assert.equal(no.type, "trueFalse");
      assert.equal(body(no)["correct"], false, "False is read as false, not as no answer");
      for (const q of result.questions) {
        assert.equal(verdict(q), "parsed", "the answer is the file's own word, so nothing is left to check");
        assert.ok(has(q, FindingCode.TypeFromEvidence), "but the reading is said to be one");
        assert.equal(has(q, FindingCode.TypeInferred), false);
      }
      assert.equal(result.orphans.length, 0);
    }
  });

  test("the case of the word and a full stop after it do not matter", () => {
    const q = at(text(["1. Ice floats on water.", "ANS: true."]), 0);
    assert.equal(q.type, "trueFalse");
    assert.equal(body(q)["correct"], true);
    assert.equal(at(text(["1. Ice floats on water.", "Correct Answer: FALSE"]), 0).type, "trueFalse");
  });

  test("an answer in a list at the end of the file is read the same way", () => {
    const result = text(["1. Ice floats on water.", "", "2. Fire is cold.", "", "Answers:", "1. True", "2. False"]);
    const [one, two] = result.questions as [Question, Question];
    assert.equal(one.type, "trueFalse");
    assert.equal(body(one)["correct"], true);
    assert.equal(two.type, "trueFalse");
    assert.equal(body(two)["correct"], false);
  });

  test("no answer is still an essay, flagged, with no key invented", () => {
    for (const result of both(["1. Ice floats on water."])) {
      const q = at(result, 0);
      assert.equal(q.type, "essay");
      assert.ok(has(q, FindingCode.TypeInferred));
      assert.equal(verdict(q), "needsReview");
      assert.equal(has(q, FindingCode.TypeFromEvidence), false);
    }
  });

  test("only the word itself counts: T, Yes, a sentence and two answers are not read as true or false", () => {
    for (const answer of ["T", "Yes", "True because ice is lighter", "True, False", "Truth"]) {
      const q = at(text(["1. Ice floats on water.", `Answer: ${answer}`]), 0);
      assert.notEqual(q.type, "trueFalse", answer);
      assert.equal(has(q, FindingCode.TypeFromEvidence), false, answer);
    }
  });

  test("a stem with a blank in it is not true or false, whatever the answer is", () => {
    const q = at(text(["1. A boolean is either ____ or false.", "Answer: True"]), 0);
    assert.notEqual(q.type, "trueFalse");
    assert.ok(has(q, FindingCode.TypeInferred), "it is read as before: an essay, flagged");
    assert.match(plain(body(q)["modelAnswer"]), /True/, "and the answer is kept, not dropped");
  });

  test("two answers that disagree are not a key", () => {
    const result = text(["1. Ice floats on water.", "Answer: True", "", "Answers:", "1. False"]);
    assert.notEqual(at(result, 0).type, "trueFalse");
  });

  test("a type the file does state is not overruled", () => {
    const q = at(text(["Type: E", "1. Ice floats on water.", "Answer: True"]), 0);
    assert.equal(q.type, "essay");
    assert.equal(has(q, FindingCode.TypeFromEvidence), false);
    assert.equal(has(q, FindingCode.TypeInferred), false);
  });

  test("nor is a type line this profile does not know: that is worked out as before, and flagged", () => {
    const q = at(text(["Type: XX", "1. Ice floats on water.", "Answer: True"]), 0);
    assert.equal(q.type, "essay");
    assert.ok(has(q, FindingCode.TypeInferred));
    assert.equal(has(q, FindingCode.TypeFromEvidence), false);
  });

  test("a question that has options is a choice question, whatever its answer says", () => {
    const q = at(text(["1. Ice floats on water.", "a. Yes", "b. No", "Answer: True"]), 0);
    assert.equal(q.type, "multipleChoice");
    assert.equal(has(q, FindingCode.TypeFromEvidence), false);
    assert.equal(verdict(q), "failed", "True names no option, and no key was invented");
  });

  test("underscores that are not a blank do not stop a statement being true or false", () => {
    assert.equal(at(text(["1. In Python, my_var is a valid name.", "Answer: True"]), 0).type, "trueFalse");
    assert.equal(at(text(["1. The __init__ method runs when an object is made.", "Answer: True"]), 0).type, "trueFalse");
    assert.equal(at(text(["1. A boolean is either ___ or false.", "Answer: True"]), 0).type, "essay", "three are a blank");
  });

  test("a question with options is read as before", () => {
    const q = at(text(["1. Ice floats on water.", "a. True", "b. False", "Answer: a"]), 0);
    assert.equal(q.type, "trueFalse");
    assert.equal(has(q, FindingCode.TypeFromEvidence), false, "it was never in doubt");
    assert.equal(body(q)["correct"], true);
  });
});

describe("an answer labelled Accepted answers", () => {
  test("with a blank in the stem, it is a fill in the blank and each form is accepted", () => {
    for (const result of both(["1. Water freezes at ____ degrees Celsius.", "Accepted answers: 0, zero"])) {
      const q = at(result, 0);
      assert.equal(q.type, "fillInBlank");
      assert.equal(stemOf(q), "Water freezes at ____ degrees Celsius.", "the answer line is not in the stem");
      assert.deepEqual(blanksOf(q), ["0", "zero"]);
      assert.equal(verdict(q), "parsed");
      assert.ok(has(q, FindingCode.TypeFromEvidence));
      assert.equal(result.orphans.length, 0);
    }
  });

  test("with no blank, it is a short answer", () => {
    for (const result of both(["1. Which gas is most of the air?", "Accepted answers: Nitrogen, N2"])) {
      const q = at(result, 0);
      assert.equal(q.type, "shortAnswer");
      assert.equal(stemOf(q), "Which gas is most of the air?");
      assert.deepEqual(body(q)["accepted"], ["Nitrogen", "N2"]);
      assert.equal(verdict(q), "parsed");
    }
  });

  test("the split is said, with what each form was", () => {
    const q = at(text(["1. Water freezes at ____ degrees Celsius.", "Accepted answers: 0, zero"]), 0);
    const note = q.findings.find((f) => f.code === FindingCode.AcceptedAnswersSplit);
    assert.ok(note);
    assert.equal(note.severity, "info");
    assert.match(note.message, /2 accepted answers \("0", "zero"\)/);
  });

  test("a semicolon cuts the line, and then a comma is part of a form", () => {
    const q = at(text(["1. What is the capital of France?", "Accepted answers: Paris, France; the French capital"]), 0);
    assert.deepEqual(body(q)["accepted"], ["Paris, France", "the French capital"]);
  });

  test("a comma inside a number is not a cut", () => {
    const q = at(text(["1. How many metres are in a kilometre?", "Accepted answers: 1,000, one thousand"]), 0);
    assert.deepEqual(body(q)["accepted"], ["1,000", "one thousand"]);
  });

  test("Accepted answer in the singular is one answer however many commas it has", () => {
    const q = at(text(["1. What is the capital of France?", "Accepted answer: Paris, France"]), 0);
    assert.equal(q.type, "shortAnswer");
    assert.deepEqual(body(q)["accepted"], ["Paris, France"]);
    assert.equal(has(q, FindingCode.AcceptedAnswersSplit), false);
  });

  test("Acceptable answers and a different case are the same label", () => {
    assert.deepEqual(body(at(text(["1. Name a prime.", "ACCEPTABLE ANSWERS: 2, 3"]), 0))["accepted"], ["2", "3"]);
    assert.deepEqual(body(at(text(["1. Name a prime.", "accepted answers: 2, 3"]), 0))["accepted"], ["2", "3"]);
  });

  test("an empty form left by a stray separator is not an answer", () => {
    const q = at(text(["1. Water freezes at ____ degrees Celsius.", "Accepted answers: 0, zero;"]), 0);
    assert.deepEqual(blanksOf(q), ["0, zero"], "a semicolon is the cut, so the comma before it stays inside the form");
    const semi = at(text(["1. Water freezes at ____ degrees Celsius.", "Accepted answers: 0; zero ;; ; "]), 0);
    assert.deepEqual(blanksOf(semi), ["0", "zero"]);
    // The note counts the forms the line was cut into, so a stray separator must not be one of them.
    const note = semi.findings.find((f) => f.code === FindingCode.AcceptedAnswersSplit);
    assert.match(note?.message ?? "", /was read as 2 accepted answers \("0", "zero"\)/);
  });

  test("a list with nothing in it but separators gives no answer and does not become one", () => {
    const q = at(text(["1. Water freezes at ____ degrees Celsius.", "Accepted answers: ;"]), 0);
    assert.equal(q.type, "essay");
    assert.equal(verdict(q), "needsReview");
    assert.equal(has(q, FindingCode.TypeFromEvidence), false);
  });

  test("a single form gives no split note", () => {
    const q = at(text(["1. The powerhouse of the cell is the ____.", "Accepted answers: mitochondria"]), 0);
    assert.deepEqual(blanksOf(q), ["mitochondria"]);
    assert.equal(has(q, FindingCode.AcceptedAnswersSplit), false);
  });

  test("a type the file does state keeps it, and the label still gives the forms", () => {
    const q = at(text(["Type: F", "1. Water freezes at ____ degrees Celsius.", "Accepted answers: 0, zero"]), 0);
    assert.equal(q.type, "fillInBlank");
    assert.deepEqual(blanksOf(q), ["0", "zero"]);
    assert.equal(has(q, FindingCode.TypeFromEvidence), false, "it was stated");
  });

  test("a label with nothing after it gives no key and is not made into one", () => {
    const q = at(text(["1. Which gas is most of the air?", "Accepted answers:"]), 0);
    assert.equal(q.type, "essay");
    assert.ok(has(q, FindingCode.TypeInferred));
    assert.equal(verdict(q), "needsReview");
    assert.equal(has(q, FindingCode.TypeFromEvidence), false);
  });

  test("words that only start like the label are stem text", () => {
    const q = at(text(["1. Explain which answers are accepted: and why."]), 0);
    assert.equal(q.type, "essay");
    assert.equal(stemOf(q), "Explain which answers are accepted: and why.");
  });
});

describe("an instruction to match and a line for each pair", () => {
  const MATCH = ["1. Match the inventor to their invention.", "Bell = Telephone", "Edison = Light bulb", "Wright = Aeroplane"];

  test("is a matching question with those pairs", () => {
    for (const result of both(MATCH)) {
      assert.equal(result.questions.length, 1);
      const q = at(result, 0);
      assert.equal(q.type, "matching");
      assert.equal(stemOf(q), "Match the inventor to their invention.", "the pairs are not in the stem");
      assert.deepEqual(pairsOf(q), ["Bell = Telephone", "Edison = Light bulb", "Wright = Aeroplane"]);
      assert.equal(verdict(q), "parsed");
      assert.ok(has(q, FindingCode.TypeFromEvidence));
      assert.equal(result.orphans.length, 0);
    }
  });

  test("a blank line between the instruction and the pairs is allowed, and the next question is its own", () => {
    const result = text([...MATCH.slice(0, 1), "", ...MATCH.slice(1), "", "2. Which animal lays eggs?", "a. Dog", "*b. Hen"]);
    assert.equal(result.questions.length, 2);
    assert.deepEqual(pairsOf(at(result, 0)), ["Bell = Telephone", "Edison = Light bulb", "Wright = Aeroplane"]);
    assert.equal(at(result, 1).type, "multipleChoice");
  });

  test("the word Matching in the instruction will do", () => {
    const q = at(text(["1. Matching: pair each country with its capital.", "France = Paris", "Italy = Rome"]), 0);
    assert.equal(q.type, "matching");
    assert.equal(pairsOf(q).length, 2);
  });

  test("the pairs end at the first line that is not one, and that line is reported, not dropped", () => {
    const result = text([...MATCH, "Bring a pencil.", ""]);
    const q = at(result, 0);
    assert.equal(q.type, "matching");
    assert.equal(pairsOf(q).length, 3);
    assert.deepEqual(result.orphans.map((o) => o.text), ["Bring a pencil."]);
    assert.equal(has(q, FindingCode.PairLeftOut), false, "stray text after the pairs is not a pair missing");
    assert.equal(verdict(q), "parsed");
  });

  test("a pair after a note or a blank line is not read, and the question says a pair may be missing", () => {
    // Cut at the note or the blank, the run is two pairs, and the question would look complete with
    // Wright missing. The line is stray text, as it must be, and the question is sent to review.
    for (const lines of [
      [...MATCH.slice(0, 3), "Bring a pencil.", "Wright = Aeroplane"],
      [...MATCH.slice(0, 3), "", "Wright = Aeroplane"],
    ]) {
      for (const result of both(lines)) {
        const q = at(result, 0);
        assert.equal(q.type, "matching");
        assert.deepEqual(pairsOf(q), ["Bell = Telephone", "Edison = Light bulb"]);
        assert.ok(result.orphans.some((o) => o.text === "Wright = Aeroplane"), "the line is reported, not dropped");
        const note = q.findings.find((f) => f.code === FindingCode.PairLeftOut);
        assert.ok(note, lines.join(" / "));
        assert.equal(note.severity, "warn");
        assert.match(note.message, /"Wright = Aeroplane" looks like a pair/);
        assert.equal(verdict(q), "needsReview");
      }
    }
  });

  test("a line that looks like a pair after an ordinary question is just stray text", () => {
    const result = text(["1. Which animal lays eggs?", "a. Dog", "*b. Hen", "", "x = 3"]);
    const q = at(result, 0);
    assert.equal(has(q, FindingCode.PairLeftOut), false);
    assert.deepEqual(result.orphans.map((o) => o.text), ["x = 3"]);
  });

  test("an Answer line under the pairs ends them and is not a pair", () => {
    const q = at(text([...MATCH, "Answer: Bell = Telephone"]), 0);
    assert.equal(pairsOf(q).length, 3);
  });

  test("a sum under a stem that does not say to match is not a pair", () => {
    const q = at(text(["1. Solve the system.", "x + y = 5", "x - y = 1"]), 0);
    assert.equal(q.type, "essay");
    assert.match(stemOf(q), /x \+ y = 5/, "the lines stay in the stem");
    assert.ok(has(q, FindingCode.TypeInferred));
  });

  test("an instruction that says match is not enough with only one pair under it", () => {
    const q = at(text(["1. Match the value of x.", "x = 5"]), 0);
    assert.notEqual(q.type, "matching");
  });

  test("a left side that comes twice is not a matching exercise", () => {
    const q = at(text(["1. Match each equation to its graph.", "y = 2x", "y = x^2"]), 0);
    assert.notEqual(q.type, "matching");
    assert.match(stemOf(q), /y = 2x/);
  });

  test("and it is not one with the first pair left behind, either", () => {
    // Refused at the first line, the later lines would be a run of two that began too late, and the
    // question would look complete with Bell left in its stem.
    for (const lines of [
      [...MATCH.slice(0, 3), "Bell = Phone"],
      [...MATCH.slice(0, 3), "bell = Phone"],
      [MATCH[0] as string, "", "Bell = Telephone", "Edison = Light bulb", "Bell = Phone"],
      [MATCH[0] as string, "Bell = Telephone", "*Edison = Light bulb", "Wright = Aeroplane", "Marconi = Radio"],
    ]) {
      const result = text(lines);
      assert.equal(result.questions.length, 1);
      const q = at(result, 0);
      assert.notEqual(q.type, "matching", lines.join(" / "));
      assert.match(stemOf(q), /Bell = Telephone/, "every line is still in the stem");
      assert.equal(verdict(q), "needsReview");
    }
  });

  test("a star in front of a pair is a mark, not a pair", () => {
    const q = at(text(["1. Match the inventor to their invention.", "*Bell = Telephone", "Edison = Light bulb"]), 0);
    assert.notEqual(q.type, "matching");
  });

  test("an instruction that has an equals sign in it is not read, since its own sum looks like a pair", () => {
    const q = at(text(["1. Match the equation y = mx + b to its name.", "Line = Linear", "Curve = Quadratic"]), 0);
    assert.notEqual(q.type, "matching");
    assert.match(stemOf(q), /Curve = Quadratic/);
  });

  test("the next question is not part of the pairs, even with no blank line before it", () => {
    const result = text([...MATCH, "2. Find the value where x = 3", "a. 3", "*b. 4"]);
    assert.equal(result.questions.length, 2);
    assert.equal(pairsOf(at(result, 0)).length, 3);
    assert.equal(at(result, 1).type, "multipleChoice");
  });

  test("a title line under the pairs is the next question's, not a pair", () => {
    const result = text([...MATCH, "Title: Next = Question", "2. Which animal lays eggs?", "a. Dog", "*b. Hen"]);
    assert.equal(pairsOf(at(result, 0)).length, 3);
    assert.equal(result.questions.length, 2);
  });

  test("a lettered line under the pairs is an option of its own, not a pair with its letter in it", () => {
    const q = at(text([...MATCH, "a. Gold = Au"]), 0);
    assert.deepEqual(pairsOf(q), ["Bell = Telephone", "Edison = Light bulb", "Wright = Aeroplane", "Gold = Au"]);
    assert.ok(has(q, FindingCode.DuplicateOptionLetter), "and the letter it repeats is said");
  });

  test("a type the file states is kept, and its lines stay where they were", () => {
    const q = at(text(["Type: E", ...MATCH]), 0);
    assert.equal(q.type, "essay");
    assert.equal(has(q, FindingCode.TypeFromEvidence), false);
    assert.match(stemOf(q), /Bell = Telephone/);
  });

  test("in Word, bold on the terms changes nothing", () => {
    const bold = (term: string, rest: string): string => paragraph(run(term, "<w:b/>") + run(rest));
    const result = wordImporter.parseBytes(
      docx({ body: [paragraph(run("1. Match the inventor to their invention.")), bold("Bell", " = Telephone"), bold("Edison", " = Light bulb")].join("") }),
      { ...OPTIONS, file: "t.docx" },
    );
    const q = at(result, 0);
    assert.equal(q.type, "matching");
    assert.deepEqual(pairsOf(q), ["Bell = Telephone", "Edison = Light bulb"]);
    assert.equal(verdict(q), "parsed");
  });

  test("the equals sign needs a space each side", () => {
    for (const pairs of [
      ["Bell=Telephone", "Edison=Light bulb"],
      ["Bell =Telephone", "Edison =Light bulb"],
      ["Bell= Telephone", "Edison= Light bulb"],
    ]) {
      assert.notEqual(at(text(["1. Match the inventor to their invention.", ...pairs]), 0).type, "matching", pairs.join(" / "));
    }
  });

  test("one equals sign to a line: a line with two is not a pair", () => {
    const q = at(text(["1. Match the inventor to their invention.", "Bell = Telephone = Phone", "Edison = Light bulb"]), 0);
    assert.notEqual(q.type, "matching");
  });

  test("a left side that repeats is found however it is spaced or capitalised", () => {
    for (const again of ["Bell = Phone", "bell = Phone", "Bell  = Phone", "BELL = Phone"]) {
      assert.notEqual(at(text([...MATCH, again]), 0).type, "matching", again);
    }
  });

  test("a word that only contains match does not make an instruction", () => {
    const q = at(text(["1. The matches were used as follows.", "x = 3", "y = 4"]), 0);
    assert.notEqual(q.type, "matching");
  });

  test("lines of pairs with letters are read as they always were, and flagged", () => {
    const q = at(text(["1. Match the inventor to their invention.", "a. Bell = Telephone", "b. Edison = Light bulb"]), 0);
    assert.equal(q.type, "matching");
    assert.ok(has(q, FindingCode.TypeInferred));
    assert.equal(has(q, FindingCode.TypeFromEvidence), false);
  });
});

describe("a bank with all five in it, as a person would write it", () => {
  const BANK = [
    "Test Bank",
    "Instructions: answer every question.",
    "",
    "1. Which chemical element has the symbol 'O'?",
    "   A. Gold",
    "   * B. Oxygen",
    "   C. Osmium",
    "",
    "2. Photosynthesis produces glucose and oxygen.",
    "   Answer: True",
    "",
    "3. The powerhouse of the cell is the ____.",
    "   Accepted answers: mitochondria, mitochondrion",
    "",
    "4. What is the primary gas found in Earth's atmosphere?",
    "   Accepted answers: Nitrogen, N2",
    "",
    "5. Match the inventor to their invention.",
    "   Bell = Telephone",
    "   Edison = Light bulb",
    "",
    "6. Describe the impact of the Industrial Revolution on urban development.",
  ];

  test("each question is the type it is, and only the essay is left to check", () => {
    for (const result of both(BANK)) {
      assert.deepEqual(
        result.questions.map((q) => q.type),
        ["multipleChoice", "trueFalse", "fillInBlank", "shortAnswer", "matching", "essay"],
      );
      assert.deepEqual(
        result.questions.map(verdict),
        ["parsed", "parsed", "parsed", "parsed", "parsed", "needsReview"],
        "an essay with no answer is a guess between essay and short answer, and says so",
      );
      assert.deepEqual(blanksOf(at(result, 2)), ["mitochondria", "mitochondrion"]);
      assert.deepEqual(body(at(result, 3))["accepted"], ["Nitrogen", "N2"]);
      assert.deepEqual(pairsOf(at(result, 4)), ["Bell = Telephone", "Edison = Light bulb"]);
      assert.equal(result.orphans.length, 2, "only the title and the instructions are not questions");
    }
  });
});
