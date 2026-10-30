/**
 * The Word importer, measured.
 *
 * The main measure is differential. The text fixtures already have hand-checked
 * expected files, so each is written out as a .docx and must come back exactly as
 * the text version does: same questions, same findings, same orphans, and the same
 * source positions, because a block in a Word file is a line of the text. That
 * gives hundreds of checked questions with no new labelling.
 *
 * The documents here are made by a writer in test/support, not by Word. They show
 * the front-end is wired correctly and survives the mess a person leaves in a file.
 * They do not show that real Word files read correctly; that is the dialect pack
 * and the real chapters in docs/word-import-plan.md.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runHarness } from "../src/harness/run.ts";
import { scoreFile, type ExpectedFile } from "../src/harness/score.ts";
import { importerFor, IMPORTERS, runImporter } from "../src/import/registry.ts";
import { standardTextImporter } from "../src/import/standard-text.ts";
import { linesToBlocks, type ImportResult, type SourceBlock } from "../src/import/types.ts";
import { docxToBlocks, wordImporter, WORD_PROFILE_ID } from "../src/import/word.ts";
import { FindingCode } from "../src/model/findings.ts";
import { richTextToPlain } from "../src/model/richtext.ts";
import { DELETED_TEXT, docx, docxFromLines, FOOTER_TEXT, HEADER_TEXT, numberLines, paragraph, run } from "./support/docx-writer.ts";
import { soup } from "./support/soup.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "..", "..", "..", "fixtures", "standard-format");
const OPTIONS = { file: "t.docx", at: "2026-01-01T00:00:00.000Z", author: "test" };

const linesOf = (text: string) => text.replace(/\r\n?/g, "\n").split("\n");

/** Codes only a Word file can raise, so they are not expected on the text version. */
const FRONT_END = new Set<string>([FindingCode.TrackedChangesPresent, FindingCode.UnreadContent]);

/** Everything about a result that should not depend on how the text arrived. */
function project(result: ImportResult) {
  return {
    questions: result.questions.map((q) => ({
      type: q.type,
      title: q.title,
      points: q.points,
      stem: q.stem,
      body: q.body,
      feedback: q.feedback,
      metadata: q.metadata,
      media: q.media,
      findings: q.findings.map((f) => [f.code, f.severity, f.field ?? "", f.message]).sort(),
      source: q.origin?.source ? [q.origin.source.firstBlock, q.origin.source.lastBlock] : null,
    })),
    orphans: result.orphans.map((o) => [o.text, o.reason, o.source.firstBlock, o.source.lastBlock]),
    fileFindings: result.fileFindings.filter((f) => !FRONT_END.has(f.code)).map((f) => [f.code, f.severity, f.message]),
    counts: result.counts,
  };
}

describe("a question in a Word file is a question", () => {
  const lines = ["1) Which is a planet?", "a. Sirius", "*b. Mars", "c. The Sun", "", "2) The sky is blue.", "*a. True", "b. False"];

  test("comes out of the same code with the profile and file recorded", () => {
    const result = wordImporter.parseBytes(docxFromLines(lines), OPTIONS);
    assert.equal(result.profile, WORD_PROFILE_ID);
    assert.equal(result.file, "t.docx");
    assert.deepEqual(result.questions.map((q) => q.type), ["multipleChoice", "trueFalse"]);
    assert.equal(richTextToPlain(result.questions[0]!.stem), "Which is a planet?");
    for (const q of result.questions) {
      assert.equal(q.origin?.profile, WORD_PROFILE_ID);
      assert.equal(q.origin?.source?.file, "t.docx");
    }
    assert.deepEqual(result.counts, { parsed: 2, needsReview: 0, failed: 0, orphans: 0 });
  });

  test("records the block range it came from, which is the line range of the text", () => {
    const result = wordImporter.parseBytes(docxFromLines(lines), OPTIONS);
    assert.deepEqual(result.questions.map((q) => [q.origin?.source?.firstBlock, q.origin?.source?.lastBlock]), [[0, 3], [5, 7]]);
  });

  test("is registered for .docx, and the text importer is untouched", () => {
    assert.equal(importerFor("bank.DOCX"), wordImporter);
    assert.equal(importerFor("bank.txt"), standardTextImporter);
    assert.equal(importerFor("bank.xyz"), undefined);
    assert.ok(IMPORTERS.includes(wordImporter));
  });

  test("a string is refused with a message that says to use bytes", () => {
    assert.throws(() => wordImporter.parse("1) text", OPTIONS), /reads a \.docx file as bytes/);
  });

  test("blocks already made from a Word file are accepted", () => {
    const blocks: SourceBlock[] = linesToBlocks(lines.join("\n"));
    const result = wordImporter.parse(blocks, OPTIONS);
    assert.equal(result.profile, WORD_PROFILE_ID);
    assert.equal(result.questions.length, 2);
  });

  test("a file that is not a Word file ends in a readable error", () => {
    assert.throws(() => wordImporter.parseBytes(new TextEncoder().encode("1) just text\n*a. x\nb. y\n"), OPTIONS), /could not be opened as a Word document/);
  });
});

