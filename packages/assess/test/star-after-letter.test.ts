/**
 * An asterisk typed after the option's letter ("c. *Mars"), the way an instructor marks
 * the right option in a bank typed by hand.
 *
 * The first bank of this kind imported 3 questions of 28: every choice question failed
 * for having no key, which was true and not useful. The asterisk could not simply be
 * read as the key, because after the letter it can also begin an option's own words, and
 * a wrong key that looks authored is worse than none. So it is a key only as a habit of
 * the whole file, on the same terms as a mark made with formatting, and each of those
 * terms is tried here.
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
const word = (lines: string[]): ImportResult =>
  wordImporter.parseBytes(docx({ body: lines.map((l) => paragraph(run(l))).join("") }), { ...OPTIONS, file: "t.docx" });

const body = (q: Question): Record<string, any> => q.body as Record<string, any>;
const plain = (rich: Parameters<typeof richTextToPlain>[0]): string => richTextToPlain(rich).replace(/\s+/g, " ").trim();
const keyOf = (q: Question): string => (body(q)["options"] as Array<{ correct?: boolean }>).map((o) => (o.correct ? "X" : ".")).join("");
const wordsOf = (q: Question): string[] => (body(q)["options"] as Array<{ content: Parameters<typeof plain>[0] }>).map((o) => plain(o.content));
const has = (q: Question, code: string): boolean => q.findings.some((f) => f.code === code);
const fileHas = (result: ImportResult, code: string) => result.fileFindings.find((f) => f.code === code);

const NAMES = ["Sirius", "Mars", "Vega", "Rigel"];

/** A question typed by hand: the right option marked after its letter, before it, or not at all. */
function mc(n: number, correct: number | undefined, how: "after" | "before" = "after", words: string[] = NAMES): string[] {
  return [
    `${n}) Which is number ${n}?`,
    ...words.map((w, i) => {
      const letter = "abcdefgh"[i];
      if (i !== correct) return `${letter}.   ${w}`;
      return how === "after" ? `${letter}.   *${w}` : `*${letter}.   ${w}`;
    }),
  ];
}

/** `n` questions with the key after the letter, the right option moving along so that no position is the habit. */
const starred = (n: number, from = 1): string[] => Array.from({ length: n }, (_, i) => mc(from + i, i % 4)).flat();

describe("an asterisk after the option letter, as a habit of the file", () => {
  test("is the key when the file does it in most choice questions, and is taken out of the option's words", () => {
    const result = text(starred(4));
    assert.equal(result.questions.length, 4);
    result.questions.forEach((q, i) => {
      assert.equal(keyOf(q), "....".split("").map((_, k) => (k === i % 4 ? "X" : ".")).join(""), `question ${i + 1}`);
      assert.deepEqual(wordsOf(q), NAMES, "no asterisk is left in the words");
      assert.equal(verdictFrom(q.findings), "parsed", `question ${i + 1}: ${q.findings.map((f) => f.message).join(" / ")}`);
    });
    assert.deepEqual(result.counts, { parsed: 4, needsReview: 0, failed: 0, orphans: 0 });
  });

  test("is said once for the file, so that the author can confirm what the asterisk means", () => {
    const used = fileHas(text(starred(4)), FindingCode.StarAfterLetterKeyUsed);
    assert.ok(used, "the file says it");
    assert.equal(used.severity, "warn");
    assert.match(used.message, /4 of 4 choice questions/);
    assert.match(used.message, /Check that the asterisk does mean the correct answer/);
  });

  test("reads the same from a Word file typed the same way", () => {
    const lines = starred(5);
    const typed = text(lines);
    const inWord = word(lines);
    assert.equal(inWord.questions.length, 5);
    inWord.questions.forEach((q, i) => {
      assert.equal(keyOf(q), keyOf(typed.questions[i] as Question));
      assert.deepEqual(wordsOf(q), NAMES);
    });
    assert.ok(fileHas(inWord, FindingCode.StarAfterLetterKeyUsed));
    assert.deepEqual(inWord.counts, typed.counts);
  });

  test("a space between the asterisk and the words is allowed", () => {
    const lines = starred(3).map((l) => l.replace("*", "* "));
    const result = text(lines);
    assert.equal(keyOf(result.questions[0] as Question), "X...");
    assert.deepEqual(wordsOf(result.questions[0] as Question), NAMES);
  });

  test("is the answer of a true or false question under a heading that says so", () => {
    const lines = ["True or False"];
    const answers = [true, true, false, true];
    answers.forEach((a, i) => lines.push(`${i + 1}) Statement ${i + 1}.`, a ? "a.   *True" : "a.   True", a ? "b.   False" : "b.   *False"));
    const result = text(lines);
    assert.equal(result.questions.length, 4);
    result.questions.forEach((q, i) => {
      assert.equal(q.type, "trueFalse");
      assert.equal(body(q)["correct"], answers[i]);
      assert.equal(verdictFrom(q.findings), "parsed", q.findings.map((f) => f.message).join(" / "));
    });
  });

  test("two asterisks in a question are two right answers, as the format's own asterisk is", () => {
    const result = text([...starred(3), "4) Which are planets?", "a.   *Mars", "b.   Vega", "c.   *Venus", "d.   Rigel"]);
    const q = result.questions[3] as Question;
    assert.equal(q.type, "multipleResponse");
    assert.equal(keyOf(q), "X.X.");
  });
});

