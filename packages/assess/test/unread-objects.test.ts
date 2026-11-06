/**
 * A question that holds the marker of something the reader could not read.
 *
 * The Word reader leaves "[picture]", "[equation]" or "[symbol]" where a picture it cannot show as placed, an equation with a part it
 * does not know, or a character from a picture font stood, and said so only in the file's own warnings. The question that held the marker
 * came out as parsed, with the figure it depends on gone. It now carries a warning of its own: it needs a look, it is never an error, the
 * note goes when the last marker is taken out of the text, and a person can dismiss it.
 *
 * A table inside a question's text is the same kind of thing: it is read cell by cell as lines of text, and nothing said so on the
 * question, only on the file. The question now says it, unless the question stands in the table (a test item file that puts each
 * question in a cell), which is the table's words and not a table that was flattened.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { standardTextImporter } from "../src/import/standard-text.ts";
import { wordImporter } from "../src/import/word.ts";
import { dismissFinding, editQuestion, withRecomputedFindings } from "../src/model/create.ts";
import { FindingCode, liveFindings, verdictFrom } from "../src/model/findings.ts";
import type { Question } from "../src/model/question.ts";
import { plainToRich, richTextToPlain } from "../src/model/richtext.ts";
import { unreadObjectFindings, unreadObjects } from "../src/model/unread-objects.ts";
import { documentToBlocks } from "../src/import/docx/document.ts";
import { openDocx } from "../src/import/docx/package.ts";
import { docx, paragraph, run, table } from "./support/docx-writer.ts";
import { drawing, png, pictureParts } from "./support/images.ts";

const OPTIONS = { file: "t.docx", at: "2026-01-01T00:00:00.000Z", author: "test" };
const oMath = (inner: string): string => `<m:oMath>${inner}</m:oMath>`;
const r = (text: string): string => `<m:r><m:t>${text}</m:t></m:r>`;
const BLUE = png(40, 30);

const noted = (q: Question) => q.findings.filter((f) => f.code === FindingCode.UnreadObject);
const word = (lines: string[], pictures: Parameters<typeof pictureParts>[0] = []): Question[] =>
  wordImporter.parseBytes(docx({ body: lines.join(""), ...pictureParts(pictures) }), OPTIONS).questions as Question[];

const OPTIONS_AND_KEY = [paragraph(run("a) Blue")), paragraph(run("b) Red")), paragraph(run("Answer: a"))];

describe("a picture the reader could not keep", () => {
  const cropped = word([paragraph(run("1. Look at the figure. Which colour is it? ") + `<w:r>${drawing("rId10", { alt: "A rectangle", crop: { l: 20000 } })}</w:r>`), ...OPTIONS_AND_KEY], [
    { rId: "rId10", part: "word/media/image1.png", bytes: BLUE },
  ]);
  const q = cropped[0] as Question;

  test("leaves the question needing a look, with a note of its own that says what is missing", () => {
    assert.equal(cropped.length, 1);
    assert.equal(noted(q).length, 1);
    assert.equal(noted(q)[0]?.severity, "warn");
    assert.match(noted(q)[0]?.message ?? "", /one picture in the source that could not be read, marked \[picture\]/);
    assert.equal(verdictFrom(q.findings), "needsReview");
  });

  test("the answer key is still read: the note is about the figure, and nothing was guessed", () => {
    assert.ok(!q.findings.some((f) => f.code === FindingCode.NoAnswerKey));
    const body = q.body as { options: Array<{ correct?: boolean }> };
    assert.deepEqual(body.options.map((o) => o.correct === true), [true, false]);
  });

  test("a picture that was kept does not raise it", () => {
    const kept = word([paragraph(run("1. Look at the figure. Which colour is it? ") + `<w:r>${drawing("rId10", { alt: "A rectangle" })}</w:r>`), ...OPTIONS_AND_KEY], [
      { rId: "rId10", part: "word/media/image1.png", bytes: BLUE },
    ]);
    assert.equal(noted(kept[0] as Question).length, 0);
    assert.equal(verdictFrom((kept[0] as Question).findings), "parsed");
  });
});

describe("an equation the reader could not read", () => {
  test("flags the question, and one that was read does not", () => {
    const refused = word([paragraph(run("1. Solve ") + oMath(r("x") + "<m:odd/>") + run(" for x.")), paragraph(run("a) 1")), paragraph(run("b) 2")), paragraph(run("Answer: b"))]);
    assert.equal(noted(refused[0] as Question).length, 1);
    assert.match(noted(refused[0] as Question)[0]?.message ?? "", /one equation in the source that could not be read, marked \[equation\]/);
    const understood = word([paragraph(run("1. Solve ") + oMath(r("x")) + run(" for x.")), paragraph(run("a) 1")), paragraph(run("b) 2")), paragraph(run("Answer: b"))]);
    assert.equal(noted(understood[0] as Question).length, 0);
  });

  test("a marker in an option flags the question as the one in the stem does", () => {
    const inOption = word([paragraph(run("1. Which one is it?")), paragraph(run("a) ") + oMath(r("x") + "<m:odd/>")), paragraph(run("b) 2")), paragraph(run("Answer: b"))]);
    assert.equal(noted(inOption[0] as Question).length, 1);
  });
});

/** A document of paragraphs and tables, and what the reader made of it. */
function wordWith(parts: string[]) {
  const bytes = docx({ body: parts.join("") });
  const pkg = openDocx(bytes);
  return { questions: wordImporter.parseBytes(bytes, OPTIONS).questions as Question[], read: documentToBlocks(pkg.xml(pkg.mainDocument)!) };
}
const cells = (rows: string[][]): string => table(rows.map((row) => row.map((c) => paragraph(run(c)))));
const flattened = (q: Question) => q.findings.filter((f) => f.code === FindingCode.TableFlattened);

