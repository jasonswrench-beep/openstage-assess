/**
 * Documents written by Word itself, read by the importer.
 *
 * Every other test here reads documents made by the writer in test/support, which is
 * not Word. This has Word write a few (word-author.ps1): a question to a table, a
 * grid, an answer key in a table, an outline list with the right options in bold, a
 * table with a merged title row, typed lines with an Answer line, numbered and
 * lettered lists, a publisher's layout of a table for each question with a table
 * inside it for each option, and a matching exercise as a table of rows. They are the XML Word really writes, so what the reader makes of
 * them is the nearest this project has to a real file until the dialect pack is in.
 *
 * It then asks Word what labels it shows on the list documents and compares.
 *
 * With --update-fixtures it also keeps the documents in fixtures/word-authored, where
 * test/word-authored.test.ts reads them on any machine, Word or not. Run it again
 * whenever the sample documents or what they should read as change.
 *
 * It needs Windows with Microsoft Word installed and is not part of `npm test`.
 * Run it with `npm run check:word-authored --workspace packages/assess`.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { docxToBlocks } from "../../src/import/word.ts";
import { EXPECTED, problemsWith, withoutAuthor } from "../support/word-authored.ts";
import { askWord, wordIsAvailable } from "./ask-word.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "..", "..", "..", "..", "fixtures", "word-authored");

function main(): void {
  if (!wordIsAvailable()) {
    console.log("This check needs Windows with Microsoft Word installed. Nothing was run.");
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "openassess-word-authored-"));
  try {
    const out = join(dir, "authored");
    mkdirSync(out);
    const quoted = (path: string): string => `'${path.replace(/'/g, "''")}'`;
    const script = `$Out = ${quoted(out)}\n${readFileSync(join(here, "word-guard.ps1"), "utf8")}\n${readFileSync(join(here, "word-author.ps1"), "utf8")}`;
    const said = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "& ([scriptblock]::Create([Console]::In.ReadToEnd()))"], {
      input: script,
      encoding: "utf8",
      timeout: 600_000,
    });
    console.log(said.trim());

    const documents = new Map<string, Uint8Array>();
    for (const file of readdirSync(out).filter((n) => n.endsWith(".docx"))) {
      documents.set(file.replace(/\.docx$/, ""), new Uint8Array(readFileSync(join(out, file))));
    }

    let disagreements = 0;
    const say = (name: string, message: string): void => {
      console.log(`${name}: ${message}`);
      disagreements++;
    };

    for (const name of Object.keys(EXPECTED)) {
      const bytes = documents.get(name);
      if (!bytes) {
        say(name, "Word did not write it");
        continue;
      }
      const { problems, result } = problemsWith(name, bytes);
      for (const problem of problems) say(name, problem);
      if (problems.length > 0 && result) {
        console.log("  blocks:", JSON.stringify(docxToBlocks(bytes).blocks.map((b) => [b.listLabel ?? "", b.text])));
        console.log("  findings:", JSON.stringify(result.fileFindings.map((f) => f.message)));
      }
    }

    // What Word shows on the list documents, against what the reader worked out from the XML Word wrote.
    const listed = new Map([...documents].filter(([name]) => EXPECTED[name]?.labels));
    if (listed.size > 0) {
      const word = askWord(listed, "labels");
      for (const [name, bytes] of listed) {
        const ours = docxToBlocks(bytes).blocks.map((b) => b.listLabel ?? "");
        const theirs = word[name] ?? [];
        if (ours.length !== theirs.length) {
          say(name, `Word reads ${theirs.length} paragraphs, the reader ${ours.length}`);
          continue;
        }
        ours.forEach((label, i) => {
          if (label !== theirs[i]) say(name, `paragraph ${i + 1}: the reader says "${label}", Word says "${theirs[i]}"`);
        });
      }
    }

    console.log(`${documents.size} documents written by Word, ${disagreements} disagreements.`);
    if (disagreements > 0) {
      process.exitCode = 1;
    } else if (process.argv.includes("--update-fixtures")) {
      mkdirSync(FIXTURES, { recursive: true });
      for (const [name, bytes] of documents) writeFileSync(join(FIXTURES, `${name}.docx`), withoutAuthor(bytes));
      console.log(`Kept in ${FIXTURES}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main();
