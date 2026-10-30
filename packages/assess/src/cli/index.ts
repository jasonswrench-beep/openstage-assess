#!/usr/bin/env node
/**
 * The OpenAssess command-line tool.
 *
 * Phase 1 and phase 2 have no user interface on purpose: the 95 percent parse
 * target cannot be iterated on through one. This is how the engine is driven
 * until the Tauri shell arrives in phase 3, and it stays afterwards as the way
 * the harness runs in continuous integration.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BANK_EXTENSION, PRODUCT_NAME, ENGINE_VERSION } from "../naming.ts";
import { Bank } from "../bank/store.ts";
import { standardTextImporter } from "../import/standard-text.ts";
import { importerFor, runImporter } from "../import/registry.ts";
import { verdictOf } from "../import/types.ts";
import { formatSummary, summarise } from "../harness/score.ts";
import { runHarness, TARGET_SCORE } from "../harness/run.ts";
import { validateQuestion } from "../model/schema.ts";
import { liveFindings } from "../model/findings.ts";
import { allCapabilities, READ_CONTRACT_VERSION, typeVerdicts } from "../read/index.ts";
import { QUESTION_TYPES } from "../model/question.ts";
import { createQuestion } from "../model/create.ts";
import { localId } from "../model/ids.ts";
import { formatReport } from "../export/types.ts";
import { DESTINATION_ID, exportOpenStageSpreadsheet } from "../export/openstage-spreadsheet.ts";

const USAGE = `${PRODUCT_NAME} engine ${ENGINE_VERSION}

  openassess info <bank${BANK_EXTENSION}>
      Manifest, counts by type and status, finding totals.

  openassess validate <bank${BANK_EXTENSION}>
      Check every question against the model and report what fails.

  openassess new <bank${BANK_EXTENSION}> --title "Course bank"
      Create an empty bank.

  openassess import <file.txt|file.docx> [--out <bank${BANK_EXTENSION}>] [--details] [--key-mark <mark>]
      Read a file (the standard test-bank text format as text, or a Word .docx) and
      report the verdicts. With --out, write the questions into a new bank.
      A Word file may mark the correct option by formatting it. The file is
      read to see whether it does, and the report says what was decided.
      --key-mark overrides that: off, bold, italic, underline, highlight,
      highlight:yellow, color, or color:FF0000.

  openassess export <bank${BANK_EXTENSION}> [--to ${DESTINATION_ID}] [--out <folder>]
      Run the destination check for the question spreadsheet that OpenStage
      Author and Scroll read: what will arrive, what will be lost, what cannot
      go. With --out, write the file or files into that folder.

  openassess search <bank${BANK_EXTENSION}> <words...>
      Search a bank.

  openassess score [fixtures directory] [--details]
      Run the accuracy harness. Exits non-zero below ${(TARGET_SCORE * 100).toFixed(0)} percent.

  openassess perf [--count 500]
      Build a bank of N questions and time open, search and save.

  openassess contract
      Print the read contract version and what each consumer can deliver.
`;

function arg(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
}

function has(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const value = args[i] as string;
    if (value.startsWith("--")) {
      // Flags that take a value consume the next item.
      if (["out", "title", "count", "profile", "to", "key-mark"].includes(value.slice(2))) i++;
      continue;
    }
    out.push(value);
  }
  return out;
}

async function cmdInfo(args: string[]): Promise<number> {
  const path = positional(args)[0];
  if (!path) return fail("Name a bank file.");
  const { bank, report } = await Bank.open(resolve(path));
  const stats = bank.stats();

  console.log(`${bank.manifest.title}  (${bank.manifest.bankId})`);
  console.log(`  format        ${bank.manifest.format} v${bank.manifest.formatVersion}`);
  console.log(`  created       ${bank.manifest.created}`);
  console.log(`  modified      ${bank.manifest.modified}`);
  console.log(`  questions     ${stats.questions}`);
  console.log(`  total points  ${stats.totalPoints}`);
  console.log(`  media files   ${stats.mediaFiles}`);
  console.log(`  opened in     ${report.elapsedMs.toFixed(1)} ms`);

  if (Object.keys(stats.byType).length > 0) {
    console.log("\n  by type");
    for (const [type, count] of Object.entries(stats.byType).sort()) {
      console.log(`    ${type.padEnd(18)} ${count}`);
    }
  }
  if (Object.keys(stats.byStatus).length > 0) {
    console.log("\n  by status");
    for (const [status, count] of Object.entries(stats.byStatus).sort()) {
      console.log(`    ${status.padEnd(18)} ${count}`);
    }
  }
  console.log(`\n  questions with errors    ${stats.withErrors}`);
  console.log(`  questions with warnings  ${stats.withWarnings}`);

  if (report.invalid.length > 0) {
    console.log(`\n  ${report.invalid.length} question file(s) could not be read and were kept untouched:`);
    for (const entry of report.invalid) console.log(`    ${entry.id}`);
  }
  if (report.migratedFrom !== undefined) {
    console.log(`\n  migrated from format version ${report.migratedFrom}`);
    for (const note of report.migrationNotes) console.log(`    ${note}`);
  }
  return 0;
}

async function cmdValidate(args: string[]): Promise<number> {
  const path = positional(args)[0];
  if (!path) return fail("Name a bank file.");
  const { bank, report } = await Bank.open(resolve(path));

  let bad = 0;
  for (const question of bank.sortedQuestions()) {
    const result = validateQuestion(question);
    if (result.ok) continue;
    bad++;
    console.log(`${question.id}  ${question.title}`);
    for (const issue of result.issues) console.log(`    ${issue.path || "<root>"}: ${issue.message}`);
  }
  for (const entry of report.invalid) {
    bad++;
    console.log(`${entry.id}  (unreadable)`);
    for (const issue of entry.issues) console.log(`    ${issue.path || "<root>"}: ${issue.message}`);
  }

  if (bad === 0) {
    console.log(`All ${bank.questions.size} questions satisfy the model.`);
    return 0;
  }
  console.log(`\n${bad} question(s) do not satisfy the model.`);
  return 1;
}

async function cmdNew(args: string[]): Promise<number> {
  const path = positional(args)[0];
  if (!path) return fail("Name the bank file to create.");
  const title = arg(args, "title") ?? basename(path, BANK_EXTENSION);
  const bank = Bank.createEmpty(title);
  const written = await bank.save(resolve(path));
  console.log(`Created ${written}`);
  console.log(`  bank id ${bank.manifest.bankId}`);
  return 0;
}

async function cmdImport(args: string[]): Promise<number> {
  const path = positional(args)[0];
  if (!path) return fail("Name a file to import.");
  const full = resolve(path);
  if (extname(full).toLowerCase() === ".doc") {
    return fail("This is an older Word file (.doc). In Word, choose File, then Save As, and pick Word Document (*.docx).");
  }
  // A file with an extension no importer claims is read as the plain-text format, as it always was.
  const importer = importerFor(full) ?? standardTextImporter;
  const keyMark = arg(args, "key-mark");
  const result = runImporter(importer, await readFile(full), { file: basename(full), ...(keyMark ? { keyMark } : {}) });

  console.log(`${result.file}  profile ${result.profile}`);
  console.log(`  parsed        ${result.counts.parsed}`);
  console.log(`  needs review  ${result.counts.needsReview}`);
  console.log(`  failed        ${result.counts.failed}`);
  console.log(`  orphan blocks ${result.counts.orphans}`);

  for (const f of result.fileFindings) console.log(`  [${f.severity}] ${f.message}`);

  if (has(args, "details")) {
    for (const question of result.questions) {
      const verdict = verdictOf(question);
      if (verdict === "parsed") continue;
      const source = question.origin?.source;
      const where = source ? ` (lines ${source.firstBlock + 1}-${source.lastBlock + 1})` : "";
      console.log(`\n  ${verdict.toUpperCase()}  ${question.title}${where}`);
      for (const f of liveFindings(question.findings)) {
        console.log(`    [${f.severity}] ${f.message}`);
      }
    }
    for (const orphan of result.orphans) {
      console.log(`\n  ORPHAN  line ${orphan.source.firstBlock + 1}: ${orphan.text}`);
      console.log(`    ${orphan.reason}`);
    }
  }

  const out = arg(args, "out");
  if (out) {
    const bank = Bank.createEmpty(basename(out, BANK_EXTENSION));
    for (const question of result.questions) bank.add(question);
    const written = await bank.save(resolve(out));
    console.log(`\nWrote ${result.questions.length} question(s) to ${written}`);
  }
  return result.counts.failed > 0 ? 1 : 0;
}

async function cmdExport(args: string[]): Promise<number> {
  const path = positional(args)[0];
  if (!path) return fail("Name a bank file.");
  const to = arg(args, "to") ?? DESTINATION_ID;
  if (to !== DESTINATION_ID) return fail(`Unknown destination "${to}". The only one so far is ${DESTINATION_ID}.`);

  const { bank } = await Bank.open(resolve(path));
  const result = exportOpenStageSpreadsheet(bank.list(), { name: bank.manifest.title });
  for (const line of formatReport(result.report)) console.log(line);

  const out = arg(args, "out");
  if (!out) {
    console.log("\nNothing was written. Add --out <folder> to write the file.");
    return 0;
  }
  if (result.files.length === 0) {
    console.log("\nNo question could be exported, so no file was written.");
    return 1;
  }
  const folder = resolve(out);
  await mkdir(folder, { recursive: true });
  for (const file of result.files) {
    const target = join(folder, file.name);
    await writeFile(target, file.content, "utf8");
    console.log(`\nWrote ${file.questions} question(s) to ${target}`);
  }
  return 0;
}

async function cmdSearch(args: string[]): Promise<number> {
  const [path, ...words] = positional(args);
  if (!path || words.length === 0) return fail("Name a bank file and something to search for.");
  const { bank } = await Bank.open(resolve(path));
  const started = performance.now();
  const hits = bank.search(words.join(" "));
  const elapsed = performance.now() - started;

  console.log(`${hits.length} of ${bank.questions.size} question(s) in ${elapsed.toFixed(2)} ms\n`);
  for (const question of hits.slice(0, 40)) {
    console.log(`  ${question.id}  [${question.type}]  ${question.title}`);
  }
  if (hits.length > 40) console.log(`  ... and ${hits.length - 40} more`);
  return 0;
}

/**
 * The corpus lives at the repository root, and this file lives four levels
 * below it. Resolving the default against the working directory instead made
 * the command find nothing whenever it was run through the workspace script,
 * which is how it is run in practice.
 */
