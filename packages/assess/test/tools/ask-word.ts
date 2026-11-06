/**
 * Asks Word itself about documents. Shared by the checks in this folder.
 *
 * It writes the documents to a temporary folder, starts a separate hidden Word
 * (see word-labels.ps1 for how it keeps clear of any Word the person has open),
 * and reads back one string for each paragraph of each document: the list label
 * Word shows, or the formatting Word reports.
 *
 * Windows with Microsoft Word installed only.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export type Question = "labels" | "format" | "text" | "pages" | "pictures" | "equations" | "tables";

/** The answers for each document, by name: one string for each paragraph. */
export type Answers = Record<string, string[]>;

export function wordIsAvailable(): boolean {
  return process.platform === "win32";
}

export function askWord(documents: ReadonlyMap<string, Uint8Array>, question: Question): Answers {
  const dir = mkdtempSync(join(tmpdir(), "openassess-word-check-"));
  try {
    const folder = join(dir, "documents");
    mkdirSync(folder);
    for (const [name, bytes] of documents) writeFileSync(join(folder, `${name}.docx`), bytes);

    const out = join(dir, "word.json");
    // The script goes in on standard input, not as a file, because script files are switched
    // off on many machines. Nothing about the machine's settings is changed.
    const quoted = (path: string): string => `'${path.replace(/'/g, "''")}'`;
    const script = `$Dir = ${quoted(folder)}\n$Out = ${quoted(out)}\n$What = '${question}'\n${readFileSync(join(here, "word-guard.ps1"), "utf8")}
${readFileSync(join(here, "word-labels.ps1"), "utf8")}`;
    // Read whole and run as one block: fed line by line, PowerShell stops at a blank line inside a block.
    const wholeBlock = "& ([scriptblock]::Create([Console]::In.ReadToEnd()))";
    const said = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", wholeBlock], {
      input: script,
      encoding: "utf8",
      timeout: 600_000,
    });
    console.log(said.trim());

    const raw = JSON.parse(readFileSync(out, "utf8").replace(/^﻿/, "")) as Record<string, string[] | string>;
    const answers: Answers = {};
    for (const [name, value] of Object.entries(raw)) answers[name] = Array.isArray(value) ? value : [value];
    return answers;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
