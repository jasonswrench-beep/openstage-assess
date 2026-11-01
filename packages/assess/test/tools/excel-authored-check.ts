/**
 * A workbook written by Excel itself, read by the question table importer.
 *
 * Every other test of the table importer reads workbooks made by the writer in src/container/xlsx.ts or by hand, which are not
 * Excel. This has Excel write one (excel-author.ps1) with the cases that matter: a typed TRUE, a formula, a line break in a
 * cell, a number kept as text, an error, text with only part of it bold, a hidden row, a hidden sheet. It asks Excel what each
 * cell holds, and compares that with what the reader finds. It also has Excel save the first sheet as CSV (the Windows code
 * page), CSV UTF-8 and Unicode text, which are the three ways a person saves a table as text, and compares those.
 *
 * It needs Windows with Microsoft Excel installed and is not part of `npm test`.
 * Run it with `npm run check:excel-authored --workspace packages/assess`.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { writeXlsx } from "../../src/container/xlsx.ts";
import { spreadsheetImporter } from "../../src/import/spreadsheet.ts";
import { readCsv } from "../../src/import/table-csv.ts";
import { readXlsx } from "../../src/import/table-xlsx.ts";
import type { TableFile } from "../../src/import/table.ts";
import { liveFindings, verdictFrom } from "../../src/model/findings.ts";
import { richTextToPlain } from "../../src/model/richtext.ts";
import type { Question } from "../../src/model/question.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(here, "..", "..", "..", "app", "samples");

interface Says {
  sheet: string;
  row: number;
  col: number;
  kind: "string" | "number" | "boolean" | "error";
  value: string;
  text: string;
  hidden: boolean;
}

const quoted = (path: string): string => `'${path.replace(/'/g, "''")}'`;
const tidy = (v: string): string => (/^-?\d+$/.test(v) ? v : String(Number(Number(v).toPrecision(15))));
const lines = (s: string): string => s.replace(/\r\n?/g, "\n").trim();

function main(): number {
  if (process.platform !== "win32") {
    console.log("This check needs Windows with Microsoft Excel installed. Nothing was run.");
    return 0;
  }
  const dir = mkdtempSync(join(tmpdir(), "openassess-excel-authored-"));
  let disagreements = 0;
  const say = (where: string, message: string): void => {
    console.log(`${where}: ${message}`);
    disagreements++;
  };
  try {
    const out = join(dir, "authored");
    mkdirSync(out);
    // What our own writer makes, for Excel to open: the samples the app offers, and a workbook with every feature the writer has.
    const ours = join(dir, "ours");
    mkdirSync(ours);
    for (const file of readdirSync(SAMPLES).filter((f) => f.endsWith(".xlsx"))) copyFileSync(join(SAMPLES, file), join(ours, file));
    writeFileSync(
      join(ours, "features.xlsx"),
      writeXlsx([
        { name: "Questions", header: true, widths: [8, 40], dropdown: { column: 0, values: ["MC", "TF"], lastRow: 50 }, rows: [["Type", "Question", "Line"], ["MC", "What is this & that <b>?", "one\ntwo"], ["TF", "café € 中", true, 2.5]] },
        { name: "A & B (second)", rows: [["Question"], ["Q?"]] },
      ]),
    );
    const script = `$Out = ${quoted(out)}\n$Ours = ${quoted(ours)}\n${readFileSync(join(here, "excel-guard.ps1"), "utf8")}\n${readFileSync(join(here, "excel-author.ps1"), "utf8")}`;
    const said = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "& ([scriptblock]::Create([Console]::In.ReadToEnd()))"], { input: script, encoding: "utf8", timeout: 600_000 });
    console.log(said.trim());
    if (/PROBLEM|stopping without/.test(said)) return 1;

    const says = JSON.parse(readFileSync(join(out, "excel-says.json"), "utf8").replace(/^﻿/, "")) as { cells: Says[]; sheets: Array<{ name: string; visible: number }> };
    const cells = Array.isArray(says.cells) ? says.cells : [says.cells as unknown as Says];

    // ---- the workbook
    const book = readXlsx(new Uint8Array(readFileSync(join(out, "excel.xlsx"))));
    const names = book.sheets.map((s) => s.name);
    if (JSON.stringify(names) !== JSON.stringify(says.sheets.map((s) => s.name))) say("sheets", `Excel has ${says.sheets.map((s) => s.name).join(" | ")}, the reader found ${names.join(" | ")}`);
    const archive = book.sheets.find((s) => s.name === "Archive");
    if (!archive?.hidden) say("Archive", "Excel hid this sheet, and the reader did not mark it hidden");

    let compared = 0;
    for (const c of cells) {
      const sheet = book.sheets.find((s) => s.name === c.sheet);
      const row = sheet?.rows.find((r) => r.number === c.row);
      const read = row?.cells[c.col - 1] ?? "";
      const expected = c.kind === "string" ? lines(c.value) : c.kind === "number" ? tidy(c.value) : c.kind === "boolean" ? c.value.toUpperCase() : "";
      compared++;
      if (read !== expected) say(`${c.sheet} row ${c.row} column ${c.col}`, `Excel holds ${c.kind} ${JSON.stringify(c.value)}; the reader found ${JSON.stringify(read)}, and expected ${JSON.stringify(expected)}`);
    }
    const hiddenIn = (name: string): number => cells.filter((c) => c.sheet === name && c.hidden).map((c) => c.row).filter((r, i, all) => all.indexOf(r) === i).length;
    const questions = book.sheets.find((s) => s.name === "Questions");
    if (questions?.hiddenRows !== hiddenIn("Questions")) say("Questions", `Excel hides ${hiddenIn("Questions")} row(s) with something in them; the reader counted ${questions?.hiddenRows}`);

    // ---- the same sheet saved as text, three ways
    const texts: Array<[string, string]> = [["excel-code-page.csv", "CSV (Windows code page)"], ["excel-utf8.csv", "CSV UTF-8"], ["excel-unicode.txt", "Unicode text"]];
    for (const [file, label] of texts) {
      const table: TableFile = readCsv(new Uint8Array(readFileSync(join(out, file))));
      const sheet = table.sheets[0];
      for (const c of cells.filter((x) => x.sheet === "Questions")) {
        const read = sheet?.rows.find((r) => r.number === c.row)?.cells[c.col - 1] ?? "";
        const expected = lines(c.text);
        compared++;
        if (read !== expected) say(`${label}, row ${c.row} column ${c.col}`, `Excel shows ${JSON.stringify(c.text)}; the reader found ${JSON.stringify(read)}`);
      }
    }

    // ---- what the importer makes of the workbook, as a person would see it
    const result = spreadsheetImporter.parseBytes?.(new Uint8Array(readFileSync(join(out, "excel.xlsx"))), { file: "excel.xlsx" });
    if (!result) throw new Error("no result");
    const plain = (q: Question): string => richTextToPlain(q.stem);
    const marked = (q: Question): string[] => ((q.body as unknown as { options: Array<{ content: unknown; correct: boolean }> }).options ?? []).filter((o) => o.correct).map((o) => richTextToPlain(o.content as never));
    const byStem = (start: string): Question | undefined => result.questions.find((q) => plain(q).startsWith(start));
    const expect = (what: string, ok: boolean, detail = ""): void => {
      compared++;
      if (!ok) say(`importer, ${what}`, detail || "was not as Excel wrote it");
    };
    expect("question count", result.questions.length === 9, `${result.questions.length} questions, expected 9 (8 on Questions with its hidden row, and 1 on the hidden sheet Archive)`);
    expect("a typed answer letter", JSON.stringify(marked(byStem("Which planet is nearest") as Question)) === JSON.stringify(["Mercury"]));
    expect("a formula's stored answer", JSON.stringify(marked(byStem("Which letter comes first") as Question)) === JSON.stringify(["z"]));
    expect("a line break in a cell", plain(byStem("Which letter comes first") as Question).includes("Pick one."));
    const correctOf = (q: Question | undefined): unknown => (q?.body as unknown as { correct?: boolean } | undefined)?.correct;
    expect("a typed TRUE", correctOf(byStem("The Sun is a star")) === true);
    expect("a typed FALSE in a hidden row", correctOf(byStem("The Moon is a star")) === false);
    expect("a number kept as text", byStem("007") !== undefined, "the stem 007 was not found as text");
    expect("an error cell is not a key", verdictFrom((byStem("007") as Question).findings) !== "parsed" && liveFindings((byStem("007") as Question).findings).every((f) => !/#DIV/.test(f.message) || f.severity !== "error"));
    expect("numbers as answers", JSON.stringify(marked(byStem("Numbers as answers") as Question)) === JSON.stringify(["42"]));
    expect("text with part of it bold", plain(byStem("Name the largest") as Question) === "Name the largest planet.");
    expect("a hidden sheet", byStem("Old question") !== undefined);
    expect("a sheet of notes is said, not read", result.fileFindings.some((f) => /Notes & rules/.test(f.message)));

    // ---- what Excel finds in the workbooks our own writer made
    type OursSays = Array<{ file: string; sheets: Array<{ name: string; a1: string; a1bold: boolean; b2: string; validation: number }> }>;
    const parsed = JSON.parse(readFileSync(join(out, "ours-says.json"), "utf8").replace(/^﻿/, "")) as OursSays | OursSays[number];
    const opened: OursSays = Array.isArray(parsed) ? parsed : [parsed];
    const wanted: Record<string, Array<{ name: string; a1: string; b2: string; bold: boolean; validation: number }>> = {
      "solar-system-question-table.xlsx": [{ name: "Questions", a1: "Type", b2: "Which planet is closest to the Sun?", bold: true, validation: 3 }],
      "blank-question-table.xlsx": [
        { name: "Questions", a1: "Type", b2: "Which channel suits a quick yes or no between two colleagues?", bold: true, validation: 3 },
        { name: "How to fill it in", a1: "How to fill in the Questions sheet", b2: "", bold: false, validation: 0 },
      ],
      "features.xlsx": [
        { name: "Questions", a1: "Type", b2: "What is this & that <b>?", bold: true, validation: 3 },
        { name: "A & B (second)", a1: "Question", b2: "", bold: false, validation: 0 },
      ],
    };
    for (const [file, sheets] of Object.entries(wanted)) {
      const got = opened.find((o) => o.file === file);
      compared++;
      if (!got) {
        say(`Excel opening ${file}`, "Excel did not open it");
        continue;
      }
      if (JSON.stringify(got.sheets.map((s) => s.name)) !== JSON.stringify(sheets.map((s) => s.name))) say(`Excel opening ${file}`, `sheets are ${got.sheets.map((s) => s.name).join(" | ")}, expected ${sheets.map((s) => s.name).join(" | ")}`);
      sheets.forEach((want, i) => {
        const have = got.sheets[i];
        if (!have) return;
        compared += 4;
        if (have.a1 !== want.a1) say(`Excel opening ${file}, ${want.name}`, `A1 shows ${JSON.stringify(have.a1)}, expected ${JSON.stringify(want.a1)}`);
        if (want.b2 !== "" && have.b2 !== want.b2) say(`Excel opening ${file}, ${want.name}`, `B2 shows ${JSON.stringify(have.b2)}, expected ${JSON.stringify(want.b2)}`);
        if (have.a1bold !== want.bold) say(`Excel opening ${file}, ${want.name}`, `A1 bold is ${have.a1bold}, expected ${want.bold}`);
        if (have.validation !== want.validation) say(`Excel opening ${file}, ${want.name}`, `the drop-down on A2 is type ${have.validation}, expected ${want.validation} (0 is no drop-down: Excel calls it a cell that takes any input)`);
      });
    }

    console.log(`${compared} comparisons, ${disagreements} disagreements with Excel.`);
    return disagreements === 0 ? 0 : 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exitCode = main();