describe("what keeps a typed asterisk from being a key", () => {
  test("a file that has one in only two questions keeps it as text, flags the questions and says why", () => {
    const result = text([...mc(1, 1), ...mc(2, 2)]);
    for (const q of result.questions) {
      assert.ok(has(q, FindingCode.NoAnswerKey), "no key was taken");
      assert.equal(verdictFrom(q.findings), "failed");
      assert.ok(!(body(q)["options"] as Array<{ correct?: boolean }>).some((o) => o.correct));
    }
    assert.ok(wordsOf(result.questions[0] as Question).includes("*Mars"), "the asterisk was left where it was typed");
    const said = fileHas(result, FindingCode.StarAfterLetterKeyUnclear);
    assert.ok(said, "the file says why no key was read");
    assert.equal(said.severity, "warn");
    assert.match(said.message, /2 of 2 choice questions/);
    assert.match(said.message, /at least 3 questions and 80 percent/);
    assert.equal(fileHas(result, FindingCode.StarAfterLetterKeyUsed), undefined);
  });

  test("three questions are enough, if they are most of the choice questions", () => {
    assert.ok(fileHas(text(starred(3)), FindingCode.StarAfterLetterKeyUsed));
  });

  test("80 percent of the choice questions is enough and less is not", () => {
    const plain4 = (from: number, n: number) => Array.from({ length: n }, (_, i) => mc(from + i, undefined)).flat();
    // Four of five is exactly 80 percent.
    const enough = text([...starred(4), ...plain4(5, 1)]);
    assert.ok(fileHas(enough, FindingCode.StarAfterLetterKeyUsed));
    assert.equal(enough.questions.filter((q) => keyOf(q).includes("X")).length, 4);
    // Three of five is 60.
    const short = text([...starred(3), ...plain4(4, 2)]);
    assert.equal(fileHas(short, FindingCode.StarAfterLetterKeyUsed), undefined);
    assert.ok(fileHas(short, FindingCode.StarAfterLetterKeyUnclear));
    assert.ok(short.questions.every((q) => !keyOf(q).includes("X")), "no key was taken from a habit the file does not have");
  });

  test("a question with no asterisk in a file that has the habit is flagged, not given a key", () => {
    const result = text([...starred(5), ...mc(6, undefined)]);
    const last = result.questions[5] as Question;
    assert.ok(has(last, FindingCode.NoAnswerKey));
    assert.equal(verdictFrom(last.findings), "failed");
    assert.ok(!keyOf(last).includes("X"));
    assert.equal(result.questions.filter((q) => verdictFrom(q.findings) === "parsed").length, 5);
  });

  test("an asterisk in front of every option says nothing, so that question is left as typed", () => {
    const allStarred = ["6) Which is number 6?", ...NAMES.map((w, i) => `${"abcd"[i]}.   *${w}`)];
    const result = text([...starred(5), ...allStarred]);
    const last = result.questions[5] as Question;
    assert.ok(has(last, FindingCode.NoAnswerKey));
    assert.deepEqual(wordsOf(last), NAMES.map((w) => `*${w}`));
    assert.ok(fileHas(result, FindingCode.StarAfterLetterKeyUsed), "the other five still set the habit");
  });

  test("two asterisks in a row are the start of the words, not a mark", () => {
    const lines = starred(3);
    lines[lines.findIndex((l) => l.startsWith("b."))] = "b.   **kwargs";
    const result = text(lines);
    const q = result.questions[0] as Question;
    assert.equal(wordsOf(q)[1], "**kwargs");
    assert.equal(keyOf(q), "X...");
  });

  test("an asterisk that ends the words, or comes alone, is not a mark", () => {
    const odd = text([...starred(3), "4) Pick one.", "a.   Mars*", "b.   *", "c.   Vega", "d.   Rigel"]);
    const q = odd.questions[3] as Question;
    assert.ok(has(q, FindingCode.NoAnswerKey));
    assert.deepEqual(wordsOf(q), ["Mars*", "*", "Vega", "Rigel"]);
  });

  test("only choice questions are counted, so the essays around them do not dilute the habit", () => {
    const essays = ["Essay", "1) Discuss the habit.", "2) Discuss it again.", "3) And once more.", "4) Last time."];
    const result = text([...starred(3), ...essays]);
    assert.ok(fileHas(result, FindingCode.StarAfterLetterKeyUsed));
    assert.match(fileHas(result, FindingCode.StarAfterLetterKeyUsed)?.message ?? "", /3 of 3 choice questions/);
  });

  test("a question with no options is not a choice question, whether or not a heading says so", () => {
    const bare = ["4) Explain the habit.", "5) Explain it again.", "6) And once more.", "7) Last time."];
    const result = text([...starred(3), ...bare]);
    assert.match(fileHas(result, FindingCode.StarAfterLetterKeyUsed)?.message ?? "", /3 of 3 choice questions/);
  });

  test("the lettered parts of an essay are not a choice question, so they do not dilute the habit either", () => {
    const parts = ["Essay", "1) Discuss the habit in two parts.", "a.   Define it.", "b.   Defend it."];
    const result = text([...starred(3), ...parts]);
    assert.match(fileHas(result, FindingCode.StarAfterLetterKeyUsed)?.message ?? "", /3 of 3 choice questions/);
    const essay = result.questions[3] as Question;
    assert.equal(essay.type, "essay", "the parts are not mistaken for options with a key");
  });
});

