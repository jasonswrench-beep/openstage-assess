/**
 * A bank with no question numbers and no option letters. Each question is a line that is only its
 * type, MC, then the stem, then the options one to a line, the right one with a star in front, and a
 * blank line before the next. Thirteen Word files from one instructor's course were written this
 * way, and the importer read none of them: with no number, nothing said where a question began.
 *
 * What starts a question here is a bare type line, which an option or a stem can also be, so it is
 * read only where the file does it as a habit, and only at the start of a run of lines. The key is
 * the star, as ever, and a question with no star has no key. These tests use invented questions;
 * the real files are measured through the harness (fixtures/publisher, kept on the machine).
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
const inWord = (lines: string[], properties = ""): ImportResult =>
  wordImporter.parseBytes(docx({ body: lines.map((l) => paragraph(l === "" ? "" : run(l, properties))).join("") }), { ...OPTIONS, file: "t.docx" });

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
const at = (result: ImportResult, n: number): Question => result.questions[n] as Question;

/** Three questions in the layout, enough for it to be the file's habit. */
const BANK = [
  "MC",
  "Which animal lays eggs?",
  "Dog",
  "*Hen",
  "Cat",
  "Cow",
  "",
  "MC",
  "What colour is the sky on a clear day?",
  "*Blue",
  "Green",
  "Red",
  "",
  "MC",
  "How many days are in a week?",
  "5",
  "6",
  "*7",
  "8",
];

describe("a bank of type lines, stems and options with no numbers or letters", () => {
  test("each question is read with its stem, its options and the one with the star as its key", () => {
    for (const result of [text(BANK), inWord(BANK)]) {
      assert.equal(result.questions.length, 3);
      assert.equal(result.orphans.length, 0, "every line is a question's");
      const [one, two, three] = result.questions as [Question, Question, Question];
      assert.equal(stemOf(one), "Which animal lays eggs?");
      assert.deepEqual(wordsOf(one), ["Dog", "Hen", "Cat", "Cow"], "the star is not part of the option");
      assert.deepEqual(rightOf(one), ["Hen"]);
      assert.deepEqual(wordsOf(two), ["Blue", "Green", "Red"]);
      assert.deepEqual(rightOf(two), ["Blue"], "the key can be the first option");
      assert.deepEqual(wordsOf(three), ["5", "6", "7", "8"], "options that are numbers are options");
      assert.deepEqual(rightOf(three), ["7"], "and the key can be later in the list");
      for (const q of result.questions) {
        assert.equal(q.type, "multipleChoice");
        assert.equal(verdict(q), "parsed");
      }
    }
  });

  test("the file says how many questions were read this way", () => {
    const note = fileHas(text(BANK), FindingCode.TypeLineQuestions);
    assert.ok(note);
    assert.equal(note.severity, "info");
    assert.match(note.message, /^3 questions began with a line that is only their type/);
  });

  test("a space after the star is allowed, and a star in the words is part of them", () => {
    const result = text([...BANK, "", "MC", "What is 3 * 4?", "7", "* 12", "3 * 4", "34"]);
    const q = at(result, 3);
    assert.equal(stemOf(q), "What is 3 * 4?");
    assert.deepEqual(wordsOf(q), ["7", "12", "3 * 4", "34"]);
    assert.deepEqual(rightOf(q), ["12"]);
    assert.equal(verdict(q), "parsed");
  });

  test("the stem can be on the type line itself", () => {
    for (const result of [text(["MC Which animal lays eggs?", "Dog", "*Hen", "Cat", "", ...BANK.slice(7)]), inWord(["MC Which animal lays eggs?", "Dog", "*Hen", "Cat", "", ...BANK.slice(7)])]) {
      assert.equal(result.questions.length, 3);
      assert.equal(stemOf(at(result, 0)), "Which animal lays eggs?");
      assert.deepEqual(wordsOf(at(result, 0)), ["Dog", "Hen", "Cat"]);
      assert.deepEqual(rightOf(at(result, 0)), ["Hen"]);
    }
  });

  test("in Word, a line break inside a paragraph is where the stem begins", () => {
    // The stem follows the break in the same paragraph as the type line, in every question.
    const broken = (stem: string): string => paragraph(run("MC") + "<w:r><w:br/></w:r>" + run(stem));
    const paragraphs = [
      broken("Which animal lays eggs?"),
      ...["Dog", "*Hen", "Cat", "Cow", ""].map((l) => paragraph(l === "" ? "" : run(l))),
      broken("What colour is the sky on a clear day?"),
      ...["*Blue", "Green", "Red", ""].map((l) => paragraph(l === "" ? "" : run(l))),
      broken("How many days are in a week?"),
      ...["5", "6", "*7", "8"].map((l) => paragraph(run(l))),
    ];
    const result = wordImporter.parseBytes(docx({ body: paragraphs.join("") }), { ...OPTIONS, file: "t.docx" });
    assert.equal(result.questions.length, 3);
    assert.equal(stemOf(at(result, 0)), "Which animal lays eggs?");
    assert.deepEqual(rightOf(at(result, 0)), ["Hen"]);
  });

  test("a heading above the questions is used by them and is not stray text", () => {
    for (const lines of [["Multiple Choice", "", ...BANK], ["Multiple Choice", ...BANK]]) {
      const result = text(lines);
      assert.equal(result.questions.length, 3);
      assert.equal(result.orphans.length, 0);
    }
  });

  test("text that is the same colour in every option does not stand in for the star", () => {
    const result = inWord(BANK, '<w:color w:val="212121"/>');
    assert.equal(result.questions.length, 3);
    assert.deepEqual(rightOf(at(result, 0)), ["Hen"]);
    assert.deepEqual(rightOf(at(result, 2)), ["7"]);
    for (const q of result.questions) assert.equal(verdict(q), "parsed");
    assert.equal(result.fileFindings.filter((f) => f.severity !== "info").length, 0);
  });
});

