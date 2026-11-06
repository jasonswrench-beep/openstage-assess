/**
 * Equations in documents written by Word itself, read by the importer.
 *
 * The tests of the equation reader use XML written by hand, which is only as good as what its author believes Word writes. This has
 * Word build each kind of equation through its own object model (word-equations.ps1), one in each question of a document, and checks
 * that the reader finds what Word built: the LaTeX that the parts it was given make, and no equation left unread.
 *
 * It needs Windows with Microsoft Word installed and is not part of `npm test`. Run it with
 * `npm run check:word-equations --workspace packages/assess`. `--update-fixtures` keeps what Word wrote in
 * fixtures/word-authored/equations, where `npm test` reads it on any machine.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { wordImporter } from "../../src/import/word.ts";
import type { Question } from "../../src/model/question.ts";
import { withoutAuthor } from "../support/word-authored.ts";
import { wordIsAvailable } from "./ask-word.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "..", "..", "..", "..", "fixtures", "word-authored", "equations");
const OPTIONS = { file: "word.docx", at: "2026-01-01T00:00:00.000Z", author: "check" };

/** The LaTeX of the equation in each question of equations-constructs, in the order word-equations.ps1 builds them; undefined where it is only to be read and shown. */
export const EXPECTED: Array<[string, string | undefined]> = [
  ["fraction", "\\frac{a}{b+1}"],
  ["root", "\\sqrt{x+1}"],
  ["cube root", "\\sqrt[3]{x}"],
  ["superscript", "x^{2}"],
  ["subscript", "x_{i}"],
  ["subscript and superscript", "x_{i}^{2}"],
  ["sum", "\\sum\\limits_{i=1}^{n}i"],
  ["integral", "\\int_{0}^{1}x"],
  ["function", "\\sin x"],
  ["accent", "\\hat{a}"],
  ["bar", "\\overline{x}"],
  ["limit", "\\lim_{x\\to0}"],
  ["upper limit", "\\overset{y}{x}"],
  ["bracket", "\\left( a \\right)"],
  ["array", "\\begin{aligned} x=1 \\end{aligned}"],
  ["brace", "\\underbrace{x+y}"],
  ["prescript", "{}_{6}^{12}C"],
  ["box", "\\boxed{x}"],
  ["matrix", "\\begin{matrix} 1 \\end{matrix}"],
  ["typed", "x=\\alpha+\\pi"],
];

function main(): void {
  if (!wordIsAvailable()) {
    console.log("This check needs Windows with Microsoft Word installed. Nothing was run.");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "openassess-word-equations-"));
  try {
    const out = join(dir, "authored");
    mkdirSync(out);
    const quoted = (path: string): string => `'${path.replace(/'/g, "''")}'`;
    const script = `$Out = ${quoted(out)}\n${readFileSync(join(here, "word-guard.ps1"), "utf8")}\n${readFileSync(join(here, "word-equations.ps1"), "utf8")}`;
    const said = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "& ([scriptblock]::Create([Console]::In.ReadToEnd()))"], { input: script, encoding: "utf8", timeout: 600_000 });
    console.log(said.trim());

    const documents = new Map<string, Uint8Array>();
    for (const file of readdirSync(out)) if (file.endsWith(".docx")) documents.set(file.slice(0, -5), new Uint8Array(readFileSync(join(out, file))));

    let disagreements = 0;
    const say = (name: string, message: string): void => {
      console.log(`${name}: ${message}`);
      disagreements++;
    };

    const constructs = documents.get("equations-constructs");
    if (!constructs) say("equations-constructs", "Word did not write it");
    else {
      const result = wordImporter.parseBytes(constructs, OPTIONS);
      for (const f of result.fileFindings) if (/equations? (was|were) not read/.test(f.message)) say("equations-constructs", f.message);
      EXPECTED.forEach(([name, want], i) => {
        const q = result.questions[i] as Question | undefined;
        const got = q?.math.map((m) => m.latex);
        console.log(`  ${name.padEnd(28)} ${got ? JSON.stringify(got) : "(no question)"}`);
        if (!q) return say(name, "no question was read for it");
        if (q.math.length !== 1) return say(name, `${q.math.length} equations were read, not 1`);
        if (want !== undefined && got?.[0] !== want) say(name, `read as ${JSON.stringify(got?.[0])}, and Word was given ${JSON.stringify(want)}`);
      });
      if (result.questions.length !== EXPECTED.length) say("equations-constructs", `${result.questions.length} questions were read, not ${EXPECTED.length}`);
    }

    const display = documents.get("equations-display");
    if (!display) say("equations-display", "Word did not write it");
    else {
      const result = wordImporter.parseBytes(display, OPTIONS);
      const q = result.questions[0] as Question | undefined;
      const got = q?.math.map((m) => m.latex);
      console.log(`  display equation             ${JSON.stringify(got)}`);
      if (!q || q.math.length !== 1 || q.math[0]!.latex !== "\\frac{x}{2}") say("equations-display", `read as ${JSON.stringify(got)}, and Word was given a fraction of x over 2`);
      if (result.questions.length !== 1) say("equations-display", `${result.questions.length} questions were read, not 1`);
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
