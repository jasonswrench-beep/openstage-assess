/**
 * Answer keys that are not marked with an asterisk: an "Answer:" line beside the
 * question, and formatting in a Word file (bold, underline, highlight, colour).
 *
 * Formatting is the nearest this importer comes to guessing a key, so most of this
 * is about when it must not: too few questions, too little agreement, two marks
 * that disagree, a key in words that says otherwise, and a question that does not
 * follow the file's habit.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { scoreFile, type ExpectedFile } from "../src/harness/score.ts";
import { standardTextImporter, withListLabel } from "../src/import/standard-text.ts";
import { scanStandardText } from "../src/import/standard-text-scan.ts";
import { countVerdicts, linesToBlocks, type ImportResult, type SourceBlock } from "../src/import/types.ts";
import { wordImporter } from "../src/import/word.ts";
import { FindingCode } from "../src/model/findings.ts";
import type { Question } from "../src/model/question.ts";
import { richTextToPlain } from "../src/model/richtext.ts";
import { docx, docxFromLines, paragraph, run, type MarkOptions } from "./support/docx-writer.ts";
import { project } from "./support/project.ts";

const OPTIONS = { file: "t.docx", at: "2026-01-01T00:00:00.000Z", author: "test" };
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "..", "..", "..", "fixtures", "standard-format");
const linesOf = (text: string) => text.replace(/\r\n?/g, "\n").split("\n");

const correctLetters = (q: Question): string =>
  "options" in q.body
    ? q.body.options.flatMap((o, i) => (o.correct ? [String.fromCharCode(97 + i)] : [])).join("")
    : "";

// ---------------------------------------------------------------------------
// "Answer:" lines
// ---------------------------------------------------------------------------

describe("an Answer line beside the question is the question's key", () => {
  const parse = (text: string) => standardTextImporter.parse(text, { file: "t.txt", at: OPTIONS.at, author: "test" });

  test("after the options, on the line straight after the last one", () => {
    const result = parse("1. Which is a planet?\na. Sirius\nb. Mars\nc. The Sun\nAnswer: B\n");
    const [q] = result.questions;
    assert.equal(correctLetters(q as Question), "b");
    assert.deepEqual(result.counts, { parsed: 1, needsReview: 0, failed: 0, orphans: 0 });
    // It used to be folded into the last option's text.
    assert.equal(richTextToPlain((q?.body as { options: Array<{ content: never }> }).options[2]?.content as never), "The Sun");
  });

  test("however it is written: ANS, Answer, Correct Answer, in any case", () => {
    for (const label of ["ANS", "Ans", "Answer", "ANSWER", "Correct Answer", "correct answer", "Answers"]) {
      const [q] = parse(`1. Which is a planet?\na. Sirius\nb. Mars\nANS: A\n`.replace("ANS", label)).questions;
      assert.equal(correctLetters(q as Question), "a", label);
    }
  });

  test("after a blank line, and before a label that follows it", () => {
    const result = parse("1. Which is a planet?\na. Sirius\nb. Mars\n\nAnswer: B\nDifficulty: Easy\n");
    assert.equal(correctLetters(result.questions[0] as Question), "b");
    assert.equal(result.questions[0]?.metadata.difficulty, "easy");
    assert.equal(result.orphans.length, 0);
  });

  test("several letters, however they are separated", () => {
    for (const written of ["B, D", "B D", "B and D", "B; D", "b,d"]) {
      const [q] = parse(`Type: MA\n1. Pick two.\na. x\nb. y\nc. z\nd. w\nAnswer: ${written}\n`).questions;
      assert.equal(correctLetters(q as Question), "bd", written);
    }
  });

  test("a true or false question, by the word or by the letter", () => {
    const byWord = parse("Type: TF\n1. The sky is blue.\na. True\nb. False\nAnswer: True\n").questions[0];
    const byLetter = parse("Type: TF\n1. The sky is blue.\na. True\nb. False\nAnswer: B\n").questions[0];
    assert.deepEqual(byWord?.body, { correct: true });
    assert.deepEqual(byLetter?.body, { correct: false });
  });

  test("the answer of a fill in the blank, short answer or essay is the text", () => {
    const blank = parse("Type: F\n1. The capital of France is ____.\nAnswer: Paris\n").questions[0];
    assert.deepEqual((blank?.body as { blanks: Array<{ accepted: string[] }> }).blanks[0]?.accepted, ["Paris"]);
    const essay = parse("Type: E\n1. Discuss the causes of the war.\nAnswer: Look for three causes.\n").questions[0];
    assert.match(JSON.stringify(essay?.body), /Look for three causes/);
  });

  test("more than one line gives more than one accepted answer", () => {
    const [q] = parse("Type: F\n1. The author is ____.\nAnswer: Van Hook\nAnswer: Dr. Van Hook\n").questions;
    assert.deepEqual((q?.body as { blanks: Array<{ accepted: string[] }> }).blanks[0]?.accepted, ["Van Hook", "Dr. Van Hook"]);
  });

  test("a line that only begins with the word is not a key", () => {
    const result = parse("1. Which is a planet?\na. Sirius\nb. Mars\nc. The Sun\nAnswer the question above in full.\n");
    assert.equal(result.questions[0]?.findings.some((f) => f.code === FindingCode.NoAnswerKey), true, "no key was found");
    // It carries on the last option, as any line that is not a new option, feedback or label does.
    assert.match(JSON.stringify(result.questions[0]?.body), /The Sun<br>Answer the question above in full\./);
  });

  test("an empty Answer line is not an answer and not a loss", () => {
    const result = parse("1. Which is a planet?\na. Sirius\n*b. Mars\nAnswer:\n");
    assert.equal(correctLetters(result.questions[0] as Question), "b");
    assert.equal(result.orphans.length, 0);
  });

  test("an Answer line is read before an Answers list, and both are kept in view", () => {
    const text = "1. Q one?\na. x\nb. y\nAnswer: A\n\n2. Q two?\na. x\nb. y\n\nAnswers:\n1. A\n2. B\n";
    const result = parse(text);
    assert.deepEqual(result.questions.map((q) => correctLetters(q)), ["a", "b"]);
    assert.deepEqual(result.counts, { parsed: 2, needsReview: 0, failed: 0, orphans: 0 });
  });

  test("an Answer line and an Answers list that disagree: the line is used and the disagreement is said", () => {
    const result = parse("1. Q one?\na. x\nb. y\nAnswer: A\n\nAnswers:\n1. B\n");
    const [q] = result.questions;
    assert.equal(correctLetters(q as Question), "a");
    const said = q?.findings.find((f) => f.code === FindingCode.KeysDisagree);
    assert.equal(said?.severity, "warn");
    assert.match(said?.message ?? "", /^The Answers list marks B, but the Answer line gives A\. The Answer line was used\.$/);
  });

  test("an asterisk and an Answer line that disagree: the asterisk is used and the disagreement is said", () => {
    const [q] = parse("1. Q one?\na. x\n*b. y\nAnswer: A\n").questions;
    assert.equal(correctLetters(q as Question), "b");
    assert.match(q?.findings.find((f) => f.code === FindingCode.KeysDisagree)?.message ?? "", /^The Answer line marks A, but the asterisk gives B\. The asterisk was used\.$/);
  });

  test("an asterisk and an Answers list that disagree is said too, which used to pass without a word", () => {
    const [q] = parse("1. Q one?\na. x\n*b. y\n\nAnswers:\n1. A\n").questions;
    assert.equal(correctLetters(q as Question), "b");
    assert.equal(q?.findings.some((f) => f.code === FindingCode.KeysDisagree), true);
  });

  test("sources that agree say nothing", () => {
    const [q] = parse("1. Q one?\na. x\n*b. y\nAnswer: B\n\nAnswers:\n1. B\n").questions;
    assert.equal(q?.findings.length, 0);
  });

  test("an Answer line for letters the question does not have is an error, as an Answers list is", () => {
    const [q] = parse("1. Q one?\na. x\nb. y\nAnswer: F\n").questions;
    assert.equal(q?.findings.some((f) => f.code === FindingCode.KeyLetterMissing), true);
  });

  test("an Answer line that is words on a choice question is reported, not lost", () => {
    const [q] = parse("1. Q one?\na. x\nb. y\nAnswer: because of the sun\n").questions;
    assert.match(q?.findings.find((f) => f.code === FindingCode.KeyTextNotUsed)?.message ?? "", /The Answer line gave "because of the sun"/);
  });

  test("a question with no key at all is still a failure that says so", () => {
    const [q] = parse("1. Q one?\na. x\nb. y\n").questions;
    assert.equal(q?.findings.some((f) => f.code === FindingCode.NoAnswerKey), true);
  });
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

interface Q {
  stem: string;
  options: string[];
  /** The options that are marked. */
  marked: number[];
  type?: string;
}

