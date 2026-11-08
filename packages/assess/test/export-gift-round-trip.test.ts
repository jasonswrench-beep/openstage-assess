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

import { exportBlackboardUpload } from "../src/export/blackboard-upload.ts";
import { exportD2lCsv } from "../src/export/d2l-csv.ts";
import { exportGift, plainNumber, withoutBlockBreaks } from "../src/export/gift.ts";
import { exportCommonCartridge } from "../src/export/common-cartridge.ts";
import { exportMoodleXml } from "../src/export/moodle-xml.ts";
import { exportQti12 } from "../src/export/qti12.ts";
import { exportQti21 } from "../src/export/qti21.ts";
import { importerForContent, runImporter } from "../src/import/registry.ts";
import { giftImporter } from "../src/import/gift.ts";
import { moodleXmlImporter, shortenPictureData } from "../src/import/moodle-xml.ts";
import { createQuestion } from "../src/model/create.ts";
import { verdictFrom } from "../src/model/findings.ts";
import type { Question, QuestionBody, QuestionType } from "../src/model/question.ts";
import { mediaPlaceholder, plainToRich, rich, richTextToPlain } from "../src/model/richtext.ts";
import { png } from "./support/images.ts";

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

// Found by a reviewer of the fixes above, each in code that had just been written for the faults before.
describe("the second reading of the fixes", () => {
  test("a title of colons and spaces at its end is written without them, whatever order they come in", () => {
    for (const [title, written] of [["Part 2: :", "Part 2"], ["T:: :", "T"], [": : Title : :", "Title"], ["a : b", "a : b"]] as const) {
      const back = fromGift(toGift(mc("Is the sky blue?", [["Yes", true], ["No", false]], { title })).text)[0] as Question;
      assert.equal(back.title, written, title);
      assert.equal(plain(back), "Is the sky blue?", `${title}: the stem is untouched`);
    }
  });

  test("a newline between two inline tags stays a space, and one next to a block tag is nothing", () => {
    const q = createQuestion({ type: "multipleChoice", stem: rich("<p>Read the <strong>following</strong>\n<code>code</code> carefully.</p>"), body: { shuffle: true, options: [opt("a", "x", true), opt("b", "y")] }, by: "test", at: AT });
    assert.match(plain(fromGift(toGift(q).text)[0] as Question), /following\s+code/);
    assert.equal(withoutBlockBreaks("<p>a</p>\n<p>b</p>"), "<p>a</p><p>b</p>");
    // The indentation after a newline is left: spaces between block tags are nothing in HTML, and no newline is left to run words together.
    assert.equal(withoutBlockBreaks("<ul>\n  <li>a</li>\n  <li>b</li>\n</ul>"), "<ul>  <li>a</li>  <li>b</li></ul>");
    assert.equal(withoutBlockBreaks("<strong>a</strong>\n<em>b</em>"), "<strong>a</strong>\n<em>b</em>");
    assert.equal(withoutBlockBreaks("<pre>x\ny</pre>"), "<pre>x\ny</pre>");
    assert.equal(withoutBlockBreaks("<p>a</p>\n\n<p>b</p>"), "<p>a</p><p>b</p>", "each of two newlines touches a block tag, one on each side");
    assert.equal(withoutBlockBreaks("<p>a</p>\n\n\n<p>b</p>"), "<p>a</p>\n<p>b</p>", "of three, the one in the middle touches neither and is whitespace");
    const started = performance.now();
    withoutBlockBreaks(`<p>${" ".repeat(200000)}</p>${"\n".repeat(50000)}<p>x</p>`);
    assert.ok(performance.now() - started < 1000, "a long run of white space is not scanned again for every place in it");
  });

  test("a plain general feedback beside a formatted stem comes back as written, with its angle brackets and ampersands", () => {
    for (const note of ["Use the <script> tag and the <em>em</em> tag.", "Remember that a <b and c> d.", "Write &amp; for an ampersand.", "Plain words."]) {
      const q = createQuestion({
        type: "multipleChoice",
        stem: rich("<p>Which is <strong>true</strong>?</p>"),
        body: { shuffle: true, options: [opt("a", "x", true), opt("b", "y")] },
        feedback: { general: plainToRich(note) },
        by: "test",
        at: AT,
      });
      const back = fromGift(toGift(q).text)[0] as Question;
      assert.equal(richTextToPlain(back.feedback.general as never), note, note);
    }
    // And beside a plain stem it is written as it always was.
    const q = createQuestion({ type: "multipleChoice", stem: plainToRich("Which?"), body: { shuffle: true, options: [opt("a", "x", true), opt("b", "y")] }, feedback: { general: plainToRich("A <b> tag.") }, by: "test", at: AT });
    assert.equal(richTextToPlain((fromGift(toGift(q).text)[0] as Question).feedback.general as never), "A <b> tag.");
  });

  test("a GIFT number too large or too small to hold fails in the open and is never a value of nothing or infinity", () => {
    for (const spec of ["1e999", "-1e999", "5:1e999", "1e999..2e999", "1..2e999", "1e-999", "5:1e-999", "-1e-999..1"]) {
      const back = fromGift(`What is the value? {#${spec}}`)[0] as Question;
      assert.equal(back.type, "essay", spec);
      assert.equal(verdictFrom(back.findings), "failed", spec);
      assert.match(back.findings.map((f) => f.message).join(" "), /too large or too small to hold/, spec);
    }
    // A zero that is written as zero, and the smallest and largest that a number can hold, are read.
    for (const spec of ["0", "0.0", "0e5", "5e-324", "1.7976931348623157e308"]) assert.equal((fromGift(`Value? {#${spec}}`)[0] as Question).type, "numeric", spec);
  });

  test("an accepted answer, a matching answer and a name that are written as plain text come back as written, with a paragraph tag in them", () => {
    const short = make("shortAnswer", { caseSensitive: false, accepted: ["<p>Hello</p>", "<P>Hi</P>"] }, "Greet.");
    const xml = exportMoodleXml([short], { name: "T" }).files[0]?.content ?? "";
    const back = moodleXmlImporter.parse(xml, { file: "t.xml", at: AT, author: "test" }).questions[0] as Question;
    assert.deepEqual((back.body as unknown as { accepted: string[] }).accepted, ["<p>Hello</p>", "<P>Hi</P>"]);
    const pairs = pairsOf(["a", "<p>text</p>"], ["b", "<p>more</p>"], ["c", "plain"]);
    const matchedXml = exportMoodleXml([pairs], { name: "T" }).files[0]?.content ?? "";
    assert.match(matchedXml, /<answer format="plain_text"><text>&lt;p&gt;text&lt;\/p&gt;<\/text>/);
    const matched = moodleXmlImporter.parse(matchedXml, { file: "t.xml", at: AT, author: "test" }).questions[0] as Question;
    assert.deepEqual((matched.body as unknown as { pairs: Array<{ right: string }> }).pairs.map((p) => p.right), ["<p>text</p>", "<p>more</p>", "plain"]);
    const named = mc("Which?", [["a", true], ["b", false]], { title: "<p>Task</p>" });
    const namedBack = moodleXmlImporter.parse(exportMoodleXml([named], { name: "T" }).files[0]?.content ?? "", { file: "t.xml", at: AT, author: "test" }).questions[0] as Question;
    assert.equal(namedBack.title, "<p>Task</p>");
  });

  test("where nothing says what the text is, a lone paragraph around it is taken off, and only that", () => {
    const xml = (answerAttr: string, text: string): string =>
      `<?xml version="1.0"?><quiz><question type="shortanswer"><name><text>S</text></name><questiontext format="html"><text>Say.</text></questiontext><usecase>0</usecase><answer fraction="100"${answerAttr}><text>${text}</text></answer></question></quiz>`;
    const accepted = (answerAttr: string, text: string): string[] => ((moodleXmlImporter.parse(xml(answerAttr, text), { file: "t.xml", at: AT, author: "test" }).questions[0] as Question).body as unknown as { accepted: string[] }).accepted;
    assert.deepEqual(accepted("", "&lt;p&gt;Paris&lt;/p&gt;"), ["Paris"]);
    assert.deepEqual(accepted(' format="moodle_auto_format"', "&lt;p&gt;Paris&lt;/p&gt;"), ["Paris"]);
    assert.deepEqual(accepted(' format="plain_text"', "&lt;p&gt;Paris&lt;/p&gt;"), ["<p>Paris</p>"]);
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

// Found by a tester of pictures, equations and fields: a Moodle file this program wrote with one picture of about 4.3 MB or more could not
// be read back. A pattern over the picture's text overflowed the stack and the import threw, where the limit on a picture is 25 MB.
// Found by a tester of fields: QTI states the right answer by its score, so a question worth 0 points came back with no key (QTI 1.2 as a
// question with no answer, QTI 2.1 with the accepted answers of a short answer empty), the exporter saying it was exported.
describe("a question worth no points in QTI", () => {
  const worth = (points: number): Question[] => [
    mc("Which is cold?", [["Ice", true], ["Fire", false], ["Lava", false]], { points }),
    make("multipleResponse", { shuffle: true, partialCredit: false, options: [opt("a", "Ice", true), opt("b", "Snow", true), opt("c", "Fire")] }, "Pick the cold ones.", { points }),
    make("trueFalse", { correct: true }, "Ice is cold.", { points }),
    make("shortAnswer", { caseSensitive: false, accepted: ["Paris", "Lutetia"] }, "Capital of France?", { points }),
    make("matching", { shuffle: true, distractors: [], pairs: [["a", "1"], ["b", "2"], ["c", "3"]].map(([l, r], i) => ({ id: `p${i}`, left: plainToRich(l as string), right: r as string })) }, "Match.", { points }),
  ];
  const destinations = [["QTI 1.2", exportQti12], ["QTI 2.1", exportQti21], ["Common Cartridge", exportCommonCartridge]] as const;
  const back = (exporter: typeof exportQti12, questions: Question[]) => {
    const out = exporter(questions, { name: "Bank" });
    const zip = out.files[0]?.bytes as Uint8Array;
    return { items: out.report.items, questions: runImporter(importerForContent(out.files[0]?.name ?? "", zip), zip, { file: "Bank.zip", at: AT, author: "test" }).questions };
  };

  test("is written worth 1, said so, and keeps its key", () => {
    for (const [name, exporter] of destinations) {
      const { items, questions } = back(exporter, worth(0));
      // Common Cartridge has no matching question and leaves it out, as it always did.
      const written = items.filter((item) => item.outcome !== "leftOut");
      assert.equal(questions.length, written.length, name);
      assert.ok(written.length >= 4, name);
      for (const item of written) assert.match(item.notes.join(" "), /worth no points is written worth 1 point/, name);
      const [choice, multiple, truth, short] = questions as [Question, Question, Question, Question];
      assert.deepEqual(rightOf(choice), ["Ice"], name);
      assert.deepEqual(rightOf(multiple), ["Ice", "Snow"], name);
      assert.equal((truth.body as unknown as { correct: boolean }).correct, true, name);
      assert.deepEqual((short.body as unknown as { accepted: string[] }).accepted, ["Paris", "Lutetia"], name);
      if (name !== "Common Cartridge") assert.equal((questions[4] as Question).type, "matching", name);
      for (const q of questions) assert.ok(!q.findings.some((f) => f.code === "import.no-answer-key"), `${name} ${q.type}`);
    }
  });

  test("is still left out when it cannot be written for another reason, and the reason is not the points", () => {
    for (const [name, exporter] of destinations) {
      const items = exporter([mc("Which?", [["a", false], ["b", false]], { points: 0 })], { name: "Bank" }).report.items;
      assert.equal(items[0]?.outcome, "leftOut", name);
      assert.doesNotMatch(items[0]?.notes.join(" ") ?? "", /worth no points/, name);
    }
  });

  test("says nothing about points for a question worth one or more, and says when points are rounded", () => {
    for (const [name, exporter] of destinations) {
      const plain = back(exporter, worth(2.5));
      assert.ok(plain.items.every((item) => !/worth no points|five decimal places/.test(item.notes.join(" "))), name);
      const rounded = back(exporter, worth(12.345678));
      assert.ok(rounded.items.filter((item) => item.outcome !== "leftOut").every((item) => /written to five decimal places/.test(item.notes.join(" "))), name);
    }
  });
});

// Found by a tester of fields: a matching question that keeps its answers in a fixed order came back mixed up from five formats, and
// nothing said so (Moodle wrote a literal true). Moodle and QTI 2.1 carry it; the others say they cannot.
describe("a matching question that keeps its answers in a fixed order", () => {
  const fixed = (shuffle: boolean): Question => make("matching", { shuffle, distractors: [], pairs: [["a", "1"], ["b", "2"], ["c", "3"]].map(([l, r], i) => ({ id: `p${i}`, left: plainToRich(l as string), right: r as string })) }, "Match.");
  const said = (questions: Question[], exporter: (q: Question[], o: { name: string }) => { report: { items: Array<{ notes: string[] }> } }): string => exporter(questions, { name: "T" }).report.items[0]?.notes.join(" ") ?? "";

  test("is written by Moodle as it is, and read back as it is", () => {
    for (const shuffle of [true, false]) {
      const xml = exportMoodleXml([fixed(shuffle)], { name: "T" }).files[0]?.content ?? "";
      assert.match(xml, new RegExp(`<shuffleanswers>${shuffle}</shuffleanswers>`));
      const back = moodleXmlImporter.parse(xml, { file: "t.xml", at: AT, author: "test" }).questions[0] as Question;
      assert.equal((back.body as unknown as { shuffle: boolean }).shuffle, shuffle);
    }
  });

  test("is said to be unsaid by the formats that cannot carry it, and by them only when it matters", () => {
    for (const [name, exporter] of [["GIFT", exportGift], ["QTI 1.2", exportQti12], ["Brightspace", exportD2lCsv], ["Blackboard", exportBlackboardUpload]] as const) {
      assert.match(said([fixed(false)], exporter as never), /matching question keeps its answers in a fixed order/, name);
      assert.doesNotMatch(said([fixed(true)], exporter as never), /fixed order/, name);
    }
  });
});

describe("feedback for a wrong short answer in Moodle", () => {
  test("is written as the any-other-answer entry and read back as the feedback for a wrong answer, with no warning about its own file", () => {
    const q = createQuestion({ type: "shortAnswer", stem: plainToRich("Capital of France?"), body: { caseSensitive: false, accepted: ["Paris"] }, feedback: { correct: plainToRich("Yes."), incorrect: plainToRich("No, think of the Seine.") }, by: "test", at: AT });
    const xml = exportMoodleXml([q], { name: "T" }).files[0]?.content ?? "";
    const result = moodleXmlImporter.parse(xml, { file: "t.xml", at: AT, author: "test" });
    const back = result.questions[0] as Question;
    assert.equal(richTextToPlain(back.feedback.incorrect as never), "No, think of the Seine.");
    assert.equal(richTextToPlain(back.feedback.correct as never), "Yes.");
    assert.deepEqual((back.body as unknown as { accepted: string[] }).accepted, ["Paris"]);
    assert.ok(!back.findings.some((f) => /not accepted/.test(f.message)), "no warning about feedback that was dropped");
    assert.equal(verdictFrom(back.findings), "parsed");
  });

  test("an answer that is not the any-other-answer entry, with feedback, is still reported as not read", () => {
    const xml = `<?xml version="1.0"?><quiz><question type="shortanswer"><name><text>S</text></name><questiontext format="html"><text>Say.</text></questiontext><answer fraction="100"><text>Paris</text></answer><answer fraction="0"><text>London</text><feedback format="html"><text>Not London.</text></feedback></answer></question></quiz>`;
    const back = moodleXmlImporter.parse(xml, { file: "t.xml", at: AT, author: "test" }).questions[0] as Question;
    assert.match(back.findings.map((f) => f.message).join(" "), /Feedback on an answer that is not accepted was not read: "Not London\."/);
    assert.equal(back.feedback.incorrect, undefined);
  });
});

describe("a Moodle question's points", () => {
  const read = (grade: string) => {
    const xml = `<?xml version="1.0"?><quiz><question type="truefalse"><name><text>T</text></name><questiontext format="html"><text>Ice is cold.</text></questiontext>${grade}<answer fraction="100"><text>true</text></answer><answer fraction="0"><text>false</text></answer></question></quiz>`;
    return (moodleXmlImporter.parse(xml, { file: "t.xml", at: AT, author: "test" }).questions[0] as Question).points;
  };

  test("are read as written, including nothing, and are the default only when missing or not a number", () => {
    assert.equal(read("<defaultgrade>0</defaultgrade>"), 0);
    assert.equal(read("<defaultgrade>0.0000000</defaultgrade>"), 0);
    assert.equal(read("<defaultgrade>2.5</defaultgrade>"), 2.5);
    assert.equal(read(""), 1);
    assert.equal(read("<defaultgrade></defaultgrade>"), 1);
    assert.equal(read("<defaultgrade>lots</defaultgrade>"), 1);
    assert.equal(read("<defaultgrade>-1</defaultgrade>"), 1);
  });
});

describe("a picture or an equation in the feedback of a Moodle question", () => {
  const withFeedback = (feedback: Record<string, unknown>): Question =>
    createQuestion({
      type: "multipleChoice",
      stem: plainToRich("Which colour?"),
      body: { shuffle: true, options: [opt("o0", "Blue", true), opt("o1", "Red")] } as never,
      feedback: feedback as never,
      media: [{ id: "m1", file: "media/p-aaaaaaaaaaaaaaaa.png", mime: "image/png", alt: "A blue box" }],
      math: [{ id: "e1", latex: "$$x$$", mathml: "", source: "latex" }] as never,
      by: "test",
      at: AT,
    });

  test("is reported in the notes, in general feedback as in feedback for a right answer", () => {
    for (const where of ["general", "correct", "incorrect"]) {
      const q = withFeedback({ [where]: rich(`<p>See ${mediaPlaceholder("m1")}</p>`) });
      const item = exportMoodleXml([q], { name: "t" }).report.items[0];
      assert.equal(item?.outcome, "exportedWithLosses", `a picture in ${where} feedback`);
      assert.match((item?.notes ?? []).join(" "), /picture/i, where);
    }
    const clean = exportMoodleXml([withFeedback({ general: plainToRich("Blue is right.") })], { name: "t" }).report.items[0];
    assert.equal(clean?.outcome, "exported");
  });
});

describe("a Moodle file with a large picture", () => {
  test("is read back whole, with the picture's bytes", () => {
    const file = "media/p-0123456789abcdef.png";
    const base = png(20, 20);
    for (const extra of [10_000, 5_000_000, 20_000_000]) {
      const picture = new Uint8Array(base.length + extra);
      picture.set(base, 0);
      picture.fill(7, base.length);
      const q = createQuestion({
        type: "multipleChoice",
        stem: rich(`<p>What does the photograph show? ${mediaPlaceholder("m1")}</p>`),
        body: { shuffle: false, options: [opt("o0", "A bridge", true), opt("o1", "A tower")] } as never,
        media: [{ id: "m1", file, mime: "image/png", alt: "A photograph" }],
        by: "test",
        at: AT,
      });
      const xml = exportMoodleXml([q], { name: "Photos", media: new Map([[file, picture]]) }).files[0]?.content ?? "";
      const result = moodleXmlImporter.parse(xml, { file: "t.xml", at: AT, author: "test" });
      assert.equal(result.questions.length, 1, `${extra} bytes of picture`);
      assert.equal(result.media?.size, 1, `${extra} bytes of picture`);
      const kept = [...(result.media?.values() ?? [])][0] as Uint8Array;
      assert.equal(kept.length, picture.length);
      assert.ok(Buffer.compare(Buffer.from(kept), Buffer.from(picture)) === 0, "the bytes are the same");
    }
  });

  test("shows the question's XML with the picture's data replaced by its length, and only a long run of text with no tag in it", () => {
    const data = "A".repeat(300);
    assert.equal(shortenPictureData(`<file name="a.png" encoding="base64">${data}</file>`), `<file name="a.png" encoding="base64">[300 characters of picture data]</file>`);
    assert.equal(shortenPictureData(`<file name="a.png">${"A".repeat(199)}</file>`), `<file name="a.png">${"A".repeat(199)}</file>`, "199 is not long enough");
    assert.equal(shortenPictureData(`<file name="a.png">${data}<b/></file>`), `<file name="a.png">${data}<b/></file>`, "text with a tag in it is not picture data");
    assert.equal(shortenPictureData(`<filename>${data}</filename>`), `<filename>${data}</filename>`, "another element");
    assert.equal(shortenPictureData(`<filename>${data}</file>`), `<filename>${data}</file>`, "another element is not a file even when a file is closed after it");
    assert.equal(shortenPictureData(`<file a="1">${data}</file><x/><file b="2">${data}${data}</file>`), `<file a="1">[300 characters of picture data]</file><x/><file b="2">[600 characters of picture data]</file>`);
    assert.equal(shortenPictureData(`<file>${data}`), `<file>${data}`, "never closed");
    assert.equal(shortenPictureData("no files here"), "no files here");
    const started = performance.now();
    shortenPictureData(`<file>${"B".repeat(30_000_000)}</file>`);
    assert.ok(performance.now() - started < 3000);
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
