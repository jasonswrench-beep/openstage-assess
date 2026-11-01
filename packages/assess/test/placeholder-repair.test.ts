/**
 * Placeholders that have been written over. When a file has an option with a letter and no words, a question with one option or
 * a question with none, the importer keeps the question, puts `(missing)` where the words should be, and says so with an error.
 * Writing the words in left that error where it was, so the question stayed Failed, and not usable, after it was repaired. These
 * pin down when the error goes (when what it says is no longer so), what stays (every placeholder still there, and anything
 * else the importer found), and that what the importer said is kept beside what was done. The text is invented.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { standardTextImporter } from "../src/import/standard-text.ts";
import { editQuestion } from "../src/model/create.ts";
import { finding, FindingCode, liveFindings, verdictFrom } from "../src/model/findings.ts";
import { plainToRich } from "../src/model/richtext.ts";
import type { Option, Question, QuestionBody } from "../src/model/question.ts";
import { hasUsableKey } from "../src/quality/answer-key.ts";
import { isPlaceholderOption, PLACEHOLDER_TEXT } from "../src/quality/placeholders.ts";

const OPTIONS = { file: "t.txt", at: "2026-01-01T00:00:00.000Z", author: "test" };
const LATER = "2026-02-02T00:00:00.000Z";
const read = (text: string): Question => standardTextImporter.parse(text, OPTIONS).questions[0] as Question;
const optionsOf = (q: Question): Option[] => (q.body as unknown as { options: Option[] }).options;
const live = (q: Question, code: string): boolean => liveFindings(q.findings).some((f) => f.code === code);
const words = (q: Question): string[] => optionsOf(q).map((o) => (o.content as { content: string }).content.replace(/<[^>]+>/g, ""));

/** The question with these options' words written in, and nothing else changed. `at` is the place of the option. */
const write = (q: Question, ...changes: Array<[number, string]>): Question =>
  editQuestion(q, { body: { ...q.body, options: optionsOf(q).map((o, i) => { const c = changes.find(([at]) => at === i); return c ? { ...o, content: plainToRich(c[1]) } : o; }) } as QuestionBody }, { by: "you", at: LATER });

// One option with a letter and no words (and a key that is fine), one option alone, and none.
const BLANK_OPTION = "1) Which of these is a chair?\n*a. Chair\nb.  \nc. Desk\n";
const ONE_OPTION = "1) Which of these is a chair?\n*a. Chair\n";
const NO_OPTIONS = "Type: MA\n1) Pick all that are furniture.\n";