const BOLD = "<w:b/>";
const UNDERLINE = '<w:u w:val="single"/>';
const YELLOW = '<w:highlight w:val="yellow"/>';

/** A bank typed by hand, in which the options listed in `marked` are formatted the way `how` says. */
function bank(questions: Q[], how: string | ((q: Q, option: number) => string) = BOLD): Uint8Array {
  const body: string[] = [];
  questions.forEach((q, n) => {
    if (q.type) body.push(paragraph(run(`Type: ${q.type}`)));
    body.push(paragraph(run(`${n + 1}. ${q.stem}`)));
    q.options.forEach((text, i) => {
      const format = typeof how === "string" ? (q.marked.includes(i) ? how : "") : how(q, i);
      body.push(paragraph(run(`${String.fromCharCode(97 + i)}. `) + run(text, format)));
    });
    body.push(paragraph());
  });
  return docx({ body: body.join("") });
}

const planets = (n: number, marked: number[] = [1]): Q[] =>
  Array.from({ length: n }, (_, k) => ({ stem: `Question ${k + 1}?`, options: ["First", "Second", "Third", "Fourth"], marked }));

const parseWord = (bytes: Uint8Array, keyMark?: string) => wordImporter.parseBytes(bytes, keyMark === undefined ? OPTIONS : { ...OPTIONS, keyMark });
const keys = (result: ImportResult) => result.questions.map((q) => correctLetters(q));
const fileMessages = (result: ImportResult) => result.fileFindings.map((f) => f.message).join("\n");