describe("a list label is read as the page shows it", () => {
  const typed = "1. Which is a planet?\na. Sirius\n*b. Mars\nc. The Sun\n\n2. Next?\n*a. Yes\nb. No\n";

  test("a label kept apart from its text reads like one typed by hand", () => {
    const labelled: SourceBlock[] = [
      { index: 0, text: "Which is a planet?", listLabel: "1." },
      { index: 1, text: "Sirius", listLabel: "a." },
      { index: 2, text: "Mars", listLabel: "*b." },
      { index: 3, text: "The Sun", listLabel: "c." },
      { index: 4, text: "" },
      { index: 5, text: "Next?", listLabel: "2." },
      { index: 6, text: "Yes", listLabel: "*a." },
      { index: 7, text: "No", listLabel: "b." },
    ];
    assert.deepEqual(project(standardTextImporter.parse(labelled, OPTIONS)), project(standardTextImporter.parse(typed, OPTIONS)));
  });

  test("an empty item still shows its label, so an empty answer is reported as one", () => {
    const blocks: SourceBlock[] = [
      { index: 0, text: "Q?", listLabel: "1." },
      { index: 1, text: "Yes", listLabel: "*a." },
      { index: 2, text: "", listLabel: "b." },
    ];
    const [q] = standardTextImporter.parse(blocks, OPTIONS).questions;
    assert.ok(q!.findings.some((f) => f.code === FindingCode.EmptyOption));
  });
});

