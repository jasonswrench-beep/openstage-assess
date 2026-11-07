/**
 * A Brightspace question library, read as Brightspace writes one.
 *
 * The shape here was taken from a real library file (a question library as a zip with an `imsmanifest.xml` and a `questiondb.xml`
 * whose root is a QTI 1.2 `questestinterop` holding an `objectbank`), the first file from a real learning system this reader was
 * tried on. Before that it had been written from memory of Canvas and of the standard, and it read none of the 80 questions: the
 * answers' words sit inside a `flow_mat`, the metadata field is `qti_metadatafield` and not `qtimetadatafield`, a multiple choice
 * question is written with `rcardinality="Multiple"` and says what it is in `qmd_questiontype`, and the points are `qmd_weighting`.
 *
 * The questions below are made up, in that shape. The real file is kept only on the machine that has it (`fixtures/publisher/lms`,
 * which is git-ignored) and is held to a second, independent reading of its own XML when it is there.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { textEntry, unzipSync, zipSync } from "../src/container/zip.ts";
import { importerForContent, runImporter } from "../src/import/registry.ts";
import type { Question } from "../src/model/question.ts";
import { richTextToPlain } from "../src/model/richtext.ts";

const AT = "2026-11-07T00:00:00.000Z";
const plain = (v: unknown): string => richTextToPlain(v as never).replace(/\s+/g, " ").trim();
const read = (bytes: Uint8Array, file = "questiondb.zip") => runImporter(importerForContent(file, bytes), bytes, { file, at: AT, author: "test" });
const options = (q: Question): Array<[string, boolean]> => (q.body as unknown as { options: Array<{ content: unknown; correct: boolean }> }).options.map((o) => [plain(o.content), o.correct]);
const said = (q: Question): string => q.findings.map((f) => `${f.severity}: ${f.message}`).join(" | ");

interface Answer {
  text: string;
  /** The number the condition for this answer sets. */
  score: number | string;
  feedback?: string;
}

/** One item in the shape Brightspace writes for a multiple choice question. */
function item(n: number, stem: string, answers: Answer[], extra: { title?: string; type?: string; weighting?: string; shuffle?: string; hint?: string; decvar?: string; cardinality?: string } = {}): string {
  const id = `QUES_${1000 + n}`;
  const title = extra.title ?? stem.slice(0, 20);
  const field = (label: string, entry: string): string => `<qti_metadatafield><fieldlabel>${label}</fieldlabel><fieldentry>${entry}</fieldentry></qti_metadatafield>`;
  const labels = answers.map((a, i) => `<flow_label class="Block"><response_label ident="${id}_A${i}"><flow_mat><material><mattext texttype="text/html"><![CDATA[${a.text}]]></mattext></material></flow_mat></response_label></flow_label>`).join("");
  const conditions = answers
    .map((a, i) => `<respcondition title="Response Condition ${i + 1}"><conditionvar><varequal respident="${id}_LID">${id}_A${i}</varequal></conditionvar><setvar action="Set">${typeof a.score === "number" ? a.score.toFixed(4) : a.score}</setvar><displayfeedback feedbacktype="Response" linkrefid="${id}_IF${i}" /></respcondition>`)
    .join("");
  const feedback = answers.map((a, i) => `<itemfeedback ident="${id}_IF${i}"><material><mattext texttype="text/plain">${a.feedback ?? ""}</mattext></material></itemfeedback>`).join("");
  return (
    `<item d2l_2p0:id="${n}" ident="OBJ_${1000 + n}" label="${id}" d2l_2p0:page="1" title="${title}" ><itemmetadata><qtimetadata>${field("qmd_computerscored", "yes")}${field("qmd_questiontype", extra.type ?? "Multiple Choice")}${field("qmd_weighting", extra.weighting ?? "1.0000")}</qtimetadata></itemmetadata>` +
    `<itemproc_extension><d2l_2p0:difficulty>1</d2l_2p0:difficulty><d2l_2p0:isbonus>no</d2l_2p0:isbonus><d2l_2p0:ismandatory>no</d2l_2p0:ismandatory></itemproc_extension>` +
    `<presentation><flow><material><mattext texttype="text/html"><![CDATA[${stem}]]></mattext></material><response_extension><d2l_2p0:display_style>2</d2l_2p0:display_style></response_extension>` +
    `<response_lid ident="${id}_LID" rcardinality="${extra.cardinality ?? "Multiple"}"><render_choice${extra.shuffle === undefined ? "" : ` shuffle="${extra.shuffle}"`}>${labels}</render_choice></response_lid></flow></presentation>` +
    `<hint><hintmaterial><flow_mat><mattext texttype="text/plain">${extra.hint ?? ""}</mattext></flow_mat></hintmaterial></hint>` +
    `<resprocessing>${extra.decvar ?? ""}${conditions}</resprocessing>${feedback}</item>`
  );
}