describe("a file whose correct answers are bold", () => {
  test("is read as keyed by bold, and said to be", () => {
    const result = parseWord(bank(planets(5)));
    assert.deepEqual(keys(result), ["b", "b", "b", "b", "b"]);
    assert.deepEqual(result.counts, { parsed: 5, needsReview: 0, failed: 0, orphans: 0 });
    const said = result.fileFindings.find((f) => f.code === FindingCode.FormattingKeyUsed);
    assert.equal(said?.severity, "warn");
    assert.match(said?.message ?? "", /^Bold sets the correct answer apart in 5 of 5 choice questions, so it was read as the answer key for the 5 that had no other key\. Check that bold does mean the correct answer in this file\.$/);
  });

  test("with different options bold in different questions", () => {
    const qs = planets(6).map((q, k) => ({ ...q, marked: [k % 4] }));
    assert.deepEqual(keys(parseWord(bank(qs))), ["a", "b", "c", "d", "a", "b"]);
  });

  test("needs at least three questions to be sure, and says so when it has fewer", () => {
    const result = parseWord(bank(planets(2)));
    assert.deepEqual(keys(result), ["", ""]);
    assert.equal(result.counts.failed, 2);
    const said = result.fileFindings.find((f) => f.code === FindingCode.FormattingKeyUnclear);
    assert.match(said?.message ?? "", /Bold sets one option apart from the others in 2 of 2 choice questions, which is not often enough.*at least 3 questions and 80 percent/);
  });

  test("needs most of the questions to show it: 8 of 10 do, 7 of 10 do not", () => {
    const some = (marked: number) => planets(10).map((q, k) => (k < marked ? q : { ...q, marked: [] }));
    const eight = parseWord(bank(some(8)));
    assert.equal(eight.questions.filter((q) => correctLetters(q) === "b").length, 8);
    assert.match(fileMessages(eight), /2 questions do not follow it and are flagged/);

    const seven = parseWord(bank(some(7)));
    assert.deepEqual(keys(seven), Array(10).fill(""));
    assert.match(fileMessages(seven), /Bold sets one option apart from the others in 7 of 10 choice questions/);
  });

  test("a question that does not follow it gets no key from formatting, and says why", () => {
    const qs = planets(10);
    qs[4] = { ...(qs[4] as Q), marked: [] };
    const result = parseWord(bank(qs));
    const q = result.questions[4] as Question;
    assert.equal(correctLetters(q), "");
    assert.equal(q.findings.some((f) => f.code === FindingCode.NoAnswerKey), true);
    const broken = q.findings.find((f) => f.code === FindingCode.FormattingKeyBroken);
    assert.equal(broken?.severity, "warn");
    assert.match(broken?.message ?? "", /In this file bold marks the correct answer, but no option of this question is bold\. No answer was taken from formatting\./);
    assert.equal(result.counts.failed, 1);
    assert.equal(result.counts.parsed, 9);
  });

  test("a question with every option bold marks none of them", () => {
    const qs = planets(10);
    qs[2] = { ...(qs[2] as Q), marked: [0, 1, 2, 3] };
    const q = parseWord(bank(qs)).questions[2] as Question;
    assert.equal(correctLetters(q), "");
    assert.match(q.findings.find((f) => f.code === FindingCode.FormattingKeyBroken)?.message ?? "", /every option of this question is bold, so it marks none of them/);
  });

  test("two bold options make it a multiple response question, and say that was inferred", () => {
    const qs = planets(8);
    qs[3] = { ...(qs[3] as Q), marked: [0, 2] };
    const q = parseWord(bank(qs)).questions[3] as Question;
    assert.equal(q.type, "multipleResponse");
    assert.equal(correctLetters(q), "ac");
    assert.equal(q.findings.some((f) => f.code === FindingCode.TypeInferred), true);
  });

  test("two bold options on a question that says it is single choice is an error", () => {
    const qs = planets(8);
    qs[3] = { ...(qs[3] as Q), marked: [0, 2], type: "MC" };
    const q = parseWord(bank(qs)).questions[3] as Question;
    assert.equal(q.findings.some((f) => f.code === FindingCode.MultipleKeysOnSingleAnswer), true);
  });

  test("true or false questions are read the same way", () => {
    const tf = (answer: number): Q => ({ stem: "The sky is blue.", options: ["True", "False"], marked: [answer], type: "TF" });
    const result = parseWord(bank([tf(0), tf(1), tf(0), tf(0)]));
    assert.deepEqual(result.questions.map((q) => JSON.stringify(q.body)), ['{"correct":true}', '{"correct":false}', '{"correct":true}', '{"correct":true}']);
  });
});

