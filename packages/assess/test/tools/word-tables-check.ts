/**
 * Data tables inside a question's text, in documents written by Word itself, read by the importer.
 *
 * A table that is none of the question layouts, and a grid, is kept as a table of the question. The tests of the reader use documents
 * from our own writer, which is not Word. This has Word write tables in the text of a question (word-tables.ps1): a plain grid, a grid
 * with a header row, one with a merged title row, one with a cell of two paragraphs, and one that is a single column and so is not a
 * grid. It asks Word what each table is (its rows, the text of each cell, whether a row repeats as a header) and holds the reader's own
 * account of the table to that, and checks the question it makes.
 *
 * It needs Windows with Microsoft Word installed and is not part of `npm test`. Run it with
 * `npm run check:word-tables --workspace packages/assess`. `--update-fixtures` keeps what Word wrote in
 * fixtures/word-authored/tables, where `npm test` reads it on any machine.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { docxToBlocks, wordImporter } from "../../src/import/word.ts";
import { FindingCode } from "../../src/model/findings.ts";
import type { Question } from "../../src/model/question.ts";
import { withoutAuthor } from "../support/word-authored.ts";
import { wordIsAvailable } from "./ask-word.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "..", "..", "..", "..", "fixtures", "word-authored", "tables");
const OPTIONS = { file: "word.docx", at: "2026-01-01T00:00:00.000Z", author: "check" };

/** What each document's first question should hold in its stem, apart from the words: a table of the question, or none. */
export const EXPECTED: Record<string, { kept: boolean; head?: boolean; colspan?: boolean; breaks?: boolean }> = {
  "tables-data": { kept: true },
  "tables-header": { kept: true, head: true },
  "tables-merged": { kept: true, colspan: true },
  "tables-cell-paragraphs": { kept: true, breaks: true },
  "tables-one-column": { kept: false },
};

interface WordRow {
  header: boolean;
  cells: string[];
}

function main(): void {
  if (!wordIsAvailable()) {
    console.log("This check needs Windows with Microsoft Word installed. Nothing was run.");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "openassess-word-tables-"));
  try {
    const out = join(dir, "authored");
    mkdirSync(out);
    const quoted = (path: string): string => `'${path.replace(/'/g, "''")}'`;
    const script = `$Out = ${quoted(out)}\n${readFileSync(join(here, "word-guard.ps1"), "utf8")}\n${readFileSync(join(here, "word-tables.ps1"), "utf8")}`;
    const said = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "& ([scriptblock]::Create([Console]::In.ReadToEnd()))"], { input: script, encoding: "utf8", timeout: 600_000 });
    console.log(said.split("\n").filter((l) => !l.startsWith("TABLES:")).join("\n").trim());
    const line = said.split("\n").find((l) => l.startsWith("TABLES:"));
    const word = JSON.parse((line ?? "TABLES: {}").slice("TABLES:".length)) as Record<string, WordRow[] | WordRow>;

    const documents = new Map<string, Uint8Array>();
    for (const file of readdirSync(out)) if (file.endsWith(".docx")) documents.set(file.slice(0, -5), new Uint8Array(readFileSync(join(out, file))));

    let disagreements = 0;
    const say = (name: string, message: string): void => {
      console.log(`${name}: ${message}`);
      disagreements++;
    };
    for (const [name, want] of Object.entries(EXPECTED)) {
      const bytes = documents.get(name);
      if (!bytes) {
        say(name, "Word did not write it");
        continue;
      }
      const result = wordImporter.parseBytes(bytes, OPTIONS);
      const q = result.questions[0] as Question | undefined;
      if (!q || result.questions.length !== 2 && name === "tables-data") {
        say(name, `${result.questions.length} questions were read`);
        continue;
      }
      const html = q.stem.content;
      const kept = html.includes("<table>");
      if (kept !== want.kept) say(name, `the stem ${kept ? "has" : "has no"} table, and ${want.kept ? "one should be kept" : "none should be kept"}: ${html}`);
      if (want.kept) {
        // The reader's own account of the table, held to what Word says it is.
        const grid = [...docxToBlocks(bytes).tables.values()][0];
        const theirs = (Array.isArray(word[name]) ? word[name] : [word[name]]) as WordRow[];
        const ours = grid?.rows ?? [];
        console.log(`${name}: Word reports ${theirs.length} rows (${theirs.map((r) => `${[r.cells].flat().length} cell${[r.cells].flat().length === 1 ? "" : "s"}${r.header ? ", header" : ""}`).join("; ")}); the reader kept ${ours.length} rows as a table of the question`);
        if (ours.length !== theirs.length) say(name, `the reader finds ${ours.length} rows, and Word ${theirs.length}`);
        ours.forEach((row, r) => {
          const cells = (Array.isArray(theirs[r]?.cells) ? theirs[r]?.cells : [theirs[r]?.cells]) as string[];
          const readerCells = row.cells.map((c) => c.text.replace(/\s*\n\s*/g, "\n"));
          const wordCells = cells.map((c) => c.replace(/\r/g, "\n").replace(/\s*\n\s*/g, "\n"));
          if (JSON.stringify(readerCells) !== JSON.stringify(wordCells)) say(name, `row ${r + 1}: the reader has ${JSON.stringify(readerCells)}, and Word ${JSON.stringify(wordCells)}`);
          if (row.header !== (theirs[r]?.header === true)) say(name, `row ${r + 1}: the reader says header ${row.header}, and Word ${theirs[r]?.header === true}`);
        });
        if (want.head && !html.includes("<thead>")) say(name, `no head in ${html}`);
        if (!want.head && /<thead>|<th[ >]/.test(html)) say(name, `a head that Word did not mark: ${html}`);
        if (want.colspan && !/colspan="2"/.test(html)) say(name, `no colspan in ${html}`);
        if (want.breaks && !/<br>/.test(html)) say(name, `no line break in a cell in ${html}`);
        if (q.findings.some((f) => f.code === FindingCode.TableFlattened)) say(name, "a table that was kept is also said to be flattened");
      } else if (!q.findings.some((f) => f.code === FindingCode.TableFlattened)) {
        say(name, "a table that was not kept does not say so");
      }
      if (q.findings.some((f) => f.code === FindingCode.NoAnswerKey)) say(name, "the key was lost");
    }

    console.log(`${documents.size} documents written by Word, ${disagreements} disagreements.`);
    if (disagreements > 0) process.exitCode = 1;
    if (disagreements === 0 && process.argv.includes("--update-fixtures")) {
      mkdirSync(FIXTURES, { recursive: true });
      for (const [name, bytes] of documents) writeFileSync(join(FIXTURES, `${name}.docx`), withoutAuthor(bytes));
      console.log(`Kept in ${FIXTURES}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main();