/** A library as a zip: the manifest and `questiondb.xml`. */
function library(items: string[]): Uint8Array {
  const xml =
    `﻿<?xml version="1.0" encoding="UTF-8"?>\n<questestinterop>\n<objectbank ident="QLIB_1" xmlns:d2l_2p0="http://desire2learn.com/xsd/d2lcp_v2p0">` +
    `<section d2l_2p0:id="1" ident="SECT_1" title="Section-Unit 1"><presentation_material><flow_mat><flow_mat><material><mattext texttype="text/plain">Made for the test</mattext></material></flow_mat></flow_mat></presentation_material>${items.join("\n")}</section></objectbank></questestinterop>`;
  const manifest = `<?xml version="1.0" encoding="UTF-8"?><manifest identifier="MANIFEST_1" xmlns:d2l_2p0="http://desire2learn.com/xsd/d2lcp_v2p0" xmlns="http://www.imsglobal.org/xsd/imscp_v1p1"><resources><resource identifier="res_question_library" type="webcontent" d2l_2p0:material_type="d2lquestionlibrary" href="questiondb.xml" /></resources></manifest>`;
  return zipSync([textEntry("imsmanifest.xml", manifest), textEntry("questiondb.xml", xml)]);
}

const four = (right: number, extra: Partial<Answer>[] = []): Answer[] => ["Berlin", "Paris", "Rome", "Madrid"].map((text, i) => ({ text, score: i === right ? 100 : 0, ...(extra[i] ?? {}) }));