describe("an asterisk after the letter next to the other ways of giving a key", () => {
  test("the format's own asterisk, before the letter, is read as ever and does not count toward the habit", () => {
    const result = text([...starred(4), ...mc(5, 2, "before")]);
    assert.equal(keyOf(result.questions[4] as Question), "..X.");
    assert.match(fileHas(result, FindingCode.StarAfterLetterKeyUsed)?.message ?? "", /4 of 5 choice questions/);
  });

  test("a question that already has the format's own asterisk is left as it is, and a second one after a letter stays text", () => {
    const result = text([...starred(4), "5) Pick one.", "*a.   Sirius", "b.   *Mars", "c.   Vega", "d.   Rigel"]);
    const q = result.questions[4] as Question;
    assert.equal(keyOf(q), "X...");
    assert.equal(wordsOf(q)[1], "*Mars");
    assert.match(fileHas(result, FindingCode.StarAfterLetterKeyUsed)?.message ?? "", /4 of 5 choice questions/);
  });

  test("the asterisk is not part of the option's words when formatting is read, so bold on the words still counts", () => {
    // Four questions give the key twice, an asterisk after the letter and bold on the words, the asterisk
    // itself plain; the fifth only by bold. If the asterisk were counted as the first of the words, bold would
    // not cover all of them in the first four and would not be a habit of the file, so the fifth would have no key.
    const choice = (n: number, key: number, star: boolean): string => {
      const items = NAMES.map((w, i) => {
        const letter = "abcd"[i];
        if (i !== key) return paragraph(run(`${letter}.   ${w}`));
        return paragraph(run(`${letter}.   ${star ? "*" : ""}`) + run(w, "<w:b/>"));
      });
      return paragraph(run(`${n}) Which is number ${n}?`)) + items.join("");
    };
    const result = wordImporter.parseBytes(
      docx({ body: [choice(1, 0, true), choice(2, 1, true), choice(3, 2, true), choice(4, 3, true), choice(5, 1, false)].join("") }),
      { ...OPTIONS, file: "t.docx" },
    );
    assert.equal(result.questions.length, 5);
    assert.ok(fileHas(result, FindingCode.StarAfterLetterKeyUsed));
    assert.equal(keyOf(result.questions[4] as Question), ".X..", "the fifth is keyed by the bold the first four also have");
    assert.ok(fileHas(result, FindingCode.FormattingKeyUsed));
    assert.equal(verdictFrom((result.questions[0] as Question).findings), "parsed");
  });

  test("an Answer line that names another option than the asterisk is said, and neither is trusted", () => {
    const lines = starred(4);
    lines.splice(5, 0, "Answer: C");
    const result = text(lines);
    const q = result.questions[0] as Question;
    assert.ok(has(q, FindingCode.KeysDisagree), q.findings.map((f) => f.message).join(" / "));
    assert.notEqual(verdictFrom(q.findings), "parsed");
  });

  test("an Answer line that agrees with the asterisk is no trouble", () => {
    const lines = starred(4);
    lines.splice(5, 0, "Answer: A");
    const q = text(lines).questions[0] as Question;
    assert.ok(!has(q, FindingCode.KeysDisagree));
    assert.equal(keyOf(q), "X...");
  });

  test("a lone typed asterisk in a short bank is still not a key, as before", () => {
    const result = text(["1. Pick one.", "a. Sirius", "b. *Mars"]);
    assert.ok(has(result.questions[0] as Question, FindingCode.NoAnswerKey));
  });
});