describe("a question with no star, or too many", () => {
  const withOne = (lines: string[]): ImportResult => text([...BANK, "", ...lines]);

  test("no star is no key: the question is kept, flagged, and nothing is chosen", () => {
    const result = withOne(["MC", "Which is a fruit?", "Pear", "Rock", "Chair"]);
    const q = at(result, 3);
    assert.deepEqual(wordsOf(q), ["Pear", "Rock", "Chair"]);
    assert.deepEqual(rightOf(q), [], "no option was made correct");
    assert.equal(verdict(q), "failed");
    assert.ok(has(q, FindingCode.NoAnswerKey));
  });

  test("a star in the stem is not the key", () => {
    const result = withOne(["MC", "What is the unit of power used in *?", "Volts", "Watts", "Joules"]);
    const q = at(result, 3);
    assert.equal(stemOf(q), "What is the unit of power used in *?");
    assert.deepEqual(rightOf(q), []);
    assert.equal(verdict(q), "failed");
  });

  test("two stars on a question that is multiple choice are both left as the file marked them, and it fails", () => {
    const q = at(withOne(["MC", "Which is a fruit?", "*Pear", "*Plum", "Chair"]), 3);
    assert.equal(q.type, "multipleChoice");
    assert.deepEqual(rightOf(q), ["Pear", "Plum"], "neither is chosen over the other");
    assert.equal(verdict(q), "failed");
    assert.ok(has(q, FindingCode.MultipleKeysOnSingleAnswer));
  });

  test("MA and MR, the multiple answer types, take every starred option, and one is enough", () => {
    for (const tag of ["MA", "MR"]) {
      const q = at(withOne([tag, "Which are fruits?", "*Pear", "*Plum", "Chair", "Rock"]), 3);
      assert.equal(q.type, "multipleResponse");
      assert.deepEqual(wordsOf(q), ["Pear", "Plum", "Chair", "Rock"]);
      assert.deepEqual(rightOf(q), ["Pear", "Plum"]);
      assert.equal(verdict(q), "parsed");
      const one = at(withOne([tag, "Which are fruits?", "*Pear", "Chair", "Rock"]), 3);
      assert.equal(one.type, "multipleResponse", "the type line says so, whatever the number of stars");
      assert.deepEqual(rightOf(one), ["Pear"]);
    }
  });
});

