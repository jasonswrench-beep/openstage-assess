/**
 * Tests for the Standard Format scanner.
 *
 * Each group below is one of the six data-loss findings that came from the old
 * single-state scan, plus the rule they all broke: every line is either part of
 * a question or reported. The last group checks that rule directly, over the
 * fixtures and over generated files, rather than trusting the examples.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { standardTextImporter } from "../src/import/standard-text.ts";
import { scanStandardText, UNATTRIBUTED_REASON } from "../src/import/standard-text-scan.ts";
import { linesToBlocks, verdictOf } from "../src/import/types.ts";
import { richTextToPlain } from "../src/model/richtext.ts";
import { optionsOf } from "../src/model/question.ts";
import { FindingCode } from "../src/model/findings.ts";
import { validateQuestion } from "../src/model/schema.ts";
import { checkAnswerKey, hasUsableKey } from "../src/quality/answer-key.ts";
import { soup } from "./support/soup.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "..", "..", "..", "fixtures", "standard-format");

function parse(text: string) {
  return standardTextImporter.parse(text, { file: "test.txt", at: "2026-01-01T00:00:00.000Z", author: "test" });
}

const correctIndexes = (q: ReturnType<typeof parse>["questions"][number]) =>
  optionsOf(q).flatMap((o, i) => (o.correct ? [i] : []));

const codes = (q: ReturnType<typeof parse>["questions"][number]) => q.findings.map((f) => f.code);

describe("an answer key can close", () => {
  test("a question after a mid-file key is its own question, not part of the key", () => {
    const result = parse(`1) First?\n*a. Yes\nb. No\n\nAnswers:\n1. A\n\n2) Second?\na. One\n*b. Two\n\nAnswers:\n2. B\n`);
    assert.equal(result.questions.length, 2);
    assert.equal(richTextToPlain(result.questions[1]!.stem), "Second?");
    assert.deepEqual(result.questions.map(correctIndexes), [[0], [1]]);
    assert.deepEqual(result.questions.map(verdictOf), ["parsed", "parsed"]);
    assert.equal(result.orphans.length, 0);
  });

  test("a question that relies on its own key block after it is keyed from that block", () => {
    const result = parse(`1) First?\na. Yes\nb. No\n\nAnswers:\n1. B\n\n2) Second?\na. One\nb. Two\n\nAnswers:\n2. A\n`);
    assert.deepEqual(result.questions.map(correctIndexes), [[1], [0]]);
  });

  test("numbering that restarts after each key gets each chapter's own key", () => {
    const result = parse(
      `1) A?\na. x\nb. y\n2) B?\na. x\nb. y\n\nAnswers:\n1. A\n2. B\n\n1) C?\na. x\nb. y\n2) D?\na. x\nb. y\n\nAnswers:\n1. B\n2. A\n`,
    );
    assert.deepEqual(result.questions.map(correctIndexes), [[0], [1], [1], [0]]);
    assert.equal(
      result.fileFindings.some((f) => f.code === FindingCode.DuplicateQuestionNumber),
      false,
      "a restart after a key is normal and is not a repeat",
    );
  });

  test("a question with no options right after a key is still a question", () => {
    const result = parse(`1) First?\n*a. Yes\nb. No\n\nAnswers:\n1. A\n\n2) Explain at length how the two differ.\n`);
    assert.equal(result.questions.length, 2);
    assert.equal(result.questions[1]!.type, "essay");
  });

  test("a heading after a letter key is reported, not appended to the last answer", () => {
    const result = parse(`1) Q?\na. x\nb. y\n\nAnswers:\n1. B\nChapter 2 Radio\n\n2) Next?\n*a. x\nb. y\n`);
    assert.deepEqual(correctIndexes(result.questions[0]!), [1]);
    assert.deepEqual(result.orphans.map((o) => o.text), ["Chapter 2 Radio"]);
  });

  test("a model answer can run onto a second line, and stops at a blank line", () => {
    const result = parse(`Type: E\n1) Explain.\n\nAnswers:\n1. First part of the answer\nand the second part\n\nChapter 2\n\n2) Next?\n*a. x\nb. y\n`);
    const essay = result.questions[0]!;
    assert.equal(richTextToPlain((essay.body as { modelAnswer: never }).modelAnswer), "First part of the answer and the second part");
    assert.deepEqual(result.orphans.map((o) => o.text), ["Chapter 2"]);
  });

  test("a list placed before its questions still keys the one question its number picks out", () => {
    const result = parse(`Answers:\n1. B\n\n1) Q?\na. x\nb. y\n`);
    assert.deepEqual(correctIndexes(result.questions[0]!), [1]);
  });

  test("an Answers heading with nothing under it is reported", () => {
    const result = parse(`1) Q?\n*a. x\nb. y\n\nAnswers:\n`);
    assert.ok(result.fileFindings.some((f) => /no entries/.test(f.message)));
  });

  test("a repeated entry for one number adds to it, so a multiple-answer key can span lines", () => {
    const result = parse(`Type: MA\n1) Pick two.\na. x\nb. y\nc. z\n\nAnswers:\n1. A\n1. C\n`);
    assert.deepEqual(correctIndexes(result.questions[0]!), [0, 2]);
  });
});

describe("an option containing = is not a matching pair", () => {
  test("a starred multiple-choice option keeps its asterisk", () => {
    const q = parse(`1) Solve for x.\na. x = 1\n*b. x = 3\nc. x = 5\n`).questions[0]!;
    assert.equal(q.type, "multipleChoice");
    assert.deepEqual(correctIndexes(q), [1]);
    assert.equal(verdictOf(q), "parsed");
  });

  test("a key list entry is enough to say these are answer options", () => {
    const q = parse(`1) Solve for x.\na. x = 1\nb. x = 3\n\nAnswers:\n1. B\n`).questions[0]!;
    assert.equal(q.type, "multipleChoice");
    assert.deepEqual(correctIndexes(q), [1]);
  });

  test("unkeyed options whose left sides repeat fail as an unkeyed multiple choice", () => {
    const q = parse(`1) Solve for x.\na. x = 1\nb. x = 3\nc. x = 5\n`).questions[0]!;
    assert.equal(q.type, "multipleChoice");
    assert.equal(verdictOf(q), "failed");
    assert.ok(codes(q).includes(FindingCode.NoAnswerKey));
  });

  test("distinct left sides with no key at all are still read as matching, and flagged", () => {
    const q = parse(`1) Match these.\na. Einstein = Relativity\nb. Marconi = Radio\n`).questions[0]!;
    assert.equal(q.type, "matching");
    assert.ok(codes(q).includes(FindingCode.TypeInferred));
  });

  test("an explicit Type: MT is matching whatever else is on the lines", () => {
    const q = parse(`Type: MT\n1) Match these.\na. x = 1\nb. y = 2\n`).questions[0]!;
    assert.equal(q.type, "matching");
  });
});

describe("a directive only counts when a question follows it", () => {
  test("Points, Title and Type lines inside a stem are text, and later questions keep their points", () => {
    const result = parse(`Points: 2\n1) Read the label:\nPoints: 20\nTitle:\nType: A\nWhat does it mean?\n*a. x\nb. y\n\n2) Second?\n*a. x\nb. y\n`);
    assert.deepEqual(result.questions.map((q) => q.points), [2, 2]);
    assert.match(richTextToPlain(result.questions[0]!.stem), /Points: 20/);
    assert.match(richTextToPlain(result.questions[0]!.stem), /Type: A/);
    assert.equal(result.orphans.length, 0);
  });

  test("a real directive run applies to the question after it, across blank lines", () => {
    const result = parse(`1) First?\n*a. x\nb. y\n\nPoints: 4\n\nTitle: Second one\nType: MC\n\n2) Second?\n*a. x\nb. y\n`);
    assert.equal(result.questions[1]!.points, 4);
    assert.equal(result.questions[1]!.title, "Second one");
    assert.equal(result.orphans.length, 0);
  });

  test("a directive that a later one replaces is reported rather than lost", () => {
    const result = parse(`Title: One\nTitle: Two\n1) Q?\n*a. x\nb. y\n`);
    assert.equal(result.questions[0]!.title, "Two");
    assert.deepEqual(result.orphans.map((o) => o.text), ["Title: One"]);
  });

  test("a directive at the very end has nothing to apply to and is reported", () => {
    const result = parse(`1) Q?\n*a. x\nb. y\n\nPoints: 9\n`);
    assert.equal(result.questions[0]!.points, 1);
    assert.deepEqual(result.orphans.map((o) => o.text), ["Points: 9"]);
  });

  test("a directive before any question waits for the next one", () => {
    const result = parse(`Points: 7\nChapter 1\n1) Q?\n*a. x\nb. y\n`);
    assert.equal(result.questions[0]!.points, 7);
    assert.deepEqual(result.orphans.map((o) => o.text), ["Chapter 1"]);
  });

  test("a Type line this profile does not know is flagged instead of ignored", () => {
    const q = parse(`Type: SA\n1) Q?\n*a. x\nb. y\n`).questions[0]!;
    assert.ok(q.findings.some((f) => f.code === FindingCode.TypeInferred && /SA/.test(f.message)));
    assert.equal(verdictOf(q), "needsReview");
  });
});

describe("text after the options is reported, not folded into the stem", () => {
  test("a heading after the options is an orphan and the stem is untouched", () => {
    const result = parse(`1) Stem?\n*a. x\nb. y\n\nChapter 5 Heading\n\n2) Next?\n*a. x\nb. y\n`);
    assert.equal(richTextToPlain(result.questions[0]!.stem), "Stem?");
    assert.deepEqual(result.orphans.map((o) => o.text), ["Chapter 5 Heading"]);
  });

  test("text after a metadata line is an orphan", () => {
    const result = parse(`1) Stem?\n*a. x\nb. y\nDIF: Easy\nstray words\n`);
    assert.equal(richTextToPlain(result.questions[0]!.stem), "Stem?");
    assert.deepEqual(result.orphans.map((o) => o.text), ["stray words"]);
  });

  test("text after a feedback line and a blank line is an orphan, not more feedback", () => {
    const result = parse(`1) Stem?\n~ Good.\n\nA stray paragraph\n*a. x\nb. y\n`);
    assert.equal(richTextToPlain(result.questions[0]!.feedback.correct!), "Good.");
    assert.deepEqual(result.orphans.map((o) => o.text), ["A stray paragraph"]);
  });

  test("a line directly under an option still continues that option", () => {
    const result = parse(`1) Stem?\n*a. first part\nsecond part\nb. y\n`);
    assert.equal(richTextToPlain(optionsOf(result.questions[0]!)[0]!.content).replace(/\s+/g, " "), "first part second part");
    assert.equal(result.orphans.length, 0);
  });

  test("a stem can run over several paragraphs before its options", () => {
    const result = parse(`1) Read this scenario.\n\nThe manager withholds the report.\n\nWhat is this called?\n*a. Silence\nb. Voice\n`);
    assert.match(richTextToPlain(result.questions[0]!.stem), /withholds the report/);
    assert.match(richTextToPlain(result.questions[0]!.stem), /What is this called/);
    assert.equal(result.orphans.length, 0);
  });

  test("a stem that continues after a blank line on a question with no options is flagged", () => {
    const q = parse(`Type: E\n1) Discuss the experiment.\n\nChapter 6 Heading\n`).questions[0]!;
    assert.ok(codes(q).includes(FindingCode.StemSpansBlankLine));
  });
});

describe("repeated labels keep every value", () => {
  test("two different values for a known label are joined and flagged, not overwritten", () => {
    const q = parse(`1) Q?\n*a. x\nb. y\nREF: 87\nREF: 90\n`).questions[0]!;
    assert.equal(q.metadata.page, "87; 90");
    assert.ok(codes(q).includes(FindingCode.DuplicateMetadataLabel));
  });

  test("two different values for an unknown label are joined and flagged", () => {
    const q = parse(`1) Q?\n*a. x\nb. y\nMSC: Conceptual\nMSC: Applied\n`).questions[0]!;
    assert.equal(q.metadata.custom?.["MSC"], "Conceptual; Applied");
    assert.ok(codes(q).includes(FindingCode.DuplicateMetadataLabel));
  });

  test("an identical repeat loses nothing and says nothing", () => {
    const q = parse(`1) Q?\n*a. x\nb. y\nREF: 87\nREF: 87\nDIF: Easy\nDIF: Easy\n`).questions[0]!;
    assert.equal(q.metadata.page, "87");
    assert.equal(q.metadata.difficulty, "easy");
    assert.equal(codes(q).includes(FindingCode.DuplicateMetadataLabel), false);
  });

  test("a conflicting difficulty keeps the first and records the second", () => {
    const q = parse(`1) Q?\n*a. x\nb. y\nDIF: Easy\nDIF: Hard\n`).questions[0]!;
    assert.equal(q.metadata.difficulty, "easy");
    assert.equal(q.metadata.custom?.["DIF"], "Hard");
    assert.ok(codes(q).includes(FindingCode.DuplicateMetadataLabel));
  });

  test("two labels that mean the same field are treated as a repeat", () => {
    const q = parse(`1) Q?\n*a. x\nb. y\nREF: 87\nPAGE: 90\n`).questions[0]!;
    assert.equal(q.metadata.page, "87; 90");
  });
});

describe("repeated question numbers do not share a key", () => {
  const twice = `3) Which planet has rings?\na. Mars\nb. Saturn\n\n3) Which planet is nearest the sun?\na. Mercury\nb. Jupiter\n\nAnswers:\n3. B\n`;

  test("neither question is given the entry, and both fail", () => {
    const result = parse(twice);
    assert.deepEqual(result.questions.map(correctIndexes), [[], []]);
    assert.deepEqual(result.questions.map(verdictOf), ["failed", "failed"]);
    for (const q of result.questions) assert.ok(codes(q).includes(FindingCode.DuplicateQuestionNumber));
  });

  test("the file says that numbers repeat", () => {
    const result = parse(twice);
    const said = result.fileFindings.find((f) => f.code === FindingCode.DuplicateQuestionNumber && /3/.test(f.message));
    assert.ok(said);
    assert.equal(said.severity, "warn", "an Answers entry was held back, so it cost something");
    assert.match(said.message, /cannot tell repeated numbers apart/);
  });

  test("a repeat is harmless when each question carries its own asterisk", () => {
    const result = parse(`3) A?\n*a. x\nb. y\n\n3) B?\na. x\n*b. y\n`);
    assert.deepEqual(result.questions.map(correctIndexes), [[0], [1]]);
    assert.deepEqual(result.questions.map(verdictOf), ["parsed", "parsed"]);
    const said = result.fileFindings.find((f) => f.code === FindingCode.DuplicateQuestionNumber);
    assert.ok(said, "it is still said");
    assert.equal(said.severity, "info", "no Answers entry was waiting, so nothing was held back and it is not a warning");
    assert.match(said.message, /No Answers entry was waiting on them/);
  });

  test("sections that each start again at 1, with answers marked another way, are said as information and keep every answer", () => {
    // A section numbered 1 and 2, then another numbered 1 and 2: the real files that were told an Answers entry was not applied.
    const result = parse(`1) First?\n*a. x\nb. y\n2) Second?\na. x\n*b. y\n\n1) Third?\n*a. p\nb. q\n2) Fourth?\na. p\n*b. q\n`);
    assert.deepEqual(result.questions.map(correctIndexes), [[0], [1], [0], [1]]);
    const said = result.fileFindings.filter((f) => f.code === FindingCode.DuplicateQuestionNumber);
    assert.equal(said.length, 1);
    assert.equal(said[0]?.severity, "info");
    assert.equal(result.fileFindings.filter((f) => f.severity === "warn").length, 0);
  });

  test("it is a warning when an Answers list placed before the questions is not applied to the repeated numbers", () => {
    // Found by an independent reader: no question is marked ambiguous here, but the list's entries were held back all the same.
    const result = parse(`Answers:\n1. A\n2. B\n\n1) First?\na. x\nb. y\n2) Second?\na. x\nb. y\n\n1) Third?\na. p\nb. q\n2) Fourth?\na. p\nb. q\n`);
    assert.deepEqual(result.questions.map(verdictOf), ["failed", "failed", "failed", "failed"]);
    const said = result.fileFindings.find((f) => f.code === FindingCode.DuplicateQuestionNumber);
    assert.equal(said?.severity, "warn");
    assert.doesNotMatch(said?.message ?? "", /No Answers entry was waiting/);
  });

  test("it is a warning when only some of the repeated numbers had an Answers entry", () => {
    const result = parse(`3) A?\na. x\nb. y\n\n3) B?\na. x\nb. y\n\nAnswers:\n3. B\n\n4) C?\n*a. x\nb. y\n\n4) D?\na. x\n*b. y\n`);
    assert.equal(result.fileFindings.find((f) => f.code === FindingCode.DuplicateQuestionNumber)?.severity, "warn");
  });
});

describe("a key names an option, never a position", () => {
  test("True in an Answers list means the option that says True, even when it is listed second", () => {
    const q = parse(`1) The sky is blue.\na. False\nb. True\n\nAnswers:\n1. True\n`).questions[0]!;
    assert.equal(q.type, "multipleChoice");
    assert.deepEqual(correctIndexes(q), [1]);
  });

  test("a key letter that two options share marks neither and is an error", () => {
    const q = parse(`1) Q?\na. x\nb. y\na. z\n\nAnswers:\n1. A\n`).questions[0]!;
    assert.deepEqual(correctIndexes(q), []);
    assert.equal(verdictOf(q), "failed");
    assert.ok(codes(q).includes(FindingCode.KeyLetterMissing));
    assert.ok(codes(q).includes(FindingCode.DuplicateOptionLetter));
  });

  test("an asterisk marks one option even when its letter is repeated", () => {
    const q = parse(`1) Q?\n*a. x\nb. y\na. z\n`).questions[0]!;
    assert.deepEqual(correctIndexes(q), [0]);
  });
});

describe("every line is accounted for", () => {
  test("no fixture leaves a line unattributed", async () => {
    const names = (await readdir(FIXTURES)).filter((n) => n.endsWith(".txt"));
    assert.ok(names.length > 10, "the corpus should be present");
    for (const name of names) {
      const text = await readFile(join(FIXTURES, name), "utf8");
      const scanned = scanStandardText(linesToBlocks(text), name, 1);
      assert.equal(scanned.unattributed, 0, `${name} left lines the scanner did not own`);
    }
  });

  test("generated files never lose a line and never throw", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const { text, markers } = soup(seed);
      const scanned = scanStandardText(linesToBlocks(text), "soup.txt", 1);
      assert.equal(scanned.unattributed, 0, `seed ${seed}: ${UNATTRIBUTED_REASON}\n${text}`);

      const result = parse(text);
      const everything = JSON.stringify([result.questions, result.orphans, result.fileFindings]);
      for (const marker of markers) {
        assert.ok(everything.includes(marker), `seed ${seed}: ${marker} was lost\n${text}`);
      }
      for (const question of result.questions) {
        const source = question.origin?.source;
        assert.ok(source && source.firstBlock <= source.lastBlock, `seed ${seed}: a question has an inverted source range`);
      }
      for (const orphan of result.orphans) {
        assert.ok(orphan.text.length > 0 && orphan.source.firstBlock >= 0, `seed ${seed}: an orphan has no text or no position`);
      }
    }
  });

  test("generated files never lose a line, in the wider vocabulary either", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const { text, markers } = soup(seed, true);
      const scanned = scanStandardText(linesToBlocks(text), "soup.txt", 1);
      assert.equal(scanned.unattributed, 0, `seed ${seed}: ${UNATTRIBUTED_REASON}\n${text}`);

      const result = parse(text);
      const everything = JSON.stringify([result.questions, result.orphans, result.fileFindings]);
      for (const marker of markers) {
        assert.ok(everything.includes(marker), `seed ${seed}: ${marker} was lost\n${text}`);
      }
    }
  });

  test("generated files only ever produce questions that satisfy the model", () => {
    let questions = 0;
    for (const wide of [false, true]) {
      for (let seed = 1; seed <= 400; seed++) {
        const { text } = soup(seed, wide);
        for (const question of parse(text).questions) {
          questions++;
          const check = validateQuestion(question);
          assert.ok(check.ok, `seed ${seed}: ${check.issues.map((i) => `${i.path} ${i.message}`).join("; ")}\n${text}`);
        }
      }
    }
    assert.ok(questions > 1000, `only ${questions} questions were generated, which is too few to mean anything`);
  });
});

describe("a question that cannot be built as written is still storable, and says it failed", () => {
  const storable = (text: string) => {
    const result = parse(text);
    for (const q of result.questions) {
      const check = validateQuestion(q);
      assert.ok(check.ok, check.issues.map((i) => `${i.path} ${i.message}`).join("; "));
    }
    return result;
  };

  test("a fill in the blank with no answer keeps an empty answer, so the key check still catches it", () => {
    const [q] = storable(`Type: F\n1) The capital of France is ____.\n`).questions;
    assert.equal(verdictOf(q!), "failed");
    assert.deepEqual((q!.body as { blanks: Array<{ accepted: string[] }> }).blanks[0]?.accepted, [""]);
    assert.ok(checkAnswerKey(q!).some((f) => f.code === FindingCode.NoAnswerKey && f.severity === "error"));
    assert.equal(hasUsableKey(q!), false);
  });

  test("points beyond the ceiling fall back to the default and say what the file gave", () => {
    const [q] = storable(`Points: 5000\n1) Q?\n*a. Yes\nb. No\n`).questions;
    assert.equal(q!.points, 1);
    const found = q!.findings.find((f) => f.code === FindingCode.PointsAssumed);
    assert.equal(found?.severity, "warn");
    assert.match(found?.message ?? "", /5000/);
    assert.equal(verdictOf(q!), "needsReview");
  });

  test("the ceiling itself is allowed, and the default the caller chose is the fallback", () => {
    assert.equal(storable(`Points: 1000\n1) Q?\n*a. Yes\nb. No\n`).questions[0]!.points, 1000);
    const result = standardTextImporter.parse(`Points: 1001\n1) Q?\n*a. Yes\nb. No\n`, { file: "t.txt", defaultPoints: 4 });
    assert.equal(result.questions[0]!.points, 4);
  });

  test("a choice question with one option gets a placeholder second option and fails", () => {
    const [q] = storable(`1) Q?\n*a. Only\n`).questions;
    assert.equal(verdictOf(q!), "failed");
    assert.deepEqual(correctIndexes(q!), [0]);
    assert.equal(optionsOf(q!).length, 2);
    assert.ok(codes(q!).includes(FindingCode.TooFewOptions));
    assert.equal(hasUsableKey(q!), false, "a placeholder option must keep the question out of an export");
  });

  test("a multiple answer question with no options is storable too", () => {
    const [q] = storable(`Type: MA\n1) Pick all.\n`).questions;
    assert.equal(verdictOf(q!), "failed");
    assert.ok(codes(q!).includes(FindingCode.NoOptions));
    assert.equal(hasUsableKey(q!), false);
  });

  test("an option with a letter and no text keeps its place and fails", () => {
    const [q] = storable(`1) Q?\na. First\nb.  \n*c. Third\n`).questions;
    assert.equal(optionsOf(q!).length, 3);
    assert.deepEqual(correctIndexes(q!), [2], "the key still points at C, not at whatever moved up");
    assert.ok(codes(q!).includes(FindingCode.EmptyOption));
    assert.equal(verdictOf(q!), "failed");
    assert.equal(hasUsableKey(q!), false);
  });

  test("an empty matching entry is left out with a warning, not stored empty", () => {
    const [q] = storable(`Type: MT\n1) Match.\na. one = 1\nb. two = 2\nc.  \n`).questions;
    assert.ok(codes(q!).includes(FindingCode.EmptyOption));
    assert.equal(verdictOf(q!), "needsReview");
  });

  test("a metadata label with nothing after it is not stored as an empty value", () => {
    const [q] = storable(`1) Q?\n*a. Yes\nb. No\nREF:   \nXYZ:   \n`).questions;
    assert.equal(q!.metadata.page, undefined);
    assert.equal(q!.metadata.custom, undefined);
  });
});

// The Standard Format is four dialects, not one: the generic and Canvas guides,
// Moodle, D2L and Blackboard each document it slightly differently. The cases
// here are the differences, written as the guides show them.
describe("the dialects of the Standard Format", () => {
  const only = (text: string) => {
    const result = parse(text);
    assert.equal(result.questions.length, 1, `expected one question, got ${result.questions.length}`);
    for (const q of result.questions) assert.ok(validateQuestion(q).ok, "the question must satisfy the model");
    return result;
  };
  const MULTI = "1) Which are prime?\na. 4\nb. 5\nc. 9\nd. 11\n";

  describe("Type: MR is the same as Type: MA", () => {
    test("with asterisks it is a clean multiple response", () => {
      const [q] = only(`Type: MR\n1) Which are prime?\na. 4\n*b. 5\nc. 9\n*d. 11\n`).questions;
      assert.equal(q!.type, "multipleResponse");
      assert.deepEqual(correctIndexes(q!), [1, 3]);
      assert.equal(verdictOf(q!), "parsed", "it used to be flagged as an unknown type");
      assert.equal(codes(q!).includes(FindingCode.TypeInferred), false);
    });

    test("with an Answers list it is not read as single choice and failed", () => {
      for (const key of ["b d", "b, d", "B,D"]) {
        const [q] = only(`Type: MR\n${MULTI}\nAnswers:\n1. ${key}\n`).questions;
        assert.equal(q!.type, "multipleResponse", key);
        assert.deepEqual(correctIndexes(q!), [1, 3], key);
        assert.equal(verdictOf(q!), "parsed", key);
      }
    });
  });

  describe("a Type code of up to three letters is a Type line", () => {
    test("it is not reported as stray text before the question", () => {
      for (const code of ["FMB", "ORD", "JUM", "S", "MR"]) {
        const result = parse(`Type: ${code}\n1) Q?\na. x\n*b. y\n`);
        assert.equal(result.orphans.length, 0, `Type: ${code} was left as an orphan`);
      }
    });

    test("a longer word is still not a Type line", () => {
      const result = parse(`Type: Essay\n1) Q?\n*a. x\nb. y\n`);
      assert.deepEqual(result.orphans.map((o) => o.text), ["Type: Essay"]);
    });
  });

  describe("Type: S is short answer", () => {
    test("every option is an accepted answer, as in fill in the blank", () => {
      const [q] = only(`Type: S\n1) Capital of Italy?\na. Rome\nb. Roma\n`).questions;
      assert.equal(q!.type, "shortAnswer");
      assert.deepEqual((q!.body as { accepted: string[] }).accepted, ["Rome", "Roma"]);
      assert.equal(verdictOf(q!), "parsed");
    });

    test("repeating the question number in the Answers list adds forms", () => {
      const result = only(`Type: S\n1) Who painted the Mona Lisa?\n\nAnswers:\n1. Leonardo da Vinci\n1. Da Vinci\n1. Leonardo\n`);
      assert.deepEqual((result.questions[0]!.body as { accepted: string[] }).accepted, ["Leonardo da Vinci", "Da Vinci", "Leonardo"]);
      assert.equal(verdictOf(result.questions[0]!), "parsed");
      assert.equal(codes(result.questions[0]!).includes(FindingCode.KeyTextNotUsed), false);
    });

    test("with no answer it fails and is not usable, and nothing is guessed", () => {
      const [q] = only(`Type: S\n1) Capital of Italy?\n`).questions;
      assert.equal(verdictOf(q!), "failed");
      assert.deepEqual((q!.body as { accepted: string[] }).accepted, [""]);
      assert.equal(hasUsableKey(q!), false);
    });
  });

  describe("repeating a question number in an Answers list", () => {
    // This was lost in the scanner rewrite. The old scanner never closed a key,
    // so every repeat was swallowed; the new one closed it at the first repeat
    // and turned each remaining form into a phantom essay question.
    test("gives a fill in the blank all its forms and invents no questions", () => {
      const result = parse(
        `Type: F\n1) Who is the Chancellor?\n\nType: F\n2) Who painted the Mona Lisa?\n\nAnswers:\n1. Dianne Van Hook\n1. Dr. Dianne Van Hook\n1. Dr. Van Hook\n2. Leonardo da Vinci\n2. Da Vinci\n`,
      );
      assert.equal(result.questions.length, 2);
      const accepted = result.questions.map((q) => (q.body as { blanks: Array<{ accepted: string[] }> }).blanks[0]!.accepted);
      assert.deepEqual(accepted, [["Dianne Van Hook", "Dr. Dianne Van Hook", "Dr. Van Hook"], ["Leonardo da Vinci", "Da Vinci"]]);
      assert.deepEqual(result.questions.map(verdictOf), ["parsed", "parsed"]);
    });

    test("is a question, not a form, when options follow it", () => {
      const result = parse(`Type: F\n1) Q?\n\nAnswers:\n1. Na\n\n1) Next chapter?\na. Yes\n*b. No\n`);
      assert.equal(result.questions.length, 2);
      assert.equal(richTextToPlain(result.questions[1]!.stem), "Next chapter?");
    });

    test("is a question, not a form, when it ends in a question mark", () => {
      const result = parse(`Type: F\n1) Q?\n\nAnswers:\n1. Na\n1) Why is the sky blue?\n`);
      assert.equal(result.questions.length, 2);
    });

    test("is a question for any type that does not take several forms", () => {
      const result = parse(`1) First?\na. x\nb. y\n\nAnswers:\n1. A\n1. Second chapter question\n*a. p\nb. q\n`);
      assert.equal(result.questions.length, 2, "a repeat after a multiple choice key is the next chapter");
    });
  });

  describe("Type: FMB, ORD and JUM are refused by name", () => {
    const cases: Array<[string, string, string]> = [
      ["FMB", "The [sun] rises in the [east].", ""],
      ["ORD", "Put these in order.\na. Evaporation\nb. Condensation\nc. Rain", "Evaporation"],
      ["JUM", "The [quick] brown [fox] jumps.\na. slow\nb. red", "slow"],
    ];
    for (const [code, body, optionText] of cases) {
      test(`${code} fails, keeps its text, and is not usable`, () => {
        const result = only(`Type: ${code}\n1) ${body}\n`);
        const q = result.questions[0]!;
        assert.equal(verdictOf(q), "failed");
        assert.equal(q.type, "essay", "kept as an essay so that its text has somewhere to live");
        const found = q.findings.find((f) => f.code === FindingCode.UnsupportedType);
        assert.equal(found?.severity, "error");
        assert.match(found?.message ?? "", new RegExp(`Type: ${code}`));
        assert.equal(result.orphans.length, 0);
        assert.equal(hasUsableKey(q), false, "an essay is graded by a person, so only the finding keeps it out of an export");
        assert.ok(JSON.stringify(q).includes(body.split("\n")[0]!.replace(/"/g, '\\"')), "the stem, brackets and all, is kept");
        if (optionText) assert.ok(JSON.stringify(q.body).includes(optionText), "the options are kept in the model answer");
      });
    }

    test("the question after one is read as normal", () => {
      const result = parse(`Type: ORD\n1) Order.\na. x\nb. y\n\n2) Next?\na. p\n*b. q\n`);
      assert.deepEqual(result.questions.map(verdictOf), ["failed", "parsed"]);
    });
  });

  describe("an @ line straight after the question is ambiguous", () => {
    // The generic, Canvas and Blackboard guides write feedback for an incorrect
    // answer with @ beside a ~ line. D2L and Moodle write general feedback with
    // a single @ and no ~. A lone @ could be either.
    const ambiguous = (q: ReturnType<typeof parse>["questions"][number]) => codes(q).includes(FindingCode.AmbiguousFeedback);

    test("a lone @ is kept as incorrect-answer feedback and flagged for review", () => {
      const [q] = only(`1) Which is largest?\n@ Plants take in carbon dioxide.\na. Oxygen\n*b. Carbon dioxide\nc. Nitrogen\n`).questions;
      assert.equal(ambiguous(q!), true);
      assert.equal(verdictOf(q!), "needsReview");
      assert.equal(richTextToPlain(q!.feedback.incorrect!), "Plants take in carbon dioxide.", "nothing is lost");
    });

    test("@ beside a ~ line is the generic style and is not flagged", () => {
      const [q] = only(`1) Q?\n~ Right.\n@ Wrong.\na. x\n*b. y\n`).questions;
      assert.equal(ambiguous(q!), false);
      assert.equal(verdictOf(q!), "parsed");
    });

    test("@ under an option is that option's feedback and is not flagged", () => {
      const [q] = only(`1) Q?\na. x\n@ No.\n*b. y\n@ Yes.\n`).questions;
      assert.equal(ambiguous(q!), false);
      assert.equal(verdictOf(q!), "parsed");
    });

    test("~ alone is not flagged", () => {
      const [q] = only(`1) Q?\n~ Right.\na. x\n*b. y\n`).questions;
      assert.equal(ambiguous(q!), false);
    });
  });
});
