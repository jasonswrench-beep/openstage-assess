/**
 * What GIFT and Moodle XML write is what their own readers get back.
 *
 * A tester wrote twenty thousand random questions with hostile text through every exporter and read them back. For these two destinations
 * it found text and keys that came back different, with the exporter saying "exported" and the reader saying nothing: a stem that begins
 * `//` (a comment in GIFT, so the question vanished and its answers were left over), a stem that begins `[html]` (taken for the format
 * and lost), a title that ends in a colon (put `: ` at the start of the stem), a newline inside a formatted stem (deleted, so two words
 * ran together), an answer or a matching side that holds `->` (re-paired, or the whole question made a failed essay), an answer that
 * begins `%50%` (read as a weight, so the wrong option came back right), a number in exponent form (unreadable), and a Moodle matching
 * answer that looks like a tag (taken out as markup). The rule under test is the one every exporter keeps: what cannot be carried is left
 * out or reported, and what is carried comes back as it was.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { exportGift, plainNumber } from "../src/export/gift.ts";
import { exportMoodleXml } from "../src/export/moodle-xml.ts";
import { giftImporter } from "../src/import/gift.ts";
import { moodleXmlImporter } from "../src/import/moodle-xml.ts";
import { createQuestion } from "../src/model/create.ts";
import { verdictFrom } from "../src/model/findings.ts";
import type { Question, QuestionBody, QuestionType } from "../src/model/question.ts";
import { plainToRich, rich, richTextToPlain } from "../src/model/richtext.ts";

const AT = "2026-11-07T00:00:00.000Z";
const make = (type: QuestionType, body: QuestionBody, stem = "What is the capital of France?", extra: Partial<Parameters<typeof createQuestion>[0]> = {}): Question =>
  createQuestion({ type, stem: plainToRich(stem), body, by: "test", at: AT, ...extra });
const opt = (id: string, text: string, correct = false) => ({ id, content: plainToRich(text), correct });
const mc = (stem: string, options: Array<[string, boolean]>, extra: Partial<Parameters<typeof createQuestion>[0]> = {}): Question =>
  make("multipleChoice", { shuffle: true, options: options.map(([t, c], i) => opt(`o${i}`, t, c)) }, stem, extra);
const pairsOf = (...p: Array<[string, string]>): Question =>
  make("matching", { shuffle: true, distractors: [], pairs: p.map(([l, r], i) => ({ id: `p${i}`, left: plainToRich(l), right: r })) }, "Match each one.");

const toGift = (...questions: Question[]) => {
  const out = exportGift(questions, { name: "T" });
  return { text: out.files[0]?.content ?? "", report: out.report, items: out.report.items };
};
const fromGift = (text: string): Question[] => giftImporter.parse(text, { file: "t.gift", at: AT, author: "test" }).questions;
const plain = (q: Question): string => richTextToPlain(q.stem);
const rightOf = (q: Question): string[] => (q.body as unknown as { options: Array<{ content: never; correct: boolean }> }).options.filter((o) => o.correct).map((o) => richTextToPlain(o.content));

describe("a stem that GIFT would read as something else", () => {
  test("begins // : the question is not lost as a comment, and the others in the file are not either", () => {
    const odd = mc("// Given the code above, what does x equal?", [["1", false], ["2", true], ["3", false]]);
    const before = mc("First question?", [["a", true], ["b", false]]);
    const after = mc("Last question?", [["c", false], ["d", true]]);
    const { text } = toGift(before, odd, after);
    const back = fromGift(text);
    assert.equal(back.length, 3, text);
    assert.deepEqual(back.map(plain), ["First question?", "// Given the code above, what does x equal?", "Last question?"]);
    assert.deepEqual(back.map(rightOf), [["a"], ["2"], ["d"]]);
    assert.ok(back.every((q) => verdictFrom(q.findings) === "parsed"));
  });

  test("begins [html], [plain], [moodle] or [markdown] : the words are kept, not taken for the format", () => {
    for (const tag of ["[html]", "[plain]", "[moodle]", "[markdown]", "[HTML]", " [plain]"]) {
      const q = mc(`${tag} is a way of saying the text is markup. Which is true?`, [["Yes", true], ["No", false]]);
      const back = fromGift(toGift(q).text);
      assert.equal(back.length, 1, tag);
      assert.equal(plain(back[0] as Question), plain(q), tag);
      assert.deepEqual(rightOf(back[0] as Question), ["Yes"], tag);
      assert.equal(verdictFrom((back[0] as Question).findings), "parsed", tag);
    }
  });

  test("an ordinary stem is written as it always was, with no tag in front", () => {
    assert.ok(!/\[plain\]/.test(toGift(mc("What is 2+2?", [["4", true], ["5", false]])).text));
    assert.ok(!/\[plain\]/.test(toGift(mc("See [1] for the table.", [["4", true], ["5", false]])).text), "a bracket that is not one of the four tags");
  });
});

describe("a title in GIFT", () => {
  test("that ends in a colon, or holds a run of colons, is written without them, and the stem is untouched", () => {
    for (const [title, written] of [["Chapter 3:", "Chapter 3"], ["a::b", "a:b"], ["::x::", "x"], ["Why?:::", "Why?"], ["Ratio 3:2", "Ratio 3:2"]] as const) {
      const q = mc("The Earth is flat. Is that so?", [["No", true], ["Yes", false]], { title });
      const { text, items } = toGift(q);
      const back = fromGift(text);
      assert.equal(back.length, 1, title);
      assert.equal(plain(back[0] as Question), "The Earth is flat. Is that so?", `${title}: the stem keeps its first word`);
      assert.equal((back[0] as Question).title, written, title);
      const noted = (items[0]?.notes ?? []).some((n) => /title had colons/.test(n));
      assert.equal(noted, written !== title, `${title}: a changed title is said`);
    }
  });

  test("that is only colons is left out, and said", () => {
    const { text, items } = toGift(mc("Which is cold?", [["Ice", true], ["Fire", false]], { title: ":::" }));
    assert.ok((items[0]?.notes ?? []).some((n) => /It is left out/.test(n)));
    assert.equal((fromGift(text)[0] as Question).title, "Which is cold?", "it is named from the stem, as an untitled question is");
  });
});

describe("a formatted stem in GIFT", () => {
  test("keeps the line breaks inside its text: two words are not run together", () => {
    const q = createQuestion({ type: "multipleChoice", stem: rich("<p>Which of the following\nis <strong>true</strong>?</p>"), body: { shuffle: true, options: [opt("a", "x", true), opt("b", "y")] }, by: "test", at: AT });
    const back = fromGift(toGift(q).text)[0] as Question;
    assert.doesNotMatch(plain(back), /followingis/);
    assert.match(plain(back), /following\s+is/);
  });

  test("keeps the lines of a code block", () => {
    const q = createQuestion({ type: "multipleChoice", stem: rich("<p>After this runs:</p><pre>int x = 1;\nint y = 2;</pre><p>what is y?</p>"), body: { shuffle: true, options: [opt("a", "2", true), opt("b", "1")] }, by: "test", at: AT });
    const back = plain(fromGift(toGift(q).text)[0] as Question);
    assert.doesNotMatch(back, /1;int/);
    assert.match(back, /int x = 1;\s+int y = 2;/);
  });
});

describe("GIFT's own marks inside an answer", () => {
  const SAID = /GIFT reads as/;

  test("an arrow in an option, an accepted answer or either side of a pair leaves the question out and says why", () => {
    const questions: Question[] = [
      mc("Which is the contrapositive of p -> q?", [["NOT q -> NOT p", true], ["q -> p", false]]),
      make("shortAnswer", { caseSensitive: false, accepted: ["a -> b"] }, "Write the rule."),
      pairsOf(["p -> q", "Implication"], ["p AND q", "Conjunction"], ["NOT p", "Negation"]),
      pairsOf(["Implication", "p -> q"], ["Conjunction", "p AND q"], ["Negation", "NOT p"]),
    ];
    for (const q of questions) {
      const { text, items } = toGift(q);
      assert.equal(items[0]?.outcome, "leftOut", q.type);
      assert.match((items[0]?.notes ?? []).join(" "), SAID);
      assert.equal(fromGift(text).length, 0, `${q.type}: nothing is written that would come back wrong`);
    }
  });

  test("an arrow in the stem or in feedback is no harm, and the question is written", () => {
    const q = mc("What does p -> q mean?", [["If p then q", true], ["p and q", false]]);
    const { text, items } = toGift(q);
    assert.notEqual(items[0]?.outcome, "leftOut");
    assert.deepEqual(rightOf(fromGift(text)[0] as Question), ["If p then q"]);
  });

  test("an option that begins with a percentage is left out of a single answer question, so it cannot be read as a weight", () => {
    const q = mc("Which is the weight shown?", [["%50% of grade", false], ["Half", true], ["None", false]]);
    const { text, items } = toGift(q);
    assert.equal(items[0]?.outcome, "leftOut");
    assert.match((items[0]?.notes ?? []).join(" "), /percent signs/);
    assert.equal(fromGift(text).length, 0);
    // A short answer too, and the left side of a pair.
    assert.equal(toGift(make("shortAnswer", { caseSensitive: false, accepted: ["%50% done"] }, "Say it.")).items[0]?.outcome, "leftOut");
    assert.equal(toGift(pairsOf(["%50% of", "Half"], ["Whole", "All"], ["None", "Zero"])).items[0]?.outcome, "leftOut");
  });

  test("a multiple response writes a weight of its own, so a percentage in the words that follow is only words", () => {
    const q = make("multipleResponse", { shuffle: true, partialCredit: true, options: [opt("a", "%50% of grade", true), opt("b", "Half", true), opt("c", "None")] }, "Pick the halves.");
    const { text, items } = toGift(q);
    assert.notEqual(items[0]?.outcome, "leftOut");
    const back = fromGift(text)[0] as Question;
    assert.deepEqual(rightOf(back), ["%50% of grade", "Half"]);
  });

  test("a percent sign that does not start a weight is no harm", () => {
    for (const text of ["50% of grade", "Grade %50", "A %50% B", "100%"]) {
      const q = mc("Which?", [[text, true], ["Other", false]]);
      assert.notEqual(toGift(q).items[0]?.outcome, "leftOut", text);
      assert.deepEqual(rightOf(fromGift(toGift(q).text)[0] as Question), [text], text);
    }
  });
});

describe("a number in GIFT", () => {
  test("is written in plain digits, and any exponent a file has is read", () => {
    assert.equal(plainNumber(6.67e-11), "0.0000000000667");
    assert.equal(plainNumber(1e21), "1000000000000000000000");
    assert.equal(plainNumber(1.5e-7), "0.00000015");
    assert.equal(plainNumber(-2.5e-8), "-0.000000025");
    assert.equal(plainNumber(1.2345e22), "12345000000000000000000");
    assert.equal(plainNumber(42), "42");
    assert.equal(plainNumber(-0.5), "-0.5");
    assert.equal(plainNumber(0), "0");
    for (const n of [6.67e-11, 1e21, 1.5e-7, -2.5e-8, 1.2345e22, 123456.789, 1e-6, 9.99e-7]) assert.equal(Number(plainNumber(n)), n, String(n));
  });

  test("a numeric question comes back with the same value, range and tolerance", () => {
    const numeric = (body: Record<string, unknown>): Question => make("numeric", body as QuestionBody, "What is the value?");
    for (const body of [{ mode: "exact", value: 6.67e-11 }, { mode: "exact", value: 1e21 }, { mode: "range", min: 1e-9, max: 2.5e-8 }, { mode: "tolerance", value: 3e-7, tolerance: 1e-9 }]) {
      const { text } = toGift(numeric(body));
      assert.doesNotMatch(text, /\de[+-]?\d/i, "no exponent is written");
      const back = fromGift(text)[0] as Question;
      assert.equal(back.type, "numeric", JSON.stringify(body));
      assert.deepEqual({ ...(back.body as unknown as Record<string, unknown>) }, body, JSON.stringify(body));
    }
  });

  test("a file that has an exponent is read as that number", () => {
    const one = fromGift("What is G? {#6.67e-11}")[0] as Question;
    assert.deepEqual(one.body, { mode: "exact", value: 6.67e-11 });
    assert.deepEqual((fromGift("Big? {#1E+21}")[0] as Question).body, { mode: "exact", value: 1e21 });
    assert.deepEqual((fromGift("Range? {#1e-3..2e3}")[0] as Question).body, { mode: "range", min: 1e-3, max: 2e3 });
    assert.deepEqual((fromGift("Near? {#5:1e-1}")[0] as Question).body, { mode: "tolerance", value: 5, tolerance: 0.1 });
    assert.equal(verdictFrom(one.findings), "parsed");
  });
});

describe("an essay with a rubric and an expected length", () => {
  test("is written by GIFT and Moodle XML with a note for each thing they cannot carry, as the other exporters give", () => {
    const essay = make("essay", { rubric: [{ id: "r1", criterion: "Clarity", levels: [{ points: 2, description: "Clear" }] }], expectedWords: 300 } as unknown as QuestionBody, "Discuss the idea.");
    for (const items of [toGift(essay).items, exportMoodleXml([essay], { name: "T" }).report.items]) {
      const notes = (items[0]?.notes ?? []).join(" | ");
      assert.match(notes, /rubric cannot be carried/);
      assert.match(notes, /expected length cannot be carried/);
      assert.equal(items[0]?.outcome, "exportedWithLosses");
    }
    const plainEssay = make("essay", {}, "Discuss the idea.");
    assert.ok(!(toGift(plainEssay).items[0]?.notes ?? []).some((n) => /rubric|expected length/.test(n)));
  });
});

describe("a Moodle matching answer that looks like a tag", () => {
  const roundTrip = (q: Question): Question => {
    const file = exportMoodleXml([q], { name: "T" }).files[0];
    assert.ok(file, "something was written");
    return moodleXmlImporter.parse(file.content, { file: "t.xml", at: AT, author: "test" }).questions[0] as Question;
  };
  const rights = (q: Question): string[] => (q.body as unknown as { pairs: Array<{ right: string }> }).pairs.map((p) => p.right);

  test("comes back as written: the tag is words, not markup to take out", () => {
    const q = pairsOf(["Line break", "<br> inserts a line break"], ["Paragraph", "<p> starts a paragraph"], ["Bold", "<b> makes text bold"]);
    assert.deepEqual(rights(roundTrip(q)), ["<br> inserts a line break", "<p> starts a paragraph", "<b> makes text bold"]);
  });

  test("a bare tag is not read as nothing", () => {
    const back = roundTrip(pairsOf(["Line break", "<br>"], ["Paragraph", "<p>"], ["Bold", "<b>"]));
    assert.deepEqual(rights(back), ["<br>", "<p>", "<b>"]);
    assert.equal(verdictFrom(back.findings), "parsed");
  });

  test("three answers that differ only after a tag stay three answers", () => {
    assert.deepEqual(rights(roundTrip(pairsOf(["a", "<br> tag"], ["b", "<p> tag"], ["c", "<b> tag"]))), ["<br> tag", "<p> tag", "<b> tag"]);
  });

  test("an answer marked as HTML is still read as markup, and a lone paragraph around plain text is taken off", () => {
    const xml = (answerAttr: string, text: string): string =>
      `<?xml version="1.0"?><quiz><question type="matching"><name><text>M</text></name><questiontext format="html"><text>Match.</text></questiontext>` +
      [["a", "x"], ["b", "y"], ["c", text]].map(([l, r]) => `<subquestion format="html"><text>${l}</text><answer${answerAttr}><text>${r}</text></answer></subquestion>`).join("") +
      `</question></quiz>`;
    const read = (answerAttr: string, text: string): string[] => rights(moodleXmlImporter.parse(xml(answerAttr, text), { file: "t.xml", at: AT, author: "test" }).questions[0] as Question);
    assert.deepEqual(read(' format="html"', "&lt;b&gt;bold&lt;/b&gt; word"), ["x", "y", "bold word"], "marked as HTML, so it is markup");
    assert.deepEqual(read("", "&lt;p&gt;Paris&lt;/p&gt;"), ["x", "y", "Paris"], "a lone paragraph around the whole text");
    assert.deepEqual(read("", "&lt;p&gt;one&lt;/p&gt;&lt;p&gt;two&lt;/p&gt;"), ["x", "y", "<p>one</p><p>two</p>"], "two paragraphs are the words");
  });
});