describe("what keeps a line from being taken for a type line", () => {
  test("two in a file is not a habit", () => {
    const result = text(BANK.slice(0, 13));
    assert.equal(result.questions.length, 0, "nothing is read");
    assert.equal(result.orphans.length, 11, "and every line is reported, so nothing is lost");
    assert.ok(result.orphans.some((o) => o.text === "MC"));
    assert.equal(fileHas(result, FindingCode.TypeLineQuestions), undefined);
  });

  test("a type line is capitals, and one of the choice types", () => {
    for (const tag of ["mc", "Mc", "MCQ", "TF"]) {
      const lines = BANK.map((l) => (l === "MC" ? tag : l));
      assert.equal(text(lines).questions.length, 0, `${tag} is not a type line`);
    }
  });

  test("the same word as an option, in the middle of a question, is an option", () => {
    const result = text([...BANK, "", "MC", "Which is a kind of cookie?", "Chip", "MC", "*Oat", "MA"]);
    const q = at(result, 3);
    assert.deepEqual(wordsOf(q), ["Chip", "MC", "Oat", "MA"]);
    assert.deepEqual(rightOf(q), ["Oat"]);
    assert.equal(result.questions.length, 4);
    assert.ok(has(q, FindingCode.TypeLineAmongOptions), "but it may be the next question, so the question is for review");
    assert.equal(verdict(q), "needsReview");
  });

  test("a type line with a blank line under it has no question under it", () => {
    const result = text([...BANK, "", "MC", "", "Which is a fruit?", "*Pear", "Rock"]);
    assert.deepEqual(
      result.orphans.map((o) => o.text),
      ["MC"],
      "the type line is reported, and the word is never made the stem of what is under it",
    );
    // What is under the blank line is a question laid out like the rest with its type line missing.
    assert.equal(result.questions.length, 4);
    assert.equal(stemOf(at(result, 3)), "Which is a fruit?");
    assert.equal(verdict(at(result, 3)), "needsReview");
  });

  test("a stem with fewer than two options under it is not a question", () => {
    const result = text([...BANK, "", "MC", "Which is a fruit?", "*Pear"]);
    assert.equal(result.questions.length, 3);
    assert.deepEqual(
      result.orphans.map((o) => o.text),
      ["MC", "Which is a fruit?", "*Pear"],
      "all three lines are reported, and the type line is not the stem of a question made of the other two",
    );
  });

  test("two questions with no blank line between them are one question, which has two stars and no key", () => {
    const result = text([...BANK, "", "MC", "Which is a fruit?", "*Pear", "Rock", "MC", "Which is a rock?", "*Granite", "Plum"]);
    assert.equal(result.questions.length, 4);
    const q = at(result, 3);
    assert.deepEqual(wordsOf(q), ["Pear", "Rock", "MC", "Which is a rock?", "Granite", "Plum"]);
    assert.deepEqual(rightOf(q), ["Pear", "Granite"], "both stars are left as marked, and neither is taken for the key");
    assert.equal(verdict(q), "failed");
    assert.ok(has(q, FindingCode.MultipleKeysOnSingleAnswer));
    assert.ok(has(q, FindingCode.TypeLineAmongOptions));
  });

  test("a question with no star that runs into the next one would take its star, and is flagged so", () => {
    const result = text([...BANK, "", "MC", "Which is a fruit?", "Pear", "Rock", "MC", "Which is a rock?", "*Granite", "Plum"]);
    const q = at(result, 3);
    assert.deepEqual(rightOf(q), ["Granite"], "the only star in the run is read as the key, as it is anywhere");
    assert.equal(verdict(q), "needsReview", "and the question is for review, because it may be two");
    assert.ok(has(q, FindingCode.TypeLineAmongOptions));
    assert.equal(q.findings.find((f) => f.code === FindingCode.TypeLineAmongOptions)?.severity, "warn");
  });
});