describe("what counts as a mark", () => {
  test("a bold word inside an option is emphasis, not a mark", () => {
    const body = Array.from({ length: 6 }, (_, k) =>
      paragraph(run(`${k + 1}. Pick one.`)) +
      paragraph(run("a. The ") + run("big", BOLD) + run(" one")) +
      paragraph(run("b. The small one")) +
      paragraph(),
    ).join("");
    const result = parseWord(docx({ body }));
    assert.deepEqual(keys(result), Array(6).fill(""));
    assert.equal(result.fileFindings.some((f) => f.code === FindingCode.FormattingKeyUsed), false);
  });

  // This used to say that a bold letter alone is nothing, on the reasoning that a bold
  // label says nothing about the option. A real publisher's key marks the right option
  // by its letter alone, so it is a mark when it is the whole of one, and the report says
  // that it is the letter. Emphasis is still not a mark: see the next test.
  test("a bold letter alone is a mark when it sets one option apart in most questions, and the file says so", () => {
    const body = Array.from({ length: 6 }, (_, k) =>
      paragraph(run(`${k + 1}. Pick one.`)) + paragraph(run("a. ", BOLD) + run("One")) + paragraph(run("b. Two")) + paragraph(),
    ).join("");
    const result = parseWord(docx({ body }));
    assert.deepEqual(keys(result), Array(6).fill("a"));
    assert.match(fileMessages(result), /Bold on the option letter sets the correct answer apart/);
  });

  test("a bold letter on every option says nothing", () => {
    const body = Array.from({ length: 6 }, (_, k) =>
      paragraph(run(`${k + 1}. Pick one.`)) + paragraph(run("a. ", BOLD) + run("One")) + paragraph(run("b. ", BOLD) + run("Two")) + paragraph(),
    ).join("");
    assert.deepEqual(keys(parseWord(docx({ body }))), Array(6).fill(""));
  });

  test("a bold term at the start of an option, its letter included, is emphasis and not a letter mark", () => {
    const body = Array.from({ length: 6 }, (_, k) =>
      paragraph(run(`${k + 1}. Pick one.`)) + paragraph(run("a. ", BOLD) + run("Term", BOLD) + run(" and more")) + paragraph(run("b. Two")) + paragraph(),
    ).join("");
    assert.deepEqual(keys(parseWord(docx({ body }))), Array(6).fill(""));
  });

  test("an option that wraps onto a second line is bold only if both lines are", () => {
    const wrapped = (second: string) =>
      paragraph(run("1. Pick one.")) + paragraph(run("a. Start of a long answer", BOLD)) + paragraph(run("continued here", second)) + paragraph(run("b. Other")) + paragraph();
    const marked = Array.from({ length: 4 }, () => wrapped(BOLD)).join("");
    assert.deepEqual(keys(parseWord(docx({ body: marked }))).slice(0, 1), ["a"]);
    const half = Array.from({ length: 4 }, () => wrapped("")).join("");
    assert.deepEqual(keys(parseWord(docx({ body: half }))), Array(4).fill(""));
  });

  test("a bold stem is nothing to do with the options", () => {
    const body = Array.from({ length: 6 }, (_, k) =>
      paragraph(run(`${k + 1}. Pick one.`, BOLD)) + paragraph(run("a. One")) + paragraph(run("b. Two")) + paragraph(),
    ).join("");
    assert.deepEqual(keys(parseWord(docx({ body }))), Array(6).fill(""));
  });

  test("questions with no choice to make do not count: fill in the blank, essay, matching", () => {
    const body = Array.from({ length: 6 }, (_, k) =>
      paragraph(run("Type: F")) + paragraph(run(`${k + 1}. Fill ____.`)) + paragraph(run("a. Paris", BOLD)) + paragraph(run("b. paris")) + paragraph(),
    ).join("");
    const result = parseWord(docx({ body }));
    assert.equal(result.fileFindings.some((f) => f.code === FindingCode.FormattingKeyUsed || f.code === FindingCode.FormattingKeyUnclear), false);
    assert.equal(result.counts.parsed, 6);
  });

  test("underlining, highlighting, colour, italics and a character style are marks like bold", () => {
    const cases: Array<[string, string | ((q: Q, i: number) => string), string]> = [
      ["underlining", UNDERLINE, "Underlining"],
      ["highlighting", YELLOW, "Highlighting"],
      ["colour", '<w:color w:val="C00000"/>', "Coloured text"],
      ["italics", "<w:i/>", "Italics"],
    ];
    for (const [name, format, described] of cases) {
      const result = parseWord(bank(planets(5), format));
      assert.deepEqual(keys(result), Array(5).fill("b"), name);
      assert.match(result.fileFindings.find((f) => f.code === FindingCode.FormattingKeyUsed)?.message ?? "", new RegExp(`^${described}`), name);
    }
  });

  test("a mark that comes from a style is a mark: the Strong character style", () => {
    const styles =
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
      '<w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style>';
    const body = planets(5)
      .map((q, k) => paragraph(run(`${k + 1}. ${q.stem}`)) + q.options.map((o, i) => paragraph(run(`${"abcd"[i]}. `) + run(o, i === 1 ? '<w:rStyle w:val="Strong"/>' : ""))).join("") + paragraph())
      .join("");
    assert.deepEqual(keys(parseWord(docx({ body, styles }))), Array(5).fill("b"));
  });

  test("black text spelled out is not a colour", () => {
    assert.deepEqual(keys(parseWord(bank(planets(5), '<w:color w:val="000000"/>'))), Array(5).fill(""));
  });
});

