/**
 * The Moodle XML importer. The rules under test are the ones every importer keeps and this one most needs: a key is read only where
 * the file gives one (an answer is right when it is worth the whole of the points, and a question where none is has no key and says
 * so, never a guessed one), nothing is dropped without being said, a question that is not one of the types read is kept as text and
 * fails, and a file that cannot be read is refused in words.
 *
 * The file is the XML Moodle writes (the sample in `fixtures/moodle-xml` has the shape of a real export, boilerplate included), and
 * the exporter of this program is read back through it: what is exported and imported again is what was exported.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { exportMoodleXml } from "../src/export/moodle-xml.ts";
import { looksLikeMoodleXml, moodleXmlImporter } from "../src/import/moodle-xml.ts";
import { importerForContent, runImporter } from "../src/import/registry.ts";
import { hasUsableKey } from "../src/quality/answer-key.ts";
import { verdictOf } from "../src/import/types.ts";
import { createQuestion } from "../src/model/create.ts";
import type { Question } from "../src/model/question.ts";
import { plainToRich, richTextToPlain } from "../src/model/richtext.ts";
import { sniffImage } from "../src/model/image.ts";
import { jpeg, png } from "./support/images.ts";

const AT = "2026-01-01T00:00:00.000Z";
const SAMPLE = fileURLToPath(new URL("../../../fixtures/moodle-xml/moodle-sample.xml", import.meta.url));

const read = (xml: string, file = "bank.xml") => moodleXmlImporter.parse(xml, { file, at: AT, author: "test" });
const one = (xml: string): Question => {
  const result = read(xml);
  assert.equal(result.questions.length, 1, `expected one question, got ${result.questions.length}: ${result.fileFindings.map((f) => f.message).join(" | ")}`);
  return result.questions[0] as Question;
};
const quiz = (...questions: string[]): string => `<?xml version="1.0" encoding="UTF-8"?>\n<quiz>\n${questions.join("\n")}\n</quiz>\n`;

/** One answer element. */
const answer = (fraction: number | string, value: string, feedback = "", format = "html"): string =>
  `<answer fraction="${fraction}" format="${format}"><text><![CDATA[${value}]]></text><feedback format="html"><text><![CDATA[${feedback}]]></text></feedback></answer>`;

/** One question element of a type, with the common parts Moodle writes. */
const question = (type: string, inner: string, stem = "<p>What?</p>", extra = ""): string =>
  `<question type="${type}"><name><text>Name of it</text></name><questiontext format="html"><text><![CDATA[${stem}]]></text></questiontext><generalfeedback format="html"><text></text></generalfeedback><defaultgrade>1.0000000</defaultgrade><penalty>0.3333333</penalty><hidden>0</hidden>${extra}${inner}</question>`;

const choice = (single: boolean, answers: string[], stem?: string): string => question("multichoice", `<single>${single}</single><shuffleanswers>true</shuffleanswers>${answers.join("")}`, stem);

const codes = (q: Question): string[] => q.findings.map((f) => f.code);
const plainOf = (t: unknown): string => richTextToPlain(t as never).replace(/\s+/g, " ").trim();
const options = (q: Question): Array<{ text: string; correct: boolean }> => (q.body as unknown as { options: Array<{ content: unknown; correct: boolean }> }).options.map((o) => ({ text: plainOf(o.content), correct: o.correct }));