describe("the lines under the options that are not options", () => {
  const labelled = [
    ...BANK.slice(0, 6),
    "Difficulty: Easy",
    "",
    ...BANK.slice(7),
  ];

  test("a label the profile knows ends the options and is read as it always is", () => {
    const result = text(labelled);
    const q = at(result, 0);
    assert.deepEqual(wordsOf(q), ["Dog", "Hen", "Cat", "Cow"], "the label is not a fifth option");
    assert.deepEqual(rightOf(q), ["Hen"]);
    assert.equal(meta(q)["difficulty"], "easy");
    assert.equal(result.orphans.length, 0);
  });

  test("a feedback line ends the options too", () => {
    const result = text([...BANK.slice(0, 6), "Feedback: Hens lay eggs.", "", ...BANK.slice(7)]);
    assert.deepEqual(wordsOf(at(result, 0)), ["Dog", "Hen", "Cat", "Cow"]);
    assert.equal(result.orphans.length, 0);
  });

  test("a line with a colon in it that is not a label the profile knows is an option", () => {
    const result = text([...BANK, "", "MC", "Which is a ratio?", "Cost: price", "*Speed: distance over time", "Colour: red"]);
    assert.deepEqual(wordsOf(at(result, 3)), ["Cost: price", "Speed: distance over time", "Colour: red"]);
  });

  test("text after a blank line is stray text, as it is anywhere", () => {
    const result = text([...BANK.slice(0, 6), "", "A note the author left here.", "", ...BANK.slice(7)]);
    assert.equal(result.questions.length, 3);
    assert.equal(result.orphans.length, 1);
    assert.equal(result.orphans[0]?.text, "A note the author left here.");
  });
});

describe("a question in the same layout with its type line left off", () => {
  const lastWithout = [...BANK, "", "Which is a fruit?", "Rock", "*Pear", "Chair"];

  test("is read, with its key, and flagged for review because where it starts was guessed", () => {
    const result = text(lastWithout);
    assert.equal(result.questions.length, 4);
    const q = at(result, 3);
    assert.equal(stemOf(q), "Which is a fruit?");
    assert.deepEqual(wordsOf(q), ["Rock", "Pear", "Chair"]);
    assert.deepEqual(rightOf(q), ["Pear"], "the key is the star, as in the others");
    assert.equal(verdict(q), "needsReview");
    const warning = q.findings.find((f) => f.code === FindingCode.TypeLineMissing);
    assert.ok(warning);
    assert.equal(warning.severity, "warn");
    assert.equal(result.orphans.length, 0);
    assert.equal(fileHas(result, FindingCode.TypeLineQuestions)?.message.slice(0, 11), "3 questions", "only the three with a type line are counted as having one");
  });

  test("is read in a Word file too", () => {
    const result = inWord(lastWithout);
    assert.equal(result.questions.length, 4);
    assert.deepEqual(rightOf(at(result, 3)), ["Pear"]);
    assert.equal(verdict(at(result, 3)), "needsReview");
  });

  test("is not read when it has no star, because the star is what makes it a question", () => {
    const result = text([...BANK, "", "Which is a fruit?", "Rock", "Pear", "Chair"]);
    assert.equal(result.questions.length, 3);
    assert.equal(result.orphans.length, 4, "all four lines are reported");
  });

  test("is not read when it has two stars", () => {
    const result = text([...BANK, "", "Which is a fruit?", "*Pear", "*Plum", "Chair"]);
    assert.equal(result.questions.length, 3);
    assert.equal(result.orphans.length, 4);
  });

  test("is not read when the star is on its first line, which would make that line an option", () => {
    const result = text([...BANK, "", "*Which is a fruit?", "Pear", "*Chair"]);
    assert.equal(result.questions.length, 3);
    assert.equal(result.orphans.length, 3);
  });

  test("is not read with fewer than three lines", () => {
    const result = text([...BANK, "", "Which is a fruit?", "*Pear"]);
    assert.equal(result.questions.length, 3);
    assert.equal(result.orphans.length, 2);
  });

  test("is not read when its lines are numbered or lettered, which are a layout of their own", () => {
    const numbered = text([...BANK, "", "9. Which is a fruit?", "*Pear", "Chair"]);
    assert.equal(numbered.questions.length, 4, "the numbered question is read as a numbered question, not as this one");
    assert.equal(has(at(numbered, 3), FindingCode.TypeLineMissing), false);
  });

  test("is not read before any question that has a type line", () => {
    const result = text(["A title", "", "Which is a fruit?", "Rock", "*Pear", "Chair", "", ...BANK]);
    assert.equal(result.questions.length, 3);
    assert.ok(result.orphans.some((o) => o.text === "Which is a fruit?"));
  });

  test("is not read in a file that does not have the habit", () => {
    const result = text(["MC", "Which is a fruit?", "Rock", "*Pear", "", "Which is a rock?", "*Granite", "Plum"]);
    assert.equal(result.questions.length, 0);
    const numbered = text(["1. Name a bird.", "a. Hen", "*b. Owl", "", "Which is a fruit?", "Rock", "*Pear", "Chair"]);
    assert.equal(numbered.questions.length, 1, "a file of numbered questions, with a run that has the shape, reads only the numbered one");
    assert.equal(numbered.questions.some((q) => has(q, FindingCode.TypeLineMissing)), false);
  });
});