describe("a question library the way Brightspace writes it", () => {
  test("is read: the question, the answers in their order, the key, the points and the shuffle", () => {
    const result = read(library([item(1, "What is the capital of France?", four(1), { shuffle: "no", weighting: "2.5000" }), item(2, "Which city is the capital of Italy?", four(2))]));
    assert.deepEqual(result.counts, { parsed: 2, needsReview: 0, failed: 0, orphans: 0 });
    const [a, b] = result.questions as [Question, Question];
    assert.equal(plain(a.stem), "What is the capital of France?");
    assert.deepEqual(options(a), [["Berlin", false], ["Paris", true], ["Rome", false], ["Madrid", false]]);
    assert.equal(a.points, 2.5, "`qmd_weighting`");
    assert.equal((a.body as { shuffle: boolean }).shuffle, false, 'shuffle="no" in lower case is no');
    assert.equal((b.body as { shuffle: boolean }).shuffle, true, "no attribute at all is the default, which is to shuffle");
    assert.deepEqual(options(b).filter(([, right]) => right), [["Rome", true]]);
    assert.equal(b.points, 1);
    assert.ok(result.fileFindings.every((f) => f.severity !== "error"), result.fileFindings.map((f) => f.message).join(" | "));
  });

  test("a multiple choice question written with rcardinality Multiple is single answer, and one that is not multiple choice is not", () => {
    // Two answers each set to the whole: a single answer question with two right answers is said, and both are marked as the file has them.
    const two = read(library([item(1, "Which are cities in Spain?", [{ text: "Madrid", score: 100 }, { text: "Paris", score: 0 }, { text: "Seville", score: 100 }])]));
    assert.match(said(two.questions[0] as Question), /2 answers are each scored as the whole of the points/);
    assert.deepEqual(options(two.questions[0] as Question).map(([, right]) => right), [true, false, true]);
    // A multi-select question whose shape is not known is not read as having a key; nothing is guessed.
    const select = read(library([item(1, "Which are cities in Spain?", [{ text: "Madrid", score: 100 }, { text: "Paris", score: 0 }, { text: "Seville", score: 100 }], { type: "Multi-Select" })]));
    const q = select.questions[0] as Question;
    assert.equal(q.type, "multipleResponse");
    assert.deepEqual(options(q).map(([, right]) => right), [false, false, false], "none marked, since the scoring is not a shape this reader knows for several answers");
    assert.equal(select.counts.failed, 1, "and the question fails for lack of a key, which is how a person is told");
  });

  test("a true or false question is told by its type, with one right answer", () => {
    const tf = read(library([item(1, "A light-year is a measure of time.", [{ text: "True", score: 0 }, { text: "False", score: 100 }], { type: "True/False" })]));
    const q = tf.questions[0] as Question;
    assert.equal(q.type, "trueFalse");
    assert.equal((q.body as { correct: boolean }).correct, false);
  });

  test("a scale that is not declared is 0 to 100 or 0 to 1, and any other biggest score is not called the whole", () => {
    const keyed = (answers: Answer[]): Question => read(library([item(1, "Which?", answers)])).questions[0] as Question;
    assert.deepEqual(options(keyed([{ text: "A", score: 0 }, { text: "B", score: 100 }])).map((o) => o[1]), [false, true], "100 is the whole");
    assert.deepEqual(options(keyed([{ text: "A", score: "0" }, { text: "B", score: "1" }])).map((o) => o[1]), [false, true], "1 is the whole of a 0 to 1 scale");
    const half = keyed([{ text: "A", score: 0 }, { text: "B", score: 50 }]);
    assert.deepEqual(options(half).map((o) => o[1]), [false, false], "50 with nothing above it might be half of a whole that is not written down");
    assert.match(said(half), /No answer is scored as the whole/);
    const mixed = keyed([{ text: "A", score: 100 }, { text: "B", score: 50 }, { text: "C", score: 0 }]);
    assert.deepEqual(options(mixed).map((o) => o[1]), [true, false, false], "an answer worth half is not the key, and is said");
    assert.match(said(mixed), /worth part of the points/);
    // A declared scale is believed, as it always was.
    const declared = keyed([{ text: "A", score: 0 }, { text: "B", score: 5 }]);
    assert.equal(declared.type, "multipleChoice");
    const withDecvar = read(library([item(1, "Which?", [{ text: "A", score: 0 }, { text: "B", score: 5 }], { decvar: '<outcomes><decvar maxvalue="5" minvalue="0" varname="SCORE" vartype="Decimal"/></outcomes>' })])).questions[0] as Question;
    assert.deepEqual(options(withDecvar).map((o) => o[1]), [false, true]);
  });

  test("a condition that scores a response this question does not have is no key", () => {
    const about = item(1, "Which?", [{ text: "A", score: 100 }, { text: "B", score: 0 }]).replace('respident="QUES_1001_LID">QUES_1001_A0', 'respident="SOME_OTHER_LID">QUES_1001_A0');
    assert.notEqual(about, item(1, "Which?", [{ text: "A", score: 100 }, { text: "B", score: 0 }]), "the file was changed");
    const result = read(library([about]));
    const q = result.questions[0] as Question;
    assert.deepEqual(options(q).map((o) => o[1]), [false, false], "nothing is marked on a rule about something else");
    assert.equal(result.counts.failed, 1);
    assert.match(said(q), /A scoring rule of this question was not read/);
  });

  test("a title that is only the first words of the question is left out, and one that is not is kept", () => {
    const result = read(library([item(1, "Which of the following defines hypothesis?", four(0), { title: "Which of the followi" }), item(2, "Which of the following defines theory?", four(0), { title: "Ch 1, question 2" })]));
    const [cut, own] = result.questions as [Question, Question];
    assert.equal(cut.title, "Which of the following defines hypothesis?", "titled from its own words, not cut in the middle of one");
    assert.equal(own.title, "Ch 1, question 2");
  });

  test("feedback on an answer is found by the condition that scores it, an empty entry is nothing, and a hint is said", () => {
    const answers = four(1, [{ feedback: "Berlin is in Germany." }, { feedback: "Right: Paris." }]);
    const result = read(library([item(1, "What is the capital of France?", answers, { hint: "Think of the Seine." }), item(2, "Which city is the capital of Italy?", four(2))]));
    const [a, b] = result.questions as [Question, Question];
    const fb = (a.body as { options: Array<{ feedback?: unknown }> }).options.map((o) => (o.feedback ? plain(o.feedback) : ""));
    assert.deepEqual(fb, ["Berlin is in Germany.", "Right: Paris.", "", ""]);
    assert.match(said(a), /A hint was not read: "Think of the Seine\."/);
    assert.equal(b.findings.filter((f) => /not read/.test(f.message)).length, 0, "empty feedback and an empty hint are not a loss");
  });

  test("the settings Brightspace keeps for each question are counted and said once for the file", () => {
    const result = read(library([item(1, "One?", four(0)), item(2, "Two?", four(1))]));
    const note = result.fileFindings.find((f) => /Brightspace/.test(f.message));
    assert.ok(note, result.fileFindings.map((f) => f.message).join(" | "));
    assert.equal(note.severity, "info");
    assert.match(note.message, /2 questions carry Brightspace's own settings \(difficulty, bonus, mandatory\), which are not read/);
  });

  test("the same library cut at many lengths, or with bytes changed, is read or refused and never throws", () => {
    const bytes = library([item(1, "What is the capital of France?", four(1)), item(2, "Which city is the capital of Italy?", four(2))]);
    for (let at = 0; at < bytes.length; at += Math.ceil(bytes.length / 120)) assert.doesNotThrow(() => read(bytes.slice(0, at)), `cut at ${at}`);
    let state = 7;
    const next = (): number => (state = (state * 1103515245 + 12345) & 0x7fffffff);
    for (let run = 0; run < 150; run++) {
      const copy = bytes.slice();
      for (let k = 0; k < 3; k++) copy[next() % copy.length] = next() & 0xff;
      assert.doesNotThrow(() => read(copy), `run ${run}`);
    }
  });
});

describe("the real Brightspace library, when it is here", () => {
  const file = join(fileURLToPath(new URL("../../../fixtures/publisher/lms/", import.meta.url)), "Ch1IntroductiontoPsychology.zip");
  const here = existsSync(file);

  test("every question comes in with the stem, the answers in their order, the key and the points its own XML gives", { skip: here ? false : "not here; the folder is git-ignored and local" }, () => {
    const bytes = new Uint8Array(readFileSync(file));
    const raw = Buffer.from(unzipSync(bytes).get("questiondb.xml") as Uint8Array).toString("utf8").replace(/^﻿/, "");
    const items = [...raw.matchAll(/<item [\s\S]*?<\/item>/g)].map((m) => m[0]);
    const result = read(bytes, "Ch1IntroductiontoPsychology.zip");
    assert.equal(result.questions.length, items.length);
    // A second reading, by regular expressions on the raw text, that shares no code with the importer. Spaces are left out on both
    // sides: it is the words and their order that are held, and a tag in the middle of a word is no fault.
    const decode = (t: string): string =>
      t
        .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&nbsp;/g, " ")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&");
    const squash = (t: string): string => t.replace(/\s+/g, "");
    const words = (s: string): string => squash(decode((/<!\[CDATA\[([\s\S]*?)\]\]>/.exec(s)?.[1] ?? "").replace(/<[^>]+>/g, " ")));
    items.forEach((it, i) => {
      const q = result.questions[i] as Question;
      const mark = `question ${i + 1}`;
      assert.equal(squash(plain(q.stem)), words(/<presentation>\s*<flow>\s*<material>([\s\S]*?)<\/material>/.exec(it)?.[1] ?? ""), `${mark}: stem`);
      const labels = [...it.matchAll(/<response_label ident="([^"]+)">([\s\S]*?)<\/response_label>/g)].map((m) => ({ id: m[1] as string, text: words(m[2] as string) }));
      const got = options(q);
      assert.deepEqual(got.map(([t]) => squash(t)), labels.map((l) => l.text), `${mark}: answers`);
      const whole = [...it.matchAll(/<respcondition[^>]*>\s*<conditionvar>\s*<varequal[^>]*>([^<]+)<\/varequal>\s*<\/conditionvar>\s*<setvar[^>]*>([\d.]+)<\/setvar>/g)].filter((m) => Number(m[2]) >= 100).map((m) => (m[1] as string).trim());
      assert.deepEqual(got.map(([, right]) => right), labels.map((l) => whole.includes(l.id)), `${mark}: key`);
      assert.equal(whole.length, 1, `${mark}: exactly one answer is scored as the whole`);
      assert.equal(q.points, Number(/qmd_weighting<\/fieldlabel>\s*<fieldentry>([^<]*)</.exec(it)?.[1]), `${mark}: points`);
      assert.equal(q.type, "multipleChoice", mark);
    });
    assert.deepEqual(result.counts, { parsed: items.length, needsReview: 0, failed: 0, orphans: 0 });
  });
});