// A table that is not a grid (one column) is not kept as a table, so it is read cell by cell and the question says so. A grid is kept
// as a table, and has its own tests (tables-in-stem.test.ts).
describe("a table inside a question that is not kept as a table", () => {
  const stats = wordWith([
    paragraph(run("1. Use the table to find the mean of the scores.")),
    cells([["Scores"], ["Ana 80"], ["Ben 90"]]),
    ...OPTIONS_AND_KEY.map((p) => p),
    paragraph(run("2. Next question?")),
    paragraph(run("a) Yes")),
    paragraph(run("b) No")),
    paragraph(run("Answer: a")),
  ]);

  test("is read cell by cell, in order, and the question says its rows and columns were not kept", () => {
    assert.deepEqual([stats.read.stats.tables, stats.read.stats.tablesPlain], [1, 1]);
    const q = stats.questions[0] as Question;
    assert.equal(richTextToPlain(q.stem).replace(/\s+/g, " "), "Use the table to find the mean of the scores. Scores Ana 80 Ben 90");
    assert.equal(flattened(q).length, 1);
    assert.equal(flattened(q)[0]?.severity, "warn");
    assert.match(flattened(q)[0]?.message ?? "", /read cell by cell, in order, as 3 lines of text, so its rows and columns are not kept/);
    assert.equal(verdictFrom(q.findings), "needsReview");
  });

  test("leaves the answer key alone, and the question after the table is not flagged", () => {
    const q = stats.questions[0] as Question;
    assert.ok(!q.findings.some((f) => f.code === FindingCode.NoAnswerKey));
    assert.deepEqual((q.body as { options: Array<{ correct?: boolean }> }).options.map((o) => o.correct === true), [true, false]);
    assert.equal(flattened(stats.questions[1] as Question).length, 0);
    assert.equal(verdictFrom((stats.questions[1] as Question).findings), "parsed");
  });

  test("a question that stands in a table, with no layout of ours to read it, is not flagged: its words are the table's", () => {
    const home = wordWith([cells([["1. Which one is it?"], ["a) This"], ["b) That"], ["Answer: b"]]), cells([["2. And this one?"], ["a) Yes"], ["b) No"], ["Answer: a"]])]);
    assert.deepEqual([home.read.stats.tables, home.read.stats.tablesPlain], [2, 2]);
    assert.equal(home.questions.length, 2);
    for (const q of home.questions) assert.equal(flattened(q).length, 0);
  });

  test("a second table in the same question is counted with the first, in one note", () => {
    const two = wordWith([
      paragraph(run("1. Compare the two tables.")),
      cells([["A", "1"]]),
      cells([["B", "2"]]),
      paragraph(run("a) A is larger")),
      paragraph(run("b) B is larger")),
      paragraph(run("Answer: b")),
    ]);
    assert.equal(flattened(two.questions[0] as Question).length, 1);
    assert.match(flattened(two.questions[0] as Question)[0]?.message ?? "", /as 4 lines of text/);
  });

  test("goes with the file's own count, which is unchanged", () => {
    const result = wordImporter.parseBytes(docx({ body: [paragraph(run("1. Q?")), cells([["x", "y"]]), ...OPTIONS_AND_KEY].join("") }), OPTIONS);
    assert.ok(result.fileFindings.some((f) => /1 table was read cell by cell/.test(f.message)));
  });
});