describe("the text fixtures, written out as Word files, come back identical", () => {
  const styles: Array<{ name: string; make: (lines: string[], seed: number) => Uint8Array }> = [
    { name: "typed labels", make: (lines) => docxFromLines(lines) },
    { name: "noise", make: (lines, seed) => docxFromLines(lines, { noise: true, seed }) },
    // Word's own lists: the numbers and letters are not in the text at all.
    { name: "Word lists, one for each kind of label", make: (lines) => docxFromLines(lines, { numbering: { mode: "lists" } }) },
    { name: "Word lists, in instances that carry on from each other", make: (lines) => docxFromLines(lines, { numbering: { mode: "lists", split: true } }) },
    { name: "Word lists for the options, typed question numbers", make: (lines) => docxFromLines(lines, { numbering: { mode: "lists", optionsOnly: true } }) },
    { name: "one multilevel list", make: (lines) => docxFromLines(lines, { numbering: { mode: "multilevel" } }) },
    { name: "one multilevel list, from paragraph styles", make: (lines) => docxFromLines(lines, { numbering: { mode: "style" } }) },
    {
      name: "Word lists with noise",
      make: (lines, seed) =>
        docxFromLines(lines, { noise: true, seed, numbering: { mode: (["lists", "multilevel", "style"] as const)[seed % 3] as "lists", split: seed % 2 === 0 } }),
    },
  ];

  test("every fixture, in every style, matches the text version and scores in full", async () => {
    const names = (await readdir(FIXTURES)).filter((n) => n.endsWith(".txt")).sort();
    assert.ok(names.length >= 20, "the corpus should be present");

    let questions = 0;
    for (const name of names) {
      const text = await readFile(join(FIXTURES, name), "utf8");
      const expected = JSON.parse(await readFile(join(FIXTURES, `${name}.expected.json`), "utf8")) as ExpectedFile;
      const direct = project(standardTextImporter.parse(text, OPTIONS));

      for (const style of styles) {
        for (let seed = 1; seed <= 4; seed++) {
          const via = wordImporter.parseBytes(style.make(linesOf(text), seed), OPTIONS);
          assert.deepEqual(project(via), direct, `${name} as ${style.name} (seed ${seed}) differs from the text version`);
          const score = scoreFile({ ...expected, file: name }, via);
          assert.equal(score.score, 1, `${name} as ${style.name} (seed ${seed}) did not score in full`);
        }
      }
      questions += expected.questions.length;
    }
    assert.ok(questions >= 57, `only ${questions} questions were compared`);
  });

  test("the numbered forms really are numbered by Word, with no label left in the text", async () => {
    const names = (await readdir(FIXTURES)).filter((n) => n.endsWith(".txt")).sort();
    let multilevel = 0;
    let styled = 0;
    let labelled = 0;
    for (const name of names) {
      const lines = linesOf(await readFile(join(FIXTURES, name), "utf8"));
      if (numberLines(lines, { mode: "multilevel" }).mode === "multilevel") multilevel++;
      if (numberLines(lines, { mode: "style" }).mode === "style") styled++;
      for (const mode of ["lists", "multilevel", "style"] as const) {
        const { blocks } = docxToBlocks(docxFromLines(lines, { numbering: { mode } }));
        assert.equal(blocks.length, lines.length, `${name} (${mode}) has a block for every line`);
        for (const b of blocks.filter((x) => x.listLabel !== undefined)) {
          labelled++;
          assert.equal(b.text.startsWith(b.listLabel as string), false, `${name} (${mode}): "${b.text}" still has its label typed`);
        }
      }
    }
    assert.ok(labelled > 600, `only ${labelled} labelled paragraphs`);
    assert.ok(multilevel >= 6 && styled >= 6, `only ${multilevel} fixtures fit one multilevel list (${styled} by style); the other forms would not be exercised`);
  });

  test("noise adds findings about the file and never changes a question", async () => {
    const text = await readFile(join(FIXTURES, "03-mixed-types.txt"), "utf8");
    const via = wordImporter.parseBytes(docxFromLines(linesOf(text), { noise: true, seed: 3 }), OPTIONS);
    const codes = via.fileFindings.map((f) => f.code);
    assert.ok(codes.includes(FindingCode.UnreadContent), "the header and footer are counted");
    assert.match(via.fileFindings.map((f) => f.message).join(" "), /headers or footers have text/);
    assert.equal(JSON.stringify(via).includes(HEADER_TEXT), false, "a header is never read as content");
    assert.equal(JSON.stringify(via).includes(FOOTER_TEXT), false, "a footer is never read as content");
    assert.equal(JSON.stringify(via).includes(DELETED_TEXT), false, "deleted text is never read");
  });
});