describe("two marks in one file", () => {
  test("that always go together are one convention", () => {
    const result = parseWord(bank(planets(5), BOLD + UNDERLINE));
    assert.deepEqual(keys(result), Array(5).fill("b"));
    assert.match(fileMessages(result), /^Bold and underlining set the correct answer apart.*Check that bold and underlining do mean/);
  });

  test("that point at different options are no convention, and no key is taken", () => {
    const how = (q: Q, i: number) => (i === 1 ? BOLD : i === 2 ? UNDERLINE : "") + (q.marked.length ? "" : "");
    const result = parseWord(bank(planets(6), how));
    assert.deepEqual(keys(result), Array(6).fill(""));
    const said = result.fileFindings.find((f) => f.code === FindingCode.FormattingKeyUnclear);
    assert.equal(said?.severity, "warn");
    assert.match(said?.message ?? "", /Bold and underlining each set one option apart from the others in most choice questions, and they do not always pick the same option, so no answer was taken from formatting\. Nothing was guessed\./);
  });

  test("a particular highlight and highlighting in general are one mark", () => {
    const result = parseWord(bank(planets(5), YELLOW));
    assert.match(fileMessages(result), /^Highlighting sets the correct answer apart/);
  });
});

describe("formatting only fills in where the file has no key in words", () => {
  const withAnswerLine = (marked: number, line: string): Uint8Array => {
    const qs = planets(6, [marked]);
    const bytes: string[] = [];
    qs.forEach((q, k) => {
      bytes.push(paragraph(run(`${k + 1}. ${q.stem}`)));
      q.options.forEach((o, i) => bytes.push(paragraph(run(`${"abcd"[i]}. `) + run(o, i === q.marked[0] ? BOLD : ""))));
      if (k === 0) bytes.push(paragraph(run(line)));
      bytes.push(paragraph());
    });
    return docx({ body: bytes.join("") });
  };

  test("a question with an Answer line keeps it, and a bold option that disagrees is said", () => {
    const result = parseWord(withAnswerLine(1, "Answer: D"));
    const first = result.questions[0] as Question;
    assert.equal(correctLetters(first), "d");
    const said = first.findings.find((f) => f.code === FindingCode.KeysDisagree);
    assert.match(said?.message ?? "", /^The file's formatting \(bold\) marks B, but the Answer line gives D\. The Answer line was used\.$/);
    assert.deepEqual(keys(result).slice(1), ["b", "b", "b", "b", "b"]);
    assert.match(fileMessages(result), /for the 5 that had no other key/);
  });

  test("an Answer line that agrees with the bold says nothing", () => {
    const first = parseWord(withAnswerLine(1, "Answer: B")).questions[0] as Question;
    assert.equal(first.findings.length, 0);
  });

  test("an asterisk on a question in a bold file is kept", () => {
    const body =
      planets(5)
        .map((q, k) => paragraph(run(`${k + 1}. ${q.stem}`)) + q.options.map((o, i) => paragraph(run(`${k === 0 && i === 2 ? "*" : ""}${"abcd"[i]}. `) + run(o, i === 1 ? BOLD : ""))).join("") + paragraph())
        .join("");
    const result = parseWord(docx({ body }));
    assert.equal(correctLetters(result.questions[0] as Question), "c");
    assert.equal(result.questions[0]?.findings.some((f) => f.code === FindingCode.KeysDisagree), true);
  });

  test("an Answers list is kept the same way", () => {
    const text = planets(5)
      .map((q, k) => paragraph(run(`${k + 1}. ${q.stem}`)) + q.options.map((o, i) => paragraph(run(`${"abcd"[i]}. `) + run(o, i === 1 ? BOLD : ""))).join("") + paragraph())
      .join("") + paragraph(run("Answers:")) + paragraph(run("1. C")) + paragraph(run("2. B"));
    const result = parseWord(docx({ body: text }));
    assert.equal(correctLetters(result.questions[0] as Question), "c");
    assert.equal(correctLetters(result.questions[1] as Question), "b");
    assert.equal(result.questions[0]?.findings.some((f) => f.code === FindingCode.KeysDisagree), true);
    assert.equal(result.questions[1]?.findings.length, 0);
  });
});

describe("the author can say what the mark is", () => {
  test("off reads no key from formatting", () => {
    const result = parseWord(bank(planets(5)), "off");
    assert.deepEqual(keys(result), Array(5).fill(""));
    assert.equal(result.fileFindings.length, 0);
    // The questions are what they would be from a plain text file: no key, and nothing about formatting.
    for (const q of result.questions) assert.deepEqual(q.findings.map((f) => f.code), [FindingCode.NoAnswerKey]);
  });

  test("a named mark is used even in a short file, and the report says it was taken from the author", () => {
    const result = parseWord(bank(planets(2)), "bold");
    assert.deepEqual(keys(result), ["b", "b"]);
    assert.match(fileMessages(result), /^Bold was taken to mark the correct answer in 2 of 2 choice questions/);
  });

  test("a named mark that the file does not use gives no key, and every question says so", () => {
    const result = parseWord(bank(planets(4)), "underline");
    assert.deepEqual(keys(result), Array(4).fill(""));
    assert.equal(result.questions.every((q) => q.findings.some((f) => f.code === FindingCode.FormattingKeyBroken)), true);
  });

  test("a specific highlight or colour can be named", () => {
    assert.deepEqual(keys(parseWord(bank(planets(3), YELLOW), "highlight:yellow")), ["b", "b", "b"]);
    assert.deepEqual(keys(parseWord(bank(planets(3), '<w:color w:val="C00000"/>'), "color:C00000")), ["b", "b", "b"]);
    assert.deepEqual(keys(parseWord(bank(planets(3), YELLOW), "highlight:green")), ["", "", ""]);
  });

  test("a text file has no formatting, so nothing changes whatever is asked", () => {
    const text = "1. Q?\na. x\nb. y\n";
    assert.deepEqual(standardTextImporter.parse(text, { ...OPTIONS, keyMark: "bold" }).fileFindings, standardTextImporter.parse(text, OPTIONS).fileFindings);
  });
});

// ---------------------------------------------------------------------------
// Labels and runs
// ---------------------------------------------------------------------------

describe("runs keep adding up to the text once a label is put in front", () => {
  const joined = (block: SourceBlock) => (block.runs ?? []).map((r) => r.text).join("");

  test("a label that Word made", () => {
    const out = withListLabel({ index: 0, text: "Mars", listLabel: "b.", runs: [{ text: "Mars", bold: true }] });
    assert.equal(out.text, "b. Mars");
    assert.equal(joined(out), out.text);
    assert.deepEqual(out.runs?.at(-1), { text: "Mars", bold: true });
  });

  test("a label in brackets", () => {
    const out = withListLabel({ index: 0, text: "Mars", listLabel: "(b)", runs: [{ text: "Mars" }] });
    assert.equal(out.text, "b) Mars");
    assert.equal(joined(out), out.text);
  });

  test("an asterisk moved in front of the label comes off the runs it was in", () => {
    const out = withListLabel({ index: 0, text: "* Mars", listLabel: "b.", runs: [{ text: "*" }, { text: " Mar", bold: true }, { text: "s" }] });
    assert.equal(out.text, "*b. Mars");
    assert.equal(joined(out), out.text);
    assert.deepEqual(out.runs?.slice(1), [{ text: "Mar", bold: true }, { text: "s" }]);
  });

  test("a block with no label is left as it is", () => {
    const block: SourceBlock = { index: 0, text: "b. Mars", runs: [{ text: "b. Mars" }] };
    assert.equal(withListLabel(block), block);
  });
});

// ---------------------------------------------------------------------------
// The text fixtures, keyed in other ways, come back as they were
// ---------------------------------------------------------------------------

async function fixtures() {
  const names = (await readdir(FIXTURES)).filter((n) => n.endsWith(".txt")).sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      lines: linesOf(await readFile(join(FIXTURES, name), "utf8")),
      expected: JSON.parse(await readFile(join(FIXTURES, `${name}.expected.json`), "utf8")) as ExpectedFile,
    })),
  );
}