describe("a file that has questions of both kinds", () => {
  test("reads the numbered ones in their own way and these in theirs", () => {
    const result = text([...BANK, "", "1. What is the capital of France?", "a. Rome", "*b. Paris", "c. Oslo"]);
    assert.equal(result.questions.length, 4);
    assert.deepEqual(rightOf(at(result, 2)), ["7"]);
    assert.deepEqual(rightOf(at(result, 3)), ["Paris"]);
    assert.deepEqual(wordsOf(at(result, 3)), ["Rome", "Paris", "Oslo"]);
    assert.equal(result.orphans.length, 0);
  });
});

describe("more of what is and is not a question here", () => {
  test("the numbers given to the questions are their own, so nothing is said to repeat", () => {
    const result = text(BANK);
    assert.deepEqual(result.fileFindings.filter((f) => f.severity !== "info"), []);
  });

  test("the page a stem ends with is the question's page", () => {
    const result = text([...BANK, "", "MC", "Which is a fruit? (Page 12)", "*Pear", "Rock"]);
    const q = at(result, 3);
    assert.equal(stemOf(q), "Which is a fruit?");
    assert.equal(meta(q)["page"], "12");
  });

  test("each of the lines a question can end with ends the options and is read in the ordinary way", () => {
    for (const trailer of ["Difficulty: Easy", "Feedback: Good.", "Feedback:", "Rationale: Hens lay eggs.", "(Page 12)", "(p. 230)", "(pp. 12-14)", "(Difficulty 3)", "Answer: b", "~ Right!", "@ Not quite."]) {
      const result = text([...BANK.slice(0, 6), trailer, "", ...BANK.slice(7)]);
      assert.equal(result.questions.length, 3, trailer);
      assert.deepEqual(wordsOf(at(result, 0)), ["Dog", "Hen", "Cat", "Cow"], `${trailer} is not an option`);
      assert.deepEqual(rightOf(at(result, 0)), ["Hen"], trailer);
      assert.equal(result.orphans.length, 0, `${trailer} is read, not reported as stray`);
    }
  });

  test("a line that looks like a label is an option while there are fewer than two options before it", () => {
    const result = text([...BANK, "", "MC", "Is the word Answer a good start?", "Answer: yes", "Answer: no", "*Maybe"]);
    assert.deepEqual(wordsOf(at(result, 3)), ["Answer: yes", "Answer: no", "Maybe"]);
    assert.deepEqual(rightOf(at(result, 3)), ["Maybe"]);
  });

  test("a bold key instead of a star is read as the file's habit and the file says so, as in any other layout", () => {
    const bold = (word: string, key: boolean): string => paragraph(run(word, key ? "<w:b/>" : ""));
    const question = (stem: string, words: string[], key: number): string =>
      paragraph(run("MC")) + paragraph(run(stem)) + words.map((w, k) => bold(w, k === key)).join("") + paragraph("");
    const result = wordImporter.parseBytes(
      docx({
        body:
          question("Which animal lays eggs?", ["Dog", "Hen", "Cat"], 1) +
          question("What colour is the sky?", ["Blue", "Green", "Red"], 0) +
          question("How many days are in a week?", ["5", "7", "8"], 1),
      }),
      { ...OPTIONS, file: "t.docx" },
    );
    assert.equal(result.questions.length, 3);
    assert.deepEqual(wordsOf(at(result, 0)), ["Dog", "Hen", "Cat"]);
    assert.deepEqual(rightOf(at(result, 0)), ["Hen"]);
    assert.deepEqual(rightOf(at(result, 2)), ["7"]);
    assert.ok(fileHas(result, FindingCode.FormattingKeyUsed), "and the file says the keys came from the formatting");
    for (const q of result.questions) assert.equal(verdict(q), "parsed");
  });

  test("three type lines are not three when two of them are options in the middle of other questions", () => {
    const result = text([
      "MC", "Which is a fruit?", "*Pear", "Rock", "",
      "MC", "Which is a rock?", "*Granite", "Plum", "",
      "Which is a kind of cookie?", "Chip", "MC", "Oat", "Fig", "*Yam",
    ]);
    assert.equal(result.questions.length, 0, "the one in the middle of a run does not count toward the habit");
  });

  test("a type line is not the start of a question when it comes straight under the lines of the one above", () => {
    const result = text([...BANK.slice(0, 6), "Difficulty: Easy", "MC", "Which is a fruit?", "*Pear", "Rock", "", ...BANK.slice(7)]);
    assert.equal(result.questions.length, 3);
    assert.deepEqual(
      result.orphans.map((o) => o.text),
      ["MC", "Which is a fruit?", "*Pear", "Rock"],
      "reported, with the lines under it, and not made a question",
    );
  });

  test("a run with its type line left off is not a question when it comes straight under another", () => {
    const result = text([...BANK.slice(0, 6), "Difficulty: Easy", "Which is a fruit?", "Rock", "*Pear", "Chair", "", ...BANK.slice(7)]);
    assert.equal(result.questions.length, 3);
    assert.equal(result.orphans.length, 4);
  });

  test("nor when the question above it is still waiting for its options", () => {
    const result = text([...BANK, "", "1. Describe a hen.", "", "Which is a fruit?", "Rock", "*Pear", "Chair"]);
    assert.equal(result.questions.length, 4);
    const last = at(result, 3);
    assert.equal(has(last, FindingCode.TypeLineMissing), false);
    assert.match(stemOf(last), /Describe a hen\. Which is a fruit\?/, "the lines are the end of its text, as ever, and not a question");
  });

  test("a run with its type line left off is not a question when its lines are numbered, lettered or directives", () => {
    for (const lines of [
      ["Which is a fruit?", "1) Rock", "*2) Pear", "3) Chair"],
      ["Which is a fruit?", "A. Rock", "*B. Pear", "C. Chair"],
      ["Which is a fruit?", "Points: 2", "*Pear", "Chair"],
    ]) {
      const result = text([...BANK, "", ...lines]);
      assert.equal(
        result.questions.some((q) => has(q, FindingCode.TypeLineMissing)),
        false,
        `${lines[1]} makes it some other layout`,
      );
    }
  });
});

describe("a short question", () => {
  test("two options and a label under them: the label is not a third option", () => {
    const result = text([...BANK, "", "MC", "Is a hen a bird?", "*Yes", "No", "Difficulty: Easy"]);
    assert.deepEqual(wordsOf(at(result, 3)), ["Yes", "No"]);
    assert.deepEqual(rightOf(at(result, 3)), ["Yes"]);
    assert.equal(meta(at(result, 3))["difficulty"], "easy");
  });
});