describe("through the real harness", () => {
  test("a folder of .docx fixtures is scored by the same gate as the text ones", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openassess-word-"));
    try {
      const names = (await readdir(FIXTURES)).filter((n) => n.endsWith(".txt")).sort();
      let expectedQuestions = 0;
      for (const name of names) {
        const text = await readFile(join(FIXTURES, name), "utf8");
        const expected = JSON.parse(await readFile(join(FIXTURES, `${name}.expected.json`), "utf8")) as ExpectedFile;
        const docxName = name.replace(/\.txt$/, ".docx");
        await writeFile(join(dir, docxName), docxFromLines(linesOf(text), { noise: name.length % 2 === 0, seed: name.length }));
        await writeFile(join(dir, `${docxName}.expected.json`), JSON.stringify({ ...expected, file: docxName }));
        expectedQuestions += expected.questions.length;
      }

      const run = await runHarness(dir);
      assert.equal(run.directoryMissing, false);
      assert.deepEqual(run.unscored, []);
      assert.deepEqual(run.missingSources, []);
      assert.equal(run.files.length, names.length);
      assert.equal(run.expectedTotal, expectedQuestions);
      assert.equal(run.correctTotal, expectedQuestions, "every question is right, not most");
      assert.equal(run.score, 1, run.files.filter((f) => f.score < 1).map((f) => f.file).join(", "));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("runImporter decodes text for a text importer and hands bytes to a Word one", () => {
    const text = "1) Q?\n*a. Yes\nb. No\n";
    assert.equal(runImporter(standardTextImporter, new TextEncoder().encode(text), OPTIONS).questions.length, 1);
    assert.equal(runImporter(wordImporter, docxFromLines(linesOf(text)), OPTIONS).questions.length, 1);
  });
});

describe("what a Word file holds that a text file cannot is reported once, for the file", () => {
  const findings = (bytes: Uint8Array) => docxToBlocks(bytes).findings;

  test("a clean file reports nothing", () => {
    assert.deepEqual(findings(docx({ body: paragraph(run("1) Q?")) })), []);
  });

  test("tracked changes: what happened to them is said, as a warning", () => {
    const body = paragraph('<w:ins w:id="1" w:author="a">' + run("added") + '</w:ins><w:del w:id="2" w:author="a"><w:r><w:delText>gone</w:delText></w:r></w:del>');
    const [found, ...rest] = findings(docx({ body }));
    assert.equal(rest.length, 0);
    assert.equal(found?.code, FindingCode.TrackedChangesPresent);
    assert.equal(found?.severity, "warn");
    assert.match(found?.message ?? "", /1 insertion, 1 deletion.*changes accepted/);
  });

  test("pictures and equations: each is marked in the text and counted", () => {
    const body = paragraph(run("See ") + "<w:r><w:drawing/></w:r>" + run(" and ") + "<m:oMath><m:r><m:t>x</m:t></m:r></m:oMath>");
    const found = findings(docx({ body }));
    assert.deepEqual(found.map((f) => f.code), [FindingCode.UnreadContent, FindingCode.UnreadContent]);
    assert.match(found[0]!.message, /1 picture, shape or text box was not read.*\[picture\]/);
    assert.match(found[1]!.message, /1 equation was not read.*\[equation\]/);
    assert.ok(found.every((f) => f.severity === "warn"));
    const result = wordImporter.parseBytes(docx({ body: paragraph(run("1) See ")) + paragraph("<w:r><w:drawing/></w:r>") }), OPTIONS);
    assert.ok(JSON.stringify(result).includes("[picture]"), "the marker reaches the question");
  });

  test("notes, symbols and text in places that were not read", () => {
    const body = paragraph(run("x") + '<w:r><w:footnoteReference w:id="1"/></w:r><w:r><w:sym w:char="F0FC"/></w:r>') + "<w:odd><w:t>lost words</w:t></w:odd>";
    const messages = findings(docx({ body })).map((f) => f.message).join("\n");
    assert.match(messages, /footnote or endnote is referred to/);
    assert.match(messages, /symbol character was not read/);
    assert.match(messages, /Text in w:odd was not read/);
  });

  test("comments and headers are information, not warnings", () => {
    const body = paragraph(run("x") + '<w:r><w:commentReference w:id="1"/></w:r>');
    const found = findings(docx({ body, headers: ["A header"], footers: ["A footer"] }));
    assert.equal(found.length, 2);
    assert.ok(found.every((f) => f.severity === "info"));
    assert.match(found.map((f) => f.message).join(" "), /comment is attached.*2 headers or footers have text/);
  });

  test("an empty header is not worth mentioning", () => {
    assert.deepEqual(findings(docx({ body: paragraph(run("x")), headers: ["   "] })), []);
  });
});

describe("generated files lose nothing, and Word makes no difference", () => {
  test("a file of lines in no sensible order reads the same as a text file or a Word file, and every marker survives", () => {
    for (const wide of [false, true]) {
      for (let seed = 1; seed <= 150; seed++) {
        const { text, markers } = soup(seed, wide);
        const direct = standardTextImporter.parse(text, OPTIONS);
        const via = wordImporter.parseBytes(docxFromLines(linesOf(text), { noise: true, seed }), OPTIONS);
        assert.deepEqual(project(via), project(direct), `seed ${seed}${wide ? " (wide)" : ""} differs\n${text}`);

        const everything = JSON.stringify([via.questions, via.orphans, via.fileFindings]);
        for (const marker of markers) assert.ok(everything.includes(marker), `seed ${seed}: ${marker} was lost in the Word file\n${text}`);
        for (const hidden of [HEADER_TEXT, FOOTER_TEXT, DELETED_TEXT]) {
          assert.equal(everything.includes(hidden), false, `seed ${seed}: "${hidden}" was read as content`);
        }
      }
    }
  });

  test("the same lines numbered by Word's lists, in any order, read the same too", () => {
    for (const mode of ["lists", "multilevel", "style"] as const) {
      for (let seed = 1; seed <= 60; seed++) {
        const { text, markers } = soup(seed, seed % 2 === 0);
        const direct = standardTextImporter.parse(text, OPTIONS);
        const via = wordImporter.parseBytes(
          docxFromLines(linesOf(text), { noise: seed % 3 === 0, seed, numbering: { mode, split: seed % 2 === 1 } }),
          OPTIONS,
        );
        assert.deepEqual(project(via), project(direct), `${mode}, seed ${seed} differs\n${text}`);
        const everything = JSON.stringify([via.questions, via.orphans, via.fileFindings]);
        for (const marker of markers) assert.ok(everything.includes(marker), `${mode}, seed ${seed}: ${marker} was lost\n${text}`);
      }
    }
  });
});

describe("speed", () => {
  test("500 questions in a Word file import within the proposed budget of 3 seconds", () => {
    const lines: string[] = [];
    for (let i = 1; i <= 500; i++) {
      lines.push(`${i}) Which of these is the answer to question number ${i}, and why does it matter?`, "a. A plausible but wrong option", `*b. The right option for question ${i}`, "c. Another wrong option", "d. None of these", "");
    }
    const bytes = docxFromLines(lines, { noise: true, seed: 11 });
    const started = performance.now();
    const result = wordImporter.parseBytes(bytes, OPTIONS);
    const took = performance.now() - started;
    assert.equal(result.questions.length, 500);
    assert.equal(result.counts.parsed, 500);
    assert.ok(took < 3000, `500 questions took ${took.toFixed(0)} ms (${(bytes.length / 1024).toFixed(0)} KB of .docx)`);
  });

  test("the same 500 questions numbered by Word's lists, each form, within the same budget", () => {
    const lines: string[] = [];
    for (let i = 1; i <= 500; i++) {
      lines.push(`${i}) Which of these is the answer to question number ${i}, and why does it matter?`, "a. A plausible but wrong option", `*b. The right option for question ${i}`, "c. Another wrong option", "d. None of these", "");
    }
    for (const mode of ["lists", "multilevel", "style"] as const) {
      const bytes = docxFromLines(lines, { noise: true, seed: 11, numbering: { mode } });
      const started = performance.now();
      const result = wordImporter.parseBytes(bytes, OPTIONS);
      const took = performance.now() - started;
      assert.equal(result.counts.parsed, 500, mode);
      assert.ok(took < 3000, `${mode}: 500 questions took ${took.toFixed(0)} ms`);
    }
  });
});