describe("the chapter it was made for", () => {
  test("every question typed as the instructor's manual types it reads once, with its key", () => {
    // Three sections that each restart at 1, the options after three spaces, a title line above.
    const lines = [
      "TEST BANK",
      "Multiple Choice",
      ...[2, 3, 0, 1].flatMap((k, i) => mc(i + 1, k)),
      "True or False",
      "1) First claim.",
      "a.   *True",
      "b.   False",
      "2) Second claim.",
      "a.   True",
      "b.   *False",
      "3) Third claim.",
      "a.   *True",
      "b.   False",
      "Essay",
      "1) Discuss.",
    ];
    for (const result of [text(lines), word(lines)]) {
      assert.equal(result.questions.length, 8);
      assert.deepEqual(result.questions.map((q) => q.type), [...Array(4).fill("multipleChoice"), "trueFalse", "trueFalse", "trueFalse", "essay"]);
      assert.deepEqual(result.questions.slice(0, 4).map(keyOf), ["..X.", "...X", "X...", ".X.."]);
      assert.deepEqual(result.questions.slice(4, 7).map((q) => body(q)["correct"]), [true, false, true]);
      assert.equal(result.counts.failed, 0);
      assert.equal(result.orphans.length, 1, "the title line is reported, not dropped");
    }
  });
});