describe("the text fixtures, with the key marked by formatting instead of an asterisk", () => {
  const marks: Array<{ name: string; marks: MarkOptions; keyMark: string }> = [
    { name: "bold", marks: { property: "bold" }, keyMark: "bold" },
    { name: "bold on the text only", marks: { property: "bold", textOnly: true }, keyMark: "bold" },
    { name: "underline", marks: { property: "underline" }, keyMark: "underline" },
    { name: "highlight", marks: { property: "highlight" }, keyMark: "highlight" },
    { name: "colour", marks: { property: "color", textOnly: true }, keyMark: "color" },
    { name: "italic", marks: { property: "italic" }, keyMark: "italic" },
    { name: "the Strong style", marks: { property: "style" }, keyMark: "bold" },
  ];

  test("every fixture, every mark, in every way of numbering, matches the text version and scores in full", async () => {
    let compared = 0;
    for (const { name, lines, expected } of await fixtures()) {
      const direct = project(standardTextImporter.parse(lines.join("\n"), OPTIONS));
      for (const mark of marks) {
        const forms = [
          { label: "typed", make: () => docxFromLines(lines, { marks: mark.marks }) },
          { label: "typed, noise", make: () => docxFromLines(lines, { marks: mark.marks, noise: true, seed: compared + 1 }) },
          { label: "numbered by lists", make: () => docxFromLines(lines, { marks: mark.marks, numbering: { mode: "lists" } }) },
          { label: "numbered, noise", make: () => docxFromLines(lines, { marks: mark.marks, noise: true, seed: compared + 2, numbering: { mode: "multilevel" } }) },
        ];
        for (const form of forms) {
          const via = wordImporter.parseBytes(form.make(), { ...OPTIONS, keyMark: mark.keyMark });
          assert.deepEqual(project(via), direct, `${name} marked by ${mark.name}, ${form.label}, differs from the text version`);
          assert.equal(scoreFile({ ...expected, file: name }, via).score, 1, `${name} marked by ${mark.name}, ${form.label}, did not score in full`);
          compared++;
        }
      }
    }
    assert.ok(compared >= 20 * 7 * 4);
  });

  test("with a file of its own questions in front to establish the habit, the file decides for itself", async () => {
    // Most fixtures are too short to show a habit, so thirty questions that do are put in front of each,
    // and the fixture's own questions must come out exactly as they do from the text version.
    const lead: string[] = [];
    for (let k = 1; k <= 30; k++) lead.push(`${9000 + k}. Calibration question ${k}?`, "a. One", "*b. Two", "c. Three", "");
    let compared = 0;
    for (const { name, lines, expected } of await fixtures()) {
      const direct = standardTextImporter.parse(lines.join("\n"), OPTIONS);
      for (const property of ["bold", "underline", "highlight"] as const) {
        const via = wordImporter.parseBytes(docxFromLines([...lead, ...lines], { marks: { property } }), OPTIONS);
        const ownQuestions = via.questions.slice(30).map((q) => shifted(q, lead.length));
        const ownOrphans = via.orphans.map((o) => ({ ...o, source: { ...o.source, firstBlock: o.source.firstBlock - lead.length, lastBlock: o.source.lastBlock - lead.length } }));
        const own: ImportResult = { ...via, questions: ownQuestions, orphans: ownOrphans, counts: countVerdicts(ownQuestions, ownOrphans.length) };
        assert.equal(via.questions.slice(0, 30).every((q) => correctLetters(q) === "b"), true, `${name}: the lead questions were keyed`);
        // Why a stray line is an orphan depends on what came before it, and the lead changes that.
        const withoutReasons = (r: ImportResult) => ({ ...project(r), orphans: project(r).orphans.map(([text, , first, last]) => [text, first, last]) });
        assert.deepEqual(withoutReasons(own), withoutReasons(direct), `${name} marked by ${property} differs from the text version`);
        assert.equal(scoreFile({ ...expected, file: name }, own).score, 1, `${name} marked by ${property} did not score in full`);
        compared++;
      }
    }
    assert.ok(compared >= 60);
  });
});