describe("the sample file, shaped like a real Moodle export", () => {
  const bytes = new Uint8Array(readFileSync(SAMPLE));
  const result = runImporter(importerForContent("moodle-sample.xml", bytes), bytes, { file: "moodle-sample.xml", at: AT, author: "test" });
  const by = (title: string): Question => result.questions.find((q) => q.title === title) as Question;

  test("is told by its contents and by its name, and every question is read", () => {
    assert.equal(importerForContent("moodle-sample.xml", bytes).id, "moodle-xml");
    assert.equal(importerForContent("renamed.txt", bytes).id, "moodle-xml", "a quiz saved with another extension is still told by what it holds");
    assert.deepEqual(result.counts, { parsed: 8, needsReview: 0, failed: 1, orphans: 1 });
    assert.equal(result.questions.length, 9);
  });

  test("keeps the title, the points, the category and the tags", () => {
    const q = by("Capital of France");
    assert.equal(q.points, 2);
    assert.deepEqual(q.metadata.tags, ["Default for Biology", "geography"]);
    assert.equal(q.metadata.status, "draft");
    assert.equal(by("Discuss").points, 10);
  });

  test("a single answer question: the answer worth the whole of the points is the key, the picture of the text is kept, bold stays bold", () => {
    const q = by("Capital of France");
    assert.equal(q.type, "multipleChoice");
    assert.deepEqual(options(q), [{ text: "Berlin", correct: false }, { text: "Paris", correct: true }, { text: "Rome", correct: false }]);
    assert.match(q.stem.content, /<strong>France<\/strong>/);
    assert.equal(plainOf((q.body as { options: Array<{ feedback?: unknown }> }).options[1]?.feedback), "Paris has been the capital since 987.");
    assert.ok(hasUsableKey(q));
    assert.equal(verdictOf(q), "parsed");
  });

  test("Moodle's standard feedback sentences are not kept as feedback, and the file says how many there were", () => {
    for (const q of result.questions) assert.doesNotMatch(JSON.stringify(q.feedback), /Your answer is/);
    assert.ok(result.fileFindings.some((f) => /9 feedbacks were Moodle's standard sentence/.test(f.message)));
    assert.equal(by("Primary colours").findings.length, 0, "a question that has only the standard sentences is not flagged for them");
  });

  test("a multiple answer question with shared credit is a multiple response with partial credit", () => {
    const q = by("Primary colours");
    assert.equal(q.type, "multipleResponse");
    assert.equal((q.body as { partialCredit: boolean }).partialCredit, true);
    assert.deepEqual(options(q).filter((o) => o.correct).map((o) => o.text), ["Red", "Green", "Blue"]);
  });

  test("true or false, short answer, matching, essay and numerical", () => {
    assert.deepEqual(by("Light-year").body, { correct: false });
    assert.equal(plainOf(by("Light-year").feedback.correct), "It is a measure of distance.");
    assert.deepEqual(by("Hardest mineral").body, { caseSensitive: false, accepted: ["Diamond", "diamonds"] });
    const match = by("Animal sounds").body as { pairs: Array<{ left: unknown; right: string }>; distractors: string[] };
    assert.deepEqual(match.pairs.map((p) => [plainOf(p.left), p.right]), [["Dog", "Bark"], ["Cat", "Meow"], ["Cow", "Moo"]]);
    assert.deepEqual(match.distractors, ["Quack"]);
    assert.equal(by("Discuss").type, "essay");
    assert.deepEqual(by("Pi").body, { mode: "tolerance", value: 3.14, tolerance: 0.005, units: "rad" });
  });

  test("LaTeX between \\( and \\) stays as the author typed it", () => {
    assert.match(by("Pi").stem.content, /What is \\\(\\pi\\\) to two decimal places\?/);
  });

  test("a description is an orphan with the reason, and a cloze is kept as an essay that fails", () => {
    assert.equal(result.orphans.length, 1);
    assert.match(result.orphans[0]?.reason ?? "", /description/);
    assert.equal(result.orphans[0]?.text, "Read the passage below.");
    const cloze = by("Missing words");
    assert.equal(cloze.type, "essay");
    assert.match(cloze.stem.content, /\{1:SHORTANSWER:=Paris\}/, "its words are all kept");
    assert.equal(verdictOf(cloze), "failed");
    assert.match(cloze.findings.find((f) => f.code === "import.unsupported-type")?.message ?? "", /cloze/);
  });

  test("a picture is kept as a file named for its bytes, with its description, and the question points at it", () => {
    const q = by("Look at the figure");
    assert.equal(q.media.length, 1);
    const m = q.media[0] as Question["media"][number];
    assert.match(m.file, /^media\/p-[0-9a-f]{16}\.png$/);
    assert.equal(m.alt, "A blue box");
    assert.equal(m.mime, "image/png");
    assert.match(q.stem.content, new RegExp(`<oa-media ref="${m.id}"></oa-media>`));
    const held = result.media?.get(m.file);
    assert.ok(held && sniffImage(held)?.mime === "image/png");
    assert.equal(verdictOf(q), "parsed");
  });

  test("the lines beside each question are its own XML, with the picture's data left out", () => {
    const lines = result.sourceLines ?? [];
    const q = by("Look at the figure");
    const source = q.origin?.source as { firstBlock: number; lastBlock: number };
    const shown = lines.slice(source.firstBlock, source.lastBlock + 1).join("\n");
    assert.match(shown, /^<question type="multichoice">/);
    assert.match(shown, /<\/question>$/);
    assert.match(shown, /What colour is the box\?/);
    const bigPicture = quiz(question("multichoice", `<single>true</single>${answer(100, "A")}${answer(0, "B")}<file name="x" encoding="base64">${"QUJD".repeat(300)}</file>`));
    assert.doesNotMatch((read(bigPicture).sourceLines ?? []).join("\n"), /QUJDQUJD/);
  });
});

describe("a key is read only where the file gives one", () => {
  test("a single answer question where no answer is worth the whole of the points has no key, and says so", () => {
    const q = one(quiz(choice(true, [answer(50, "A"), answer(25, "B"), answer(0, "C")])));
    assert.deepEqual(options(q).map((o) => o.correct), [false, false, false]);
    assert.ok(codes(q).includes("import.no-answer-key"));
    assert.ok(q.findings.some((f) => f.severity === "error"));
    assert.equal(hasUsableKey(q), false);
    assert.equal(verdictOf(q), "failed");
    assert.ok(q.findings.some((f) => /Nothing was guessed/.test(f.message)));
  });

  test("two answers each worth the whole of the points are both marked as the file has them, and flagged", () => {
    const q = one(quiz(choice(true, [answer(100, "A"), answer(100, "B"), answer(0, "C")])));
    assert.deepEqual(options(q).map((o) => o.correct), [true, true, false]);
    assert.ok(codes(q).includes("import.more-than-one-right"));
    assert.equal(hasUsableKey(q), false, "a single answer question with two right answers is not a usable key");
  });

  test("part credit on a single answer question is not kept as a key, and is said", () => {
    const q = one(quiz(choice(true, [answer(100, "A"), answer(50, "B"), answer(-20, "C")])));
    assert.deepEqual(options(q).map((o) => o.correct), [true, false, false], "only what is worth the whole of the points is right");
    assert.ok(codes(q).filter((c) => c === "import.weights-not-kept").length >= 1);
  });

  test("a multiple answer question where nothing is worth anything has no key", () => {
    const q = one(quiz(choice(false, [answer(0, "A"), answer(0, "B")])));
    assert.deepEqual(options(q).map((o) => o.correct), [false, false]);
    assert.equal(hasUsableKey(q), false);
  });

  test("a multiple answer question whose wrong answers take everything away is all or nothing", () => {
    const q = one(quiz(choice(false, [answer(50, "A"), answer(50, "B"), answer(-100, "C"), answer(-100, "D")])));
    assert.equal((q.body as { partialCredit: boolean }).partialCredit, false);
    assert.deepEqual(options(q).filter((o) => o.correct).map((o) => o.text), ["A", "B"]);
    assert.deepEqual(q.findings, []);
  });

  test("weights that are not equal shares are read as the right answers, and the weights are said not to be kept", () => {
    const q = one(quiz(choice(false, [answer(70, "A"), answer(10, "B"), answer(-20, "C")])));
    assert.deepEqual(options(q).filter((o) => o.correct).map((o) => o.text), ["A", "B"]);
    assert.ok(codes(q).includes("import.weights-not-kept"));
  });

  test("true or false: neither answer worth the whole of the points leaves no key, and both leaves none either", () => {
    const tf = (a: number, b: number): Question =>
      one(quiz(question("truefalse", `${answer(a, "true", "", "moodle_auto_format")}${answer(b, "false", "", "moodle_auto_format")}`)));
    assert.deepEqual(tf(100, 0).body, { correct: true });
    assert.deepEqual(tf(0, 100).body, { correct: false });
    for (const [a, b] of [[0, 0], [50, 50], [100, 100]] as const) {
      const q = tf(a, b);
      assert.deepEqual(q.body, {}, `${a} and ${b}`);
      assert.ok(codes(q).includes("import.no-answer-key"));
      assert.equal(hasUsableKey(q), false);
    }
  });

  test("true or false whose answers do not read true and false is kept as text and fails", () => {
    const q = one(quiz(question("truefalse", `${answer(100, "yes")}${answer(0, "no")}`)));
    assert.equal(q.type, "essay");
    assert.equal(verdictOf(q), "failed");
  });

  test("a short answer takes the answers worth the whole of the points, and not part credit, which is said", () => {
    const q = one(quiz(question("shortanswer", `<usecase>1</usecase>${answer(100, "Paris")}${answer(50, "Lyon")}${answer(0, "*", "No.")}`)));
    assert.deepEqual(q.body, { caseSensitive: true, accepted: ["Paris"] });
    const said = q.findings.map((f) => f.message).join(" ");
    assert.match(said, /"Lyon" is worth 50 percent/);
    // Moodle's "*" is any other answer, and the feedback on it is the feedback for a wrong answer: it is read as that and is not a thing dropped.
    assert.doesNotMatch(said, /Feedback on an answer that is not accepted/);
    assert.equal(richTextToPlain(q.feedback.incorrect as never), "No.");
  });

  test("a short answer with nothing worth the whole of the points has no accepted answer, and is flagged", () => {
    const q = one(quiz(question("shortanswer", `<usecase>0</usecase>${answer(50, "Paris")}`)));
    // No accepted answer is one empty entry, which the model accepts (it wants at least one), so the question can be stored and repaired.
    assert.deepEqual((q.body as { accepted: string[] }).accepted, [""]);
    assert.equal(hasUsableKey(q), false);
    assert.equal(verdictOf(q), "failed");
  });

  test("an asterisk in an accepted answer is kept as typed, and said", () => {
    const q = one(quiz(question("shortanswer", `<usecase>0</usecase>${answer(100, "Par*")}`)));
    assert.deepEqual((q.body as { accepted: string[] }).accepted, ["Par*"]);
    assert.match(q.findings.map((f) => f.message).join(" "), /asterisk/);
  });

  test("a numerical question needs one number worth the whole of the points, and does not guess among several", () => {
    const num = (answers: string): Question => one(quiz(question("numerical", `${answers}`)));
    const body = (value: string, tolerance: string, fraction = 100): string => `<answer fraction="${fraction}" format="plain_text"><text>${value}</text><tolerance>${tolerance}</tolerance><feedback format="html"><text></text></feedback></answer>`;
    assert.deepEqual(num(body("42", "0")).body, { mode: "exact", value: 42 });
    assert.deepEqual(num(body("42", "0.5")).body, { mode: "tolerance", value: 42, tolerance: 0.5 });
    assert.equal(num(body("42", "0", 50)).type, "essay", "no number worth the whole of the points");
    assert.equal(num(body("42", "0") + body("43", "0")).type, "essay", "two right numbers");
    assert.equal(num(body("forty-two", "0")).type, "essay");
    assert.equal(num(body("*", "0")).type, "essay");
    const partial = num(body("42", "0") + body("41", "0", 50));
    assert.equal(partial.type, "numeric");
    assert.match(partial.findings.map((f) => f.message).join(" "), /"41" is worth 50 percent/);
  });

  test("a weight that is not a number makes the question unreadable, and it is kept as text", () => {
    const q = one(quiz(choice(true, [answer("lots", "A"), answer(0, "B")])));
    assert.equal(q.type, "essay");
    assert.match(q.findings.map((f) => f.message).join(" "), /"lots", which is not a number/);
  });

  test("an answer with no text is kept as (missing), flagged as an error, and is never taken for a key", () => {
    const q = one(quiz(choice(true, [answer(100, ""), answer(0, "B")])));
    assert.deepEqual(options(q), [{ text: "(missing)", correct: true }, { text: "B", correct: false }]);
    assert.ok(codes(q).includes("import.empty-option"));
    assert.equal(verdictOf(q), "failed");
  });
});

describe("what is read of the text", () => {
  test("html keeps its paragraphs, lists and emphasis, and says what it took out", () => {
    const q = one(quiz(choice(true, [answer(100, "A"), answer(0, "B")], '<div class="x"><p style="color:red">One <i>two</i> <font color="red">three</font> <span lang="en">four</span></p><ul><li>a</li></ul></div>')));
    assert.match(q.stem.content, /<p>One <em>two<\/em> three four<\/p><ul><li>a<\/li><\/ul>/);
    const said = q.findings.find((f) => f.code === "import.markup-removed")?.message ?? "";
    assert.match(said, /<font>/);
    assert.doesNotMatch(said, /<div>|<span>/, "a div or a span only wraps words, so it is not worth a note");
  });

  test("plain text and the default format are text, not markup, and keep their line breaks", () => {
    const q = one(
      quiz(
        `<question type="multichoice"><name><text>n</text></name><questiontext format="plain_text"><text>Is 3 &lt; 5 &amp; 5 &gt; 3?\nSecond line.</text></questiontext>` +
          `<single>true</single>${answer(100, "A")}${answer(0, "B")}</question>`,
      ),
    );
    assert.equal(plainOf(q.stem), "Is 3 < 5 & 5 > 3? Second line.");
    assert.match(q.stem.content, /Is 3 &lt; 5 &amp; 5 &gt; 3\?<br>Second line\./);
    const auto = one(quiz(`<question type="essay"><name><text>n</text></name><questiontext format="moodle_auto_format"><text>Plain words, 1 &lt; 2.</text></questiontext></question>`));
    assert.equal(plainOf(auto.stem), "Plain words, 1 < 2.");
  });

  test("markdown is not converted, and says so", () => {
    const q = one(quiz(`<question type="essay"><name><text>n</text></name><questiontext format="markdown"><text>**bold** words</text></questiontext></question>`));
    assert.equal(plainOf(q.stem), "**bold** words");
    assert.match(q.findings.map((f) => f.message).join(" "), /Markdown/);
  });

  test("markup in the text cannot become markup of the bank: a script is taken out and said", () => {
    const q = one(quiz(choice(true, [answer(100, "A"), answer(0, "B")], '<p>Hi</p><script>alert(1)</script><img src="x" onerror="alert(1)">')));
    assert.doesNotMatch(JSON.stringify({ stem: q.stem, body: q.body }), /<script|onerror|alert/);
    assert.match(q.findings.map((f) => f.message).join(" "), /<script>/, "and it says so");
  });

  test("the title is the question's name, and the question's own words when there is no name", () => {
    assert.equal(one(quiz(choice(true, [answer(100, "A"), answer(0, "B")]))).title, "Name of it");
    const unnamed = one(quiz(`<question type="essay"><questiontext format="html"><text><![CDATA[<p>Describe the water cycle.</p>]]></text></questiontext></question>`));
    assert.match(unnamed.title, /Describe the water cycle/);
  });

  test("a question with no text is given a visible stand-in, and still has its key", () => {
    const q = one(quiz(`<question type="truefalse"><name><text>n</text></name>${answer(100, "true")}${answer(0, "false")}</question>`));
    assert.equal(plainOf(q.stem), "(no question text in the source)");
    assert.deepEqual(q.body, { correct: true });
  });

  test("points default to what the caller gives when the file has none, and the file's own grade wins when it has one", () => {
    const withGrade = one(quiz(`<question type="essay"><name><text>n</text></name><questiontext format="html"><text>Q</text></questiontext><defaultgrade>4.5000000</defaultgrade></question>`));
    assert.equal(withGrade.points, 4.5);
    const without = moodleXmlImporter.parse(quiz(`<question type="essay"><name><text>n</text></name><questiontext format="html"><text>Q</text></questiontext></question>`), { at: AT, defaultPoints: 3 });
    assert.equal(without.questions[0]?.points, 3);
  });
});

describe("pictures", () => {
  const PNG = png(12, 12);
  const withPicture = (img: string, files: string): string => question("multichoice", `<single>true</single>${answer(100, "A")}${answer(0, "B")}`, `<p>Look: ${img}</p>`, "").replace("</questiontext>", `${files}</questiontext>`);
  const file = (name: string, bytes: Uint8Array): string => `<file name="${name}" path="/" encoding="base64">${Buffer.from(bytes).toString("base64")}</file>`;

  test("a picture is kept when its file is there and it is a PNG, JPEG or GIF, and named for what its bytes are", () => {
    for (const [name, bytes, mime] of [["a.png", PNG, "image/png"], ["b.jpg", jpeg(10, 10), "image/jpeg"]] as const) {
      const result = read(quiz(withPicture(`<img src="@@PLUGINFILE@@/${name}" alt="Figure">`, file(name, bytes))));
      const q = result.questions[0] as Question;
      assert.equal(q.media[0]?.mime, mime);
      assert.ok(result.media?.has(q.media[0]?.file as string));
      assert.deepEqual(q.findings, []);
    }
  });

  test("a picture file named wrongly for its bytes is told by the bytes, and a name with a percent sign is found", () => {
    const result = read(quiz(withPicture('<img src="@@PLUGINFILE@@/my%20box.png" alt="x">', file("my box.png", jpeg(9, 9)))));
    assert.equal(result.questions[0]?.media[0]?.mime, "image/jpeg");
    assert.match(result.questions[0]?.media[0]?.file ?? "", /\.jpg$/);
  });

  test("a picture with no description is kept and the question is flagged for it", () => {
    const q = read(quiz(withPicture('<img src="@@PLUGINFILE@@/a.png" alt="">', file("a.png", PNG)))).questions[0] as Question;
    assert.equal(q.media.length, 1);
    assert.ok(codes(q).includes("a11y.missing-alt-text"));
  });

  test("a picture marked as decoration needs no description", () => {
    const q = read(quiz(withPicture('<img src="@@PLUGINFILE@@/a.png" alt="" role="presentation">', file("a.png", PNG)))).questions[0] as Question;
    assert.equal(q.media[0]?.decorative, true);
    assert.deepEqual(q.findings, []);
  });

  test("a picture that cannot be kept stays as [picture], the question is flagged, and the reason is said", () => {
    const cases: Array<[string, string, RegExp]> = [
      ['<img src="https://example.org/x.png" alt="Linked">', "", /linked from another site/],
      ['<img src="@@PLUGINFILE@@/gone.png" alt="Gone">', "", /does not hold a picture named gone\.png/],
      ['<img src="@@PLUGINFILE@@/x.bmp" alt="Bitmap">', file("x.bmp", new Uint8Array([0x42, 0x4d, 1, 2, 3, 4])), /not a PNG, JPEG or GIF/],
      ['<img src="data:image/png;base64,AAAA" alt="Inline">', "", /does not point at a picture in the file/],
    ];
    for (const [img, files, why] of cases) {
      const q = read(quiz(withPicture(img, files))).questions[0] as Question;
      assert.match(q.stem.content, /\[picture\]/);
      assert.equal(q.media.length, 0);
      assert.ok(codes(q).includes("import.unread-object"), img);
      assert.match(q.findings.map((f) => f.message).join(" "), why);
      assert.equal(verdictOf(q), "needsReview");
    }
  });

  test("a picture in an answer or in feedback is kept the same way", () => {
    const xml = quiz(
      question(
        "multichoice",
        `<single>true</single><answer fraction="100" format="html"><text><![CDATA[<p><img src="@@PLUGINFILE@@/a.png" alt="Choice"></p>]]></text>${file("a.png", PNG)}<feedback format="html"><text></text></feedback></answer>${answer(0, "B")}`,
      ),
    );
    const q = read(xml).questions[0] as Question;
    assert.equal(q.media.length, 1);
    assert.match(JSON.stringify(q.body), /oa-media/);
  });

  test("the same picture in two questions is one file", () => {
    const a = withPicture('<img src="@@PLUGINFILE@@/a.png" alt="One">', file("a.png", PNG));
    const b = withPicture('<img src="@@PLUGINFILE@@/b.png" alt="Two">', file("b.png", PNG));
    const result = read(quiz(a, b));
    assert.equal(result.media?.size, 1);
    assert.equal(result.questions[0]?.media[0]?.file, result.questions[1]?.media[0]?.file);
  });
});

describe("a file that cannot be read is refused in words, and what is damaged is not lost", () => {
  test("text that is not XML, an empty file, a different XML file, and a file with a document type are refused with a sentence", () => {
    const refusals: Array<[string, RegExp]> = [
      ["This is not XML at all.", /not well formed XML/],
      ["", /not well formed XML/],
      ['<?xml version="1.0"?><html><body>hi</body></html>', /first element is <html>.*begins with <quiz>/],
      ['<?xml version="1.0"?><!DOCTYPE quiz [<!ENTITY x "y">]><quiz><question type="essay"><questiontext><text>&x;</text></questiontext></question></quiz>', /not well formed XML/],
      ["<quiz><question type=\"essay\">", /not well formed XML/],
    ];
    for (const [source, message] of refusals) {
      const result = read(source);
      assert.deepEqual(result.questions, [], source);
      assert.equal(result.fileFindings[0]?.severity, "error");
      assert.match(result.fileFindings[0]?.message ?? "", message, source);
    }
  });

  test("an empty quiz says that no question was found", () => {
    const result = read("<quiz></quiz>");
    assert.match(result.fileFindings.map((f) => f.message).join(" "), /No question was found/);
  });

  test("a file cut at every length, and a file with its bytes changed, is read or refused and never throws", () => {
    const source = readFileSync(SAMPLE, "utf8");
    let refused = 0;
    for (let at = 0; at < source.length; at += Math.ceil(source.length / 400)) {
      const result = read(source.slice(0, at));
      if (result.questions.length === 0) refused++;
      for (const f of result.fileFindings) assert.ok(f.message.length > 0);
    }
    assert.ok(refused > 0, "the early cuts are refused");
    // A seeded run of damage: a few characters changed to other characters.
    let state = 12345;
    const next = (): number => (state = (state * 1103515245 + 12345) & 0x7fffffff);
    for (let run = 0; run < 300; run++) {
      const chars = [...source];
      for (let k = 0; k < 4; k++) chars[next() % chars.length] = String.fromCharCode(32 + (next() % 95));
      assert.doesNotThrow(() => read(chars.join("")), `run ${run}`);
    }
  });

  test("a question that cannot be built is kept as its words and fails, and the others are still read", () => {
    const result = read(quiz(choice(true, [answer(100, "A"), answer(0, "B")]), question("ddwtos", answer(0, "x"), "<p>Drag the words.</p>"), choice(true, [answer(100, "C"), answer(0, "D")])));
    assert.deepEqual(result.questions.map((q) => q.type), ["multipleChoice", "essay", "multipleChoice"]);
    assert.equal(verdictOf(result.questions[1] as Question), "failed");
    assert.match(result.questions[1]?.stem.content ?? "", /Drag the words\./);
    assert.match(result.questions[1]?.findings[0]?.message ?? "", /drag and drop into text/);
    const unknown = one(quiz(question("sillyplugin", "", "<p>Odd.</p>")));
    assert.match(unknown.findings.map((f) => f.message).join(" "), /"sillyplugin" is not one OpenAssess reads/);
  });
});

describe("telling the format, and the command line", () => {
  test("looksLikeMoodleXml reads past a declaration, comments and a byte order mark, and says no to other XML", () => {
    assert.equal(looksLikeMoodleXml('<?xml version="1.0"?>\n<!-- a comment -->\n<quiz>'), true);
    assert.equal(looksLikeMoodleXml("﻿<quiz>"), true);
    assert.equal(looksLikeMoodleXml("<quizzical>"), false);
    assert.equal(looksLikeMoodleXml('<?xml version="1.0"?><questestinterop>'), false);
    assert.equal(looksLikeMoodleXml("What is the quiz?"), false);
  });

  test("a file with a byte order mark is read", () => {
    const result = read(`﻿${quiz(choice(true, [answer(100, "A"), answer(0, "B")]))}`);
    assert.equal(result.questions.length, 1);
  });

  test("`import` reads a Moodle XML file, and `review` writes the page beside its lines", () => {
    const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
    const folder = mkdtempSync(join(tmpdir(), "oa-moodle-"));
    try {
      const run = (...args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, ...args], { encoding: "utf8" });
      const imported = run("import", SAMPLE, "--out", join(folder, "bank.openassess"));
      assert.equal(imported.status, 1, "the command exits 1 when a question failed, and the cloze did");
      assert.match(imported.stdout, /profile moodle-xml/);
      assert.match(imported.stdout, /parsed\s+8/);
      assert.match(imported.stdout, /failed\s+1/);
      assert.match(imported.stdout, /with 1 picture\(s\)/);
      const exported = run("export", join(folder, "bank.openassess"), "--to", "moodle-xml", "--out", join(folder, "out"));
      assert.equal(exported.status, 0, exported.stderr);
      assert.ok(readdirSync(join(folder, "out")).some((n) => n.endsWith(".xml")));

      writeFileSync(join(folder, "broken.xml"), "<quiz><question");
      const broken = run("import", join(folder, "broken.xml"));
      assert.equal(broken.status, 0);
      assert.match(broken.stdout, /not well formed XML/);

      const review = run("review", SAMPLE, "--out", join(folder, "review.html"));
      assert.equal(review.status, 0, review.stderr);
      const page = readFileSync(join(folder, "review.html"), "utf8");
      assert.match(page, /Capital of France/);
      assert.doesNotMatch(page, /<script>alert/);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("what this program exports, read back", () => {
  const fixtures = join(fileURLToPath(new URL("../../../fixtures/standard-format/", import.meta.url)));

  /** What a question means, as a list of facts, so that two questions can be compared without their ids and dates. */
  function facts(q: Question): unknown {
    const body = q.body as unknown as Record<string, unknown>;
    const opts = (body["options"] as Array<{ content: unknown; correct: boolean; feedback?: unknown }> | undefined)?.map((o) => [plainOf(o.content), o.correct, o.feedback ? plainOf(o.feedback) : ""]);
    return {
      type: q.type,
      title: q.title,
      points: q.points,
      stem: plainOf(q.stem),
      options: opts,
      shuffle: body["shuffle"],
      partial: body["partialCredit"],
      correct: body["correct"],
      accepted: body["accepted"],
      caseSensitive: body["caseSensitive"],
      pairs: (body["pairs"] as Array<{ left: unknown; right: string }> | undefined)?.map((p) => [plainOf(p.left), p.right]),
      distractors: body["distractors"],
      numeric: body["mode"] === undefined ? undefined : [body["mode"], body["value"], body["tolerance"], body["min"], body["max"], body["units"]],
      feedback: [q.feedback.general, q.feedback.correct, q.feedback.incorrect].map((f) => (f ? plainOf(f) : "")),
    };
  }

  test("every question of every fixture bank that Moodle XML can hold comes back as what it was, and exporting that again is the same file", () => {
    let checked = 0;
    let questions = 0;
    for (const name of readdirSync(fixtures).filter((n) => /\.(txt|docx)$/.test(n))) {
      const bytes = new Uint8Array(readFileSync(join(fixtures, name)));
      const source = runImporter(importerForContent(name, bytes), bytes, { file: name, at: AT, author: "test" });
      const first = exportMoodleXml(source.questions, { name: "Bank" });
      if (first.files.length === 0) continue;
      const exported = new TextEncoder().encode(first.files[0]?.content ?? "");
      const back = runImporter(importerForContent("Bank.xml", exported), exported, { file: "Bank.xml", at: AT, author: "test" });
      const written = source.questions.filter((_q, i) => first.report.items[i]?.outcome !== "leftOut");
      assert.equal(back.questions.length, written.length, name);
      written.forEach((q, i) => {
        const got = back.questions[i] as Question;
        const expected = facts(q) as Record<string, unknown>;
        const actual = facts(got) as Record<string, unknown>;
        // A fill in the blank is exported as a short answer, and every kind that it exports as itself must match in every fact.
        if (q.type === "fillInBlank") {
          assert.equal(got.type, "shortAnswer", `${name}: ${q.title}`);
          return;
        }
        // A picture the file named and nothing supplied has no bytes to write, so it goes out as words, and the report said so.
        if (q.media.length > 0 && !source.media?.has((q.media[0] as { file: string }).file)) {
          assert.match(plainOf(got.stem) + JSON.stringify(got.body), /\[Picture/, `${name}: ${q.title}`);
          return;
        }
        // Moodle holds the title of a question and the points; a bank's own tags are not in the file, but its category is.
        assert.deepEqual(actual, expected, `${name}: ${q.title}`);
        questions++;
      });
      const second = exportMoodleXml(back.questions, { name: "Bank" });
      assert.equal(second.files[0]?.content, first.files[0]?.content, `${name}: exported again`);
      checked++;
    }
    assert.ok(checked >= 15, `only ${checked} fixtures were exported`);
    assert.ok(questions >= 40, `only ${questions} questions were compared`);
  });

  const real = join(fileURLToPath(new URL("../../../fixtures/publisher/", import.meta.url)));
  const hasReal = existsSync(real) && readdirSync(real).some((n) => n.endsWith(".expected.json"));
  test("every real bank in fixtures/publisher, when there are some, comes back from Moodle XML as what it was", { skip: hasReal ? false : "none there; the folder is git-ignored and local" }, () => {
    let questions = 0;
    for (const name of readdirSync(real).filter((n) => /\.(txt|docx|xlsx|csv)$/.test(n))) {
      const bytes = new Uint8Array(readFileSync(join(real, name)));
      const source = runImporter(importerForContent(name, bytes), bytes, { file: name, at: AT, author: "test" });
      const out = exportMoodleXml(source.questions, { name: "Bank", ...(source.media ? { media: source.media } : {}) });
      if (out.files.length === 0) continue;
      const data = new TextEncoder().encode(out.files[0]?.content ?? "");
      const back = runImporter(importerForContent("Bank.xml", data), data, { file: "Bank.xml", at: AT, author: "test" });
      const written = source.questions.filter((_q, i) => out.report.items[i]?.outcome !== "leftOut");
      assert.equal(back.questions.length, written.length, name);
      written.forEach((q, i) => {
        if (q.type === "fillInBlank") return;
        assert.deepEqual(facts(back.questions[i] as Question), facts(q), `${name}: ${q.title}`);
        // What a real file holds does not make the key worse: no error that the source did not have.
        const errors = (back.questions[i] as Question).findings.filter((f) => f.severity === "error" && !q.findings.some((x) => x.code === f.code));
        assert.deepEqual(errors, [], `${name}: ${q.title}`);
        questions++;
      });
    }
    assert.ok(questions > 0);
  });

  test("a picture in the text goes out in the file and comes back as the same picture with the same description", () => {
    const PNG = png(20, 20);
    const FILE = "media/p-aaaaaaaaaaaaaaaa.png";
    const q = createQuestion({
      type: "multipleChoice",
      stem: { format: "rich", content: '<p>Look: <oa-media ref="m1"></oa-media></p>' },
      body: { shuffle: false, options: [{ id: "o1", content: plainToRich("Blue"), correct: true }, { id: "o2", content: plainToRich("Red"), correct: false }] },
      media: [{ id: "m1", file: FILE, mime: "image/png", alt: "A blue box" }],
      by: "t",
      at: AT,
    });
    const out = exportMoodleXml([q], { name: "Pictures", media: new Map([[FILE, PNG]]) });
    const back = read(out.files[0]?.content ?? "", "Pictures.xml");
    const m = back.questions[0]?.media[0] as Question["media"][number];
    assert.equal(m.alt, "A blue box");
    assert.deepEqual(back.media?.get(m.file), PNG);
    assert.deepEqual(back.questions[0]?.findings, []);
  });
});
