/**
 * Tests for profile one and for the harness that scores it.
 *
 * The harness test is the gate: if the fixture corpus ever scores below the
 * target, the build fails here rather than being noticed later.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { standardTextImporter } from "../src/import/standard-text.ts";
import { verdictOf } from "../src/import/types.ts";
import { runHarness, TARGET_SCORE } from "../src/harness/run.ts";
import { richTextToPlain, collectRefs } from "../src/model/richtext.ts";
import { validateQuestion } from "../src/model/schema.ts";
import { FindingCode } from "../src/model/findings.ts";
import { optionsOf } from "../src/model/question.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "..", "..", "..", "fixtures", "standard-format");

function parse(text: string) {
  return standardTextImporter.parse(text, { file: "test.txt", at: "2026-01-01T00:00:00.000Z", author: "test" });
}

describe("the Standard Format profile", () => {
  test("reads a numbered stem with lettered options and an asterisk key", () => {
    const result = parse(`3) Who determined the exact speed of light?\na. Albert Einstein\n*b) Albert Michelson\nc) Thomas Edison\n`);
    assert.equal(result.questions.length, 1);
    const q = result.questions[0]!;
    assert.equal(q.type, "multipleChoice");
    assert.equal(richTextToPlain(q.stem), "Who determined the exact speed of light?");
    assert.equal(optionsOf(q).filter((o) => o.correct).length, 1);
    assert.equal(richTextToPlain(optionsOf(q)[1]!.content), "Albert Michelson");
    assert.equal(verdictOf(q), "parsed");
  });

  test("every question it produces satisfies the model, including the broken ones", async () => {
    const run = await runHarness(FIXTURES);
    assert.ok(run.files.length > 0, "fixtures must be present");

    const { readdir, readFile } = await import("node:fs/promises");
    for (const name of (await readdir(FIXTURES)).filter((n) => n.endsWith(".txt"))) {
      const result = parse(await readFile(join(FIXTURES, name), "utf8"));
      for (const question of result.questions) {
        const check = validateQuestion(question);
        assert.ok(check.ok, `${name}: ${question.title}\n${check.issues.map((i) => `${i.path}: ${i.message}`).join("\n")}`);
      }
    }
  });

  test("records provenance back to the lines it came from", () => {
    const result = parse(`1) First question?\na. One\n*b. Two\n\n2) Second question?\n*a. Yes\nb. No\n`);
    const second = result.questions[1]!;
    assert.equal(second.origin?.kind, "import");
    assert.equal(second.origin?.source?.file, "test.txt");
    assert.equal(second.origin?.source?.firstBlock, 4);
    assert.equal(second.origin?.source?.lastBlock, 6);
  });

  test("does not guess when no answer is marked", () => {
    const result = parse(`1) Which planet is closest to the sun?\na. Mercury\nb. Venus\n`);
    const q = result.questions[0]!;
    assert.equal(optionsOf(q).some((o) => o.correct), false, "nothing may be guessed correct");
    assert.ok(q.findings.some((f) => f.code === FindingCode.NoAnswerKey && f.severity === "error"));
    assert.equal(verdictOf(q), "failed");
  });

  test("reads an Answers list at the end, keyed by question number", () => {
    const result = parse(`7) What is 2 + 2?\na. 3\nb. 4\nc. 5\n\nAnswers:\n7. B\n`);
    assert.equal(optionsOf(result.questions[0]!)[1]?.correct, true);
    assert.equal(verdictOf(result.questions[0]!), "parsed");
  });

  test("flags an answer key that names an option the question does not have", () => {
    const result = parse(`7) What is 2 + 2?\na. 3\nb. 4\n\nAnswers:\n7. D\n`);
    assert.ok(result.questions[0]!.findings.some((f) => f.code === FindingCode.KeyLetterMissing));
  });

  test("flags an Answers entry for a question that is not in the file", () => {
    const result = parse(`7) What is 2 + 2?\n*b. 4\na. 3\n\nAnswers:\n9. A\n`);
    assert.ok(result.fileFindings.some((f) => f.message.includes("question 9")));
  });

  test("true or false needs True first, exactly as the format says", () => {
    const trueFirst = parse(`1) The sky is blue.\na. True\nb. False\n\nAnswers:\n1. A\n`);
    assert.equal(trueFirst.questions[0]!.type, "trueFalse");
    assert.equal((trueFirst.questions[0]!.body as { correct: boolean }).correct, true);

    const falseFirst = parse(`1) The sky is blue.\na. False\nb. True\n\nAnswers:\n1. A\n`);
    assert.equal(falseFirst.questions[0]!.type, "multipleChoice");
  });

  test("a Points line is sticky until the next one", () => {
    const result = parse(`Points: 2.5\n1) First?\n*a. Yes\nb. No\n\n2) Second?\n*a. Yes\nb. No\n\nPoints: 5\n3) Third?\n*a. Yes\nb. No\n`);
    assert.deepEqual(result.questions.map((q) => q.points), [2.5, 2.5, 5]);
  });

  test("separates question feedback from option feedback", () => {
    const result = parse(
      `1) Which is a measure of centre?\n~ Yes, the mean is.\n@ No, review the chapter.\na. Range\n@ The range measures spread.\n*b. Mean\n`,
    );
    const q = result.questions[0]!;
    assert.equal(richTextToPlain(q.feedback.correct!), "Yes, the mean is.");
    assert.equal(richTextToPlain(q.feedback.incorrect!), "No, review the chapter.");
    assert.equal(richTextToPlain(optionsOf(q)[0]!.feedback!), "The range measures spread.");
  });

  test("keeps an unknown publisher label rather than dropping it", () => {
    const result = parse(`1) A question?\n*a. Yes\nb. No\nMSC: Conceptual\n`);
    const q = result.questions[0]!;
    assert.equal(q.metadata.custom?.["MSC"], "Conceptual");
    assert.ok(q.findings.some((f) => f.code === FindingCode.UnknownMetadataLabel));
    assert.equal(verdictOf(q), "needsReview");
  });

  test("maps the publisher codes it does know", () => {
    const result = parse(`1) A question?\n*a. Yes\nb. No\nDIF: Hard\nREF: 142\nOBJ: 4.1\nTOP: Sampling; Design\n`);
    const m = result.questions[0]!.metadata;
    assert.equal(m.difficulty, "hard");
    assert.equal(m.page, "142");
    assert.equal(m.objective, "4.1");
    assert.deepEqual(m.tags, ["Sampling", "Design"]);
  });

  test("a colon inside a stem is not mistaken for a metadata label", () => {
    const result = parse(`1) Consider this scenario: a manager withholds information. What is that called?\n*a. Employee silence\nb. Voice\n`);
    assert.match(richTextToPlain(result.questions[0]!.stem), /scenario: a manager/);
  });

  test("reads an image tag into a media reference with its alternative text", () => {
    const result = parse(`1) The instrument shown here [ img: "interferometer.jpg" "An interferometer" ] was used by whom?\n*a. Michelson\nb. Edison\n`);
    const q = result.questions[0]!;
    assert.equal(q.media.length, 1);
    assert.equal(q.media[0]?.alt, "An interferometer");
    assert.deepEqual(collectRefs(q.stem).media, [q.media[0]?.id]);
  });

  test("an image with no alternative text is flagged as an accessibility problem", () => {
    const result = parse(`1) The instrument shown here [ img: "x.jpg" ] was used by whom?\n*a. Michelson\nb. Edison\n`);
    assert.ok(result.questions[0]!.findings.some((f) => f.code === FindingCode.MissingAltText));
  });

  test("a raw HTML block is kept but reduced to the supported subset", () => {
    const result = parse(`1) Visit [HTML] <a href="https://example.com">this page</a><script>bad()</script> [/HTML] and answer.\n*a. Yes\nb. No\n`);
    const html = result.questions[0]!.stem.content;
    assert.ok(!html.includes("<script"));
    assert.ok(!html.includes("bad()"));
    assert.ok(html.includes("this page"), "the words inside an unsupported tag survive");
  });

  test("text before the first question is reported as an orphan, not swallowed", () => {
    const result = parse(`Chapter 4 Descriptive Statistics\n\n1) What does the median represent?\n*a. The middle value\nb. The mean\n`);
    assert.equal(result.orphans.length, 1);
    assert.equal(result.orphans[0]?.text, "Chapter 4 Descriptive Statistics");
    assert.equal(result.orphans[0]?.source.firstBlock, 0);
  });

  test("a file with no questions says so rather than returning an empty success", () => {
    const result = parse(`This document has no questions in it at all.\n`);
    assert.equal(result.questions.length, 0);
    assert.ok(result.fileFindings.some((f) => f.severity === "error"));
  });

  test("keeps smart quotes, dashes and ellipses as the author typed them", () => {
    const result = parse(`Type: F\n1) Who wrote “Hamlet” — and when… it’s 1600–1601?\na. Shakespeare\n`);
    assert.equal(richTextToPlain(result.questions[0]!.stem), "Who wrote “Hamlet” — and when… it’s 1600–1601?");
  });
});

describe("the accuracy harness", () => {
  test("the fixture corpus scores at or above the target", async () => {
    const run = await runHarness(FIXTURES);
    assert.ok(run.files.length >= 5, `expected several fixtures, found ${run.files.length}`);
    assert.ok(
      run.score >= TARGET_SCORE,
      `scored ${(run.score * 100).toFixed(1)}%, below the ${(TARGET_SCORE * 100).toFixed(0)}% target:\n` +
        run.files
          .flatMap((f) => f.mismatches.map((m) => `  ${f.file} q${m.questionIndex + 1} ${m.field}: want ${m.expected}, got ${m.actual}`))
          .join("\n"),
    );
  });

  test("every fixture has an expected file beside it", async () => {
    const run = await runHarness(FIXTURES);
    assert.deepEqual(run.unscored, [], "a fixture nobody scores is a fixture nobody maintains");
    assert.deepEqual(run.missingSources, []);
  });

  test("the deliberately broken fixture is read correctly and still fails", async () => {
    const run = await runHarness(FIXTURES);
    const broken = run.files.find((f) => f.file.startsWith("90-"));
    assert.ok(broken, "the broken fixture must be in the corpus");
    assert.equal(broken.correct, broken.expectedCount, "the parser should read a broken file correctly");
    assert.equal(broken.verdicts.failed, broken.expectedCount, "and should mark every question failed");
  });

  test("the harness notices when a parser swallows an orphan", async () => {
    const run = await runHarness(FIXTURES);
    const orphanFixture = run.files.find((f) => f.file.startsWith("91-"));
    assert.ok(orphanFixture);
    assert.equal(orphanFixture.orphans, 2);
    assert.deepEqual(orphanFixture.mismatches, []);
  });
});
