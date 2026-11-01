/**
 * An answer chosen by hand. An importer says what is wrong with the key the FILE gave ("the Answer line says Verbally bullying
 * after the letter B, but option B reads Verbal bullying", "the answer key names option E, which this question does not have"),
 * and those findings were kept when a person then marked the right answer, so the question stayed Failed under an error that
 * the screen says goes when the question is fixed. This is the rule that settles it: an answer chosen by hand replaces what the
 * file's key said, and only then; what the file said is kept beside it, dismissed; and nothing is chosen for the person. The text
 * is invented.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { standardTextImporter } from "../src/import/standard-text.ts";
import { createQuestion, editQuestion } from "../src/model/create.ts";
import { finding, FindingCode, liveFindings, verdictFrom } from "../src/model/findings.ts";
import { plainToRich } from "../src/model/richtext.ts";
import type { Option, Question, QuestionBody } from "../src/model/question.ts";
import { answerOf, hasUsableKey } from "../src/quality/answer-key.ts";

const OPTIONS = { file: "t.txt", at: "2026-01-01T00:00:00.000Z", author: "test" };
const LATER = "2026-02-02T00:00:00.000Z";
const read = (lines: string[]): Question => standardTextImporter.parse(lines.join("\n"), OPTIONS).questions[0] as Question;
const optionsOf = (q: Question): Option[] => (q.body as unknown as { options: Option[] }).options;
const live = (q: Question, code: string): boolean => liveFindings(q.findings).some((f) => f.code === code);

/** The question with exactly these options marked right, chosen as the screen does: by editing the body. */
const choose = (q: Question, ...ticked: number[]): Question =>
  editQuestion(q, { body: { ...q.body, options: optionsOf(q).map((o, i) => ({ ...o, correct: ticked.includes(i) })) } as QuestionBody }, { by: "you", at: LATER });

// The two ways a file's key fails that the repair screen was seen to keep.
const DISAGREES = ["1. Which of these is a fruit?", "a. Chair", "b. Apple", "c. Desk", "Answer: a. Apple"];
const NO_SUCH_OPTION = ["1. Which of these is a fruit?", "a. Chair", "b. Apple", "c. Desk", "Answer: e"];