describe("what is counted", () => {
  const text = [
    "1. See [picture] and [picture] and then solve [equation] for [symbol].",
    "a) The [Picture] again",
    "b) Neither",
    "Answer: b",
    "Feedback: look at [picture].",
  ].join("\n");
  const q = standardTextImporter.parse(text, OPTIONS).questions[0] as Question;

  test("every marker in the stem, the options and the feedback, whatever the case, in a note that lists the kinds", () => {
    const found = unreadObjects(q);
    // Two in the stem, one in option a (written with a capital, as the PDF reader writes it) and one in the feedback.
    assert.deepEqual([found.picture, found.equation, found.symbol, found.total], [4, 1, 1, 6]);
    assert.match(noted(q)[0]?.message ?? "", /4 pictures, one equation and one symbol/);
  });

  test("only the exact words: the editor's own tokens and ordinary brackets are not these", () => {
    const own = standardTextImporter.parse("1. Compare [picture 2] with [equation 1] and [a picture] and [pictures].\na) One\nb) Two\nAnswer: a\n", OPTIONS).questions[0] as Question;
    assert.equal(noted(own).length, 0);
    assert.deepEqual(unreadObjectFindings(own), []);
  });
});

describe("after the question is edited", () => {
  const q = standardTextImporter.parse("1. Look at [picture] and say what it shows.\na) A cat\nb) A dog\nAnswer: a\n", OPTIONS).questions[0] as Question;

  test("the note stays while a marker stays, even when the edit is to something else", () => {
    const edited = editQuestion(q, { title: "A new title" }, { by: "t", at: "2026-01-02T00:00:00.000Z" });
    assert.equal(noted(edited).length, 1);
  });

  test("the note goes when the last marker is taken out, and does not come back", () => {
    const described = editQuestion(q, { stem: plainToRich("Look at the photograph of a cat and say what it shows.") }, { by: "t", at: "2026-01-02T00:00:00.000Z" });
    assert.equal(noted(described).length, 0);
    assert.equal(verdictFrom(described.findings), "parsed");
    const again = editQuestion(described, { title: "Cat" }, { by: "t", at: "2026-01-03T00:00:00.000Z" });
    assert.equal(noted(again).length, 0);
  });

  test("a person who dismisses it keeps it dismissed through the next edit, and the question then reads as parsed", () => {
    const dismissed = dismissFinding(q, FindingCode.UnreadObject, "someone", "2026-01-02T00:00:00.000Z");
    assert.equal(verdictFrom(dismissed.findings), "parsed");
    const edited = editQuestion(dismissed, { stem: plainToRich("Look at [picture] and say what it shows, in a word.") }, { by: "t", at: "2026-01-03T00:00:00.000Z" });
    assert.equal(noted(edited).length, 1);
    assert.equal(noted(edited)[0]?.dismissed, true);
    assert.deepEqual(liveFindings(edited.findings).filter((f) => f.code === FindingCode.UnreadObject), []);
  });

  test("an edit never raises it: a marker typed by hand in the editor is only text", () => {
    const clean = standardTextImporter.parse("1. Name the planet.\na) Mars\nb) Venus\nAnswer: a\n", OPTIONS).questions[0] as Question;
    const typed = editQuestion(clean, { stem: plainToRich("Name the planet in [picture].") }, { by: "t", at: "2026-01-02T00:00:00.000Z" });
    assert.equal(noted(typed).length, 0);
    assert.equal(noted(withRecomputedFindings(typed)).length, 0);
  });
});