function defaultFixtures(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "..", "fixtures", "standard-format");
}

async function cmdScore(args: string[]): Promise<number> {
  const given = positional(args)[0];
  const directory = given ? resolve(given) : defaultFixtures();
  const run = await runHarness(directory);

  if (run.directoryMissing) {
    console.log(`No fixture directory at ${directory}.`);
    console.log("The gate did not run, so nothing was measured.");
    return 1;
  }
  if (run.files.length === 0) {
    console.log(`No scored fixtures in ${directory}.`);
    return 1;
  }

  console.log(formatSummary(summarise(run.files), { showMismatches: has(args, "details") }));

  if (run.unscored.length > 0) {
    console.log(`\nNot scored (no .expected.json beside them): ${run.unscored.join(", ")}`);
  }
  if (run.missingSources.length > 0) {
    console.log(`\nExpected files with no source: ${run.missingSources.join(", ")}`);
  }

  const score = summarise(run.files).score;
  const target = `${(TARGET_SCORE * 100).toFixed(0)}%`;
  if (score < TARGET_SCORE) {
    console.log(`\nBelow the ${target} target. Run again with --details to see every mismatch.`);
    return 1;
  }
  console.log(`\nAt or above the ${target} target.`);
  return 0;
}

async function cmdPerf(args: string[]): Promise<number> {
  const count = Number(arg(args, "count") ?? 500);
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { unlink } = await import("node:fs/promises");

  const bank = Bank.createEmpty(`Performance bank of ${count}`);
  const builtStarted = performance.now();
  for (let i = 0; i < count; i++) {
    bank.add(
      createQuestion({
        type: "multipleChoice",
        stem: `Question ${i + 1}: which of the following best describes concept ${i + 1} in chapter ${(i % 12) + 1}?`,
        points: 1,
        metadata: { chapter: String((i % 12) + 1), tags: [`unit-${(i % 4) + 1}`], status: "draft" },
        body: {
          shuffle: true,
          options: [0, 1, 2, 3].map((j) => ({
            id: localId("o", j),
            content: { format: "plain" as const, content: `Option ${j + 1} for question ${i + 1}` },
            correct: j === i % 4,
          })),
        },
        at: "2026-01-01T00:00:00.000Z",
        by: "perf",
      }),
    );
  }
  const built = performance.now() - builtStarted;

  const path = join(tmpdir(), `openassess-perf-${process.pid}${BANK_EXTENSION}`);

  const saveStarted = performance.now();
  await bank.save(path);
  const saved = performance.now() - saveStarted;

  const openStarted = performance.now();
  const reopened = await Bank.open(path);
  const opened = performance.now() - openStarted;

  const searchStarted = performance.now();
  const hits = reopened.bank.search("concept 42");
  const searched = performance.now() - searchStarted;

  const { statSync } = await import("node:fs");
  const bytes = statSync(path).size;
  await unlink(path);

  const budget = 2000;
  const row = (label: string, ms: number) =>
    `  ${label.padEnd(22)} ${ms.toFixed(1).padStart(8)} ms   ${ms < budget ? "within" : "OVER"} the ${budget} ms budget`;

  console.log(`${count} questions, file size ${(bytes / 1024).toFixed(0)} KB\n`);
  console.log(row("build in memory", built));
  console.log(row("save", saved));
  console.log(row("open", opened));
  console.log(row("search", searched));
  console.log(`\n  search returned ${hits.length} question(s)`);
  console.log(`  ${reopened.bank.questions.size} question(s) read back`);

  return [saved, opened, searched].every((ms) => ms < budget) ? 0 : 1;
}