/** A question with its source moved back by the lines that were put in front of the file. */
function shifted(q: Question, by: number): Question {
  const source = q.origin?.source;
  if (!source || !q.origin) return q;
  return { ...q, origin: { ...q.origin, source: { ...source, firstBlock: source.firstBlock - by, lastBlock: source.lastBlock - by } } };
}

describe("the text fixtures, with the key given in an Answer line instead of an asterisk", () => {
  /** The fixture with each question's asterisks taken off and "Answer: B, D" put after its last option. */
  function withAnswerLines(lines: string[]): string[] {
    const scanned = scanStandardText(linesToBlocks(lines.join("\n")), "f.txt", 1);
    const after = new Map<number, string>();
    const unstarred = new Set<number>();
    for (const q of scanned.questions) {
      const starred = q.options.filter((o) => o.starred);
      if (starred.length === 0) continue;
      for (const o of starred) unstarred.add(o.firstBlock);
      const last = Math.max(...q.options.map((o) => o.lastBlock));
      after.set(last, `Answer: ${starred.map((o) => o.letter.toUpperCase()).join(", ")}`);
    }
    const out: string[] = [];
    lines.forEach((line, i) => {
      out.push(unstarred.has(i) ? line.replace("*", "") : line);
      const answer = after.get(i);
      if (answer) out.push(answer);
    });
    return out;
  }

  test("every fixture scores in full as text, and as a Word file", async () => {
    let changed = 0;
    for (const { name, lines, expected } of await fixtures()) {
      const transformed = withAnswerLines(lines);
      if (transformed.length !== lines.length) changed++;
      const asText = standardTextImporter.parse(transformed.join("\n"), OPTIONS);
      assert.equal(scoreFile({ ...expected, file: name }, asText).score, 1, `${name} with Answer lines did not score in full as text`);
      const asWord = wordImporter.parseBytes(docxFromLines(transformed), OPTIONS);
      assert.equal(scoreFile({ ...expected, file: name }, asWord).score, 1, `${name} with Answer lines did not score in full as a Word file`);
      assert.deepEqual(project(asWord), project(asText), `${name}: the Word file differs from the text`);
    }
    assert.ok(changed >= 12, `only ${changed} fixtures had a starred key to move`);
  });
});

