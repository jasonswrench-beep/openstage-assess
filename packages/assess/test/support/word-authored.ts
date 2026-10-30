/**
 * What the documents that Word wrote itself should read as.
 *
 * The documents are in fixtures/word-authored. They were written by Word, through its
 * own object model, by test/tools/word-authored-check.ts, so their XML is what Word
 * really writes and not what our own test writer imagines. Everything in them is a
 * sample sentence, so they can be kept in the repository and read on a machine that has
 * no Word.
 */

import { textEntry, unzipSync, zipSync } from "../../src/container/zip.ts";
import type { ImportResult } from "../../src/import/types.ts";
import { wordImporter } from "../../src/import/word.ts";
import { FindingCode } from "../../src/model/findings.ts";
import type { Question } from "../../src/model/question.ts";
import { richTextToPlain } from "../../src/model/richtext.ts";

export interface Expectation {
  /** For each question, its options with whether each is correct. */
  questions: Array<Array<[string, boolean]>>;
  /** A key mark to give the importer, for a file too short to show its own habit. */
  keyMark?: string;
  /** What the report about tables should say, if there are tables. */
  layout?: string;
  /** Whether the list labels are checked against what Word shows, by the tool. */
  labels?: boolean;
}

const PLANETS: Array<[string, boolean]> = [["Sirius", false], ["Mars", true], ["The Sun", false]];
const STARS: Array<[string, boolean]> = [["Venus", false], ["Earth", false], ["Sirius", true]];

export const EXPECTED: Record<string, Expectation> = {
  "A-question-per-table": { questions: [PLANETS], layout: "labelled rows" },
  "B-grid": {
    questions: [
      [["Sirius", false], ["Mars", true], ["The Sun", false], ["Vega", false]],
      [["Venus", false], ["Earth", false], ["Sirius", true], ["Mars", false]],
    ],
    layout: "a grid with a header row",
  },
  "C-answer-key-table": { questions: [PLANETS, STARS], layout: "an answer key" },
  "D-outline-list-bold-key": { questions: [PLANETS, STARS], keyMark: "bold", labels: true },
  "E-merged-title-row": { questions: [PLANETS], layout: "labelled rows" },
  "F-typed-bold-and-answer-line": { questions: [PLANETS], labels: true },
  "G-numbered-and-lettered-lists": { questions: [PLANETS, STARS], labels: true },
};

/**
 * The document with the name of whoever wrote it taken out of its properties. Word puts the
 * name of the person it is running for in them, and a fixture that is published should not
 * carry it. Every other part of the document is kept exactly as Word wrote it.
 */
export function withoutAuthor(bytes: Uint8Array): Uint8Array {
  const parts = unzipSync(bytes);
  const entries = [...parts].map(([name, data]) => {
    if (name !== "docProps/core.xml") return { name, data };
    const text = new TextDecoder()
      .decode(data)
      .replace(/<dc:creator>[^<]*<\/dc:creator>/, "<dc:creator></dc:creator>")
      .replace(/<cp:lastModifiedBy>[^<]*<\/cp:lastModifiedBy>/, "<cp:lastModifiedBy></cp:lastModifiedBy>");
    return textEntry(name, text);
  });
  return zipSync(entries);
}

export const optionsOf = (q: Question): Array<[string, boolean]> =>
  "options" in q.body ? q.body.options.map((o): [string, boolean] => [richTextToPlain(o.content), o.correct]) : [];

/** What is wrong with the way a document reads, in words; empty when nothing is. */
export function problemsWith(name: string, bytes: Uint8Array): { problems: string[]; result?: ImportResult } {
  const want = EXPECTED[name];
  if (!want) return { problems: [`${name} is not one of the documents Word was asked to write`] };
  const result = wordImporter.parseBytes(bytes, { file: `${name}.docx`, ...(want.keyMark ? { keyMark: want.keyMark } : {}) });
  const problems: string[] = [];

  const got = result.questions.map(optionsOf);
  if (JSON.stringify(got) !== JSON.stringify(want.questions)) {
    problems.push(`read as ${JSON.stringify(got)}, wanted ${JSON.stringify(want.questions)}`);
  }
  if (result.counts.failed > 0) {
    problems.push(`${result.counts.failed} questions failed: ${result.questions.flatMap((q) => q.findings.map((f) => f.message)).join(" | ")}`);
  }
  if (want.layout) {
    const layouts = result.fileFindings.filter((f) => f.code === FindingCode.TableLayout).map((f) => f.message).join(" ");
    if (!layouts.includes(want.layout)) problems.push(`the tables were reported as "${layouts}", not "${want.layout}"`);
  }
  return { problems, result };
}