function cmdContract(): number {
  console.log(`Read contract ${READ_CONTRACT_VERSION}`);
  console.log(`Operations: openBank, listQuestions, getQuestion, resolveLink, supportedTypes, toDeliveryPayload\n`);

  for (const capability of allCapabilities()) {
    console.log(`${capability.label}  (${capability.consumer}, ${capability.presentation})`);
    for (const verdict of typeVerdicts(capability.consumer)) {
      if (verdict.supported) {
        console.log(`  ${verdict.type.padEnd(18)} delivers`);
      } else if (verdict.fallback && verdict.fallback.to !== "none") {
        console.log(`  ${verdict.type.padEnd(18)} falls back to ${verdict.fallback.to}`);
        console.log(`  ${"".padEnd(18)}   ${verdict.fallback.note}`);
      } else {
        console.log(`  ${verdict.type.padEnd(18)} cannot deliver`);
        if (verdict.fallback) console.log(`  ${"".padEnd(18)}   ${verdict.fallback.note}`);
      }
    }
    for (const note of capability.notes) console.log(`  note: ${note}`);
    console.log("");
  }
  console.log(`Question types in the model: ${QUESTION_TYPES.length}`);
  return 0;
}

function fail(message: string): number {
  console.error(`${message}\n`);
  console.error(USAGE);
  return 2;
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "info":
      return cmdInfo(args);
    case "validate":
      return cmdValidate(args);
    case "new":
      return cmdNew(args);
    case "import":
      return cmdImport(args);
    case "export":
      return cmdExport(args);
    case "search":
      return cmdSearch(args);
    case "score":
      return cmdScore(args);
    case "perf":
      return cmdPerf(args);
    case "contract":
      return cmdContract();
    case "--help":
    case "-h":
    case undefined:
      console.log(USAGE);
      return 0;
    default:
      return fail(`Unknown command "${command}".`);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
