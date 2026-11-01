/**
 * An Answer line that says more than a letter. Publisher banks write "Answer: c. Gravity. Gravity holds a planet in its orbit
 * ..." (the letter, the option's own words, a reason), and the first reading of such a line took every single-letter
 * word in it for an option letter, so the article "a" in the reason marked option A. A wrong answer that looks authored is the
 * one thing this importer must not make, so these tests pin down what a long line may and may not do: it is believed only where
 * its letter and its words name the same option; where they name different ones it is an error with both quoted; and prose is
 * never mined for letters. The text is invented.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { standardTextImporter } from "../src/import/standard-text.ts";
import { FindingCode, liveFindings, verdictFrom } from "../src/model/findings.ts";
import { richTextToPlain } from "../src/model/richtext.ts";
import type { Question } from "../src/model/question.ts";

const OPTIONS = { file: "t.txt", at: "2026-01-01T00:00:00.000Z", author: "test" };
const FRUIT = ["1. Which of these is a fruit?", "a. Chair", "b. Apple", "c. Desk"];
const read = (lines: string[]): Question[] => standardTextImporter.parse(lines.join("\n"), OPTIONS).questions;
const one = (lines: string[]): Question => read(lines)[0] as Question;
const key = (q: Question): string => ((q.body as unknown as { options: Array<{ correct: boolean }> }).options ?? []).map((o) => (o.correct ? "X" : ".")).join("");
const has = (q: Question, code: string): boolean => liveFindings(q.findings).some((f) => f.code === code);
const verdict = (q: Question): string => verdictFrom(q.findings);

describe("an Answer line with words after the letter", () => {
  test("is a key when the letter and the words name the same option", () => {
    const q = one([...FRUIT, "Answer: b. Apple"]);
    assert.equal(key(q), ".X.");
    assert.equal(verdict(q), "parsed");
  });

  test("is a key with a reason after the option's words, and a reference in brackets", () => {
    const q = one([...FRUIT, "Answer: b. Apple. Apples grow on trees. (Textbook reference: Section 2)"]);
    assert.equal(key(q), ".X.");
    assert.equal(verdict(q), "parsed");
  });

  test("is a key when its words are the start of the option, for a short line over a long option", () => {
    const q = one(["1. Who is it?", "a. Males only", "b. Both females and males", "c. Neither", "Answer: b. Both females"]);
    assert.equal(key(q), ".X.");
  });

  test("is a key when the option has more words than the answer line gives, in different case and with different quotes", () => {
    const q = one(["1. Which?", "a. The “Big” one", "b. other", "Answer: A. the big one"]);
    assert.equal(key(q), "X.");
  });

  test("is no key when the letter and the words name different options, and the error quotes both", () => {
    const q = one([...FRUIT, "Answer: a. Apple"]);
    assert.equal(key(q), "...");
    assert.ok(has(q, FindingCode.KeysDisagree));
    const message = liveFindings(q.findings).find((f) => f.code === FindingCode.KeysDisagree)?.message ?? "";
    assert.match(message, /"Apple" after the letter A/);
    assert.match(message, /option A reads "Chair"/);
    assert.equal(verdict(q), "failed");
  });

  test("is no key when the letter is right and one word of the option is spelled another way: that is for a person to say", () => {
    const q = one(["1. Which warning?", "a. Written", "b. Spoken warning", "Answer: b. Speaking warning."]);
    assert.equal(key(q), "..");
    assert.ok(has(q, FindingCode.KeysDisagree));
  });

  test("with prose in it is not mined for letters: the article a is not option A", () => {
    const q = one(["1. What holds the planets in orbit?", "a. Magic", "b. Gravity", "c. Luck", "Answer: c. Gravity holds a planet in its orbit."]);
    assert.equal(key(q), "...", "the letter c names Luck, whose words are not those; the word a names nothing");
    assert.equal(verdict(q), "failed");
  });

  test("of prose alone, with no letter, makes no key, and says it was not used", () => {
    const q = one([...FRUIT, "Answer: It is a thing that a tree grows."]);
    assert.equal(key(q), "...");
    assert.ok(has(q, FindingCode.KeyTextNotUsed));
    assert.equal(verdict(q), "failed");
  });

  test("of the words of exactly one option, with no letter, is a key", () => {
    const q = one([...FRUIT, "Answer: Apple"]);
    assert.equal(key(q), ".X.");
  });

  test("of words that two options share is not a key", () => {
    const q = one(["1. Which?", "a. Same", "b. Same", "c. Other", "Answer: Same"]);
    assert.equal(key(q), "...");
  });

  test("a letter and its stop, alone, is the letter", () => {
    assert.equal(key(one([...FRUIT, "Answer: b."])), ".X.");
    assert.equal(key(one([...FRUIT, "Answer: (b)"])), ".X.");
  });

  test("for a true or false question, the letter and True, or the word and its reason", () => {
    const tf = ["1. The Sun is a star.", "a. True", "b. False"];
    const said = (line: string): unknown => {
      const q = one([...tf, line]);
      return q.type === "trueFalse" ? (q.body as unknown as { correct?: boolean }).correct : key(q);
    };
    assert.equal(said("Answer: a. True. The Sun is a star."), true);
    assert.equal(said("Answer: False. It is a star."), false);
    // The letter says the first option and the word says the second: neither is chosen.
    assert.equal(said("Answer: b. True."), undefined);
  });

  test("is still the letters when that is all it says: B, D and B, Z are read as they were", () => {
    assert.equal(key(one(["1. Pick.", "a. one", "b. two", "c. three", "d. four", "Answer: B, D"])), ".X.X");
    // B is applied and Z, which names nothing, is said: this is what the line has always done.
    const q = one([...FRUIT, "Answer: B, Z"]);
    assert.equal(key(q), ".X.");
    assert.ok(has(q, FindingCode.KeyTextNotUsed));
  });

  test("with a letter no option has, and words, is not read", () => {
    const q = one([...FRUIT, "Answer: f. Apple"]);
    assert.equal(key(q), "...");
  });

  test("never makes the question look parsed when it applied nothing", () => {
    for (const line of ["Answer: a. Apple", "Answer: nothing at all", "Answer: c. Chair"]) {
      assert.notEqual(verdict(one([...FRUIT, line])), "parsed", line);
    }
  });
});

describe("a question number and a heading, as the PDFs have them", () => {
  test("a number with a doubled full stop is the number", () => {
    const qs = read(["1. First?", "*a. yes", "b. no", "", "2.. Second?", "a. yes", "*b. no"]);
    assert.equal(qs.length, 2);
    assert.equal(richTextToPlain(qs[1]?.stem as never), "Second?");
  });

  test("True and False is a heading that gives a type, as True or False is", () => {
    // A statement with options of True and False is a true or false question without any heading. What the heading changes is that
    // it is a heading: a line that sets the section apart, and not a line of text that no question claimed.
    const lines = ["1. First?", "*a. yes", "b. no", "", "True and False", "", "2. The Sun is a star.", "*a. True", "b. False"];
    const result = standardTextImporter.parse(lines.join("\n"), OPTIONS);
    assert.equal(result.questions.length, 2);
    assert.deepEqual(result.orphans.map((o) => o.text), [], "the heading is not text that was left over");
    assert.equal(result.questions[1]?.type, "trueFalse");
  });
});
