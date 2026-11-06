/**
 * Symbol characters in documents written by Word itself, read by the importer.
 *
 * Word writes a character typed from the Symbol font two ways: Insert Symbol (`w:sym` with the font and a code) and plain letters in
 * a run whose font is Symbol. The tests of the reader use documents from our own writer, which is not Word. This has Word write one
 * of each (word-symbols.ps1) and checks that the reader finds the character Word shows, and that a Wingdings character, which is a
 * picture, is marked where it stood and not guessed.
 *
 * It needs Windows with Microsoft Word installed and is not part of `npm test`. Run it with
 * `npm run check:word-symbols --workspace packages/assess`. `--update-fixtures` keeps what Word wrote in
 * fixtures/word-authored/symbols, where `npm test` reads it on any machine.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { wordImporter } from "../../src/import/word.ts";
import type { Question } from "../../src/model/question.ts";
import { richTextToPlain } from "../../src/model/richtext.ts";
import { withoutAuthor } from "../support/word-authored.ts";
import { wordIsAvailable } from "./ask-word.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "..", "..", "..", "..", "fixtures", "word-authored", "symbols");
const OPTIONS = { file: "word.docx", at: "2026-01-01T00:00:00.000Z", author: "check" };

/** What each document's question should read as, once Word's characters are read. */
export const EXPECTED_STEMS: Record<string, string> = {
  "symbols-insert": "Is the angle α and the error ± small?",
  "symbols-typed": "Which letters are αβγ Greek?",
  "symbols-arial": "Is the error ± or 30 ° small?",
  "symbols-wingdings": "Is this ticked [symbol]?",
};

function main(): void {
  if (!wordIsAvailable()) {
    console.log("This check needs Windows with Microsoft Word installed. Nothing was run.");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "openassess-word-symbols-"));
  try {
    const out = join(dir, "authored");
    mkdirSync(out);
    const quoted = (path: string): string => `'${path.replace(/'/g, "''")}'`;
    const script = `$Out = ${quoted(out)}\n${readFileSync(join(here, "word-guard.ps1"), "utf8")}\n${readFileSync(join(here, "word-symbols.ps1"), "utf8")}`;
    const said = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "& ([scriptblock]::Create([Console]::In.ReadToEnd()))"], { input: script, encoding: "utf8", timeout: 600_000 });
    console.log(said.trim());

    const documents = new Map<string, Uint8Array>();
    for (const file of readdirSync(out)) if (file.endsWith(".docx")) documents.set(file.slice(0, -5), new Uint8Array(readFileSync(join(out, file))));

    let disagreements = 0;
    const say = (name: string, message: string): void => {
      console.log(`${name}: ${message}`);
      disagreements++;
    };
    for (const [name, want] of Object.entries(EXPECTED_STEMS)) {
      const bytes = documents.get(name);
      if (!bytes) {
        say(name, "Word did not write it");
        continue;
      }
      const result = wordImporter.parseBytes(bytes, OPTIONS);
      const q = result.questions[0] as Question | undefined;
      const stem = q ? richTextToPlain(q.stem).replace(/\s+/g, " ") : "";
      if (stem !== want) say(name, `the question reads ${JSON.stringify(stem)}, and Word shows ${JSON.stringify(want)}`);
      if (result.questions.length !== 1) say(name, `${result.questions.length} questions were read, not 1`);
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
