/**
 * The review page: what an import made of a file, as one page. It shows the result and decides nothing, so the tests are
 * about what it must never do: show an answer the importer did not find, let the text of a document become part of the page,
 * or drop a question, a check or a line no question used. They use invented text, and read the fixtures only to render each
 * type once.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { standardTextImporter } from "../src/import/standard-text.ts";
import { linesToBlocks, type ImportResult } from "../src/import/types.ts";
import { wordImporter } from "../src/import/word.ts";
import { reviewHtml } from "../src/report/review-html.ts";
import { docx, paragraph, run } from "./support/docx-writer.ts";

const OPTIONS = { file: "bank.txt", at: "2026-01-01T00:00:00.000Z", author: "test" };
const read = (lines: string[], file = "bank.txt"): ImportResult => standardTextImporter.parse(lines.join("\n"), { ...OPTIONS, file });
const page = (lines: string[], file = "bank.txt"): string => reviewHtml(read(lines, file), linesToBlocks(lines.join("\n")).map((b) => b.text));
const occurrences = (html: string, what: string): number => html.split(what).length - 1;

const CLEAN = ["1. What is the capital of France?", "a. Berlin", "*b. Paris", "c. Rome", ""];
const NO_KEY = ["2. What is the capital of Spain?", "a. Lisbon", "b. Madrid", "c. Paris", ""];

describe("the review page", () => {
  test("is one page with no script and no address outside it", () => {
    const html = page([...CLEAN, ...NO_KEY]);
    assert.ok(html.startsWith("<!doctype html>"));
    assert.equal(occurrences(html, "<script"), 0);
    assert.doesNotMatch(html, /(?:src|href|action)="(?:https?:)?\/\//i);
    assert.doesNotMatch(html, /url\(\s*['"]?https?:/i);
  });

  test("shows each question with its verdict, and opens the ones that need a look", () => {
    const html = page([...CLEAN, ...NO_KEY]);
    assert.match(html, /<details class="q v-parsed" id="q1">/, "a question that read cleanly is folded");
    assert.match(html, /<details class="q v-failed" id="q2" open>/, "one that failed is open");
    assert.match(html, /<b>2<\/b><span>questions<\/span>/);
    assert.match(html, /<b>1<\/b><span>parsed<\/span>/);
    assert.match(html, /<b>1<\/b><span>failed<\/span>/);
    assert.match(html, /href="#q2">Go to the first question that needs a look/);
  });

  test("marks the answer the file gave and never shows one it did not", () => {
    const withKey = page(CLEAN);
    assert.equal(occurrences(withKey, 'class="mark"'), 1);
    assert.match(withKey, /<li class="right"><span class="letter">B<\/span><span class="text">Paris<\/span><span class="mark">marked as the answer<\/span>/);
    assert.doesNotMatch(withKey, /No option is marked/);

    const without = page(NO_KEY);
    assert.equal(occurrences(without, 'class="mark"'), 0, "no option is shown as right");
    assert.equal(occurrences(without, 'class="right"'), 0);
    assert.match(without, /No option is marked as the answer\./);
  });

  test("shows the checks a question raised, in words", () => {
    const html = page(NO_KEY);
    assert.match(html, /<li class="sev-error"><span class="sev">Error<\/span> /);
  });

  test("leaves out a check that was dismissed, and still shows that no answer was found", () => {
    const result = read(NO_KEY);
    const question = result.questions[0];
    assert.ok(question && question.findings.length > 0);
    for (const f of question.findings) f.dismissed = true;
    const html = reviewHtml(result, []);
    assert.equal(occurrences(html, 'class="sev-'), 0);
    assert.match(html, /No option is marked as the answer\./, "a dismissed check does not make an answer appear");
  });

  test("shows the lines of the file a question came from, numbered from one", () => {
    const html = page([...CLEAN, ...NO_KEY]);
    assert.match(html, /<summary>The file, lines 1 to 4<\/summary>/);
    assert.match(html, /<span class="no">2<\/span>a\. Berlin/);
    assert.match(html, /<span class="no">3<\/span>\*b\. Paris/);
    assert.match(html, /<summary>The file, lines 6 to 9<\/summary>/, "the second question starts after the blank line");
  });

  test("says line, not lines, for one line", () => {
    // Statements that end with their own answer are questions of one line each.
    const lines = ["1. The Sun is a star. (T)", "", "2. A light-year is a measure of time. (F)", "", "3. Water boils at a lower temperature on a mountain. (True)", ""];
    const html = reviewHtml(read(lines), lines);
    assert.match(html, /<summary>The file, line 1<\/summary>/);
    assert.match(html, /<summary>The file, line 3<\/summary>/);
    assert.doesNotMatch(html, /lines (\d+) to \1\b/);
  });

  test("leaves out the source when it is not given", () => {
    const html = reviewHtml(read(CLEAN));
    assert.equal(occurrences(html, 'class="source"'), 0);
    assert.match(html, /id="q1"/);
  });

  test("lists the text no question used, with its line and why", () => {
    const html = page(["Midterm review sheet", "", ...CLEAN]);
    assert.match(html, /<h2>Text no question used<\/h2><div class="orphan"><p>Midterm review sheet<\/p><p class="why">Line 1\. /);
    assert.match(html, /<b>1<\/b><span>lines no question used<\/span>/);
  });

  test("says so when every line was used, and when no question was found", () => {
    assert.match(page(CLEAN), /Every line of the file was used by a question/);
    const none = reviewHtml(read([]), []);
    assert.match(none, /No question was found in this file\./);
    assert.match(none, /<b>0<\/b><span>questions<\/span>/);
  });

  test("shows the warnings about the file as a whole", () => {
    // A Word file whose right answers are bold: the importer reports, once, that it read the bold as the key.
    const bold = (text: string): string => paragraph(run(text, "<w:b/>"));
    const plain = (text: string): string => paragraph(run(text));
    const body = [1, 2, 3, 4]
      .map((n) => [plain(`${n}. Question number ${n} is which?`), plain("a. wrong one"), bold("b. right one"), plain("c. wrong two"), paragraph("")].join(""))
      .join("");
    const result = wordImporter.parseBytes(docx({ body }), { ...OPTIONS, file: "bold.docx" });
    assert.ok(result.fileFindings.length > 0, "the importer says something about a file that marks answers by formatting");
    const html = reviewHtml(result, []);
    assert.match(html, /<h2>About the file<\/h2><ul class="findings">/);
    assert.match(html, /<li class="sev-warn"><span class="sev">Check<\/span> Bold sets the correct answer apart/);
    assert.equal(occurrences(html, 'class="mark"'), 4, "the four bold options are shown as the answers");
  });

  test("puts the text of the document in the page as text, never as markup", () => {
    const hostile = [
      '1. <script>alert("x")</script> & "quoted" \'single\' <b>bold</b>?',
      "a. <img src=x onerror=alert(1)>",
      "*b. </li></ul><h1>injected</h1>",
      "c. plain",
      "",
    ];
    const html = page(hostile, "a<b>&.txt");
    assert.equal(occurrences(html, "<script"), 0);
    assert.equal(occurrences(html, "<img"), 0);
    assert.equal(occurrences(html, "<h1>injected"), 0);
    assert.equal(occurrences(html, "<h1>"), 1, "the page's own heading, and nothing the file wrote");
    assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; &quot;quoted&quot; &#39;single&#39;/);
    assert.match(html, /<title>Import review - a&lt;b&gt;&amp;\.txt<\/title>/);
  });

  test("renders every type the fixtures hold, with nothing left as a placeholder", () => {
    const folder = fileURLToPath(new URL("../../../fixtures/standard-format/", import.meta.url));
    const seen = new Set<string>();
    for (const name of readdirSync(folder).filter((n) => n.endsWith(".txt"))) {
      const text = readFileSync(join(folder, name), "utf8");
      const result = standardTextImporter.parse(text, { ...OPTIONS, file: name });
      for (const q of result.questions) seen.add(q.type);
      const html = reviewHtml(result, linesToBlocks(text).map((b) => b.text));
      assert.doesNotMatch(html, /undefined|\[object|NaN/, name);
      assert.equal(occurrences(html, "<details"), occurrences(html, "</details>"), `${name}: every fold is closed`);
      assert.equal(occurrences(html, 'class="q '), result.questions.length, `${name}: a question for each one imported`);
    }
    for (const type of ["multipleChoice", "trueFalse", "fillInBlank", "matching"]) assert.ok(seen.has(type), `${type} is in the fixtures, so it was rendered`);
  });

  test("shows a true or false answer, a blank's accepted answers and a pair, from what the question holds", () => {
    const folder = fileURLToPath(new URL("../../../fixtures/standard-format/", import.meta.url));
    const text = readFileSync(join(folder, "03-mixed-types.txt"), "utf8");
    const html = reviewHtml(standardTextImporter.parse(text, { ...OPTIONS, file: "03.txt" }), []);
    assert.match(html, /<span class="label">Accepted<\/span> Zworykin  \|  Vladimir Zworykin/);
    assert.match(html, /<span class="text">Marconi<\/span><span class="arrow">matches<\/span><span class="text">Radio waves<\/span>/);

    const statements = ["1. The Sun is a star. (T)", "", "2. A light-year is a measure of time. (F)", "", "3. Water boils at a lower temperature on a mountain. (True)", ""];
    const answered = reviewHtml(read(statements), []);
    assert.deepEqual([...answered.matchAll(/<span class="label">Answer<\/span> (True|False)/g)].map((m) => m[1]), ["True", "False", "True"]);
  });

  test("a true or false question with no answer shows none", () => {
    const result = read(["Type: TF", "1. The Moon is made of cheese.", ""]);
    const html = reviewHtml(result, []);
    assert.match(html, /No answer is recorded\./);
    assert.doesNotMatch(html, /<span class="label">Answer<\/span>/);
  });
});

describe("the review command", () => {
  const cli = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
  const review = (args: string[]): string =>
    execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, "review", ...args], { encoding: "utf8" });

  test("writes the page for a text file, and for a Word file, and changes neither", () => {
    const dir = mkdtempSync(join(tmpdir(), "openassess-review-"));
    try {
      const text = join(dir, "bank.txt");
      const body = [...CLEAN, ...NO_KEY].join("\n");
      writeFileSync(text, body, "utf8");
      const said = review([text, "--out", join(dir, "text.html")]);
      assert.match(said, /bank\.txt: 2 question\(s\), 1 parsed, 0 need review, 1 failed/);
      const fromText = readFileSync(join(dir, "text.html"), "utf8");
      assert.match(fromText, /<span class="no">3<\/span>\*b\. Paris/);
      assert.equal(readFileSync(text, "utf8"), body, "the file was not changed");

      const word = join(dir, "bank.docx");
      const lines = [...CLEAN, ...NO_KEY];
      writeFileSync(word, docx({ body: lines.map((l) => (l === "" ? paragraph("") : paragraph(run(l)))).join("") }));
      review([word, "--out", join(dir, "word.html")]);
      const fromWord = readFileSync(join(dir, "word.html"), "utf8");
      assert.match(fromWord, /<title>Import review - bank\.docx<\/title>/);
      assert.match(fromWord, /<span class="no">2<\/span>a\. Berlin/);
      assert.match(fromWord, /<details class="q v-failed" id="q2" open>/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses an older .doc file by saying how to save it as .docx", () => {
    const dir = mkdtempSync(join(tmpdir(), "openassess-review-"));
    try {
      const old = join(dir, "bank.doc");
      writeFileSync(old, "x");
      assert.throws(() => execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, "review", old], { encoding: "utf8", stdio: "pipe" }), /Save As/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