describe("generated files lose nothing with Answer lines and formatting in them", () => {
  test("a file of lines in no sensible order, with Answer lines among them, keeps every marker", async () => {
    const { soup } = await import("./support/soup.ts");
    for (let seed = 1; seed <= 80; seed++) {
      const { text, markers } = soup(seed, seed % 2 === 0);
      const lines = linesOf(text);
      // Put an Answer line after every fifth line, wherever that is.
      const mixed = lines.flatMap((line, i) => (i % 5 === 4 ? [line, `Answer: ${"ABCD"[i % 4]} ${markers[0] ?? ""}`] : [line]));
      const asText = standardTextImporter.parse(mixed.join("\n"), OPTIONS);
      const asWord = wordImporter.parseBytes(docxFromLines(mixed, { noise: true, seed }), OPTIONS);
      assert.deepEqual(project(asWord), project(asText), `seed ${seed} differs between text and Word`);
      const everything = JSON.stringify([asText.questions, asText.orphans, asText.fileFindings]);
      for (const marker of markers) assert.ok(everything.includes(marker), `seed ${seed}: ${marker} was lost\n${mixed.join("\n")}`);
      assert.equal(scanStandardText(linesToBlocks(mixed.join("\n")), "f", 1).unattributed, 0, `seed ${seed}: a line was not owned`);
    }
  });
});