describe("a placeholder that has been written over", () => {
  test("clears the error about an option with no words, and keeps what it said", () => {
    const before = read(BLANK_OPTION);
    assert.deepEqual(words(before), ["Chair", PLACEHOLDER_TEXT, "Desk"]);
    assert.ok(live(before, FindingCode.EmptyOption));
    assert.equal(verdictFrom(before.findings), "failed");
    assert.equal(hasUsableKey(before), false);

    const after = write(before, [1, "Table"]);
    assert.equal(live(after, FindingCode.EmptyOption), false);
    assert.equal(verdictFrom(after.findings), "parsed", "the question stops being a failure");
    assert.equal(hasUsableKey(after), true, "and can be exported");
    const kept = after.findings.find((f) => f.code === FindingCode.EmptyOption);
    assert.ok(kept, "what the importer said is kept, not deleted");
    assert.equal(kept?.dismissed, true);
    assert.equal(kept?.dismissedBy, "you");
    assert.equal(kept?.message, before.findings.find((f) => f.code === FindingCode.EmptyOption)?.message);
    assert.match(after.history.at(-1)?.change ?? "", /the missing words were written, so the placeholder no longer applies \(import\.empty-option\)/);
  });

  test("clears the error about a question with one option once its second has words", () => {
    const before = read(ONE_OPTION);
    assert.equal(optionsOf(before).length, 2);
    assert.ok(live(before, FindingCode.TooFewOptions));
    const after = write(before, [1, "Table"]);
    assert.equal(live(after, FindingCode.TooFewOptions), false);
    assert.equal(verdictFrom(after.findings), "parsed");
    assert.equal(hasUsableKey(after), true);
  });

  test("does not clear the error about too few options when the placeholder is taken away and one option is left", () => {
    const before = read(ONE_OPTION);
    const only = optionsOf(before)[0] as Option;
    const alone = editQuestion(before, { body: { ...before.body, options: [only] } as QuestionBody }, { by: "you", at: LATER });
    assert.equal(optionsOf(alone).length, 1);
    assert.ok(live(alone, FindingCode.TooFewOptions), "one option is still not a question");
    assert.equal(verdictFrom(alone.findings), "failed");
  });

  test("clears the error about a question with no options once both its options have words, and not before", () => {
    const before = read(NO_OPTIONS);
    assert.ok(live(before, FindingCode.NoOptions));
    const half = write(before, [0, "Chair"]);
    assert.ok(live(half, FindingCode.NoOptions), "one placeholder is still there");
    const both = write(half, [1, "Table"]);
    assert.equal(live(both, FindingCode.NoOptions), false);
  });

  test("keeps every error while a placeholder is left, and clears only the option that was written", () => {
    const before = read("1) Which of these is furniture?\n*a. Chair\nb.  \nc.  \n");
    assert.equal(liveFindings(before.findings).filter((f) => f.code === FindingCode.EmptyOption).length, 2);
    const one = write(before, [1, "Table"]);
    const left = liveFindings(one.findings).filter((f) => f.code === FindingCode.EmptyOption);
    assert.equal(left.length, 1, "the other option still has no words");
    assert.match(left[0]?.message ?? "", /Option C has no text/, "and it is the one that still says so");
    assert.equal(verdictFrom(one.findings), "failed");
    const two = write(one, [2, "Sofa"]);
    assert.equal(live(two, FindingCode.EmptyOption), false);
    assert.equal(verdictFrom(two.findings), "parsed");
  });

  test("does nothing when the placeholder is typed in again, or left, or the words are only spaces", () => {
    const before = read(BLANK_OPTION);
    assert.ok(live(write(before, [1, PLACEHOLDER_TEXT]), FindingCode.EmptyOption));
    assert.ok(live(write(before, [1, "   "]), FindingCode.EmptyOption));
    const reworded = write(before, [0, "Armchair"]);
    assert.ok(live(reworded, FindingCode.EmptyOption), "words written in another option are not the missing ones");
  });

  test("does not touch the importer's other findings, a key error among them", () => {
    const before = read("1) Which of these is a chair?\na. Chair\nb.  \nc. Desk\nAnswer: e\n");
    const withNote: Question = { ...before, findings: [...before.findings, finding(FindingCode.TypeInferred, "warn", "the type was guessed"), finding(FindingCode.UnsupportedType, "error", "kept as an essay")] };
    const after = write(withNote, [1, "Table"]);
    assert.equal(live(after, FindingCode.EmptyOption), false);
    for (const code of [FindingCode.KeyLetterMissing, FindingCode.TypeInferred, FindingCode.UnsupportedType]) assert.ok(live(after, code), `${code} is not a placeholder`);
  });

  test("goes at the next edit if it went stale before: a question already written over, whatever else is edited", () => {
    // What an earlier version left in a bank: the words are there, and the error still says they are not.
    const real = read("1) Which of these is a chair?\n*a. Chair\nb. Table\nc. Desk\n");
    const stale: Question = { ...real, findings: [...real.findings, finding(FindingCode.EmptyOption, "error", "Option B has no text.", { field: "body.options.1.content" })] };
    assert.equal(verdictFrom(stale.findings), "failed");
    const after = editQuestion(stale, { stem: plainToRich("Which of these can you sit on?") }, { by: "you", at: LATER });
    assert.equal(live(after, FindingCode.EmptyOption), false);
    assert.equal(verdictFrom(after.findings), "parsed");
  });

  test("tells a placeholder from words, a picture or an equation", () => {
    const option = (content: string): Option => ({ id: "o", content: plainToRich(content), correct: false });
    assert.equal(isPlaceholderOption(option(PLACEHOLDER_TEXT)), true);
    assert.equal(isPlaceholderOption(option("")), true);
    assert.equal(isPlaceholderOption(option("  (missing)  ")), true);
    assert.equal(isPlaceholderOption(option("Chair")), false);
    assert.equal(isPlaceholderOption({ id: "o", content: { format: "rich", content: '<oa-media ref="m1"></oa-media>' }, correct: false }), false, "a picture is an answer");
  });
});
