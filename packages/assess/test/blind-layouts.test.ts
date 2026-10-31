/**
 * Three banks from authors the rules had not been written for, given to the importer
 * before any rule was changed: a nursing test bank in a publisher's layout, a second chapter
 * of an instructor's bank, and a 2002 exam that has no answer key at all. The first scored
 * nothing, the second a little over half, and the third was right to refuse every key. What
 * they needed is here as rules, each tried on small invented examples, with what makes it a
 * rule and what keeps it from reading something it should not:
 *
 *   - options that run together on one line ("B. Mars C. Vega"), the first option at the end
 *     of the question's text, and an answer at the end of a line ("D. Mercury ANS: C");
 *   - a number that goes back to 1 in the middle of a sentence that a line wrap broke;
 *   - a KEY line of fields separated by bars, which Word may have broken across paragraphs;
 *   - the explanation under an Answer line, which has no label;
 *   - a bracketed note alone on a line: "(Difficulty 3)";
 *   - a matching exercise written as numbered terms with their definitions and foils.
 *
 * The real files are measured through the harness (fixtures/publisher, kept on the machine).
 * These tests have none of their words.
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
const text = (lines: string[], extra: Record<string, unknown> = {}): ImportResult =>
  standardTextImporter.parse(lines.join("\n"), { ...OPTIONS, ...extra });
const inWord = (lines: string[], extra: Record<string, unknown> = {}): ImportResult =>
  wordImporter.parseBytes(docx({ body: lines.map((l) => paragraph(l === "" ? "" : run(l))).join("") }), { ...OPTIONS, file: "t.docx", ...extra });

const body = (q: Question): Record<string, any> => q.body as Record<string, any>;
const plain = (rich: Parameters<typeof richTextToPlain>[0]): string => richTextToPlain(rich).replace(/\s+/g, " ").trim();
const stemOf = (q: Question): string => plain(q.stem);
const wordsOf = (q: Question): string[] => (body(q)["options"] as Array<{ content: Parameters<typeof plain>[0] }>).map((o) => plain(o.content));
const rightOf = (q: Question): string[] =>
  (body(q)["options"] as Array<{ content: Parameters<typeof plain>[0]; correct?: boolean }>).filter((o) => o.correct).map((o) => plain(o.content));
const has = (q: Question, code: string): boolean => q.findings.some((f) => f.code === code);
const fileHas = (result: ImportResult, code: string) => result.fileFindings.find((f) => f.code === code);
const verdict = (q: Question): string => verdictFrom(q.findings);
const meta = (q: Question): Record<string, any> => q.metadata as unknown as Record<string, any>;
const first = (result: ImportResult): Question => result.questions[0] as Question;

// ---------------------------------------------------------------------------
// Options that run together
// ---------------------------------------------------------------------------

describe("options that share a line", () => {
  test("the first option at the end of the question, and the rest on lines of their own", () => {
    for (const result of [
      text(["1. Which is a planet? A. Sirius", "B. Mars", "C. Vega", "D. Rigel", "ANS: B"]),
      inWord(["1. Which is a planet? A. Sirius", "B. Mars", "C. Vega", "D. Rigel", "ANS: B"]),
    ]) {
      const q = first(result);
      assert.equal(stemOf(q), "Which is a planet?");
      assert.deepEqual(wordsOf(q), ["Sirius", "Mars", "Vega", "Rigel"]);
      assert.deepEqual(rightOf(q), ["Mars"]);
      assert.equal(verdict(q), "parsed", "the split is reported once for the file, and does not flag the question");
      assert.ok(fileHas(result, FindingCode.OptionsSplitFromLine), "and the file says it was done");
      assert.equal(result.orphans.length, 0);
    }
  });

  test("two options on one line, and more than two", () => {
    const two = text(["1. Which is a planet?", "A. Sirius", "B. Mars C. Vega", "D. Rigel", "ANS: C"]);
    const q = first(two);
    assert.deepEqual(wordsOf(q), ["Sirius", "Mars", "Vega", "Rigel"]);
    assert.deepEqual(rightOf(q), ["Vega"]);
    assert.ok(fileHas(two, FindingCode.OptionsSplitFromLine), "and the file says it was done, for a line of options as for a stem");
    const all = first(text(["1. Which is a planet?", "A. Sirius B. Mars C. Vega D. Rigel", "ANS: D"]));
    assert.deepEqual(wordsOf(all), ["Sirius", "Mars", "Vega", "Rigel"]);
    assert.deepEqual(rightOf(all), ["Rigel"]);
  });

  test("a line of options carries on in the lines under it, which belong to the last one", () => {
    const q = first(text(["1. Which is a planet?", "A. Sirius B. Mars", "and its moons", "C. Vega", "ANS: B"]));
    assert.deepEqual(wordsOf(q), ["Sirius", "Mars and its moons", "Vega"]);
  });

  test("the letters have to come in order, from A, or the line is left as it was", () => {
    // B is not the letter after A here, and D skips C.
    assert.deepEqual(wordsOf(first(text(["1. Which?", "A. Sirius C. Mars", "B. Vega", "ANS: B"]))), ["Sirius C. Mars", "Vega"]);
    assert.deepEqual(wordsOf(first(text(["1. Which?", "A. Sirius", "B. Mars D. Vega", "ANS: B"]))), ["Sirius", "Mars D. Vega"]);
    // A letter that is not the next one is part of the words, and the one that is still splits.
    assert.deepEqual(wordsOf(first(text(["1. Which?", "A. Sirius", "B. Mars A. Vega C. Rigel", "ANS: B"]))), ["Sirius", "Mars A. Vega", "Rigel"]);
  });

  test("a letter with no space before it is not an option", () => {
    assert.deepEqual(wordsOf(first(text(["1. Which?", "A. Sirius.B. Mars", "C. Vega", "ANS: C"]))), ["Sirius.B. Mars", "Vega"]);
  });

  test("a lower case letter, or lower case words after the letter, are not options", () => {
    assert.deepEqual(wordsOf(first(text(["1. Which?", "A. Sirius", "B. an infection with C. difficile", "ANS: B"]))), ["Sirius", "an infection with C. difficile"]);
    assert.deepEqual(wordsOf(first(text(["1. Which?", "A. Sirius, or b. Vega", "B. Mars", "ANS: B"]))), ["Sirius, or b. Vega", "Mars"]);
  });

  test("a stem that ends in a letter and a full stop is not given an option", () => {
    const q = first(text(["1. Which food is rich in vitamin A. Mars", "a. Sirius", "b. Vega", "ANS: b"]));
    assert.equal(stemOf(q), "Which food is rich in vitamin A. Mars");
    assert.deepEqual(wordsOf(q), ["Sirius", "Vega"]);
    // One A with no B on the same line or under it.
    const alone = first(text(["1. Explain the role of vitamin A. Include its sources."]));
    assert.equal(stemOf(alone), "Explain the role of vitamin A. Include its sources.");
    assert.equal(body(alone)["options"], undefined);
  });

  test("a line that is nothing but options has no question to give them to", () => {
    const q = first(text(["1. A. Sirius B. Mars"]));
    assert.equal(stemOf(q), "A. Sirius B. Mars");
    assert.equal(body(q)["options"], undefined);
  });

  test("the formatting of a line with several options says nothing about one of them", () => {
    // Bold marks the right option in four questions. In the fifth, two options share a line that
    // is bold from end to end, which would make both look marked if the line were read for each.
    const marked = (n: number, right: string): string =>
      paragraph(run(`${n}. Which is a planet?`)) +
      ["Sirius", "Mars", "Vega", "Rigel"].map((w, i) => paragraph(run(`${"ABCD"[i]}. `) + run(w, w === right ? "<w:b/>" : ""))).join("");
    const shared =
      paragraph(run("5. Which is a planet?")) + paragraph(run("A. Sirius")) + paragraph(run("B. Mars C. Vega", "<w:b/>")) + paragraph(run("D. Rigel"));
    const result = wordImporter.parseBytes(docx({ body: marked(1, "Mars") + marked(2, "Vega") + marked(3, "Rigel") + marked(4, "Sirius") + shared }), { ...OPTIONS, file: "t.docx" });
    assert.equal(result.questions.length, 5);
    const last = result.questions[4] as Question;
    assert.deepEqual(wordsOf(last), ["Sirius", "Mars", "Vega", "Rigel"]);
    assert.deepEqual(rightOf(last), [], "no key was taken from the bold of a line that holds two options");
    assert.equal(verdict(last), "failed");
    for (const q of result.questions.slice(0, 4)) assert.equal(rightOf(q).length, 1);
  });

  test("nor does the formatting of a stem line that has the first options on it", () => {
    const marked = (n: number, right: string): string =>
      paragraph(run(`${n}. Which is a planet?`)) +
      ["Sirius", "Mars", "Vega", "Rigel"].map((w, i) => paragraph(run(`${"ABCD"[i]}. `) + run(w, w === right ? "<w:b/>" : ""))).join("");
    const onStem = paragraph(run("5. Which is a planet? A. Sirius B. Mars", "<w:b/>")) + paragraph(run("C. Vega")) + paragraph(run("D. Rigel"));
    const result = wordImporter.parseBytes(docx({ body: marked(1, "Mars") + marked(2, "Vega") + marked(3, "Rigel") + marked(4, "Sirius") + onStem }), { ...OPTIONS, file: "t.docx" });
    const last = result.questions[4] as Question;
    assert.deepEqual(wordsOf(last), ["Sirius", "Mars", "Vega", "Rigel"]);
    assert.deepEqual(rightOf(last), [], "no key was taken from a line that is bold because its question is");
  });
});

describe("an answer at the end of a line", () => {
  test("is the key, and closes the question, so the line under it is not more of the option", () => {
    const result = text(["1. Which is a planet?", "A. Sirius", "B. Mars", "C. Vega", "D. Rigel ANS: B", "Mars is the fourth planet from the sun."]);
    const q = first(result);
    assert.deepEqual(wordsOf(q), ["Sirius", "Mars", "Vega", "Rigel"]);
    assert.deepEqual(rightOf(q), ["Mars"]);
    assert.deepEqual(result.orphans.map((o) => o.text), ["Mars is the fourth planet from the sun."], "the sentence is stray text unless the file does this in most questions");
    assert.ok(fileHas(result, FindingCode.AnswerEndsLine));
  });

  test("closes the question wherever it stands, so the line under it is never more of the words", () => {
    // At the end of a question's first line, with its options.
    const onFirst = text(["1. Which is a planet? A. Sirius B. Mars ANS: B", "Mars is a planet."]);
    assert.deepEqual(wordsOf(first(onFirst)), ["Sirius", "Mars"]);
    assert.deepEqual(onFirst.orphans.map((o) => o.text), ["Mars is a planet."]);
    // At the end of the first line of a true or false statement.
    const tf = text(["True/False", "1. Mars is a planet. ANS: T", "It is the fourth planet."]);
    assert.equal(stemOf(first(tf)), "Mars is a planet.");
    assert.deepEqual(tf.orphans.map((o) => o.text), ["It is the fourth planet."]);
    // At the end of a second line of a statement.
    const second = text(["True/False", "1. Mars is", "a planet. ANS: T", "It is the fourth planet."]);
    assert.equal(stemOf(first(second)), "Mars is a planet.");
    assert.deepEqual(second.orphans.map((o) => o.text), ["It is the fourth planet."]);
    // At the end of a line that goes on with an option.
    const onOption = text(["1. Which is a planet?", "A. Sirius", "B. Mars", "and its moons ANS: B", "stray words"]);
    assert.deepEqual(wordsOf(first(onOption)), ["Sirius", "Mars and its moons"]);
    assert.deepEqual(onOption.orphans.map((o) => o.text), ["stray words"]);
  });

  test("on the end of the options of several, in a line that has them all", () => {
    const q = first(text(["1. Which is a planet?", "A. Sirius B. Mars C. Vega D. Rigel ANS: C"]));
    assert.deepEqual(wordsOf(q), ["Sirius", "Mars", "Vega", "Rigel"]);
    assert.deepEqual(rightOf(q), ["Vega"]);
  });

  test("with a list of letters, for a question with more than one right option", () => {
    const q = first(text(["Multiple Response", "1. Which are planets?", "A. Sirius", "B. Mars", "C. Vega", "D. Venus ANS: B, D"]));
    assert.equal(q.type, "multipleResponse");
    assert.deepEqual(rightOf(q), ["Mars", "Venus"]);
  });

  test("after the words of a true or false statement", () => {
    const result = text(["True/False", "1. Mars is a planet. ANS: T", "2. The sun is a planet. ANS: F"]);
    assert.deepEqual(result.questions.map((q) => body(q)["correct"]), [true, false]);
    assert.deepEqual(result.questions.map((q) => stemOf(q)), ["Mars is a planet.", "The sun is a planet."]);
  });

  test("only in the spellings of the label that publishers use, and only when a key follows", () => {
    // "answer:" in lower case in the middle of a sentence, and a label with words after it.
    assert.deepEqual(wordsOf(first(text(["1. Which?", "A. Sirius", "B. Write the answer: Mars", "ANS: B"]))), ["Sirius", "Write the answer: Mars"]);
    assert.deepEqual(wordsOf(first(text(["1. Which?", "A. Sirius", "B. Mars ANS: they said so", "ANS: B"]))), ["Sirius", "Mars ANS: they said so"]);
    // A label in lower case is not one even when a key follows it, and a label glued to a word is not one.
    assert.deepEqual(wordsOf(first(text(["1. Which?", "A. Sirius", "B. Choose the answer: a", "ANS: B"]))), ["Sirius", "Choose the answer: a"]);
    assert.deepEqual(wordsOf(first(text(["1. Which?", "A. Sirius", "B. MarsANS: b", "ANS: B"]))), ["Sirius", "MarsANS: b"]);
  });
});

// ---------------------------------------------------------------------------
// A number out of sequence
// ---------------------------------------------------------------------------

describe("a number that goes back to the start in the middle of a stem", () => {
  const wrapped = ["13. A client was given the outcome: list five strengths by the end of day", "1. Which diagnosis most likely led to it?", "A. Low self-esteem", "B. Self-care deficit", "ANS: A"];

  test("is the rest of the sentence that a line wrap broke, and the question is flagged", () => {
    for (const result of [text(wrapped), inWord(wrapped)]) {
      assert.equal(result.questions.length, 1);
      const q = first(result);
      assert.equal(stemOf(q), "A client was given the outcome: list five strengths by the end of day 1. Which diagnosis most likely led to it?");
      assert.deepEqual(rightOf(q), ["Low self-esteem"]);
      assert.ok(has(q, FindingCode.NumberOutOfSequence));
      assert.equal(verdict(q), "needsReview", "the importer guessed where the question ends, so it says so");
    }
  });

  test("a steps list inside a stem is not a run of questions", () => {
    const q = first(text(["5) Put these steps in order:", "1. wash", "2. dry", "Which comes first?", "a. wash", "b. dry", "ANS: a"]));
    assert.equal(stemOf(q), "Put these steps in order: 1. wash 2. dry Which comes first?");
    assert.deepEqual(wordsOf(q), ["wash", "dry"]);
  });

  test("a number that goes on from the last is a question, and so is one after a blank line or after options", () => {
    assert.equal(text(["1. Explain A.", "2. Explain B."]).questions.length, 2);
    assert.equal(text(["3. Explain A.", "", "1. Explain B."]).questions.length, 2);
    assert.equal(text(["3. Which?", "a. x", "b. y", "1. Explain B."]).questions.length, 2);
    // A gap upward is not a restart.
    assert.equal(text(["3. Explain A.", "5. Explain B."]).questions.length, 2);
  });

  test("a number given again right under a question that has no options is joined, and flagged for review", () => {
    const result = text(["4. Explain A.", "4. Explain B."]);
    assert.equal(result.questions.length, 1);
    assert.equal(verdict(first(result)), "needsReview");
  });
});

// ---------------------------------------------------------------------------
// A KEY line
// ---------------------------------------------------------------------------

describe("a KEY line of fields separated by bars", () => {
  const withKey = (...key: string[]): string[] => ["1. Which is a planet?", "A. Sirius", "B. Mars", "ANS: B", ...key];

  test("is read as the fields it holds, the Bloom level among them, and does not flag the question", () => {
    const q = first(text(withKey("KEY: Cognitive Level: Application | Client Need: Safe Care | Integrated Processes: Assessment")));
    assert.equal(meta(q)["bloom"], "apply");
    assert.deepEqual(meta(q)["custom"], { "Client Need": "Safe Care", "Integrated Processes": "Assessment" });
    assert.equal(verdict(q), "parsed");
    assert.ok(has(q, FindingCode.MetadataKeptAsNote), "the fields no question has a place for are said to be kept");
  });

  test("goes on into the line under it when Word broke it across paragraphs", () => {
    for (const result of [
      text(withKey("KEY: Cognitive Level: Analysis | Client", "Need: Safe Care")),
      inWord(withKey("KEY: Cognitive Level: Analysis | Client", "Need: Safe Care")),
    ]) {
      const q = first(result);
      assert.equal(meta(q)["bloom"], "analyze");
      assert.deepEqual(meta(q)["custom"], { "Client Need": "Safe Care" });
      assert.equal(result.orphans.length, 0);
      assert.ok(fileHas(result, FindingCode.MetadataLineContinued));
    }
  });

  test("is a KEY line and no other label: another label with the same shape of value is read as before", () => {
    const q = first(text(withKey("Topic: Cell: x | Organelle: y")));
    assert.deepEqual(meta(q)["tags"], ["Cell: x | Organelle: y"]);
    assert.equal(meta(q)["custom"], undefined);
  });

  test("is a list of at least two fields: one field is a label this profile does not know", () => {
    const q = first(text(withKey("KEY: Cognitive Level: Application")));
    assert.deepEqual(meta(q)["custom"], { KEY: "Cognitive Level: Application" });
    assert.equal(meta(q)["bloom"], undefined);
    assert.equal(verdict(q), "needsReview");
  });

  test("keeps the fields it has no place for and says where they came from", () => {
    const q = first(text(withKey("KEY: Cognitive Level: Application | Client Need: Safe Care")));
    const said = q.findings.find((f) => f.code === FindingCode.MetadataKeptAsNote);
    assert.match(said?.message ?? "", /fields of a KEY line/);
  });

  test("goes on over more than one line", () => {
    const q = first(text(withKey("KEY: Cognitive Level: Analysis | Client", "Need:", "Safe Care")));
    assert.deepEqual(meta(q)["custom"], { "Client Need": "Safe Care" });
  });

  test("goes on only directly under it, with no blank line between", () => {
    const result = text(withKey("KEY: Cognitive Level: Analysis | Client", "", "Need: Safe Care"));
    assert.deepEqual(result.orphans.map((o) => o.text), ["Need: Safe Care"]);
  });

  test("is the only label a line under it can go on for: stray text under any other is still stray", () => {
    const result = text(withKey("DIF: Easy", "stray words"));
    assert.deepEqual(result.orphans.map((o) => o.text), ["stray words"]);
    assert.deepEqual(text(withKey("KEY: photosynthesis", "stray words")).orphans.map((o) => o.text), ["stray words"]);
  });

  test("that is not a list of fields stays one label this profile does not know, and says so", () => {
    const q = first(text(withKey("KEY: photosynthesis")));
    assert.deepEqual(meta(q)["custom"], { KEY: "photosynthesis" });
    assert.equal(verdict(q), "needsReview");
    // One that has a field with no label of its own is not a list of fields either.
    assert.deepEqual(meta(first(text(withKey("KEY: Application | Client Need: Safe Care"))))["custom"], { KEY: "Application | Client Need: Safe Care" });
  });
});

// ---------------------------------------------------------------------------
// The explanation under an Answer line
// ---------------------------------------------------------------------------

describe("the paragraph under an Answer line", () => {
  const bank = (n: number, explained: boolean[]): string[] =>
    Array.from({ length: n }, (_, i) => [`${i + 1}. Which is a planet?`, "A. Sirius", "B. Mars", "ANS: B", ...(explained[i] ? [`Mars is a planet, number ${i + 1}.`] : [])]).flat();

  test("is the explanation of the answer when the file gives one in most of its questions, kept as a note", () => {
    for (const result of [text(bank(4, [true, true, true, true])), inWord(bank(4, [true, true, true, true]))]) {
      assert.equal(result.orphans.length, 0);
      for (const [i, q] of result.questions.entries()) {
        assert.deepEqual(meta(q)["custom"], { Rationale: `Mars is a planet, number ${i + 1}.` });
        assert.equal(verdict(q), "parsed");
        assert.equal((q as { feedback?: { general?: unknown } }).feedback?.general, undefined, "and it is not feedback, which a student is shown");
      }
      assert.equal(fileHas(result, FindingCode.RationaleRead)?.severity, "info");
    }
  });

  test("of two paragraphs is kept whole", () => {
    const lines = ["1. Which?", "A. x", "B. y", "ANS: B", "First part.", "Second part."];
    const many = [...lines, ...bank(3, [true, true, true]).map((l) => l.replace(/^(\d+)\./, (_, n) => `${Number(n) + 1}.`))];
    assert.equal(meta(first(text(many)))["custom"]["Rationale"], "First part. Second part.");
  });

  test("is stray text when only one question in a file has one, as it always was", () => {
    const result = text(bank(4, [false, true, false, false]));
    assert.equal(result.orphans.length, 1);
    assert.match(result.orphans[0]?.reason ?? "", /only 1 of 4/);
    assert.equal(meta(result.questions[1] as Question)["custom"], undefined);
  });

  test("is not given a question's rationale when a blank line comes between", () => {
    // Five questions in six give it, and that is enough; the sixth has a blank line first.
    const lines = bank(6, [true, true, true, true, true, true]);
    lines.splice(lines.indexOf("Mars is a planet, number 6."), 0, "");
    const result = text(lines);
    assert.deepEqual(result.orphans.map((o) => o.text), ["Mars is a planet, number 6."]);
    assert.equal(result.questions.filter((q) => meta(q)["custom"] !== undefined).length, 5);
  });

  test("is only what comes right under the Answer line, not text after another line", () => {
    const lines = bank(6, [true, true, true, true, true, true]);
    lines.splice(lines.indexOf("Mars is a planet, number 6."), 1, "(Page 3)", "stray words");
    const result = text(lines);
    assert.deepEqual(result.orphans.map((o) => o.text), ["stray words"]);
    assert.equal(meta(result.questions[5] as Question)["custom"], undefined);
  });

  test("is stray text when the file has it in too small a share of its questions, however many", () => {
    // Three questions in five: at least three, but not 80 percent.
    const result = text(bank(5, [true, true, true, false, false]));
    assert.equal(result.orphans.length, 3);
    assert.ok(result.questions.every((q) => meta(q)["custom"] === undefined));
  });

  test("never gives an answer: it is read only for questions that already have their key", () => {
    // The explanation names option A, and the key says B.
    const lines = ["1. Which?", "A. x", "B. y", "ANS: B", "A is wrong because it is not a planet."];
    const q = first(text([...lines, ...bank(3, [true, true, true]).map((l) => l.replace(/^(\d+)\./, (_, n) => `${Number(n) + 1}.`))]));
    assert.deepEqual(rightOf(q), ["y"]);
  });
});

// ---------------------------------------------------------------------------
// A bracketed note, alone on a line
// ---------------------------------------------------------------------------

describe("a note in brackets alone on a line", () => {
  const withNote = (note: string): string[] => ["1. Which is a planet?", "A. Sirius", "B. Mars", "ANS: B", note];

  test("with a label this profile knows is that field of the question", () => {
    assert.equal(meta(first(text(withNote("(Difficulty 3)"))))["difficulty"], "hard");
    assert.equal(meta(first(text(withNote("(Difficulty: easy)"))))["difficulty"], "easy");
    assert.equal(meta(first(text(withNote("(Chapter 4)"))))["chapter"], "4");
    const result = inWord(withNote("(Difficulty 2)"));
    assert.equal(meta(first(result))["difficulty"], "medium");
    assert.equal(result.orphans.length, 0);
    assert.equal(verdict(first(result)), "parsed");
  });

  test("with a label it does not know is stray text, so words in brackets are not read as metadata", () => {
    for (const note of ["(Note to self)", "(Colour red)", "(Difficulty)"]) {
      assert.deepEqual(text(withNote(note)).orphans.map((o) => o.text), [note], note);
    }
  });

  test("is under a question that is not a choice question too", () => {
    const result = text(["Short Answer", "1) Explain the water cycle.", "(Page 4)", "(Difficulty 2)", "2) Explain the carbon cycle.", "(Difficulty 3)"]);
    assert.equal(result.orphans.length, 0);
    assert.deepEqual(result.questions.map((q) => meta(q)["difficulty"]), ["medium", "hard"]);
  });
});

// ---------------------------------------------------------------------------
// Terms, definitions and foils
// ---------------------------------------------------------------------------

describe("a matching exercise written as numbered terms, definitions and foils", () => {
  const item = (n: number, term: string, definition: string, foil?: string): string[] => [`${n}) Term: ${term}`, `Definition: ${definition}`, ...(foil ? [`Foil: ${foil}`] : []), `(Page ${n + 10})`];
  const section = [...item(1, "Star", "A sun that burns.", "Comet"), ...item(2, "Planet", "A world that orbits a star.", "Asteroid"), ...item(3, "Moon", "A world that orbits a planet.", "Nebula")];

  test("is one exercise, under its heading, flagged because the heading stands for the instruction", () => {
    for (const result of [text(["Matching", ...section]), inWord(["Matching", ...section])]) {
      assert.equal(result.questions.length, 1);
      const q = first(result);
      assert.equal(q.type, "matching");
      assert.equal(stemOf(q), "Matching");
      assert.deepEqual((body(q)["pairs"] as Array<{ left: Parameters<typeof plain>[0]; right: string }>).map((p) => `${plain(p.left)} = ${p.right}`), [
        "Star = A sun that burns.",
        "Planet = A world that orbits a star.",
        "Moon = A world that orbits a planet.",
      ]);
      assert.deepEqual(body(q)["distractors"], ["Comet", "Asteroid", "Nebula"], "the foils are the wrong answers");
      assert.equal(q.findings.find((f) => f.code === FindingCode.StemFromHeading)?.severity, "warn");
      assert.equal(verdict(q), "needsReview");
      assert.equal(meta(q)["page"], "11; 12; 13", "every item's page is kept");
      assert.equal(result.orphans.length, 0);
    }
  });

  test("needs no foil lines", () => {
    const q = first(text(["Matching", ...item(1, "Star", "A sun that burns."), ...item(2, "Planet", "A world that orbits a star.")]));
    assert.equal(q.type, "matching");
    assert.deepEqual(body(q)["distractors"], []);
    assert.equal((body(q)["pairs"] as unknown[]).length, 2);
  });

  test("with one item is not an exercise, and fails rather than guess", () => {
    const q = first(text(["Matching", ...item(1, "Star", "A sun that burns.", "Comet")]));
    assert.equal(verdict(q), "failed");
  });

  test("is one exercise for each heading", () => {
    const result = text(["Matching", ...section, "Short Answer", "1) Explain the water cycle.", "Matching", ...item(1, "Cell", "The unit of life."), ...item(2, "Atom", "The unit of matter.")]);
    assert.deepEqual(result.questions.map((q) => q.type), ["matching", "essay", "matching"]);
    assert.equal((body(result.questions[0] as Question)["pairs"] as unknown[]).length, 3);
    assert.equal((body(result.questions[2] as Question)["pairs"] as unknown[]).length, 2);
  });

  test("is one exercise for each heading even when one follows the other", () => {
    const result = text(["Matching", ...item(1, "Star", "A sun that burns."), ...item(2, "Planet", "A world that orbits a star."), "Matching", ...item(1, "Cell", "The unit of life."), ...item(2, "Atom", "The unit of matter.")]);
    assert.equal(result.questions.length, 2);
    assert.equal((body(result.questions[1] as Question)["pairs"] as unknown[]).length, 2);
  });

  test("is only that when a Definition line comes under the Term, and only under a matching heading or none", () => {
    // No Definition: a question that happens to begin with the word.
    const stray = text(["1) Term: the word for a star that burns", "a. Sun", "b. Moon", "ANS: a"]);
    assert.equal(stray.questions.length, 1);
    assert.equal(stray.questions[0]?.type, "multipleChoice");
    // Under a multiple choice heading, a Term line is not the start of a matching exercise.
    const other = text(["Multiple Choice", "1) Term: a star", "Definition: a sun", "a. x", "b. y", "ANS: a"]);
    assert.equal(other.questions[0]?.type, "multipleChoice");
  });
});

// ---------------------------------------------------------------------------
// The layout as a whole
// ---------------------------------------------------------------------------

describe("a bank in a publisher's layout, in a Word file", () => {
  const bank = [
    "Multiple Choice",
    "1. Which is a planet? A. Sirius",
    "B. Mars",
    "C. Vega",
    "D. Rigel",
    "ANS: B",
    "Mars is the fourth planet from the sun.",
    "KEY: Cognitive Level: Comprehension | Client Need: Safe",
    "Care",
    "2. A bright thing in the sky is called a star or a planet. A. A star",
    "B. A planet C. A moon",
    "D. A comet ANS: A",
    "Stars make their own light.",
    "KEY: Cognitive Level: Analysis | Client Need: Safe Care",
    "Multiple Response",
    "3. Which are stars? A. Sirius B. Mars",
    "C. Vega D. Venus ANS: A, C",
    "Sirius and Vega are stars; Mars and Venus are planets.",
    "KEY: Cognitive Level: Application | Client Need: Safe Care",
  ];

  test("reads every question with its key, its explanation and its fields, and leaves nothing over", () => {
    const result = inWord(bank);
    assert.equal(result.questions.length, 3);
    assert.equal(result.orphans.length, 0);
    const [one, two, three] = result.questions as [Question, Question, Question];
    assert.deepEqual(wordsOf(one), ["Sirius", "Mars", "Vega", "Rigel"]);
    assert.deepEqual(rightOf(one), ["Mars"]);
    assert.equal(meta(one)["bloom"], "understand");
    assert.deepEqual(meta(one)["custom"], { "Client Need": "Safe Care", Rationale: "Mars is the fourth planet from the sun." });
    assert.equal(stemOf(two), "A bright thing in the sky is called a star or a planet.");
    assert.deepEqual(wordsOf(two), ["A star", "A planet", "A moon", "A comet"]);
    assert.deepEqual(rightOf(two), ["A star"]);
    assert.equal(three.type, "multipleResponse");
    assert.deepEqual(wordsOf(three), ["Sirius", "Mars", "Vega", "Venus"]);
    assert.deepEqual(rightOf(three), ["Sirius", "Vega"]);
    for (const q of result.questions) assert.equal(verdict(q), "parsed");
  });
});