describe("an answer chosen by hand", () => {
  test("replaces the error about an Answer line whose letter and words disagreed, and keeps what the file said", () => {
    const before = read(DISAGREES);
    assert.equal(verdictFrom(before.findings), "failed");
    assert.ok(live(before, FindingCode.KeysDisagree));
    assert.equal(hasUsableKey(before), false);

    const after = choose(before, 1);
    assert.equal(verdictFrom(after.findings), "parsed", "the question stops being a failure");
    assert.equal(hasUsableKey(after), true);
    assert.equal(live(after, FindingCode.KeysDisagree), false);

    const kept = after.findings.find((f) => f.code === FindingCode.KeysDisagree);
    assert.ok(kept, "what the file said is kept, not deleted");
    assert.equal(kept?.dismissed, true);
    assert.equal(kept?.dismissedBy, "you");
    assert.equal(kept?.dismissedAt, LATER);
    assert.equal(kept?.message, before.findings.find((f) => f.code === FindingCode.KeysDisagree)?.message, "and it still says it");
    assert.match(after.history.at(-1)?.change ?? "", /the answer was chosen, so what the file's key said no longer applies \(import\.keys-disagree\)/);
  });

  test("replaces the error about a key that named an option the question does not have", () => {
    const before = read(NO_SUCH_OPTION);
    assert.ok(live(before, FindingCode.KeyLetterMissing));
    const after = choose(before, 2);
    assert.equal(live(after, FindingCode.KeyLetterMissing), false);
    assert.equal(verdictFrom(after.findings), "parsed");
    assert.equal(hasUsableKey(after), true);
  });

  test("is the person's own answer, whichever it is: it does not have to be the one the file seemed to mean", () => {
    // The Answer line says Apple after the letter A. Choosing A, the letter, is as much theirs as choosing B, the words.
    for (const ticked of [0, 1, 2]) {
      const after = choose(read(DISAGREES), ticked);
      assert.deepEqual(optionsOf(after).map((o) => o.correct), [0, 1, 2].map((i) => i === ticked));
      assert.equal(verdictFrom(after.findings), "parsed", `option ${ticked}`);
    }
  });

  test("is not chosen for anyone: an edit that leaves the answer alone leaves what the file said", () => {
    const before = read(DISAGREES);
    const reworded = editQuestion(before, { stem: plainToRich("Which of these grows on a tree?") }, { by: "you", at: LATER });
    assert.ok(live(reworded, FindingCode.KeysDisagree), "a new stem is not an answer");
    assert.equal(verdictFrom(reworded.findings), "failed");
    const retitled = editQuestion(before, { title: "Fruit" }, { by: "you", at: LATER });
    assert.ok(live(retitled, FindingCode.KeysDisagree));
    // Nor is marking nothing, which is what there already was.
    assert.ok(live(choose(before), FindingCode.KeysDisagree));
  });

  test("is not a new answer when only the words of an option change, or a wrong one is taken away", () => {
    const keyed = createQuestion({
      type: "multipleChoice",
      stem: plainToRich("Which?"),
      body: { shuffle: true, options: [{ id: "o1", content: plainToRich("One"), correct: true }, { id: "o2", content: plainToRich("Two"), correct: false }, { id: "o3", content: plainToRich("Three"), correct: false }] },
      findings: [finding(FindingCode.KeyLetterMissing, "error", "The answer key names option E, which this question does not have.")],
      by: "t",
      at: OPTIONS.at,
    });
    const options = optionsOf(keyed);
    const reworded = editQuestion(keyed, { body: { shuffle: true, options: [{ ...(options[0] as Option), content: plainToRich("Uno") }, options[1] as Option, options[2] as Option] } }, { by: "you", at: LATER });
    assert.equal(answerOf(reworded), answerOf(keyed));
    assert.ok(live(reworded, FindingCode.KeyLetterMissing), "the file's key was still the one applied");
    const trimmed = editQuestion(keyed, { body: { shuffle: true, options: [options[0] as Option, options[1] as Option] } }, { by: "you", at: LATER });
    assert.ok(live(trimmed, FindingCode.KeyLetterMissing));
  });

  test("is not an answer if it is not a usable one: two marked on a single-answer question leaves the findings", () => {
    const before = read(NO_SUCH_OPTION);
    const two = choose(before, 0, 1);
    assert.ok(live(two, FindingCode.KeyLetterMissing));
    assert.ok(live(two, FindingCode.MultipleKeysOnSingleAnswer));
    assert.equal(verdictFrom(two.findings), "failed");
    // And when they then settle on one, it is theirs.
    const one = choose(two, 1);
    assert.equal(live(one, FindingCode.KeyLetterMissing), false);
    assert.equal(verdictFrom(one.findings), "parsed");
  });

  test("leaves every other problem an importer found: only what the file's key said is replaced", () => {
    const before = read(NO_SUCH_OPTION);
    const withOthers: Question = {
      ...before,
      findings: [...before.findings, finding(FindingCode.UnsupportedType, "error", "kept as an essay"), finding(FindingCode.EmptyOption, "error", "an option had no text"), finding(FindingCode.TypeInferred, "warn", "the type was guessed")],
    };
    const after = choose(withOthers, 1);
    for (const code of [FindingCode.UnsupportedType, FindingCode.EmptyOption, FindingCode.TypeInferred]) assert.ok(live(after, code), code);
    assert.equal(live(after, FindingCode.KeyLetterMissing), false);
    assert.equal(hasUsableKey(after), false, "a question kept as an essay, or with a placeholder option, is still not ready");
  });

  test("works for a multiple response, a true or false and a short answer, whose keys are not letters", () => {
    const missing = (type: "multipleResponse" | "trueFalse" | "shortAnswer", body: QuestionBody, code = FindingCode.KeyLetterMissing, severity: "error" | "info" = "error"): Question =>
      createQuestion({ type, stem: plainToRich("Which?"), body, findings: [finding(code, severity, "the file's key was not applied")], by: "t", at: OPTIONS.at });

    const multiple = missing("multipleResponse", { shuffle: true, partialCredit: true, options: ["A", "B", "C"].map((t, i) => ({ id: `o${i}`, content: plainToRich(t), correct: i === 0 })) });
    const chosen = choose(multiple, 0, 2);
    assert.equal(live(chosen, FindingCode.KeyLetterMissing), false, "a different set of right answers is an answer");

    const tf = missing("trueFalse", {}, FindingCode.KeyLetterMissing, "info");
    assert.ok(live(tf, FindingCode.KeyLetterMissing));
    assert.equal(live(editQuestion(tf, { body: { correct: true } }, { by: "you", at: LATER }), FindingCode.KeyLetterMissing), false);

    const short = missing("shortAnswer", { caseSensitive: false, accepted: [] }, FindingCode.KeyLetterMissing, "info");
    assert.equal(live(editQuestion(short, { body: { caseSensitive: false, accepted: ["Nile"] } }, { by: "you", at: LATER }), FindingCode.KeyLetterMissing), false);
    // Whether case counts is not an answer. This one already has one, so only the wording of the rule differs between the two.
    const answered = missing("shortAnswer", { caseSensitive: false, accepted: ["Nile"] });
    assert.ok(live(editQuestion(answered, { body: { caseSensitive: true, accepted: ["Nile"] } }, { by: "you", at: LATER }), FindingCode.KeyLetterMissing), "case is not an answer");
    assert.equal(live(editQuestion(answered, { body: { caseSensitive: false, accepted: ["Nile", "the Nile"] } }, { by: "you", at: LATER }), FindingCode.KeyLetterMissing), false, "another accepted answer is");
  });

  test("keeps a dismissal someone made, and says who replaced the rest", () => {
    const before = read(NO_SUCH_OPTION);
    const note: Question = { ...before, findings: [...before.findings, { ...finding(FindingCode.TypeInferred, "warn", "the type was guessed"), dismissed: true, dismissedBy: "someone", dismissedAt: "2026-01-05T00:00:00.000Z" }] };
    const after = choose(note, 1);
    const earlier = after.findings.find((f) => f.code === FindingCode.TypeInferred);
    assert.equal(earlier?.dismissedBy, "someone", "an earlier dismissal is not rewritten");
    assert.equal(after.findings.find((f) => f.code === FindingCode.KeyLetterMissing)?.dismissedBy, "you");
  });
});
